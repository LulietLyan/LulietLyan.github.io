---
title: 从项目实现到工程掌控
description: PseudoClaude 系列收束：如何把复杂项目拆成自己能讲、能维护、能继续演进的系统。
date: 2026-08-21
order: 8
tags:
  - PseudoClaude
  - Project Review
  - AI Agent
  - Engineering
---

PseudoClaude 是一个典型的“功能很多、链路很长”的工程项目。

它不只是一次模型调用，也不只是几个本地工具的拼接。真正让它变复杂的，是很多能力同时存在：终端交互、模型流式输出、工具调用、权限审批、会话持久化、上下文压缩、MCP、Skill、子 Agent、Team、Git worktree。

做完这样的项目之后，最重要的事情不是继续往上堆功能，而是回过头确认我们是否真正掌控了它。所谓掌控，至少包括三层：

```text
能运行
能解释
能维护和演进
```

只做到第一层，还只是 demo。能讲清楚第二层，才算真的开始拥有项目。能做到第三层，才是工程能力。

这篇是 PseudoClaude 系列的收束：如何把一个复杂终端 Agent，拆成自己能解释、能维护、能继续演进的工程系统。

## 不要从文件树开始，要从主链路开始

刚开始复盘一个复杂项目，很容易从目录树陷进去：

```text
internal/agent
internal/tools
internal/tui
internal/mcp
internal/compact
internal/team
...
```

每个目录都看一点，很快就会觉得自己什么都看了，又什么都没懂。

更好的方式是先找主链路。

PseudoClaude 的主链路是：

```text
cmd/PseudoClaude/main.go
  -> tui.New(...).Run()
  -> 用户输入 submitAgentTextWithTools
  -> runner.Run
  -> provider.Stream
  -> collector.collect
  -> executeToolCalls
  -> Conversation.AddToolResult
  -> 下一轮
```

只要这条线通了，项目就有了骨架。

之后读任何模块，都问它一句：

```text
它插在主链路的哪个位置？
```

例如：

- permission 插在工具执行前。
- hook 插在 prompt submit、tool use、compact、stop 等生命周期点。
- compact 插在每轮模型请求前。
- memory 插在主 Agent 完成后异步更新。
- skill 插在 prompt catalog 和 `load_skill` 工具里。
- mcp 插在启动注册工具阶段。
- subagent 插在 `Agent` 工具调用阶段。
- team 插在 `Agent` 工具的 team 分支。

这比死背目录名有效得多。

## 简历上的话要能还原成函数

项目经历里最容易写虚。比如：

> 实现 ReAct 与 Plan Mode 双模式驱动 LLM 自主完成代码阅读、编辑、搜索与验证。

这句话要变成代码事实：

- ReAct 主循环在 `internal/agent/runner.go` 的 `Runner.run`。
- 工具定义来自 `Registry.DefinitionsFiltered`。
- 模型输出由 `Provider.Stream` 和 `streamCollector.collect` 收集。
- 工具调用通过 `executeToolCalls` 执行。
- 工具结果通过 `Conversation.AddToolResult` 回灌。
- Plan Mode 在 `prepareRequest` 里只暴露 `SafetyReadOnly` 工具，并用 `AllowedSafety` 执行期兜底。

再比如：

> 实现权限模式、路径沙箱、危险命令检查、策略文件与交互式审批。

也要能还原：

- 权限模式在 `internal/permission/mode.go`。
- 检查入口是 `Engine.CheckWithContext`。
- 路径沙箱在 `sandboxTarget`。
- 危险命令黑名单在 `blacklist.go`。
- 审批事件在 `requestApproval` 发出 `EventApproval`。
- TUI 在 `updateApproving` 和 `finishApproval` 里处理用户选择。

你能把每一句简历变成“文件 + 函数 + 数据流”，面试时就不会虚。

## 项目的亮点不是功能多，而是统一入口多

PseudoClaude 看起来功能很多：

- TUI
- LLM provider
- tool calling
- permission
- hook
- session
- compact
- memory
- MCP
- skill
- subagent
- team
- worktree

但真正值得讲的不是“我有这么多功能”，而是这些功能没有各跑各的。

统一入口有几个：

第一，模型协议统一到 `llm.Provider`。

```text
OpenAI / Anthropic
  -> Provider.Stream
  -> StreamEvent
```

第二，工具统一到 `tools.Tool` 和 `tools.Registry`。

```text
内置工具 / MCP 工具 / Skill 工具 / Agent 工具
  -> Definition
  -> Execute
```

第三，执行过程统一到 `agent.Event`。

```text
文本 delta / 工具开始 / 工具结果 / 审批 / usage / stop
  -> TUI 或 task manager 消费
```

第四，会话事实统一到 `Conversation`。

```text
用户消息 / 助手消息 / tool calls / tool results / compact replace
  -> Conversation
  -> Session hooks
```

第五，多 Agent 统一复用 Runner。

```text
subagent / fork / team member
  -> child Runner
  -> RunToCompletion
```

统一入口越多，系统越能扩展。功能多但入口散，最后会变成维护灾难。

## 我会怎么向面试官讲这个项目

如果只有一分钟，我会这样讲：

> PseudoClaude 是一个 Go 写的终端 Coding Agent。我把它拆成 TUI 交互层、Runner 执行引擎、LLM Provider 适配层、工具生态层、上下文记忆层和安全协作层。用户输入经 Bubble Tea TUI 变成 `agent.Request`，Runner 执行 ReAct loop：请求模型、收集流式文本和工具调用、执行工具、把工具结果写回 Conversation，然后继续下一轮。工具层用统一 `tools.Tool` 接口和 Registry 管理内置工具、MCP 工具、Skill 工具和 Agent 工具；执行前统一经过 Hook 和 permission engine。长会话方面，Conversation 通过 hooks 自动写 JSONL，compact 模块先落盘大工具结果，再在接近上下文窗口时做模型摘要压缩。多 Agent 方面，`Agent` 本身是工具，调用后基于父 Runner 快照创建子 Runner，后台任务由 task manager 管理，文件隔离通过 Git worktree，团队协作则在 worktree 基础上加入 mailbox、member registry 和 shared task。

如果面试官继续追问，我会按模块展开：

- 问主循环：讲 `Runner.run`。
- 问模型适配：讲 `llm.Provider`。
- 问工具：讲 `tools.Registry` 和 `executeToolCalls`。
- 问安全：讲 `permission.CheckWithContext` 和 `EventApproval`。
- 问长会话：讲 JSONL、replace marker、Layer 1/2 compact。
- 问多 Agent：讲 `AgentTool`、`task.Manager`、worktree、mailbox。

关键是别一上来讲所有模块。先讲主链路，再根据追问展开。

## 这个项目也有明显可改进的地方

拥有项目不等于只讲优点。读完源码后，也要知道它哪里还能变好。

一些可以继续演进的方向：

1. 工具结果和权限规则可以有更细粒度的可观测性，比如 trace id 和结构化日志。
2. Skill specialized tool 默认 side effect 很保守，但可以支持 skill 显式声明安全级别。
3. MCP 非文本结果目前会 drop，可以设计 artifact 存储和引用。
4. Memory 依赖模型输出 JSON operations，可以加入更严格的 schema retry 和 diff 预览。
5. Team backend 现在 in-process 路径更完整，外部 terminal backend 还可以继续打磨。
6. Worktree 的结果合并策略还可以增强，比如自动生成 patch summary。
7. 权限策略可以提供 dry-run explain，让用户知道为什么 ask/deny。
8. TUI 可以补更强的任务树可视化和团队状态面板。

这些不是否定项目，而是证明你真的读过它。

一个项目如果只能讲“我实现了什么”，还停留在展示层；能讲“我为什么这样实现，以及下一步怎么改”，才进入工程层。

## 我从这个项目学到的几件事

第一，Agent 工程的核心不是 prompt，而是状态机。

模型当然重要，但真正让系统可靠的是：消息怎么流动、工具怎么执行、错误怎么回灌、审批怎么暂停、会话怎么恢复。

第二，安全边界必须落在执行器里。

提示词可以要求模型不要改文件，但真正可靠的是：Plan Mode 只暴露只读工具，执行阶段也拦截非只读工具；路径沙箱和危险命令黑名单优先于用户规则。

第三，长会话不是一个“大摘要”能解决的。

工具结果落盘、JSONL replace marker、最近消息保留、长期 memory，它们解决的是不同层级的问题。

第四，多 Agent 不是简单并发。

如果没有 task 生命周期、worktree 隔离、mailbox 通信和成员身份，多 Agent 只是一堆模型请求。PseudoClaude 真正值得学的是它把 Agent 变成可托管、可隔离、可通信的执行单元。

第五，复杂项目要通过系统化复盘沉淀成自己的能力。

这个过程大概是：

```text
先让系统完整跑起来
  -> 从入口读主链路
  -> 画模块数据流
  -> 把项目卖点还原到源码
  -> 写文档和博客
  -> 找下一步改进点
```

写博客本身就是项目复盘的一部分。因为只有写到能让别人看懂，才会发现哪些地方还没有真正想清楚。

## 收束

PseudoClaude 对我来说，不只是一个终端 Agent 项目，也是一种工程复盘方法的样本。

项目完成只是第一步。真正重要的是把它拆开、讲清楚、验证边界，并继续推动它演进。

掌控项目的标志，是我能从 `main.go` 讲到 `Runner.run`，从 `ToolCall` 讲到权限审批，从 JSONL 讲到上下文压缩，从 `Agent` 工具讲到 Team mailbox；也能诚实说出哪些地方还粗糙，下一步该怎么改。

这才是从项目实现走向工程掌控的真正转变。
