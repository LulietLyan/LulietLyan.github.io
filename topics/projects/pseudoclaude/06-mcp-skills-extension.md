---
title: 扩展能力的边界：MCP、Skill 与延迟加载
description: PseudoClaude 如何把内置工具之外的能力接入同一条 Agent 执行链路。
date: 2026-08-21
order: 6
tags:
  - PseudoClaude
  - MCP
  - Skill
  - Tool Calling
---

一个 Agent 如果只能用内置工具，很快就会碰到边界。

不同项目需要不同工具：查文档、调数据库、读 issue、访问内部服务、跑特定脚本。问题是，如果每加一种能力都要改 Runner 主循环，系统会越来越乱。

PseudoClaude 的做法是：把外部能力统一适配成 `tools.Tool`。

```text
内置工具
MCP 工具
Skill 专用工具
Agent 工具
Task / Team 工具
  -> tools.Registry
  -> 同一条权限、Hook、执行、回灌链路
```

这篇重点讲 MCP 和 Skill。

## MCP：远端工具也要变成本地 Tool

MCP 相关代码在 `internal/mcp`：

- `config.go`：读取配置。
- `manager.go`：连接 server、发现工具。
- `tool.go`：把 MCP remote tool 适配成 `tools.Tool`。
- `sdk.go` / `http.go`：不同传输方式。

配置大概长这样：

```yaml
mcp_servers:
  context7:
    type: stdio
    command: npx
    args:
      - -y
      - "@upstash/context7-mcp"
```

启动时，`main.go` 调：

```go
mcpCfg, loadIssues := mcp.LoadConfig(cwd)
mcpManager := mcp.NewManager(context.Background(), mcpCfg, ...)
```

然后：

```go
for _, tool := range mcpManager.Tools() {
    registry.Register(tool)
}
```

注意最后一步：MCP 工具没有走特殊主循环，而是直接注册到 Registry。

## MCP Manager 如何发现工具

`mcp.NewManager` 会并发连接所有配置的 server：

```text
for each server:
  Dial
  ListTools
  AdaptTool
  append manager.tools
```

代码里用了 `sync.WaitGroup` 和 mutex。每个 server 连接失败只记录 issue，不影响其它 server 和内置工具。

发现工具后，会把工具名规范成：

```text
mcp__<server>__<tool>
```

这样可以避免不同 server 的工具名冲突，也符合模型 provider 对 tool name 字符的限制。

如果 server 配置了 `read_only: true`，会强制把该 server 的工具都标成只读。

## AdaptTool：MCP 到 tools.Tool 的适配器

核心在 `internal/mcp/tool.go`：

```go
func AdaptTool(serverName string, remote RemoteTool, session ClientSession, callTimeout time.Duration) (tools.Tool, *Issue)
```

它返回的是一个 `remoteTool`，实现了 `tools.Tool` 接口。

`Definition()` 返回：

```go
tools.Definition{
    Name:        fullName,
    Description: description,
    InputSchema: schema,
    Safety:      safety,
}
```

`Execute()` 做的事是：

1. 把 JSON arguments 解成 `map[string]any`。
2. 设置 MCP call timeout。
3. 调 `session.CallTool(callCtx, remoteName, args)`。
4. 把文本块合并成 content。
5. 丢弃非文本块并记录 `non_text_dropped`。
6. 转成 `tools.Success` 或 `tools.Failure`。

这意味着 MCP 工具一旦进入 Registry，后续完全复用本地工具链路：

```text
LLM sees mcp__server__tool
  -> returns ToolCall
  -> agent/tools.go
  -> PreToolUse hook
  -> permission engine
  -> registry.Execute
  -> remoteTool.Execute
  -> MCP CallTool
```

MCP 的复杂性被关在 adapter 里，Runner 不需要知道远端工具怎么连接。

## Skill：先放目录，再按需加载全文

MCP 解决的是“工具来自外部服务”。Skill 解决的是另一个问题：复杂任务需要一套 SOP。

如果把所有 Skill 的完整说明都塞进 system prompt，会很快浪费大量 token。PseudoClaude 的策略是延迟加载：

```text
启动时只加载 skill 摘要目录
模型需要时调用 load_skill
load_skill 再把完整 SOP 注入 active skills
如果 skill 声明了专用工具，再动态注册进 Registry
```

Skill 相关代码在：

- `internal/skills/catalog.go`
- `internal/skills/parser.go`
- `internal/skills/render.go`
- `internal/skills/active.go`
- `internal/tools/load_skill.go`
- `internal/tools/skill_tool.go`

## Catalog：扫描 builtin/user/project 三类 Skill

`skills.LoadCatalog` 会扫描：

```text
builtin skills
~/.PseudoClaude/skills
<project>/.PseudoClaude/skills
```

每个 skill 可以是一个 `.md` 文件，也可以是一个目录。

Catalog 对外提供：

- `List()`
- `Get(name)`
- `PromptItems()`
- `Summaries()`
- `ValidateTools(...)`
- `Reload(...)`

启动时，`main.go` 把 skill 摘要放进 prompt：

```go
m.runner.SkillsCatalog = m.promptSkillCatalog
```

实际 system prompt 中不是完整 Skill 内容，而是类似：

```text
Available Skills:
- name: description
```

这就是延迟加载的第一步。

## load_skill 是系统工具

`load_skill` 在 `internal/tools/load_skill.go`。

它的定义：

```go
Definition{
    Name:   "load_skill",
    Safety: SafetyReadOnly,
    System: true,
}
```

`System: true` 很重要。即使当前 active skill 限制了可用工具，`load_skill` 也会保留。否则模型可能陷入“需要加载技能，但加载技能的工具被过滤掉”的死局。

执行流程：

```text
decode name
Catalog.Get(name)
ReloadSkillBody(skill)
RenderInvocation(skill, "")
Active.Activate(skill.Meta.Name, rendered)
注册 skill.Tools 为 specialized tools
返回 loaded skill
```

代码里还会把 skill 自带工具注册到 Registry：

```go
for _, spec := range skill.Tools {
    registry.RegisterOrReplace(NewSkillTool(spec))
}
```

这意味着 Skill 不仅是 prompt 文档，也可以携带可执行工具。

## Active Skills 如何进入下一轮 prompt

`load_skill` 激活后，内容存进 `ActiveSkills`。

Runner 每轮请求前会：

```go
if active := prompt.RenderActiveSkills(r.activeSkillEntries()); active != "" {
    environment = strings.TrimSpace(environment) + "\n\n" + active
}
```

注意：active skill 是加到 environment 部分，而不是重新构造整个 stable system。这让它可以随运行状态变化。

Skill 的生命周期是：

```text
Catalog 摘要常驻
  -> 模型选择 load_skill
  -> ActiveSkills 记录完整 SOP
  -> 下一轮 prompt 带上 active skill
  -> Skill specialized tools 注册进 Registry
```

相比启动时全量加载所有说明，延迟加载可以降低常驻 token 占用，并让能力激活变成显式动作。

## Skill Tool：把外部命令包装成工具

`internal/tools/skill_tool.go` 会把 `skills.ToolSpec` 包装成 `tools.Tool`。

执行时，它会运行 Skill 声明的外部命令，并把原始 JSON 参数作为 stdin 传入。

这类工具默认是 `SafetySideEffect`。哪怕实际脚本只读，系统也保守地把它当成有副作用工具处理。

这是一种合理默认值：外部脚本的真实行为很难静态判断，宁可多审批，也不要默默执行风险脚本。

## install_skill：运行时安装新 Skill

`install_skill` 在 `internal/tools/install_skill.go`。

它可以从本地路径或 HTTP(S) zip 安装 skill 包到用户目录，然后触发 catalog reload。

启动时注册：

```go
registry.Register(tools.NewInstallSkillTool(userSkillDir, reloadFn))
```

这让 Agent 能在运行时扩展自己的技能库。当然，它是副作用工具，会走权限系统。

## MCP 和 Skill 的共同点

MCP 和 Skill 看起来是两类机制，但它们在 PseudoClaude 里的共同点是：

```text
外部能力必须适配进内部统一抽象。
```

MCP 适配成 `tools.Tool`。

Skill 摘要适配成 prompt catalog。

Skill 完整 SOP 通过 `load_skill` 变成 active prompt。

Skill 专用命令也适配成 `tools.Tool`。

因此 Runner 主循环不需要分支：

```text
如果是内置工具...
如果是 MCP 工具...
如果是 Skill 工具...
```

它只看：

```go
registry.DefinitionsFiltered(...)
registry.Execute(...)
```

这就是生态扩展的关键。

## 扩展入口总结

如果把所有能力写死在 Runner 中，Runner 会同时承担协议适配、工具发现、外部连接、prompt 组织和执行调度职责。PseudoClaude 将扩展入口拆成两类：

- MCP：扩展可调用的外部工具。
- Skill：扩展任务流程说明，并在需要时提供专用工具。

两者最终都回到同一条工具链：

```text
Definition 暴露给模型
ToolCall 返回给 Runner
Hook 和 Permission 统一检查
Execute 统一执行
Result 统一回灌
```

因此，扩展能力不会绕过 Runner、Hook、Permission 和 Registry。外部能力只有先适配为内部工具定义或 active prompt，才能进入 Agent 主循环。
