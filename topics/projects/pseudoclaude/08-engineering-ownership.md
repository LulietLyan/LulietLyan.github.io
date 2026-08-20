---
title: 从项目实现到工程掌控
description: PseudoClaude 系列阶段性收束：如何把复杂 Agent 项目拆成可解释、可维护、可演进的工程系统。
date: 2026-08-21
order: 8
tags:
  - PseudoClaude
  - Project Review
  - AI Agent
  - Engineering
---

PseudoClaude 是一个链路较长的本地 Agent 项目。它同时包含终端交互、模型流式输出、工具调用、权限审批、会话持久化、上下文压缩、MCP、Skill、子 Agent、Team 和 Git worktree。

复杂系统的风险通常不在单个函数，而在边界之间：谁拥有状态，谁允许副作用，谁负责恢复，谁决定停止，谁向用户暴露中间过程。本文从工程掌控的角度，对 PseudoClaude 做一次阶段性收束。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

## 主链路优先

阅读复杂项目时，目录树只能说明模块位置，不能说明运行时顺序。PseudoClaude 的主链路可以概括为：

```text
cmd/PseudoClaude/main.go
  -> tui.New(...).Run()
  -> 用户输入进入 TUI
  -> TUI 构造 agent.Request
  -> runner.Run
  -> provider.Stream
  -> streamCollector.collect
  -> executeToolCalls
  -> Conversation.AddToolResult
  -> 下一轮模型请求
```

这条线比目录树重要。任何模块都应放回这条主链路中解释：

- `permission` 位于工具执行前，决定 allow、deny 或 ask。
- `hook` 位于 session、prompt、compact、tool、notification、stop 等生命周期点。
- `compact` 位于每轮模型请求前，必要时先降低上下文体积。
- `memory` 在主 Agent 完成后异步更新长期记忆。
- `skill` 通过 catalog 出现在 system prompt 中，通过 `load_skill` 进入活跃上下文。
- `mcp` 在启动阶段连接外部 server，并将远端能力注册成工具。
- `subagent` 和 `team` 从 `Agent` 工具进入，最终仍复用 Runner。

## 工程掌控的三个层次

对一个 Agent 系统的掌控至少包含三层。

第一层是运行掌控。系统可以正常启动、选择 provider、接收用户输入、执行工具、写入会话，并在任务结束后返回稳定状态。

第二层是边界掌控。每个模块的职责可被清晰解释：TUI 负责交互状态，Runner 负责执行循环，Provider 负责协议适配，Registry 负责工具发现和执行入口，Permission 负责副作用决策，Session 负责持久化，Compact 负责上下文体积管理。

第三层是演进掌控。新增工具、接入新 provider、添加新的 hook event、扩展 skill 格式或增强 team backend 时，不需要重写主循环。

PseudoClaude 的重要价值在第二层和第三层。功能数量本身不是关键，关键是这些功能是否通过稳定接口进入系统。

## 统一接口

项目中有几类统一入口值得保留。

模型协议统一到 `llm.Provider`：

```go
type Provider interface {
    Name() string
    Model() string
    Stream(ctx context.Context, req Request) <-chan StreamEvent
}
```

Anthropic 和 OpenAI 的 SDK、消息格式、system prompt 结构、tool call 返回时机并不一致，但 Runner 只消费 `StreamEvent`。这使执行循环不依赖具体 provider。

工具协议统一到 `tools.Tool`：

```go
type Tool interface {
    Definition() Definition
    Execute(ctx context.Context, input json.RawMessage, env Env) Result
}
```

内置文件工具、命令工具、MCP 工具、Skill 工具、Agent 工具都可以注册进 `tools.Registry`。Runner 不关心工具来源，只关心工具名、schema、安全级别和执行结果。

执行状态统一到 `agent.Event`。TUI、后台任务和其他消费者可以通过事件理解 Runner 的运行状态，而不是直接侵入 Runner 内部。

会话事实统一到 `conversation.Conversation`。用户消息、助手文本、tool calls、tool results 和 compact replace marker 都通过同一个结构进入后续模型请求。

多 Agent 执行统一复用 Runner。子 Agent 和 team member 不是独立的一套执行引擎，而是从父 Runner 派生配置、工具和上下文后运行。

## 安全边界

Agent 系统中的安全边界不能停留在 prompt。PseudoClaude 将副作用控制落在工具执行路径中：

```text
executeOneTool
  -> dispatchPreToolHook
  -> permissionCheckedTool
  -> requestApproval / executeAllowedTool
  -> dispatchPostToolHook
```

这条路径说明两个原则。

第一，Hook 可以在工具执行前阻断，也可以在工具执行后观察结果，但它不是唯一安全边界。

第二，Permission Engine 在调用具体工具前做决策，且决策结果包含来源和理由。交互式审批通过 `EventApproval` 交给 TUI，而不是在工具内部阻塞 UI。

Plan Mode 也使用同样原则。它不仅在提示词中要求模型只读，还在 `prepareRequest` 中只暴露 `SafetyReadOnly` 工具，并在执行期通过 `AllowedSafety` 再做一次限制。

## 状态边界

长会话中的状态有多种来源，不能混在一个字符串里。

PseudoClaude 至少区分了四类状态：

- 短期会话：`conversation.Conversation` 中的消息序列。
- 持久会话：`session.Writer` 写入的 JSONL 文件。
- 大工具结果：compact runtime 管理的 spill 文件。
- 长期记忆：`memory.Manager` 维护的项目和用户记忆。

这种拆分的意义在于恢复和压缩。Conversation 负责提供模型请求所需的消息；Session 负责断点恢复；Compact 负责在上下文接近限制时降低消息体积；Memory 负责把跨会话信息以摘要方式重新注入 system prompt。

如果这些状态都放进单个 prompt 字符串，系统很难判断哪些内容可以压缩，哪些内容必须保留，哪些内容已经被摘要替代。

## 可演进点

当前实现仍有可以继续加强的地方。

工具执行可以增加贯穿 Runner、Hook、Permission、Tool Result 的 trace id，使长任务排查更直接。

MCP 工具的非文本结果可以进入 artifact 存储，而不是只保留文本结果。

Memory 更新依赖模型输出 JSON operations，可以增加 schema retry、diff 预览和更严格的冲突处理。

Team 的外部 terminal backend 可以继续增强，使 in-process backend 与外部进程执行具备更一致的生命周期管理。

Worktree 合并可以提供结构化 patch summary，帮助用户在主工作区审查子 Agent 结果。

权限系统可以增加 dry-run explain，让用户在执行前看到某个 tool call 会被 allow、ask 或 deny 的具体原因。

这些改进方向都指向同一个目标：减少隐式行为，增强系统可观察性。

## 小结

PseudoClaude 的工程重点不在于把所有能力堆进一个终端应用，而在于把能力放到可解释的边界内：

```text
Provider 负责协议
Runner 负责循环
Registry 负责工具入口
Permission 负责副作用决策
Conversation/Session/Compact/Memory 负责状态
Task/Subagent/Team/Worktree 负责协作和隔离
TUI 负责交互呈现
```

当一个项目能够从入口装配讲到执行循环，从工具接口讲到权限审批，从 JSONL 持久化讲到上下文压缩，从 Agent 工具讲到 Team mailbox，它就从可运行程序进一步成为可以持续维护和扩展的工程系统。
