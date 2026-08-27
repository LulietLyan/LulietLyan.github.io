---
title: Mailbox 通信：文件锁、未读消息与 Agent 唤醒
description: How PseudoClaude persists per-agent mailboxes, serializes concurrent writers, injects unread messages as reminders, and wakes idle team members.
date: 2026-08-28
order: 22
tags:
  - PseudoClaude
  - Multi-Agent
  - Mailbox
  - Go
---

Team Member 的 Assistant 回复只属于自己的 Conversation，不能假设 Lead 或其他成员会自动看到。协作必须经过一个明确通道，既能让同时运行的 goroutine 写入，也能让成员暂时空闲后再读取。

PseudoClaude 采用每个 Agent 一个 JSON Mailbox：`SendMessage` 解析收件人并追加消息，Runner 在下一轮请求前读取未读项、渲染 Reminder，再把这些索引标为已读。它是本机文件协议，不是远端消息队列。

## Message 同时承载文本和控制类型

Mailbox 定义四种已知类型，但底层结构允许附加 Payload：

```go
type MessageType string

const (
    MessageText MessageType = "text"
    MessageShutdownRequest MessageType = "shutdown_request"
    MessageShutdownResponse MessageType = "shutdown_response"
    MessagePlanApprovalResponse MessageType = "plan_approval_response"
)

type Message struct {
    From      string         `json:"from"`
    To        string         `json:"to"`
    Type      MessageType    `json:"type"`
    Summary   string         `json:"summary"`
    Content   string         `json:"content,omitempty"`
    Payload   map[string]any `json:"payload,omitempty"`
    Timestamp time.Time      `json:"timestamp"`
    Read      bool           `json:"read"`
}

type IndexedMessage struct {
    Index   int     `json:"index"`
    Message Message `json:"message"`
}
```

每个收件人使用独立文件：

```text
~/.PseudoClaude/teams/<team>/inboxes/
  <lead-agent-id>.json
  <member-agent-id>.json
```

Box 是只追加数组，IndexedMessage 的 Index 就是数组下标，供 MarkRead 定位。已读消息不删除，因此文件会随 Team 生命周期持续增长；当前没有分页、压缩、归档或大小上限。

MessageType 并没有严格解析函数。`SendMessage` 只在空值时设为 text，其他任意字符串也会被写入。Shutdown 类型当前只是消息标签，没有 Mailbox 层自动终止成员的处理器；Plan Approval 也只有发送权限检查，不构成完整审批状态机。

## Write 是锁内 read-modify-write

追加消息先补默认值，再在收件人自己的锁中更新 Box：

```go
func (s *Store) Write(
    ctx context.Context,
    agentID string,
    msg Message,
) error {
    if msg.Type == "" {
        msg.Type = MessageText
    }
    if msg.Timestamp.IsZero() {
        msg.Timestamp = time.Now()
    }
    msg.Read = false
    return s.withLock(ctx, agentID, func(box *Box) error {
        box.Messages = append(box.Messages, msg)
        return nil
    })
}

func (s *Store) withLock(
    ctx context.Context,
    agentID string,
    mutate func(*Box) error,
) error {
    path := s.path(agentID)
    release, err := filelock.Acquire(
        ctx, path+".lock", filelock.Options{},
    )
    if err != nil {
        return err
    }
    defer release()
    box, err := s.readBox(agentID)
    if err != nil {
        return err
    }
    if err := mutate(box); err != nil {
        return err
    }
    return atomicWriteJSON(path, box)
}
```

不同收件人拥有不同锁，可以并行写；同一收件人的并发写会串行，避免两个 goroutine 都读取旧 Box 后覆盖对方。测试用 10 个 goroutine 同时写一个 Agent，最终仍得到 10 条合法 JSON 消息。

Store.path 直接把 `agentID + ".json"` Join 到 InboxDir，不执行名称校验。生产收件人通常来自 Team Registry 中生成的安全 AgentID，但底层 Store 若被其他调用方传入 `../x` 一类 ID，会有路径越界风险。

## 文件锁使用 O_EXCL 和陈旧回收

锁不是进程内 mutex，而是一个真实 `.lock` 文件：

```go
func Acquire(
    ctx context.Context,
    path string,
    opts Options,
) (func(), error) {
    if ctx == nil {
        ctx = context.Background()
    }
    opts = normalize(opts)
    for attempt := 0; attempt < opts.Attempts; attempt++ {
        file, err := os.OpenFile(
            path,
            os.O_WRONLY|os.O_CREATE|os.O_EXCL,
            0o600,
        )
        if err == nil {
            _, _ = file.WriteString(time.Now().Format(time.RFC3339Nano))
            _ = file.Close()
            return func() { _ = os.Remove(path) }, nil
        }
        if !errors.Is(err, os.ErrExist) {
            return nil, err
        }
        _ = removeIfStale(path, opts.StaleAge)
        if attempt == opts.Attempts-1 {
            break
        }
        timer := time.NewTimer(jitter(opts.MinDelay, opts.MaxDelay))
        select {
        case <-ctx.Done():
            timer.Stop()
            return nil, ctx.Err()
        case <-timer.C:
        }
    }
    return nil, os.ErrExist
}
```

默认尝试 10 次，每次随机等待 5 到 100 毫秒；ModTime 超过 10 秒的锁会被移除。它允许不同进程共享 Team 文件，也避免进程崩溃后永久锁死。

这不是带租约续期的分布式锁。如果一次合法写入超过 StaleAge，另一个 Writer 可能删掉仍在使用的锁；网络文件系统上的 O_EXCL 和 Rename 语义也取决于具体文件系统。当前 JSON 很小，设计基于本地短临界区。

## 原子 Rename 让无锁读取看到旧版或新版

锁内更新不会直接截断目标文件，而是写同目录临时文件后 Rename：

```go
func atomicWriteJSON(path string, value any) error {
    data, err := json.MarshalIndent(value, "", "  ")
    if err != nil {
        return err
    }
    data = append(data, '\n')
    tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*.json")
    if err != nil {
        return err
    }
    tmpPath := tmp.Name()
    ok := false
    defer func() {
        if !ok {
            _ = os.Remove(tmpPath)
        }
    }()
    if _, err := tmp.Write(data); err != nil {
        _ = tmp.Close()
        return err
    }
    if err := tmp.Close(); err != nil {
        return err
    }
    if err := os.Rename(tmpPath, path); err != nil {
        return err
    }
    ok = true
    return nil
}
```

Read 和 ReadUnread 不获取锁。因为 Writer 最后才 Rename，Reader 通常看到完整旧文件或完整新文件，不会看到正在写的半截 JSON。实现没有 `fsync` 文件和父目录，突然断电后的持久性仍取决于操作系统与文件系统。

MarkRead 也走同一个 withLock，按索引把 Read 改为 true。新消息只追加在末尾，因此旧索引在并发追加后仍指向同一项；两个消费者仍可能同时读取同一批未读消息，然后分别 MarkRead，所以交付语义不是 exactly-once。

## SendMessage 负责收件人解析与空闲恢复

Tool 可以从 Team Context 取默认 Team，也允许 Lead 在外部显式传 team_name：

```go
recipients, err := t.recipients(name, args.To, env)
if err != nil {
    return teamFailure("SendMessage", err)
}
resumed := map[string]string{}
for _, recipient := range recipients {
    msg := mailbox.Message{
        From: from,
        To: recipient.AgentID,
        Type: msgType,
        Summary: args.Summary,
        Content: args.Content,
        Payload: args.Payload,
    }
    if err := store.Write(ctx, recipient.AgentID, msg); err != nil {
        return teamFailure("SendMessage", err)
    }
    if shouldResume(recipient) {
        taskID, err := t.Manager.ResumeMember(
            ctx, name, recipient.AgentID,
        )
        if err != nil {
            return teamFailure("SendMessage", err)
        }
        resumed[recipient.Name] = taskID
    }
}
```

`to` 可以是 Member Name、AgentID、`broadcast`、`*` 或 `all`。Broadcast 会读取最新 Member 列表并排除发送者自己的 AgentID；Lead 也作为一个 Member，所以成员广播会包含 Lead。

只有 `plan_approval_response` 检查 `env.Team.IsLead`。其他控制类型和任意未知类型都可以由成员发送。循环中若先写成功若干收件人、后一个失败，不会回滚前面的消息，因此 Broadcast 不是原子多播。

收件人若是 `IsActive=false` 的 in-process Member，Tool 在写信后调用 ResumeMember。它通过 Task Manager 复用该成员的 Runner/Conversation，启动一轮固定 Wake Prompt；tmux/iTerm2 成员没有接通 Wake，活动成员也只收信，不会向正在运行的 goroutine实时注入。

## Runner 在模型请求前消费未读消息

Team Member 每一轮构建 Reminder 时调用 `TeamRunContext.Reminder`：

```go
func (c *TeamRunContext) Reminder() string {
    if c == nil || c.Inbox == nil || c.AgentID == "" {
        return ""
    }
    messages, err := c.Inbox.ReadUnread(c.AgentID)
    if err != nil {
        return fmt.Sprintf(
            "<incoming-messages>\nFailed to read team mailbox: %v\n</incoming-messages>",
            err,
        )
    }
    if len(messages) == 0 {
        return ""
    }
    indices := make([]int, 0, len(messages))
    var b strings.Builder
    b.WriteString("<incoming-messages>\n")
    b.WriteString(
        "Unread team messages. Plain assistant replies are not sent " +
            "to teammates; use SendMessage for reports or collaboration.\n",
    )
    for _, indexed := range messages {
        indices = append(indices, indexed.Index)
        // 渲染 from/to/type/summary/content
    }
    b.WriteString("\n</incoming-messages>")
    if err := c.Inbox.MarkRead(c.AgentID, indices); err != nil {
        b.WriteString(fmt.Sprintf(
            "\n<system-reminder>Failed to mark team messages read: %v</system-reminder>",
            err,
        ))
    }
    return b.String()
}
```

显式提醒“普通回复不会发给队友”，强制模型通过 SendMessage 建立可审计通信。消息在 Reminder 返回时就标为已读，不等待 Provider 成功接收、模型处理或回执；如果随后的模型请求失败，这批消息不会自动再次注入。

Lead 使用类似的 `LeadReminder` 读取所有 Team 的 Lead Box。TUI 每两秒 `HasLeadMail` peek 一次，peek 不标已读；若界面空闲且发现消息，就自动提交协调回合。真正构造请求时 `LeadReminder` 才渲染并 MarkRead。

## 完整流程

```text
发送者调用 SendMessage
  -> 解析 Team 与 recipient/broadcast
  -> 检查 plan_approval_response 只能由 Lead 发送
  -> 为每个收件人获取 <agent>.json.lock
  -> 读取 Box，追加 unread Message
  -> 写临时 JSON，Rename 覆盖目标
  -> 收件人空闲且 in-process：恢复 Task Runner

成员下一轮模型请求
  -> ReadUnread(agentID)
  -> 渲染 <incoming-messages>
  -> 锁内 MarkRead(indices)
  -> Reminder 发送给 Provider
  -> 模型必须显式调用 SendMessage 回报

Lead TUI
  -> 每两秒 HasLeadMail peek
  -> 空闲时自动触发协调回合
  -> LeadReminder 读取并 MarkRead
```

## 测试验证了什么

Mailbox 测试覆盖写入、时间戳、未读索引、MarkRead、10 goroutine 并发追加和陈旧锁回收；Filelock 测试覆盖获取、释放、冲突和 stale removal；SendMessage 测试覆盖点对点、广播、Lead-only Plan Response 和空闲成员恢复；TeamContext/LeadMail/TUI 测试确认 Reminder 内容、MarkRead 和两秒唤醒入口。

现有测试没有覆盖无效 AgentID 路径、未知 MessageType、Broadcast 部分成功、活动成员实时收信、Reminder 后 Provider 失败的消息重投、Mailbox 无限增长或网络文件系统语义。

## 小结

PseudoClaude 用可检查的本地文件代替隐式共享 Conversation：每个 Agent 有独立 Box，文件锁序列化 Writer，原子 Rename 保护无锁 Reader，Unread Reminder 把通信送回模型上下文。空闲进程内成员还能在收到新信后复用原 Conversation 继续工作。

下一篇完成多 Agent 主线，解释每个成员和可选子 Agent 怎样获得独立 Git worktree/branch，CWD 如何切换，以及自动清理为什么必须保守处理未提交改动和本地提交。
