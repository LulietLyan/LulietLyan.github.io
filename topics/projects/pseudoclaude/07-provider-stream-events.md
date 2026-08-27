---
title: Provider 抽象：归一不同模型的流式协议
description: How PseudoClaude adapts Anthropic and OpenAI providers into a normalized StreamEvent protocol consumed by the agent runtime.
date: 2026-08-28
order: 7
tags:
  - PseudoClaude
  - LLM
  - Streaming
  - Go
---

PseudoClaude 的 Agent 循环需要模型输出文本、工具调用和 Token 用量，但不应该理解某个厂商 SDK 的事件类型。否则，每接入一种协议，Runner 都要增加一套分支，Conversation 也要保存多种消息结构。

项目把这个边界放在 `internal/llm`：Provider 工厂选择协议实现，各实现负责请求转换和流式组装，最后只向上游发送统一的 `StreamEvent`。这里归一的是 Agent 真正需要的语义，不是强行假设两个接口拥有相同的传输过程。

## Provider 是 Runner 唯一认识的模型接口

内部请求保留消息、工具定义、系统提示词和迭代提醒；输出则被拆成五类事件：

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

`Text` 可以连续出现，`ToolCall` 表示一项已经组装完成的调用，`Usage` 保存统一的计量结果，`Done` 表示正常结束，`Err` 表示流无法继续。Runner 的 `streamCollector` 只消费这套事件，因此后续的 ReAct 循环与具体协议解耦。

创建 Provider 的入口同样集中在一个工厂中：

```go
func New(cfg config.ProviderConfig) (Provider, error) {
    switch cfg.Protocol {
    case "anthropic":
        return newAnthropicProvider(cfg), nil
    case "openai":
        return newOpenAIProvider(cfg), nil
    default:
        return nil, fmt.Errorf("unsupported protocol: %s", cfg.Protocol)
    }
}
```

配置决定协议、模型、API Key 和可选 Base URL。`main.go` 只调用工厂并把结果注入 Runner，不承担 SDK 初始化细节。增加协议时，需要实现 Provider 并在工厂注册，而不需要改动 Agent 的执行循环。

## 同一份请求如何进入两个协议

PseudoClaude 将系统提示词分成 `Stable` 和 `Environment`。前者包含基础指令、Skill 目录和 Memory 索引，在一次运行中较稳定；后者包含工作目录、模型信息和已激活 Skill，会随迭代变化。

OpenAI 适配器将两部分拼成一条 system message，再依次转换历史消息；Reminder 作为新的 user message 追加：

```go
system := strings.TrimSpace(req.System.Stable)
if environment := strings.TrimSpace(req.System.Environment); environment != "" {
    if system != "" {
        system += "\n\n" + environment
    } else {
        system = environment
    }
}
if system != "" {
    out = append(out, openai.SystemMessage(system))
}
// ...转换 user、assistant、tool call 和 tool result...
if reminder := strings.TrimSpace(req.Reminder); reminder != "" {
    out = append(out, openai.UserMessage(reminder))
}
```

Anthropic 适配器则保留两个独立的 system block，并只给稳定部分设置五分钟 ephemeral cache：

```go
func toAnthropicSystem(sys System) []anthropic.TextBlockParam {
    var out []anthropic.TextBlockParam
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
    return out
}
```

Anthropic 的 Reminder 会附加到最后一条 user message；如果末尾不是 user message，才新建一条。两种写法遵循各自 SDK 的消息模型，但进入项目内部之前，它们都来自同一个 `llm.Request`。

工具定义也在这里完成协议转换。项目内部只保存名称、说明和 JSON Schema，Provider 再分别构造 OpenAI function tool 或 Anthropic tool parameter。Agent 不需要维护第二份工具描述。

## OpenAI：先累积碎片，再发布完整工具调用

OpenAI 兼容流可能把工具名和 JSON 参数拆在多个 chunk 中。直接转发单个 delta 会让上游拿到不完整 JSON，因此实现使用 SDK 的 `ChatCompletionAccumulator` 组装状态：

```go
acc := openai.ChatCompletionAccumulator{}
sentTools := make(map[string]bool)
for stream.Next() {
    evt := stream.Current()
    received = true
    acc.AddChunk(evt)

    if usage := openAIUsageFromCompletionUsage(acc.Usage); usage != nil {
        sendStreamEvent(ctx, ch, StreamEvent{Usage: usage})
    }
    if len(evt.Choices) == 0 {
        continue
    }
    if text := evt.Choices[0].Delta.Content; text != "" {
        sendStreamEvent(ctx, ch, StreamEvent{Text: text})
    }
    if toolCall, ok := acc.JustFinishedToolCall(); ok {
        sendOpenAIToolCall(ctx, ch, toolCall.ID, toolCall.Name, toolCall.Arguments)
        sentTools[toolCall.ID] = true
    }
}
```

`sentTools` 防止一个已经发布的调用在最终收尾时重复发送。流结束后，`finalizeOpenAIStream` 还会遍历 accumulator 中尚未发送的 ToolCall，补发最终 Usage，再发送 `Done`。这一步兼容没有明确“工具参数结束”事件、但最终累计消息已经完整的服务端实现。

部分 OpenAI 兼容服务会在已经返回有效 chunk 后，以空 JSON 尾部或 `unexpected EOF` 结束。当前实现仅在确实收到过数据时，将这类错误视为可收尾的兼容情况；其他错误仍通过 `Err` 上报。这个例外不是吞掉所有 EOF，而是对已知兼容行为做窄范围处理。

## Anthropic：文本实时转发，工具在完整消息中提取

Anthropic 流以 content block 为单位。实现一边把事件累积成完整 `anthropic.Message`，一边只将文本 delta 实时转发：

```go
message := anthropic.Message{}
for stream.Next() {
    current := stream.Current()
    _ = message.Accumulate(current)
    switch event := current.AsAny().(type) {
    case anthropic.ContentBlockDeltaEvent:
        switch delta := event.Delta.AsAny().(type) {
        case anthropic.TextDelta:
            sendStreamEvent(ctx, ch, StreamEvent{Text: delta.Text})
        case anthropic.ThinkingDelta:
            continue
        }
    }
}
```

隐藏 thinking delta 不进入 Agent 事件。正常结束后，Provider 从累计消息读取 Usage 和完整的 `ToolUseBlock`：

```go
sendStreamEvent(ctx, ch, StreamEvent{Usage: anthropicUsage(message.Usage)})
for _, block := range message.Content {
    if toolUse, ok := block.AsAny().(anthropic.ToolUseBlock); ok {
        sendStreamEvent(ctx, ch, StreamEvent{ToolCall: &ToolCall{
            ID:        toolUse.ID,
            Name:      toolUse.Name,
            Arguments: json.RawMessage(toolUse.Input),
        }})
    }
}
sendStreamEvent(ctx, ch, StreamEvent{Done: true})
```

因此，两种 Provider 的流式时序并不完全相同：OpenAI 在 accumulator 判断单个调用完成时即可发布，Anthropic 在完整 message 收尾后统一提取工具调用。上层得到的都是完整 ToolCall，这才是归一化真正需要保证的契约。

## Usage 与错误也属于协议边界

统一 Usage 不只包含输入、输出和总 Token，还保留缓存读写：

| 内部字段 | OpenAI 映射 | Anthropic 映射 |
| --- | --- | --- |
| `InputTokens` | prompt tokens | input tokens |
| `OutputTokens` | completion tokens | output tokens |
| `CacheRead` | cached prompt tokens | cache read input tokens |
| `CacheWrite` | 当前无对应值 | cache creation input tokens |
| `TotalTokens` | API total | 输入、输出、缓存创建和缓存读取之和 |

Provider 还将不同服务的上下文超限错误包装为 `ErrPromptTooLong`。Context Compact 因而可以判断“提示词过长”这一内部错误，而不用解析每家服务的原始报错文本。

## 一次流式请求的边界

完整路径可以概括为：

```text
Runner 生成 llm.Request
  -> Provider 工厂选中的协议实现
  -> 内部消息 / 工具定义转换为 SDK 参数
  -> SDK 流事件与碎片累积
  -> Text / ToolCall / Usage / Done / Err
  -> streamCollector 写入 ReAct 循环
```

Provider 层负责“协议语义转换”，不负责决定工具能否执行，也不负责更新会话。工具权限属于 Agent 和 Permission Engine，会话写入属于 Runner；这使模型接入和执行安全可以分别演进。

## 测试关注什么

`internal/llm` 的测试没有只检查工厂返回类型，还覆盖了工具 Schema 转换、System 与 Environment 的组织方式、Reminder 插入位置、Usage 映射、工具参数碎片累积、OpenAI 兼容空尾，以及上下文超限错误归一化。

这组测试保护的是 Provider 契约：无论底层事件长什么样，Runner 都应该收到完整工具调用、可比较的 Usage 和明确的终止事件。

## 小结

PseudoClaude 没有在 Agent 循环中直接兼容两套 SDK，而是用 Provider 工厂统一创建入口，用 `llm.Request` 统一输入，用 `StreamEvent` 统一输出。协议实现内部仍尊重各自的消息和流式时序，只把已经具有稳定语义的结果交给上层。

下一篇继续沿工具生态向外展开，介绍 MCP Server 如何通过 stdio 或 Streamable HTTP 完成连接、工具发现、适配和注册。
