---
title: 危险命令防线：黑名单如何检查 Tool Call
description: How PseudoClaude normalizes run_command arguments and hard-denies known destructive patterns before configurable rules and permission modes.
date: 2026-08-28
order: 14
tags:
  - PseudoClaude
  - Security
  - Command
  - Go
---

`run_command` 是 Coding Agent 中风险最高的基础 Tool。模型可以用它运行测试，也可能请求删除目录、格式化设备或制造 fork bomb。把这些调用全部交给 Permission Mode 并不够：用户切到 Bypass Mode 后，未命中规则的命令会自动允许。

PseudoClaude 在可配置策略之前放了一层不可配置的危险命令黑名单。它能保证已经识别的模式不会被显式 Allow 或 Bypass 覆盖；但它仍是正则启发式检查，不是 Shell 解析器或操作系统级隔离。

## run_command 接收结构化参数

模型不是提交一整段默认交给 Shell 的脚本，而是分别给出可执行文件和参数数组：

```go
func (runCommandTool) Definition() Definition {
    return Definition{
        Name:        "run_command",
        Description: "Run a local command in the current workspace and return stdout, stderr, and exit status. Prefer read_file, find_files, and search_code for reading, locating, or searching files; use commands for build, test, validation, or shell-only operations.",
        Safety:      SafetySideEffect,
        InputSchema: objectSchema(map[string]any{
            "command": stringProp("Executable command name or path."),
            "args": map[string]any{
                "type":        "array",
                "description": "Optional command arguments.",
                "items":       map[string]any{"type": "string"},
            },
        }, "command"),
    }
}
```

执行时使用 `exec.CommandContext`，参数不会默认再经过 Shell 展开：

```go
cmd := exec.CommandContext(ctx, args.Command, args.Args...)
cmd.Dir = env.CWD
var stdout, stderr bytes.Buffer
cmd.Stdout = &stdout
cmd.Stderr = &stderr
err := cmd.Run()
```

因此 `command="echo"`、`args=["$HOME"]` 不会自动展开环境变量，分号和管道也只是普通参数。模型仍可显式调用 `sh -c`，此时 Shell 语义由被启动的 `sh` 提供，而不是 `run_command` 自己提供。

## 权限层先重建稳定命令串

规则、审批摘要和黑名单需要同一种目标表示。`commandText` 解析 ToolCall，并对包含空白、引号或反斜杠的参数使用 Go Quote：

```go
func commandText(call llm.ToolCall) (string, bool) {
    if call.Name != "run_command" {
        return "", false
    }
    var args struct {
        Command string   `json:"command"`
        Args    []string `json:"args"`
    }
    if err := json.Unmarshal(call.Arguments, &args); err != nil {
        return "", false
    }
    args.Command = strings.TrimSpace(args.Command)
    if args.Command == "" {
        return "", false
    }
    parts := []string{args.Command}
    for _, arg := range args.Args {
        if strings.ContainsAny(arg, " \t\n\"'\\") {
            parts = append(parts, strconv.Quote(arg))
        } else {
            parts = append(parts, arg)
        }
    }
    return strings.Join(parts, " "), true
}
```

例如 `{"command":"git","args":["status","a b"]}` 会变成 `git status "a b"`。这不是重新生成可执行 Shell 脚本，而是用于匹配和展示的规范化字符串。

参数 JSON 无法解析或 command 为空时，Permission Engine 直接 Deny。因为系统无法确认实际目标，此时不会降级成 Ask，让用户为一段不可解释输入授权。

## 黑名单位于所有可配置策略之前

Engine 在 Exec 分类分支中先调用 `commandText`，再检查 blacklist：

```go
if category == CategoryExec {
    command, ok := commandText(call)
    if !ok {
        return CheckResult{
            Decision: DecisionDeny,
            Source:   "unknown",
            Reason:   "command arguments could not be parsed",
            Category: category,
            CWD:      root,
        }
    }
    target = command
    matchTarget = command
    if ok, pattern := hitsBlacklist(command); ok {
        return CheckResult{
            Decision: DecisionDeny,
            Source:   "blacklist",
            Reason:   "command matches dangerous blacklist pattern",
            Rule:     pattern,
            Category: category,
            Target:   target,
            CWD:      root,
        }
    }
}
```

只有没有命中黑名单，调用才会继续查 Session、Local、Project、User 规则和 Permission Mode。这意味着 `Bash(rm *)` Allow 规则或 `bypassPermissions` 都没有机会覆盖已经命中的结果。

## 当前保护哪些命令

黑名单由八个编译期正则组成，主要覆盖：

```go
var dangerousCommandPatterns = []*regexp.Regexp{
    regexp.MustCompile(`(?i)(^|\s)rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)[^\n]*(?:\s|=)(/|~)(?:\s|$)`),
    regexp.MustCompile(`(?i)(^|\s)rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)[^\n]*(?:/bin|/boot|/dev|/etc|/home|/lib|/private|/sbin|/usr|/var)(?:\s|$)`),
    regexp.MustCompile(`(?i)(^|\s)dd\s+[^\n]*(?:^|\s)of=/dev/(?:disk|rdisk|sd|hd|vd|nvme|mapper/)`),
    regexp.MustCompile(`(?i)(^|\s)(mkfs|mke2fs|newfs|diskutil\s+eraseDisk|format)\b[^\n]*(?:/dev/|[A-Z]:)`),
    regexp.MustCompile(`:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`),
    regexp.MustCompile(`(?i)>\s*/dev/(?:disk|rdisk|sd|hd|vd|nvme)`),
    regexp.MustCompile(`(?i)(^|\s)chmod\s+-R\s+777\s+/(?:\s|$)`),
    regexp.MustCompile(`(?i)(^|\s)chown\s+-R\s+[^;\n]+\s+/(?:\s|$)`),
}
```

它针对的是系统根目录、关键系统目录、块设备、文件系统格式化、fork bomb，以及递归修改根目录权限或所有者。`rm -rf ./build` 和普通镜像写入 `dd if=input of=output.img` 不命中，让正常构建清理和文件操作继续进入规则或审批。

`hitsBlacklist` 返回第一个命中表达式，CheckResult 会把它放入 Rule 字段，工具失败结果和日志因此能解释拒绝原因：

```go
func hitsBlacklist(command string) (bool, string) {
    normalized := strings.TrimSpace(command)
    if normalized == "" {
        return false, ""
    }
    for _, pattern := range dangerousCommandPatterns {
        if pattern.MatchString(normalized) {
            return true, pattern.String()
        }
    }
    return false, ""
}
```

## 拒绝仍然是 ReAct Observation

黑名单命中不会终止整个 Agent 进程。Agent 将 CheckResult 转成 `permission_denied` Tool Result，写回 Conversation；模型可以看到失败原因并选择更安全的动作。测试中的 Provider 第一轮强行请求 `rm -rf /`，工具没有执行，第二轮仍能返回 `safer plan` 并正常结束。

这比直接关闭进程更适合 ReAct：危险动作被硬拒绝，但任务可以通过其他工具继续完成。

## 黑名单不是完整命令安全模型

当前实现需要明确以下边界：

- 正则匹配的是重建后的显示串，不会解析 Shell AST、脚本文件、环境变量或被调用程序的二次执行行为。
- `/bin/rm -rf /` 的可执行文件包含路径，现有 `(^|\s)rm` 模式不会按 basename 归一。
- `sh -c "rm -rf /"` 中危险文本位于带引号参数内，现有模式不保证识别包装后的 Shell payload。
- `python -c`、解释器脚本、下载后执行、资源耗尽和网络破坏等不在八个模式的穷举范围内。
- 文件路径沙箱不应用于 `run_command`。命令的工作目录设为 Workspace，但进程仍可以使用绝对路径或 `..` 访问外部文件。
- 黑名单不可由配置扩展；新增危险模式需要修改源码并增加测试。

所以它应被描述为“对已知高危命令的不可绕过策略层”，这里的不可绕过仅指后续 Permission Rule 和 Mode 不能覆盖一次已经命中的判断，不代表任何等价命令都能被识别。

## 完整流程

```text
Provider 返回 run_command ToolCall
  -> JSON 解析 command + args
  -> 参数 Quote 后重建稳定命令串
  -> 依次匹配八个危险正则
  -> 命中：DecisionDeny(source=blacklist)
  -> permission_denied Tool Result 回填模型
  -> 未命中：继续分层规则与 Permission Mode
  -> Allow 后 exec.CommandContext 直接启动进程
```

## 测试验证了什么

Blacklist 测试覆盖 `rm -rf /`、`rm -fr ~`、fork bomb、危险 `dd`、`mkfs` 和设备重定向，并确认 `rm -rf ./build`、`git status` 与普通文件 `dd` 不误报。Engine 测试验证 Bypass Mode 不能覆盖已命中的 `rm -rf /`。Command 测试覆盖直接进程执行、退出码、输出截断和 Context 超时。

现有测试没有覆盖绝对 executable、Shell wrapper、解释器包装或命令等价变形。这些属于本篇从实现结构推导出的风险，而不是已经通过测试证明安全的场景。

## 小结

PseudoClaude 将危险命令检查放在可配置授权之前，并把命令参数先归一为统一目标。这个顺序保证已识别模式不会被 Bypass 或 Allow 覆盖，同时保留拒绝结果进入 ReAct 循环的能力。

下一篇继续分析另一项硬边界：文件 Tool 怎样处理绝对路径、目录穿越、未创建文件和符号链接，确保目标真实位置仍在工作区内。
