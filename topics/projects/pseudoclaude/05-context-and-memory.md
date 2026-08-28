---
title: 上下文与记忆：四种状态的生命周期
description: How Conversation, Session, Compact, and Memory divide responsibility for PseudoClaude's short- and long-lived context state.
date: 2026-08-21
order: 5
tags:
  - PseudoClaude
  - Context
  - Memory
  - Go
---

Coding Agent 的“上下文”不是一个字符串。当前模型请求需要一份有顺序的消息历史，进程退出后需要恢复会话，长工具结果需要控制体积，跨会话还要保留稳定的用户偏好和项目知识。这些状态的生命周期不同，不能交给同一个历史数组处理。

PseudoClaude 将它们拆成四个机制：Conversation、Session、Compact 和 Memory。

## 四种状态分别解决什么

| 机制 | 保存内容 | 生命周期 | 主要用途 |
| --- | --- | --- | --- |
| Conversation | 当前有效的 `llm.Message` 序列 | 当前进程中的一次会话 | 作为下一轮模型请求的事实源 |
| Session | Conversation 的 JSONL 追加日志 | 跨进程、可恢复 | 持久化原始消息和替换快照 |
| Compact | 大结果落盘记录、摘要和 Usage anchor | 当前 Session | 控制送给模型的上下文体积 |
| Memory | 项目级与用户级 Markdown 笔记及索引 | 跨 Session，用户级还跨项目 | 保存经过筛选的长期事实 |

它们之间的主流程是：

```text
Runner
  -> append Conversation
  -> Session Writer 通过 Hook 追加 JSONL
  -> Compact 在模型请求前替换 Conversation
  -> Session Writer 记录 replace marker 与新快照
  -> 正常任务结束后异步更新 Memory
  -> 下一次运行把 Memory 索引加入 System Prompt
```

## Conversation：当前事实源

Conversation 只保存模型下一轮真正需要看到的消息：

```go
// Conversation 保存当前真正会发送给模型的有效消息序列。
// 它只负责进程内同步与变更通知，磁盘持久化由 Hooks 的订阅者完成。
type Conversation struct {
    mu       sync.Mutex
    messages []llm.Message
    hooks    Hooks
}

// Hooks 将内存状态变化同步给 Session Writer 等外部组件。
// 回调始终在 Conversation 解锁后执行，避免磁盘 IO 占用消息锁或发生重入死锁。
type Hooks struct {
    OnAppend  func(llm.Message)
    OnReplace func(ReplaceReason, []llm.Message)
}

// Messages 返回当前有效历史的结构副本，调用方不能直接替换内部切片或 ToolResult。
func (c *Conversation) Messages() []llm.Message {
    c.mu.Lock()
    defer c.mu.Unlock()
    return copyMessages(c.messages)
}

// ReplaceMessages 原子替换整份有效历史，供 Compact 的落盘快照和摘要压缩使用。
// Hook 收到同一份新快照的副本，并据此在 Session 日志中追加 replace marker。
func (c *Conversation) ReplaceMessages(reason ReplaceReason, messages []llm.Message) {
    // 先在锁外复制可能较大的消息，缩短持有 Conversation 锁的时间。
    copied := copyMessages(messages)
    c.mu.Lock()
    c.messages = copied
    hook := c.hooks.OnReplace
    c.mu.Unlock()
    callReplaceHook(hook, reason, copied)
}
```

返回消息切片、ToolCalls 切片和 ToolResult 值都会复制，调用方不能绕过 Conversation 的锁替换内部结构。这里不是任意嵌套数据的递归深拷贝：`ToolCall.Arguments` 是 `json.RawMessage`，复制 ToolCall struct 后仍共享底层 byte slice，当前代码把已进入历史的 Arguments 视为不可变值。

Conversation 有两类状态变化：

| 操作 | 使用场景 | Hook | Session 结果 |
| --- | --- | --- | --- |
| Append | 用户文本、Assistant 文本、ToolCall、ToolResult | `OnAppend` | 追加一条 message Entry |
| Replace | Layer 1 快照、Layer 2 摘要 | `OnReplace` | 追加 replace marker 和完整新快照 |

Runner 通过 `AddUser`、`AddAssistant`、`AddAssistantToolCalls` 和 `AddToolResult` 追加消息；Compact 才能通过 `ReplaceMessages` 整体替换当前有效上下文。这个边界让普通 ReAct 循环保持 append-only 心智模型，同时允许压缩器缩短模型真正读取的历史。

Hook 在释放锁后调用。这样 Session Writer 即使执行磁盘 IO，也不会长时间占用 Conversation 的互斥锁。

## Session：追加日志而不是第二份内存

`session.Writer` 被注册为 Conversation Hook：

```go
// Hooks 将 Writer 适配成 Conversation 的追加与整表替换订阅者。
func (w *Writer) Hooks() conversation.Hooks {
    return conversation.Hooks{
        OnAppend: w.AppendMessage,
        OnReplace: func(reason conversation.ReplaceReason, msgs []llm.Message) {
            w.AppendReplace(string(reason), msgs)
        },
    }
}
```

普通消息被序列化为一行 JSON。发生压缩或快照替换时，Writer 不重写整个文件，而是先追加一个 Replace Entry，再追加新的有效消息：

```go
// AppendReplace 先写 replace marker，再顺序写入替换后的完整有效快照。
// 这是追加日志协议，不是单条原子事务；每条 Entry 都会单独 Sync。
func (w *Writer) AppendReplace(reason string, msgs []llm.Message) {
    if w == nil {
        return
    }
    w.mu.Lock()
    // Loader 遇到 marker 会清空此前消息，后续 Entry 成为新的有效状态。
    err := w.writeEntryLocked(Entry{
        Type: EntryReplace, Reason: reason, TS: time.Now().Unix(),
    })
    for _, msg := range msgs {
        if err != nil {
            break
        }
        entry := entryFromMessage(msg)
        if !w.wroteMsg && w.model != "" {
            entry.Model = w.model
        }
        err = w.writeEntryLocked(entry)
        if err == nil {
            w.wroteMsg = true
        }
    }
    w.mu.Unlock()
    w.report(err)
}
```

恢复时，Loader 顺序扫描 JSONL。遇到 Replace Entry 就清空此前累计的消息，后续记录成为新的有效快照：

```go
// Load 顺序重放 conversation.jsonl。message 负责追加，replace 负责重置当前状态；
// 扫描结束后再修剪可能因进程中断留下的末尾悬空 ToolCall。
func Load(ctx Context) (LoadResult, error) {
    file, err := os.Open(ctx.JSONLPath)
    if err != nil {
        return LoadResult{}, err
    }
    defer file.Close()

    result := LoadResult{ID: ctx.ID}
    scanner := bufio.NewScanner(file)
    // 工具消息可能很大，提高 Scanner 上限，避免默认 64 KiB 限制截断合法 Entry。
    scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
    for scanner.Scan() {
        var entry Entry
        if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
            // 单行损坏不会让整个 Session 无法恢复，记录诊断后继续重放后续行。
            result.BadLines++
            continue
        }
        switch entry.Type {
        case EntryReplace:
            // Replace 的 reason 只用于审计；恢复语义始终是清空此前累计消息。
            result.Messages = nil
        case EntryMessage, "":
            msg := messageFromEntry(entry)
            if msg.Role != "" {
                result.Messages = append(result.Messages, msg)
            }
        }
    }
    if err := scanner.Err(); err != nil {
        return result, err
    }
    // 若进程在写入 assistant ToolCall 后退出，删除该不完整尾部，避免 Provider 拒绝协议。
    next, truncated := truncateDanglingToolCalls(result.Messages)
    result.Messages = next
    result.Truncated = truncated
    return result, nil
}
```

这种设计保留了追加写的简单性，同时允许 Conversation 在压缩后缩短。恢复逻辑还会删除末尾没有对应 ToolResult 的悬空 ToolCall，避免上次进程中断留下供应商协议不接受的消息序列。

追加日志也有明确的故障窗口。Replace Marker 与随后多条快照消息分别写入并 Sync，并不是单条磁盘事务；如果进程恰好在中间退出，Loader 会恢复 marker 之后已经写入的部分快照，再由悬空 ToolCall 修剪处理尾部协议完整性。它优先保证日志可重放和模型协议可接受，不承诺跨多条 Entry 的原子提交。

Session 的边界也很明确：它保存发生过的消息变化，但不会判断哪些内容值得跨会话长期保留。

## Compact Layer 1：大结果落盘

工具结果通常是上下文增长最快的部分。第一层压缩不调用模型，而是把单个过大结果或一轮中累计过大的结果写入 Session 的 `tool-results` 目录，并用预览替换正文：

```go
// replaceToolResult 只有在原文成功写盘后才生成预览并登记 Replace，确保引用路径可用。
func replaceToolResult(rt *Runtime, id, content string) (string, error) {
    path, err := spillToolResult(rt.Snapshot().Session, id, content)
    if err != nil {
        return content, err
    }
    preview := buildPreview(len(content), previewHead(content), path)
    rt.markReplace(id, preview)
    return preview, nil
}

// spillToolResult 以清理后的 CallID 命名文件；目标已存在时直接复用，避免重复覆盖。
func spillToolResult(session Session, id, content string) (string, error) {
    name := safeFileName(id)
    path := filepath.Join(session.SpillDir, name+".txt")
    if _, err := os.Stat(path); err == nil {
        return path, nil
    } else if !os.IsNotExist(err) {
        return path, err
    }
    if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
        return path, err
    }
    return path, nil
}
```

Replacement Ledger 记录每个 Call ID 已经决定保留还是落盘，后续检查不会不断改写同一结果。落盘失败时保留原文且不冻结决策，目录恢复后可以再次尝试；压缩不会用一条损坏的预览替换仍可使用的结果。

落盘失败虽然不会破坏原文，但错误仍会从 `ManageContext` 返回 Runner，当前 Agent Run 会以 Stream Error 停止。这里选择显式暴露存储故障，而不是在上下文可能继续失控增长时静默忽略。

Layer 1 有两条独立阈值：单个结果超过 50,000 bytes 时直接落盘；同一条 Assistant ToolCalls 后连续结果合计超过 200,000 bytes 时，按体积从大到小选择候选，直到剩余总量回到上限内。先处理单项、再处理聚合，能够避免许多中等结果共同挤满上下文。

这层压缩相对无损：模型上下文只保留原始大小、落盘路径和头部预览，但完整正文仍在 Session 目录中。真正的信息损失发生在 Layer 2 的模型摘要。

## Compact Layer 2：摘要旧上下文

每轮模型请求前，Runner 调用 `ManageContext`。它总是先尝试 Layer 1，再估算当前 token 是否接近上下文窗口：

```go
// ManageContext 是模型请求前的自动压缩入口：始终先尝试无模型的 Layer 1，
// 只有剩余 Token 达到阈值且自动熔断未打开时，才执行有损摘要 Layer 2。
func ManageContext(ctx context.Context, in ManageInput) (ManageOutput, error) {
    // 手动触发直接进入 Layer 2，不经过自动阈值与失败熔断判断。
    if in.Trigger == TriggerManual {
        return ForceCompact(ctx, in)
    }
    if in.Conversation == nil || in.Runtime == nil {
        return ManageOutput{}, nil
    }
    messages := in.Conversation.Messages()
    // BeforeTokens 表示任何本轮压缩发生之前的基线。
    before := EstimateWithAnchor(messages, in.Runtime.Snapshot().UsageAnchor)
    output := ManageOutput{BeforeTokens: before, AfterTokens: before}

    // Layer 1 将大型 ToolResult 落盘并用可恢复预览替换正文。
    layer1 := OffloadToolResults(messages, in.Runtime)
    if layer1.Changed {
        in.Conversation.ReplaceMessages(
            conversation.ReplaceReasonSnapshot,
            layer1.Messages,
        )
        output.TriggeredLayer1 = true
        output.OffloadedCount = layer1.OffloadedCount
        // Provider Usage 对应旧消息内容，替换后必须把锚点重置为当前估算。
        resetAnchorToEstimate(in.Runtime, in.Conversation)
    }

    // 重新读取 Conversation，基于 Layer 1 的结果判断是否仍需要摘要。
    messages = in.Conversation.Messages()
    current := EstimateWithAnchor(messages, in.Runtime.Snapshot().UsageAnchor)
    output.AfterTokens = current
    if !shouldAutoCompact(current, in.Runtime.Snapshot().ContextWindow) {
        return output, layer1.Err
    }
    // 连续失败达到上限后静默跳过自动 Layer 2；手动 ForceCompact 仍可再次尝试。
    if in.Runtime.AutoTripped() {
        return output, layer1.Err
    }
    if in.OnProgress != nil {
        in.OnProgress("正在压缩上下文...")
    }
    compactOut, err := compactConversation(ctx, in, AutoSafetyMarginTokens)
    if err != nil {
        // 失败次数跨运行保存在 Runtime 中，达到阈值后阻止重复请求同一失败路径。
        in.Runtime.RecordAutoFailure()
        return output, err
    }
    // 任意一次自动摘要成功都会闭合熔断器并清零失败次数。
    in.Runtime.RecordAutoSuccess()
    compactOut.BeforeTokens = before
    compactOut.TriggeredLayer1 = output.TriggeredLayer1
    compactOut.OffloadedCount = output.OffloadedCount
    return compactOut, layer1.Err
}
```

Token 判断不是每轮都对所有文本盲算。Runner 会在模型响应后记录 Provider Usage 与当时的消息数量，之后按下面的方式估算新增后缀：

```text
当前估算 Token = 上次 Provider Token + 锚点之后新增消息的估算 Token
```

锚点因 Replace 失效时才重新全量估算。没有 Provider Usage 时，估算器统计 Role、Content、ToolCall 和 ToolResult 的 UTF-8 字节数，再除以经验比例 3.5。

自动 Layer 2 的阈值是 `ContextWindow - 20,000 - 13,000`。因此默认 128K OpenAI 窗口约在 95K 触发，默认 200K Anthropic 窗口约在 167K 触发。20K 是摘要预留，13K 是自动安全余量；阈值提前触发是为了给摘要请求和下一轮响应留下空间。

第二层让 Provider 对旧消息生成结构化摘要，再保留最近一段完整消息：

```go
// 摘要成功后保留一段近期原文，避免所有短期细节都退化为有损摘要。
recent := SelectRecent(in.Conversation.Messages())
next := buildCompactedMessages(summary, recent)
// ReplaceReasonCompact 会让 Session Writer 追加 replace marker 和新的有效快照。
in.Conversation.ReplaceMessages(conversation.ReplaceReasonCompact, next)
after := EstimateMessages(next)
in.Runtime.ResetUsageAnchor(after, in.Conversation.Len())
```

`SelectRecent` 不会从 ToolResult 中间切开，它会向前扩展到对应的 Assistant ToolCall。新上下文还会插入一条边界提醒，明确摘要不是文件、错误和工具结果的完整原文，需要细节时必须重新读取。

自动摘要连续失败达到上限后会触发熔断，后续普通轮次不再反复调用同一个失败路径；用户手动 Compact 仍可绕过自动熔断再次尝试。

摘要请求过长时最多进行首次请求加三次重试，每次删除最早的一条输入消息。当前实现的 `safetyMargin` 与 `contextWindow` 参数尚未参与重试裁剪，而且逐条删除可能暂时切开摘要输入中的 ToolCall/ToolResult；Tool 边界保护只发生在摘要成功后的近期原文选择阶段。自动熔断打开后也是静默跳过 Layer 2，最终仍可能由 Provider 报上下文过长。这些是当前策略的已知边界。

## Memory：跨会话的筛选结果

Memory 不保存完整对话。Manager 管理项目级与用户级两个 Store，启动时只加载它们的 `MEMORY.md` 索引：

```go
// RefreshIndex 只读取两个 Store 的 MEMORY.md，而不加载各条记忆正文。
// Store 将缺失或不可读的索引视为空；合并时项目级内容固定排在用户级内容之前。
func (m *Manager) RefreshIndex() {
    // 只把短索引注入 Prompt；单条 Markdown 正文仍按需保留在 Store 目录。
    project := m.project.LoadIndex()
    user := m.user.LoadIndex()
    var parts []string
    if strings.TrimSpace(project) != "" {
        parts = append(parts, "## Project Memory\n"+strings.TrimSpace(project))
    }
    if strings.TrimSpace(user) != "" {
        parts = append(parts, "## User Memory\n"+strings.TrimSpace(user))
    }
    // 项目记忆优先出现，使当前仓库约定先于跨项目用户偏好进入上下文。
    index := trimIndex(strings.Join(parts, "\n\n"))
    m.mu.Lock()
    m.index = index
    m.mu.Unlock()
}
```

项目索引先于用户索引，二者都受行数和字节数限制。具体 Markdown 笔记仍留在各自目录，System Prompt 不会在启动时装入全部正文。

主 Agent 正常完成且不再请求工具时，Runner 将本次新增消息交给 `UpdateAsync`。Memory 使用一次独立的模型请求把消息转换成 Create、Update、Delete Operation，验证后分别写入 Project 或 User Store：

```go
// UpdateAsync 让模型把本轮对话转换成结构化变更，并在后台更新两个 Store。
// 同一 Manager 的更新会串行执行；未配置 provider 时该调用是 no-op。
func (m *Manager) UpdateAsync(ctx context.Context, input UpdateInput) {
    if m == nil {
        return
    }
    m.mu.Lock()
    // 启动 goroutine 前取得 Provider 和索引快照，本轮提取基于调用时观察到的记忆状态。
    provider := m.provider
    projectIndex := m.project.LoadIndex()
    userIndex := m.user.LoadIndex()
    m.mu.Unlock()
    if provider == nil {
        return
    }
    go func() {
        // 同一 Manager 可能连续完成多个 Agent 回合；串行化可避免索引读改写互相覆盖。
        m.updateMu.Lock()
        defer m.updateMu.Unlock()

        // 独立模型请求只返回结构化 Operation，不把原始会话直接复制成长记忆。
        ops, err := collectJSONOperations(
            ctx,
            provider,
            BuildUpdatePrompt(input.Messages, projectIndex, userIndex),
        )
        if err != nil {
            log.Printf("memory update failed: %v", err)
            return
        }
        if len(ops) == 0 {
            return
        }

        // 丢弃字段不完整的操作，再按 project/user 生命周期分发到不同 Store。
        var projectOps, userOps []Operation
        for _, op := range ops {
            if err := ValidateOperation(op); err != nil {
                log.Printf("invalid memory operation ignored: %v", err)
                continue
            }
            switch op.Level {
            case LevelProject:
                projectOps = append(projectOps, op)
            case LevelUser:
                userOps = append(userOps, op)
            }
        }
        now := time.Now()
        // 两个 Store 分别加锁并顺序应用；它们之间不是跨目录原子事务。
        if err := m.project.Apply(projectOps, now); err != nil {
            log.Printf("project memory update failed: %v", err)
            return
        }
        if err := m.user.Apply(userOps, now); err != nil {
            log.Printf("user memory update failed: %v", err)
            return
        }

        // 写入成功后重新读取磁盘索引，更新下一轮 System Prompt 使用的内存快照。
        project := m.project.LoadIndex()
        user := m.user.LoadIndex()
        m.mu.Lock()
        m.index = trimIndex(strings.TrimSpace("## Project Memory\n"+project) +
            "\n\n" + strings.TrimSpace("## User Memory\n"+user))
        m.mu.Unlock()
    }()
}
```

异步更新不会延迟用户看到最终回答，同一个 Manager 的写入又通过 `updateMu` 串行化，避免多个回合同时修改索引。代价是进程立即退出或模型提取失败时，本轮长期记忆可能不会保存；这不会影响当前 Conversation 和 Session 的完整性。

Memory 更新也不是跨 Project/User Store 的事务。项目操作成功而用户操作失败时，项目记忆已经落盘；Manager 会记录错误，但不会回滚前一层。索引的字节上限目前直接按 byte slice 截断，极端情况下切点可能落在 UTF-8 多字节字符内部。这些风险不会破坏当前会话，却会影响下一次 System Prompt 中长期索引的完整性。

## 一次回合中四种状态如何变化

假设用户要求读取一个大型日志、修复代码并记住项目使用 `go test ./...`：

```text
1. User、Assistant ToolCall、ToolResult 依次追加到 Conversation
2. 每次追加通过 Hook 写入 Session JSONL
3. 大型日志超过 Layer 1 阈值，正文写入 tool-results，Conversation 被预览快照替换
4. Session 追加 snapshot replace marker 和新快照
5. 上下文接近窗口时，Layer 2 生成摘要并保留近期 ToolCall 闭环
6. Conversation 再次替换，Session 追加 compact replace marker
7. Agent 正常完成，Memory 异步提取稳定项目事实
8. 下一次 Session 启动时：Session 恢复会话，Memory Index 进入 System Prompt
```

这里有两条不同的恢复路径：Session 恢复“上次会话进行到哪里”，Memory 告诉新会话“长期应该知道什么”。Session 中出现过某句话，不代表它会自动成为 Memory；Memory 中的索引也不会被追加成当前 Conversation 的普通用户消息。

## 测试覆盖与未覆盖边界

Conversation 测试验证追加顺序、Replace Hook 和结构复制；Session 测试验证 JSONL 重放、Replace、坏行跳过与悬空 ToolCall 修剪；Compact 测试覆盖单项及聚合落盘、失败重试、摘要提取、近期调用边界和自动熔断；Memory 测试覆盖 Operation 解析、层级分发、Store 路径与索引限制。

跨模块测试还确认 Runner 在普通模型请求前自动 Compact，并在顶层 Agent 正常结束后触发 Memory。当前没有真正模拟进程在 AppendReplace 多条写入中间崩溃的故障注入测试，也没有覆盖 UTF-8 索引恰好在字节上限中间被切断的情况。

## 为什么不能合并

如果只保留 Session，模型每轮都要读取不断增长的完整日志；如果只保留 Compact 摘要，恢复时会丢失最近的 ToolCall 边界；如果把所有对话都写进 Memory，临时错误和一次性任务会污染跨会话上下文。

四个机制的组合关系是：Conversation 决定“下一轮看什么”，Session 决定“重启后如何恢复”，Compact 决定“有限窗口内保留什么”，Memory 决定“未来会话长期知道什么”。

## 小结

PseudoClaude 没有把状态管理简化为一个 Messages 数组。当前事实、磁盘恢复、窗口控制和长期知识分别拥有独立生命周期，再通过 Conversation Hook、Replace Marker 和 Memory Index 连接起来。

最后一篇将讨论这些状态和工具具备副作用之后，系统如何用权限引擎与 Plan Mode 限定执行边界。
