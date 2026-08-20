---
title: PseudoClaude
description: 从零复盘一个 Go 终端 Coding Agent 的设计、实现与面试表达。
icon: mdi:robot-outline
order: 1
tags:
  - Projects
  - Go
  - AI Agent
  - Coding Agent
---

PseudoClaude 是我用 Go 写的终端 Coding Agent。它把大模型、工具调用、权限审批、上下文压缩、长期记忆、MCP、Skill、Hook、后台任务、子 Agent 和 Git worktree 协作放进一个本地 TUI。

这个专栏不是一份 README，也不是给招聘 JD 背答案的项目包装。它更像一次源码复盘：我会从零开始讲，如果要做一个 Claude Code 风格的终端 Agent，第一行代码应该怎么落，模块边界为什么这样切，哪些地方是 demo，哪些地方开始变成工程系统。

推荐阅读顺序：

1. [为什么我要做一个终端 Coding Agent](./01-why-build-pseudoclaude)
2. [从零搭一个最小可用终端 Agent](./02-bootstrap-terminal-agent)
3. [Runner、Provider 与 ReAct 主循环](./03-react-runner-provider)
4. [让模型安全地动手：工具系统、权限引擎与 Hook](./04-tools-permissions-hooks)
5. [长会话不失忆：Conversation、Session、Memory 与上下文压缩](./05-context-memory-compact)
6. [把能力做成生态：MCP、Skill 与延迟加载](./06-mcp-skills-extension)
7. [从子 Agent 到 Team Lead：后台任务、Git worktree 与 mailbox 协作](./07-subagents-team-worktree)
8. [从 vibe coding 到真正拥有项目](./08-from-vibe-to-ownership)

读完这个系列，你应该能回答三个问题：

- 一个 Coding Agent 的主循环到底是什么。
- 如何让模型读文件、改代码、跑命令，同时把风险关在笼子里。
- 如何把一个 vibe coding 出来的项目，拆成自己能讲清楚、能维护、能继续演进的系统。

