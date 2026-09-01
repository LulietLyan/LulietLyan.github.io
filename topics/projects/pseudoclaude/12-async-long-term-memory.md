---
title: 长期记忆：如何异步提取跨会话知识
description: How PseudoClaude asynchronously extracts structured memory operations and updates project and user stores without blocking the active turn.
date: 2026-08-28
order: 12
tags:
  - PseudoClaude
  - Memory
  - Context
  - Go
---

Session 能恢复一次会话，但不适合直接充当长期记忆。完整日志包含临时错误、一次性工具输出和已经过期的任务细节；把它们全部带入新会话，成本高，也会污染模型判断。

PseudoClaude 的 Memory 只保存经过筛选的稳定信息。主 Agent 正常完成一次任务后，将本轮新增消息交给独立模型请求；模型返回 Create、Update 或 Delete 操作，Manager 再分别更新项目级和用户级 Markdown Store。下一次 Run 只把轻量索引放进 System Prompt，不预加载全部正文。

先用一句话抓住它：**长期记忆不是聊天记录，而是聊天结束后异步整理出来的一组小卡片。**

可以把这条链路想成四个角色：

```text
Runner
  负责判断“一轮对话已经正常结束”，然后把本轮新增消息交给 Memory。

Memory Manager
  负责开后台任务，调用模型提取记忆操作，并协调两个 Store。

Memory Prompt
  负责告诉模型：只返回 JSON，不要把整段聊天原样存起来。

Store
  负责把通过校验的操作写成 Markdown 文件和 MEMORY.md 索引。
```

这也是理解本文的主线：**先筛选，再结构化，再落盘，下一轮才可见。**

## 两个维度描述一条记忆

Memory 将共享范围和内容类型分开建模：

```go
type Level string
type NoteType string

const (
    LevelProject Level = "project"
    LevelUser    Level = "user"

    TypeUserPreference    NoteType = "user_preference"
    TypeCorrectionFeedback NoteType = "correction_feedback"
    TypeProjectKnowledge   NoteType = "project_knowledge"
    TypeReferenceMaterial  NoteType = "reference_material"
)
```

Project Level 跟随当前仓库，默认目录是 `<workspace>/.PseudoClaude/memory`；User Level 位于 `~/.PseudoClaude/memory`，可以跨工作区复用。NoteType 则回答信息的语义：用户偏好、明确纠正、项目知识或参考材料。

这两个维度不能合并。一个“使用中文回答”的偏好通常属于 User Level，而“本仓库测试命令是 `go test ./...`”属于 Project Level；两者都可能在语义上被视为稳定知识，但传播范围不同。

## 正文与索引分开保存

每个 Store 的 `MEMORY.md` 是轻量索引，其他 Markdown 文件保存单条完整 Note：

```text
.PseudoClaude/memory/
├── MEMORY.md
├── project_knowledge_build.md
└── reference_material_api-contract.md
```

索引行包含类型、标题、单句摘要和正文文件名：

```text
- [project_knowledge] Build workflow — Run Go tests before release. (project_knowledge_build.md)
```

启动时 Manager 只读取两个索引，并按 Project、User 的顺序合并：

```go
func (m *Manager) RefreshIndex() {
    if m == nil {
        return
    }
    // 只把短索引注入 Prompt；单条 Markdown 正文仍按需保留在 Store 目录。
    project := m.project.LoadIndex()
    user := m.user.LoadIndex()
    var parts []string
    if strings.TrimSpace(project) != "" {
        parts = append(parts,
            "## Project Memory\n"+strings.TrimSpace(project))
    }
    if strings.TrimSpace(user) != "" {
        parts = append(parts,
            "## User Memory\n"+strings.TrimSpace(user))
    }
    // 项目记忆优先出现，使当前仓库约定先于跨项目用户偏好进入上下文。
    index := trimIndex(strings.Join(parts, "\n\n"))
    m.mu.Lock()
    m.index = index
    m.mu.Unlock()
}
```

索引最多 200 行、25 KiB。把摘要与正文分离后，模型每轮只承担“有哪些长期知识”的固定成本；具体 Note 仍保留为用户可编辑的 Markdown 文件。

## Runner 只提交本轮新增消息

每次 Run 开始前，Runner 记录 Conversation 的原长度。模型不再请求工具、主 Agent 正常完成时，才触发 Memory：

```go
userText, defs, toolOpts := r.prepareRequest(req)
startLen := req.Conversation.Len()
req.Conversation.AddUser(userText)
```

完成分支中的源码是：

```go
if len(out.ToolCalls) == 0 {
    // 保存最新用量锚点，供下一轮上下文压缩判断使用。
    if r.Compact != nil {
        r.Compact.UpdateUsageAnchor(out.Usage, req.Conversation.Len())
    }
    unknownCount = 0
    // 只有顶层 Agent 更新长期记忆，避免子 Agent 重复写入同一段上下文。
    // UpdateAsync 内部会另起 goroutine；这里触发的是“排队更新”，不是同步等待落盘。
    if !r.Sub.IsSubAgent {
        r.updateMemoryAfterRun(req.Conversation, startLen)
    }
    // 先通知 Hook，再向调用方发送最终停止事件。
    r.dispatchHook(ctx, hook.EventStop, permissionMode, hook.Payload{"iter": iteration})
    sendStop(ctx, events, iteration, StopCompleted, "completed")
    return
}
```

`updateMemoryAfterRun` 只截取 `messages[startLen:]`，因此旧会话历史不会在每轮被重复分析。流错误、取消、最大迭代停止和子 Agent 不会进入这条正常完成分支。

Runner 调用时使用 `context.Background()`。Memory 提取因此不再绑定已经结束的 Run Context，可以在最终回答发出后继续；当前也没有单独的提取超时或关闭等待机制。

## UpdateAsync 把响应延迟与记忆写入解耦

Manager 先快照当前 Provider 和两个旧索引，再启动 goroutine：

```go
func (m *Manager) UpdateAsync(ctx context.Context, input UpdateInput) {
    if m == nil {
        return
    }
    m.mu.Lock()
    // 启动 goroutine 前取得 Provider 和索引快照，本轮提取基于调用时观察到的记忆状态。
    // 这里故意只快照旧索引和本轮消息：提取模型需要判断“新增事实是否已经存在”，不需要读取每条正文。
    provider := m.provider
    projectIndex := m.project.LoadIndex()
    userIndex := m.user.LoadIndex()
    m.mu.Unlock()
    if provider == nil {
        return
    }
    go func() {
        // 从这里开始进入后台更新；用户已经可以看到最终回答，慢的是下一轮记忆可见性。
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
        // 语义判断交给提取模型，路径安全和文件格式仍交给 Store 做最后防线。
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
        if err := m.project.Apply(projectOps, now); err != nil {
            log.Printf("project memory update failed: %v", err)
            return
        }
        if err := m.user.Apply(userOps, now); err != nil {
            log.Printf("user memory update failed: %v", err)
            return
        }
        project := m.project.LoadIndex()
        user := m.user.LoadIndex()
        m.mu.Lock()
        m.index = trimIndex(
            strings.TrimSpace("## Project Memory\n"+project) +
                "\n\n" +
                strings.TrimSpace("## User Memory\n"+user),
        )
        m.mu.Unlock()
    }()
}
```

`UpdateAsync` 返回时，后台模型请求通常还没真正完成，用户不必等待第二次推理。可以把它理解成“把整理记忆这件事放到后台队列里”。`updateMu` 保证同一个 Manager 的实际更新任务串行执行，避免两个 goroutine 同时改写 Store 文件。

不过，旧索引是在 goroutine 排队之前读取的。若两个更新快速进入队列，后一个任务可能携带前一个任务写入前的旧索引；串行化保护了文件操作，却没有让提取输入自动刷新到最新版本。

## 提取请求要求结构化 Operation

Memory Prompt 包含现有 Project/User 索引、本轮文本消息、可用 Action、Level、NoteType 和 JSON Schema。模型应返回 Operation 数组：

```go
type Operation struct {
    Action   string   `json:"action"`
    Level    Level    `json:"level"`
    Type     NoteType `json:"type,omitempty"`
    Title    string   `json:"title,omitempty"`
    Summary  string   `json:"summary,omitempty"`
    Slug     string   `json:"slug,omitempty"`
    Filename string   `json:"filename,omitempty"`
    Content  string   `json:"content,omitempty"`
}
```

Create 需要 Level、Type、Title 和 Content；Update 需要 Level、Filename 和 Content；Delete 需要 Level 和 Filename。模型可以返回 `[]` 表示本轮没有值得长期保存的信息。

`BuildUpdatePrompt` 当前只写每条消息的 Role 与非空 `Content`：

```go
b.WriteString("\n\n[recent turn]\n")
for _, msg := range turn {
    // 记忆提取只看本轮消息的角色和文本内容，避免把大型工具结果再次塞进后台请求。
    // 如果某个项目事实只藏在 ToolResult 里，助手需要在正文中概括它，Memory 才更容易保存。
    b.WriteString("role=" + msg.Role + "\n")
    if msg.Content != "" {
        b.WriteString(msg.Content + "\n")
    }
}
return []llm.Message{{Role: "user", Content: b.String()}}
```

ToolCall 参数和 ToolResult 正文没有进入提取 Prompt。这样可以避免巨型工具输出再次污染记忆请求，但也意味着某项项目知识如果只出现在 ToolResult、没有被助手文本概括，就不会被长期记忆模型看到。

## 从流式文本中提取 JSON

Provider 仍返回统一 StreamEvent。Memory 累积 Text，遇到错误立即失败，再移除可选代码围栏并提取数组：

```go
func collectJSONOperations(
    ctx context.Context,
    provider llm.Provider,
    messages []llm.Message,
) ([]Operation, error) {
    var b strings.Builder
    for event := range provider.Stream(ctx, llm.Request{Messages: messages}) {
        if event.Err != nil {
            return nil, event.Err
        }
        b.WriteString(event.Text)
        if event.Done {
            break
        }
    }
    raw := extractJSONArray(b.String())
    if raw == "" {
        return nil, errors.New("empty memory update response")
    }
    var ops []Operation
    if err := json.Unmarshal([]byte(raw), &ops); err != nil {
        return nil, err
    }
    return ops, nil
}
```

当响应前面有包装文字时，数组扫描会从第一个 `[` 开始配平，并跳过 JSON 字符串内部的方括号和转义字符。但若去除围栏后的文本直接以 `[` 开头，`extractJSONArray` 会原样返回整个剩余文本；数组后的尾随说明仍会导致 JSON 解析失败。失败只写日志，不会重试或影响已经完成的用户请求。

## Store 负责路径和文件变更

合法 Operation 按 Level 分组，Project Store 先 Apply，User Store 后 Apply。Store 持有自己的互斥锁，创建目录后顺序执行操作：

```go
for _, op := range ops {
    // Manager 已经按 Level 分组；这里再检查一次，是为了让 Store 单独使用时也不会写错目录。
    if op.Level != "" && op.Level != s.Level {
        continue
    }
    switch op.Action {
    case "create":
        if err := s.create(op, now); err != nil {
            return err
        }
    case "update":
        if err := s.update(op, now); err != nil {
            return err
        }
    case "delete":
        if err := s.delete(op); err != nil {
            return err
        }
    case "", "noop":
        continue
    default:
        return fmt.Errorf("unsupported memory action: %s", op.Action)
    }
}
```

`NotePath` 拒绝路径分隔符和目录穿越；Create 用 NoteType 与安全化 Slug 生成文件名；Update 保留原 `created` 时间并刷新 `updated`；Delete 同时删除正文和索引行。每次正文变更后，Store 再更新 `MEMORY.md`。

## 更新后的内容何时可见

```text
本轮 Run 开始：读取当前 Memory Index -> Stable System
  -> 模型 / 工具循环
  -> 主 Agent 正常完成
  -> 立即向 TUI 发送完成结果
  -> 后台模型提取 Operation
  -> Validate + Project/User Store Apply
  -> Manager 刷新内存中的 Index
  -> 下一次新的 Run 读取更新后 Index
```

当前 Run 的稳定 System 已经构造完成，所以后台更新不会反向改变刚结束的模型上下文。它面向的是下一次 Run 和后续会话。

## 当前实现的边界

- Manager 没有 `Wait` 或 `Close` 来等待后台更新。用户在最终回答后立即退出进程，本轮 Memory 可能丢失，而 Session JSONL 不受影响。
- Project 正文、Project 索引、User 正文和 User 索引是多个文件操作，不构成事务。后一步失败时，前面已经写入的文件不会回滚。
- 排队任务的旧索引快照可能过时，模型可能据此创建重复 Note 或覆盖判断不完整。
- `trimIndex` 先按行、再直接按字节切片；25 KiB 边界恰好落在多字节字符中间时，可能产生无效 UTF-8。
- Create 的安全 Slug 对应已有文件时使用 `WriteFile` 覆盖，没有文件级 compare-and-swap。
- `extractJSONArray` 对“前置说明 + JSON”有容错，但对“JSON + 尾随说明”并不总是容错。
- 现有 Memory 测试覆盖 Store、路径、索引顺序与上限、Prompt、JSON 提取和 Operation 校验，但没有直接等待并验证 `UpdateAsync` 的真实异步 Provider 到磁盘集成路径。

## 为什么不用完整会话自动续写 Memory

长期 Memory 是筛选结果，不是 Session 的副本。只分析本轮增量可以降低提取成本和重复操作；用结构化 Operation 可以让模型负责语义判断，让 Store 负责路径与格式校验；索引与正文分离则把每轮 Prompt 成本限制在固定范围。

代价是这是最终一致而非同步事务。该设计适合“稳定偏好和项目知识晚一轮可见”的场景，不适合必须在进程退出前确认落盘的审计数据。

## 小结

PseudoClaude 将长期记忆实现为一条后台提取管线：Runner 选择本轮消息，模型生成结构化操作，Manager 串行协调两个 Store，System Prompt 只消费受限索引。它让最终回答不等待记忆推理，也明确接受了退出丢失、旧快照和多文件非事务等一致性成本。

下一篇讨论同一会话内部的另一个成本问题：当 Tool Result 和历史逐渐逼近模型窗口时，系统如何先做无损落盘，再做带近期闭环的有损摘要。
