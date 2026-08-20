---
title: PseudoClaude
description: 一个 Go 终端 Coding Agent 的工程实现札记：Runner、工具系统、权限、上下文、MCP、Skill 与多 Agent 协作。
icon: mdi:robot-outline
order: 1
tags:
  - Projects
  - Go
  - AI Agent
  - Coding Agent
---

PseudoClaude 是一个使用 Go 编写的本地终端 Coding Agent。项目将大模型流式输出、工具调用、权限审批、会话持久化、上下文压缩、长期记忆、MCP、Skill、Hook、后台任务、子 Agent、Team 与 Git worktree 协作整合进一个 TUI 应用。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

这个专栏按工程实现展开，而不是按功能清单展开。每篇文章都会围绕一个稳定问题组织：入口如何装配依赖，Runner 如何驱动 ReAct 循环，工具如何统一注册和执行，权限如何落在副作用发生前，上下文如何持久化与压缩，扩展能力如何进入系统，多 Agent 如何通过任务生命周期和 worktree 隔离协作。

推荐阅读顺序：

1. [为什么要做一个终端 Coding Agent](./01-why-build-pseudoclaude)
2. [搭建一个最小可用终端 Agent](./02-bootstrap-terminal-agent)
3. [Runner、Provider 与 ReAct 主循环](./03-react-runner-provider)
4. [让模型安全地执行动作：工具系统、权限引擎与 Hook](./04-tools-permissions-hooks)
5. [长会话状态管理：Conversation、Session、Memory 与上下文压缩](./05-context-memory-compact)
6. [扩展能力的边界：MCP、Skill 与延迟加载](./06-mcp-skills-extension)
7. [从子 Agent 到 Team Lead：后台任务、Git worktree 与 mailbox 协作](./07-subagents-team-worktree)
8. [从项目实现到工程掌控](./08-engineering-ownership)
9. [入口装配：main.go 如何连接配置、工具、记忆与 TUI](./09-main-assembly)
10. [Provider 适配层：统一 Anthropic 与 OpenAI 流式协议](./10-provider-adapter)
11. [TUI 与 Slash Command：交互状态机如何驱动 Agent](./11-tui-command-state-machine)
12. [测试边界与可维护性：用 Go 测试约束 Agent 系统](./12-testing-maintainability)

读完这个系列，应该能够从源码层面解释四个问题：

- `cmd/PseudoClaude/main.go` 如何把配置、工具、权限、Hook、记忆、MCP、Skill、Team 和 TUI 装配为一个进程。
- `internal/agent.Runner` 如何把一次用户输入转化为多轮模型请求、工具执行和结果回灌。
- `internal/tools`、`internal/permission`、`internal/hook` 如何共同控制本地副作用。
- `internal/conversation`、`internal/session`、`internal/compact`、`internal/memory` 如何支撑长会话和跨轮状态。
