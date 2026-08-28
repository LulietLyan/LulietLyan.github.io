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
// Mode 描述 Agent 当前回合的工作意图，与 permission.Mode 的授权策略相互独立。
type Mode string

const (
    ModeChat Mode = "chat" // 普通对话或直接执行任务
    ModePlan Mode = "plan" // 只调查并生成计划，执行期仅允许 ReadOnly 工具
    ModeDo   Mode = "do"   // 根据已确认 Plan 执行原始任务
)
```

Permission Mode 定义在安全层：

```go
// Mode 控制没有显式规则命中时的默认决策，不会覆盖黑名单、路径边界或显式规则。
type Mode string

const (
    // ModeStrict 对读、写、执行都询问用户。
    ModeStrict Mode = "strict"
    // ModeDefault 自动允许读取，写入和命令执行需要询问。
    ModeDefault Mode = "default"
    // ModeAcceptEdits 自动允许读取和文件修改，命令执行仍需询问。
    ModeAcceptEdits Mode = "acceptEdits"
    // ModeBypassPermissions 对已通过硬性检查且没有规则命中的调用自动放行。
    ModeBypassPermissions Mode = "bypassPermissions"
)
```

两者解决的问题不同。Plan Mode 表示“这一轮只调查和产出计划”；`default` 或 `acceptEdits` 表示“没有规则时，读、写、命令分别如何处理”。即使用户将 Permission Mode 切到 Bypass，Plan Mode 的执行期 Read Only 限制仍然存在；反过来，Chat Mode 也不会自动绕过权限引擎。

可以把它们理解成两个正交坐标：Agent Mode 限制“本轮允许哪些能力类别”，Permission Mode 决定“能力类别允许后，具体目标是否需要询问”。一个调用必须同时通过两个坐标，任何一边允许都不能替另一边授权。

## 第一层：任务提示词与周期提醒

进入 Plan Mode 时，Runner 不直接使用原始任务文本，而是构造带边界的 Plan Prompt：

```go
// planPrompt 把原始任务包装成只调查、不修改的行为说明。
// 这是降低误调用概率的软约束，硬边界仍由 Definition 过滤和执行期 AllowedSafety 提供。
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
// prepareRequest 把 Registry 中允许暴露的 Definition 发给模型；此时只描述能力，
// 不执行任何工具。模型随后返回 ToolCall，才会进入 Registry.Execute。
func (r Runner) prepareRequest(req Request) (string, []tools.Definition, toolExecutionOptions) {
    // 没有 Registry 时仍能生成文本请求，但不会向模型暴露或执行任何工具。
    if r.Registry == nil {
        return requestText(req), nil, toolExecutionOptions{}
    }
    // 同一名称集合既参与 Definition 可见性过滤，也留给执行期进行第二次检查。
    allowedNames := allowedNameSet(r.AllowedTools)
    switch req.Mode {
    case ModePlan:
        // Plan Mode 建立双重 ReadOnly 边界：模型只看见只读定义，伪造调用也会被 AllowedSafety 拒绝。
        return planPrompt(req.PlanTask),
            filterDefinitionsBySafety(
                r.Registry.DefinitionsFiltered(r.AllowedTools),
                tools.SafetyReadOnly,
            ),
            toolExecutionOptions{
                AllowedSafety: map[tools.Safety]bool{tools.SafetyReadOnly: true},
                AllowedNames:  allowedNames,
                Sub:           r.Sub,
            }
    case ModeDo:
        // Do Mode 使用原始任务与已确认 Plan 组装执行提示词，Safety 不再额外收窄。
        return doPrompt(req.PlanTask, req.PlanText),
            r.Registry.DefinitionsFiltered(r.AllowedTools),
            toolExecutionOptions{AllowedNames: allowedNames, Sub: r.Sub}
    default:
        // Chat Mode 使用普通文本，同时保留 Skill 或 SubAgent 提供的名称白名单。
        return requestText(req),
            r.Registry.DefinitionsFiltered(r.AllowedTools),
            toolExecutionOptions{AllowedNames: allowedNames, Sub: r.Sub}
    }
}

// filterDefinitionsBySafety 保持 Registry 的稳定名称顺序，仅保留目标 Safety 的模型契约。
// 它只影响模型可见性，真正执行前仍由 toolExecutionOptions.allows 复检。
func filterDefinitionsBySafety(defs []tools.Definition, safety tools.Safety) []tools.Definition {
    out := make([]tools.Definition, 0, len(defs))
    for _, def := range defs {
        if def.Safety == safety {
            out = append(out, def)
        }
    }
    return out
}
```

模型请求中只出现 `SafetyReadOnly` 的 Definition。默认基础工具里，`read_file`、`find_files` 和 `search_code` 会保留，`write_file`、`edit_file` 与 `run_command` 不会出现。先按 Allowed Tools 做名称过滤，再按 Safety 取交集，因此 Skill 或 SubAgent 的工具限制也不会被 Plan Mode 扩大。

Definition 过滤能降低错误调用概率，却不能防止模型或 Provider 返回一个没有公开的 `write_file`。所以同一段代码还生成了 `AllowedSafety`，供执行阶段再次检查。

这里有两个集合，含义不同：`defs` 是发给模型的可见契约，`toolExecutionOptions` 留在本地。只保留前者会留下执行边界缺口：模型虽然没看见写工具，但 Provider 仍可能返回写调用；只保留后者虽然安全，却会让模型反复尝试永远无法执行的能力。两者同时存在，既减少误调用，又建立硬边界。

## 第三层：执行前再次检查 Safety

真正进入 Registry 前，Agent 层调用 `executeAllowedTool`：

```go
// executeAllowedTool 是进入 Registry 前的最后一道能力校验。即使权限引擎已经 allow，
// 当前 Agent Mode、Skill 或 SubAgent 白名单仍可拒绝该调用。
func executeAllowedTool(
    ctx context.Context,
    registry *tools.Registry,
    env tools.Env,
    call llm.ToolCall,
    opts toolExecutionOptions,
) tools.Result {
    // Safety 白名单实现 Plan Mode 等模式的硬边界，不能被用户审批或 Permission Mode 绕过。
    if safety, ok := registry.Safety(call.Name); ok && !opts.allows(safety) {
        return tools.Failure(
            call.Name,
            "tool_not_allowed",
            "tool is not available in the current mode",
            map[string]any{"call_id": call.ID, "safety": string(safety)},
        )
    }
    // 名称白名单限制 Active Skill 或 SubAgent 的能力；System 工具由 allowsName 特别保留。
    if !opts.allowsName(registry, call.Name) {
        return tools.Failure(
            call.Name,
            "tool_not_allowed",
            "tool is not available for the active skill",
            map[string]any{"call_id": call.ID},
        )
    }
    // 通过 Agent 层约束后，转换为 tools.Call，交给 Registry 做路由、JSON、超时和 panic 保护。
    return registry.Execute(ctx, tools.Call{
        ID: call.ID, Name: call.Name, Arguments: json.RawMessage(call.Arguments),
    }, env)
}
```

这一步不依赖模型是否见过 Definition。只要当前模式不允许该 Safety，工具实现就不会执行，失败结果会写回 Conversation。测试专门构造了一个在 Plan Mode 中强行返回 `write_file` 的 Provider，并断言 Tool 未执行且消息中包含 `tool_not_allowed`。

Plan Mode 的只读边界到这里由三层组成：提示词约束意图，Definition 过滤限制可见能力，Allowed Safety 在执行前建立硬校验。

调用顺序上，Permission 检查发生在 `executeAllowedTool` 之前。因此一个伪造的 `write_file` 可能先得到 Permission allow，甚至经过一次用户审批，但随后仍会被 Plan Mode 的 `AllowedSafety` 拒绝。审批只回答“这个目标是否授权”，不能改变 Agent Mode。

System 控制面工具跳过普通 Permission 规则，但不会跳过 `executeAllowedTool`。它们可以绕过 Active Skill 的名称白名单，仍需满足当前 Safety 限制；`load_skill` 还保留了显式兼容判断，以支持尚未带 System 标记的注册路径。

## 权限引擎是正交的参数级边界

Permission Engine 适用于所有 Agent Mode。它处理的不是“规划还是执行”，而是某个具体工具和目标是否安全。`CheckWithContext` 首先完成分类，并在命令路径上优先检查黑名单：

```go
// 未知工具不直接放行；参数无法可靠解释时也宁可询问或拒绝。
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
    // Exec 规则匹配的是规范化命令文本，无法解析参数时直接拒绝。
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
    // 黑名单先于用户规则与 Permission Mode，显式 allow 和 bypass 都不能覆盖。
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
// 高优先级层一旦命中就停止查找；每个 RuleSet 内部仍是 deny 优先于 allow。
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

// 只有已知、可解释、通过黑名单与沙箱且未命中规则的调用，才进入模式兜底。
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

```go
// evalSymlinksOrAncestor 支持尚未创建的写入目标：先找到最近的已存在祖先并解析
// 其符号链接，再把缺失的路径段接回去，防止新文件路径绕过项目边界。
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

因此，下面几类路径都要基于解析后的真实位置判断：

- `../outside.txt` 形式的目录穿越。
- `/etc/passwd` 形式的绝对路径。
- 项目内符号链接指向外部目录后再拼接文件名。
- 尚不存在的新文件路径。

不能只对原始字符串做前缀匹配，否则 `project/link/escape.txt` 看似位于项目下，真实目标却可能在外部目录。

这个 sandbox 只覆盖通过文件工具解析出的目标，不是操作系统级隔离。`run_command` 启动的进程仍可能访问工作区外路径；命令路径依靠黑名单、分层规则、Permission Mode 和交互审批约束。因此把任意 shell 调用视为普通 ReadOnly Tool 会破坏安全模型。

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
    // Session 授权只更新内存规则，进程结束后失效。
    if err := engine.AllowForSession(call); err != nil {
        return tools.Failure(call.Name, "permission_error", err.Error(), permissionMetadata(call, check))
    }
    return executeAllowedTool(ctx, registry, env, call, opts)
case permission.ApprovalAllowForever:
    // Forever 授权写入项目本地规则，后续会话可以复用。
    if err := engine.PersistLocalAllow(call); err != nil {
        return tools.Failure(call.Name, "permission_error", err.Error(), permissionMetadata(call, check))
    }
    return executeAllowedTool(ctx, registry, env, call, opts)
default:
    // 显式拒绝也作为 ToolResult 返回，让模型可以解释或调整方案。
    check.Source = "user"
    check.Reason = "user denied this tool call"
    return permissionDeniedResult(call, check)
}
```

即使用户在审批界面允许一个调用，最终仍会进入 `executeAllowedTool`。因此 Plan Mode 中伪造的 Side Effect Tool 不会因为一次权限批准而越过 Allowed Safety。

## 四个对照场景

| Agent Mode | Permission Mode | ToolCall | 结果 |
| --- | --- | --- | --- |
| Plan | bypass | `write_file` | Definition 不可见；即使伪造，最终被 AllowedSafety 拒绝 |
| Plan | default | 工作区内 `read_file` | ReadOnly 可见，Permission 默认允许读取，进入 Registry |
| Chat | default | 工作区内 `write_file` | Permission 返回 ask，用户允许后再经过执行白名单 |
| Chat | bypass | 工作区外 `read_file` | sandbox 在模式兜底前直接 deny |

第一个和第四个场景最能说明分层的意义。Bypass 只改变 Permission 的最后兜底，既不能扩张 Plan Mode 的能力集合，也不能覆盖路径沙箱。相反，Plan Mode 只限制副作用类别，并不替 Permission 判断某个读取路径是否越界。

SubAgent 的 `DontAsk` 也只把 Permission 的 ask 分支变为继续执行，避免无人响应的后台任务卡死。调用随后仍会经过 AllowedSafety、AllowedNames 和 Registry；它不是全局绕过开关。

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

## 测试与剩余风险

Runner 测试会让 Provider 在 Plan Mode 中强行返回 Side Effect ToolCall，验证工具实现没有执行且 Conversation 收到 `tool_not_allowed`。Permission 测试覆盖四种模式、规则优先级、命令黑名单、绝对路径、目录穿越、符号链接逃逸、不存在写入目标、Session/Forever 授权和审批取消。

这些测试证明当前分层按设计工作，但安全边界仍依赖元数据和覆盖范围：Safety 由 Tool 作者声明，错误标注会影响可见性与并发；命令黑名单是启发式集合，不可能穷举所有危险 shell 组合；文件 sandbox 不是进程 sandbox。生产环境若允许不受信任的命令，还需要容器、用户权限或操作系统级隔离。

## 小结

PseudoClaude 的 Plan Mode 不是一段“请勿修改文件”的提示词，而是提示词、Definition 过滤和执行期 Safety 校验共同形成的只读模式。Permission Engine 再为所有模式提供参数级黑名单、路径沙箱、分层规则和交互审批。

至此，前六篇完成了核心运行时的主线：入口装配运行时，TUI 驱动交互，Runner 驱动 ReAct 循环，Tool 统一能力边界，状态模块管理上下文生命周期，安全模块控制副作用。

下一阶段转向模型与工具生态。下一篇先从 Provider 边界开始，说明 Anthropic 与 OpenAI 不同的消息和流式协议如何被归一成 Runner 可消费的事件。
