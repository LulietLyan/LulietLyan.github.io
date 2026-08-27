---
title: 交互审批：Ask 如何往返 Agent 与 TUI
description: How PseudoClaude turns an Ask decision into a blocking Agent-to-TUI approval round trip and returns scoped authorization to tool execution.
date: 2026-08-28
order: 17
tags:
  - PseudoClaude
  - Permission
  - TUI
  - Go
---

Permission Engine 的 `Allow` 和 `Deny` 都能在当前 goroutine 内立即完成，`Ask` 则需要把一次 Tool Call 暂停下来，等待 Bubble Tea 中的用户决定。这里不能只弹一个提示框：Agent 执行循环、TUI 状态机、取消信号和授权持久化必须共享同一笔请求，响应后还要回到原来的 ReAct 轮次。

PseudoClaude 用 `EventApproval` 将请求从 Agent 送到 TUI，再用 `ApprovalRequest.Respond` channel 把决定送回等待中的执行函数。它是一条进程内人在回路链路，不依赖轮询或全局变量。

## 先把可能交互的调用串行化

一次模型响应可以同时返回多个 Tool Call。明确允许的只读调用可以并发，但副作用、未知工具，以及预检查结果为 Ask 的只读调用会进入单项串行 Batch：

```go
func splitToolBatches(
    registry *tools.Registry,
    calls []llm.ToolCall,
    opts toolExecutionOptions,
    engine *permission.Engine,
    mode permission.Mode,
) []toolBatch {
    var batches []toolBatch
    var readonly []indexedToolCall
    flushReadonly := func() {
        if len(readonly) == 0 {
            return
        }
        batches = append(batches, toolBatch{
            concurrent: true,
            items:      readonly,
        })
        readonly = nil
    }
    for i, call := range calls {
        safety, known := registry.Safety(call.Name)
        if shouldRunSerialForPermission(engine, mode, call, safety, known) ||
            (known && !opts.allows(safety)) {
            flushReadonly()
            batches = append(batches, toolBatch{
                items: []indexedToolCall{{index: i, call: call}},
            })
            continue
        }
        if known && safety == tools.SafetyReadOnly {
            readonly = append(readonly, indexedToolCall{index: i, call: call})
            continue
        }
        flushReadonly()
        batches = append(batches, toolBatch{
            items: []indexedToolCall{{index: i, call: call}},
        })
    }
    flushReadonly()
    return batches
}
```

这避免界面同时出现多个副作用审批，也保证前一项执行结果不会与后一项审批交错。代价是副作用调用即使已经被 Rule 自动 Allow，也不会并发；当前实现优先选择可预测的顺序，而不是最大吞吐量。

预检查由 `shouldRunSerialForPermission` 调用 `Engine.Check`，使用 Engine 根目录；真正执行前则用 `CheckWithContext` 和本次 `Env.CWD` 再判断。Worktree CWD 与 Engine 根不同时，两次判断可能不完全一致，因此“预检查没有 Ask”不等于执行阶段一定不需要审批。

## Allow、Deny、Ask 在同一个执行入口分流

每个 Tool Call 先经过 PreToolUse Hook，再进入 `permissionCheckedTool`。Permission Engine 返回三态后，只有 Allow 立即执行，Deny 转成结构化失败，Ask 才进入审批：

```go
check := engine.CheckWithContext(
    mode,
    call,
    safety,
    permission.CheckContext{CWD: env.CWD},
)
switch check.Decision {
case permission.DecisionAllow:
    return executeAllowedTool(ctx, registry, env, call, opts)
case permission.DecisionDeny:
    return permissionDeniedResult(call, check)
case permission.DecisionAsk:
    if opts.Sub.DontAsk {
        return executeAllowedTool(ctx, registry, env, call, opts)
    }
    dispatchNotificationHook(ctx, hooks, "approval", summarizeCall(call))
    decision, err := requestApproval(
        ctx, call, check, events, iteration, opts.Sub,
    )
    if err != nil {
        return tools.Failure(
            call.Name,
            "permission_canceled",
            err.Error(),
            permissionMetadata(call, check),
        )
    }
    // 继续处理四种用户决定
}
```

审批不是 Rule 之外的另一套风险判断。界面直接拿到原始 `CheckResult`，其中包含决策来源、理由、命中 Rule、Category、Target 和 CWD；展示和最终错误因此都能追溯 Engine 为什么提出询问。

受保护的 System Tool 是例外：它们属于 Agent 控制面，在普通 Permission Rule 之前直接进入 `executeAllowedTool`。这不会跳过当前 Mode/Skill 的执行白名单复检，但项目 Rule 无法拦截这类控制面 Tool。

## ApprovalRequest 同时携带展示信息和响应通道

Agent 为一次 Ask 构造独立请求，基础命令和文件 Tool 会生成易读 Summary，其他 Tool 则回退到最多 160 个字符的 Arguments：

```go
type ApprovalRequest struct {
    Call        llm.ToolCall
    Summary     string
    Reason      string
    Result      permission.CheckResult
    SourceLabel string
    Respond     chan permission.ApprovalDecision
}

func requestApproval(
    ctx context.Context,
    call llm.ToolCall,
    result permission.CheckResult,
    events chan<- Event,
    iteration int,
    sub SubRunOptions,
) (permission.ApprovalDecision, error) {
    req := &ApprovalRequest{
        Call:        call,
        Summary:     summarizeCall(call),
        Reason:      result.Reason,
        Result:      result,
        SourceLabel: sub.label(),
        Respond:     make(chan permission.ApprovalDecision, 1),
    }
    if sub.ApprovalUpgrader != nil {
        return sub.ApprovalUpgrader(ctx, *req)
    }
    if !sendEvent(ctx, events, Event{
        Type:       EventApproval,
        Iteration:  iteration,
        Source:     sub.label(),
        ToolCall:   &call,
        Approval:   req,
    }) {
        if ctx.Err() != nil {
            return permission.ApprovalDenyOnce, ctx.Err()
        }
        return permission.ApprovalDenyOnce, context.Canceled
    }
    select {
    case decision := <-req.Respond:
        return decision, nil
    case <-ctx.Done():
        return permission.ApprovalDenyOnce, ctx.Err()
    }
}
```

`Respond` 是容量为 1 的 channel。Agent 发出 Event 后阻塞等待，但 Bubble Tea 的 Update 循环仍在运行，可以重绘界面和接收键盘。Context 取消与用户响应参加同一个 `select`，避免退出会话后遗留永久等待的 goroutine。

`ApprovalUpgrader` 为嵌套运行提供把请求升级到父界面的入口；普通主 Agent 没有 Upgrader，直接走 Event channel。

## Bubble Tea 把流式状态切换为审批状态

TUI 收到 Event 时不继续订阅下一个 Agent Event，而是保存请求并切换到 `stateApproving`：

```go
case agent.EventApproval:
    if event.Approval != nil {
        m.pendingApproval = event.Approval
        m.approvalCursor = 0
        m.state = stateApproving
        return m, nil
    }
    return m, waitForAgentEvent(m.events)
```

界面显示 Tool、Target、Reason 和可选的 SubAgent Source，并提供四项决定：

```go
var approvalChoices = []approvalChoice{
    {"1 Allow once", permission.ApprovalAllowOnce},
    {"2 Allow session", permission.ApprovalAllowSession},
    {"3 Allow forever", permission.ApprovalAllowForever},
    {"4 Deny once", permission.ApprovalDenyOnce},
}

func (m Model) finishApproval(
    decision permission.ApprovalDecision,
) (tea.Model, tea.Cmd) {
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

数字键可以直接决定，上下键选择后按 Enter 也可以。完成时 TUI 清理 pending 状态，恢复 Streaming，再用 Tea Cmd 向 `Respond` 发送决定并重新等待 Agent Event。channel 发送使用非阻塞 `select`，防止请求已经因 Context 取消而让 UI 卡住。

## 四种决定怎样改变执行

响应回到 `permissionCheckedTool` 后按授权范围处理：

```go
switch decision {
case permission.ApprovalAllowOnce:
    return executeAllowedTool(ctx, registry, env, call, opts)
case permission.ApprovalAllowSession:
    if err := engine.AllowForSession(call); err != nil {
        return tools.Failure(call.Name, "permission_error", err.Error(),
            permissionMetadata(call, check))
    }
    return executeAllowedTool(ctx, registry, env, call, opts)
case permission.ApprovalAllowForever:
    if err := engine.PersistLocalAllow(call); err != nil {
        return tools.Failure(call.Name, "permission_error", err.Error(),
            permissionMetadata(call, check))
    }
    return executeAllowedTool(ctx, registry, env, call, opts)
default:
    check.Source = "user"
    check.Reason = "user denied this tool call"
    return permissionDeniedResult(call, check)
}
```

Allow Once 不改变 Engine；Allow Session 先加入内存 Session Rule；Allow Forever 先写项目 Local YAML。只有规则更新成功才执行当前 Tool，持久化失败不会降级成一次授权。Deny Once 不新增 Deny Rule，当前界面也没有 Session Deny 或 Forever Deny 选项。

## 拒绝和取消仍回到模型

审批拒绝生成 `permission_denied`，取消等待生成 `permission_canceled`。`executeOneTool` 仍会派发 PostToolUse、ToolResult 和 ToolCallDone；Runner 随后把统一 JSON Result 加进 Conversation，下一轮模型可以解释拒绝、改用只读工具或缩小目标。

按 Esc 时 TUI 同时取消流并尝试发送 Deny Once。由于 Context 取消和 channel 响应存在竞争，等待方可能先得到 `ctx.Err()`，这时结果是 `permission_canceled`，而不是稳定保证为 `permission_denied`；整个 Run 随后也会停止。

## 子 Agent 的 DontAsk 是当前安全缺口

前台子 Agent、后台 Agent 和进程内 Team Member 都会设置 `DontAsk: true`。在当前分支顺序中，只要 Engine 返回 Ask，就直接进入 `executeAllowedTool`，不会调用后面配置的 `ApprovalUpgrader`：

```go
case permission.DecisionAsk:
    if opts.Sub.DontAsk {
        return executeAllowedTool(ctx, registry, env, call, opts)
    }
    decision, err := requestApproval(
        ctx, call, check, events, iteration, opts.Sub,
    )
```

现有测试 `TestAgentToolSubagentRunsWriteAfterAgentApproval` 明确期待子 Agent 写入不再二次询问。这可以理解为把启动 Agent Tool 的批准扩展为对子任务内部 Ask 的委托，但授权范围没有绑定到某个具体命令或路径；在 Bypass 或其他无需批准就启动子 Agent 的场景里，边界更宽。

黑名单、工作区沙箱和显式 Deny 在产生 Ask 之前已经返回，所以仍然有效；Plan/Skill 的 `AllowedSafety` 和 `AllowedNames` 也会在 `executeAllowedTool` 中继续复检。问题准确地说是：子 Agent 会自动通过 Permission Engine 的 Ask，不是完全绕过所有检查。

此外，因为 `DontAsk` 的判断早于 `requestApproval`，当前这些 `DontAsk` 子运行配置的 `ApprovalUpgrader` 对 Ask 实际不可达。若产品目标是由父 TUI 对子 Agent 的新目标逐项升级审批，应调整分支顺序，或把父授权编译成范围明确的临时 Rule，而不是把 Ask 统一视为 Allow。

## 完整往返

```text
模型返回 ToolCall
  -> Tool Batch 判断是否需要串行
  -> PreToolUse Hook
  -> Permission Engine: Allow / Deny / Ask
  -> Ask: 构造 ApprovalRequest + Respond channel
  -> EventApproval 写入 Agent event channel
  -> Agent goroutine 等待 response 或 context cancel
  -> Bubble Tea 保存 pendingApproval，进入 stateApproving
  -> 用户选择 once / session / forever / deny
  -> Tea Cmd 写回 Respond，界面恢复 stateStreaming
  -> 可持久授权先更新 Engine
  -> executeAllowedTool 或 permission_denied
  -> PostToolUse + ToolResult 事件
  -> Result 写回 Conversation，继续 ReAct
```

## 测试验证了什么

Agent 测试覆盖 Allow Once、Deny Once、Session、Forever、Context 取消，以及持久授权后当前调用执行；TUI 测试覆盖进入审批状态、光标移动、数字键选择、状态恢复和 channel 响应。子 Agent 测试同时证明 Ask 写操作会在 `DontAsk` 下直接执行，而黑名单 Deny 仍然生效。

现有测试没有覆盖多个并发只读调用在真实 CWD 下同时转为 Ask、Esc 的取消/拒绝竞争、MCP Session/Forever 授权失败后的界面表达，以及父 Upgrader 在 `DontAsk` 分支中的可达性。

## 小结

PseudoClaude 没有把审批做成 TUI 内部的临时弹窗，而是让 Ask 成为 Agent 执行协议的一部分：请求事件向外发送、goroutine 等待、响应 channel 返回，最后仍收敛成统一 Tool Result。这样一次授权可以明确选择执行范围，取消也能沿 Context 退出。

下一篇回到 Plan Mode，分析只读边界为什么既要减少模型能看到的 Tool Definition，也要在真实执行入口按 Safety 再拒绝一次。
