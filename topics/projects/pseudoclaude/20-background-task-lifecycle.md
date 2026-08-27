---
title: 任务生命周期：前台执行、超时转后台与完成通知
description: How PseudoClaude runs child agents in the foreground or as detached background tasks with status snapshots, cancellation, continuation, and TUI notifications.
date: 2026-08-28
order: 20
tags:
  - PseudoClaude
  - Multi-Agent
  - Task
  - Go
---

委派决定了子 Agent 拿到什么，Task 层决定它活多久、谁等待结果，以及完成后如何重新进入主对话。前台执行适合短任务，直接把最终文本作为 Agent Tool Result 返回；后台执行必须脱离当前 ToolCall 的等待，又要保留可查询、可取消和可继续的状态。

PseudoClaude 没有为两者实现两套 Runner。前台直接消费 `RunToCompletion`，后台则把同一个 Runner、Conversation 和 Prompt 交给 `task.Manager` 的 goroutine，并通过 Snapshot 和 DoneEvent 暴露状态。

## RunToCompletion 把事件流收敛成结果

Runner 原本输出 Agent Event channel。前台与后台都通过同一适配器收集最终文本、Token、Tool 数和停止原因：

```go
func (r Runner) RunToCompletion(
    ctx context.Context,
    in RunToCompletionInput,
) CompletionResult {
    req := in.Request
    if in.TaskText != "" {
        req.UserText = in.TaskText
    }
    events := r.Run(ctx, req)
    var result CompletionResult
    for event := range events {
        if in.Events != nil {
            in.Events <- event
        }
        switch event.Type {
        case EventAssistantText:
            result.Text = event.Text
        case EventUsage:
            if event.Usage != nil {
                result.Usage.InputTokens += event.Usage.InputTokens
                result.Usage.OutputTokens += event.Usage.OutputTokens
                result.Usage.TotalTokens += event.Usage.TotalTokens
                result.Usage.CacheWrite += event.Usage.CacheWrite
                result.Usage.CacheRead += event.Usage.CacheRead
            }
        case EventToolCallDone:
            if event.ToolCall != nil {
                result.ToolCount++
                result.LastTool = event.ToolCall.Name
            }
        case EventStop:
            if event.Stop != nil {
                result.Stop = *event.Stop
            }
        }
    }
    return result
}
```

它不另造执行循环，只把 ReAct Event 聚合为调用方需要的状态。若 Provider 多次发 `EventAssistantText`，结果保存最后一段完整 Assistant Text；Usage 则逐轮累加。

`StopOnMaxTurn` 字段当前没有在函数体使用。最大轮数仍由 Runner Config 或 `Sub.MaxTurns` 控制，不能把这个输入字段描述成已经生效的停止开关。

## 前台直接等待，超时后重新提交后台任务

Defined 子 Agent 默认走 `runForeground`：

```go
func runForeground(
    ctx context.Context,
    runner Runner,
    conv *conversation.Conversation,
    prompt string,
    timeout time.Duration,
) CompletionResult {
    if timeout > 0 {
        runCtx, cancel := context.WithTimeout(ctx, timeout)
        defer cancel()
        return runner.RunToCompletion(runCtx, RunToCompletionInput{
            Request:  Request{Conversation: conv},
            TaskText: prompt,
        })
    }
    return runner.RunToCompletion(ctx, RunToCompletionInput{
        Request:  Request{Conversation: conv},
        TaskText: prompt,
    })
}
```

没有 ForegroundTimeout 时，它与父 ToolCall 共用 Context。设置超时后，子 Run 收到 Deadline；若停止原因是 Canceled，Agent Tool 将同一个 Runner 和 Conversation 交给后台：

```go
result := runForeground(
    ctx, runner, childConv, args.Prompt,
    t.Background.ForegroundTimeout,
)
if result.Stop.Reason == StopCanceled &&
    t.Background.ForegroundTimeout > 0 {
    return t.launch(
        ctx, args, def, runner, childConv, false,
        "timed_out_to_background",
    )
}
return completionToolResult(def.Name, result)
```

这样短任务同步返回，长任务不会无限占住当前 Agent Tool。当前判断只看 `StopCanceled`，无法区分 ForegroundTimeout、用户取消或上游 Context 取消；只要 timeout 配置大于 0，这些取消都可能触发新的后台任务。

此外，前台 Run 已经把 Prompt 和部分事件写入 `childConv`，后台 `defaultRun` 又会用同一个 Prompt 调用同一 Conversation。超时发生在中途时，任务说明可能再次作为 User 消息出现。Worktree 路径还会清理第一次运行的 worktree，再为后台 Prepare 创建新的 worktree。这些是超时续跑当前采用“重启任务”而不是“迁移 goroutine”的代价。

## Launch 创建脱离父请求的 Task Context

后台入口先保存完整执行对象，再启动 goroutine：

```go
func (m *Manager) Launch(
    ctx context.Context,
    in LaunchInput,
) (string, error) {
    if in.Conversation == nil {
        in.Conversation = &conversation.Conversation{}
    }
    taskCtx, cancel := context.WithCancel(context.Background())
    id := in.ID
    if id == "" {
        id = m.idSource()
    }
    task := &BackgroundTask{
        ID:           id,
        Name:         in.Name,
        Type:         in.Type,
        Fork:         in.Fork,
        Status:       StatusRunning,
        Prompt:       in.Prompt,
        StartedAt:    time.Now(),
        Cancel:       cancel,
        Runner:       in.Runner,
        Conversation: in.Conversation,
        OnFinish:     in.OnFinish,
        LastActivity: "started",
    }
    // 名称去重并写入 tasks/byName
    go m.runTask(taskCtx, id, in.Prompt, in.Prepare, in.OnFinish)
    return id, nil
}
```

这里故意不用传入的 `ctx` 创建 child Context，而是从 `context.Background()` 开始。父 Agent 本轮结束或原 ToolCall 返回后，后台任务继续存在；只有 TaskStop 保存的 CancelFunc 能主动取消它。

这也意味着进程退出时没有持久化或优雅等待。Task map、Runner 和 Conversation 都只在内存中，重启 PseudoClaude 后普通后台 Task 不会恢复。`Options.AutoTimeout` 被存入 Manager，但当前没有读取点，所以后台任务也没有自动超时。

## Prepare 和 Cleanup 把隔离资源包进生命周期

后台 worktree 不能在 `Launch` 返回 task ID 前同步创建，否则创建慢时仍会阻塞主 Agent。Task goroutine 因此支持 Prepare/Cleanup：

```go
if prepare != nil {
    nextRunner, nextPrompt, nextCleanup, err :=
        prepare(ctx, runner, prompt)
    if err != nil {
        snap := m.finish(
            id, StatusFailed, "", err.Error(),
            agent.CompletionResult{
                Stop: agent.Stop{
                    Reason:  agent.StopStreamError,
                    Message: err.Error(),
                },
            },
        )
        m.callOnFinish(onFinish, FinishEvent{
            TaskID: id, Snapshot: snap,
        })
        return
    }
    runner = nextRunner
    prompt = nextPrompt
    cleanup = nextCleanup
}
result := m.run(ctx, runner, conv, prompt)
if cleanup != nil {
    result.Text = cleanup(context.Background(), result.Text)
}
```

Prepare 可以异步创建 worktree、修改 Runner CWD 并在 Prompt 前加入隔离说明；Cleanup 在独立 Background Context 中执行保守清理，并能把保留目录附到最终结果。Prepare 失败直接记为 Failed，真实 Runner 不会启动。

Manager 为每个 Launch 启动独立 goroutine，多个 Prepare 可以同时执行。资源并发安全必须由具体服务负责，例如 Worktree Manager 用 `creating` map 防止同名并发创建。

## 状态从 Agent Stop 映射到 Task Snapshot

后台状态只有五种：

```go
const (
    StatusRunning   Status = "running"
    StatusCompleted Status = "completed"
    StatusFailed    Status = "failed"
    StatusCancelled Status = "cancelled"
    StatusMaxTurns  Status = "max_turns"
)

func statusFromStop(reason agent.StopReason) Status {
    switch reason {
    case agent.StopCompleted:
        return StatusCompleted
    case agent.StopMaxIterations:
        return StatusMaxTurns
    case agent.StopCanceled:
        return StatusCancelled
    default:
        return StatusFailed
    }
}
```

`finish` 在锁内写入 Result、Error、EndedAt、Usage、ToolCount 和 LastActivity，再生成值拷贝 Snapshot。goroutine panic 由 defer recover 转成 Failed，不会让整个 TUI 崩溃。

`Stop` 会先把状态改成 Cancelled、调用 CancelFunc 并立即 publishDone；运行 goroutine稍后退出时还会再次 `finish` 和 publishDone。TUI 可能收到同一任务的多次 DoneEvent，但每次都重新读取最终 Snapshot，而不是信任 Event 携带状态。

## 完成通知采用非阻塞广播

Manager 的公共 Done channel 和每个 Subscriber 都有 buffer，发布时不等待消费者：

```go
func (m *Manager) publishDone(id string) {
    m.mu.RLock()
    subscribers := append([]chan DoneEvent(nil), m.subscribers...)
    m.mu.RUnlock()
    event := DoneEvent{TaskID: id}
    select {
    case m.done <- event:
    default:
    }
    for _, ch := range subscribers {
        select {
        case ch <- event:
        default:
        }
    }
}
```

这保证后台完成不会因为 TUI 忙而卡住，代价是 buffer 满时事件会静默丢弃。Subscriber 没有取消订阅或关闭机制；TUI 每处理一次 Done 后会再次调用 `SubscribeDone()`，从源码看会不断向 Manager 追加 channel，而不是复用最初订阅。这会让长期会话累积无人读取的 subscriber，并把后续事件写入它们的 buffer。

TUI 收到 task ID 后调用 `Get`，生成最多 2,000 字符的 `<task-notification>`，先放进 pending reminders；下一次模型请求再消费。通知不是自动把子 Agent 的整个 Conversation 合并回父 Conversation，只提供状态和截断结果。

## 命名任务可以在完成后继续

Task Manager 为非空 Name 保存 `byName` 映射。`SendMessage` 只允许继续 Completed 或 MaxTurns 等非运行、非失败、非取消状态：

```go
func (m *Manager) SendMessage(
    ctx context.Context,
    name, message string,
) (string, error) {
    m.mu.RLock()
    id, ok := m.byName[name]
    task := m.tasks[id]
    if !ok || task == nil {
        m.mu.RUnlock()
        return "", fmt.Errorf("task name %q not found", name)
    }
    if task.Status == StatusRunning {
        m.mu.RUnlock()
        return "", fmt.Errorf("task name %q is still running", name)
    }
    if task.Status == StatusCancelled || task.Status == StatusFailed {
        m.mu.RUnlock()
        return "", fmt.Errorf(
            "task name %q cannot be continued from status %s",
            name, task.Status,
        )
    }
    in := LaunchInput{
        Name:         name,
        Type:         task.Type,
        Fork:         task.Fork,
        Prompt:       message,
        Runner:       task.Runner,
        Conversation: task.Conversation,
        OnFinish:     task.OnFinish,
    }
    m.mu.RUnlock()
    return m.Launch(ctx, in)
}
```

继续运行复用原 Runner 和 Conversation，但创建新 task ID，并让 Name 指向新任务。它不是向仍在运行的 goroutine 注入消息；正在运行时会返回错误。Team Mailbox 对空闲成员的唤醒也建立在这个机制上。

## 完整流程

```text
Defined 子 Agent
  -> 默认前台 RunToCompletion
  -> 完成：文本直接作为 Agent Tool Result
  -> ForegroundTimeout/Canceled：重新 Launch 后台任务

Fork 或显式 background
  -> Task Manager 保存 Runner + Conversation + CancelFunc
  -> 从 context.Background 创建独立生命周期
  -> goroutine Prepare -> RunToCompletion -> Cleanup
  -> StopReason 映射 Task Status
  -> 保存 Snapshot
  -> 非阻塞 publish DoneEvent
  -> TUI Get Snapshot，生成 pending task reminder
  -> 命名且已结束：SendMessage 复用 Conversation 创建新 Task
```

## 测试验证了什么

Completion 测试覆盖最终文本、Usage、Tool 数和 MaxTurns；AgentTool 测试覆盖显式后台与前台超时转后台；Task Manager 测试覆盖父 Context 取消不影响后台任务、并发 Prepare、Cleanup、panic、Stop、多 Subscriber、预分配 ID 和继续命名任务；TUI 测试确认 DoneEvent 被格式化为下一轮 Reminder。

现有测试没有覆盖 subscriber 长期累积、buffer 满后的事件丢失、Stop 双通知、AutoTimeout 生效，或超时转后台时 Conversation 中的重复 Prompt。当前后台任务也没有跨进程恢复能力。

## 小结

PseudoClaude 用同一个 Runner 支持同步与异步执行：前台把 Event 聚合成 Tool Result，后台把执行对象放进独立 Task Context，再以 Snapshot 和 DoneEvent 回到主 TUI。命名任务还可以复用原 Conversation 继续一轮。

下一篇进入比普通后台 Task 更持久的协作模型：Team Lead 如何创建成员、保存身份与任务，并让每个成员在独立工作区完成后向 Lead 回报。
