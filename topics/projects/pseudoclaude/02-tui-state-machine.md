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

Bubble Tea 的 `Update` 是 Bubble Tea 的统一事件入口：每次收到键盘、鼠标、窗口或后台任务消息都会走这里。先处理窗口变化、滚动、退出等全局消息，再根据当前状态把消息交给专用函数：

```go
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    // 构造 Model 时如果已经发生初始化错误，就不再响应任何事件，直接退出程序。
	// 继续分发消息只会让一个不完整的 Model 进入后续逻辑，可能引发更多错误。
    if m.initErr != nil {
        return m, tea.Quit
    }

    // 省略 task、team、resize、mouse 和全局按键处理。
    // 这些状态会更优先得到处理，因为它们不依赖当前页面的全局状态，应该得到优先响应。
    // 但是这些步骤并不在当前讨论范围内


    // 全局消息和快捷键都没有提前返回时，再按当前会话状态分发消息。
	// 每个 updateXxx 只负责一种界面状态，避免把所有按键和异步事件混在这个总入口里。
    switch m.state {
	case stateSelecting:
		// provider 选择阶段：把消息交给 provider 列表，例如上下移动和回车确认。
		return m.updateSelecting(msg)
	case stateStreaming:
		// Agent 工作阶段：处理流式文本、工具调用、停止事件和加载动画。
		return m.updateStreaming(msg)
	case stateApproving:
		// 工具审批阶段：处理允许、拒绝以及审批选项移动。
		return m.updateApproving(msg)
	case stateResuming:
		// 历史会话恢复阶段：处理会话选择、确认或取消。
		return m.updateResuming(msg)
	default:
		// 其余情况按空闲状态处理：编辑输入、提交消息、执行命令或接收压缩结果。
		return m.updateIdle(msg)
	}
}
```

设置不同的状态转移的作用不是减少代码行数，而是把输入语义固定下来。例如，`enter` 在 Idle 中表示提交消息，但在 `Approving` 中表示确认选项，而在 `Selecting` 中又表示选择 Provider（Provider 即选择对应 LLM 服务的提供商，在本项目中包含 OpenAI 和 Anthropic）；各状态不需要共享一套复杂条件判断。

## 从 Enter 到 Runner

Idle 状态先区分本地命令和普通用户输入：

```go
// updateIdle 处理“等待用户输入”状态下的消息。
// 它先拦截补全和空闲态快捷键，再把普通输入交给 textarea 组件。
func (m Model) updateIdle(msg tea.Msg) (tea.Model, tea.Cmd) {
	// 先按消息类型处理需要优先响应的事件。
	// 当前主要关心键盘输入，以及异步上下文压缩返回的结果。
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		// 让命令补全菜单处理按键。
		// 例如补全菜单打开时，方向键用于移动候选项，Enter 用于选中候选项；
		// 如果这里不优先处理，Enter 会被下面的提交逻辑误认为用户要发送消息。
		if next, cmd, ok := m.handleCompletionKey(msg); ok {
			return next, cmd
		}

		// Shift+Tab 在不同权限模式之间循环切换。
		// 切换结果写入 transcript，让用户能够看到下一次请求将使用哪种权限模式。
		if msg.String() == "shift+tab" {
			m.permissionMode = permission.NextMode(m.permissionMode)
			m.appendTranscript(transcriptEntry{kind: transcriptStatus, text: "Permission mode: " + m.permissionMode.String()})
			return m, nil
		}

		// Enter 表示提交当前输入框内容。
		if msg.String() == "enter" {
			// 去掉首尾空白，避免把只有空格或换行的内容当成一条有效消息。
			text := strings.TrimSpace(m.textarea.Value())
			if text == "" {
				return m, nil
			}

			// 先尝试把输入解释成内置命令，例如 /help、/status 或 /compact。
			// handled 为 true 表示命令系统已经消费该输入，此时不能再把它发送给 Agent。
			if next, cmd, handled := m.dispatchInput(text); handled {
				return next, cmd
			}

			// 输入不是命令，按普通用户消息提交，开始一轮 Agent 流式响应。
			return m.submitUserText(text)
		}
	case compactMsg:
		// 接收异步上下文压缩结果，并清理压缩期间显示的临时 UI 状态。
		// 无论成功还是失败，都要回到空闲状态并清空输入框，准备下一次输入。
		m.progress = ""
		m.state = stateIdle
		m.textarea.Reset()
		if msg.err != nil {
			// 压缩失败时把原因显示为错误消息，并把焦点还给输入框。
			m.appendTranscript(transcriptEntry{kind: transcriptError, text: "压缩失败: " + msg.err.Error()})
			return m, m.textarea.Focus()
		}
		// 压缩成功时展示压缩前后的估算 token 数，便于确认释放了多少上下文空间。
		m.appendTranscript(transcriptEntry{kind: transcriptStatus, text: fmt.Sprintf("上下文已压缩：estimated tokens %d -> %d", msg.output.BeforeTokens, msg.output.AfterTokens)})
		return m, m.textarea.Focus()
	}

	// 前面的特殊分支都没有消费消息时，把它交给 textarea 的默认更新逻辑。
	// 普通字符、删除键、光标移动以及 textarea 自身的内部消息都在这里处理。
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)

	// textarea 更新后，再根据最新输入重新计算斜杠命令补全候选。
	// 顺序不能反过来，否则候选列表会比输入框内容慢一个按键。
	m = m.updateCompletionFromInput()

	// 返回更新后的 Model，以及 textarea 产生的后续命令（例如光标闪烁）。
	return m, cmd
}
```

Slash Command 可以完全在 TUI 内完成，例如打开帮助或切换某种本地状态；只有普通输入才会进入 Agent。真正提交前，上述方法中的按下 Enter 后调用的 `submitUserText` 实际上会走到调用 `submitAgentTextWithTools` 把本轮可能变化的依赖写回 Runner：

```go
// submitAgentTextWithTools 把一条普通输入正式提交给 Agent，并把 TUI 切换到流式输出状态。
// allowedTools 只在 Skill 等受限调用中使用；普通聊天传 nil，表示不额外设置工具白名单。
func (m Model) submitAgentTextWithTools(text, printableOverride string, allowedTools []string) (tea.Model, tea.Cmd) {
	// 没有模型 provider 就无法发起请求，保留当前空闲状态并把原因显示给用户。
	if m.provider == nil {
		m.appendTranscript(transcriptEntry{kind: transcriptError, text: "provider 尚未初始化"})
		return m, nil
	}

	// 提交前执行 UserPromptSubmit Hook。
	// Hook 可以阻止本次提交，也可以注入只供 Agent 使用的附加提示词。
	if m.hookEngine != nil {
		result := m.hookEngine.Dispatch(context.Background(), hook.EventUserPromptSubmit, m.hookPayload(hook.EventUserPromptSubmit).With("prompt", text))
		if result.Blocked {
			// 被 Hook 拦截后不创建 Runner，也不把输入写入对话，仍停留在空闲状态。
			m.appendTranscript(transcriptEntry{kind: transcriptError, text: hookBlockedMessage(result)})
			return m, nil
		}
		// 注入内容进入队列，Runner 会在构造本轮提示词时读取它们。
		m.hookPrompts.Add(result.InjectedPrompts...)
	}

	// 把文本转换成 Agent Request。
	// requestForInput 会带上当前对话、Plan/Chat 模式以及本轮权限模式。
	req, printable, err := m.requestForInput(text)
	if err != nil {
		m.appendTranscript(transcriptEntry{kind: transcriptError, text: err.Error()})
		return m, nil
	}
	// printable 是 transcript 中给用户看的文本；预设命令或 Skill 可以用较短标签替代真实提示词。
	if strings.TrimSpace(printableOverride) != "" {
		printable = printableOverride
	}

	// 为本轮执行创建独立的取消上下文。
	// m.cancel 会被 Esc、Ctrl+C 等中断操作调用，从而停止正在运行的 Agent。
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel

	// 在真正启动前，把 TUI 中可能变化的依赖重新写入 Runner。
	// 这些值不能只在 New 时固定，因为会话期间可能恢复会话、切换 Worktree、重载 Skill 或更换运行配置。
	// Provider 和 Registry 分别决定调用哪个模型，以及本轮有哪些工具可供 Runner 查找。
	m.runner.Provider = m.provider
	m.runner.Registry = m.registry
	// 复制工具环境后再覆盖有效目录，避免直接修改 m.toolEnv；effectiveCWD 会反映当前 Worktree。
	env := m.toolEnv
	env.CWD = m.effectiveCWD()
	m.runner.Env = env
	// Permission 是执行工具时使用的权限引擎；本轮具体权限模式已经放在上面的 req 中。
	m.runner.Permission = m.permissionEngine
	// Compact、Instructions 和 Memory 共同提供当前会话的上下文压缩、持久指令与长期记忆。
	m.runner.Compact = m.compactRuntime
	m.runner.Instructions = m.instructions
	m.runner.Memory = m.memory
	// 复制工具白名单，避免调用方之后修改原切片，导致正在运行的 Runner 权限范围意外变化。
	m.runner.AllowedTools = append([]string(nil), allowedTools...)
	// Hooks 和 HookPrompts 让 Runner 执行生命周期 Hook，并消费提交阶段注入的提示词。
	m.runner.Hooks = m.hookEngine
	m.runner.HookPrompts = m.hookPrompts
	// SessionID 与 CWD 供 Hook、工具和会话记录识别当前执行环境。
	m.runner.SessionID = m.sessionCtx.ID
	m.runner.CWD = m.effectiveCWD()
	// Runner 在合适时机会调用 pendingReminders，把后台任务或团队通知注入本轮上下文。
	m.runner.Sub.PendingReminderFn = m.pendingReminders

	// Runner.Run 在后台 goroutine 中执行，并立即返回只读事件通道，不会同步等待最终回复。
	// bridgeAgentEvents 将它接入 TUI 的事件总线，随后保存到 m.events 供 Bubble Tea 逐条读取。
	events := bridgeAgentEvents(m.runner.Run(ctx, req))
	m.events = events

	// 保存当前 Runner 快照，供后续启动的子 Agent 继承本轮最新环境和权限设置。
	m.refreshAgentHandle(req)

	// 重置所有“单轮执行”状态，防止上一轮回复、工具、用量或停止原因残留到新界面。
	m.turnStart = time.Now()
	m.elapsed = 0
	m.curReply = ""
	m.curTool = nil
	m.progress = "starting"
	m.usage = nil
	m.lastStop = nil
	m.textarea.Reset()
	m.completion = completionState{}
	// 从这里开始，后续消息将由 Update 分发给 updateStreaming，而不再进入 updateIdle。
	m.state = stateStreaming
	// transcript 只显示 printable；真正发送给 Agent 的仍是 requestForInput 生成的 req。
	m.appendTranscript(transcriptEntry{kind: transcriptUser, text: printable})

	// 并行启动两个 Bubble Tea Command：一个等待首条 Agent 事件，一个驱动加载动画。
	// 每条 Agent 事件处理完后都会再次安排 waitForAgentEvent，直到收到 Stop 或通道关闭。
	return m, tea.Batch(
		waitForAgentEvent(m.events),
		m.spinner.Tick,
	)
}
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
// waitForAgentEvent 把“等待下一条 Runner 事件”包装成 Bubble Tea Command。
// Command 在 Bubble Tea 的更新循环之外阻塞读通道；读到事件后，Bubble Tea 会把返回的 agentMsg 再送进 Model.Update。
func waitForAgentEvent(ch <-chan agent.Event) tea.Cmd {
	return func() tea.Msg {
		// 每次只取一条事件，处理完成后由 handleAgentEvent 再返回一个新的 waitForAgentEvent，继续读取下一条。
		event, ok := <-ch
		if !ok {
			// Runner 关闭通道却没有显式 Stop 事件时，补一个 completed，保证 TUI 能结束 streaming 状态。
			return agentMsg{Type: agent.EventStop, Stop: &agent.Stop{Reason: agent.StopCompleted, Message: "completed"}}
		}
		return agentMsg(event)
	}
}
```

每消费一条非终止事件，`handleAgentEvent` 都会再次返回 `waitForAgentEvent(m.events)`，因此形成“取一条、更新一次、再取下一条”的节奏。这符合 Bubble Tea 的消息循环，而不是在 `Update` 里阻塞读取整个流。

channel 意外关闭时，TUI 将其归一为 `EventStop`。这样界面不会永远停在 Streaming 状态，但这条保底路径也意味着真正的异常应该由 Runner 在关闭前先发送 `EventError` 或带原因的 `EventStop`。

## Event 如何改变界面

`handleAgentEvent` 中的 `agent.Event` 同时承载文本、工具、Usage、审批和停止信息。TUI 只按事件类型更新显示状态：

```go
// handleAgentEvent 一次只消费一条 Runner 事件。
// 除审批和停止等需要暂停/结束的事件外，每个分支都会返回新的 waitForAgentEvent 来读取下一条。
func (m Model) handleAgentEvent(event agent.Event) (tea.Model, tea.Cmd) {
	// 每收到一条事件都刷新本轮耗时，流式文本、工具执行和审批界面会共用这个值。
	m.elapsed = time.Since(m.turnStart)
	switch event.Type {
	case agent.EventProgress:
		// Progress 是短暂的运行状态，例如“requesting model”或“starting tool batch”。
		m.progress = event.Message
		if isCompactProgress(event.Message) {
			// 普通进度只显示在当前状态栏；上下文压缩和结果落盘比较重要，需要额外保留在 transcript。
			m.appendTranscript(transcriptEntry{kind: transcriptStatus, text: event.Message})
		}
		// 当前事件处理完毕，继续订阅下一条 Runner 事件。
		return m, waitForAgentEvent(m.events)
	case agent.EventTextDelta:
		// 模型流式返回的文本片段依次拼到 curReply，View 会直接渲染它，因此用户可以实时看到回复。
		// 此时不写 transcript；等 Stop 到达后再一次性写入完整回复，避免产生许多碎片记录。
		m.curReply += event.Text
		return m, waitForAgentEvent(m.events)
	case agent.EventUsage:
		// Usage 可能包含输入、输出和缓存 token；复制一份后保存，供状态栏展示本轮用量。
		if event.Usage != nil {
			usage := *event.Usage
			m.usage = &usage
		}
		return m, waitForAgentEvent(m.events)
	case agent.EventAssistantText:
		// Runner 已把完整回复写入 Conversation，界面也已通过 TextDelta 累积文本，所以这里无需重复追加。
		return m, waitForAgentEvent(m.events)
	case agent.EventToolCallStart:
		// 工具开始执行时记录调用内容和开始时间，View 据此显示“当前正在运行的工具”。
		if event.ToolCall != nil {
			m.curTool = &toolStatus{call: *event.ToolCall, started: time.Now()}
		}
		return m, waitForAgentEvent(m.events)
	case agent.EventToolResult:
		// 工具完成后，同时更新当前工具状态并写入一条永久 transcript 记录。
		if event.ToolResult != nil {
			result := event.ToolResult.Result
			// 用 call ID 匹配开始与结果事件，避免把其他工具的结果挂到当前工具上。
			if m.curTool != nil && m.curTool.call.ID == event.ToolResult.Call.ID {
				m.curTool.result = &result
			}
			m.appendTranscript(transcriptEntry{kind: transcriptTool, result: result, elapsed: event.ToolResult.Elapsed})
			// install_skill 成功会改变本地 Skill 目录，立即重载后，新命令才能在当前会话中生效。
			if result.OK && result.Tool == "install_skill" {
				m.reloadSkills()
				m.appendTranscript(transcriptEntry{kind: transcriptStatus, text: "Skills reloaded."})
			}
			return m, waitForAgentEvent(m.events)
		}
		return m, waitForAgentEvent(m.events)
	case agent.EventToolCallDone:
		// ToolCallDone 用于通知调用阶段结束；可展示的详细结果已经由 ToolResult 分支记录。
		return m, waitForAgentEvent(m.events)
	case agent.EventApproval:
		// 权限引擎返回 ask 时，Runner 会携带 Respond channel 发出审批请求，并等待 TUI 回写决定。
		if event.Approval != nil {
			// 保存原请求，审批结束时必须使用同一个 Respond channel 把选择送回等待中的 Runner。
			m.pendingApproval = event.Approval
			m.approvalCursor = 0
			// 切换状态后，Update 会把按键交给 updateApproving，而不是 updateStreaming。
			m.state = stateApproving
			// 这里故意不返回 waitForAgentEvent：Runner 正阻塞等待审批，此时继续订阅没有意义。
			return m, nil
		}
		// 缺少请求内容的 Approval 无法展示或回复，忽略它并继续读取事件。
		return m, waitForAgentEvent(m.events)
	case agent.EventError:
		// 错误先写入 transcript，但仍继续订阅；Runner 随后会发 Stop，由统一收尾逻辑恢复空闲状态。
		if event.Err != nil {
			m.appendTranscript(transcriptEntry{kind: transcriptError, text: event.Err.Error()})
		}
		return m, waitForAgentEvent(m.events)
	case agent.EventStop:
		// Stop 是本轮执行的终点：提交完整回复、清理临时状态并回到 Idle。
		return m.finishAgentRun(event)
	default:
		// 未识别事件不改变界面，但也不能中断事件链，继续等待下一条。
		return m, waitForAgentEvent(m.events)
	}
}
```

Text Delta 只追加到 `curReply`，最终 Stop 到达时才把完整回复加入 transcript。工具开始和结果则更新 `curTool` 与工具记录。界面因此可以同时显示当前流式文本、正在执行的工具以及已经完成的工具结果，而不需要知道 Provider 或 Registry 的内部实现。

## 审批是一次暂停与恢复

权限引擎返回 `ask` 时，Runner 发出带 `Respond` channel 的 `EventApproval`。TUI 收到它后停止继续订阅 Agent Event，进入 Approving 状态。用户完成选择后，TUI 将结果写回原请求并恢复 Streaming：

```go
// finishApproval 把用户决定送回 Runner，并将 TUI 从审批状态恢复到流式状态。
func (m Model) finishApproval(decision permission.ApprovalDecision) (tea.Model, tea.Cmd) {
	// 先保存请求指针，再清空界面持有的审批状态，防止同一个请求被重复确认。
	req := m.pendingApproval
	m.pendingApproval = nil
	m.approvalCursor = 0
	// 从现在开始，Update 再次把异步事件交给 updateStreaming。
	m.state = stateStreaming
	var cmds []tea.Cmd
	if req != nil {
		// 通过 Bubble Tea Command 回写决定，避免在 Update 函数内部直接等待 channel。
		cmds = append(cmds, sendApprovalDecision(req, decision))
	}
	// 恢复下一条 Agent 事件的订阅，同时重新驱动 spinner；Runner 收到决定后会继续执行或返回拒绝结果。
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
