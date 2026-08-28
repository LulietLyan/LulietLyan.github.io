---
title: Tool 系统：从模型契约到受控执行
description: How PseudoClaude unifies tool definitions, registration, visibility filtering, execution routing, and structured error results.
date: 2026-08-21
order: 4
tags:
  - PseudoClaude
  - Tool Calling
  - Go
  - AI Agent
---

模型不能直接调用 Go 函数。它只能根据请求中的工具描述生成一个名称和一段 JSON 参数。PseudoClaude 的 Tool 系统负责把这段不可信的模型输出转换为本地执行，并把所有结果重新收敛为模型可理解的数据。

这篇文章只讨论能力契约和执行入口。某次调用是否应该得到用户授权属于 Permission 层，将在第六篇展开。

## 一个 Tool 的四个组成部分

`internal/tools/tool.go` 定义了模型契约、运行环境、调用和结果：

```go
// Definition 是发送给模型的工具契约，不包含工具的 Go 实现。
type Definition struct {
    Name        string         // 模型在 ToolCall 中返回的稳定路由名
    Description string         // 告诉模型何时以及为什么使用该工具
    InputSchema map[string]any // 约束 ToolCall.Arguments 的 JSON Schema
    Safety      Safety         // 权限和运行模式使用的风险分类
    System      bool           // 控制面工具，不受普通工具名称过滤和权限规则限制
    Timeout     time.Duration  // 可选的单工具超时，覆盖 Env 默认值
}

// Call 是模型输出经过 LLM 适配层转换后的内部工具调用。
type Call struct {
    ID        string
    Name      string
    Arguments json.RawMessage
}

// Result 是所有工具统一返回给 Agent 和模型的结构化结果。
type Result struct {
    OK        bool           `json:"ok"`
    Tool      string         `json:"tool"`
    Content   string         `json:"content,omitempty"`
    ErrorType string         `json:"error_type,omitempty"`
    Error     string         `json:"error,omitempty"`
    Metadata  map[string]any `json:"metadata,omitempty"`
}

// Tool 把“给模型看的定义”和“运行期执行”绑定在同一个实现类型上。
// 实现可以是零字段值，也可以携带目录、Catalog、回调等依赖。
type Tool interface {
    Definition() Definition
    Execute(ctx context.Context, input json.RawMessage, env Env) Result
}
```

`Definition` 是发送给模型的 Tool 定义，`Execute` 是只存在于本地进程的实现。两者放在同一个接口上，可以保证注册表中的每一个模型定义都有对应执行对象，但模型不会得到 Go 函数指针或本地环境。

`Safety` 只提供 `read_only` 与 `side_effect` 两类粗粒度标签，用于工具过滤、执行策略和权限分类。它不是参数级权限规则：同一个 `run_command` 的 `git status` 与危险删除命令都属于 Side Effect，具体目标仍要在执行前解析。

`Env` 则保存本次执行才确定的 CWD、超时和输出上限。基础文件工具因此可以是无状态值，同一个 Tool 实例能在主 Agent、SubAgent 或 Worktree 中使用不同环境。

这四类数据不要混为一层：

| 数据 | 谁产生 | 谁消费 | 是否可信 |
| --- | --- | --- | --- |
| `Definition` | Tool 实现 | Provider 和模型 | 本地声明 |
| `llm.ToolCall` / `tools.Call` | 模型，经 Provider 适配 | Agent 与 Registry | 不可信输入 |
| `Env` | Runner | Registry 与具体 Tool | 本地运行配置 |
| `Result` | Registry 或具体 Tool | Agent、Conversation、下一轮模型 | 结构化 Observation |

模型只看到 Definition，并根据它生成 ToolCall。`Execute` 不会因为模型“看见了 Definition”就自动发生；调用还必须穿过 Agent 层的 Hook、Permission、Safety 和名称白名单。

## Registry 是唯一运行目录

`Registry` 用 Definition Name 索引 Tool：

```go
// Register 以工具自己声明的 Definition.Name 为键，并拒绝静默覆盖已有实现。
func (r *Registry) Register(tool Tool) error {
	if tool == nil {
		return errors.New("tool is nil")
	}
	def := tool.Definition()
	name := strings.TrimSpace(def.Name)
	if name == "" {
		return errors.New("tool name is required")
	}
	if r.tools == nil {
		r.tools = make(map[string]Tool)
	}
	if _, exists := r.tools[name]; exists {
		return fmt.Errorf("tool %q already registered", name)
	}
	r.tools[name] = tool
	return nil
}

// RegisterOrReplace 用于 Skill 重载和兼容工具等明确允许热替换的场景。
func (r *Registry) RegisterOrReplace(tool Tool) error {
	if tool == nil {
		return errors.New("tool is nil")
	}
	def := tool.Definition()
	name := strings.TrimSpace(def.Name)
	if name == "" {
		return errors.New("tool name is required")
	}
	if r.tools == nil {
		r.tools = make(map[string]Tool)
	}
	r.tools[name] = tool
	return nil
}
```

普通注册拒绝 nil、空名称和重复名称，避免一个后加载模块静默覆盖原有能力。只有 Skill 重载和 Team 兼容工具等明确允许替换的场景才调用 `RegisterOrReplace`。

入口先注册六个不需要外部依赖的基础工具：

```go
// DefaultRegistry 组装所有无需外部依赖的基础工具。Skill、MCP、Agent 和团队工具
// 要等各自子系统初始化后，再由 main 动态注册到同一个 Registry。
func DefaultRegistry() (*Registry, error) {
    return NewRegistry(
        NewReadFileTool(),
        NewWriteFileTool(),
        NewEditFileTool(),
        NewRunCommandTool(),
        NewFindFilesTool(),
        NewSearchCodeTool(),
    )
}
```

MCP、Skill、Agent 和 Team 工具在各自管理器准备完成后再进入同一个 Registry。Runner 因此不需要为不同来源维护多套分支。

## 给模型的列表不是 Registry 全量

Registry 保存的是当前进程全部已注册能力，但某个运行不一定能使用全部能力。`DefinitionsFiltered` 根据名称限制普通工具，同时保留 System 控制面工具：

```go
// DefinitionsFiltered 限制普通工具的模型可见范围，但始终保留 System 控制面工具。
func (r *Registry) DefinitionsFiltered(allowed []string) []Definition {
	// nil Registry 没有可供模型使用的工具定义。
	if r == nil {
		return nil
	}
	// 空白名单表示不限制工具范围，直接返回全部已注册定义。
	if len(allowed) == 0 {
		return r.Definitions()
	}

	// 将名称列表规范化为集合：忽略空白项，同时消除重复名称。
	allowedSet := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		name = strings.TrimSpace(name)
		if name != "" {
			allowedSet[name] = true
		}
	}

	// Definitions 已按名称排序；过滤时保持这个稳定顺序，避免工具提示词随机变化。
	defs := r.Definitions()
	out := make([]Definition, 0, len(defs))
	for _, def := range defs {
		// 普通工具必须出现在白名单中；System 工具属于控制面，始终向模型暴露。
		if allowedSet[def.Name] || def.System {
			out = append(out, def)
		}
	}
	return out
}
```

随后 Runner 还可以按 Safety 过滤，例如 Plan Mode 只发送 Read Only 定义。SubAgent 则会根据角色声明、后台运行方式和团队身份计算名称集合。

过滤 Definition 是第一道能力边界：模型通常不会请求一个根本没有看见的工具。但它不能成为唯一防线，因为模型响应、历史消息或 Provider 都可能产生未公开的工具名。执行阶段必须再次验证。

## Registry.Execute 的统一保护

所有真实工具最终都经过 `Registry.Execute`：

```go
// Execute 完成统一的运行期保护：名称路由、JSON 合法性、Env 默认值、超时和 panic
// 隔离；通过后才调用具体 Tool.Execute。
func (r *Registry) Execute(ctx context.Context, call Call, env Env) Result {
	// 步骤 1：按 ToolCall 名称找到具体实现；未知名称不进入执行阶段。
	tool, ok := r.Get(call.Name)
	if !ok {
		return Failure(call.Name, "unknown_tool", fmt.Sprintf("unknown tool %q", call.Name), map[string]any{"call_id": call.ID})
	}

	// 步骤 2：先检查参数是否为合法 JSON；字段和业务语义由具体工具继续校验。
	if !json.Valid(call.Arguments) {
		return Failure(call.Name, "invalid_arguments", "arguments must be valid JSON", map[string]any{"call_id": call.ID})
	}

	// 步骤 3：补齐工作目录、超时和输出限制等环境默认值，并容忍调用方传入 nil Context。
	env = normalizeEnv(env)
	if ctx == nil {
		ctx = context.Background()
	}

	// 步骤 4：默认使用 Env 超时；工具 Definition 可声明更适合自身的固定超时。
	timeout := env.Timeout
	if def := tool.Definition(); def.Timeout > 0 {
		timeout = def.Timeout
	}
	// 派生 Context 同时响应父级取消和本次工具超时；cancel 用于及时释放计时器资源。
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// 步骤 5：在独立 goroutine 中执行工具，使当前函数能够同时等待执行结果和超时信号。
	// 通道容量为 1，保证 Execute 已因超时返回后，工具的迟到结果仍可完成发送。
	done := make(chan Result, 1)
	go func() {
		// 将工具实现的 panic 转成统一失败结果，避免 panic 穿透 Registry 执行边界。
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- Failure(call.Name, "internal_error", fmt.Sprintf("tool panicked: %v", recovered), map[string]any{"call_id": call.ID})
			}
		}()
		done <- tool.Execute(execCtx, call.Arguments, env)
	}()

	// 步骤 6：超时或父 Context 取消时立即返回；否则规范化工具给出的结果。
	select {
	case <-execCtx.Done():
		// Registry 当前把两种 Context 终止都映射为 timeout，并保留原始 Context 错误文本。
		return Failure(call.Name, "timeout", execCtx.Err().Error(), map[string]any{"call_id": call.ID})
	case result := <-done:
		// 工具可以省略可推导字段，Registry 在统一出口补齐工具名和调用 ID。
		if result.Tool == "" {
			result.Tool = call.Name
		}
		if result.Metadata == nil {
			result.Metadata = map[string]any{}
		}
		result.Metadata["call_id"] = call.ID
		return result
	}
}
```

这条入口依次处理：

1. 名称路由，未知名称返回 `unknown_tool`。
2. JSON 基本合法性，非法参数不会进入 Tool 实现。
3. Env 默认值，包括 CWD、超时、读取和输出上限。
4. Tool 自定义超时。
5. Context 超时与取消。
6. panic 隔离，将实现异常转换为 `internal_error`。
7. 为结果补上 Tool Name、Metadata 和 Call ID。

具体 Tool 仍要解析自己的字段并验证业务条件。例如 `read_file` 要求 path，`edit_file` 要求 old string 唯一匹配。Registry 只提供跨工具一致的保护，不假装理解每个 schema 的语义。

## Agent 层如何调用 Registry

Runner 拿到 ToolCall 后，不会直接调用 `Registry.Execute`。`internal/agent/tools.go` 在外面组织 Hook、权限和事件：

```go
// executeOneTool 先给 PreToolUse Hook 拦截机会，再进入权限决策和真实执行；
// 无论工具成功、失败还是被拒绝，最后都会派发 PostToolUse。
func executeOneTool(ctx context.Context, registry *tools.Registry, env tools.Env, iteration int, call llm.ToolCall, events chan<- Event, opts toolExecutionOptions, engine *permission.Engine, mode permission.Mode, hooks toolHookContext) ToolResult {
	// 从发出 Start 到构造最终 ToolResult 的时间包含 Hook、审批等待和真实执行。
	started := time.Now()
	sendEvent(ctx, events, Event{Type: EventToolCallStart, Iteration: iteration, ToolCall: &call})

	// PreToolUse 可以直接返回 hook_blocked；空 Tool 字段是“未拦截、继续执行”的哨兵。
	result := dispatchPreToolHook(ctx, call, hooks)
	if result.Tool == "" {
		result = permissionCheckedTool(ctx, registry, env, iteration, call, events, opts, engine, mode, hooks)
	}

	// PostToolUse 对成功、业务失败、权限拒绝和 Hook 拦截统一可见。
	dispatchPostToolHook(ctx, call, result, hooks)
	out := ToolResult{Call: call, Result: result, Elapsed: time.Since(started)}
	// Result 携带结构化结果；Done 则明确标记该调用生命周期结束。
	sendEvent(ctx, events, Event{Type: EventToolResult, Iteration: iteration, ToolResult: &out})
	sendEvent(ctx, events, Event{Type: EventToolCallDone, Iteration: iteration, ToolCall: &call, ToolResult: &out})
	return out
}
```

主路径可以写成：

```text
llm.ToolCall
  -> PreToolUse Hook
  -> Permission Check / Approval
  -> Safety 与名称执行校验
  -> Registry.Execute
  -> tools.Result
  -> PostToolUse Hook
  -> agent.EventToolResult
  -> Conversation ToolResult
```

即使 Hook 阻止、权限拒绝或 Registry 返回错误，Agent 层仍然生成统一的 ToolResult Event，Runner 也会把结果写回 Conversation。模型下一轮看到的是结构化失败，而不是一条脱离调用上下文的 Go error。

这条链实际包含五个不同职责的入口：

| 入口 | 粒度 | 主要职责 |
| --- | --- | --- |
| `executeToolCalls` | 一轮多个调用 | 拆批、并发、取消、结果保序 |
| `executeOneTool` | 单个调用 | 生命周期事件、Hook、耗时 |
| `permissionCheckedTool` | 单个调用 | allow、deny、ask 与审批 |
| `executeAllowedTool` | 单个调用 | Safety 和名称白名单复检 |
| `Registry.Execute` | 单个调用 | 路由、JSON、Env、超时、panic 隔离 |

所以 `executeToolCalls` 与 `Registry.Execute` 不是重复实现：前者是 Agent 调度器，后者是 Tool 运行时边界。被 Hook 拦截、权限拒绝或白名单禁止的调用根本不会到达 Registry。

## 多个调用的顺序边界

模型一轮可以返回多个 ToolCall。PseudoClaude 会把确定为 Read Only 且无需交互审批的连续调用组成并发批次；未知工具、Side Effect 工具、当前模式不允许的工具以及可能询问权限的调用保持串行。

`splitToolBatches` 的关键是只并发“已知且确认为 ReadOnly”的连续区间：

```go
// splitToolBatches 保留模型调用顺序，把连续且无需审批的已知只读工具合并为并发批次。
// 可能弹出审批、具有副作用、被当前模式禁用或名称未知的调用都单独形成串行批次。
func splitToolBatches(registry *tools.Registry, calls []llm.ToolCall, opts toolExecutionOptions, engine *permission.Engine, mode permission.Mode) []toolBatch {
    var batches []toolBatch
    // readonly 暂存当前连续区间中可以安全并发的调用。
    var readonly []indexedToolCall
    flushReadonly := func() {
        if len(readonly) == 0 {
            return
        }
        batches = append(batches, toolBatch{concurrent: true, items: readonly})
        readonly = nil
    }
    for i, call := range calls {
        safety, known := registry.Safety(call.Name)
        // 需要审批或执行期 Safety 不允许的调用必须独占批次，避免并发审批和副作用交错。
        if shouldRunSerialForPermission(engine, mode, call, safety, known) ||
            (known && !opts.allows(safety)) {
            flushReadonly()
            batches = append(batches, toolBatch{items: []indexedToolCall{{index: i, call: call}}})
            continue
        }
        // 只有 Registry 明确认定为 ReadOnly 的工具才会进入并发区间。
        if known && safety == tools.SafetyReadOnly {
            readonly = append(readonly, indexedToolCall{index: i, call: call})
            continue
        }
        flushReadonly()
        batches = append(batches, toolBatch{items: []indexedToolCall{{index: i, call: call}}})
    }
    // 循环结束后提交尾部尚未遇到串行边界的只读调用。
    flushReadonly()
    return batches
}
```

并发结果不会直接 append 到完成列表，而是写回与原始调用下标对应的固定槽位：

```go
// 按调用数量预分配结果槽位。index 保证并发完成顺序不会改变模型原始顺序，
// filled 用于取消时只返回已经完成的结果。
results := make([]ToolResult, len(calls))
filled := make([]bool, len(calls))

for _, item := range batch.items {
    item := item
    wg.Add(1)
    go func() {
        defer wg.Done()
        // 单项获准后，调用链才会继续进入 Registry.Execute。
        result := executeOneTool(ctx, registry, env, iteration, item.call, events, opts, engine, mode, hooks)
        mu.Lock()
        results[item.index] = result
        filled[item.index] = true
        mu.Unlock()
    }()
}
wg.Wait()
```

并发执行后，结果仍按模型原始调用顺序写回，而不是按 goroutine 完成顺序排列。这对 ToolCall 与 ToolResult 的对应关系很重要，也避免并发调度改变下一轮消息序列。

例如模型依次返回 `read_file(A)`、`search_code(B)`、`write_file(C)`、`read_file(D)`：前两个只读调用形成并发批次，写文件独占串行批次，最后一个读取形成新的并发批次。即使 B 比 A 先完成，最终结果仍是 A、B、C、D。

这里的 Safety 声明必须保守。一个实际写文件的 Tool 如果错误标成 Read Only，不仅会绕过模式过滤，还可能与其他调用并发执行。Registry 能校验名称和超时，但无法替实现纠正错误的副作用分类。

## 失败也必须保持协议完整

失败来源不同，但都收敛为 `tools.Result`：

| 失败位置 | 典型 `ErrorType` | 是否调用具体 Tool |
| --- | --- | --- |
| PreToolUse Hook | `hook_blocked` | 否 |
| Permission | `permission_denied`、`permission_canceled` | 否 |
| Agent 执行白名单 | `tool_not_allowed` | 否 |
| Registry 前置保护 | `unknown_tool`、`invalid_arguments`、`timeout`、`internal_error` | 视失败阶段而定 |
| Tool 业务校验 | `not_found`、`not_unique`、`command_failed` 等 | 是 |

这些失败仍带原始 Call ID，并由 Runner 追加成 ToolResult。这样 Provider 不会看到悬空 ToolCall，模型也能在下一轮根据错误类型调整行为。

当前实现还有两个边界需要明确：Registry 将父 Context 取消和自身 Deadline 都映射成 `timeout`；如果具体 Tool 完全忽略 Context，它的 goroutine 可能在 Registry 返回后继续运行。容量为 1 的 `done` channel 只能保证迟到结果不会阻塞发送，不能强制终止不合作的实现。

## 测试如何验证这条链

Tool 包测试覆盖注册拒绝、稳定排序、未知名称、非法 JSON、超时和基础工具的业务错误。Agent 测试再覆盖只读并发、混合结果保序、权限审批与取消、Plan Mode 伪造 Side Effect 调用，以及 Hook 拦截后仍派发结果事件。

两层测试关注点不同：`internal/tools` 证明单个 Registry 边界稳定，`internal/agent` 证明多个调用经过调度和权限后仍维持 ReAct 消息协议。只测具体 Tool 的成功路径，无法发现并发乱序或拒绝结果没有写回 Conversation 这类跨层问题。

## 小结

PseudoClaude 的 Tool 系统把能力链拆成五段：Definition 决定模型看见什么，批次调度决定如何运行多个调用，Hook 与 Permission 决定单项能否继续，Registry 提供统一运行保护，具体 Tool 实现业务行为。所有成功与失败最终都变成同一种 Result，再回到 ReAct 循环。

下一篇将讨论这些结果进入 Conversation 后如何持久化、压缩，以及为什么长期 Memory 不能等同于聊天历史。
