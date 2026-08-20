---
title: TUI 与 Slash Command：交互状态机如何驱动 Agent
description: 分析 internal/tui 与 internal/command 如何管理输入、provider 选择、运行事件、审批、compact 和 slash command。
date: 2026-08-21
order: 11
tags:
  - PseudoClaude
  - Go
  - TUI
---

PseudoClaude 是一个 terminal-first 的 Agent 项目。模型和工具是执行核心，但用户实际面对的是 TUI：输入任务、选择 provider、切换权限模式、查看流式输出、处理审批、恢复会话、执行 slash command。`internal/tui` 的职责就是把这些交互状态组织成一个稳定的 Bubble Tea 状态机。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

## TUI 状态

`internal/tui/tui.go` 定义了会话状态：

```go
type sessionState int

const (
    stateSelecting sessionState = iota
    stateIdle
    stateStreaming
    stateApproving
    stateResuming
)
```

这些状态控制同一输入事件在不同阶段的含义。

在 `stateSelecting` 中，键盘输入用于选择 provider。

在 `stateIdle` 中，Enter 会提交用户输入；Shift+Tab 会切换权限模式；slash command 会被命令分发器处理。

在 `stateStreaming` 中，TUI 持续等待 `agent.Event`，Esc 会取消当前运行。

在 `stateApproving` 中，数字键、方向键和 Enter 用于处理权限审批。

在 `stateResuming` 中，列表选择用于恢复历史会话。

这种显式状态划分避免了大量布尔变量交叉判断。终端应用没有浏览器路由，也没有后端请求上下文，因此状态机本身就是交互边界。

## Model 结构

`tui.Model` 持有三类字段。

第一类是 UI 组件：textarea、spinner、list、viewport、glamour renderer。

第二类是 Agent 运行态：provider、conversation、runner、compact runtime、session writer、events channel、cancel function、usage、current tool、permission mode、pending approval。

第三类是扩展能力：registry、command registry、skill catalog、hook engine、subagent catalog、task manager、team manager、worktree manager、agent handle。

这看起来字段较多，但都属于本地终端应用运行态。更重要的是，执行核心不在 TUI 内部；TUI 只在提交时刷新 runner 依赖，然后消费 runner 输出的事件。

## 初始化

`tui.New` 创建基础 UI 组件、registry、command registry、tool env、hook prompt queue、permission mode，并初始化 compact runtime 与 session writer。

当配置中有多个 provider 时：

```go
if len(providers) > 1 {
    m.state = stateSelecting
    m.list = newProviderList(providers, 80, 12)
}
```

当只有一个 provider 时，TUI 直接调用 `llm.New` 创建 provider，并设置给 runner。

Session 和 compact runtime 也在 TUI 初始化中创建。原因是 TUI 持有当前会话生命周期：用户可以在 TUI 内恢复旧会话、手动 compact、关闭程序时写入 session end hook。

## Update 分发

Bubble Tea 的核心是 `Update(msg tea.Msg) (tea.Model, tea.Cmd)`。PseudoClaude 先处理全局消息，例如 task done、team wake、window resize、鼠标滚动和 Ctrl+C；随后按状态分发：

```go
switch m.state {
case stateSelecting:
    return m.updateSelecting(msg)
case stateStreaming:
    return m.updateStreaming(msg)
case stateApproving:
    return m.updateApproving(msg)
case stateResuming:
    return m.updateResuming(msg)
default:
    return m.updateIdle(msg)
}
```

这是一种直接、可测试的状态机结构。每个状态只处理自己关心的消息，其余消息返回原状态。

## 用户输入提交

普通输入由 `submitUserText` 进入，最终调用：

```go
submitAgentTextWithTools(text, printableOverride, allowedTools)
```

这个函数承担 TUI 到 Runner 的桥接。

第一步是检查 provider 是否存在。

第二步触发 `UserPromptSubmit` Hook。如果 Hook 阻断，则将错误写入 transcript，不启动 Runner。

第三步根据当前模式构造 `agent.Request`。Plan Mode 会生成 `ModePlan` 请求，普通输入生成 `ModeChat` 请求。

第四步创建 context 和 cancel function，刷新 runner 依赖：

```go
m.runner.Provider = m.provider
m.runner.Registry = m.registry
m.runner.Env = env
m.runner.Permission = m.permissionEngine
m.runner.Compact = m.compactRuntime
m.runner.Instructions = m.instructions
m.runner.Memory = m.memory
m.runner.AllowedTools = append([]string(nil), allowedTools...)
m.runner.Hooks = m.hookEngine
m.runner.HookPrompts = m.hookPrompts
m.runner.SessionID = m.sessionCtx.ID
m.runner.CWD = m.effectiveCWD()
```

第五步启动 runner：

```go
events := bridgeAgentEvents(m.runner.Run(ctx, req))
m.events = events
```

第六步调用 `refreshAgentHandle(req)`，把当前 runner snapshot 暴露给 Agent 工具。这样子 Agent 可以基于当前 provider、registry、conversation、permission mode 和工作目录派生。

最后，TUI 进入 `stateStreaming`，并返回等待 Agent 事件和 spinner tick 的命令。

## 事件消费

Runner 的输出由 `handleAgentEvent` 消费。

`EventProgress` 更新进度文字，compact 相关进度会额外写入 transcript。

`EventTextDelta` 累加当前回复，使 TUI 可以流式显示。

`EventUsage` 更新 token usage。

`EventToolCallStart` 记录当前工具名和开始时间。

`EventToolResult` 将工具结果写入 transcript，并在 `install_skill` 成功后重新加载 Skill。

`EventApproval` 切换到 `stateApproving`。

`EventStop` 调用 `finishAgentRun` 收束本轮运行。

TUI 不需要知道工具执行细节，也不需要知道 provider 如何产生 tool call。它只根据事件更新界面状态。

## 审批状态

权限审批是 TUI 和 Runner 之间的显式握手。`agent.ApprovalRequest` 包含：

```go
Respond chan permission.ApprovalDecision
```

Runner 在工具执行路径中发出 `EventApproval` 后等待这个 channel。TUI 收到审批事件后进入 `stateApproving`，用户可以选择：

```text
allow once
allow session
allow forever
deny once
```

`finishApproval` 会把决策写入 `Respond` channel，Runner 随后继续执行或返回拒绝结果。

这种设计比在工具内部直接读取 stdin 更可靠。审批是 UI 状态，不是工具逻辑；工具执行只等待一个明确的决策结果。

## Slash Command

slash command 由 `internal/command` 管理。

`command.Registry` 维护命令列表、别名索引、可见命令和补全。命令名必须以 `/` 开头，注册时会检查重名和 alias 冲突。

TUI 的入口是：

```go
func (m Model) dispatchInput(text string) (Model, tea.Cmd, bool) {
    adapter := &commandAdapter{model: &m}
    result := command.Dispatch(m.commandRegistry, text, adapter)
    ...
}
```

`command.Dispatch` 的规则清晰：

- 空输入视为已处理。
- 非 slash 输入返回 `Handled=false`，交给 Agent。
- 未知 slash command 显示帮助。
- 不允许参数的命令若收到参数，显示 usage 错误。
- UI、Prompt、Skill 类命令要求 TUI 处于 idle。
- 命令 handler 通过 `Controller` 接口操作 TUI，而不是直接依赖 `tui.Model`。

这种设计把命令解析、命令注册和 TUI 状态更新分开。新增命令时，优先进入 `internal/command`，再通过 adapter 映射到 TUI 行为。

## 手动 Compact

手动 compact 由 TUI 发起：

```go
startManualCompact()
```

它会检查 provider 和 compact runtime，触发 `PreCompact` Hook，进入 streaming 状态，然后调用：

```go
compact.ForceCompact(ctx, compact.ManageInput{
    Conversation: m.conv,
    Runtime:      m.compactRuntime,
    Provider:     m.provider,
    Trigger:      compact.TriggerManual,
})
```

完成后触发 `PostCompact` Hook，并把 before/after token 估算写入 transcript。

手动 compact 和 Runner 自动 compact 使用同一套 compact runtime，差异在于触发位置：手动 compact 来自 TUI 命令，自动 compact 发生在 Runner 每轮模型请求前。

## Team Wake

TUI 还承担 Lead 自动唤醒逻辑。`Init` 中如果存在 team manager，会注册 `waitForTeamWake()`。每隔固定时间触发 `teamWakeMsg` 后，如果 TUI idle 且 Lead 有未读消息，会提交一条预设 prompt：

```go
Process unread team updates and continue coordinating the team.
```

这说明 Team 协作并没有绕过主 Agent。Lead 收到成员更新后，仍然通过 TUI -> Runner -> model request 的主链路继续处理。

## 小结

PseudoClaude 的 TUI 不是展示层附属品，而是本地 Agent 的交互状态机。它管理 provider 选择、输入提交、事件消费、权限审批、会话恢复、手动 compact、slash command 和 Team 唤醒。

工程上最重要的边界是：TUI 不执行工具，Runner 不渲染界面，命令系统不直接持有 UI 结构。三者通过 `agent.Event`、`command.Controller` 和 Bubble Tea message 连接。这种分层让终端交互保持可维护，也让 Agent 执行逻辑能够被后台任务和子 Agent 复用。
