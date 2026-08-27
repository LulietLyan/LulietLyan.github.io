---
title: 安全边界：权限引擎与 Plan Mode
description: How PseudoClaude combines prompts, tool filtering, runtime validation, and permission rules to constrain side effects in Plan Mode.
date: 2026-08-21
order: 6
tags:
  - PseudoClaude
  - Security
  - Plan Mode
  - Go
---

只要 Agent 能写文件或执行命令，“模型应该不会这样做”就不能成为安全边界。模型输出是不可信输入，提示词只能影响它更可能生成什么，不能保证本地程序最终执行什么。

PseudoClaude 将安全拆成两个相关但不同的概念：Agent Mode 决定本轮任务是聊天、规划还是执行；Permission Mode 决定显式规则都未命中时，一次已知工具调用应该自动允许还是询问用户。

## Plan Mode 不等于 Permission Mode

Agent Mode 定义在执行层：

```go
const (
    ModeChat Mode = "chat"
    ModePlan Mode = "plan"
    ModeDo   Mode = "do"
)
```

Permission Mode 定义在安全层：

```go
const (
    ModeStrict            Mode = "strict"
    ModeDefault           Mode = "default"
    ModeAcceptEdits       Mode = "acceptEdits"
    ModeBypassPermissions Mode = "bypassPermissions"
)
```

两者解决的问题不同。Plan Mode 表示“这一轮只调查和产出计划”；`default` 或 `acceptEdits` 表示“没有规则时，读、写、命令分别如何处理”。即使用户将 Permission Mode 切到 Bypass，Plan Mode 的执行期 Read Only 限制仍然存在；反过来，Chat Mode 也不会自动绕过权限引擎。

## 第一层：任务提示词与周期提醒

进入 Plan Mode 时，Runner 不直接使用原始任务文本，而是构造带边界的 Plan Prompt：

```go
func planPrompt(task string) string {
    return fmt.Sprintf(`Plan mode. Your job is to clarify and plan before implementation.

Rules:
- Use only read-only tools to inspect the workspace.
- Do not edit files, create directories, run commands, install dependencies, or make any project changes.
- If the task is broad or underspecified, ask concise clarifying questions first instead of inventing requirements.
- If you already have enough information, produce an implementation plan with target files, steps, validation, and risks.
- Do not claim that files or directories were created in Plan mode.

Task:
%s`, strings.TrimSpace(task))
}
```

Runner 在第一轮以及之后每四轮再次加入 `PlanReminder`。这可以减少长循环中模型逐渐偏离任务模式的概率，但它仍然只是行为引导。真正的只读边界在工具列表与执行路径中。

## 第二层：只发送 Read Only 定义

`prepareRequest` 同时生成发给模型的 Definition 和留在本地的执行选项：

```go
case ModePlan:
    return planPrompt(req.PlanTask),
        filterDefinitionsBySafety(
            r.Registry.DefinitionsFiltered(r.AllowedTools),
            tools.SafetyReadOnly,
        ),
        toolExecutionOptions{
            AllowedSafety: map[tools.Safety]bool{
                tools.SafetyReadOnly: true,
            },
            AllowedNames: allowedNames,
            Sub:          r.Sub,
        }
```

模型请求中只出现 `SafetyReadOnly` 的 Definition。默认基础工具里，`read_file`、`find_files` 和 `search_code` 会保留，`write_file`、`edit_file` 与 `run_command` 不会出现。先按 Allowed Tools 做名称过滤，再按 Safety 取交集，因此 Skill 或 SubAgent 的工具限制也不会被 Plan Mode 扩大。

Definition 过滤能降低错误调用概率，却不能防止模型或 Provider 返回一个没有公开的 `write_file`。所以同一段代码还生成了 `AllowedSafety`，供执行阶段再次检查。

## 第三层：执行前再次检查 Safety

真正进入 Registry 前，Agent 层调用 `executeAllowedTool`：

```go
func executeAllowedTool(
    ctx context.Context,
    registry *tools.Registry,
    env tools.Env,
    call llm.ToolCall,
    opts toolExecutionOptions,
) tools.Result {
    if safety, ok := registry.Safety(call.Name); ok && !opts.allows(safety) {
        return tools.Failure(
            call.Name,
            "tool_not_allowed",
            "tool is not available in the current mode",
            map[string]any{"call_id": call.ID, "safety": string(safety)},
        )
    }
    if !opts.allowsName(registry, call.Name) {
        return tools.Failure(
            call.Name,
            "tool_not_allowed",
            "tool is not available for the active skill",
            map[string]any{"call_id": call.ID},
        )
    }
    return registry.Execute(ctx, tools.Call{
        ID: call.ID, Name: call.Name, Arguments: json.RawMessage(call.Arguments),
    }, env)
}
```

这一步不依赖模型是否见过 Definition。只要当前模式不允许该 Safety，工具实现就不会执行，失败结果会写回 Conversation。测试专门构造了一个在 Plan Mode 中强行返回 `write_file` 的 Provider，并断言 Tool 未执行且消息中包含 `tool_not_allowed`。

Plan Mode 的只读边界到这里由三层组成：提示词约束意图，Definition 过滤限制可见能力，Allowed Safety 在执行前建立硬校验。

## 权限引擎是正交的参数级边界

Permission Engine 适用于所有 Agent Mode。它处理的不是“规划还是执行”，而是某个具体工具和目标是否安全。`CheckWithContext` 首先完成分类，并在命令路径上优先检查黑名单：

```go
category, knownCategory := classify(call, safety)
friendly := friendlyName(call.Name)
if !knownCategory || friendly == "" {
    return CheckResult{
        Decision: DecisionAsk,
        Source:   "unknown",
        Reason:   fmt.Sprintf("tool %q is not covered by permission rules", call.Name),
        Category: category,
        CWD:      root,
    }
}

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

文件与 MCP 目标解析完成后，函数再按优先级查找规则，最后才使用 Permission Mode：

```go
for _, rules := range []RuleSet{e.session, e.local, e.project, e.user} {
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
return CheckResult{
    Decision: decision,
    Source:   "mode",
    Reason:   fmt.Sprintf("%s mode requires %s for %s tools", ParseMode(mode.String()), decision, category),
    Category: category,
    Target:   target,
    CWD:      root,
}
```

中间的文件分支会先解析参数和真实路径，再执行沙箱判断。完整顺序是：

```text
工具分类与参数可解释性
  -> 命令黑名单 / 文件路径沙箱
  -> session 规则
  -> project local 规则
  -> project 规则
  -> user 规则
  -> Permission Mode fallback
```

硬性检查位于规则和模式之前。`bypassPermissions` 只改变最后的 fallback，不能允许 `rm -rf /`，也不能读取项目根目录外的文件。

## 文件沙箱不仅检查 `..`

Permission Engine 先将项目根目录转换为真实绝对路径。检查写入一个尚不存在的文件时，`evalSymlinksOrAncestor` 会向上寻找最近的已存在祖先，解析祖先符号链接，再接回缺失路径段。

因此，下面几类路径都要基于解析后的真实位置判断：

- `../outside.txt` 形式的目录穿越。
- `/etc/passwd` 形式的绝对路径。
- 项目内符号链接指向外部目录后再拼接文件名。
- 尚不存在的新文件路径。

不能只对原始字符串做前缀匹配，否则 `project/link/escape.txt` 看似位于项目下，真实目标却可能在外部目录。

## 规则与 Permission Mode

每个 RuleSet 内先匹配 Deny，再匹配 Allow；不同层级按 Session、Project Local、Project、User 的优先级查找。高优先级层一旦命中就不再查看低优先级层。

显式规则都未命中时，Permission Mode 的行为是：

| Permission Mode | Read | Write | Exec |
| --- | --- | --- | --- |
| `strict` | Ask | Ask | Ask |
| `default` | Allow | Ask | Ask |
| `acceptEdits` | Allow | Allow | Ask |
| `bypassPermissions` | Allow | Allow | Allow |

Ask 会被 Agent 层转换成 `EventApproval`。用户可以只允许一次、允许本次 Session、持久化到项目本地配置，或拒绝本次调用：

```go
switch decision {
case permission.ApprovalAllowOnce:
    return executeAllowedTool(ctx, registry, env, call, opts)
case permission.ApprovalAllowSession:
    if err := engine.AllowForSession(call); err != nil {
        return tools.Failure(call.Name, "permission_error", err.Error(), permissionMetadata(call, check))
    }
    return executeAllowedTool(ctx, registry, env, call, opts)
case permission.ApprovalAllowForever:
    if err := engine.PersistLocalAllow(call); err != nil {
        return tools.Failure(call.Name, "permission_error", err.Error(), permissionMetadata(call, check))
    }
    return executeAllowedTool(ctx, registry, env, call, opts)
default:
    check.Source = "user"
    check.Reason = "user denied this tool call"
    return permissionDeniedResult(call, check)
}
```

即使用户在审批界面允许一个调用，最终仍会进入 `executeAllowedTool`。因此 Plan Mode 中伪造的 Side Effect Tool 不会因为一次权限批准而越过 Allowed Safety。

## 安全边界的完整路径

一次 ToolCall 从模型到执行的约束关系是：

```text
Agent Mode prompt / reminder
  -> model-visible Definition filter
  -> Hook pre-check
  -> Permission hard checks and rules
  -> optional user approval
  -> Allowed Safety / Allowed Names check
  -> Registry input, timeout and panic guards
  -> Tool.Execute
```

这里没有任何单层能够独立承担安全责任。提示词无法阻止伪造调用，Safety 无法判断具体命令，Permission Mode 无法绕过沙箱，Registry 的 JSON 校验也不决定用户意图。各层只处理自己能够可靠判断的信息。

## 小结

PseudoClaude 的 Plan Mode 不是一段“请勿修改文件”的提示词，而是提示词、Definition 过滤和执行期 Safety 校验共同形成的只读模式。Permission Engine 再为所有模式提供参数级黑名单、路径沙箱、分层规则和交互审批。

至此，前六篇完成了核心运行时的主线：入口装配运行时，TUI 驱动交互，Runner 驱动 ReAct 循环，Tool 统一能力边界，状态模块管理上下文生命周期，安全模块控制副作用。

下一阶段转向模型与工具生态。下一篇先从 Provider 边界开始，说明 Anthropic 与 OpenAI 不同的消息和流式协议如何被归一成 Runner 可消费的事件。
