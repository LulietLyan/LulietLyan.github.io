---
title: Runner、Provider 与 ReAct 主循环
description: PseudoClaude 的执行核心：模型请求、流式事件、工具调用和下一轮回灌。
date: 2026-08-21
order: 3
tags:
  - PseudoClaude
  - ReAct
  - LLM
  - Go
---

PseudoClaude 里最值得先读透的文件，是 `internal/agent/runner.go`。

这不是因为它代码最多，而是因为它回答了 Coding Agent 最核心的问题：

```text
模型说要调用工具之后，程序到底怎么继续？
```

答案是 ReAct loop。

## Runner 的输入和输出

Runner 的公开入口是：

```go
func (r Runner) Run(ctx context.Context, req Request) <-chan Event
```

输入是一个 `agent.Request`：

```go
type Request struct {
    Mode           Mode
    UserText       string
    PlanTask       string
    PlanText       string
    PermissionMode permission.Mode
    Conversation   *conversation.Conversation
}
```

输出不是字符串，而是一条事件通道：

```go
<-chan Event
```

这点很重要。因为 Agent 执行过程中不只有最终回答，还有：

- 流式文本 delta。
- 工具开始执行。
- 工具执行结果。
- 权限审批请求。
- token usage。
- 停止原因。
- 错误。

所以 Runner 不能只返回 `string`。它必须返回事件流。

## 一轮请求前做了什么

`Runner.run` 一开始会做这些准备：

1. 规范化配置，例如最大迭代次数。
2. 确保 `Conversation` 存在。
3. 确保 `Registry` 存在。
4. 检查 `Provider` 是否为空。
5. 调 `prepareRequest` 拿到：
   - 用户文本。
   - 本轮暴露给模型的工具定义。
   - 工具执行限制。
6. 确定 permission mode。
7. 把用户输入写入 Conversation。
8. 构造 stable system prompt。

其中 `prepareRequest` 是模式切换的关键：

```text
ModePlan
  -> planPrompt
  -> 只暴露 read_only 工具
  -> 执行阶段也只允许 read_only

ModeDo
  -> doPrompt
  -> 暴露正常工具

ModeChat
  -> 原始用户输入
  -> 暴露正常工具
```

这就是 Plan Mode 的实现重点：不只是提示模型“不要修改”，而是从工具列表和执行选项两边同时限制。

## Stable System 和 Dynamic Environment

Runner 构造两类系统上下文。

第一类是 stable system prompt：

```go
stableSystem := prompt.BuildSystemPrompt(prompt.PromptInputs{
    Instructions:  r.Instructions,
    SkillsCatalog: prompt.RenderSkillsCatalog(r.skillCatalogItems()),
    Memory:        memoryIndex,
})
```

它包含：

- 固定行为规则。
- 项目/用户指令。
- Skill 摘要目录。
- 长期记忆索引。

第二类是每轮动态 environment：

```go
environment := prompt.GatherEnvironment(
    r.Version,
    r.Provider.Name(),
    r.Provider.Model(),
    r.Env.CWD,
).Render()
```

它包含：

- 当前工作目录。
- 平台。
- 日期。
- git status。
- provider。
- model。

两者分开有实际意义：stable 部分更适合缓存，environment 每轮可能变化。

## 模型请求和流式收集

每一轮循环里，Runner 组装 `llm.Request`：

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

然后调用：

```go
out, err := collector.collect(
    ctx,
    iteration,
    r.Provider.Stream(ctx, modelReq),
    events,
)
```

`Provider.Stream` 来自 `internal/llm/provider.go`：

```go
type Provider interface {
    Name() string
    Model() string
    Stream(ctx context.Context, req Request) <-chan StreamEvent
}
```

OpenAI 和 Anthropic 的 SDK 差异都被适配到这个接口后面。

Runner 不关心模型供应商，只关心收集结果：

- `out.Text`
- `out.ToolCalls`
- `out.Usage`

如果有文本，Runner 会：

```go
req.Conversation.AddAssistant(out.Text)
sendEvent(... EventAssistantText ...)
```

如果没有工具调用，本轮任务结束。

## 工具调用为什么要回灌

如果模型返回 tool calls，Runner 做两件事：

```go
req.Conversation.AddAssistantToolCalls(out.ToolCalls)
results, err := executeToolCalls(...)
```

工具执行完成后，每个结果都会写回 Conversation：

```go
req.Conversation.AddToolResult(llm.ToolResult{
    CallID:  result.Call.ID,
    Name:    result.Call.Name,
    Content: result.Result.JSON(),
    IsError: !result.Result.OK,
})
```

然后 Runner 不结束，而是进入下一轮。

这就是 ReAct：

```text
Reason: 模型决定要看文件
Act: 调用 read_file
Observe: 工具结果回灌给模型
Reason: 模型基于文件内容继续推理
Act: 调用 edit_file 或 run_command
Observe: 继续回灌
```

没有这个循环，工具调用只是一个孤立动作。只有回灌之后，模型才能把观察结果纳入下一步计划。

## Provider 适配：统一消息、工具和 usage

`internal/llm/openai.go` 做三类转换：

- `toOpenAIMessages(req)`：内部消息转 OpenAI message。
- `toOpenAITools(req.Tools)`：内部工具定义转 function schema。
- `openAIUsageFromCompletionUsage`：usage 归一化。

`internal/llm/anthropic.go` 做类似转换：

- `toAnthropicMessages`
- `toAnthropicTools`
- `toAnthropicSystem`
- `anthropicUsage`

工具定义来自 `tools.Definition`：

```go
type Definition struct {
    Name        string
    Description string
    InputSchema map[string]any
    Safety      Safety
    System      bool
    Timeout     time.Duration
}
```

这带来一个直接好处：新增 provider 时，不需要改 Runner，也不需要改工具系统。只要把内部 `llm.Request` 和 `tools.Definition` 适配成新 provider 的 API 参数即可。

## 停止条件

Runner 的停止不是简单 “stream done”。

它有几类停止原因：

- `StopCompleted`：没有工具调用，任务完成。
- `StopMaxIterations`：超过最大迭代次数。
- `StopCanceled`：上下文取消。
- `StopUnknownToolLimit`：未知工具调用太多。
- `StopStreamError`：模型流式请求出错。

这几个停止原因会通过 `EventStop` 发给 TUI 或后台任务管理器。

后台任务的 `task.Manager` 会根据 stop reason 映射状态：

```text
completed
failed
cancelled
max_turns
```

所以 Runner 的停止原因不是 UI 细节，而是整个系统生命周期的一部分。

## 从这里理解整个项目

读 PseudoClaude 时，只要抓住 Runner，就不会迷路：

```text
TUI 负责启动 Runner 和消费事件
Provider 负责把内部请求适配到模型 API
Tools 负责让模型观察和修改工作区
Permission/Hook 负责拦截工具调用
Conversation 负责保存每轮消息
Compact 负责在请求前管理上下文
Memory 负责任务结束后异步更新长期知识
Task/Team 负责复用 Runner 做后台和协作
```

Runner 是中心，但它不独裁。它通过接口和事件把其它模块连起来，这也是这个项目能继续扩展的原因。

