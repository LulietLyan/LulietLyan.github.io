---
title: 从 main.go 看 PseudoClaude 的整体架构
description: How PseudoClaude assembles its TUI, runner, tools, state services, and security modules from the main process entry point.
date: 2026-08-21
order: 1
tags:
  - PseudoClaude
  - Architecture
  - Go
  - AI Agent
---

PseudoClaude 是一个使用 Go 和 Bubble Tea 编写的本地终端 Coding Agent。项目仓库位于：[https://github.com/LulietLyan/PseudoClaude](https://github.com/LulietLyan/PseudoClaude)。

我们希望解决的并不是“如何调用一次模型 API”，而是如何把一次不确定的模型输出放进确定的程序边界：模型可以请求读取文件、搜索代码、修改工程或执行命令，但真正的执行、状态记录和权限决策必须由本地程序掌握。

`cmd/PseudoClaude/main.go` 是理解这套架构的起点。它是进程的组合根，负责准备依赖并把它们交给 TUI；Agent 的多轮循环并不直接写在 `main` 中。

## 运行时的主干

从终端输入到一次 Agent 任务结束，主要依赖关系可以概括为：

```text
Terminal
  -> tui.Model
  -> agent.Runner
  -> llm.Provider
  -> tools.Registry
  -> permission.Engine
  -> conversation.Conversation
```

这不是严格的逐层调用栈。例如 Runner 会同时使用 Provider、Registry、Permission 和 Conversation。这个结构表达的是职责方向：TUI 管交互，Runner 管执行轮次，Provider 管模型协议，Registry 管工具，Permission 管副作用决策，Conversation 管当前会话事实。

入口首先加载整个进程无法缺少的模型配置：

```go
cfg, err := config.Load(".PseudoClaude/config.yaml")
if err != nil {
    fmt.Fprintf(os.Stderr, "配置错误: %v\n", err)
    os.Exit(1)
}

cwd, err := os.Getwd()
if err != nil {
    cwd = "."
}
home, _ := os.UserHomeDir()
```

`cfg` 决定有哪些 Provider 可以进入 TUI，`cwd` 和 `home` 则是项目级与用户级资源的路径基准。后续的 Instructions、Memory、Hook、Permission、Skill 和 Agent 配置都从这两个目录派生。

## main 的装配顺序

按照当前源码的实际顺序，入口完成以下工作：

| 步骤 | 初始化对象或内容 | 装入的内容 | 作用 |
| --- | --- | --- | --- |
| 1 | `cfg` | `.PseudoClaude/config.yaml` 中的 Provider 与功能配置 | 校验进程启动所需的模型配置 |
| 2 | `cwd`、`home` | 当前工作目录与用户主目录 | 确定项目级和用户级资源边界 |
| 3 | `instructionResult` | 三个层级的 `PSEUDOCLAUDE.md` | 形成传给 Runner 的持久指令 |
| 4 | `memoryManager` | 项目级与用户级 Memory Store 及其索引 | 提供长期记忆索引和更新入口 |
| 5 | `hookEngine` | 用户级与项目级 `hooks.yaml` | 编译生命周期自动化规则 |
| 6 | Session 清理任务 | 过期会话目录 | 在后台执行本地会话保留策略 |
| 7 | `permissionEngine` | 用户、项目、项目本地三级权限规则 | 在工具执行前给出 `allow`、`deny` 或 `ask` |
| 8 | `worktreeMgr` | Git 仓库、逻辑会话与已有 worktree | 为隔离执行提供可选工作目录 |
| 9 | `registry` | 六个无外部依赖的基础工具 | 建立工具定义和执行实现的统一目录 |
| 10 | `activeSkills`、`skillCatalog` | 会话激活集合及三级 Skill 目录 | 支持 Skill 的渐进披露 |
| 11 | `load_skill` | Catalog、激活集合与 Registry | 按需加载 Skill 正文和专用工具 |
| 12 | `mcpManager` | MCP 配置、连接、远端工具定义 | 将可用远端工具适配进 Registry |
| 13 | `install_skill` 与 Skill 校验 | 安装目录、重载回调、工具依赖 | 支持安装 Skill 并移除依赖不完整的条目 |
| 14 | `subagentCatalog` | 内置、用户级和项目级 Agent 定义 | 提供可委派的角色和工具约束 |
| 15 | `taskManager`、`teamManager` | 后台任务状态和持久化团队 | 提供可选的多 Agent 协作能力 |
| 16 | Agent、Task、Team 工具 | Runner 句柄和各管理器 | 将委派与协作能力暴露给模型 |
| 17 | `startup` | 各子系统的加载摘要 | 在界面中呈现实际启动状态 |
| 18 | `tui.Model` | UI、会话、压缩运行时、Runner 及上述依赖 | 形成一次终端会话的完整状态 |
| 19 | Bubble Tea Program | `tui.Model` | 启动事件循环并在退出时释放资源 |

这张表刻意区分“创建对象”和“把能力注册到统一入口”。例如 MCP Manager 负责连接 Server 和适配工具，但真正让 Runner 能找到远端工具的是后续的 Registry 注册：

```go
mcpStats := mcpManager.Stats()
for _, tool := range mcpManager.Tools() {
    if err := registry.Register(tool); err != nil {
        fmt.Fprintf(os.Stderr, "MCP 工具注册提示: %s: %v\n", tool.Definition().Name, err)
        continue
    }
    mcpStats.Registered++
}
```

因此，Runner 不需要分别认识本地工具、Skill 工具或 MCP 工具。只要它们都实现 `tools.Tool` 并进入同一个 Registry，执行层面对的就是同一种能力。

## 必需能力与可选能力

入口还负责决定初始化失败应该终止进程还是降级运行。

基础配置、权限引擎、基础 Registry 和核心 Agent 工具创建失败时，主流程无法满足基本约束，程序会直接退出。Worktree、Team、单个 MCP Server 和单条 Hook 规则则是可选能力，失败时记录告警并保留仍然可用的部分。

Worktree 的处理体现了这种边界：

```go
var worktreeMgr *worktree.Manager
if mgr, err := worktree.NewManager(worktree.Options{
    RepoRoot: cwd,
    Logf: func(format string, args ...any) {
        fmt.Fprintf(os.Stderr, "Worktree 提示: "+format+"\n", args...)
    },
}); err != nil {
    fmt.Fprintf(os.Stderr, "Worktree 功能已禁用: %v\n", err)
} else {
    worktreeMgr = mgr
    go worktreeMgr.SweepStale(context.Background(), time.Now().Add(-24*time.Hour))
}
```

非 Git 目录不应该让普通对话也无法启动，所以这里返回 `nil` Manager 并继续装配。相反，权限引擎无法确定真实项目根目录时，工具路径边界也无法成立，程序选择终止启动。

## TUI 是运行时容器

`main` 的最后一步是把前面准备好的对象接入 `tui.Model`：

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

if err := model.Run(); err != nil {
    fmt.Fprintf(os.Stderr, "运行错误: %v\n", err)
    os.Exit(1)
}
```

这里的 `WithXxx` 主要完成依赖接入，不是从头创建各个模块。MCP 也不经过链式方法，因为它的工具已经进入 `registry`。顺序中仍有少量运行时依赖，例如 Worktree 要先确定有效工作目录，Hook 的 `SessionStart` 才能拿到正确路径。

同时，`tui.New` 也不只是创建几个控件。它还准备命令注册表、工具环境、Conversation、Session Writer、Compact Runtime 和 Runner，并根据 Provider 数量决定直接初始化还是先进入选择状态。

## 模块边界如何落地

Runner 不直接操作界面，而是把执行过程转换成事件：

```go
type Event struct {
    Type       EventType
    Iteration  int
    Source     string
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

由此形成几条明确边界：

- `internal/tui` 持有交互状态，只消费 Event，不解析 OpenAI 或 Anthropic 流式协议。
- `internal/agent` 组织模型请求和工具轮次，不负责渲染终端。
- `internal/llm` 适配 Provider SDK，不决定工具是否允许执行。
- `internal/tools` 定义和执行工具，不直接弹出审批界面。
- `internal/permission` 返回结构化决策，不运行具体工具。
- `internal/conversation`、`session`、`compact`、`memory` 分别处理不同生命周期的状态。

这些边界并不意味着模块完全独立，而是要求跨模块协作发生在少数明确接口上。`main.go` 的职责就是集中完成这部分协作，避免每个子模块自行读取全局配置或构造下游依赖。

## 小结

从 `main.go` 看，PseudoClaude 的整体架构可以归纳为一句话：入口装配运行时，TUI 驱动交互，Runner 驱动 Agent 轮次，Tool、状态和安全模块通过明确接口参与执行。

下一篇将只关注这条主干最外层的 TUI：Bubble Tea 如何把用户输入、流式输出、工具状态和审批请求组织成一个有限状态机。
