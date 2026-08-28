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
// Request 描述一次 Agent 运行所需的输入和上下文。
// PlanTask 与 PlanText 分别表示原始任务和已确认的执行计划，仅在对应模式下使用。
type Request struct {
	Mode           Mode                       // 运行模式，决定提示词以及可暴露给模型的工具。
	UserText       string                     // Chat 模式下发送给模型的用户输入。
	PlanTask       string                     // Plan/Do 模式下需要规划或执行的原始任务。
	PlanText       string                     // Do 模式下已经确认、等待执行的计划正文。
	PermissionMode permission.Mode            // 本次运行的工具权限模式；为空时由 Runner 的权限引擎或系统默认值决定。
	Conversation   *conversation.Conversation // 可变的会话历史；运行期间会向其中追加消息，为 nil 时自动创建。
}


// Run 异步执行一次 Agent 请求，并按产生顺序返回事件流。
// 返回的通道使用方应持续读取直至关闭；取消 ctx 会终止运行，通道只由 Run 关闭。
// 事件通道无缓冲，因此使用方的读取速度会对后台执行形成背压。
func (r Runner) Run(ctx context.Context, req Request) <-chan Event {
	// 使用无缓冲通道维持事件顺序，并避免生产方无限积压事件。
	events := make(chan Event)
	go func() {
		// 无论正常完成、取消还是发生错误，都统一结束事件流。
		defer close(events)
		r.run(ctx, req, events)
	}()
	return events
}
```

返回值不是最终文本，而是 Event channel。因为一次运行中还会出现文本增量、工具开始、工具结果、审批、Usage、错误和停止原因。TUI 可以即时消费这些事件，后台 Task 也可以用相同执行层而不依赖终端渲染。

这里的 `Run` 和 `run` 分工不同。`Run` 只负责创建事件通道、启动 goroutine，并在 goroutine 退出时关闭通道；`r.run(ctx, req, events)` 才是一次 Agent 运行的实际入口。

`r.run` 大致按以下顺序执行：

1. 初始化运行参数。它补齐空的 `Context`、`Conversation` 和 `Registry`，规范化最大迭代次数等配置；如果是 SubAgent，还会用 SubAgent 的轮次限制覆盖默认值。Provider 为空时无法继续，Runner 会发送 `EventError` 和 `StopStreamError` 后返回。
2. 准备本次请求。它根据 Chat、Plan 或 Do 模式生成用户文本、筛选可见的 Tool Definition，并确定工具执行限制；随后选择 Permission Mode，把用户消息写入 Conversation，再根据 Instructions、Skill Catalog 和 Memory Index 构造稳定 System Prompt。
3. 进入迭代循环。每轮先检查取消状态和最大迭代数，再按需压缩上下文、执行相关 Hook、采集当前环境和已激活 Skill，最后把 Conversation、Tools、System 和 Reminder 交给 Provider。模型返回的流由 Collector 汇总为文本、ToolCall 和 Usage，同时通过 `events` 向调用方报告进度。
4. 处理本轮结果。Assistant 文本会写回 Conversation；如果没有 ToolCall，本次运行正常结束，主 Agent 还会触发异步 Memory 更新。如果有 ToolCall，Runner 会先记录调用，再经过模式限制、权限检查和 Hook 执行工具，并把每个 ToolResult 写回 Conversation，供下一轮模型请求使用。
5. 结束运行。完成、取消、超过迭代上限、连续调用未知工具或流式请求出错都会产生对应的 Stop Event。`r.run` 返回后，外层 goroutine 执行 `defer close(events)`，调用方由此知道事件已经全部发送完毕。

后面的章节分别展开第 3、4 步中的 Provider 请求、流式收集、工具执行和 Conversation 更新。

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
// 收集当前运行环境；已加载技能的完整 SOP 只进入可逐轮更新的动态环境。
environment := prompt.GatherEnvironment(r.Version, r.Provider.Name(), r.Provider.Model(), r.Env.CWD).Render()
// load_skill 在上一轮写入 ActiveSkills；这里把完整 SOP 加入下一轮动态环境。
if active := prompt.RenderActiveSkills(r.activeSkillEntries()); active != "" {
    environment = strings.TrimSpace(environment) + "\n\n" + active
}

// 组合会话、工具、系统提示词和轮次提醒，形成完整的模型请求。
modelReq := llm.Request{
    Messages: req.Conversation.Messages(),
    Tools:    defs,
    System: llm.System{
        Stable:      stableSystem,
        Environment: environment,
    },
    Reminder: r.reminder(req.Mode, iteration),
}

// 消费模型的流式响应，同时把文本增量和用量等事件转发给调用方。
out, err := collector.collect(ctx, iteration, r.Provider.Stream(ctx, modelReq), events)
if err != nil {
    // Context 取消与模型流错误使用不同的停止原因，便于调用方区分用户中止和服务故障。
    if ctx.Err() != nil {
        sendStop(context.Background(), events, iteration, StopCanceled, "canceled")
        return
    }
    r.dispatchHook(ctx, hook.EventNotification, permissionMode, hook.Payload{"kind": "stream_error", "detail": err.Error()})
    sendEvent(ctx, events, Event{Type: EventError, Iteration: iteration, Err: err})
    sendStop(ctx, events, iteration, StopStreamError, err.Error())
    return
}
```

`Messages` 是当前 Conversation 快照，`Tools` 是本轮允许模型看到的工具。System 被分成相对稳定的规则、Instructions、Skill 摘要、Memory 索引，以及每轮重新采集的工作目录、Git 状态、日期、Provider 等环境信息。

Collector 一边累计完整输出，一边把 Text Delta 和 Usage 转发给上游：

```go
// collect 持续消费模型的流式响应，聚合完整文本、工具调用和最新 Usage，
// 同时把需要实时展示的文本增量与 Usage 事件转发给 Runner 的调用方。
func (c *streamCollector) collect(ctx context.Context, iteration int, stream <-chan llm.StreamEvent, events chan<- Event) (roundOutput, error) {
	// 持续读取，直到 Context 取消、模型流关闭、模型报错或收到 Done 事件。
	for {
		select {
		// 调用方取消运行时立即退出，不再等待模型流自行关闭。
		case <-ctx.Done():
			return roundOutput{}, ctx.Err()
		case event, ok := <-stream:
			// Provider 关闭通道也视为本轮正常结束，返回目前已经聚合的内容。
			if !ok {
				return c.output(), nil
			}
			// 流事件携带错误时停止收集，由上层决定错误事件和停止原因。
			if event.Err != nil {
				return roundOutput{}, event.Err
			}

			// 文本以增量形式到达：一份累加为最终回复，一份立即转发给界面展示。
			if event.Text != "" {
				c.text.WriteString(event.Text)
				if !sendEvent(ctx, events, Event{Type: EventTextDelta, Iteration: iteration, Text: event.Text}) {
					// sendEvent 返回 false 表示转发期间 Context 已取消。
					return roundOutput{}, ctx.Err()
				}
			}

			// 工具调用只在这里按模型返回顺序收集，流结束后再由 Runner 统一执行。
			if event.ToolCall != nil {
				c.toolCalls = append(c.toolCalls, *event.ToolCall)
			}

			// 复制 Usage，避免持有 Provider 管理的指针；后到的统计覆盖先到的统计。
			if event.Usage != nil {
				usage := *event.Usage
				c.usage = &usage
				if !sendEvent(ctx, events, Event{Type: EventUsage, Iteration: iteration, Usage: &usage}) {
					// Usage 转发同样服从取消信号，避免后台 goroutine 阻塞。
					return roundOutput{}, ctx.Err()
				}
			}

			// Done 是 Provider 显式给出的完成标记，此时返回本轮聚合结果。
			if event.Done {
				return c.output(), nil
			}
		}
	}
}
```

TUI 看到的是 Text Delta，而 Conversation 保存的是本轮收集完毕后的完整 Assistant 文本。这样不会因为每个 token 都写一条历史消息，也不会让下一轮读到半截回复。

## ToolCall 如何变成下一轮上下文

理解 ToolCall 闭环前，先要分清 Collector、Runner 和事件通道之间的关系。`streamCollector` 不是 `Runner` 的字段，而是 `r.run` 在每次模型请求前创建的局部对象：

```go
collector := &streamCollector{}
out, err := collector.collect(
    ctx,
    iteration,
    r.Provider.Stream(ctx, modelReq),
    events,
)
```

Collector 只保存当前一轮模型响应的临时状态。下一轮会创建新的 Collector，避免上一轮文本、ToolCall 或 Usage 混入本轮；多个 Runner 并发执行时，也不会争用同一个收集器。

这次 `collect` 调用有两个完全不同的输出路径：

| 输出 | 传递方式 | 接收者 | 用途 |
| --- | --- | --- | --- |
| `roundOutput` | 普通函数返回值 | `r.run` 中的 `out` | 写 Conversation、判断是否执行工具 |
| `Event` | 写入 `events` channel | Run 的调用方，通常是 TUI | 实时显示文本、Usage 和执行状态 |

这里还有一组名字很像、方向相反的类型：Collector 从 `stream` 读取的是 Provider 产生的 `llm.StreamEvent`；它调用 `sendEvent` 时构造的则是 Agent 层的 `Event`。前者是模型协议归一化后的入站数据，后者是 Runner 暴露给界面的出站数据。

数据流可以画成：

```text
Provider.Stream 返回 llm.StreamEvent
              |
              v
       streamCollector.collect
          |                 |
          | c.output()      | sendEvent(events, ...)
          v                 v
   roundOutput -> r.run     Event channel -> TUI
   完整 Text/ToolCalls      实时 TextDelta/Usage
   最新 Usage
```

### 同一个 channel 如何一路传到 Collector

`Run` 创建 `events`，传给后台执行的 `r.run`，同时把它返回给调用方：

```go
func (r Runner) Run(ctx context.Context, req Request) <-chan Event {
    events := make(chan Event)
    go func() {
        defer close(events)
        r.run(ctx, req, events)
    }()
    return events
}
```

`r.run` 再把这个 channel 传给 `collector.collect`。Go 的 channel 值指向同一个底层通道，作为参数传递不会创建一条新的事件流。因此 Collector 中的：

```go
sendEvent(ctx, events, Event{
    Type:      EventTextDelta,
    Iteration: iteration,
    Text:      event.Text,
})
```

写入的正是 `Run` 返回给调用方的源通道。Runner 自己不会再从中读取；TUI 先用 `bridgeAgentEvents` 把源通道接入自己的事件流，再由 `waitForAgentEvent` 逐条接收，并把 `EventTextDelta` 追加到当前回复。

Collector 只直接发布 Text Delta 和 Usage。ToolCall 先保存在 `roundOutput` 中；等 Runner 真正进入工具执行阶段后，`executeOneTool` 才向同一条 Agent 事件流发送 `EventToolCallStart`、`EventToolResult` 和 `EventToolCallDone`。

### 聚合结果如何回到 Runner

实时事件走 channel，完整结果则走普通返回值。Provider 如果依次返回文本片段 `"hel"`、`"lo"`、一个 ToolCall、Usage 和 Done，Collector 会这样处理：

1. 收到 `"hel"`，把它追加到 `c.text`，同时向 TUI 发送 `EventTextDelta("hel")`。
2. 收到 `"lo"`，此时 `c.text` 变成 `"hello"`，TUI 再收到一个文本增量。
3. 收到 ToolCall，只追加到 `c.toolCalls`，此时还不执行工具。
4. 收到 Usage，保存最新副本，同时发送 `EventUsage`。
5. 收到 Done，`c.output()` 返回本轮聚合结果。

```go
func (c *streamCollector) output() roundOutput {
    return roundOutput{
        Text:      c.text.String(),
        ToolCalls: append([]llm.ToolCall(nil), c.toolCalls...),
        Usage:     c.usage,
    }
}
```

这个返回值被赋给 `r.run` 中的 `out`。因此 `r` 不需要拥有 Collector 字段，也不需要从事件通道反向读取结果：

```go
out, err := collector.collect(ctx, iteration, r.Provider.Stream(ctx, modelReq), events)
// out.Text == "hello"
// out.ToolCalls 包含本轮模型提出的调用
```

### `out.ToolCalls` 如何形成闭环

Runner 拿到 `roundOutput` 后，先保存模型已经生成的完整文本。没有 ToolCall 表示模型已经给出最终答复，本次运行可以结束；存在 ToolCall 时才进入工具阶段：

```go
if strings.TrimSpace(out.Text) != "" {
    req.Conversation.AddAssistant(out.Text)
    sendEvent(ctx, events, Event{
        Type: EventAssistantText, Iteration: iteration, Text: out.Text,
    })
}
if len(out.ToolCalls) == 0 {
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

这里的顺序不能交换：必须先记录 Assistant 发出的 ToolCall，再记录工具结果。`CallID` 将每个 ToolResult 与原始调用对齐，最终形成模型协议需要的消息序列：

```text
user: 原始任务
assistant: tool_calls(call_1 = read_file)
user: tool_result(call_1 = 文件内容)
assistant: 基于文件内容继续回答或调用下一个工具
```

工具成功、参数错误、权限拒绝和未知工具都会生成结构化 ToolResult。只要整个工具执行流程没有被取消，普通工具错误就作为 Observation 写回会话，让模型在下一轮解释错误、修正参数或改用其他工具。

## Conversation 才是跨轮次状态

Collector、Conversation 和事件通道的生命周期不同：

| 对象 | 生命周期 | 保存什么 |
| --- | --- | --- |
| `streamCollector` | 一次模型请求 | 本轮 Text、ToolCalls、Usage |
| `Conversation` | 整次 Agent 运行，并可由 Session 持久化 | 下一轮模型真正读取的消息历史 |
| `events` channel | 一次 `Runner.Run` | 发给 TUI 或后台 Task 的实时事件 |

工具执行结束后，代码自然回到 `for iteration := 1; ; iteration++` 的下一次循环。新一轮构造请求时重新读取 Conversation：

```go
modelReq := llm.Request{
    Messages: req.Conversation.Messages(),
    Tools:    defs,
    System: llm.System{
        Stable:      stableSystem,
        Environment: environment,
    },
    Reminder: r.reminder(req.Mode, iteration),
}
```

这时 `Messages` 已经包含上一轮的 Assistant ToolCall 和对应 ToolResult。真正把观察结果带进下一轮的不是 Collector，也不是事件通道，而是 Conversation。

Conversation 的追加操作还会触发 Session Hook，把消息写入会话日志；Compact 则可以原子替换当前有效消息。ReAct 循环只维护这一份事实源，不需要另外同步一套“给模型看的历史”。

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

把两条输出路径和工具闭环合并起来，一次 ReAct 运行如下：

```text
用户输入写入 Conversation
  -> 构造 System、Environment、Tools、Messages
  -> Provider.Stream
  -> Collector 消费 llm.StreamEvent
       |-> TextDelta / Usage 写入 events -> TUI 实时展示
       `-> roundOutput 返回 r.run
  -> r.run 保存完整 Assistant Text
  -> 无 ToolCall：发送 StopCompleted
  -> 有 ToolCall：写入 Conversation 的 Assistant ToolCalls
  -> 执行工具并产生 ToolResult
  -> ToolResult 写回 Conversation，并通过 CallID 对齐调用
  -> 下一轮重新读取 Conversation.Messages()
  -> Provider.Stream 看到上一轮的调用与观察结果
```

这里没有一个单独名为 `ReAct` 的类型。ReAct 是由 Provider 提供模型流、Collector 归一化单轮结果、Registry 执行工具、Conversation 保存跨轮次状态、Runner 调度循环共同形成的执行协议。

## 小结

PseudoClaude 的 Agent 能连续推进任务，关键在于分开处理“实时展示”和“下一轮推理”。Collector 把 Text Delta 与 Usage 通过 channel 立即交给界面，同时把完整 `roundOutput` 返回给 Runner；Runner 再把 ToolCall 和 ToolResult 按协议顺序写入 Conversation，由下一轮模型请求重新读取。

下一篇将把这个循环中的“执行工具”单独展开，说明模型看到的 Tool Definition 如何最终路由到受控的 Go 实现。
