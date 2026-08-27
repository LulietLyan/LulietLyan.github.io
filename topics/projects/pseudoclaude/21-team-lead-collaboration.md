---
title: Team Lead 协作：持久成员、共享任务与运行恢复
description: How PseudoClaude models persistent teams, launches isolated in-process members, shares dependency-aware tasks, and reports member completion to the Lead.
date: 2026-08-28
order: 21
tags:
  - PseudoClaude
  - Multi-Agent
  - Team
  - Go
---

普通后台子 Agent 的生命周期围绕一次 Task，完成后只保留内存 Conversation。Team 要解决的是另一类问题：Lead 需要稳定的成员身份、共享任务状态、独立工作区和可继续的通信地址，成员空闲后仍能被下一条消息唤醒。

PseudoClaude 因此把 Team 状态写到 `~/.PseudoClaude/teams`，每个 Member 拥有 AgentID、Session、Worktree 和 Mailbox。当前真正接通的执行后端是进程内 Task Manager；tmux/iTerm2 和角色/Plan 字段已经建模，但还没有进入生产 Spawn 链。

## Team 是磁盘状态，不是 goroutine 列表

核心类型把团队身份和运行位置分开保存：

```go
type Team struct {
    Name          string       `json:"name"`
    SanitizedName string       `json:"sanitized_name"`
    Description   string       `json:"description,omitempty"`
    ProjectRoot   string       `json:"project_root"`
    LeadAgentID   string       `json:"lead_agent_id"`
    Backend       BackendType  `json:"backend"`
    CreatedAt     time.Time    `json:"created_at"`
    Members       []MemberInfo `json:"members"`

    ConfigDir  string `json:"-"`
    ConfigPath string `json:"-"`
    InboxDir   string `json:"-"`
    TasksPath  string `json:"-"`
}

type MemberInfo struct {
    Name             string      `json:"name"`
    AgentID          string      `json:"agent_id"`
    AgentType        string      `json:"agent_type,omitempty"`
    Model            string      `json:"model,omitempty"`
    WorktreeName     string      `json:"worktree_name"`
    WorktreePath     string      `json:"worktree_path"`
    Branch           string      `json:"branch"`
    BackendType      BackendType `json:"backend_type"`
    IsActive         *bool       `json:"is_active,omitempty"`
    PlanModeRequired bool        `json:"plan_mode_required"`
    SessionID        string      `json:"session_id"`
    SessionDir       string      `json:"session_dir"`
    LastUpdatedAt    time.Time   `json:"last_updated_at"`
}
```

配置目录由清洗后的 Team 名派生：

```text
~/.PseudoClaude/teams/<sanitized-name>/
  config.json
  tasks.json
  inboxes/
  sessions/<agent-id>/
```

Manager 初始化会遍历该目录并恢复合法 `config.json`；损坏 Team 被 Warning 跳过，不阻止其他 Team 使用。普通后台 Task 不持久化，Team 配置虽能恢复 Member 元数据，但进程内 Runner 和 Conversation 仍在 Task Manager 内存中，进程重启后不能仅凭 config 恢复成员的执行上下文。

## TeamCreate 同时建立 Lead 和共享存储

创建时先规范化目录名，默认 Backend 为 `in-process`，再建立 Inbox、空任务文件和可选 Lead 成员：

```go
func (m *Manager) Create(
    ctx context.Context,
    in CreateInput,
) (*Team, error) {
    base := SanitizeName(in.Name)
    safe, err := uniqueSanitizedName(m.root, base)
    if err != nil {
        return nil, err
    }
    backend := in.Backend
    if backend == "" {
        backend = BackendInProcess
    }
    team := &Team{
        Name:          in.Name,
        SanitizedName: safe,
        Description:   in.Description,
        ProjectRoot:   m.projectRoot,
        LeadAgentID:   in.LeadAgentID,
        Backend:       backend,
        CreatedAt:     time.Now(),
    }
    derivePaths(team, m.homeDir)
    if err := os.MkdirAll(team.InboxDir, 0o755); err != nil {
        return nil, err
    }
    if err := atomicWriteJSON(
        team.TasksPath,
        map[string]any{"tasks": []any{}},
    ); err != nil {
        return nil, err
    }
    if team.LeadAgentID != "" {
        team.Members = append(team.Members, MemberInfo{
            Name: "lead", AgentID: team.LeadAgentID,
            BackendType: backend, LastUpdatedAt: time.Now(),
        })
    }
    if err := team.save(); err != nil {
        return nil, err
    }
    // 写入 Manager map 与名称 Registry
    return cloneTeam(team), nil
}
```

Team Name 可以包含空格和 Unicode，SanitizeName 会转小写并用 `-` 收敛不支持字符。同名安全目录已存在时追加 `-2`、`-3`，所以显示名称相同也可能创建多个持久 Team。

JSON 使用临时文件加 `os.Rename` 更新，但 Team `Create` 没有包住多文件事务。Inbox 创建成功而 tasks/config 写入失败时，磁盘上可能留下不完整目录。

## SpawnMember 先创建 Worktree 和初始 Mailbox

Team Member 与普通 Defined 子 Agent 最大的差异是 worktree 不是可选项：

```go
func (m *Manager) SpawnMember(
    ctx context.Context,
    in agent.TeamLaunchInput,
) (agent.TeamLaunchResult, error) {
    team, ok := m.getInternal(in.TeamName)
    if !ok {
        return agent.TeamLaunchResult{}, ErrTeamNotFound
    }
    memberName := SanitizeName(in.MemberName)
    if memberName == "" {
        memberName = "member"
    }
    if m.worktrees == nil {
        return agent.TeamLaunchResult{}, ErrWorktreeDisabled
    }
    if team.Backend == BackendInProcess {
        if m.tasks == nil || in.Parent.Registry == nil ||
            in.Parent.Provider == nil {
            return agent.TeamLaunchResult{}, ErrBackendDisabled
        }
    }

    agentID := "team-" + team.SanitizedName + "-" +
        memberName + "-" + fmt.Sprintf("%d", time.Now().UnixNano())
    worktreeName := "team-" + team.SanitizedName + "-" + memberName
    wt, err := m.worktrees.Create(
        ctx, worktree.CreateInput{Name: worktreeName},
    )
    if err != nil {
        return agent.TeamLaunchResult{}, err
    }
    // 创建 session dir、写初始 mailbox、保存 MemberInfo
}
```

成员名决定稳定 Worktree 名，AgentID 再追加纳秒时间。Member 元数据保存前，Manager 会把 Lead 的 Prompt 写进该 AgentID 的 Mailbox；之后才 AddMember 和启动 Backend。这样成员第一轮既收到 User Prompt，也能在 Reminder 看到同一份初始消息。

创建步骤没有统一 rollback。Worktree 建好后若 SessionDir、Mailbox 或 AddMember 失败，当前路径不会自动清理已创建资源；进程内 Launch 失败只移除 Member 和 Registry，也会保留先前 Worktree、SessionDir 和 Mailbox。

## 进程内成员使用独立 Runner 和 Conversation

已接通的 Backend 会从父 Snapshot 组装 Team Runner：

```go
runner := agent.Runner{
    Provider:     parent.Provider,
    Registry:     parent.Registry,
    Env:          parent.Env,
    Config:       parent.Config,
    Permission:   parent.Permission,
    Instructions: parent.Instructions,
    AllowedTools: toolkit.FilterSubAgentTools(
        parent.Registry,
        toolkit.FilterPolicy{
            TeamMember: true,
            InProcessTeamMember: true,
            Background: true,
        },
    ),
    SessionID: member.SessionID,
    CWD:       member.WorktreePath,
    Team: &agent.TeamRunContext{
        TeamName: team.Name,
        MemberName: member.Name,
        AgentID: member.AgentID,
        LeadID: team.LeadAgentID,
        Inbox: AgentInbox{Store: store},
    },
    Sub: agent.SubRunOptions{
        SystemPrompt: BuildMemberPrompt(*team, member),
        IsSubAgent: true,
        ParentLabel: member.Name,
        DontAsk: true,
        FileCacheScope: member.AgentID,
        PermissionMode: parent.PermissionMode,
    },
}
runner.Env.CWD = member.WorktreePath
runner.Env.Team = &toolkit.TeamEnv{
    TeamName: team.Name,
    MemberName: member.Name,
    AgentID: member.AgentID,
}
```

Team Member 使用全新的 Conversation，但共享父 Provider、Registry、Permission Engine 和 Instructions。可用 Tool 限定为后台基础工具加 `TaskCreate/Update/List/Get` 与 `SendMessage`，仍禁止 Agent Tool，因此成员不能继续扩张团队。

`FileCacheScope` 使用 AgentID，避免多个成员的文件缓存混在同一 Scope；CWD 同时写入 Runner 与 Tool Env，模型环境、文件工具和权限检查都指向成员 Worktree。

当前 `AgentType`、`Model` 和 `PlanModeRequired` 只保存到 MemberInfo。`launchInProcess` 不从 Subagent Catalog 解析角色，不切换 Provider，也不根据 PlanModeRequired 阻止执行；BuildMemberPrompt 只注入通用团队规则。它们是已经建模但尚未接线的策略字段。

## Team Task 是共享依赖图

普通 BackgroundTask 表示一个正在运行的 goroutine；Team Task 则是 `tasks.json` 中的协作工作项：

```go
type Task struct {
    ID          string    `json:"id"`
    Title       string    `json:"title"`
    Description string    `json:"description,omitempty"`
    Assignee    string    `json:"assignee,omitempty"`
    Status      Status    `json:"status"`
    CreatedAt   time.Time `json:"created_at"`
    UpdatedAt   time.Time `json:"updated_at"`
    BlockedBy   []string  `json:"blocked_by,omitempty"`
    Blocks      []string  `json:"blocks,omitempty"`
}

func isReady(task Task, byID map[string]Task) bool {
    for _, id := range task.BlockedBy {
        if byID[id].Status != StatusDone {
            return false
        }
    }
    return true
}
```

TaskUpdate 在添加 `BlockedBy` 时同步更新另一端的 `Blocks`，删除时也双向维护。List 为每项计算 IsReady，方便 Lead 选择下一项工作。Store 使用文件锁和原子 JSON 写入，所以多个进程内成员能共享一个任务文件。

当前 Store 不检查依赖 ID 是否存在、不检测环，也不验证 Tool 输入的 Status 是否属于四个常量。缺失依赖会因为零值状态不是 Done 而永久阻塞，循环依赖也只能由协作者手动修正。

## 成员完成后变为空闲并回报 Lead

进程内成员以 AgentID 作为 Task ID 和 Name 启动。OnFinish 负责持久化活动状态并写 Lead Mailbox：

```go
func (m *Manager) markMemberIdleAndNotify(
    ctx context.Context,
    team *Team,
    member MemberInfo,
    event task.FinishEvent,
) {
    if err := team.SetMemberActive(
        m.homeDir, member.AgentID, false,
    ); err != nil {
        m.warn("failed to mark member idle %s/%s: %v",
            team.Name, member.Name, err)
    }
    if team.LeadAgentID == "" {
        return
    }
    store, err := mailbox.New(team.InboxDir)
    if err != nil {
        return
    }
    summary := "member idle: " + string(event.Snapshot.Status)
    _ = store.Write(ctx, team.LeadAgentID, mailbox.Message{
        From: member.AgentID,
        To: team.LeadAgentID,
        Type: mailbox.MessageText,
        Summary: summary,
        Content: event.Snapshot.Result,
        Payload: map[string]any{
            "member_name": member.Name,
            "task_id": event.TaskID,
            "status": event.Snapshot.Status,
            "error": event.Snapshot.Error,
        },
    })
}
```

Lead 的 TUI 会轮询是否有未读消息，空闲时自动提交一轮“Process unread team updates”，或者在下一次正常请求中把 LeadReminder 注入模型。成员结果因此通过 Mailbox 而不是直接合并 Conversation。

当 SendMessage 写给一个空闲的 in-process Member 时，`ResumeMember` 先把 IsActive 改回 true，再调用 Task Manager 的 SendMessage，复用原 Runner 与 Conversation，并用固定 wake Prompt 提醒它读取 Mailbox。若 PseudoClaude 已重启，Task Manager 中没有这个 Name，持久 Member 也无法恢复执行。

## Backend 与 Plan 字段的当前接线状态

类型包定义 `tmux`、`iterm2` 和 `in-process`，`internal/team/backend` 也声明了 Spawn/Wake/Kill 接口和环境检测。但是生产 `main.go` 创建 Team Manager 时没有注入 BackendController，`SpawnMember` 只在 `BackendInProcess` 分支调用 `launchInProcess`。

如果 TeamCreate 显式写 `backend: tmux` 或 `iterm2`，当前代码会创建 Worktree、SessionDir、Mailbox 和 active MemberInfo，却不会调用外部 Backend Spawn，返回结果中的 PaneID 为空。Delete/Kill 也因 Manager backend 为 nil，不会终止外部进程。

`plan_mode_required` 同样只持久化；Mailbox 对 `plan_approval_response` 唯一执行的规则是只有 Lead 能发送该类型，并没有成员提交 Plan、等待批准后再执行的状态机。这些不能作为已完成的产品能力介绍。

## 完整流程

```text
Lead 调用 TeamCreate
  -> 建立 ~/.PseudoClaude/teams/<name>
  -> 保存 lead Member + tasks.json + inboxes

Lead 调用 Agent(team_name, member_name, prompt)
  -> 创建 team-<team>-<member> worktree/branch
  -> 建 SessionDir 和成员 Mailbox
  -> 写初始 Prompt 消息
  -> 保存 MemberInfo(active=true)
  -> in-process: 创建独立 Team Runner + Conversation
  -> Task Manager 后台执行
  -> Member 使用共享 Task Tool 与 SendMessage
  -> 完成后 active=false，结果写入 Lead Mailbox
  -> Lead Reminder 消费结果
  -> 后续消息写给空闲 Member：复用 Task Conversation 再启动
```

## 测试验证了什么

Team Manager 测试覆盖创建、磁盘恢复、损坏配置隔离、成员增删和强制删除；Spawn 测试覆盖 Worktree、初始 Mailbox、独立 Team Runner、完成后空闲与 Lead 通知、空闲成员恢复；TeamTask 测试覆盖双向依赖与 IsReady；Tool 测试覆盖 Create/Delete/Kill 和共享 Task 操作。

现有测试没有证明 tmux/iTerm2 真正 Spawn，也没有覆盖 AgentType/Model/PlanModeRequired 的运行时效果、跨进程成员恢复、依赖环或 Spawn 中途失败的资源 rollback。

## 小结

PseudoClaude 的 Team 不是临时并发列表，而是一组落盘身份、Worktree、Mailbox 和共享任务。已完成的主链是 in-process Member：独立 Runner 在后台执行，结束后持久化为空闲并通过 Mailbox 回报 Lead，后续消息可以复用其 Conversation。

下一篇下钻这条协作链的通信层：每个 Agent 的 JSON Mailbox 如何应对并发写入，未读消息怎样变成模型 Reminder，以及点对点、广播与控制消息如何路由。
