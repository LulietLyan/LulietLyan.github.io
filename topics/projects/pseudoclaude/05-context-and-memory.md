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
type Conversation struct {
    mu       sync.Mutex
    messages []llm.Message
    hooks    Hooks
}

type Hooks struct {
    OnAppend  func(llm.Message)
    OnReplace func(ReplaceReason, []llm.Message)
}

func (c *Conversation) Messages() []llm.Message {
    c.mu.Lock()
    defer c.mu.Unlock()
    return copyMessages(c.messages)
}
```

返回切片和嵌套 ToolCall、ToolResult 都会复制，调用方不能绕过 Conversation 的锁直接修改内部历史。Runner 通过 `AddUser`、`AddAssistant`、`AddAssistantToolCalls` 和 `AddToolResult` 追加消息；Compact 则通过 `ReplaceMessages` 原子替换当前有效上下文。

Hook 在释放锁后调用。这样 Session Writer 即使执行磁盘 IO，也不会长时间占用 Conversation 的互斥锁。

## Session：追加日志而不是第二份内存

`session.Writer` 被注册为 Conversation Hook：

```go
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
func (w *Writer) AppendReplace(reason string, msgs []llm.Message) {
    if w == nil {
        return
    }
    w.mu.Lock()
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
switch entry.Type {
case EntryReplace:
    result.Messages = nil
case EntryMessage, "":
    msg := messageFromEntry(entry)
    if msg.Role != "" {
        result.Messages = append(result.Messages, msg)
    }
}
```

这种设计保留了追加写的简单性，同时允许 Conversation 在压缩后缩短。恢复逻辑还会删除末尾没有对应 ToolResult 的悬空 ToolCall，避免上次进程中断留下供应商协议不接受的消息序列。

Session 的边界也很明确：它保存发生过的消息变化，但不会判断哪些内容值得跨会话长期保留。

## Compact Layer 1：大结果落盘

工具结果通常是上下文增长最快的部分。第一层压缩不调用模型，而是把单个过大结果或一轮中累计过大的结果写入 Session 的 `tool-results` 目录，并用预览替换正文：

```go
func replaceToolResult(rt *Runtime, id, content string) (string, error) {
    path, err := spillToolResult(rt.Snapshot().Session, id, content)
    if err != nil {
        return content, err
    }
    preview := buildPreview(len(content), previewHead(content), path)
    rt.markReplace(id, preview)
    return preview, nil
}

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

## Compact Layer 2：摘要旧上下文

每轮模型请求前，Runner 调用 `ManageContext`。它总是先尝试 Layer 1，再估算当前 token 是否接近上下文窗口：

```go
func ManageContext(ctx context.Context, in ManageInput) (ManageOutput, error) {
    if in.Trigger == TriggerManual {
        return ForceCompact(ctx, in)
    }
    if in.Conversation == nil || in.Runtime == nil {
        return ManageOutput{}, nil
    }
    messages := in.Conversation.Messages()
    before := EstimateWithAnchor(messages, in.Runtime.Snapshot().UsageAnchor)
    output := ManageOutput{BeforeTokens: before, AfterTokens: before}

    layer1 := OffloadToolResults(messages, in.Runtime)
    if layer1.Changed {
        in.Conversation.ReplaceMessages(
            conversation.ReplaceReasonSnapshot,
            layer1.Messages,
        )
        output.TriggeredLayer1 = true
        output.OffloadedCount = layer1.OffloadedCount
        resetAnchorToEstimate(in.Runtime, in.Conversation)
    }

    messages = in.Conversation.Messages()
    current := EstimateWithAnchor(messages, in.Runtime.Snapshot().UsageAnchor)
    output.AfterTokens = current
    if !shouldAutoCompact(current, in.Runtime.Snapshot().ContextWindow) {
        return output, layer1.Err
    }
    if in.Runtime.AutoTripped() {
        return output, layer1.Err
    }
    if in.OnProgress != nil {
        in.OnProgress("正在压缩上下文...")
    }
    compactOut, err := compactConversation(ctx, in, AutoSafetyMarginTokens)
    if err != nil {
        in.Runtime.RecordAutoFailure()
        return output, err
    }
    in.Runtime.RecordAutoSuccess()
    compactOut.BeforeTokens = before
    compactOut.TriggeredLayer1 = output.TriggeredLayer1
    compactOut.OffloadedCount = output.OffloadedCount
    return compactOut, layer1.Err
}
```

第二层让 Provider 对旧消息生成结构化摘要，再保留最近一段完整消息：

```go
recent := SelectRecent(in.Conversation.Messages())
next := buildCompactedMessages(summary, recent)
in.Conversation.ReplaceMessages(conversation.ReplaceReasonCompact, next)
after := EstimateMessages(next)
in.Runtime.ResetUsageAnchor(after, in.Conversation.Len())
```

`SelectRecent` 不会从 ToolResult 中间切开，它会向前扩展到对应的 Assistant ToolCall。新上下文还会插入一条边界提醒，明确摘要不是文件、错误和工具结果的完整原文，需要细节时必须重新读取。

自动摘要连续失败达到上限后会触发熔断，后续普通轮次不再反复调用同一个失败路径；用户手动 Compact 仍可绕过自动熔断再次尝试。

## Memory：跨会话的筛选结果

Memory 不保存完整对话。Manager 管理项目级与用户级两个 Store，启动时只加载它们的 `MEMORY.md` 索引：

```go
func (m *Manager) RefreshIndex() {
    project := m.project.LoadIndex()
    user := m.user.LoadIndex()
    var parts []string
    if strings.TrimSpace(project) != "" {
        parts = append(parts, "## Project Memory\n"+strings.TrimSpace(project))
    }
    if strings.TrimSpace(user) != "" {
        parts = append(parts, "## User Memory\n"+strings.TrimSpace(user))
    }
    index := trimIndex(strings.Join(parts, "\n\n"))
    m.mu.Lock()
    m.index = index
    m.mu.Unlock()
}
```

项目索引先于用户索引，二者都受行数和字节数限制。具体 Markdown 笔记仍留在各自目录，System Prompt 不会在启动时装入全部正文。

主 Agent 正常完成且不再请求工具时，Runner 将本次新增消息交给 `UpdateAsync`。Memory 使用一次独立的模型请求把消息转换成 Create、Update、Delete Operation，验证后分别写入 Project 或 User Store：

```go
go func() {
    m.updateMu.Lock()
    defer m.updateMu.Unlock()
    ops, err := collectJSONOperations(
        ctx,
        provider,
        BuildUpdatePrompt(input.Messages, projectIndex, userIndex),
    )
    if err != nil {
        log.Printf("memory update failed: %v", err)
        return
    }
    // 省略 Operation 校验、分层写入与索引刷新。
}()
```

异步更新不会延迟用户看到最终回答，同一个 Manager 的写入又通过 `updateMu` 串行化，避免多个回合同时修改索引。代价是进程立即退出或模型提取失败时，本轮长期记忆可能不会保存；这不会影响当前 Conversation 和 Session 的完整性。

## 为什么不能合并

如果只保留 Session，模型每轮都要读取不断增长的完整日志；如果只保留 Compact 摘要，恢复时会丢失最近的 ToolCall 边界；如果把所有对话都写进 Memory，临时错误和一次性任务会污染跨会话上下文。

四个机制的组合关系是：Conversation 决定“下一轮看什么”，Session 决定“重启后如何恢复”，Compact 决定“有限窗口内保留什么”，Memory 决定“未来会话长期知道什么”。

## 小结

PseudoClaude 没有把状态管理简化为一个 Messages 数组。当前事实、磁盘恢复、窗口控制和长期知识分别拥有独立生命周期，再通过 Conversation Hook、Replace Marker 和 Memory Index 连接起来。

最后一篇将讨论这些状态和工具具备副作用之后，系统如何用权限引擎与 Plan Mode 限定执行边界。
