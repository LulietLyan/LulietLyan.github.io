---
title: 测试边界与可维护性：用 Go 测试约束 Agent 系统
description: 从 PseudoClaude 的测试组织出发，分析 Runner、工具、权限、会话、MCP、Skill、Team 和 TUI 的可维护边界。
date: 2026-08-21
order: 12
tags:
  - PseudoClaude
  - Go
  - Testing
---

Agent 项目的不确定性主要来自模型，但工程系统不能把不确定性扩散到所有模块。PseudoClaude 的测试重点不是验证某个模型会如何回答，而是验证宿主程序的边界：Runner 如何处理事件，工具如何执行和失败，权限如何决策，会话如何恢复，MCP 和 Skill 如何注册，Team 和 worktree 如何维护生命周期。

开源仓库：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)

## 测试组织

项目测试集中在 `internal` 下，覆盖 Runner、工具、权限、Hook、Conversation、Session、Compact、Memory、MCP、Skill、Subagent、Task、Team、TUI、Worktree 等包。

测试文件示例：

```text
internal/agent/runner_test.go
internal/tools/registry_test.go
internal/permission/engine_test.go
internal/session/session_test.go
internal/compact/compact_test.go
internal/memory/memory_test.go
internal/mcp/manager_test.go
internal/skills/catalog_test.go
internal/subagent/parser_test.go
internal/team/spawn_test.go
internal/tui/stream_test.go
internal/worktree/manager_test.go
```

这种组织方式与 Go 包边界一致。每个包测试自己的行为，而不是把所有场景压进端到端测试。

## Runner 测试

`internal/agent/runner_test.go` 使用 fake provider 和 scripted tool 构造可重复场景。

fake provider 实现 `llm.Provider`：

```go
type fakeProvider struct {
    streams  [][]llm.StreamEvent
    requests []llm.Request
}
```

每次 Runner 调用 `Stream`，fake provider 返回预先定义的一组 `llm.StreamEvent`，同时记录请求。这样测试可以验证 Runner 发送了几轮请求、system prompt 是否稳定、工具结果是否回灌到 conversation。

`TestCollectorPublishesDeltasAndCollectsOutput` 验证 `streamCollector.collect` 的核心行为：文本增量会被发成 `EventTextDelta`，完整文本会被聚合进 round output，usage 会被转发，tool call 会被收集。

`TestRunnerCompletesAfterMultipleToolRounds` 验证多轮 ReAct：第一轮模型调用 `read_file`，第二轮调用 `search_code`，第三轮返回文本并停止。测试断言 provider 被调用三次，conversation 中存在用户消息、assistant tool calls、tool results 和最终 assistant 文本。

`TestRunnerHandlesMultipleToolCallsInOrder` 验证只读工具可以并发执行，但写回 conversation 的 tool result 顺序仍按模型 tool call 原顺序排列。

`TestSideEffectToolsRunSerially` 验证副作用工具串行执行。这个测试约束了一个关键安全边界：并发优化只能用于只读工具，不能让写文件、执行命令等副作用操作失序。

## 工具注册表测试

`internal/tools/registry_test.go` 验证工具系统的基础合同。

`TestRegistryRegisterGetAndDefinitions` 确认注册、查询和 definition 排序稳定。排序稳定很重要，因为工具定义会进入模型请求；不稳定顺序会给测试和 prompt 观察带来噪声。

`TestRegistryRejectsInvalidRegistrations` 确认 nil tool、空名称、重复名称都会被拒绝。

`TestRegistryExecuteUnknownAndInvalidJSON` 确认未知工具返回 `unknown_tool`，非法 JSON 参数返回 `invalid_arguments`，并且非法 JSON 不会触发实际工具执行。

`TestRegistryExecuteTimeout` 确认工具执行受 context timeout 控制。

`TestDefaultRegistryDescriptionsReinforceToolUseRules` 验证默认工具描述包含关键使用约束，例如优先使用专用读文件、搜索工具，编辑前先读取文件等。对于 Agent 系统而言，工具描述也是模型行为边界的一部分，因此它值得被测试。

## 权限测试

`internal/permission/engine_test.go` 体现了权限系统的优先级。

`TestEngine` 覆盖以下行为：

- `bypassPermissions` 模式下危险命令仍被 blacklist 拒绝。
- 本地 deny 规则可以拒绝 `git push`。
- 项目 allow 规则可以允许 `git status`。
- 默认模式下读操作可以允许，写操作需要 ask。
- 访问项目根目录外路径会被 sandbox 拒绝。
- `read_file` 不接受 glob path，应提示使用 `find_files`。
- `find_files` 的 glob pattern 仍然可以走只读路径。

这些断言说明权限系统不是单一模式开关。硬性检查先于规则和模式，路径沙箱与危险命令黑名单即使在 bypass 模式下也不能被绕过。

`TestEngineRulePrecedence` 验证规则层级：session 规则高于 local，local 高于 project，project 高于 user。这个测试保证用户临时批准、项目策略和个人配置之间有确定优先级。

## 会话与上下文测试

Conversation、Session、Compact、Memory 的测试重点是状态可恢复。

`internal/conversation/conversation_test.go` 验证消息追加、tool call、tool result、replace 和深拷贝。深拷贝不是形式问题：如果调用方拿到 `Messages()` 后修改 slice 或 tool result，不能污染真实会话历史。

`internal/session/session_test.go` 验证 JSONL 写入和加载。普通 message 会追加，replace marker 会重置当前消息集；加载时会跳过坏行，并处理悬挂 tool call，避免恢复出协议不完整的上下文。

`internal/compact/compact_test.go` 验证工具结果落盘、摘要压缩、最近消息选择和 usage anchor。尤其是最近消息选择需要保持 assistant tool call 与 tool result 的边界，不能把一组工具交互切断。

`internal/memory/memory_test.go` 验证 memory operations 的解析、校验、应用和索引更新。模型输出 JSON operations 属于候选变更；写文件前仍由程序验证 action、level、filename、slug 和路径边界。

## Hook 测试

`internal/hook` 下的测试覆盖 loader、condition、payload、executor、prompt queue 和 engine。

Hook 系统容易出现两个风险：配置错误导致运行时崩溃，或阻断语义不清晰。测试通过几类方式约束它：

- loader 测试保证 project/user hook 配置能被解析，错误能变成 warning。
- condition 测试保证事件、工具名、路径等匹配规则稳定。
- payload 测试保证基础字段和事件字段一致。
- executor 测试保证 shell/http action 的阻断返回和输出解析符合约定。
- prompt queue 测试保证注入 prompt 可以在后续 reminder 中被 drain。

这使 Hook 能作为生命周期扩展点存在，而不是不可预测的脚本入口。

## MCP 与 Skill 测试

MCP 测试覆盖配置合并、server 名称、HTTP/stdio 调用、tool name 映射和 manager 连接行为。

Skill 测试覆盖 catalog 扫描、markdown/frontmatter 解析、active skill 渲染、安装路径、`load_skill` 行为和专属工具声明。

这两类测试约束的是扩展边界：外部能力可以进入系统，但必须先变成内部可理解的工具定义或 active context。MCP server 失败不能让内置工具不可用；Skill 解析失败也应以 warning 呈现，而不是破坏主流程。

## Subagent、Team 与 Worktree 测试

Subagent 测试覆盖定义解析、catalog 优先级、fork 请求构造和工具过滤。

Task 测试覆盖后台任务管理、通知和 task tools。

Team 测试覆盖 manager、persistence、spawn、lead mail、registry、team task store 和 wrapper tools。

Worktree 测试覆盖 manager 初始化、slug 生成和隔离目录行为。

这些测试共同约束多 Agent 协作的边界：子 Agent 不能无限嵌套创建子 Agent，后台任务必须有可查询生命周期，Team 必须有可恢复配置和 mailbox，worktree 名称必须稳定且不会生成危险路径。

## TUI 测试

`internal/tui` 的测试主要覆盖命令、补全、stream 和 subagent 相关行为。

TUI 测试不需要启动真实模型。它可以通过构造模型状态、fake 事件和命令输入来验证：

- slash command 是否被正确解析和分发。
- 补全是否基于命令和 Skill catalog 生成。
- Agent event 是否被正确转成 transcript 和状态变化。
- subagent approval 是否能通过主 TUI 升级处理。

这说明 TUI 的可测性来自事件边界。只要 Runner 输出是 `agent.Event`，TUI 就可以在没有真实 provider 的情况下测试状态转移。

## 测试策略

PseudoClaude 的测试策略可以总结为四条。

第一，用 fake provider 替代真实模型。测试 Runner 状态机，不测试模型能力。

第二，用 fake tool 替代真实文件系统副作用。测试注册、批处理、权限和结果回灌，不让测试依赖外部命令。

第三，对权限、路径、命令、JSON、timeout 等边界做显式断言。这些地方一旦回归，可能直接影响本地工作区安全。

第四，将扩展系统测试在适配边界上。MCP、Skill、Subagent、Team 都应验证“如何进入内部统一接口”，而不是只测试 happy path。

## 小结

Agent 项目的测试不应试图证明模型总会做正确选择。更可靠的目标是证明宿主程序在模型输出任意 tool call 时仍然保持边界：未知工具不会执行，非法 JSON 不会执行，危险命令不会执行，越界路径不会执行，副作用工具不会并发失序，长会话可以恢复，扩展能力必须通过注册表进入。

PseudoClaude 的 Go 测试围绕这些边界展开。它们让项目具备继续演进的基础：可以新增 provider、工具、Skill、Team backend 或 compact 策略，同时用现有测试确认关键合同没有被破坏。
