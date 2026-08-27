---
title: Agent 委派：Fork 与预定义子 Agent 如何分工
description: How PseudoClaude routes Agent tool calls into conversation forks or predefined roles with scoped models, tools, permissions, and execution contexts.
date: 2026-08-28
order: 19
tags:
  - PseudoClaude
  - Multi-Agent
  - Delegation
  - Go
---

多 Agent 的第一步不是并发，而是决定要把什么上下文和能力交给谁。代码检索适合一个从空白上下文开始的只读角色，延续当前推理则需要继承完整 Conversation；两者如果都叫“启动子 Agent”，很容易掩盖其状态边界。

PseudoClaude 用同一个 `Agent` Tool 承担委派入口，但内部区分 Fork、预定义子 Agent 和 Team Member。本篇只分析前两种：Fork 复制父会话后在后台继续，预定义角色则按 Markdown Definition 创建受限 Runner。

## Agent Tool 先做三路分发

模型提交的参数同时覆盖三种协作方式：

```go
type AgentToolInput struct {
    Prompt           string `json:"prompt"`
    Description      string `json:"description"`
    SubagentType     string `json:"subagent_type,omitempty"`
    Model            string `json:"model,omitempty"`
    Isolation        string `json:"isolation,omitempty"`
    RunInBackground  bool   `json:"run_in_background,omitempty"`
    Name             string `json:"name,omitempty"`
    TeamName         string `json:"team_name,omitempty"`
    PlanModeRequired bool   `json:"plan_mode_required,omitempty"`
}
```

`Execute` 在 Trim 和基础校验后读取 `RunnerHandle` 快照，并按固定顺序路由：

```go
if parentRunnerIsSubagent(parent) {
    if args.TeamName != "" {
        return tools.Failure(
            "Agent",
            "nested_team_member_forbidden",
            "team members and sub Agents cannot start another team member",
            nil,
        )
    }
    if parentRunnerIsFork(parent) {
        return tools.Failure(
            "Agent",
            "nested_agent_forbidden",
            "Fork sub Agents cannot start another Agent",
            nil,
        )
    }
    return tools.Failure(
        "Agent",
        "nested_agent_forbidden",
        "Sub Agents cannot start another Agent",
        nil,
    )
}
if args.TeamName != "" {
    return t.executeTeam(ctx, args, parent)
}
if args.SubagentType == "" {
    return t.executeFork(ctx, args, parent)
}
def, ok := t.Catalog.Resolve(args.SubagentType)
if !ok {
    return tools.Failure(
        "Agent",
        "unknown_subagent_type",
        "unknown subagent_type: "+args.SubagentType,
        map[string]any{"subagent_type": args.SubagentType},
    )
}
return t.executeDefined(ctx, args, parent, def)
```

`team_name` 的优先级高于 `subagent_type`，因为 Team Member 可以同时选择一个预定义角色；没有 Team 且没有类型才表示 Fork。所有子 Agent 和 Team Member 都不能再次调用 Agent，避免无界递归委派和无法归属的后台树。

Description 缺失时取 Prompt 的前 80 个字节作为短描述。这里按 byte slice 截取，长中文恰好跨 UTF-8 边界时可能生成无效字符串；现有输入校验没有做 rune 截断。

## 预定义角色是一份 Markdown 运行策略

角色文件由 YAML Frontmatter 和正文组成。解析结果不仅是 Prompt，还包括运行能力：

```go
type Definition struct {
    Name            string
    Description     string
    Tools           []string
    DisallowedTools []string
    Model           ModelRef
    MaxTurns        int
    Permission      PermissionRef
    Background      bool
    Isolation       Isolation
    SystemPrompt    string
    Source          Source
    Path            string
    Warnings        []Warning
}
```

内置 `explore` 使用 Haiku、最多 8 轮，明确禁用 Write/Edit；`plan` 使用 Sonnet 和 Plan Permission；`general-purpose` 继承父模型和权限。项目也可以在 `.PseudoClaude/agents/*.md` 定义角色，用户级目录是 `~/.PseudoClaude/agents/*.md`。

Catalog 同时加载 Plugin、Builtin、User 和 Project，优先级依次为 10、20、30、40：

```go
func (s Source) Priority() int {
    switch s {
    case SourceProject:
        return 40
    case SourceUser:
        return 30
    case SourceBuiltin:
        return 20
    case SourcePlugin:
        return 10
    default:
        return 0
    }
}

func (c *Catalog) reload(opts LoadOptions) {
    active := map[string]Definition{}
    all := map[string][]Definition{}
    add := func(def Definition) {
        all[def.Name] = append(all[def.Name], cloneDefinition(def))
        if cur, ok := active[def.Name];
            !ok || def.Source.Priority() >= cur.Source.Priority() {
            active[def.Name] = cloneDefinition(def)
        }
    }
    // plugin -> builtin -> user -> project
}
```

Project 可以覆盖同名 User/Builtin，User 可以覆盖 Builtin。解析错误不会阻止整个 Catalog，合法角色继续加载，问题进入 Warnings。Tool schema 本身不为角色生成 enum，动态角色只追加到 Tool Description，因此 Reload 不会改变 Provider 缓存所见的 JSON Schema。

Plugin 加载函数当前返回 nil，所以它只是预留优先级；同一 Source 内出现同名文件时，后加载项会因 `>=` 覆盖 active，代码没有单独报告重名冲突。

## 预定义子 Agent 从空 Conversation 开始

Defined 路径不会复制父消息，只共享 Provider、Registry、配置和受控运行依赖：

```go
func (t *AgentTool) executeDefined(
    ctx context.Context,
    args AgentToolInput,
    parent RunnerSnapshot,
    def subagent.Definition,
) tools.Result {
    background := args.RunInBackground || def.Background
    runner := t.childRunner(parent, def, false, background)
    childConv := &conversation.Conversation{}

    if effectiveIsolation(args, def) == subagent.IsolationWorktree {
        // 创建或准备独立 worktree
    }
    if background {
        return t.launch(
            ctx, args, def, runner, childConv, false, "async_launched",
        )
    }
    result := runForeground(
        ctx, runner, childConv, args.Prompt,
        t.Background.ForegroundTimeout,
    )
    return completionToolResult(def.Name, result)
}
```

父 Agent 必须把完成任务所需事实写进 Prompt，子 Agent 看不到父 Conversation 的隐含推理。这减少无关历史和 Token，也让角色结果更容易复现；代价是 Prompt 不完整时，子 Agent 无法自行回看父对话补齐需求。

前台是 Defined 的默认值。调用参数或 Definition 的 `background: true` 任一成立，就改由 Task Manager 异步运行。调用参数的 `isolation: worktree` 也可以覆盖一个未声明隔离的角色，但只接受 `worktree`，`container` 等值直接返回 `invalid_arguments`。

## Fork 复制父会话并强制后台

Fork 的目的不是切换角色，而是从当前会话状态分出一条异步支线：

```go
func (t *AgentTool) executeFork(
    ctx context.Context,
    args AgentToolInput,
    parent RunnerSnapshot,
) tools.Result {
    def := subagent.ForkDefinition()
    messages := subagent.BuildForkMessages(
        parent.Conversation.Messages(),
        args.Prompt,
    )
    childConv := conversation.NewFromMessages(
        messages,
        conversation.Hooks{},
    )
    runner := t.childRunner(parent, def, true, true)
    return t.launch(
        ctx, args, def, runner, childConv, true, "async_launched",
    )
}
```

即使请求写了 `run_in_background: false`，Fork 仍传入 `background=true` 并立即返回 task ID。Fork Definition 使用继承模型、继承权限和专用约束 Prompt，要求只处理分配任务、不询问用户、不继续委派。

`BuildForkMessages` 会复制消息与 ToolCalls 切片，并为 ToolResult 建立新的结构体值，再附加 Fork 标记和新任务：

```go
func BuildForkMessages(parent []llm.Message, task string) []llm.Message {
    messages := cloneMessages(parent)
    messages = ensureNoDanglingToolCalls(messages)
    content := strings.TrimSpace(ForkBoilerplate) +
        "\n\nTask:\n" + strings.TrimSpace(task)
    messages = append(messages, llm.Message{
        Role: "user", Content: content,
    })
    return messages
}
```

父消息若以带 ToolCalls 的 Assistant 消息结束，Fork 会为每个调用补一个 `tool result unavailable in forked context` 错误结果，保证 Provider 不收到悬空调用协议。这不是重放真实工具结果，而是为了让复制后的消息序列结构合法。

Fork 不读取 `isolation` 并直接进入 `executeFork`，因此当前不能用同一个 Agent 调用为 Fork 创建 worktree；隔离参数只在 Defined 路径生效。

这里的复制不是任意嵌套数据的递归深拷贝。`ToolCall.Arguments` 是 `json.RawMessage`，复制 ToolCall struct 后仍可能共享底层 byte slice；当前流程把历史消息视为不可变值。测试验证了修改子级 ToolCalls 元素不会回写父切片，并验证悬空调用得到补全，但没有修改 Arguments byte 来验证完全隔离。

## Child Runner 收窄能力而不是复制完整父 Runner

Runner 装配会解析角色模型，并按 Definition、后台策略和 Plan Permission 过滤 Tool：

```go
allowed := tools.FilterSubAgentTools(parent.Registry, tools.FilterPolicy{
    DefinitionTools:      def.Tools,
    DefinitionDisallowed: def.DisallowedTools,
    Background:           background,
    Fork:                 fork,
})
if def.Permission == subagent.PermissionPlan {
    allowed = readOnlyToolNames(parent.Registry, allowed)
}

return Runner{
    Provider:     provider,
    Registry:     parent.Registry,
    AllowedTools: allowed,
    Sub: SubRunOptions{
        SystemPrompt:   def.SystemPrompt,
        MaxTurns:       def.MaxTurns,
        PermissionMode: permissionModeFromRef(
            def.Permission, parent.PermissionMode,
        ),
        DontAsk:     true,
        IsSubAgent:  true,
        IsFork:      fork,
        ParentLabel: def.Name,
    },
}
```

普通子 Agent 看不到 Team 协作 Tool 和 Agent Tool；后台任务还会与固定异步允许列表取交集。Definition 的 allow list 最后再取交集，deny list 则先删除。`MaxTurns` 覆盖 Runner 的最大迭代数，Model 可通过 ProviderResolver 选择，解析失败会安静回退父 Provider。

所有子运行都设置 `DontAsk: true`，具体权限边界已在第 17 篇披露：硬 Deny 仍生效，但 Permission Engine 的 Ask 会直接执行。它属于委派信任模型的一部分，不能因为角色有 Permission 字段就理解为每个副作用都重新询问用户。

## 完整流程

```text
Provider 返回 Agent ToolCall
  -> 解析、Trim、校验 prompt / isolation / parent snapshot
  -> 父 Runner 是子 Agent：拒绝嵌套委派
  -> team_name 非空：交给 Team Manager
  -> subagent_type 为空：Fork
       -> 结构化复制父 Conversation
       -> 修复悬空 ToolCall
       -> 加入 Fork 约束与任务
       -> 强制后台 Task
  -> subagent_type 非空：Catalog Resolve
       -> 空 Conversation
       -> 解析 Model / Tools / Permission / MaxTurns
       -> 前台运行，或按参数/Definition 转后台
```

## 测试验证了什么

AgentTool 测试确认 Defined 从空会话启动、Explore 不暴露写工具、Fork 保留标记并强制后台、未知角色和嵌套委派被拒绝、调用级 worktree 可覆盖角色设置。Catalog/Parser 测试覆盖来源优先级、热 Reload、完整 Frontmatter、非法值 Warning；Fork 测试覆盖 ToolCalls 切片隔离、Fork 标记和悬空 ToolCall 修复。

现有测试没有覆盖同一来源的同名角色冲突、ProviderResolver 返回错误的可观测告警、中文 Description 的 byte 截断，或为 Fork 提供 worktree isolation。它们都是当前实现不能额外承诺的行为。

## 小结

PseudoClaude 将“继承当前思路”和“调用一个专业角色”做成两种明确委派模型。Fork 用父 Conversation 换取上下文连续性，并固定后台运行；Defined 用空 Conversation 和 Definition 换取更小、更受控的执行环境。

下一篇继续追踪二者的运行载体：前台子 Agent 如何同步返回，超时怎样转入后台，以及 Task Manager 怎样保存状态并把完成结果交还 TUI。
