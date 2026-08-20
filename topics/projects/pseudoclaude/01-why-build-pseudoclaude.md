---
title: 为什么我要做一个终端 Coding Agent
description: PseudoClaude 系列开篇：从需求、边界和工程目标开始，而不是从炫技开始。
date: 2026-08-21
order: 1
tags:
  - PseudoClaude
  - AI Agent
  - Go
---

写 PseudoClaude 的动机很简单：我想把 Claude Code 那类终端 Coding Agent 的核心机制自己做一遍。

更准确一点说，我想知道一个 Agent 从“能聊天”到“能在本地工程里持续干活”，中间到底差了哪些工程结构。

一开始想象中的 Agent 很浪漫：

```text
用户说需求
模型理解需求
模型读代码
模型改代码
模型跑测试
模型继续修
最后交付
```

但真正落到代码里，会立刻遇到一些不浪漫的问题：

- 模型怎么读文件，读到的结果怎么回灌给下一轮。
- 模型怎么改文件，怎么避免误改。
- 命令怎么执行，危险命令怎么拦。
- 对话越来越长，工具结果越来越大，怎么不爆上下文。
- 用户想继续上次会话，怎么恢复。
- 工具很多时，怎么不把所有工具说明全塞进 prompt。
- 一个 Agent 忙不过来时，能不能派子 Agent 并行调查。
- 子 Agent 改文件，怎么不污染主工作区。

这些问题拼起来，就是 PseudoClaude 的真实边界。

## 它不是一个后端服务

PseudoClaude 不是 REST API 服务，也不是一个 Web 后台。它更像一个本地交互式执行器：

```text
Terminal UI
  -> Agent Runner
  -> LLM Provider
  -> Tool Registry
  -> Local Workspace
```

所以我没有从数据库、HTTP 路由、用户系统开始，而是先做三件事：

1. 一个终端界面，能持续接收用户输入和显示流式输出。
2. 一个 Agent 主循环，能请求模型、执行工具、回灌结果。
3. 一组安全边界，能决定哪些工具可以执行，哪些必须询问用户。

项目入口在 `cmd/PseudoClaude/main.go`。这个文件像一条总装配线：加载配置、初始化记忆、权限、Hook、worktree、工具注册表、Skill、MCP、子 Agent、任务系统、团队系统，最后创建 `tui.Model` 并运行。

如果只记一个主线，可以这样记：

```text
main.go 装配所有依赖
  -> tui.New(...) 创建交互模型
  -> 用户输入触发 Runner.Run
  -> Runner 驱动 LLM 和工具
  -> Conversation / Session / Compact 维持上下文
```

## 五层架构只是事后总结

简历里我把它写成五层：

- 交互层：`internal/tui`
- 引擎层：`internal/agent`、`internal/llm`
- 工具层：`internal/tools`、`internal/mcp`、`internal/skills`
- 记忆层：`internal/conversation`、`internal/session`、`internal/compact`、`internal/memory`
- 安全层：`internal/permission`、`internal/hook`、`internal/worktree`

但真实构建过程不是先画漂亮架构图，而是从一个问题滚到下一个问题。

先有 TUI，因为没有交互就没法用。

然后有 Runner，因为 TUI 不能直接写一堆模型调用逻辑。

然后有 Tool Registry，因为工具会越来越多，不能靠 if else 分发。

然后有权限系统，因为一旦模型能写文件和跑命令，风险就必须有统一入口管理。

然后有 Session 和 Compact，因为长会话会把上下文撑爆。

最后才有 Skill、MCP、子 Agent、Team，因为当主循环稳定后，扩展能力才有意义。

## 这个系列怎么读

这个系列会尽量按“从零搭建”的顺序写：

1. 先搭最小终端 Agent：输入、输出、请求模型。
2. 再把一次请求升级成 ReAct loop：模型能调用工具。
3. 加工具系统：文件、搜索、命令、统一注册。
4. 加权限和 Hook：让副作用可控。
5. 加 Conversation、Session、Compact、Memory：让长会话能持续。
6. 加 MCP 和 Skill：让工具生态可扩展。
7. 加 subagent、task、team、worktree：让大型任务能并行和隔离。

我会尽量避免“这个文件做了什么”的流水账，而是解释每个模块为什么出现，以及它在源码里具体怎么落地。

## 最核心的一句话

PseudoClaude 的核心价值不是“我调用了大模型 API”，而是：

```text
我把模型输出、工具执行、权限审批、上下文持久化和多 Agent 协作
收敛到统一的事件流和接口里。
```

这也是一个 Coding Agent 从 toy demo 变成工程项目的分界线。

