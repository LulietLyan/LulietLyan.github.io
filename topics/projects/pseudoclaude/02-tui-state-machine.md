---
title: Bubble Tea 状态机：TUI 如何驱动 Agent 交互
description: How PseudoClaude turns user input, runner events, streaming output, and permission approvals into a Bubble Tea terminal state machine.
date: 2026-08-21
order: 2
tags:
  - PseudoClaude
  - Bubble Tea
  - TUI
  - Go
---

PseudoClaude 的 TUI 负责构建用户与 Agent 之间的交互协议，例如 **当前能接收什么输入**、**后台任务是否仍在运行**、**流式文本如何显示**、**何时暂停等待审批**，以及 **任务结束后如何回到可输入状态** 等。

这类界面如果只用几个布尔值控制，很快会出现互相矛盾的组合，例如“既在流式输出又允许提交新输入”等比较复杂的情况下会产生冲突。因此，项目把主交互阶段定义为有限状态。

## 五种互斥状态

`internal/tui/tui.go` 中的 `sessionState` 定义了界面状态的相关常量：

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

它们分别表示：

| 状态 | TUI 正在处理的事情 | 主要输入 |
| --- | --- | --- |
| `stateSelecting` | 从多个 Provider 中选择一个 | 列表按键 |
| `stateIdle` | 编辑并提交用户输入 | 文本框、Slash Command |
| `stateStreaming` | 等待并展示 Runner 事件 | Agent Event、取消键 |
| `stateApproving` | 等待用户决定一次工具调用 | 审批选项 |
| `stateResuming` | 选择要恢复的历史会话 | 会话列表按键 |

Bubble Tea 的 `Update` 先处理窗口变化、滚动、退出等全局消息，再根据当前状态把消息交给专用函数：

```go
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    if m.initErr != nil {
        return m, tea.Quit
    }

    // 省略 task、team、resize、mouse 和全局按键处理。

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
}
```

设置不同的状态转移的作用不是减少代码行数，而是把输入语义固定下来。例如，`enter` 在 Idle 中表示提交消息，但在 `Approving` 中表示确认选项，而在 `Selecting` 中又表示选择 Provider（Provider 即选择对应 LLM 服务的提供商，在本项目中包含 OpenAI 和 Anthropic）；各状态不需要共享一套复杂条件判断。

## 从 Enter 到 Runner

Idle 状态先区分本地命令和普通用户输入：

```go
if msg.String() == "enter" {
    text := strings.TrimSpace(m.textarea.Value())
    if text == "" {
        return m, nil
    }
    if next, cmd, handled := m.dispatchInput(text); handled {
        return next, cmd
    }
    return m.submitUserText(text)
}
```

Slash Command 可以完全在 TUI 内完成，例如打开帮助或切换某种本地状态；只有普通输入才会进入 Agent。真正提交前，`submitAgentTextWithTools` 会把本轮可能变化的依赖写回 Runner：

```go
m.runner.Provider = m.provider
m.runner.Registry = m.registry
env := m.toolEnv
env.CWD = m.effectiveCWD()
m.runner.Env = env
m.runner.Permission = m.permissionEngine
m.runner.Compact = m.compactRuntime
m.runner.Instructions = m.instructions
m.runner.Memory = m.memory
m.runner.AllowedTools = append([]string(nil), allowedTools...)
m.runner.Hooks = m.hookEngine
m.runner.SessionID = m.sessionCtx.ID
m.runner.CWD = m.effectiveCWD()

events := bridgeAgentEvents(m.runner.Run(ctx, req))
m.events = events
m.state = stateStreaming
```

这里每次提交都重新设置 CWD、权限模式相关依赖和允许的工具，是因为会话期间可能切换 Worktree、Skill 或 Provider。把这些值固定在 `tui.New` 时会让 Runner 使用过期环境。

状态变化后的执行流程是：

```text
Idle
  -> Enter
  -> dispatchInput
  -> submitAgentTextWithTools
  -> Runner.Run
  -> Streaming
```

TUI 不同步等待 `Runner.Run` 返回最终字符串。Runner 返回的是只读事件通道，Bubble Tea Command 每次从中取一个事件，再把事件送回 `Update`。

## Channel 如何进入 Bubble Tea

普通 Go channel 不能直接作为 Bubble Tea Message 使用，所以 TUI 用一个 Command 等待下一条事件：

```go
func waitForAgentEvent(ch <-chan agent.Event) tea.Cmd {
    return func() tea.Msg {
        event, ok := <-ch
        if !ok {
            return agentMsg{
                Type: agent.EventStop,
                Stop: &agent.Stop{Reason: agent.StopCompleted, Message: "completed"},
            }
        }
        return agentMsg(event)
    }
}
```

每消费一条非终止事件，`handleAgentEvent` 都会再次返回 `waitForAgentEvent(m.events)`，因此形成“取一条、更新一次、再取下一条”的节奏。这符合 Bubble Tea 的消息循环，而不是在 `Update` 里阻塞读取整个流。

channel 意外关闭时，TUI 将其归一为 `EventStop`。这样界面不会永远停在 Streaming 状态，但这条保底路径也意味着真正的异常应该由 Runner 在关闭前先发送 `EventError` 或带原因的 `EventStop`。

## Event 如何改变界面

`agent.Event` 同时承载文本、工具、Usage、审批和停止信息。TUI 只按事件类型更新显示状态：

```go
switch event.Type {
case agent.EventTextDelta:
    m.curReply += event.Text
    return m, waitForAgentEvent(m.events)
case agent.EventToolCallStart:
    if event.ToolCall != nil {
        m.curTool = &toolStatus{call: *event.ToolCall, started: time.Now()}
    }
    return m, waitForAgentEvent(m.events)
case agent.EventToolResult:
    if event.ToolResult != nil {
        result := event.ToolResult.Result
        // 省略 curTool 更新和 install_skill 成功后的目录重载。
        m.appendTranscript(transcriptEntry{
            kind: transcriptTool, result: result, elapsed: event.ToolResult.Elapsed,
        })
    }
    return m, waitForAgentEvent(m.events)
case agent.EventApproval:
    if event.Approval != nil {
        m.pendingApproval = event.Approval
        m.approvalCursor = 0
        m.state = stateApproving
        return m, nil
    }
case agent.EventStop:
    return m.finishAgentRun(event)
}
```

Text Delta 只追加到 `curReply`，最终 Stop 到达时才把完整回复加入 transcript。工具开始和结果则更新 `curTool` 与工具记录。界面因此可以同时显示当前流式文本、正在执行的工具以及已经完成的工具结果，而不需要知道 Provider 或 Registry 的内部实现。

## 审批是一次暂停与恢复

权限引擎返回 `ask` 时，Runner 发出带 `Respond` channel 的 `EventApproval`。TUI 收到它后停止继续订阅 Agent Event，进入 Approving 状态。用户完成选择后，TUI 将结果写回原请求并恢复 Streaming：

```go
func (m Model) finishApproval(decision permission.ApprovalDecision) (tea.Model, tea.Cmd) {
    req := m.pendingApproval
    m.pendingApproval = nil
    m.approvalCursor = 0
    m.state = stateStreaming

    var cmds []tea.Cmd
    if req != nil {
        cmds = append(cmds, sendApprovalDecision(req, decision))
    }
    cmds = append(cmds, waitForAgentEvent(m.events), m.spinner.Tick)
    return m, tea.Batch(cmds...)
}
```

完整状态迁移为：

```text
Streaming
  -> EventApproval
  -> Approving
  -> user decision
  -> Respond <- decision
  -> Streaming
```

审批界面和权限决策因此没有互相调用。Runner 只发请求并等待 response，TUI 只展示选项并返回选择；具体规则匹配仍属于 Permission 模块。

## 停止与取消边界

正常 Stop 会调用 `finishAgentRun`，记录最后回复和停止原因，再回到 Idle。用户在 Streaming 状态按 `esc` 时，TUI 调用保存的 `cancel`，清空当前工具状态并记录 `StopCanceled`。

测试对这些迁移进行了直接约束：连续 Text Delta 必须拼成完整回复；收到 Stop 后必须回到 Idle；Approval 必须进入 Approving，提交选择后必须回到 Streaming。这里测试的不是终端颜色，而是交互协议不会卡死或越过审批。

## 小结

PseudoClaude 的 TUI 本质上是一个事件驱动状态机。它在用户输入时启动 Runner，在执行期间把 Event 还原为界面状态，并在审批或取消时完成双向协调；模型请求和工具调用本身不在这一层实现。

下一篇将越过这条事件边界，进入 Runner 内部，说明一次用户输入为什么可能触发多轮模型请求。
