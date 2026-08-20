---
title: 为什么要做一个终端 Coding Agent
description: PseudoClaude 系列开篇：从工程目标、系统边界和源码阅读路径开始。
date: 2026-08-21
order: 1
tags:
  - PseudoClaude
  - AI Agent
  - Go
---

PseudoClaude 的目标是实现一个 Claude Code 风格的本地终端 Coding Agent。项目仓库位于：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)。

从工程角度看，Coding Agent 不是“聊天界面加几个本地命令”。它需要解决的是一个受控执行问题：模型可以在本地工程中读取文件、搜索代码、编辑文件、执行命令、调用外部工具，并在每一步之后根据观察结果继续推进任务。系统必须同时保证这些动作可追踪、可限制、可恢复。

一个最小闭环可以写成：

```text
用户输入
  -> 构造模型请求
  -> 接收流式文本和 tool call
  -> 执行工具
  -> 将工具结果写回会话
  -> 再次请求模型
  -> 直到停止条件成立
```

这个闭环对应 PseudoClaude 中的主要实现：

```text
cmd/PseudoClaude/main.go
  -> internal/tui.Model
  -> internal/agent.Runner
  -> internal/llm.Provider
  -> internal/tools.Registry
  -> internal/conversation.Conversation
```

## 工程目标

PseudoClaude 的核心目标可以拆成五类。

第一类是交互目标。应用运行在终端中，使用 Bubble Tea 管理输入框、滚动视图、状态栏、审批视图和 provider 选择界面。这个部分位于 `internal/tui`。

第二类是执行目标。系统需要一个稳定的 Agent Runner，负责多轮请求、流式收集、工具执行、工具结果回灌、停止原因判定。这个部分集中在 `internal/agent/runner.go`、`internal/agent/tools.go` 和 `internal/agent/event.go`。

第三类是工具目标。模型不能直接操作文件系统或 shell，它只能发出结构化 tool call。工具层通过 `tools.Tool` 接口、`tools.Definition` 元数据和 `tools.Registry` 注册表把读文件、写文件、编辑文件、搜索、命令执行、MCP 工具、Skill 工具、Agent 工具统一起来。

第四类是安全目标。只要系统允许模型写文件和执行命令，权限控制就必须位于工具执行前。PseudoClaude 将权限模式、路径沙箱、危险命令黑名单、策略文件和交互式审批放在 `internal/permission`，并在 `agent.executeOneTool` 的执行路径上调用。

第五类是状态目标。长任务会产生大量消息和工具结果，系统需要会话持久化、上下文压缩和长期记忆。相关实现分布在 `internal/conversation`、`internal/session`、`internal/compact` 和 `internal/memory`。

## 为什么入口值得先读

复杂项目的阅读顺序不应从目录树开始，而应从进程入口开始。PseudoClaude 的入口是 `cmd/PseudoClaude/main.go`，它承担的是总装配职责：

```text
Load config
Load instructions
Create memory manager
Load hook engine
Create permission engine
Create worktree manager
Create tool registry
Load skills
Load MCP tools
Load subagent catalog
Create task manager
Create team manager
Register Agent and task tools
Create tui.Model
Run Bubble Tea program
```

这条装配线说明了项目的真实依赖方向：TUI 不直接创建工具，Runner 不直接加载配置，Provider 不知道权限策略，工具执行不知道 UI 如何展示审批。每一层只接收自己需要的依赖。

入口代码中最值得注意的是链式配置：

```go
model := tui.New(cfg.Providers, cwd, registry, permissionEngine).
    WithAgentHandle(agentHandle).
    WithWorktrees(worktreeMgr).
    WithSkills(skillCatalog, activeSkills).
    WithHooks(hookEngine).
    WithSubAgents(subagentCatalog, taskManager).
    WithTeams(teamManager).
    WithPersistentContext(instructionResult.Content, memoryManager).
    WithStartupStatus(startup...)
```

这段代码体现了一个重要设计：`tui.New` 只创建基础交互模型，MCP、Skill、Hook、Team、Memory 等能力通过 `WithXxx` 注入。入口能够表达装配顺序，TUI 内部也能保持可测试的状态结构。

## 系统边界

PseudoClaude 不是一个 Web 服务。它没有 HTTP 路由、数据库用户表或后端控制器。它是一个终端本地执行器，边界更接近以下形态：

```text
Terminal process
  -> local workspace
  -> model provider API
  -> optional MCP servers
  -> user/project configuration
```

因此，系统关注点也不同于传统服务端项目。传统 Web 服务通常围绕请求生命周期、数据库事务和 API 合同设计。PseudoClaude 围绕 Agent 轮次设计：一次用户输入可能触发多次模型请求、多个工具批次、若干权限审批、一次上下文压缩和一次记忆更新。

这也是 `agent.Event` 存在的原因。Runner 不直接操作 TUI，而是把执行过程转成事件：

```go
type Event struct {
    Type       EventType
    Iteration  int
    Text       string
    Message    string
    ToolCall   *llm.ToolCall
    ToolResult *ToolResult
    Approval   *ApprovalRequest
    Usage      *llm.Usage
    Stop       *Stop
    Err        error
}
```

事件边界将执行引擎和界面解耦。TUI 可以显示文本增量、工具状态和审批界面；后台 task manager 可以消费同一类事件并记录任务结果。

## 模块划分

从源码看，PseudoClaude 可以按职责划分为七个部分：

```text
交互层       internal/tui, internal/command
执行层       internal/agent
模型适配层   internal/llm
工具层       internal/tools, internal/mcp, internal/skills
状态层       internal/conversation, internal/session, internal/compact, internal/memory
安全层       internal/permission, internal/hook, internal/worktree
协作层       internal/task, internal/subagent, internal/team
```

这种划分不是为了制造目录，而是为了限制耦合。

`internal/llm` 只负责把内部请求转换为不同 provider 的 SDK 请求，并将 provider 的流式返回统一成 `llm.StreamEvent`。

`internal/tools` 只负责工具定义、执行和结果封装，不负责判断用户是否允许执行。

`internal/permission` 只负责决策，不直接运行工具。

`internal/agent` 将这些组件串起来，但通过接口持有依赖，例如 `llm.Provider`、`tools.Registry`、`permission.Engine`、`MemoryUpdater`。

## 阅读路径

阅读 PseudoClaude 时，可以按以下路径建立完整心智模型：

1. 从 `cmd/PseudoClaude/main.go` 读装配过程，确认系统有哪些运行时依赖。
2. 读 `internal/tui/tui.go`，理解应用状态、输入处理、provider 选择和事件消费。
3. 读 `internal/agent/runner.go`，理解 ReAct 主循环。
4. 读 `internal/agent/tools.go` 和 `internal/tools/registry.go`，理解工具批处理、权限介入和统一结果格式。
5. 读 `internal/llm/provider.go`、`openai.go`、`anthropic.go`，理解 provider 适配层如何统一消息、工具和 usage。
6. 读 `internal/conversation`、`internal/session`、`internal/compact`，理解长会话如何落盘、恢复和压缩。
7. 读 `internal/subagent`、`internal/task`、`internal/team`、`internal/worktree`，理解并行任务和工作区隔离。

## 系列文章的组织方式

后续文章会按实现链路推进，而不是按宣传卖点推进。

第 2 篇先搭建最小终端 Agent，说明输入、输出、provider 和 Runner 的最小形态。

第 3 篇分析 `Runner.run`，重点解释多轮循环、工具调用、结果回灌、Plan Mode 和停止条件。

第 4 篇分析工具系统、权限系统和 Hook，说明副作用如何在执行前被拦截。

第 5 篇分析会话、压缩和记忆，说明长任务如何避免上下文失控。

第 6 篇分析 MCP 与 Skill，说明扩展能力如何进入工具注册表和 prompt。

第 7 篇分析子 Agent、Team 和 worktree，说明并行任务如何避免污染主工作区。

第 9 至第 12 篇补足入口装配、Provider 适配、TUI 状态机和测试边界。

## 小结

PseudoClaude 的核心不在于调用某个模型 API，而在于把模型输出、工具执行、权限决策、上下文状态和多 Agent 协作组织成可维护的 Go 程序。

这个项目可以作为一个 Agent 系统的工程样本：模型是不确定的，但程序边界必须确定；工具有副作用，但执行入口必须统一；会话会增长，但上下文管理必须可恢复；协作可以并行，但文件系统边界必须清晰。
