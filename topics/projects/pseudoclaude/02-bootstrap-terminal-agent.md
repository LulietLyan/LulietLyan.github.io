---
title: 搭建一个最小可用终端 Agent
description: 一个 Coding Agent 的最小实现需要 TUI、Provider、Conversation 和工具结果回灌。
date: 2026-08-21
order: 2
tags:
  - PseudoClaude
  - Terminal
  - Bubble Tea
  - Go
---

如果以最小可用版本为目标，PseudoClaude 不应首先实现 MCP、Skill、Team 这些扩展能力。基础闭环需要四个部分：

```text
Terminal input
  -> LLM streaming response
  -> Conversation history
  -> Tool call and tool result feedback
```

本文先不展开完整源码，而是说明最小骨架如何逐步演进为当前项目结构。

## 第一步：终端界面只做状态机

PseudoClaude 的 TUI 在 `internal/tui`。核心结构是 `Model`，定义在 `internal/tui/tui.go`。

它维护这些状态：

```go
type sessionState int

const (
    stateSelecting sessionState = iota
    stateIdle
    stateStreaming
    stateApproving
    stateResuming
)
```

最小版本只需要两个状态：

- `stateIdle`：用户可以输入。
- `stateStreaming`：模型正在输出。

现有项目把审批、恢复会话、选择 provider 都加进去了，但核心输入路径仍然很清晰：

```text
updateIdle
  -> 按 Enter
  -> dispatchInput(text)       // 如果是 slash command 就本地处理
  -> submitUserText(text)
  -> submitAgentTextWithTools(...)
```

对应代码在 `internal/tui/stream.go`。这里有一个关键设计：TUI 不直接调用 OpenAI SDK，也不直接执行工具。它只把运行时依赖写进 `m.runner`，然后调用：

```go
events := bridgeAgentEvents(m.runner.Run(ctx, req))
```

这让 TUI 和 Agent 执行逻辑保持分离。TUI 只消费事件：

```text
EventTextDelta
EventToolResult
EventApproval
EventStop
EventError
```

最初版本可以进一步简化为：

```text
用户输入
  -> 调 provider.Stream
  -> 每收到 delta 就打印
```

但只要你想支持工具调用，就必须引入 Runner。

## 第二步：把一次模型请求抽成 Provider

直接在 TUI 里写 OpenAI 或 Anthropic 调用，很快会变成混乱的 SDK 适配代码。

PseudoClaude 在 `internal/llm/provider.go` 里抽了一个接口：

```go
type Provider interface {
    Name() string
    Model() string
    Stream(ctx context.Context, req Request) <-chan StreamEvent
}
```

内部统一使用 `llm.Request`：

```go
type Request struct {
    Messages []Message
    Tools    []tools.Definition
    System   System
    Reminder string
}
```

这一步的价值是：Runner 只认识 `Provider.Stream`，不关心底层是 OpenAI 还是 Anthropic。

OpenAI 的适配在 `internal/llm/openai.go`：

- `toOpenAIMessages`：把内部消息转成 Chat Completions messages。
- `toOpenAITools`：把 `tools.Definition` 转成 function tool schema。
- `finalizeOpenAIStream`：补发最终工具调用和 usage。

Anthropic 的适配在 `internal/llm/anthropic.go`：

- `toAnthropicMessages`
- `toAnthropicTools`
- `toAnthropicSystem`
- `appendAnthropicReminder`

两个 provider 最终都吐出同一种 `StreamEvent`：

```go
type StreamEvent struct {
    Text     string
    ToolCall *ToolCall
    Usage    *Usage
    Done     bool
    Err      error
}
```

在这个阶段，第一个重要抽象是避免让主循环依赖具体模型 SDK。

## 第三步：Conversation 是事实源

模型聊天不是单次请求。每一轮都要带上历史消息、工具调用和工具结果。

PseudoClaude 用 `internal/conversation/conversation.go` 管消息：

```go
type Conversation struct {
    mu       sync.Mutex
    messages []llm.Message
    hooks    Hooks
}
```

最常用的方法：

- `AddUser(text)`
- `AddAssistant(text)`
- `AddAssistantToolCalls(calls)`
- `AddToolResult(result)`
- `Messages()`

工具结果为什么也是消息？因为模型下一轮必须看到工具执行结果，否则它无法继续推理。

在内部格式里，工具结果是：

```go
type ToolResult struct {
    CallID  string
    Name    string
    Content string
    IsError bool
}
```

`Conversation.AddToolResult` 会把它包装成一个 `Role: "user"` 的消息。这符合主流 tool calling 协议：工具执行结果通常作为用户侧消息回传给模型。

最小实现可以先只保存文本消息：

```text
user -> assistant -> user -> assistant
```

但只要支持工具，就要保存：

```text
user
assistant tool_calls
user tool_result
assistant
```

## 第四步：最小 Runner

最小 Runner 的伪代码像这样：

```text
append user message

loop:
  request model with messages and tool definitions
  collect text and tool calls

  if text:
    append assistant message

  if no tool calls:
    stop

  append assistant tool calls
  execute each tool
  append tool results
```

PseudoClaude 的完整版本在 `internal/agent/runner.go`。它额外做了很多工程化处理：

- 最大迭代次数。
- unknown tool 上限。
- Plan Mode。
- 自动上下文压缩。
- Hook 分发。
- 动态 environment。
- active skills 注入。
- memory update。
- permission mode。

但骨架仍然是上面的 loop。

这个 loop 就是 Coding Agent 的心脏。如果没有它，模型最多是聊天助手；有了它，模型才可以通过工具观察环境、改变环境、验证结果。

## 第五步：TUI 只消费事件

Runner 不应该直接打印文本。它应该发事件：

```go
type Event struct {
    Type       EventType
    Iteration  int
    Text       string
    ToolCall   *llm.ToolCall
    ToolResult *ToolResult
    Approval   *ApprovalRequest
    Usage      *llm.Usage
    Stop       *Stop
    Err        error
}
```

TUI 的 `handleAgentEvent` 根据事件更新界面：

```text
EventTextDelta      -> 累加当前回复
EventToolCallStart  -> 显示正在执行的工具
EventToolResult     -> transcript 里记录工具结果
EventApproval       -> 切到审批状态
EventStop           -> 收尾并回到 idle
```

这个设计会让后续扩展轻松很多：

- 后台任务可以复用 Runner，但不需要 TUI。
- `RunToCompletion` 可以把事件流收集成最终结果。
- Team member 可以作为无界面的 Runner 在后台跑。

## 最小版本和 PseudoClaude 的差距

最小终端 Agent：

```text
TUI
Provider
Conversation
Runner loop
几个工具
```

PseudoClaude 完整版本：

```text
TUI 状态机
Provider 适配层
ReAct Runner
Tool Registry
Permission Engine
Hook Engine
Session JSONL
Context Compact
Memory Manager
MCP Manager
Skill Catalog
Subagent Catalog
Task Manager
Team Manager
Worktree Manager
```

听起来多，但都是从最小骨架自然长出来的。

我的经验是：先把 Runner loop 做对，再加功能。否则很容易做出一个“看起来能力很多，但每个能力都绕过主链路”的系统。
