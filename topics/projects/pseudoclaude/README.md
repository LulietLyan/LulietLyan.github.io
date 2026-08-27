---
title: PseudoClaude
description: A source-guided series on PseudoClaude's terminal runtime, model and tool ecosystem, context lifecycle, security boundaries, and multi-agent collaboration.
icon: mdi:robot-outline
order: 1
tags:
  - Projects
  - Go
  - AI Agent
  - Coding Agent
---

PseudoClaude 是一个使用 Go 和 Bubble Tea 编写的本地终端 Coding Agent。项目将模型流式输出、工具调用、权限审批、会话持久化、上下文压缩、长期记忆和多 Agent 协作整合进同一个 TUI 运行时，并通过 Provider、MCP、Skill、Task、Team 与 Worktree 扩展执行边界。这组文章进一步下钻每种状态怎样写入、恢复、筛选、控制体积，副作用怎样被约束，以及多个 Agent 如何隔离工作并交换结果。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

这组文章不按 package 罗列功能，而是先沿程序的一次真实运行过程理解核心架构，再分别展开模型与工具扩展边界：

1. [从 `main.go` 看 PseudoClaude 的整体架构](/topics/projects/pseudoclaude/01-project-architecture/)：进程入口如何准备依赖并装配完整运行时。
2. [Bubble Tea 状态机：TUI 如何驱动 Agent 交互](/topics/projects/pseudoclaude/02-tui-state-machine/)：用户输入和 Agent 事件如何转化为界面状态。
3. [ReAct 执行循环：模型、工具与结果如何闭环](/topics/projects/pseudoclaude/03-react-agent-loop/)：Runner 如何反复请求模型、执行工具并回填结果。
4. [Tool 系统：从模型契约到受控执行](/topics/projects/pseudoclaude/04-tool-system/)：工具定义、注册、过滤和执行如何进入统一边界。
5. [上下文与记忆：四种状态的生命周期](/topics/projects/pseudoclaude/05-context-and-memory/)：Conversation、Session、Compact 与 Memory 分别保存什么。
6. [安全边界：权限引擎与 Plan Mode](/topics/projects/pseudoclaude/06-plan-mode-security/)：只读规划和副作用控制如何由多层校验共同保证。
7. [Provider 抽象：归一不同模型的流式协议](/topics/projects/pseudoclaude/07-provider-stream-events/)：Anthropic 与 OpenAI 的消息和流式事件如何收敛为内部契约。
8. [MCP 工具桥接：从远端发现到本地注册](/topics/projects/pseudoclaude/08-mcp-tool-bridge/)：stdio 与 Streamable HTTP Server 如何接入统一 Tool 系统。
9. [Skill 渐进披露：按需加载 SOP 与专用工具](/topics/projects/pseudoclaude/09-skill-progressive-disclosure/)：Skill 如何先公开索引，再激活正文和目录工具。
10. [会话持久化：JSONL 日志如何写入与恢复](/topics/projects/pseudoclaude/10-session-jsonl-recovery/)：追加消息和 Replace 快照如何重放为有效会话。
11. [分层指令：项目与用户规则如何进入 System Prompt](/topics/projects/pseudoclaude/11-layered-instructions/)：三层 `PSEUDOCLAUDE.md` 如何展开引用并组装成稳定提示词。
12. [长期记忆：如何异步提取跨会话知识](/topics/projects/pseudoclaude/12-async-long-term-memory/)：本轮消息如何生成分层 Operation，并在后台更新索引与正文。
13. [长上下文治理：Tool Result 落盘与历史摘要](/topics/projects/pseudoclaude/13-two-stage-context-compaction/)：两级策略如何处理结果尖峰、窗口阈值和近期调用闭环。
14. [危险命令防线：黑名单如何检查 Tool Call](/topics/projects/pseudoclaude/14-dangerous-command-guard/)：结构化命令怎样在 Rule 和 Mode 之前经过不可配置的高危模式检查。
15. [路径沙箱：如何把文件工具限制在工作区](/topics/projects/pseudoclaude/15-workspace-path-sandbox/)：绝对路径、目录穿越、未创建目标和 symlink 如何统一按真实路径判断。
16. [分层权限规则：匹配、优先级与授权持久化](/topics/projects/pseudoclaude/16-layered-permission-rules/)：Session、Local、Project、User Rule 如何匹配，并由 Permission Mode 兜底。
17. [交互审批：Ask 如何往返 Agent 与 TUI](/topics/projects/pseudoclaude/17-interactive-approval-flow/)：Ask 怎样暂停 ToolCall，经 Bubble Tea 响应后执行、持久授权或拒绝。
18. [Plan Mode：工具定义与执行阶段的双重只读](/topics/projects/pseudoclaude/18-plan-mode-double-guard/)：只读 Definition 与执行期 Safety 复检如何共同拒绝副作用调用。
19. [Agent 委派：Fork 与预定义子 Agent 如何分工](/topics/projects/pseudoclaude/19-agent-delegation-models/)：同一 Agent Tool 如何选择继承父会话的 Fork 或按 Definition 装配的专业角色。
20. [任务生命周期：前台执行、超时转后台与完成通知](/topics/projects/pseudoclaude/20-background-task-lifecycle/)：Runner 怎样同步返回或进入独立后台 Context，并通过 Snapshot 与 Reminder 回报结果。
21. [Team Lead 协作：持久成员、共享任务与运行恢复](/topics/projects/pseudoclaude/21-team-lead-collaboration/)：Lead、Member、共享 Task 和独立 Runner 如何形成可继续的协作状态。
22. [Mailbox 通信：文件锁、未读消息与 Agent 唤醒](/topics/projects/pseudoclaude/22-mailbox-communication/)：每 Agent JSON 收件箱如何处理并发写入、Reminder 消费、广播和空闲恢复。
23. [Git Worktree 隔离：独立分支、工作目录与保守清理](/topics/projects/pseudoclaude/23-git-worktree-isolation/)：独立 checkout、Branch 和 CWD 如何隔离修改，并在清理前保护本地工作。
