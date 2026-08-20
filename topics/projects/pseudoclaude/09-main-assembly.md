---
title: 入口装配：main.go 如何连接配置、工具、记忆与 TUI
description: 从 cmd/PseudoClaude/main.go 出发，分析 PseudoClaude 的启动顺序、依赖注入和运行时边界。
date: 2026-08-21
order: 9
tags:
  - PseudoClaude
  - Go
  - Architecture
---

`cmd/PseudoClaude/main.go` 是 PseudoClaude 的进程入口，也是理解项目依赖关系的最短路径。它没有承载业务细节，而是把配置、指令、记忆、权限、Hook、工具、MCP、Skill、Subagent、Team 和 TUI 装配成一个可运行的终端应用。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

## 入口职责

入口文件的职责可以归纳为三类。

第一类是加载外部输入：配置文件、项目指令、用户指令、权限策略、Hook 规则、Skill 目录、MCP 配置、Subagent 定义和历史 Team 状态。

第二类是创建运行时对象：memory manager、permission engine、worktree manager、tool registry、MCP manager、task manager、team manager、agent handle。

第三类是把这些对象注入 TUI，使终端状态机可以在用户输入时构造完整的 `agent.Runner`。

因此，`main.go` 更接近 composition root，而不是传统意义上的控制器。它决定“哪些能力存在”，但不决定“每轮 Agent 如何运行”。

## 启动顺序

启动流程可以按以下顺序阅读：

```text
config.Load
instructions.NewLoader(...).Load
memory.NewManager
hook.Load
session.CleanExpired
permission.NewEngine
worktree.NewManager
tools.DefaultRegistry
skills.LoadCatalog
mcp.LoadConfig / mcp.NewManager
subagent.LoadCatalog
task.NewManager
team.NewManager
agent.AgentTool
tui.New(...).WithXxx(...).Run
```

这个顺序反映了依赖方向。

工具注册表必须先创建，随后内置工具、MCP 工具、Skill 工具、Agent 工具和 Team 工具才能陆续注册进去。

权限引擎必须在 TUI 创建前完成，因为 TUI 初始权限模式来自 `permissionEngine.StartMode()`。

worktree manager 必须先于 team manager 创建，因为 Team 和 Subagent 都可能依赖 worktree 做工作区隔离。

task manager 必须先于 agent tool 和 team manager 创建，因为后台任务、消息发送和团队成员运行都需要统一生命周期管理。

## 配置加载

入口首先调用：

```go
cfg, err := config.Load(".PseudoClaude/config.yaml")
```

配置文件的主要职责是声明 provider、MCP server 和 feature flag。provider 配置随后进入 `tui.New(cfg.Providers, ...)`，由 TUI 在启动时或用户选择后创建具体 `llm.Provider`。

这里的设计选择是：入口只加载配置，不直接创建 provider。原因在于 provider 选择属于交互流程的一部分。当配置中有多个 provider 时，`internal/tui` 会进入 `stateSelecting`，通过列表让用户选择；只有选中后才调用 `llm.New`。

## 指令与记忆

项目指令由 `instructions.NewLoader(cwd).Load()` 加载。该 loader 会合并项目级、局部和用户级指令，并支持 `@include` 扩展附近参考材料。

长期记忆由以下代码初始化：

```go
memoryManager := memory.NewManager(
    memory.DefaultProjectDir(cwd),
    memory.DefaultUserDir(home),
)
memoryManager.RefreshIndex()
```

memory manager 并不直接进入模型请求。入口将它注入 TUI：

```go
WithPersistentContext(instructionResult.Content, memoryManager)
```

随后 TUI 把指令和记忆传给 runner：

```go
m.runner.Instructions = instructions
m.runner.Memory = memoryManager
```

Runner 在每轮运行前调用 `Memory.IndexText()`，把裁剪后的记忆索引放进 stable system prompt；在普通主 Agent 运行完成后调用 `UpdateAsync` 异步更新记忆。

## Hook 与权限

Hook engine 通过 `hook.Load` 创建：

```go
hookEngine := hook.Load(hook.LoadOptions{
    ProjectRoot: cwd,
    HomeDir:     home,
    Logf:        ...,
})
```

权限引擎通过 `permission.NewEngine(cwd, permission.DefaultOptions(cwd))` 创建。入口还会遍历 `permissionEngine.LoadIssues()`，将配置问题打印到 stderr。

这两个组件都会进入 TUI：

```go
tui.New(cfg.Providers, cwd, registry, permissionEngine).
    WithHooks(hookEngine)
```

TUI 在用户提交前触发 `UserPromptSubmit` Hook，在会话开始和结束时触发生命周期 Hook；Runner 在工具执行、compact、stop 等阶段触发 Agent 层 Hook。权限引擎则只在工具执行路径上做决策，不负责 UI 呈现。

这种分工避免了两个常见问题：Hook 变成权限系统的替代品，或者权限系统承担过多生命周期扩展职责。

## 工具注册表

入口通过 `tools.DefaultRegistry()` 创建默认工具：

```go
registry, err := tools.DefaultRegistry()
```

默认工具包括读文件、写文件、编辑文件、执行命令、查找文件和搜索代码。随后入口继续注册更多工具来源。

Skill 加载工具：

```go
registry.Register(tools.NewLoadSkillTool(skillCatalog, activeSkills, registry))
```

MCP 工具：

```go
for _, tool := range mcpManager.Tools() {
    registry.Register(tool)
}
```

Skill 安装工具：

```go
registry.Register(tools.NewInstallSkillTool(userSkillDir, reloadFn))
```

Agent 工具：

```go
registry.Register(agentTool)
```

Task 工具与 Team 工具：

```go
task.NewTaskListTool(taskManager)
task.NewTaskGetTool(taskManager)
task.NewTaskStopTool(taskManager)
task.NewSendMessageTool(taskManager)
teamtools.NewTeamCreateTool(teamManager)
...
```

这说明 PseudoClaude 的扩展点最终都会汇入 `tools.Registry`。Runner 只看一个注册表，不需要区分工具来自内置代码、MCP server、Skill 目录还是 Agent 协作系统。

## MCP 初始化

MCP 的加载分两步。

第一步读取配置：

```go
mcpCfg, loadIssues := mcp.LoadConfig(cwd)
```

第二步创建 manager：

```go
mcpManager := mcp.NewManager(context.Background(), mcpCfg, mcp.ManagerOptions{
    ClientInfo: mcp.ClientInfo{Name: "PseudoClaude", Version: "dev"},
})
defer mcpManager.Close()
```

入口会打印配置问题和连接问题，但不会因为单个 MCP server 失败而退出。随后所有成功暴露的 MCP 工具都会注册进统一工具表。

这是一种故障隔离策略：外部扩展失败不应影响内置工具和本地 Agent 主流程。

## Subagent、Task 与 Team

子 Agent 目录由 `subagent.LoadCatalog` 加载。task manager 通过 `task.NewManager` 创建。team manager 则依赖 home、project root、worktree manager 和 task manager：

```go
team.NewManager(team.ManagerOptions{
    HomeDir:     home,
    ProjectRoot: cwd,
    Worktrees:   worktreeMgr,
    Tasks:       taskManager,
})
```

随后入口创建 `agent.AgentTool`：

```go
agentHandle := &agent.RunnerHandle{}
agentTool := &agent.AgentTool{
    Catalog:   subagentCatalog,
    Tasks:     taskManager,
    Parent:    agentHandle,
    Worktrees: worktreeMgr,
}
```

`RunnerHandle` 是这里的关键。入口创建 Agent 工具时，主 Runner 还没有处理具体用户输入；可用于派生子 Agent 的 runner snapshot 要等 TUI 提交任务时才能确定。TUI 在 `submitAgentTextWithTools` 中调用 `refreshAgentHandle`，把当前 provider、registry、env、permission、compact、instructions、memory、hooks、conversation 等状态写入 handle。之后 Agent 工具才能基于父 Runner 快照创建子 Agent。

## TUI 装配

入口最后构造 TUI：

```go
model := tui.New(cfg.Providers, cwd, registry, permissionEngine).
    WithAgentHandle(agentHandle).
    WithWorktrees(worktreeMgr).
    WithSkills(skillCatalog, activeSkills).
    WithHooks(hookEngine).
    WithSubAgents(subagentCatalog, taskManager).
    WithTeams(teamManager).
    WithPersistentContext(instructionResult.Content, memoryManager).
    WithStartupStatus(startup...)
```

链式 `WithXxx` 方法将可选能力注入 TUI。这个写法有两个好处。

第一，入口能清楚表达系统能力组合，不需要把所有依赖塞进一个巨大构造函数。

第二，测试可以只构造需要的能力。例如只测试命令分发时不需要 MCP；只测试权限审批时不需要 Team；只测试 provider 选择时不需要 Skill。

## 启动状态

入口会生成 `startup` 列表，例如：

```text
MCP: 2/3 connected, 12 registered
Instructions: 2 loaded
Memory: index loaded
Skills: 5 loaded
Hooks: 3 loaded
Agents: 4 loaded
Worktree: enabled
Teams: 1 loaded
```

这些信息进入 `WithStartupStatus`，由 TUI 展示给用户。启动状态不是核心逻辑，但它对本地工具非常重要：用户需要知道哪些扩展已经加载，哪些能力被禁用。

## 小结

`main.go` 的工程价值在于明确组合边界。它不实现 Agent 逻辑，不直接执行工具，也不处理 TUI 状态；它只负责把运行时依赖稳定地接起来。

PseudoClaude 的后续扩展大多可以从入口判断接入位置：新增 provider 进入 `internal/llm` 和配置；新增工具进入 `tools.Registry`；新增生命周期扩展进入 Hook；新增协作模式进入 task/team/subagent/worktree；新增交互命令进入 `internal/command` 和 TUI adapter。

对 Go 项目而言，这种 composition root 能降低阅读成本，也能避免依赖在包之间隐式漂移。
