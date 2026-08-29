---
title: Provider 抽象：归一不同模型的流式协议
description: How PseudoClaude normalizes messages, tool calls, streaming, usage, cancellation, and errors across Anthropic and OpenAI providers.
date: 2026-08-30
order: 7
tags:
  - PseudoClaude
  - LLM
  - Streaming
  - Go
---

PseudoClaude 的 Agent 循环需要模型输出文本、工具调用和 Token 用量，但不应该理解任何厂商 SDK 的事件类型。否则，每增加一个模型协议，Runner、Conversation、Context Compact 和 TUI 都会被迫增加一组分支。

项目把这个边界放在 `internal/llm`：Runner 只构造统一请求，Provider 负责把它翻译成厂商请求，再把不同形态的流式响应收敛为统一事件。Provider 不执行工具、不保存会话，也不决定权限；它只负责协议语义转换。

本文所有 Go 代码均截取自已经补充设计注释的项目源码。完整版本可以直接查看：[`provider.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/llm/provider.go)、[`stream.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/llm/stream.go)、[`anthropic.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/llm/anthropic.go) 和 [`openai.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/llm/openai.go)。

## 模块位于哪条调用链上

完整边界可以先压缩成一张图：

```text
TUI 选择 ProviderConfig
  -> llm.New 创建具体 Provider
  -> Runner 构造 llm.Request
  -> Anthropic / OpenAI 适配器转换请求
  -> 厂商 SDK 返回流式碎片
  -> Provider 发布统一 StreamEvent
  -> streamCollector 聚合本轮文本、ToolCall 和 Usage
  -> Runner 执行工具并写入 ToolResult
  -> 下一轮再次构造 llm.Request
```

这条链路里最容易混淆的一点是：模型只能**提出** ToolCall，真正执行工具的是 Runner。Provider 发出 `Done` 时，表示“模型本轮响应流正常结束”，并不表示工具执行结束。

## Provider 是 Runner 唯一认识的模型接口

`provider.go` 定义了项目内部稳定的数据语言：

```go
// Message 是 Provider 之间共享的会话表示。它按 ToolResult、ToolCalls、普通文本的
// 优先级解释；Conversation 负责只构造其中一种有效形态，避免含义冲突。
type Message struct {
	Role       string      // 普通文本的 user/assistant 角色；工具结果在 Provider 中按协议映射。
	Content    string      // 普通文本，或与 assistant 工具调用同轮出现的可选说明。
	ToolCalls  []ToolCall  // 模型在同一轮提出的一组调用，必须先于对应结果进入历史。
	ToolResult *ToolResult // 本地工具执行结果，通过 CallID 关联先前的 ToolCall。
}

// StreamEvent 是所有 Provider 对上游发布的统一事件。成功流必须先发送完 Text、
// ToolCall 和 Usage，再发送 Done；失败流发送 Err 后关闭，取消时可以直接关闭。
type StreamEvent struct {
	Text     string    // 可立即展示的文本增量。
	ToolCall *ToolCall // 已完成协议层组装；Arguments 的 JSON 语义仍由工具层校验。
	Usage    *Usage    // 截至当前事件可用的 Token 统计；后到值覆盖先到值。
	Done     bool      // Provider 已正常完成本轮模型响应，不表示工具已经执行。
	Err      error     // 流无法继续的终止错误；与 Done 互斥。
}

// Usage 归一两家 API 的 Token 统计，并单独保留提示词缓存的读写量。
type Usage struct {
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
	CacheWrite   int64
	CacheRead    int64
}

// ToolCall 是模型输出的执行请求。Arguments 保持原始 JSON，具体结构由工具层校验。
type ToolCall struct {
	ID        string
	Name      string
	Arguments json.RawMessage
}

// ToolResult 是本地工具返回给模型的 observation。CallID 必须匹配原 ToolCall.ID。
type ToolResult struct {
	CallID  string
	Name    string
	Content string
	IsError bool
}

// System 将稳定指令与动态运行环境分开，使支持块级缓存的 Provider 只缓存稳定部分。
type System struct {
	Stable      string // 基础行为、固定能力说明等可跨迭代复用的内容。
	Environment string // CWD、模型信息、已加载 Skill 等可能逐轮变化的内容。
}

// Request 是 Runner 与 Provider 的完整边界：会话和工具描述模型可见内容，System 与
// Reminder 分别承载长期指令和只影响当前轮次的临时约束。
type Request struct {
	Messages []Message
	Tools    []tools.Definition
	System   System
	Reminder string
}

// Provider 隔离厂商 SDK。Runner 只消费统一请求和只读事件流，不参与协议转换。
type Provider interface {
	Name() string
	Model() string
	Stream(ctx context.Context, req Request) <-chan StreamEvent
}

// New 根据配置选择协议适配器。新增协议需要实现 Provider，并在这里显式注册。
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

`Provider` 同时体现了 Adapter 与 Strategy 两种设计：具体实现适配不同 SDK，Runner 则在运行时选择其中一种策略。新增协议时需要实现 Provider、加入工厂分支和配置校验，但不应该修改 Agent 的执行循环。

### Message 实际上是受约定约束的联合类型

Go 结构体允许四个字段同时存在，但转换器按照固定优先级解释它：

| 优先级 | 判定 | 消息语义 |
| --- | --- | --- |
| 1 | `ToolResult != nil` | 工具执行结果 |
| 2 | `len(ToolCalls) > 0` | assistant 工具调用消息，可附带 Content |
| 3 | 其他 | 普通 user 或 assistant 文本 |

因此 `ToolResult` 与普通 `Content` 同时存在时，Content 会被工具结果分支覆盖。当前类型系统不能排除这种非法状态，正确性依赖 Conversation 只通过 `AddUser`、`AddAssistant`、`AddAssistantToolCalls` 和 `AddToolResult` 构造合法消息。

### ToolCall.ID 是调用闭环的主键

一次工具交互在会话中的顺序是：

```text
user:      请读取 README.md
assistant: tool_call(call_1, read_file, {"path":"README.md"})
user/tool: tool_result(call_1, {"ok":true,"content":"..."})
assistant: README 的主要内容是……
```

`ToolCall.ID` 必须等于 `ToolResult.CallID`。没有这个关联，并行调用返回多个结果时，模型无法判断每个 observation 属于哪个请求。`Arguments` 使用 `json.RawMessage`，则让 LLM 层只运输原始参数，字段校验和权限判断继续留在工具层。

## 事件流同时是协议，也是并发边界

`Stream` 返回 `<-chan StreamEvent`，把调用方限制为只读。创建、发送和关闭通道的所有权都属于 Provider；网络请求放入 goroutine 后，Runner 可以立即开始消费增量内容。

`stream.go` 的函数很短，却保护了整个取消链路：

```go
// sendStreamEvent 在无缓冲事件流上施加背压，同时允许取消打断阻塞发送。
// 如果下游已经停止消费，ctx.Done 可避免 Provider goroutine 永久泄漏。
func sendStreamEvent(ctx context.Context, ch chan<- StreamEvent, event StreamEvent) bool {
	select {
	case <-ctx.Done():
		return false
	case ch <- event:
		return true
	}
}
```

无缓冲通道产生背压：只有 collector 接收了当前事件，Provider 才能继续发送下一个事件。额外队列空间保持 `O(1)`，代价是下游展示或转发变慢时，上游也会同步变慢。

不能把上面的 `select` 简化成 `ch <- event`。用户取消后，collector 可能已经退出；如果 Provider 仍阻塞在发送操作上，它永远执行不到 `defer close(ch)`，最终泄漏 goroutine。

取消因此需要覆盖多个不同阻塞点：

- 同一个 Context 传给厂商 SDK，用来中止 HTTP 流。
- Provider 循环检查 `ctx.Done()`，避免继续处理新 chunk。
- `sendStreamEvent` 检查 `ctx.Done()`，打断阻塞发送。
- collector 也检查 `ctx.Done()`，让消费者及时退出。

成功、失败和取消的事件序列不同：

```text
正常文本：Text -> Text -> Usage -> Done -> close
工具调用：Text? -> ToolCall -> Usage/Done -> close
服务失败：Text? -> Err -> close
用户取消：ctx.Done -> close
```

`Done` 是协议层的正常完成，`close` 是并发层的“不再有事件”。当前 collector 对通道直接关闭也按正常结束处理，因此 Provider 如果意外关闭而没有发送 `Done` 或 `Err`，上层可能把不完整响应当成正常结果。这是接口目前依靠实现约定维持的边界。

## 同一份请求如何进入两种消息协议

`System` 拆成 `Stable` 与 `Environment`，并不是为了让两段文字具有不同权限，而是为了让 Provider 根据自身协议选择缓存与组织方式：

| 内部数据 | Anthropic | OpenAI Chat Completions |
| --- | --- | --- |
| `Stable` | 独立 system block，设置 5 分钟 ephemeral cache | 与 Environment 合并 |
| `Environment` | 独立、无缓存 system block | 与 Stable 合成一条 system message |
| `Reminder` | 追加到末尾 user block，必要时新建 user message | 总是追加一条 user message |
| `ToolCall` | assistant `tool_use` block | assistant `tool_calls` |
| `ToolResult` | user `tool_result` block，保留 `IsError` | role=tool message，通过 Content 表达错误 |

Reminder 是逐轮更新的临时约束。把它放在对话末尾，既让它更靠近当前生成位置，也避免把临时状态混进稳定系统提示词。

## Anthropic：实时发布文本，收尾时提取工具

Anthropic 流以 content block 为核心。适配器一边用 SDK 累积完整 `Message`，一边只把可见文本实时发布；thinking delta 被明确隐藏，工具调用则等完整消息结束后统一提取。

下面是带源码注释的完整核心路径：

```go
// Stream 将内部 Request 翻译为 Anthropic Messages 请求，并把 SDK 事件归一为 StreamEvent。
// Provider 拥有返回通道的发送和关闭权；网络读取在 goroutine 中进行，调用方可立即消费。
func (p anthropicProvider) Stream(ctx context.Context, req Request) <-chan StreamEvent {
	ch := make(chan StreamEvent)
	go func() {
		defer close(ch)

		// 步骤 1：先完成纯数据转换，再发起请求，避免协议类型泄漏到 Runner。
		anthropicTools := toAnthropicTools(req.Tools)
		msgs := appendAnthropicReminder(toAnthropicMessages(req.Messages), req.Reminder)
		params := anthropic.MessageNewParams{
			Model:     anthropic.Model(p.cfg.Model),
			MaxTokens: anthropicMaxTokens,
			System:    toAnthropicSystem(req.System),
			Messages:  msgs,
			Tools:     anthropicTools,
		}
		if p.cfg.Thinking {
			// Thinking 参与模型推理，但其 delta 不会作为可见文本转发给上游。
			params.Thinking = anthropic.ThinkingConfigParamOfEnabled(anthropicThinkingBudgetTokens)
		}

		// 步骤 2：SDK 接收同一个 Context，使取消能够中止底层 HTTP 流。
		stream := p.client.Messages.NewStreaming(ctx, params)
		message := anthropic.Message{}
		for stream.Next() {
			// SDK 读取与通道发送是两个阻塞点；循环层检查保证取消后不再处理新事件。
			select {
			case <-ctx.Done():
				return
			default:
			}

			current := stream.Current()
			// Accumulate 同时拼接文本、工具参数和 Usage，供流结束后的完整语义提取。
			// 当前实现保持 best-effort：累积错误不会单独改变对上游的事件协议。
			_ = message.Accumulate(current)
			switch event := current.AsAny().(type) {
			case anthropic.ContentBlockDeltaEvent:
				switch delta := event.Delta.AsAny().(type) {
				case anthropic.TextDelta:
					// 文本可以逐块展示，不需要等待完整 Message。
					sendStreamEvent(ctx, ch, StreamEvent{Text: delta.Text})
				case anthropic.ThinkingDelta:
					// 隐藏内部思考，只保留最终可见文本和工具调用。
					continue
				}
			}
		}
		if err := stream.Err(); err != nil {
			// 错误流不发送 Done；上游通过 Err 区分失败与正常完成。
			sendStreamEvent(ctx, ch, StreamEvent{Err: wrapPromptTooLong(err)})
			return
		}
		// 步骤 3：先发布计量和完整工具调用，最后用 Done 封闭本轮协议。
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
	}()
	return ch
}
```

这段逻辑分成三个阶段：请求转换、流式累积、正常收尾。工具参数可能以多个 `InputJSONDelta` 到达，项目不自行拼字符串，而是让官方 SDK 的 `Message.Accumulate` 恢复完整 `ToolUseBlock`。当前代码忽略了 `Accumulate` 返回的错误，属于 best-effort 处理：如果流块顺序损坏，Provider 不会单独生成错误事件。

### 稳定提示词为什么单独成块

```go
// toAnthropicSystem 保留 Stable 与 Environment 的块边界，只给稳定块设置五分钟缓存。
// 动态环境变化时不会使稳定提示词块一起失去缓存复用机会。
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

动态环境可能随 CWD、模型信息或已加载 Skill 改变。如果把它与 Stable 合成同一个缓存块，每次迭代的微小变化都会破坏整块缓存复用。分块的目的主要是提高缓存命中率，不是改变系统指令的语义优先级。

## OpenAI：先累积碎片，再发布完整调用

OpenAI Chat Completions 可能把一个工具调用拆成多个 chunk：

```text
chunk 1: ID="call_1", Name="read_file", Arguments="{\"path\":"
chunk 2: Arguments="\"README.md\"}"
完成值:  {"path":"README.md"}
```

第一个 chunk 的 Arguments 不是完整 JSON，不能直接交给 Runner。适配器使用 SDK 的 `ChatCompletionAccumulator` 按调用索引拼接碎片，并用 `JustFinishedToolCall` 判断一个调用何时具有完整语义。

```go
// Stream 将内部 Request 翻译为 OpenAI Chat Completions 请求，并把碎片化响应归一为
// StreamEvent。Provider 拥有返回通道的发送和关闭权，调用方只负责消费。
func (p openAIProvider) Stream(ctx context.Context, req Request) <-chan StreamEvent {
	ch := make(chan StreamEvent)
	go func() {
		defer close(ch)

		// 步骤 1：请求显式包含 Usage，使流末尾能够更新统一 Token 统计。
		stream := p.client.Chat.Completions.NewStreaming(ctx, openai.ChatCompletionNewParams{
			Model:         openai.ChatModel(p.cfg.Model),
			Messages:      toOpenAIMessages(req),
			Tools:         toOpenAITools(req.Tools),
			StreamOptions: openai.ChatCompletionStreamOptionsParam{IncludeUsage: openai.Bool(true)},
		})
		// 工具名称和 Arguments 可能跨多个 chunk，Accumulator 负责按索引拼成完整调用。
		acc := openai.ChatCompletionAccumulator{}
		// received 只允许在至少收到一个有效 chunk 后容忍兼容服务的空 JSON 尾部。
		received := false
		// 工具调用可能在循环中及时发布，也可能在收尾阶段补发；ID 集合负责去重。
		sentTools := make(map[string]bool)
		for stream.Next() {
			// SDK 读取与通道发送是两个阻塞点；循环层检查保证取消后不再处理新事件。
			select {
			case <-ctx.Done():
				return
			default:
			}

			evt := stream.Current()
			received = true
			// 当前实现保持 best-effort：累积失败不会单独改变对上游的事件协议。
			// 最终收尾仍只读取 Accumulator 成功保存下来的状态。
			acc.AddChunk(evt)
			// Usage 常出现在没有 Choices 的尾部 chunk，因此必须先于 Choices 判断处理。
			// finalize 会再次发布最终值；Collector 以最后一次 Usage 为准。
			if usage := openAIUsageFromCompletionUsage(acc.Usage); usage != nil {
				sendStreamEvent(ctx, ch, StreamEvent{Usage: usage})
			}
			if len(evt.Choices) == 0 {
				continue
			}
			if text := evt.Choices[0].Delta.Content; text != "" {
				// 文本 delta 已可直接展示；完整文本仍由 Accumulator 和上游各自聚合。
				sendStreamEvent(ctx, ch, StreamEvent{Text: text})
			}
			if toolCall, ok := acc.JustFinishedToolCall(); ok {
				// 只有 Arguments 已被 SDK 判定完整后，才向 Runner 发布 ToolCall。
				sendOpenAIToolCall(ctx, ch, toolCall.ID, toolCall.Name, toolCall.Arguments)
				sentTools[toolCall.ID] = true
			}
		}
		if err := stream.Err(); err != nil {
			if received && isOpenAICompatibleEmptyJSONTail(err) {
				// 部分兼容服务会在有效数据后留下空 JSON 尾；保留已累积结果并正常收尾。
				finalizeOpenAIStream(ctx, ch, acc, sentTools)
				return
			}
			// 其他错误不发送 Done，由上游按失败流处理。
			sendStreamEvent(ctx, ch, StreamEvent{Err: wrapPromptTooLong(err)})
			return
		}
		finalizeOpenAIStream(ctx, ch, acc, sentTools)
	}()
	return ch
}

// finalizeOpenAIStream 补发循环中未完成判定的工具调用，再发送最终 Usage 和 Done。
// 这条兜底路径也覆盖部分并行调用和兼容服务缺少明确结束 chunk 的情况。
func finalizeOpenAIStream(ctx context.Context, ch chan<- StreamEvent, acc openai.ChatCompletionAccumulator, sentTools map[string]bool) {
	if len(acc.Choices) > 0 {
		for _, call := range acc.Choices[0].Message.ToolCalls {
			// 空 ID 无法与 ToolResult 关联；已发送 ID 则跳过，避免跨即时与收尾路径重复。
			if call.ID == "" || sentTools[call.ID] {
				continue
			}
			sendOpenAIToolCall(ctx, ch, call.ID, call.Function.Name, call.Function.Arguments)
		}
	}
	if usage := openAIUsageFromCompletionUsage(acc.Usage); usage != nil {
		sendStreamEvent(ctx, ch, StreamEvent{Usage: usage})
	}
	sendStreamEvent(ctx, ch, StreamEvent{Done: true})
}
```

这里有“及时发布 + 最终兜底”两条路径。`JustFinishedToolCall` 判断调用完成时立即发布，并把 ID 放入 `sentTools`；流结束后再遍历 accumulator 的完整消息，补发尚未发送的调用。SDK 明确指出 `JustFinishedToolCall` 不能单独可靠覆盖并行工具调用，最终遍历因此是维持完整 ToolCall 契约的必要兜底。

### 为什么 Usage 要先于 Choices 判断

开启 `IncludeUsage` 后，最终 Usage chunk 往往没有 `Choices`。如果代码先执行 `if len(evt.Choices) == 0 { continue }`，Token 统计会被直接跳过。

当前循环会在 Usage chunk 到达时发布一次统计，`finalizeOpenAIStream` 又发布最终统计。collector 使用后到值覆盖先到值，所以最终聚合结果正确，但 TUI 可能收到两次相同 Usage 更新。这不是语义错误，却是可以进一步收紧的重复事件。

### 为什么要容忍空 JSON 尾部

部分 OpenAI 兼容服务已经发送有效 chunk，却用空 JSON 或不完整 JSON 结束连接。适配器只在 `received == true` 时容忍 `EOF`、`unexpected EOF` 和 `unexpected end of JSON input`，然后使用已经累积的状态正常收尾。

这个策略提高了兼容性，但也有代价：真正被截断的响应可能被视为成功。因此它必须同时依赖“已经收到数据”和窄范围错误匹配，不能推广成吞掉所有流错误。

## Tool Definition 的转换边界

项目内部工具只暴露名称、说明和 JSON Schema。OpenAI 可以把整个 Schema 直接放进 function parameters；Anthropic SDK 使用强类型 `ToolInputSchemaParam`，所以适配器单独提取 `properties` 和 `required`，把其他 Schema 约束放入 `ExtraFields`。

`stringSlice` 同时支持 `[]string` 与 `[]any`，是因为 Definition 既可能由 Go 代码直接构造，也可能来自 JSON/YAML 解码。遇到非字符串项时它整体拒绝转换，避免生成只有一部分生效的 required 列表。

这部分转换仍然只处理“给模型看的契约”。模型返回的 Arguments 是否为合法 JSON、字段是否符合工具业务规则，以及调用是否获得权限，都属于后续工具与 Permission 层。

## Usage 与错误也必须归一

两家 API 的计量字段并不相同：

| 内部字段 | OpenAI 映射 | Anthropic 映射 |
| --- | --- | --- |
| `InputTokens` | prompt tokens | input tokens |
| `OutputTokens` | completion tokens | output tokens |
| `CacheRead` | cached prompt tokens | cache read input tokens |
| `CacheWrite` | 当前无对应值 | cache creation input tokens |
| `TotalTokens` | API total | 输入、输出、缓存创建和缓存读取之和 |

上下文超限同样要从厂商错误文本转成内部语义：

```go
// ErrPromptTooLong 将不同 Provider 的上下文超限错误收敛为一个可判定的内部错误。
// 上层压缩逻辑只依赖这个哨兵，不需要理解各家 API 的错误文本。
var ErrPromptTooLong = errors.New("prompt too long")

// wrapPromptTooLong 保留原始错误信息，同时为常见的上下文超限文本挂上统一哨兵。
// 未命中的错误原样返回，避免把鉴权、限流或网络故障误判为可通过压缩恢复的问题。
func wrapPromptTooLong(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	patterns := []string{
		"prompt is too long",
		"prompt too long",
		"context length",
		"context_length",
		"maximum context",
		"max context",
		"too many tokens",
		"exceeds the context",
		"exceeded context",
	}
	for _, pattern := range patterns {
		if strings.Contains(msg, pattern) {
			// 使用 %w 维持 errors.Is(err, ErrPromptTooLong) 的稳定判断方式。
			return fmt.Errorf("%w: %v", ErrPromptTooLong, err)
		}
	}
	return err
}
```

Context Compact 只需要调用 `errors.Is(err, llm.ErrPromptTooLong)`，不必复制两家服务的错误字符串。`%w` 保留稳定判定，`%v` 则把厂商原始信息留在最终错误文本中。它仍然是启发式匹配：如果服务改变错误文案，需要同步补充测试与模式。

## 测试保护了什么，又没有保护什么

当前 `internal/llm` 的单元测试覆盖以下协议转换：工具 Definition、ToolCall/ToolResult 历史、Stable/Environment/Reminder、Usage 与缓存 Token、OpenAI 工具参数碎片、兼容空 JSON 尾，以及上下文超限错误归一化。

运行 `go test ./internal/llm -cover` 时，当前语句覆盖率为 `47.3%`。主要盲区不是纯转换函数，而是需要模拟真实 SDK 流的路径：

| 风险点 | 当前状态 |
| --- | --- |
| Provider 网络流成功与失败时序 | 缺少端到端流测试 |
| 取消发生在 HTTP 读取或 channel 发送期间 | 缺少直接并发测试 |
| Anthropic `Message.Accumulate` 返回错误 | 当前忽略 |
| OpenAI `Accumulator.AddChunk` 返回 false | 当前忽略 |
| OpenAI 最终 Usage 重复发布 | collector 可容忍，但未直接约束 |
| channel 无 `Done` 直接关闭 | collector 会按正常结束处理 |
| `Message` 同时包含多个互斥字段 | 没有统一 Validate 入口 |

这些并不否定 Provider 抽象，而是说明统一接口除了类型签名，还依赖一组事件顺序和消息形态不变量。后续增强测试时，最有价值的是构造可注入的流客户端，直接验证成功、错误、取消、并行工具调用和残缺尾部五条路径。

## 新增第三个 Provider 时的检查顺序

以接入 Gemini 为例，最稳妥的顺序是：

1. 实现 `Name`、`Model` 和 `Stream`，维持现有事件终止语义。
2. 把 System、Message、Tool Definition 转成 Gemini 请求格式。
3. 把文本、完整 ToolCall、Usage 和错误转换回内部事件。
4. 在 `llm.New` 与配置校验中注册协议。
5. 补充默认上下文窗口、依赖和配置文档。
6. 用同一组协议测试验证 ToolCall/ToolResult 闭环、取消与错误归一化。

只要现有 `Request` 和 `StreamEvent` 足以表达 Gemini 的必要语义，就不应该修改统一结构。只有厂商能力无法无损落入现有契约时，才需要扩展内部协议，并同时检查 Runner、Conversation、Compact 和 TUI 的所有消费者。

## 小结

`internal/llm` 的价值不只是把两个 SDK 包在同一个接口后面。它定义了 PseudoClaude 内部稳定的模型协议：Message 约束会话形态，ToolCall/ToolResult 建立工具闭环，StreamEvent 规定增量与终止语义，Context 贯穿取消链路，Usage 与错误则为展示和上下文压缩提供统一依据。

Anthropic 与 OpenAI 在 system block、工具参数累积、调用完成判定和流尾行为上都不同。Provider 没有抹平这些传输差异，而是在每种实现内部尊重它们，只把已经具备稳定语义的结果交给 Runner。这才是“归一协议”真正需要保证的边界。

下一篇继续沿工具生态向外展开，介绍 MCP Server 如何通过 stdio 或 Streamable HTTP 完成连接、工具发现、适配和注册。
