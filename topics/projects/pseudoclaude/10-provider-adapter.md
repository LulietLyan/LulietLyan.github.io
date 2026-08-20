---
title: Provider 适配层：统一 Anthropic 与 OpenAI 流式协议
description: 分析 internal/llm 如何把不同模型 SDK 的消息、工具调用、usage 和错误统一成 Runner 可消费的事件流。
date: 2026-08-21
order: 10
tags:
  - PseudoClaude
  - Go
  - LLM
---

PseudoClaude 支持 Anthropic 与 OpenAI-compatible API。两个 provider 的 SDK、消息格式、system prompt 表达、工具调用返回时机和 usage 字段并不一致。项目通过 `internal/llm` 包把这些差异限制在适配层内，对上只暴露统一的 `Provider` 接口。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

## Provider 接口

核心接口定义在 `internal/llm/provider.go`：

```go
type Provider interface {
    Name() string
    Model() string
    Stream(ctx context.Context, req Request) <-chan StreamEvent
}
```

Runner 只依赖这个接口。无论底层使用 Anthropic Messages API 还是 OpenAI Chat Completions API，Runner 看到的都是：

```go
type StreamEvent struct {
    Text     string
    ToolCall *ToolCall
    Usage    *Usage
    Done     bool
    Err      error
}
```

这种抽象把协议适配和执行循环分开。Provider 负责把内部请求翻译成 SDK 请求，并把 SDK 返回翻译成 `StreamEvent`；Runner 负责维护 conversation、执行工具、更新记忆和发出 `agent.Event`。

## 内部请求结构

`llm.Request` 是 provider 无关的请求结构：

```go
type Request struct {
    Messages []Message
    Tools    []tools.Definition
    System   System
    Reminder string
}
```

`Messages` 来自 `conversation.Conversation`。

`Tools` 来自 `tools.Registry.DefinitionsFiltered`，包含名称、描述、JSON schema、安全级别等信息。

`System` 分为 `Stable` 和 `Environment`。`Stable` 适合放长期不变的项目指令、Skill catalog 和记忆索引；`Environment` 则包含当前版本、provider、model、工作目录和 active skills。

`Reminder` 用于注入 Plan Mode 提醒、Hook prompt queue、任务通知和 Team mailbox 更新。

## 双层事件流

PseudoClaude 使用两层事件流。

第一层是 `llm.StreamEvent`，只描述 provider 返回：

```text
text delta
tool call
usage
done
error
```

第二层是 `agent.Event`，描述 Agent 运行语义：

```text
progress
text_delta
assistant_text
tool_call_start
tool_result
tool_call_done
approval
usage
stop
error
```

中间转换由 `internal/agent/collector.go` 完成：

```go
out, err := collector.collect(
    ctx,
    iteration,
    r.Provider.Stream(ctx, modelReq),
    events,
)
```

`streamCollector.collect` 会实时转发文本增量和 usage，同时聚合完整 assistant 文本和 tool calls。Runner 拿到 `roundOutput` 后再决定是否进入工具执行。

这层设计使 Provider 不需要理解权限、工具批处理、审批或 TUI 状态；Provider 只要持续产出模型语义事件即可。

## OpenAI 适配

OpenAI provider 位于 `internal/llm/openai.go`。

构造函数根据配置创建 client：

```go
opts := []option.RequestOption{option.WithAPIKey(cfg.APIKey)}
if cfg.BaseURL != "" {
    opts = append(opts, option.WithBaseURL(cfg.BaseURL))
}
client := openai.NewClient(opts...)
```

这允许接入 OpenAI 官方 API，也允许接入 OpenAI-compatible endpoint。

`openAIProvider.Stream` 使用 Chat Completions streaming：

```go
stream := p.client.Chat.Completions.NewStreaming(ctx, openai.ChatCompletionNewParams{
    Model:         openai.ChatModel(p.cfg.Model),
    Messages:      toOpenAIMessages(req),
    Tools:         toOpenAITools(req.Tools),
    StreamOptions: openai.ChatCompletionStreamOptionsParam{IncludeUsage: openai.Bool(true)},
})
```

适配逻辑的重点有三个。

第一，文本 delta 直接转成 `StreamEvent{Text: text}`。

第二，使用 `openai.ChatCompletionAccumulator` 聚合流式 chunk。当 accumulator 发现 tool call 完成时，通过 `sendOpenAIToolCall` 尽早发送工具调用。

第三，流结束后调用 `finalizeOpenAIStream`，补发未发送的 tool call、usage 和 done 事件。

OpenAI-compatible 服务有时会在流末尾返回空 JSON 或 unexpected EOF。实现中通过 `isOpenAICompatibleEmptyJSONTail` 做兼容：如果已经收到有效流内容，并且尾部错误属于这类兼容问题，就尝试正常 finalize。

## Anthropic 适配

Anthropic provider 位于 `internal/llm/anthropic.go`。

`anthropicProvider.Stream` 使用 Messages streaming：

```go
params := anthropic.MessageNewParams{
    Model:     anthropic.Model(p.cfg.Model),
    MaxTokens: anthropicMaxTokens,
    System:    toAnthropicSystem(req.System),
    Messages:  msgs,
    Tools:     anthropicTools,
}
```

如果配置开启 thinking，则设置：

```go
params.Thinking = anthropic.ThinkingConfigParamOfEnabled(anthropicThinkingBudgetTokens)
```

流式处理时，provider 累积完整 `anthropic.Message`，并只将 `TextDelta` 转给上层。`ThinkingDelta` 被忽略，因为它不属于普通 assistant 文本。

工具调用的处理时机和 OpenAI 不同。Anthropic 实现会在最终 message 累积完成后遍历 content blocks，提取 `ToolUseBlock`，再发送 `StreamEvent{ToolCall: ...}`。

Runner 不关心 tool call 是流中早到还是结束后到。只要 `streamCollector.collect` 收到完整 round output，就能进入统一工具执行路径。

## System Prompt 的差异

OpenAI 适配把 stable system 和 environment 合并为一条 system message：

```go
if environment := strings.TrimSpace(req.System.Environment); environment != "" {
    system += "\n\n" + environment
}
out = append(out, openai.SystemMessage(system))
```

Anthropic 适配则把 `System` 转成多个 text block：

```go
if stable := strings.TrimSpace(sys.Stable); stable != "" {
    out = append(out, anthropic.TextBlockParam{
        Text: stable,
        CacheControl: anthropic.CacheControlEphemeralParam{
            TTL: anthropic.CacheControlEphemeralTTLTTL5m,
        },
    })
}
if environment := strings.TrimSpace(sys.Environment); environment != "" {
    out = append(out, anthropic.TextBlockParam{Text: environment})
}
```

这里有一个细节：Anthropic stable system 使用 ephemeral cache control。对于相对稳定的项目指令、Skill catalog 和记忆索引，缓存能降低重复请求成本；environment 不设置同样缓存，因为它更容易随工作目录、provider、active skill 等状态变化。

## Tool Schema 转换

内部工具定义使用 `tools.Definition`：

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

OpenAI 转换为 `ChatCompletionFunctionTool`：

```go
openai.ChatCompletionFunctionTool(shared.FunctionDefinitionParam{
    Name:        def.Name,
    Description: openai.String(def.Description),
    Parameters:  openai.FunctionParameters(def.InputSchema),
})
```

Anthropic 转换为 `ToolParam`。由于 SDK 类型对 schema 字段有结构要求，实现会拆出 `properties`、`required`，并把其他字段放入 `ExtraFields`。

这说明内部 schema 设计要尽量 provider neutral。工具层不应该直接引用某个 SDK 的工具定义类型，否则 MCP 工具、Skill 工具和 Agent 工具都会被 provider 细节污染。

## Reminder 处理

`Reminder` 在两个 provider 中也有差异。

OpenAI 适配将 reminder 作为额外 user message 追加到 messages 末尾。

Anthropic 适配优先把 reminder 追加到最后一条 user message；如果最后一条不是 user，则新建一条 user message。

这种处理保持了同一语义：reminder 是本轮即时上下文，不写入 stable system，也不永久修改用户原始输入。

## 错误归一

`provider.go` 定义了：

```go
var ErrPromptTooLong = errors.New("prompt too long")
```

`wrapPromptTooLong` 会扫描 provider 错误文本，将常见上下文超限错误包装成 `ErrPromptTooLong`。

这使上层不必识别每个 provider 的错误文案。后续如果 compact runtime 要针对上下文超限做补救，也可以基于统一错误类型判断。

## 小结

Provider 适配层的边界应保持窄而稳定。

PseudoClaude 的做法是：内部使用 provider neutral 的 `Request`、`Message`、`ToolCall`、`ToolResult`、`Usage`、`StreamEvent`；外部 provider 的差异只存在于 `openai.go` 和 `anthropic.go`。Runner 不知道 SDK 细节，也不需要知道不同 provider 如何表达 tool use。

这种设计让 Agent 主循环可以专注处理状态机问题：何时请求模型，何时执行工具，何时回灌结果，何时停止。Provider 只负责协议转换。
