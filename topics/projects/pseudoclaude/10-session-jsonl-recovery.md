---
title: 会话持久化：JSONL 日志如何写入与恢复
description: How PseudoClaude persists messages and replacement snapshots in JSONL and replays them into a valid conversation after restart.
date: 2026-08-28
order: 10
tags:
  - PseudoClaude
  - Session
  - JSONL
  - Go
---

终端 Coding Agent 的一次任务可能持续几十轮。只把消息保存在内存中，进程退出就会丢失上下文；每次变化都重写整份会话，又会让写入成本随历史长度增长。PseudoClaude 的选择是事件式 JSONL：普通消息追加一条记录，上下文被压缩或替换时追加一个 Replace 标记和新的有效快照。

这种设计保留了追加写的简单性，也让恢复器可以顺序重放历史。不过，追加日志不等于事务数据库。本篇会分别说明它如何工作，以及当前恢复链路仍有哪些没有完成的产品接线。

## Session Context 先确定落盘边界

每次新会话都有独立目录，内部固定包含 JSONL 路径和大型工具结果目录：

```go
type Context struct {
    ID        string
    Dir       string
    JSONLPath string
    SpillDir  string
}

func contextForID(workspace, id string) Context {
    dir := filepath.Join(workspace, ".PseudoClaude", SessionsDirName, id)
    return Context{
        ID:        id,
        Dir:       dir,
        JSONLPath: filepath.Join(dir, ConversationFileName),
        SpillDir:  filepath.Join(dir, ToolResultsDirName),
    }
}
```

Session ID 由本地时间戳和两字节随机数构成，例如 `20260828-142030-a1b2`。`NewContext` 最多尝试十次避免目录碰撞，只创建 Session 和 `tool-results` 目录；`conversation.jsonl` 延迟到 Writer 打开时创建。

目录放在当前工作区的 `.PseudoClaude/sessions` 中，因此不同仓库拥有独立会话集合。ID 中可解析的时间还被用于三十天过期清理，而不是依赖额外数据库字段。

## Conversation Hook 将内存变化接到磁盘

Conversation 是模型下一轮实际读取的内存消息序列，Session Writer 是它的持久化观察者。二者通过两类 Hook 相连：

```go
func (w *Writer) Hooks() conversation.Hooks {
    return conversation.Hooks{
        OnAppend: w.AppendMessage,
        OnReplace: func(reason conversation.ReplaceReason, msgs []llm.Message) {
            w.AppendReplace(string(reason), msgs)
        },
    }
}
```

`AddUser`、`AddAssistant`、`AddAssistantToolCalls` 和 `AddToolResult` 触发 `OnAppend`；Compact 用新消息集合替换当前上下文时触发 `OnReplace`。Conversation 会先释放自己的互斥锁，再同步调用 Hook，避免磁盘 IO 长时间占用消息锁，也避免回调重入造成死锁。

Hook 本身不是后台队列。Runner 在继续后续步骤前，会等待对应 Writer 方法返回，因此成功返回代表该条记录已经走完当前同步写入路径。

## 每一行都是一个可重放事件

Writer 的 Entry 同时容纳文本消息、工具调用、工具结果和替换事件：

```go
type Entry struct {
    Type       string          `json:"type,omitempty"`
    Reason     string          `json:"reason,omitempty"`
    Role       string          `json:"role,omitempty"`
    Content    string          `json:"content,omitempty"`
    ToolCalls  []llm.ToolCall  `json:"tool_calls,omitempty"`
    ToolResult *llm.ToolResult `json:"tool_result,omitempty"`
    TS         int64           `json:"ts"`
    Model      string          `json:"model,omitempty"`
}
```

普通追加先转换成 `EntryMessage`。Writer 用互斥锁串行保护文件，把结构编码成一行 JSON，再立即 `Sync`：

```go
func (w *Writer) writeEntryLocked(entry Entry) error {
    data, err := json.Marshal(entry)
    if err != nil {
        return err
    }
    if _, err := w.file.Write(append(data, '\n')); err != nil {
        return err
    }
    return w.file.Sync()
}
```

逐行 `fsync` 用吞吐量换取更清晰的持久化时点。对于交互式 Agent，消息频率通常远低于日志采集系统，这个权衡可以接受；代价是工具调用很多时，磁盘同步会直接增加 Runner 延迟。

Model 只写在 Writer 实例的第一条成功消息上。会话列表扫描物理日志时，可以从首个带 Model 的记录展示该会话最初绑定的模型。

## Replace 让追加日志表达当前快照

Layer 1 落盘或 Layer 2 摘要会整体替换 Conversation。如果直接追加新消息，恢复器无法知道旧历史已经失效。因此 Writer 先写 Replace，再依次写替换后的消息：

```go
func (w *Writer) AppendReplace(reason string, msgs []llm.Message) {
    if w == nil {
        return
    }
    w.mu.Lock()
    err := w.writeEntryLocked(Entry{
        Type: EntryReplace, Reason: reason, TS: time.Now().Unix(),
    })
    for _, msg := range msgs {
        if err != nil {
            break
        }
        entry := entryFromMessage(msg)
        if !w.wroteMsg && w.model != "" {
            entry.Model = w.model
        }
        err = w.writeEntryLocked(entry)
        if err == nil {
            w.wroteMsg = true
        }
    }
    w.mu.Unlock()
    w.report(err)
}
```

日志可能形成下面的形状：

```text
message(user: 原始请求)
message(assistant: tool call)
message(user: tool result)
replace(reason=compact)
message(user: 历史摘要)
message(assistant: 已记录摘要)
message(user: 摘要边界提醒)
message(...近期完整历史)
```

Replace 之前的行仍保留在文件中，便于审计变化；它们不再属于恢复后的有效上下文。这也是“物理日志长度”和“当前 Conversation 长度”不能混为一谈的原因。

## Loader 顺序重放并修复中断尾部

恢复不需要随机访问。Loader 使用 Scanner 从头读取，坏 JSON 行计数后跳过，遇到 Replace 就清空当前累计消息：

```go
for scanner.Scan() {
    var entry Entry
    if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
        result.BadLines++
        continue
    }
    switch entry.Type {
    case EntryReplace:
        result.Messages = nil
    case EntryMessage, "":
        msg := messageFromEntry(entry)
        if msg.Role == "" {
            continue
        }
        result.Messages = append(result.Messages, msg)
        if entry.TS > 0 {
            result.LastMessage = time.Unix(entry.TS, 0)
        }
    }
}
```

扫描完成后还要检查最后一个 Assistant ToolCall 是否已经收到全部 ToolResult：

```go
func truncateDanglingToolCalls(messages []llm.Message) ([]llm.Message, bool) {
    for i := len(messages) - 1; i >= 0; i-- {
        if len(messages[i].ToolCalls) == 0 {
            continue
        }
        if toolCallsSatisfied(messages, i) {
            return messages, false
        }
        return append([]llm.Message(nil), messages[:i]...), true
    }
    return messages, false
}
```

进程可能在记录 ToolCall 后、写入结果前退出。多数模型协议不接受只有调用没有结果的历史，因此恢复器删除这个不完整调用及其后续消息，回到最后一个完整边界。它不会伪造失败结果，因为程序无法确定工具究竟没有执行，还是执行后尚未来得及持久化。

## 会话列表与恢复时的对象切换

`session.List` 扫描合法 ID 目录，提取首条用户文本作为标题、首个 Model、物理 Message Entry 数、文件大小和修改时间，再按修改时间倒序排列。TUI 最多展示九个候选，并排除当前会话和空会话。

选中历史会话后，恢复逻辑不只是替换一个消息数组：

```go
rt, err := compact.OpenRuntime(m.cwd, info.ID, contextWindow)
if err != nil {
    m.state = stateIdle
    m.appendTranscript(transcriptEntry{
        kind: transcriptError,
        text: "恢复压缩运行时失败: " + err.Error(),
    })
    return m, m.textarea.Focus()
}
model := ""
if m.provider != nil {
    model = m.provider.Model()
}
writer, err := session.OpenWriter(ctx, model, func(err error) {
    m.appendTranscript(transcriptEntry{
        kind: transcriptError,
        text: "会话写入失败: " + err.Error(),
    })
})
if err != nil {
    m.state = stateIdle
    m.appendTranscript(transcriptEntry{
        kind: transcriptError,
        text: "打开会话写入器失败: " + err.Error(),
    })
    return m, m.textarea.Focus()
}
if m.sessionWriter != nil {
    _ = m.sessionWriter.Close()
}
m.sessionCtx = ctx
m.sessionWriter = writer
m.compactRuntime = rt
m.conv = conversation.NewFromMessages(messages, writer.Hooks())
```

随后实现会把 Runner 的 Compact、Memory 和 Instructions 指回这些会话对象。最后消息超过六小时时，还会在内存历史末尾追加一条提醒，要求模型重新确认文件和外部状态。

## 当前实现的边界

追加日志降低了复杂度，但下面几项不能被描述成事务保证：

- `AppendReplace` 是“一个 Replace 行 + 多个 Message 行”，不是原子提交。进程在中间退出时，Loader 会以已经写入的部分新快照为准，没有回滚到 Replace 之前的机制。
- Conversation Hook 没有错误返回值。Writer 失败会调用 TUI 的 `onError` 回调，但当前内存 Conversation 仍会继续变化，磁盘日志可能从该点开始与运行状态不一致。
- Scanner 单行上限是 10 MiB。Tool Result 在 Compact 落盘前已经通过 Conversation Hook 写入原始 JSONL，极大的单条结果可能让后续恢复直接遇到 Scanner 错误。
- 会话列表的 `MessageCount` 统计物理日志中的全部 Message Entry，不会在 Replace 时归零，因此不等于恢复后的有效消息数。
- 三十天清理依据 Session ID 中的创建时间，不依据最后修改时间。一个最近恢复过的旧会话仍可能因原始创建时间过期而被删除。
- 恢复选择、对象切换和测试已经实现，但当前生产 TUI 没有命令或按键调用 `startResume`。现有测试直接调用内部方法，所以准确表述是“恢复核心已实现，用户入口尚未接线”。

这些边界不否定 JSONL 重放模型，但决定了简历和博客不能把它表述为已完成崩溃一致性验证的数据库式会话系统。

## 完整流程

```text
Runner 修改 Conversation
  -> 解锁后同步触发 OnAppend / OnReplace
  -> Writer 加锁
  -> JSON Marshal + append newline + fsync
  -> 进程退出
  -> List 扫描会话元数据
  -> OpenContext + Load 顺序重放
  -> Replace 清空旧状态
  -> 修剪悬空 ToolCall 尾部
  -> 新 Writer + Compact Runtime + Conversation
  -> Runner 继续使用恢复后的有效历史
```

## 测试验证了什么

Session 测试覆盖新目录、消息追加、Compact Replace、列表标题与 Model、坏行跳过、悬空 ToolCall 修剪和过期清理。Conversation 测试覆盖消息顺序、Hook、Replace 和复制语义。TUI 测试覆盖候选排序、键盘选择、取消和内部恢复方法，但没有覆盖从真实用户命令进入恢复界面的端到端路径。

## 小结

PseudoClaude 用 JSONL 保存“消息怎样变化”，而不是反复保存一份不可解释的最终数组。Replace 事件让追加日志可以表达上下文快照，Loader 再通过顺序重放和工具调用尾部修复得到模型可接受的历史。

下一篇转向另一类持久上下文：项目和用户编写的 `PSEUDOCLAUDE.md` 如何分层加载、展开引用并进入稳定 System Prompt。
