---
title: 分层权限规则：匹配、优先级与授权持久化
description: How PseudoClaude evaluates session, local, project, and user permission rules before applying mode fallbacks and reusable approvals.
date: 2026-08-28
order: 16
tags:
  - PseudoClaude
  - Permission
  - Policy
  - Go
---

危险命令和工作区越界适合硬拒绝，但普通写文件、运行测试或调用 MCP Tool 不能一律禁止。PseudoClaude 将剩余决策交给分层 Rule 和 Permission Mode：显式规则表达稳定策略，Mode 只决定没有规则命中时是 Allow 还是 Ask。

这套设计的关键不是 YAML 本身，而是两个不同优先级：同一个 RuleSet 内 Deny 先于 Allow；不同来源之间则按 Session、Local、Project、User 顺序，第一层命中立即结束。

## 三个磁盘层和一个内存层

默认配置路径是：

```go
func DefaultOptions(root string) Options {
    home, err := os.UserHomeDir()
    userPath := filepath.Join(".PseudoClaude", "permissions.yaml")
    if err == nil && home != "" {
        userPath = filepath.Join(home, ".PseudoClaude", "permissions.yaml")
    }
    return Options{
        UserPath:    userPath,
        ProjectPath: filepath.Join(root, ".PseudoClaude", "permissions.yaml"),
        LocalPath:   filepath.Join(root, ".PseudoClaude", "permissions.local.yaml"),
    }
}
```

User 层跨项目共享；Project 层随仓库共享；Local 层用于当前项目的个人授权，默认 `.gitignore` 已排除 `permissions.local.yaml`；Session 层只存在于当前 Engine 内存中。

磁盘结构包含启动模式和 Allow/Deny 文本：

```yaml
defaultMode: default

permissions:
  allow:
    - Read
    - Glob(internal/**)
    - Bash(go test ./...)
  deny:
    - Bash(git push *)
    - Write(.PseudoClaude/config.yaml)
```

不存在的文件视为空配置。读取失败、YAML 错误或单条坏规则都会形成 LoadIssue，其他层和同文件中的合法规则仍可加载，避免一条可选策略阻止程序启动。

## Rule 使用面向用户的工具名

配置不直接暴露内部 Go 路由名。基础映射包括 Bash、Read、Write、Edit、Glob 和 Grep；MCP 名称保持 `mcp__server__tool`，也支持在 Tool 名中使用通配符。

规则格式是 `Tool` 或 `Tool(pattern)`：

```go
func parseRuleWithError(text string, action Decision) (Rule, error) {
    if action != DecisionAllow && action != DecisionDeny {
        return Rule{}, fmt.Errorf("invalid action %q", action)
    }
    text = strings.TrimSpace(text)
    if text == "" {
        return Rule{}, fmt.Errorf("empty rule")
    }
    tool := text
    pattern := ""
    if idx := strings.Index(text, "("); idx >= 0 {
        if !strings.HasSuffix(text, ")") {
            return Rule{}, fmt.Errorf("missing closing parenthesis")
        }
        tool = strings.TrimSpace(text[:idx])
        pattern = strings.TrimSpace(text[idx+1 : len(text)-1])
    }
    if tool == "" || internalName(tool) == "" {
        return Rule{}, fmt.Errorf("unknown tool %q", tool)
    }
    rule := Rule{Tool: tool, Pattern: pattern, Action: action}
    if pattern != "" {
        matcher, err := CompileMatcher(pattern)
        if err != nil {
            return Rule{}, err
        }
        rule.Matcher = matcher
    }
    return rule, nil
}
```

没有 pattern 的 `Read` 对该 Tool 的全部目标生效。Pattern 默认使用 Glob；`=` 前缀表示 Exact，`~` 表示 Regex，`!` 对后续完整 Matcher 取反。例如：

| 规则 | 含义 |
| --- | --- |
| `Bash(git *)` | Glob 匹配所有以 `git ` 开始的规范化命令 |
| `Bash(=git status)` | 只匹配完全相等的 `git status` |
| `Bash(~^npm (install\|test)$)` | 使用 Go 正则 |
| `Bash(!~^rm)` | 匹配不以 `rm` 开始的命令 |
| `Write(src/**)` | 以路径语义匹配 src 子树 |
| `mcp__github__*` | 匹配同一 MCP Server 的工具名 |

路径 Glob 中 `*` 不跨目录、`**` 可以跨目录；命令和 MCP Tool Glob 中 `*` 可以跨任意字符。

## 同层 Deny 先于 Allow

一个 RuleSet 分别保存两组已经编译的 Rule。匹配时固定先遍历 Deny：

```go
func (rs RuleSet) Match(tool, target string, isPath bool) (CheckResult, bool) {
    for _, rule := range rs.Deny {
        if ruleMatches(rule, tool, target, isPath) {
            return CheckResult{
                Decision: DecisionDeny,
                Source:   "rule",
                Reason:   "denied by permission rule " + ruleString(rule),
                Rule:     ruleString(rule),
                Target:   target,
            }, true
        }
    }
    for _, rule := range rs.Allow {
        if ruleMatches(rule, tool, target, isPath) {
            return CheckResult{
                Decision: DecisionAllow,
                Source:   "rule",
                Reason:   "allowed by permission rule " + ruleString(rule),
                Rule:     ruleString(rule),
                Target:   target,
            }, true
        }
    }
    return CheckResult{}, false
}
```

因此同一文件中 `allow: Bash(git *)` 和 `deny: Bash(git push)` 同时命中时，Push 被拒绝，与 YAML 中出现顺序无关。

## 跨层采用第一个命中

Engine 的外层顺序不同：

```go
for _, rules := range []RuleSet{
    e.session,
    e.local,
    e.project,
    e.user,
} {
    if result, ok := rules.Match(call.Name, matchTarget, isPath); ok {
        result.Category = category
        if result.Target == "" {
            result.Target = target
        }
        result.CWD = root
        return result
    }
}
decision := modeFallback(mode, category)
```

高层一旦得到 Allow 或 Deny，就不会继续看低层。结果是 Local Allow 可以覆盖 Project Deny，Session Deny 又可以覆盖 Local Allow。它不是“所有层 Deny 全局优先”，而是“层优先，层内 Deny 优先”。

这个选择允许个人 Local 配置修正共享 Project 策略，但也意味着 User 层无法用 Deny 推翻项目内已经命中的 Allow。设计团队需要明确这正是当前策略，而不是从文件名推测优先级。

## Permission Mode 只做最后兜底

四种模式把已知 Tool 分类为 Read、Write 或 Exec：

| Mode | Read | Write | Exec |
| --- | --- | --- | --- |
| `strict` | Ask | Ask | Ask |
| `default` | Allow | Ask | Ask |
| `acceptEdits` | Allow | Allow | Ask |
| `bypassPermissions` | Allow | Allow | Allow |

```go
func modeFallback(mode Mode, category Category) Decision {
    switch ParseMode(mode.String()) {
    case ModeStrict:
        return DecisionAsk
    case ModeDefault:
        if category == CategoryRead {
            return DecisionAllow
        }
        return DecisionAsk
    case ModeAcceptEdits:
        if category == CategoryRead || category == CategoryWrite {
            return DecisionAllow
        }
        return DecisionAsk
    case ModeBypassPermissions:
        return DecisionAllow
    default:
        return DecisionAsk
    }
}
```

启动 Mode 按 Local、Project、User 的 `defaultMode` 选择，三层都没有合法值时使用 Default。TUI 中 Shift+Tab 按 Strict、Default、AcceptEdits、Bypass、Strict 循环切换，只改变当前交互状态，不写配置。

扩展 Tool 的 SafetyReadOnly 映射为 Read，SafetySideEffect 映射为 Write。MCP Side Effect Tool 因此在 AcceptEdits 下会被当作 Write 自动允许；本地 `run_command` 是唯一专门归为 Exec 的工具。

## Allow Session 与 Allow Forever

Ask 获批后，Engine 尝试从当前调用生成目标规则。Session 授权只更新最高优先级内存层：

```go
func (e *Engine) AllowForSession(call llm.ToolCall) error {
    rule, _, ok := e.ruleForCall(call)
    if !ok {
        return os.ErrInvalid
    }
    e.session.Allow = appendUniqueRule(e.session.Allow, rule)
    return nil
}
```

Allow Forever 实际含义是写入当前项目的 Local 配置，并立即更新内存：

```go
func (e *Engine) PersistLocalAllow(call llm.ToolCall) error {
    rule, text, ok := e.ruleForCall(call)
    if !ok {
        return os.ErrInvalid
    }
    settings, _ := loadSettings(e.localPath)
    if !containsString(settings.Permissions.Allow, text) {
        settings.Permissions.Allow = append(settings.Permissions.Allow, text)
    }
    if err := os.MkdirAll(filepath.Dir(e.localPath), 0o755); err != nil {
        return err
    }
    data, err := yaml.Marshal(settings)
    if err != nil {
        return err
    }
    if err := os.WriteFile(e.localPath, data, 0o644); err != nil {
        return err
    }
    e.local.Allow = appendUniqueRule(e.local.Allow, rule)
    return nil
}
```

重复授权按 Tool、Pattern 和 Action 去重。重新创建 Engine 后，Local 文件中的规则仍然有效；Session 授权则随 Engine 生命周期结束。

## 当前持久化边界

- “Forever”不是 User 全局授权，而是当前项目的 `permissions.local.yaml`；换项目不会继承。
- `ruleForCall` 只会为核心命令/文件 Tool 提取目标。MCP 和一般扩展 Tool 的 Allow Session/Forever 当前会返回 `permission_error`，Allow Once 才能成功。
- 代码注释称生成精确规则，但 Pattern 没有自动加 `=`。命令参数若包含 `*`、`?` 等字符，会按默认 Glob 编译，授权范围可能比一次调用更宽。
- `PersistLocalAllow` 忽略 `loadSettings` 的 Issue。现有 Local YAML 损坏时，它可能以空 Settings 重写文件，丢掉原内容。
- 文件通过 `os.WriteFile` 整体覆盖，没有临时文件 rename、文件锁或跨进程并发保护；进程中断和并发写入可能造成丢更新。
- Session RuleSet 同样没有互斥锁。主 Runner 的副作用 Tool 串行执行降低了常见竞争，但共享 Engine 的并发子 Agent 仍需额外审查。
- 更高层 Allow 可以覆盖更低层 Deny；若希望全局 Deny 永不被项目覆盖，当前优先级模型不满足该策略。

## 完整决策流程

```text
硬性命令/路径检查通过
  -> Session RuleSet: Deny then Allow
  -> Local RuleSet: Deny then Allow
  -> Project RuleSet: Deny then Allow
  -> User RuleSet: Deny then Allow
  -> 无规则命中
  -> Permission Mode 按 Read/Write/Exec 兜底
  -> Allow: 执行
  -> Deny: permission_denied
  -> Ask: 进入交互审批
       -> Allow session: 内存 Rule
       -> Allow forever: Project Local YAML + 内存 Rule
```

## 测试验证了什么

Settings 测试覆盖坏 YAML、坏 Rule 隔离和启动 Mode 优先级；Matcher 测试覆盖 Glob、Exact、Regex、Not 及错误语法；Rule 测试覆盖路径、命令和 MCP Tool Glob，以及同层 Deny；Engine 测试验证 Local Allow 覆盖 Project/User、Session Deny 覆盖全部低层；Persist 测试验证 Session 不写文件、Local 去重和重启后生效。

现有测试没有覆盖损坏 Local 文件后 Persist、Pattern 元字符导致的授权扩大、MCP 持久授权失败或多 goroutine/多进程同时写配置。

## 小结

PseudoClaude 将稳定策略和临时交互分开：四层 Rule 先按明确顺序匹配，Mode 只为未命中调用提供默认行为，审批结果再选择只执行一次、写入 Session 或项目 Local 层。

下一篇沿 Ask 分支继续，说明 Agent 怎样暂停单个 ToolCall、让 Bubble Tea 展示审批选项，再通过 channel 把决定送回等待中的执行流程。
