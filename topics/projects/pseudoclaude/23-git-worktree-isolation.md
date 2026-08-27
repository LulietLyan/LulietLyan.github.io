---
title: Git Worktree 隔离：独立分支、工作目录与保守清理
description: How PseudoClaude gives agents independent Git worktrees and branches, redirects execution through per-run CWDs, and protects local changes during cleanup.
date: 2026-08-28
order: 23
tags:
  - PseudoClaude
  - Multi-Agent
  - Git
  - Worktree
  - Go
---

多个 Agent 在同一个 checkout 修改文件时，即使 goroutine 和 Conversation 完全独立，磁盘写入仍会互相覆盖。Git worktree 提供了更合适的本地隔离单位：共享对象数据库，但每个任务拥有独立工作目录、Index、HEAD 和 Branch。

PseudoClaude 用一个可选 Worktree Manager 服务三种场景：用户手动创建并进入长期工作区，预定义子 Agent 按需创建随机临时工作区，Team Member 总是创建稳定成员工作区。Manager 不修改进程级 CWD，而是将具体路径注入 Runner 和 Tool Env。

## Manager 只在有效 Git 仓库中启用

初始化先通过 `git rev-parse --show-toplevel` 规范化仓库根，再准备元数据目录与内存索引：

```go
func NewManager(opts Options) (*Manager, error) {
    ctx := context.Background()
    git := opts.Git
    if git == nil {
        git = execGitRunner{}
    }
    root, err := ensureRepoRoot(ctx, git, opts.RepoRoot)
    if err != nil {
        return nil, fmt.Errorf(
            "%w: git repository not available: %v",
            ErrUnavailable, err,
        )
    }
    m := &Manager{
        repoRoot: root,
        metaDir: filepath.Join(root, ".PseudoClaude"),
        worktreeDir: filepath.Join(
            root, ".PseudoClaude", "worktrees",
        ),
        sessionFile: filepath.Join(
            root, ".PseudoClaude", "worktree_session.json",
        ),
        active:   map[string]*Worktree{},
        creating: map[string]struct{}{},
    }
    if err := os.MkdirAll(m.worktreeDir, 0o755); err != nil {
        return nil, err
    }
    m.warnIfNotIgnored()
    m.loadCurrent()
    m.scanActive()
    return m, nil
}
```

非 Git 目录返回 `ErrUnavailable`，主程序把 Worktree 作为可选能力禁用；普通 Agent 仍可运行，但 Team Spawn 会因 `ErrWorktreeDisabled` 拒绝。Manager 还检查 `.PseudoClaude/worktrees/` 和 session 文件是否被 `.gitignore` 忽略，只给 Warning，不自动修改仓库。

启动扫描直接读取每个 checkout 的 `.git` 指针和 Git Dir HEAD，不为每项启动 Git 子进程。它能恢复 Path、Branch 和 HeadCommit，但 BasedOn、真实创建时间等未落盘字段无法完整重建；Manual 只能按随机临时名称模式重新推断。

## 逻辑名称稳定映射到目录和分支

名称最长 64 字符，只允许字母、数字、点、下划线、连字符和作为层级的 `/`；`.`、`..`、空段和绝对路径被拒绝。`/` 最终变成 `+`：

```go
func FlatName(name string) (string, error) {
    if err := ValidateName(name); err != nil {
        return "", err
    }
    return strings.ReplaceAll(name, "/", "+"), nil
}

func branchName(flat string) string {
    return "worktree-" + flat
}
```

例如：

```text
逻辑名:  feature/parser
目录:    .PseudoClaude/worktrees/feature+parser
分支:    worktree-feature+parser
```

输入本身不允许 `+`，所以扁平映射可以逆向恢复 `/`。普通子 Agent 用 `agent-a` 加 7 位十六进制随机数；Team Member 用 `team-<team>-<member>`；手动 `/worktree create` 使用用户给定名称并设置 `Manual=true`。

## Create 用 Git 建立独立 checkout

同名 active 项幂等返回，另一个 goroutine正在创建同名项则报错。真正创建使用固定分支名和基线：

```go
func (m *Manager) Create(
    ctx context.Context,
    in CreateInput,
) (*Worktree, error) {
    flat, err := FlatName(in.Name)
    if err != nil {
        return nil, err
    }
    base := in.BaseRef
    if base == "" {
        base = "HEAD"
    }
    path := filepath.Join(m.worktreeDir, flat)
    branch := branchName(flat)

    m.mu.Lock()
    if existing := m.active[in.Name]; existing != nil {
        cp := *existing
        m.mu.Unlock()
        return &cp, nil
    }
    if _, ok := m.creating[in.Name]; ok {
        m.mu.Unlock()
        return nil, fmt.Errorf(
            "worktree %q is already being created", in.Name,
        )
    }
    m.creating[in.Name] = struct{}{}
    m.mu.Unlock()

    if _, err := runGitTrimmed(
        ctx, m.git, m.repoRoot,
        "worktree", "add", "-B", branch, path, base,
    ); err != nil {
        _ = os.RemoveAll(path)
        return nil, fmt.Errorf(
            "create worktree %q at %s: %w", in.Name, path, err,
        )
    }
    // 读取 HEAD、执行 postCreateSetup、写入 active
}
```

`-B` 让托管 Branch 明确指向 BaseRef。若磁盘目录已经存在且 `.git` 指针可解析，Create 先走 fastRecover，不重新执行 Git；无法恢复才尝试 Git add。

Branch 与逻辑名一一对应，没有自动 merge、rebase 或 cherry-pick 回父分支的代码。子 Agent 的最终文本需要报告保留路径/分支，后续合并由 Lead 或用户完成。

## 隔离通过 Runner CWD，而不是 os.Chdir

用户手动 Enter 时只保存逻辑 Session 并更新 EffectiveCWD：

```go
func (m *Manager) Enter(
    ctx context.Context,
    name string,
) (*Session, error) {
    m.mu.Lock()
    wt := m.active[name]
    m.mu.Unlock()
    if wt == nil {
        return nil, fmt.Errorf("%w: %s", ErrNotFound, name)
    }
    branch, _ := runGitTrimmed(
        ctx, m.git, m.repoRoot, "branch", "--show-current",
    )
    head, _ := runGitTrimmed(
        ctx, m.git, m.repoRoot, "rev-parse", "HEAD",
    )
    s := &Session{
        OriginalCWD: m.repoRoot,
        WorktreePath: wt.Path,
        WorktreeName: wt.Name,
        OriginalBranch: branch,
        OriginalHeadCommit: head,
        SessionID: RandomAgentName(),
        StartedAt: m.now(),
    }
    if err := saveSession(m.sessionFile, s); err != nil {
        return nil, err
    }
    m.mu.Lock()
    m.current = s
    m.mu.Unlock()
    return s, nil
}
```

TUI Adapter 随后调用 `setActiveCWD(session.WorktreePath)`；下一次 Runner Snapshot、Tool Env、Permission CheckContext 和 System Environment 都获得新路径。进程本身不 `os.Chdir`，所以同时运行的后台 Agent 不会被一次手动 Enter 改变工作目录。

Session 写进 `.PseudoClaude/worktree_session.json`，重启后路径存在即可恢复。Exit 不删除时只写 `null` 并回到 RepoRoot；需要删除时复用 Remove 的安全检查。

## 子 Agent 用 Prepare/Cleanup 包住临时 Worktree

Defined 子 Agent 的 worktree 隔离可以来自 Definition 或单次调用：

```go
func (t *AgentTool) worktreePrepare(
    parentCWD string,
) AgentPrepareFunc {
    return func(
        ctx context.Context,
        runner Runner,
        prompt string,
    ) (Runner, string, AgentCleanupFunc, error) {
        name := worktree.RandomAgentName()
        wt, err := t.Worktrees.Create(ctx, worktree.CreateInput{
            Name: name, Manual: false,
        })
        if err != nil {
            return runner, prompt, nil, err
        }
        runner.CWD = wt.Path
        runner.Env.CWD = wt.Path
        notice := buildWorktreeNotice(parentCWD, wt.Path)
        cleanup := func(ctx context.Context, result string) string {
            report, err := t.Worktrees.AutoCleanup(ctx, name)
            if err != nil {
                return strings.TrimSpace(
                    result + "\n\nWorktree cleanup failed: " + err.Error(),
                )
            }
            if kept := worktree.FormatKept(report); kept != "" {
                return strings.TrimSpace(result + "\n\n" + kept)
            }
            return result
        }
        return runner,
            strings.TrimSpace(notice+"\n\n"+prompt),
            cleanup,
            nil
    }
}
```

Notice 要求子 Agent 把父路径映射到 Worktree、编辑前重新读取文件且不把临时结果写回父目录。完成后 AutoCleanup 删除干净临时项；发现改动或提交则保留，并在 Tool Result 末尾提供 Path、Branch 和原因。

Fork 当前不走 `effectiveIsolation`，即使 ToolCall 带 `isolation: worktree` 也只复制 Conversation 后直接后台 Launch。Team Member 则在 Spawn 时无条件调用 Worktree Create，不使用 AgentPrepare，也不会在每次成员空闲时自动清理。

## 创建后设置兼顾可运行性

纯 Git checkout 不包含被忽略的本地配置和依赖。`postCreateSetup` 尽力执行四项设置：

```go
func (m *Manager) postCreateSetup(
    ctx context.Context,
    wt *Worktree,
) {
    for _, err := range []error{
        m.copyLocalConfig(wt),
        m.setupHooks(ctx, wt),
        m.symlinkLargeDirs(wt),
        m.copyIncludedIgnoredFiles(ctx, wt),
    } {
        if err != nil {
            m.logf("worktree setup warning for %s: %v", wt.Name, err)
        }
    }
}
```

Local config 会复制 `.PseudoClaude/config.yaml`、`permissions.local.yaml`、`hooks.yaml`、agents 和 skills；Git Hooks 复用主仓库 `core.hooksPath` 或 `.husky`；`.worktreeinclude` 可以选择性复制 Git ignored 文件，并拒绝仓库外源路径。

`node_modules`、`.venv` 和 `vendor` 默认不复制，而是 symlink 到主工作区以降低时间和磁盘成本。它们中的写入跨 Worktree 共享，因此依赖安装、生成缓存或原生构建仍可能互相影响。复制的本地配置也只是创建时快照，之后不会与主工作区同步。

## 删除前检查三类受保护内容

AutoCleanup 与普通 Remove 都依赖保守检查：

```go
func hasProtectedChanges(
    ctx context.Context,
    git GitRunner,
    wt *Worktree,
) (bool, string) {
    status, err := runGitTrimmed(
        ctx, git, wt.Path, "status", "--porcelain",
    )
    if err != nil {
        return true, "status check failed: " + err.Error()
    }
    if strings.TrimSpace(status) != "" {
        return true, "uncommitted changes"
    }
    if wt.HeadCommit != "" {
        count, err := runGitTrimmed(
            ctx, git, wt.Path,
            "rev-list", "--count", wt.HeadCommit+"..HEAD",
        )
        if err != nil {
            return true, "local commit check failed: " + err.Error()
        }
        if strings.TrimSpace(count) != "0" {
            return true, "new local commits"
        }
    }
    if _, err := runGitTrimmed(
        ctx, git, wt.Path,
        "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
    ); err == nil {
        count, err := runGitTrimmed(
            ctx, git, wt.Path,
            "rev-list", "--count", "@{u}..HEAD",
        )
        if err != nil {
            return true,
                "unpushed commit check failed: " + err.Error()
        }
        if strings.TrimSpace(count) != "0" {
            return true, "unpushed commits"
        }
    }
    return false, ""
}
```

未提交修改、新本地提交、相对 Upstream 未推送提交，以及 status、创建基线或已存在 Upstream 的比较失败都会阻止默认删除。没有配置 Upstream 本身不算错误。`--discard` 才调用 `git worktree remove --force` 并尝试 `branch -D`。

这里“新本地提交”相对创建时 HeadCommit 判断，所以即使提交已推送，只要 HEAD 前进也会保护；它是有意保守而非精确判断是否可恢复。恢复扫描若无法读取准确 HeadCommit，保护范围可能只剩 status 与 upstream。

## AutoCleanup 与陈旧扫描的范围不同

AutoCleanup 只拒绝 Manual 或有受保护内容的指定 Worktree，Team Delete 也可以对稳定名称调用它。SweepStale 则只处理名称匹配 `agent-a[0-9a-f]{7}`、目录早于 cutoff、不是当前 Session 且干净的项。

因此 Team Worktree 不参加陈旧扫描。`KillMember` 只移除 Member 元数据，不清理 Worktree；非 force 的 Team Delete 即使所有成员空闲，也只删除 Team ConfigDir。只有 force Delete 的分支会逐个尝试 AutoCleanup，仍会保留有修改的目录。长期使用时需要通过 Worktree List/Remove 人工管理遗留成员分支。

## Worktree 不等于完全沙箱

- Worktree 共享同一 Git Object Database 和仓库级引用，创建/删除 Branch 会影响同一 Repository。
- 默认共享依赖目录，相关写入不隔离。
- Agent 进程仍可以通过 `run_command` 或绝对路径访问 Worktree 外部；它不是 chroot、container 或 OS 权限边界。
- 父工作区在 Worktree 创建后继续变化时，子 Branch 不自动同步。
- 没有自动合并策略，多个 Agent 即使各自修改成功，最终仍可能产生 Git 冲突。
- Worktree Branch 使用固定逻辑名和 `-B`，名称复用需要理解它会把托管 Branch 指向新的 BaseRef。

## 完整流程

```text
Manager 启动
  -> git rev-parse 仓库根
  -> 建 .PseudoClaude/worktrees
  -> 恢复逻辑 Session 和已有 checkout

Create(name, base=HEAD)
  -> 校验名称，/ 映射 +
  -> 派生 worktree-<flat> branch
  -> git worktree add -B <branch> <path> <base>
  -> 复制本地配置、设置 Hooks
  -> symlink 大依赖、复制 include 文件

Agent/Team 运行
  -> Runner.CWD + Env.CWD 指向独立 checkout
  -> 文件 Tool 和权限路径以该 CWD 工作
  -> 各 Agent 修改自己的 Index/Branch

完成清理
  -> git status 检查未提交内容
  -> 比较创建 HEAD 后的新提交
  -> 检查 Upstream 未推送提交
  -> 干净临时项删除
  -> 有风险项保留并报告 Path/Branch
```

## 测试验证了什么

Worktree 测试在真实临时 Git 仓库中覆盖创建、`feature/a` 映射、幂等恢复、Enter 不改变进程 CWD、Exit、Dirty 删除保护、Discard、临时 AutoCleanup 和陈旧 Sweep；Slug 测试覆盖路径穿越和非法字符；AgentTool 测试覆盖 Definition/调用级 worktree；Team Spawn 测试确认成员获得 WorktreePath、Branch 和独立 CWD。

现有测试没有覆盖共享依赖并发写、复杂 `.worktreeinclude` glob、Branch 自动合并、Team 普通删除后的清理、进程崩溃于 Git add 与 active 写入之间，或命令逃出 Worktree 的 OS 级隔离。

## 小结

PseudoClaude 将 Git worktree 作为多 Agent 的磁盘隔离单元：每项拥有独立 checkout、Index、HEAD、Branch 和显式 CWD，Manager 用保守 Git 检查避免自动删除用户修改。它同时服务手动会话、临时 Defined 子 Agent 和持久 Team Member。

这层隔离解决的是并行修改互相覆盖，不解决依赖目录共享、工作区外访问或最终合并冲突。至此，多 Agent 主线完整闭环：委派决定上下文与能力，Task 管理运行生命周期，Team 保存协作身份，Mailbox 传递消息，Worktree 隔离修改位置。
