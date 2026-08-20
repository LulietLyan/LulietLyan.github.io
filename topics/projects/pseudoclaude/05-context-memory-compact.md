---
title: 长会话不失忆：Conversation、Session、Memory 与上下文压缩
description: PseudoClaude 如何保存会话、恢复上下文、落盘大工具结果，并用两层压缩支撑长时间编程。
date: 2026-08-21
order: 5
tags:
  - PseudoClaude
  - Context
  - Memory
  - Agent
---

一个 Coding Agent 真正跑起来后，很快会遇到一个朴素问题：上下文会爆。

模型读文件，工具结果可能几万字；模型跑测试，日志可能很长；用户连续聊几个小时，历史消息会不断累积。只靠“把全部 messages 塞回模型”是不可能长期工作的。

PseudoClaude 的上下文系统由几层组成：

```text
Conversation  内存中的消息事实源
Session       JSONL 会话持久化与恢复
Compact       工具结果落盘 + 模型摘要压缩
Prompt        系统提示词和动态环境
Instructions  项目/用户级指令加载
Memory        LLM 自动提取长期记忆
```

这篇讲它们如何配合。

## Conversation：内存里的事实源

`internal/conversation/conversation.go` 定义了 `Conversation`：

```go
type Conversation struct {
    mu       sync.Mutex
    messages []llm.Message
    hooks    Hooks
}
```

它提供几类追加方法：

- `AddUser(text)`
- `AddAssistant(text)`
- `AddAssistantToolCalls(calls)`
- `AddToolResult(result)`
- `ReplaceMessages(reason, messages)`

这里的设计很克制：Conversation 不懂 UI、不懂 provider、不懂文件系统。它只负责维护消息数组。

但它有一个关键扩展点：

```go
type Hooks struct {
    OnAppend  func(llm.Message)
    OnReplace func(ReplaceReason, []llm.Message)
}
```

这让持久化可以外挂在消息事实源上，而不是散落在 Runner 里。

## Session：用 JSONL 保存每一次消息变化

Session 目录结构大致是：

```text
.PseudoClaude/sessions/<session-id>/
  conversation.jsonl
  tool-results/
```

`session.Context` 定义在 `internal/session/context.go`：

```go
type Context struct {
    ID        string
    Dir       string
    JSONLPath string
    SpillDir  string
}
```

TUI 初始化时会创建 `session.Writer`，然后：

```go
m.conv = conversation.New(writer.Hooks())
```

`Writer.Hooks()` 把 Conversation 的 append/replace 转成 JSONL 写入：

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

普通消息写成：

```json
{"type":"message","role":"user","content":"...","ts":...}
```

工具调用和工具结果也会写进去。

如果发生上下文替换，比如压缩，Writer 会先写一条：

```json
{"type":"replace","reason":"compact","ts":...}
```

再写替换后的完整 messages。

## replace marker 为什么重要

如果 JSONL 只是 append-only，那么压缩后的上下文很难恢复。因为旧消息仍在文件里，恢复时不知道哪些旧消息已经被摘要替换。

所以 `replace` marker 的语义是：

```text
从这里开始，之前重建出的 messages 全部作废，
后续 message 才是新的 conversation 状态。
```

恢复逻辑在 `internal/session/load.go`：

```go
switch entry.Type {
case EntryReplace:
    result.Messages = nil
case EntryMessage, "":
    result.Messages = append(result.Messages, messageFromEntry(entry))
}
```

最后还会调用 `truncateDanglingToolCalls`。

这是为了避免恢复到非法 tool calling 状态。比如最后一条 assistant message 有 tool calls，但后面缺少对应 tool result，恢复后再发给 provider 可能直接报错。它会截断到那条未完成 tool call 之前。

## Prompt：stable system 和动态 environment

Prompt 拼装在 `internal/prompt`。

`BuildSystemPrompt` 会把固定模块和可选模块拼起来。固定模块包括：

- Identity
- System Constraints
- Task Modes
- Action Execution
- Tool Use
- Tone Style
- Text Output

可选模块包括：

- Custom Instructions
- Available Skills
- Long-Term Memory

Runner 每轮还会调用 `GatherEnvironment` 生成动态环境：

```text
Runtime environment:
- working directory: ...
- platform: ...
- date: ...
- git status: ...
- version: ...
- provider: ...
- model: ...
```

这两类信息分开很有意义：稳定规则不需要每轮变化，环境信息则可能因为 worktree、provider、git status 改变而变化。

## Instructions：项目、项目本地、用户三级加载

`internal/instructions/loader.go` 加载三层指令：

```text
<project>/PSEUDOCLAUDE.md
<project>/.PseudoClaude/PSEUDOCLAUDE.md
~/.PseudoClaude/PSEUDOCLAUDE.md
```

每个来源会被包成：

```md
## Source: project-root (/path/to/PSEUDOCLAUDE.md)

...
```

然后作为 Custom Instructions 放进 system prompt。

指令文件支持：

```text
@include relative/path.md
```

include 展开在 `internal/instructions/include.go`。它有几个边界：

- 只能相对路径，不能绝对路径。
- 不能越过当前 layer boundary。
- 最大深度默认 5。
- 检测循环 include。
- 检测二进制文件。

这让项目可以把长指令拆成多个文件，但不会随便读出边界外内容。

## Compact Layer 1：大工具结果先落盘

上下文压缩入口在 `internal/compact/summary.go`：

```go
func ManageContext(ctx context.Context, in ManageInput) (ManageOutput, error)
```

它首先调用 Layer 1：

```go
layer1 := OffloadToolResults(messages, in.Runtime)
```

实现位于 `internal/compact/layer1.go`。

Layer 1 的目标不是总结，而是把过大的工具结果移出 prompt。

触发条件：

- 单个工具结果超过 `SingleToolResultLimitBytes = 50000`。
- 同一轮工具结果总量超过 `ToolRoundAggregateLimitBytes = 200000`。

落盘路径在当前 session 的：

```text
tool-results/<call-id>.txt
```

原本的 tool result content 会被替换成预览：

```text
[content offloaded] original size: 123456 bytes
[saved to] .PseudoClaude/sessions/.../tool-results/call_xxx.txt
[head preview]
...

完整内容已保存到上述路径；如需完整内容，请使用文件读取工具读取该路径。
```

这一步很关键。它比直接摘要工具结果更稳，因为完整原文还在磁盘上。模型如果需要细节，可以重新调用读文件工具读取落盘路径。

## Compact Layer 2：接近窗口时再摘要旧上下文

Layer 1 后，`ManageContext` 会估算当前 tokens：

```go
current := EstimateWithAnchor(messages, in.Runtime.Snapshot().UsageAnchor)
```

如果接近 context window，就触发 Layer 2：

```go
shouldAutoCompact(current, contextWindow)
```

Layer 2 调 `compactConversation`：

```text
summarize
  -> BuildSummaryPrompt
  -> provider.Stream
  -> extractSummary

SelectRecent
  -> 保留最近消息
  -> ExpandToToolBoundary

buildCompactedMessages
  -> 历史摘要
  -> 边界提醒
  -> 最近消息

Conversation.ReplaceMessages
```

摘要提示词要求输出固定结构：

1. 主要请求和意图
2. 关键技术概念
3. 文件和代码位置
4. 错误与修复
5. 问题解决过程
6. 用户消息原文记录
7. 待办任务
8. 当前工作状态
9. 可能的下一步

压缩后的 conversation 会以一条“历史会话摘要”开头，然后保留最近上下文。

还有一条边界提醒很重要：

```text
上方摘要不是代码、错误、工具结果或用户原话的完整原文；
需要细节时，请重新读取相关文件、记录或预览中给出的落盘路径。
```

这是在提醒模型：摘要不是事实原文，不要脑补。

## Recent 保留工具边界

`internal/compact/recent.go` 里有一个细节：`SelectRecent` 不只是粗暴保留最后 N 条消息。

如果保留起点落在某个 tool result 上，它会向前扩展到对应 tool call：

```go
func ExpandToToolBoundary(messages []llm.Message, start int) int
```

原因同样是 provider 协议要求。工具结果必须和之前的工具调用配对，否则上下文结构会坏。

这类细节很不起眼，但它决定了压缩后的上下文能不能继续被模型 API 接受。

## Memory：长期记忆不是会话摘要

Compact 解决的是当前会话上下文窗口。Memory 解决的是跨会话的稳定知识。

Memory 在 `internal/memory`，分两级：

```text
.PseudoClaude/memory          // project memory
~/.PseudoClaude/memory        // user memory
```

每一级有一个 `MEMORY.md` 索引。`Manager.RefreshIndex` 会读取两级索引，拼成：

```md
## Project Memory
...

## User Memory
...
```

这段文本进入 system prompt 的 Long-Term Memory 模块。

每次主 Agent 正常结束时，Runner 会调用：

```go
r.Memory.UpdateAsync(context.Background(), memory.UpdateInput{
    Messages: messages[startLen:],
})
```

注意是异步更新，不阻塞用户。

更新方式也不是手写规则，而是让模型输出 JSON operations：

```json
[
  {
    "action": "create",
    "level": "project",
    "type": "project_knowledge",
    "title": "...",
    "summary": "...",
    "slug": "...",
    "content": "..."
  }
]
```

支持动作：

- `create`
- `update`
- `delete`
- `noop`

`Store.Apply` 会把 operation 写成 Markdown note，并更新 `MEMORY.md` 索引。

## 为什么 Memory 和 Compact 要分开

它们看起来都在“记东西”，但目标不同。

Compact：

- 面向当前会话。
- 解决上下文窗口不够。
- 保留工作状态、最近消息、工具边界。
- 摘要替换 Conversation。

Memory：

- 面向跨会话。
- 记录稳定偏好、项目知识、纠正反馈、参考材料。
- 写入 `.PseudoClaude/memory` 或 `~/.PseudoClaude/memory`。
- 下次启动时加载索引。

如果把它们混在一起，会出现两种问题：

- 会话压缩过度保存长期垃圾。
- 长期记忆里塞满一次性中间状态。

PseudoClaude 把它们拆开，结构会清楚很多。

## 长会话的完整链路

把这些模块串起来，就是：

```text
Runner 每轮开始
  -> Compact.ManageContext
      -> Layer 1 工具结果落盘
      -> Layer 2 摘要压缩
      -> Conversation.ReplaceMessages
      -> Session Writer 写 replace marker

Runner 请求模型
  -> Prompt.BuildSystemPrompt
      -> Instructions
      -> Skill catalog
      -> Memory index
  -> GatherEnvironment

Runner 结束
  -> Memory.UpdateAsync
      -> provider.Stream 生成 JSON ops
      -> Store.Apply 写 memory notes
```

这就是 PseudoClaude 能支撑长时间连续编程会话的基础。

它不是靠一个巨大的 prompt 硬塞，而是把短期上下文、长期记忆、工具原文、摘要状态拆成不同存储层，各自承担不同职责。

