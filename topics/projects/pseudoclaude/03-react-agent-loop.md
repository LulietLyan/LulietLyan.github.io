---
title: ReAct 执行循环：模型、工具与结果如何闭环
description: How the PseudoClaude runner closes the ReAct loop across model streaming, tool calls, result feedback, and stop conditions.
date: 2026-08-21
order: 3
tags:
  - PseudoClaude
  - ReAct
  - Agent
  - Go
---

普通聊天程序在模型返回文本后就可以结束一次请求。Coding Agent 不同：模型可能先要求读取文件，根据结果再搜索代码，然后修改实现并运行测试。一次用户输入因此对应多次模型请求。

PseudoClaude 将这个过程集中在 `internal/agent/runner.go`。它实现的是一个 ReAct 式循环：模型提出动作，程序执行动作并把观察结果写回会话，模型再基于更新后的会话决定下一步。这里的“Reason”指模型根据上下文做决策，系统并不保存或展示模型的隐藏思维链。

## 循环的输入与输出

Runner 依赖 Provider、Registry、工具环境和 Conversation 等运行时对象：

```go
type Request struct {
    Mode           Mode
    UserText       string
    PlanTask       string
    PlanText       string
    PermissionMode permission.Mode
    Conversation   *conversation.Conversation
}

func (r Runner) Run(ctx context.Context, req Request) <-chan Event {
    events := make(chan Event)
    go func() {
        defer close(events)
        r.run(ctx, req, events)
    }()
    return events
}
```

返回值不是最终文本，而是 Event channel。因为一次运行中还会出现文本增量、工具开始、工具结果、审批、Usage、错误和停止原因。TUI 可以即时消费这些事件，后台 Task 也可以用相同执行层而不依赖终端渲染。

循环开始前，Runner 会补齐缺省对象、选择权限模式、写入用户消息，并构造稳定 System Prompt。Provider 为空属于无法继续的错误，会先发 `EventError`，再以 `StopStreamError` 结束。

## Provider 是模型边界

Runner 不直接依赖 OpenAI 或 Anthropic SDK。`internal/llm/provider.go` 将供应商差异收敛为一个接口和一套内部消息：

```go
type Request struct {
    Messages []Message
    Tools    []tools.Definition
    System   System
    Reminder string
}

type Provider interface {
    Name() string
    Model() string
    Stream(ctx context.Context, req Request) <-chan StreamEvent
}

type StreamEvent struct {
    Text     string
    ToolCall *ToolCall
    Usage    *Usage
    Done     bool
    Err      error
}
```

Provider 的职责是把内部 Request 转成具体 SDK 请求，并把响应重新适配为 `StreamEvent`。Runner 只关心本轮最终收集到的文本、工具调用和 Usage，因此更换模型协议不会改变 ReAct 控制流。

## 一轮模型请求

每次迭代前，Runner 先让 Compact 模块检查上下文，然后构造模型请求：

```go
environment := prompt.GatherEnvironment(
    r.Version,
    r.Provider.Name(),
    r.Provider.Model(),
    r.Env.CWD,
).Render()

modelReq := llm.Request{
    Messages: req.Conversation.Messages(),
    Tools:    defs,
    System: llm.System{
        Stable:      stableSystem,
        Environment: environment,
    },
    Reminder: r.reminder(req.Mode, iteration),
}

out, err := collector.collect(
    ctx,
    iteration,
    r.Provider.Stream(ctx, modelReq),
    events,
)
```

`Messages` 是当前 Conversation 快照，`Tools` 是本轮允许模型看到的工具契约。System 被分成相对稳定的规则、Instructions、Skill 摘要、Memory 索引，以及每轮重新采集的工作目录、Git 状态、日期、Provider 等环境信息。

Collector 一边累计完整输出，一边把 Text Delta 和 Usage 转发给上游：

```go
if event.Text != "" {
    c.text.WriteString(event.Text)
    if !sendEvent(ctx, events, Event{
        Type: EventTextDelta, Iteration: iteration, Text: event.Text,
    }) {
        return roundOutput{}, ctx.Err()
    }
}
if event.ToolCall != nil {
    c.toolCalls = append(c.toolCalls, *event.ToolCall)
}
if event.Done {
    return c.output(), nil
}
```

TUI 看到的是 Text Delta，而 Conversation 保存的是本轮收集完毕后的完整 Assistant 文本。这样不会因为每个 token 都写一条历史消息，也不会让下一轮读到半截回复。

## ToolCall 如何变成下一轮上下文

一次工具闭环的关键不是“调用了某个函数”，而是消息写入顺序：

```go
if strings.TrimSpace(out.Text) != "" {
    req.Conversation.AddAssistant(out.Text)
    sendEvent(ctx, events, Event{
        Type: EventAssistantText, Iteration: iteration, Text: out.Text,
    })
}
if len(out.ToolCalls) == 0 {
    // 省略 Usage anchor、Memory 更新和 Stop Hook。
    sendStop(ctx, events, iteration, StopCompleted, "completed")
    return
}

req.Conversation.AddAssistantToolCalls(out.ToolCalls)
results, err := executeToolCalls(
    ctx, r.Registry, r.Env, iteration, out.ToolCalls,
    events, toolOpts, r.Permission, permissionMode, hooks,
)
for _, result := range results {
    req.Conversation.AddToolResult(llm.ToolResult{
        CallID:  result.Call.ID,
        Name:    result.Call.Name,
        Content: result.Result.JSON(),
        IsError: !result.Result.OK,
    })
}
```

对应的消息序列是：

```text
user: 原始任务
assistant: tool_calls(read_file)
user: tool_result(read_file)
assistant: 基于文件内容继续回答或调用下一个工具
```

工具结果使用 `CallID` 与 Assistant 发出的 ToolCall 对齐。无论结果成功、权限拒绝还是参数错误，它都会以结构化 JSON 写回 Conversation。只要执行流程本身没有被取消，Runner 就进入下一轮，让模型看到错误并自行修正，而不是把每次工具失败都升级为整个 Agent 失败。

## Conversation 是事实源

`internal/conversation/conversation.go` 对消息追加和读取做了同步保护，并在写入后触发持久化 Hook：

```go
func (c *Conversation) AddAssistantToolCalls(calls []llm.ToolCall) {
    if len(calls) == 0 {
        return
    }
    msg := llm.Message{
        Role: "assistant",
        ToolCalls: append([]llm.ToolCall(nil), calls...),
    }
    c.mu.Lock()
    c.messages = append(c.messages, msg)
    hook := c.hooks.OnAppend
    c.mu.Unlock()
    callAppendHook(hook, msg)
}

func (c *Conversation) AddToolResult(result llm.ToolResult) {
    copyResult := result
    msg := llm.Message{Role: "user", ToolResult: &copyResult}
    c.mu.Lock()
    c.messages = append(c.messages, msg)
    hook := c.hooks.OnAppend
    c.mu.Unlock()
    callAppendHook(hook, msg)
}
```

Runner 每一轮都重新读取 `Conversation.Messages()`。因此真正驱动下一轮的不是临时局部变量，而是已经包含 ToolCall 与 ToolResult 的会话快照。Session 持久化和 Compact 替换也通过 Conversation Hook 接入，不需要在 ReAct 循环中分别维护第二份历史。

## 什么时候停止

循环不会只依赖模型“自觉结束”。当前 Runner 有五种明确的停止原因：

| 原因 | 触发条件 |
| --- | --- |
| `completed` | 本轮没有工具调用，得到最终文本或空响应 |
| `max_iterations` | 超过配置的最大迭代数 |
| `canceled` | Context 被取消或工具批次被中断 |
| `unknown_tool_limit` | 连续未知工具调用达到上限 |
| `stream_error` | Provider 或自动 Compact 返回错误 |

Runner 默认最多执行 15 轮，连续未知工具调用上限为 2。已知工具成功或产生已知结果后，未知计数会清零。这种限制针对的是失控循环，而不是把一个偶发的错误调用立即判为任务失败。

正常完成时，主 Agent 还会异步触发 Memory 更新；SubAgent 不执行这一步，避免多个子运行同时把局部任务写进长期记忆。

## 完整执行过程

把关键步骤合并起来，一次 ReAct 运行如下：

```text
用户输入写入 Conversation
  -> 构造 System、Environment、Tools、Messages
  -> Provider.Stream
  -> Collector 汇总 Text / ToolCalls / Usage
  -> 无 ToolCall：StopCompleted
  -> 有 ToolCall：写入 Assistant ToolCalls
  -> 执行工具并产生 ToolResult
  -> ToolResult 写回 Conversation
  -> 下一轮 Provider.Stream
```

这里没有一个单独名为 `ReAct` 的类型。ReAct 是由 Provider、Conversation、Registry 和 Runner 循环共同形成的执行协议。

## 小结

PseudoClaude 的 Agent 能连续推进任务，关键在于 Runner 将模型输出和本地观察组织成可重复的消息闭环。模型决定下一步动作，程序控制动作是否执行并记录结果，Conversation 则把每一次观察带入下一轮。

下一篇将把这个循环中的“执行工具”单独展开，说明模型看到的 Tool Definition 如何最终路由到受控的 Go 实现。
