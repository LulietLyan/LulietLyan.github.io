---
title: 路径沙箱：如何把文件工具限制在工作区
description: How PseudoClaude resolves file targets, symlinks, and not-yet-created paths before rejecting access outside the active workspace.
date: 2026-08-28
order: 15
tags:
  - PseudoClaude
  - Security
  - Sandbox
  - Go
---

对文件 Tool 而言，检查原始字符串是否以项目路径开头远远不够。`../outside` 可以直接穿越目录，项目内 symlink 可以指向外部，一个尚不存在的新文件又无法直接调用 `EvalSymlinks`。

PseudoClaude 的路径边界位于 Permission Engine：先根据 Tool 参数提取目标，再解析工作区和目标的真实路径，最后才进入 Allow/Deny Rule。它保护的是内置文件 Tool 的目标，不是操作系统级进程沙箱。

## 不同文件工具有不同参数形状

`read_file`、`write_file` 和 `edit_file` 直接使用 `path`；`search_code` 的 path 可省略；`find_files` 则接收 glob pattern。`pathTarget` 同时返回沙箱目标和规则匹配目标：

```go
func pathTarget(call llm.ToolCall) (
    target string,
    matchTarget string,
    ok bool,
) {
    switch call.Name {
    case "read_file", "write_file", "edit_file":
        var args struct {
            Path string `json:"path"`
        }
        if err := json.Unmarshal(call.Arguments, &args);
            err != nil || strings.TrimSpace(args.Path) == "" {
            return "", "", false
        }
        return args.Path, args.Path, true
    case "search_code":
        var args struct {
            Pattern string `json:"pattern"`
            Path    string `json:"path"`
        }
        if err := json.Unmarshal(call.Arguments, &args);
            err != nil || strings.TrimSpace(args.Pattern) == "" {
            return "", "", false
        }
        if strings.TrimSpace(args.Path) == "" {
            return ".", ".", true
        }
        return args.Path, args.Path, true
    case "find_files":
        var args struct {
            Pattern string `json:"pattern"`
        }
        if err := json.Unmarshal(call.Arguments, &args);
            err != nil || strings.TrimSpace(args.Pattern) == "" {
            return "", "", false
        }
        return globStaticRoot(args.Pattern), args.Pattern, true
    default:
        return "", "", false
    }
}
```

`find_files("src/**/*.go")` 只需要确认静态根 `src` 位于工作区，但后续 Rule 仍要看到完整的 `src/**/*.go`。把两个目标分开，避免为了支持 glob 而让沙箱误把 `*` 当真实文件名。

参数缺失或 JSON 非法时直接 Deny。对于要求精确路径的 Read、Write、Edit 和 Grep，路径中出现 `*`、`?` 或 `[` 也会拒绝，并提示先用 `find_files`；只有 Glob Tool 接受 glob。

## 项目根先解析为真实路径

Engine 初始化时把项目根变成绝对真实路径：

```go
func resolveRoot(root string) (string, error) {
    if strings.TrimSpace(root) == "" {
        root = "."
    }
    abs, err := filepath.Abs(root)
    if err != nil {
        return "", err
    }
    resolved, err := filepath.EvalSymlinks(abs)
    if err != nil {
        return "", err
    }
    return filepath.Clean(resolved), nil
}
```

根目录无法解析属于 Engine 的致命初始化错误，主程序不会退回到一个没有边界的 Permission Engine。后续每个相对路径都以当前 Tool Env 的 CWD 为基准；Worktree 和子 Agent 因而可以把自己的实际工作目录作为独立边界。

## 未创建目标要从最近存在祖先开始解析

读取已有文件可以直接 `EvalSymlinks`，写入 `new/a/b.txt` 时整条路径可能尚不存在。实现会向上查找最近存在的祖先，解析祖先 symlink，再把缺失片段按原顺序接回：

```go
func evalSymlinksOrAncestor(abs string) (string, error) {
    abs = filepath.Clean(abs)
    if resolved, err := filepath.EvalSymlinks(abs); err == nil {
        return filepath.Clean(resolved), nil
    }

    missing := []string{}
    cursor := abs
    for {
        if _, err := os.Stat(cursor); err == nil {
            resolved, err := filepath.EvalSymlinks(cursor)
            if err != nil {
                return "", err
            }
            for i := len(missing) - 1; i >= 0; i-- {
                resolved = filepath.Join(resolved, missing[i])
            }
            return filepath.Clean(resolved), nil
        }
        parent := filepath.Dir(cursor)
        if parent == cursor {
            return "", os.ErrNotExist
        }
        missing = append(missing, filepath.Base(cursor))
        cursor = parent
    }
}
```

例如 `workspace/link/new/file.txt` 中 `new/file.txt` 不存在，而 `link` 指向 `/tmp/outside`。算法先找到 `link`，解析为 `/tmp/outside`，再接回 `new/file.txt`，最终正确识别为工作区外目标。

## 边界判断不能只做裸前缀匹配

解析完成后，`insideRoot` 接受根目录本身或 `root + separator` 开头的目标：

```go
func insideRoot(root, target string) bool {
    root = filepath.Clean(root)
    target = filepath.Clean(target)
    if target == root {
        return true
    }
    sep := string(filepath.Separator)
    return strings.HasPrefix(target, root+sep)
}

func sandboxTarget(root, raw string) (string, bool, error) {
    if strings.TrimSpace(raw) == "" {
        raw = "."
    }
    target := raw
    if !filepath.IsAbs(target) {
        target = filepath.Join(root, target)
    }
    abs, err := filepath.Abs(target)
    if err != nil {
        return "", false, err
    }
    resolved, err := evalSymlinksOrAncestor(abs)
    if err != nil {
        return "", false, err
    }
    return resolved, insideRoot(root, resolved), nil
}
```

加入路径分隔符可以防止 `/work/project-evil` 被误判为 `/work/project` 的子目录。判断基于解析后的 target，所以 `..`、绝对路径和 symlink 使用同一条逻辑，而不是各自维护容易漏掉的字符串规则。

## Engine 在规则匹配前执行沙箱

文件分支的决策顺序如下：

```go
rawTarget, rawMatchTarget, ok := pathTarget(call)
if !ok {
    return CheckResult{
        Decision: DecisionDeny,
        Source:   "unknown",
        Reason:   "file tool path arguments could not be parsed",
        Category: category,
        CWD:      root,
    }
}
if pathToolRequiresExactPath(call.Name) && pathContainsGlob(rawTarget) {
    return CheckResult{
        Decision: DecisionDeny,
        Source:   "unknown",
        Reason:   call.Name + " does not accept glob patterns; use find_files first",
        Category: category,
        Target:   rawTarget,
        CWD:      root,
    }
}
resolved, inside, err := sandboxTarget(root, rawTarget)
if err != nil {
    return CheckResult{
        Decision: DecisionDeny,
        Source:   "sandbox",
        Reason:   "path could not be resolved for sandbox check",
        Category: category,
        Target:   rawTarget,
        CWD:      root,
    }
}
rel, relErr := filepath.Rel(root, resolved)
if relErr != nil {
    rel = rawTarget
}
target = filepath.ToSlash(filepath.Clean(rel))
matchTarget = normalizeRulePath(root, rawMatchTarget)
isPath = true
if !inside {
    return CheckResult{
        Decision: DecisionDeny,
        Source:   "sandbox",
        Reason:   "path is outside the project root",
        Category: category,
        Target:   target,
        CWD:      root,
    }
}
```

只有 inside 为 true，Engine 才查询分层规则和 Permission Mode。因此 User Allow、Session Allow 和 Bypass 都不能批准工作区外文件目标。

用于 Rule 匹配的路径仍基于原始目标做相对规范化，而不是使用 resolved real path。这样规则可以继续写成用户熟悉的 `src/**`，同时由前置沙箱单独保证真实目标没有越界。

## Tool 实现本身只做路径拼接

基础文件 Tool 的 `resolvePath` 会拒绝 `~` 并生成绝对路径，但不会检查是否位于工作区：

```go
func resolvePath(env Env, raw string) (string, error) {
    raw = strings.TrimSpace(raw)
    if raw == "" {
        return "", fmt.Errorf("path is required")
    }
    if strings.HasPrefix(raw, "~") {
        return "", fmt.Errorf("~ paths are not supported")
    }
    path := raw
    if !filepath.IsAbs(path) {
        path = filepath.Join(env.CWD, path)
    }
    abs, err := filepath.Abs(filepath.Clean(path))
    if err != nil {
        return "", err
    }
    return abs, nil
}
```

安全依赖 Agent 在 Registry.Execute 之前调用 Permission Engine。测试或其他调用方若直接使用 Tool，或者 Runner 没有配置 Engine，就不会自动获得工作区沙箱。这是模块边界，不应把文件 Tool 自身描述为沙箱实现。

## 当前实现不保护什么

- `sandboxTarget` 只用于文件类 Tool。`run_command` 虽以 Workspace 为 CWD，仍可读取 `/etc/passwd`、执行 `../script` 或修改其他绝对路径。
- 它不是 chroot、container、mount namespace 或系统调用过滤；同一进程中的其他代码不受约束。
- 检查与真正 `os.Open`、`WriteFile` 之间存在时间窗口。另一个进程可以在检查后替换 symlink，形成典型 TOCTOU 风险。
- `CheckWithContext` 信任调用方提供的 Env CWD。该值来自本地 Runner/Worktree 装配而非模型参数，但 Permission Engine 不额外证明它属于最初 Engine root。
- 精确路径工具拒绝包含 glob 元字符的合法文件名，例如实际名为 `notes[1].txt` 的文件。
- `evalSymlinksOrAncestor` 对任意 `os.Stat` 失败都会继续向父目录查找，不只处理 `IsNotExist`；权限错误最后可能被表现为一般路径解析失败。

## 完整流程

```text
文件 ToolCall
  -> 按工具类型解析 path / pattern
  -> exact Tool 拒绝 glob 元字符
  -> find_files 从 glob 提取静态根
  -> 相对路径拼到本次 Env CWD
  -> 已有目标直接 EvalSymlinks
  -> 未创建目标向上寻找存在祖先
  -> 解析祖先 symlink 并接回缺失片段
  -> insideRoot(real root, real target)
  -> 越界：DecisionDeny(source=sandbox)
  -> 内部：继续 Rule 与 Permission Mode
```

## 测试验证了什么

Sandbox 测试覆盖普通项目路径、`../outside`、`/etc/passwd`、未创建的多级写入路径和项目内 symlink 指向外部。Target 测试覆盖 Search 默认路径、Glob 静态根、缺失参数和精确路径 glob 检测。Engine 测试确认 Bypass Mode 无法放行越界 Read。

现有测试没有覆盖 symlink 检查后的竞态、任意 Worktree CWD、文件名 glob 元字符或命令级文件访问，这些不能从当前单元测试推导为安全保证。

## 小结

PseudoClaude 的工作区边界不是对原始字符串做一次 `HasPrefix`，而是把不同文件 Tool 收敛成目标，解析真实根与真实目标，并为未创建文件回溯最近存在祖先。硬检查通过之后，配置规则才有资格参与授权。

下一篇进入可配置策略：Session、Local、Project、User 四层 Rule 如何匹配，Permission Mode 如何兜底，以及交互批准怎样生成可复用规则。
