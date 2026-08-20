---
title: 从子 Agent 到 Team Lead：后台任务、Git worktree 与 mailbox 协作
description: PseudoClaude 如何把 Agent 自己也做成工具，并用 task、worktree、team、mailbox 支撑并行协作。
date: 2026-08-21
order: 7
tags:
  - PseudoClaude
  - Multi-Agent
  - Worktree
  - Team
---

PseudoClaude 里最有意思的一层，是把 Agent 自己也做成工具。

这听起来有点绕：Agent 不是运行主体吗，为什么还会是工具？

答案在 `internal/agent/agent_tool.go`。模型如果想委派任务，不是调用某个隐藏 API，而是正常发起一个名为 `Agent` 的 tool call：

```json
{
  "prompt": "...",
  "description": "...",
  "subagent_type": "...",
  "run_in_background": true,
  "isolation": "worktree",
  "team_name": "..."
}
```

系统收到后，`AgentTool.Execute` 创建另一个 Runner，把它放到前台、后台、worktree，或者 team 里运行。

这篇讲 PseudoClaude 的多 Agent 协作：subagent、task、worktree、team 和 mailbox。

## AgentTool：多 Agent 的统一入口

`AgentTool` 实现了普通工具接口：

```go
func (t *AgentTool) Definition() tools.Definition
func (t *AgentTool) Execute(ctx context.Context, input json.RawMessage, env tools.Env) tools.Result
```

它持有这些依赖：

```go
type AgentTool struct {
    Catalog    *subagent.Catalog
    Tasks      AgentTaskLauncher
    Parent     *RunnerHandle
    Providers  ProviderResolver
    Background BackgroundPolicy
    Worktrees  WorktreeService
    Team       TeamService
}
```

`AgentToolInput` 支持：

- `prompt`：子 Agent 任务。
- `description`：短描述。
- `subagent_type`：预定义角色。
- `model`：模型覆盖。
- `isolation`：目前支持 `worktree`。
- `run_in_background`：后台运行。
- `name`：后台任务名。
- `team_name`：启动 team member。
- `plan_mode_required`：team 场景下要求先提交计划。

分流逻辑很清楚：

```text
if team_name != "":
  executeTeam
else if subagent_type == "":
  executeFork
else:
  Catalog.Resolve(subagent_type)
  executeDefined
```

所以 PseudoClaude 有三种 Agent 形态：

- defined subagent：预定义角色。
- fork subagent：继承当前上下文的临时后台分支。
- team member：持久团队成员。

## 为什么要有 RunnerHandle

子 Agent 需要继承父 Agent 的运行环境，比如 provider、registry、permission、instructions、hooks、cwd、conversation。

TUI 每次启动主 Runner 前，会把当前 runner 快照存进 `RunnerHandle`。`AgentTool.Execute` 再读取：

```go
parent := t.Parent.Snapshot()
```

如果没有 provider、registry 或 conversation，就返回 `not_ready`。

它还会禁止嵌套：

```text
subagent 不能再启动 Agent
fork subagent 不能再启动 Agent
team member 不能再启动 team member
```

这很重要。否则模型可能递归开 Agent，导致任务树失控。

## defined subagent：角色定义和工具边界

subagent 定义在 `internal/subagent/definition.go`。一个 `Definition` 包括：

- `Name`
- `Description`
- `Tools`
- `DisallowedTools`
- `Model`
- `MaxTurns`
- `Permission`
- `Background`
- `Isolation`
- `SystemPrompt`
- `Source`

Catalog 加载顺序在 `internal/subagent/catalog.go`：

```text
plugin
builtin
~/.PseudoClaude/agents
<project>/.PseudoClaude/agents
```

同名定义按优先级覆盖，项目级可以覆盖用户级和内置定义。

defined subagent 启动时，会调用：

```go
runner := t.childRunner(parent, def, false, background)
```

`childRunner` 会复制父 Runner 大部分字段，但收缩工具范围：

```go
allowed := tools.FilterSubAgentTools(parent.Registry, tools.FilterPolicy{
    DefinitionTools:      def.Tools,
    DefinitionDisallowed: def.DisallowedTools,
    Background:           background,
    Fork:                 fork,
})
```

如果权限是 plan，还会只保留只读工具：

```go
if def.Permission == subagent.PermissionPlan {
    allowed = readOnlyToolNames(parent.Registry, allowed)
}
```

后台 subagent 默认不能弹审批。如果需要 ask，默认拒绝。

这让 subagent 不是“另一个无限权限主 Agent”，而是一个被角色定义约束过的 Runner。

## 前台运行和后台运行

defined subagent 可以前台运行：

```text
Agent tool call
  -> childRunner
  -> runForeground
  -> Runner.RunToCompletion
  -> 结果作为 Agent 工具结果返回
```

也可以后台运行：

```text
Agent tool call
  -> childRunner
  -> task.Manager.LaunchAgent
  -> goroutine Runner.RunToCompletion
  -> TaskGet / TaskList 查询结果
```

后台任务由 `internal/task/manager.go` 管理。

`task.Manager.Launch` 会：

1. 创建独立 cancel context。
2. 生成 task id。
3. 保存 `BackgroundTask`。
4. 开 goroutine 调 `runTask`。

`runTask` 调默认执行器：

```go
runner.RunToCompletion(ctx, RunToCompletionInput{
    Request:  agent.Request{Conversation: conv},
    TaskText: prompt,
})
```

完成后，它把 stop reason 映射成：

- `completed`
- `failed`
- `cancelled`
- `max_turns`

并发布 done event。TUI 订阅后会把后台任务更新写进 transcript。

## fork subagent：复制当前上下文

如果 `Agent` tool call 没有传 `subagent_type`，就走 fork：

```go
messages := subagent.BuildForkMessages(parent.Conversation.Messages(), args.Prompt)
childConv := conversation.NewFromMessages(messages, conversation.Hooks{})
runner := t.childRunner(parent, def, true, true)
```

fork 的特点：

- 克隆父 conversation。
- 追加 fork boilerplate。
- 永远后台运行。
- 不允许再启动 Agent。
- 不向用户提问。
- 专注分配任务。

`BuildForkMessages` 还有一个细节：它会修复 dangling tool calls。

如果父 conversation 最后一条 assistant message 有 tool calls，但没有对应 tool result，fork 会补一条 error tool result：

```text
tool result unavailable in forked context
```

这是为了保证复制出来的上下文符合 provider 的 tool calling 结构要求。

fork 适合临时并行调查：主 Agent 正在做一个任务，让 fork 去读某个模块、查一个错误、总结一个方向。

## Worktree：让子 Agent 在隔离目录里改文件

多 Agent 最大的工程风险，是同时污染同一个工作区。

PseudoClaude 用 Git worktree 做文件隔离。相关代码在：

- `internal/worktree/create.go`
- `internal/worktree/lifecycle.go`
- `internal/agent/agent_worktree.go`

如果 subagent 请求：

```json
{"isolation": "worktree"}
```

或者定义里配置了 worktree 隔离，`AgentTool` 会调用 `worktreePrepare`。

创建 worktree 的实际命令是：

```bash
git worktree add -B <branch> <path> <base>
```

代码里是：

```go
runGitTrimmed(ctx, m.git, m.repoRoot, "worktree", "add", "-B", branch, path, base)
```

创建后会把子 Runner 的目录切过去：

```go
runner.CWD = wt.Path
runner.Env.CWD = wt.Path
```

这样子 Agent 的读写、搜索、命令执行都会发生在独立 worktree，而不是主工作区。

结束后会自动清理：

```text
如果是 manual worktree -> 保留
如果有未提交改动/新提交/未推送提交 -> 保留
否则删除临时 worktree
```

这让系统可以大胆派 Agent 并行执行，同时把文件级风险隔离开。

## Team：比 subagent 更持久的协作单位

Team 是多 Agent 的持久协作层。相关代码在 `internal/team`。

普通 subagent 更像一次性任务；team member 则有：

- 名字。
- AgentID。
- SessionID。
- SessionDir。
- WorktreePath。
- Mailbox。
- Active 状态。
- Shared task store。

当 `Agent` tool call 带 `team_name` 时：

```go
t.Team.SpawnMember(ctx, TeamLaunchInput{...})
```

`SpawnMember` 会：

1. 查找 team。
2. 清洗 member name。
3. 创建 worktree。
4. 创建 session dir。
5. 打开 mailbox store。
6. 给 member mailbox 写入初始任务。
7. 写入 `MemberInfo`。
8. 注册 member name 到 agent id。
9. in-process backend 下用 task manager 启动成员。

team member 的 Runner 会设置：

```go
Team: &agent.TeamRunContext{
    TeamName:   team.Name,
    MemberName: member.Name,
    AgentID:    member.AgentID,
    LeadID:     team.LeadAgentID,
    Inbox:      AgentInbox{Store: store},
}
```

并且：

```go
runner.CWD = member.WorktreePath
runner.Env.CWD = member.WorktreePath
runner.Env.Team = &tools.TeamEnv{...}
```

也就是说，team member 天然在自己的 worktree 里工作，并且有 team 上下文。

## Mailbox：团队协作不是普通回复

Team 通信在 `internal/team/mailbox`。

消息结构：

```go
type Message struct {
    From      string
    To        string
    Type      MessageType
    Summary   string
    Content   string
    Payload   map[string]any
    Timestamp time.Time
    Read      bool
}
```

每个 agent 一个 mailbox JSON 文件。写入时用 file lock：

```go
filelock.Acquire(ctx, path+".lock", ...)
```

这避免多个成员同时写同一个 mailbox 时破坏 JSON。

跨成员通信必须调用 `SendMessage` 工具。普通 assistant 回复只属于当前 run，不会自动发给 Lead 或其它成员。

`SendMessage` 会：

1. 解析 team name。
2. 解析收件人，可以是 member name、agent id、lead、broadcast。
3. 写入对方 mailbox。
4. 如果对方是 idle member，调用 `ResumeMember` 唤醒。

## Lead 如何被通知

team member 结束后，task 的 `OnFinish` 会调用：

```go
markMemberIdleAndNotify(ctx, team, member, event)
```

它先把成员标记为 idle，然后给 Lead mailbox 写消息：

```go
store.Write(ctx, team.LeadAgentID, mailbox.Message{
    From:    member.AgentID,
    To:      team.LeadAgentID,
    Type:    mailbox.MessageText,
    Summary: "member idle: completed",
    Content: event.Snapshot.Result,
    Payload: map[string]any{
        "member_name": member.Name,
        "task_id":     event.TaskID,
        "status":      event.Snapshot.Status,
        "error":       event.Snapshot.Error,
    },
})
```

TUI 每隔一段时间检查 `HasLeadMail()`。如果 Lead 有未读消息且当前 idle，就自动提交：

```text
Process unread team updates and continue coordinating the team.
```

下一轮 Runner 的 reminder 会调用 `LeadReminder()`，把未读成员更新注入 prompt。

这不是强行打断模型流，而是在下一轮上下文里提醒 Lead 处理团队更新。

## idle 成员如何被唤醒

成员完成任务后会变 idle。如果有人给它发 `SendMessage`，并且它是 in-process backend，系统会：

```go
ResumeMember(...)
  -> task.Manager.SendMessage(member.AgentID, mailboxWakePrompt)
```

唤醒 prompt 是：

```text
You have new unread team mailbox messages. Read the incoming team messages in the system reminder, handle the request, and use SendMessage to report results or ask follow-up questions.
```

真正的消息内容不在唤醒 prompt 里，而是在 mailbox 中。成员下一轮运行时，`TeamRunContext.Reminder()` 会读取自己的未读消息，并注入：

```text
<incoming-messages>
Unread team messages...
- from=... to=... type=... summary=...
  content...
</incoming-messages>
```

然后标记已读。

这形成了一个闭环：

```text
SendMessage
  -> write mailbox
  -> resume idle member
  -> TeamRunContext.Reminder injects unread messages
  -> member handles
  -> member SendMessage replies
```

## 三层协作模型

PseudoClaude 的多 Agent 可以理解成三层：

第一层：defined subagent。

```text
预定义角色 + 工具边界 + 可前台/后台运行
```

第二层：fork subagent。

```text
复制当前上下文 + 后台调查分支任务
```

第三层：team member。

```text
持久身份 + worktree + session + mailbox + 可唤醒协作
```

它们都复用 Runner，但生命周期和协作方式不同。

## 设计复盘

PseudoClaude 的多 Agent 不是简单“开多个模型请求并发跑”。

更准确地说，它是：

```text
工具化委派
  -> Runner 快照复制
  -> 角色和工具边界收缩
  -> task.Manager 后台托管
  -> Git worktree 文件隔离
  -> mailbox 异步协作
```

这种设计最值得学习的地方，是它没有把多 Agent 做成一个和主系统平行的新架构。

`Agent` 仍然是 tool call。

子 Agent 仍然是 Runner。

后台执行仍然是 task。

文件隔离交给 worktree。

团队协作交给 mailbox。

每层只做一件事，组合起来就能支持复杂任务拆解。

