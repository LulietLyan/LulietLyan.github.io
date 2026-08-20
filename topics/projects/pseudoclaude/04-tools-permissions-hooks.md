---
title: 让模型安全地动手：工具系统、权限引擎与 Hook
description: PseudoClaude 如何让 LLM 读文件、改代码、跑命令，同时把副作用关进统一执行入口。
date: 2026-08-21
order: 4
tags:
  - PseudoClaude
  - Tool Calling
  - Permission
  - Hook
---

一个 Coding Agent 最危险也最有价值的能力，是“动手”。

模型本身不能读文件、不能改代码、不能运行测试。它只能生成意图：

```json
{
  "name": "read_file",
  "arguments": {
    "path": "internal/agent/runner.go"
  }
}
```

真正的 IO、副作用和风险，都发生在工具系统里。

所以 PseudoClaude 里最重要的工程边界之一，就是把所有工具调用收敛到一条统一路径：

```text
LLM ToolCall
  -> agent.executeToolCalls
  -> PreToolUse hook
  -> permission engine
  -> tools.Registry.Execute
  -> concrete Tool.Execute
  -> PostToolUse hook
  -> ToolResult 回灌给模型
```

这篇讲 `internal/tools`、`internal/agent/tools.go`、`internal/permission` 和 `internal/hook`。

## 工具接口：模型看到的是 Definition，系统执行的是 Execute

工具接口定义在 `internal/tools/tool.go`：

```go
type Tool interface {
    Definition() Definition
    Execute(ctx context.Context, input json.RawMessage, env Env) Result
}
```

`Definition` 是给模型看的：

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

几个字段很关键：

- `Name`：模型调用工具时使用的名字。
- `Description`：模型决定何时调用工具的重要依据。
- `InputSchema`：JSON Schema，约束参数结构。
- `Safety`：`read_only` 或 `side_effect`。
- `System`：系统工具，典型例子是 `load_skill`。
- `Timeout`：工具级超时。

安全级别只有两类：

```go
const (
    SafetyReadOnly   Safety = "read_only"
    SafetySideEffect Safety = "side_effect"
)
```

这看似简单，但足够支撑关键策略：读工具可以并发，写工具和命令必须更谨慎。

## Registry：所有工具都进同一个注册表

工具注册表在 `internal/tools/registry.go`。

默认内置工具来自：

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

这些工具覆盖了 Coding Agent 的最小工程动作：

- `read_file`：读 UTF-8 文本文件。
- `write_file`：完整写入文件。
- `edit_file`：精确替换文件片段。
- `run_command`：运行本地命令。
- `find_files`：glob 查找文件。
- `search_code`：文本或正则搜索代码。

启动时，`cmd/PseudoClaude/main.go` 还会把其它来源的工具注册进同一个 Registry：

- `load_skill`
- MCP tools
- `install_skill`
- `Agent`
- background task tools
- team tools

这意味着后续执行路径是统一的。MCP 工具、Skill 工具、Agent 工具，最终也都是 `tools.Tool`。

## Registry.Execute 做了哪些防护

`Registry.Execute` 是具体工具执行前的最后一层通用包装。

它会做这些事：

1. 检查工具是否存在。
2. 检查 arguments 是否是合法 JSON。
3. 规范化 `tools.Env`。
4. 设置 context timeout。
5. 用 goroutine 执行工具。
6. recover panic。
7. 注入 `call_id` 到结果 metadata。

伪代码：

```text
tool, ok := registry.Get(call.Name)
if !ok -> unknown_tool
if !json.Valid(call.Arguments) -> invalid_arguments

execCtx := context.WithTimeout(...)
go tool.Execute(execCtx, call.Arguments, env)

select:
  timeout -> timeout failure
  result  -> normalize metadata
```

这层设计让每个工具实现可以专注自己的业务逻辑，而不用重复写 timeout、panic recover、call_id 注入。

## 内置工具的关键细节

`read_file`、`write_file`、`edit_file` 在 `internal/tools/file.go`。

`read_file` 会：

- 解析 `path`。
- 基于 `env.CWD` 解析成绝对路径。
- 拒绝目录、二进制、非 UTF-8 内容。
- 按 `MaxReadBytes` 和 `MaxOutputBytes` 截断。

`write_file` 会：

- 要求完整 `content`。
- 自动创建父目录。
- 拒绝非 UTF-8 文本。

`edit_file` 是最值得注意的工具：

```go
count := strings.Count(content, *args.OldText)
if count != 1 {
    return Failure("edit_file", "not_unique", ...)
}
```

它要求 `old_text` 在文件中精确出现一次。这是防误改设计。如果一个片段出现多次，模型必须先读文件、找准上下文，再构造唯一替换片段。

`run_command` 在 `internal/tools/command.go`。它使用：

```go
exec.CommandContext(ctx, args.Command, args.Args...)
```

注意：它不是 shell 字符串执行。`ls | grep x` 这种管道不会自动工作，必须显式传 `sh -c`。这让命令参数结构更清晰，也更容易被权限系统解析。

## 从模型输出到工具执行：agent/tools.go

模型返回工具调用后，Runner 调：

```go
executeToolCalls(ctx, r.Registry, r.Env, iteration, out.ToolCalls, ...)
```

这段逻辑在 `internal/agent/tools.go`。

第一步是分批：

```go
splitToolBatches(...)
```

规则是：

- 已知且只读，并且不需要审批：进入并发批次。
- 写操作、副作用工具、未知工具、需要审批的工具：串行执行。

为什么这样设计？

模型可能一次性请求多个读文件、搜索代码工具，这些并发执行能明显提高响应速度。但写文件、运行命令、审批弹窗都不能乱序，否则很容易出现状态冲突或多个审批同时弹出。

第二步是执行单个工具：

```text
executeOneTool
  -> EventToolCallStart
  -> dispatchPreToolHook
  -> permissionCheckedTool
  -> dispatchPostToolHook
  -> EventToolResult
  -> EventToolCallDone
```

也就是说，工具真正执行前，Hook 和权限都已经介入。

## 权限系统：先沙箱和黑名单，再规则和模式

权限引擎在 `internal/permission/engine.go`。

入口是：

```go
CheckWithContext(mode, call, safety, CheckContext{CWD: env.CWD})
```

它先把工具调用分类：

```text
read_file / find_files / search_code -> read
write_file / edit_file               -> write
run_command                           -> exec
MCP read-only                         -> read
MCP side-effect                       -> write
```

如果是命令，会解析 `command + args`，然后检查危险黑名单：

```go
if ok, pattern := hitsBlacklist(command); ok {
    return DecisionDeny
}
```

如果是文件工具，会解析目标路径，并做 sandbox check：

```text
raw target
  -> resolve under cwd/root
  -> filepath.Rel(root, resolved)
  -> 如果越过 root，则 deny
```

这一步比用户规则优先。也就是说，即使某条规则允许写文件，只要路径越出项目根，也会被沙箱拒绝。

然后才匹配多层规则：

```go
for _, rules := range []RuleSet{e.session, e.local, e.project, e.user} {
    if result, ok := rules.Match(...); ok {
        return result
    }
}
```

没命中规则时，按当前 mode fallback。

## 四种权限模式

权限模式定义在 `internal/permission/mode.go`：

```go
const (
    ModeStrict            Mode = "strict"
    ModeDefault           Mode = "default"
    ModeAcceptEdits       Mode = "acceptEdits"
    ModeBypassPermissions Mode = "bypassPermissions"
)
```

fallback 策略：

```text
strict:
  read/write/exec -> ask

default:
  read -> allow
  write/exec -> ask

acceptEdits:
  read/write -> allow
  exec -> ask

bypassPermissions:
  read/write/exec -> allow
```

TUI 里按 `Shift+Tab` 会调用 `permission.NextMode` 切换模式。

## 交互式审批怎么发生

`permissionCheckedTool` 根据 `CheckResult.Decision` 分三种：

```text
DecisionAllow -> executeAllowedTool
DecisionDeny  -> permissionDeniedResult
DecisionAsk   -> requestApproval
```

`requestApproval` 会构造：

```go
ApprovalRequest{
    Call:    call,
    Summary: summarizeCall(call),
    Reason:  result.Reason,
    Respond: make(chan permission.ApprovalDecision, 1),
}
```

然后向 TUI 发：

```go
Event{Type: EventApproval, Approval: req}
```

TUI 收到后进入 `stateApproving`。用户可以选择：

- allow once
- allow session
- allow forever
- deny once

如果选择 `allow session`，权限引擎会 `AllowForSession(call)`。

如果选择 `allow forever`，会 `PersistLocalAllow(call)` 写入本地权限配置。

这里的关键点是：审批不是工具内部做的，而是通过 Runner 事件流交给 TUI。后台 subagent 没有人审批，所以默认拒绝需要 ask 的操作。

## Hook：权限之前的生命周期扩展点

Hook 系统在 `internal/hook`。

工具调用前后分别触发：

- `PreToolUse`
- `PostToolUse`

在 `executeOneTool` 里，PreToolUse 比权限检查更早：

```go
result := dispatchPreToolHook(ctx, call, hooks)
if result.Tool == "" {
    result = permissionCheckedTool(...)
}
```

如果 Hook 返回 blocked，工具不会进入权限系统，也不会执行：

```go
return tools.Failure(call.Name, "hook_blocked", reason, ...)
```

Hook payload 里会带：

- event
- session id
- cwd
- permission mode
- tool name
- tool input

PostToolUse 会拿到工具结果摘要：

```text
tool_name
tool_input
tool_result
is_error
```

除了工具事件，Hook 还覆盖：

- session start/end
- user prompt submit
- pre user message
- pre/post compact
- notification
- stop

Hook 可以阻断，也可以注入 prompt。注入内容进入 `PromptQueue`，在 Runner 的 `reminder` 中被带入下一轮模型请求。

## 为什么这套链路重要

如果工具调用散落在各处，很容易出现三类问题：

1. 有的工具绕过权限。
2. 有的工具没有日志和事件。
3. 新增 MCP、Skill、Agent 工具时，每个都要单独接安全逻辑。

PseudoClaude 的做法是：不管工具来自哪里，最终都注册进 `tools.Registry`，再由 `agent/tools.go` 统一调度。

```text
内置工具
MCP 工具
Skill 工具
Agent 工具
Task 工具
Team 工具
  -> Registry
  -> executeToolCalls
  -> Hook
  -> Permission
  -> Execute
```

这就是让模型“安全地动手”的核心。

模型可以大胆提出动作，但动作能不能发生，不由模型决定，而由工具执行器、权限引擎和 Hook 共同决定。

