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
type Definition struct {
    Name        string
    Description string
    InputSchema map[string]any
    Safety      Safety
    System      bool
    Timeout     time.Duration
}

type Call struct {
    ID        string
    Name      string
    Arguments json.RawMessage
}

type Result struct {
    OK        bool           `json:"ok"`
    Tool      string         `json:"tool"`
    Content   string         `json:"content,omitempty"`
    ErrorType string         `json:"error_type,omitempty"`
    Error     string         `json:"error,omitempty"`
    Metadata  map[string]any `json:"metadata,omitempty"`
}

type Tool interface {
    Definition() Definition
    Execute(ctx context.Context, input json.RawMessage, env Env) Result
}
```

`Definition` 是发送给模型的 Tool 定义，`Execute` 是只存在于本地进程的实现。两者放在同一个接口上，可以保证注册表中的每一个模型定义都有对应执行对象，但模型不会得到 Go 函数指针或本地环境。

`Safety` 只提供 `read_only` 与 `side_effect` 两类粗粒度标签，用于工具过滤、执行策略和权限分类。它不是参数级权限规则：同一个 `run_command` 的 `git status` 与危险删除命令都属于 Side Effect，具体目标仍要在执行前解析。

`Env` 则保存本次执行才确定的 CWD、超时和输出上限。基础文件工具因此可以是无状态值，同一个 Tool 实例能在主 Agent、SubAgent 或 Worktree 中使用不同环境。

## Registry 是唯一运行目录

`Registry` 用 Definition Name 索引 Tool：

```go
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
```

普通注册拒绝 nil、空名称和重复名称，避免一个后加载模块静默覆盖原有能力。只有 Skill 重载和 Team 兼容工具等明确允许替换的场景才调用 `RegisterOrReplace`。

入口先注册六个不需要外部依赖的基础工具：

```go
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
func (r *Registry) DefinitionsFiltered(allowed []string) []Definition {
    if len(allowed) == 0 {
        return r.Definitions()
    }
    allowedSet := make(map[string]bool, len(allowed))
    for _, name := range allowed {
        name = strings.TrimSpace(name)
        if name != "" {
            allowedSet[name] = true
        }
    }
    defs := r.Definitions()
    out := make([]Definition, 0, len(defs))
    for _, def := range defs {
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
func (r *Registry) Execute(ctx context.Context, call Call, env Env) Result {
    tool, ok := r.Get(call.Name)
    if !ok {
        return Failure(call.Name, "unknown_tool",
            fmt.Sprintf("unknown tool %q", call.Name),
            map[string]any{"call_id": call.ID})
    }
    if !json.Valid(call.Arguments) {
        return Failure(call.Name, "invalid_arguments",
            "arguments must be valid JSON",
            map[string]any{"call_id": call.ID})
    }
    env = normalizeEnv(env)
    if ctx == nil {
        ctx = context.Background()
    }
    timeout := env.Timeout
    if def := tool.Definition(); def.Timeout > 0 {
        timeout = def.Timeout
    }
    execCtx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    done := make(chan Result, 1)
    go func() {
        defer func() {
            if recovered := recover(); recovered != nil {
                done <- Failure(call.Name, "internal_error",
                    fmt.Sprintf("tool panicked: %v", recovered),
                    map[string]any{"call_id": call.ID})
            }
        }()
        done <- tool.Execute(execCtx, call.Arguments, env)
    }()

    select {
    case <-execCtx.Done():
        return Failure(call.Name, "timeout", execCtx.Err().Error(),
            map[string]any{"call_id": call.ID})
    case result := <-done:
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
func executeOneTool(
    ctx context.Context,
    registry *tools.Registry,
    env tools.Env,
    iteration int,
    call llm.ToolCall,
    events chan<- Event,
    opts toolExecutionOptions,
    engine *permission.Engine,
    mode permission.Mode,
    hooks toolHookContext,
) ToolResult {
    started := time.Now()
    sendEvent(ctx, events, Event{
        Type: EventToolCallStart, Iteration: iteration, ToolCall: &call,
    })
    result := dispatchPreToolHook(ctx, call, hooks)
    if result.Tool == "" {
        result = permissionCheckedTool(
            ctx, registry, env, iteration, call, events, opts, engine, mode, hooks,
        )
    }
    dispatchPostToolHook(ctx, call, result, hooks)
    out := ToolResult{Call: call, Result: result, Elapsed: time.Since(started)}
    sendEvent(ctx, events, Event{
        Type: EventToolResult, Iteration: iteration, ToolResult: &out,
    })
    sendEvent(ctx, events, Event{
        Type: EventToolCallDone, Iteration: iteration, ToolCall: &call, ToolResult: &out,
    })
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

## 多个调用的顺序边界

模型一轮可以返回多个 ToolCall。PseudoClaude 会把确定为 Read Only 且无需交互审批的连续调用组成并发批次；未知工具、Side Effect 工具、当前模式不允许的工具以及可能询问权限的调用保持串行。

并发执行后，结果仍按模型原始调用顺序写回，而不是按 goroutine 完成顺序排列。这对 ToolCall 与 ToolResult 的对应关系很重要，也避免并发调度改变下一轮消息序列。

这里的 Safety 声明必须保守。一个实际写文件的 Tool 如果错误标成 Read Only，不仅会绕过模式过滤，还可能与其他调用并发执行。Registry 能校验名称和超时，但无法替实现纠正错误的副作用分类。

## 小结

PseudoClaude 的 Tool 系统把工具能力拆成三个阶段：Definition 决定模型看见什么，Agent 层决定一次调用能否进入执行，Registry 决定如何可靠地路由和运行实现。所有成功与失败最终都变成同一种 Result，再回到 ReAct 循环。

下一篇将讨论这些结果进入 Conversation 后如何持久化、压缩，以及为什么长期 Memory 不能等同于聊天历史。
