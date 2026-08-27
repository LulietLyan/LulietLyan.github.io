---
title: Plan Mode：工具定义与执行阶段的双重只读
description: How PseudoClaude constrains Plan Mode through prompts, read-only tool definitions, and a second runtime safety check before execution.
date: 2026-08-28
order: 18
tags:
  - PseudoClaude
  - Plan Mode
  - Security
  - Go
---

Plan Mode 的目标不是让模型“尽量不要改文件”，而是让当前 ReAct 运行只能使用声明为 ReadOnly 的 Tool。提示词负责表达行为目标，Definition 过滤减少模型可选择的能力，执行期复检则处理 Provider 仍返回隐藏 ToolCall 的情况。

PseudoClaude 因而把 Plan Mode 做成两道程序约束：请求模型前筛选 Tool Definition，执行调用前再次检查同一份 Safety。Permission Mode 仍在这两道约束内部独立决定 Read 是否需要审批，不能把 Plan 与 Permission 混成一个开关。

## Safety 是 Tool 契约的一部分

每个 Tool Definition 都声明粗粒度 Safety：

```go
type Definition struct {
    Name        string
    Description string
    InputSchema map[string]any
    Safety      Safety
    System      bool
    Timeout     time.Duration
}

type Safety string

const (
    SafetyReadOnly   Safety = "read_only"
    SafetySideEffect Safety = "side_effect"
)
```

Read、Glob、Grep 和 `load_skill` 标为 ReadOnly；Write、Edit、Bash、Skill 命令和 Agent 等标为 SideEffect。Plan Mode 不维护另一份工具名黑名单，而是复用 Registry 中 Definition 的 Safety，因此新注册的 MCP 或 Skill Tool 也进入同一筛选逻辑。

这种设计便于扩展，但 Safety 是注册者声明的信任边界。若一个工具错误标成 ReadOnly，框架不会分析其 Go 实现、MCP schema 或外部行为来发现副作用。

## 第一层：只把 ReadOnly Definition 发给模型

Runner 在一次 Run 开始时根据工作模式准备 Prompt、工具定义和执行选项：

```go
func (r Runner) prepareRequest(
    req Request,
) (string, []tools.Definition, toolExecutionOptions) {
    if r.Registry == nil {
        return requestText(req), nil, toolExecutionOptions{}
    }
    allowedNames := allowedNameSet(r.AllowedTools)
    switch req.Mode {
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
    case ModeDo:
        return doPrompt(req.PlanTask, req.PlanText),
            r.Registry.DefinitionsFiltered(r.AllowedTools),
            toolExecutionOptions{AllowedNames: allowedNames, Sub: r.Sub}
    default:
        return requestText(req),
            r.Registry.DefinitionsFiltered(r.AllowedTools),
            toolExecutionOptions{AllowedNames: allowedNames, Sub: r.Sub}
    }
}
```

顺序是先用 `AllowedTools` 做 Skill/SubAgent 名称过滤，再只保留 SafetyReadOnly。`DefinitionsFiltered` 原本会始终保留 System Tool，但后续 Safety 过滤仍会移除 SideEffect System Tool；System 身份不会自动突破 Plan 边界。

对模型而言，第一层的效果是工具协议中根本没有 Write、Edit 或 Bash。它减少误调用和不必要的工具选择，也让支持原生 Tool Calling 的 Provider 从 schema 层看到更小的能力集合。

## Prompt 与 Reminder 负责行为语义

Definition 只能表达“有哪些工具”，不能告诉模型最终应该交付一份计划。Plan Prompt 负责补齐任务语义：

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

长 ReAct 循环可能在多轮 Tool Result 后弱化最初指令，所以每轮请求还会注入不持久化的 Reminder：

```go
const planReminderInterval = 4

func reminderForMode(mode Mode, iteration int) string {
    if mode != ModePlan {
        return ""
    }
    full := iteration == 1 ||
        (iteration-1)%planReminderInterval == 0
    return prompt.PlanReminder(full)
}
```

第 1、5、9 轮使用完整提醒，中间轮次使用短提醒。Reminder 参与当前 Provider Request，但不加入 Conversation；因此它不会污染 Session 恢复内容，也不会在后续普通模式中残留。

Prompt 和 Reminder 都是行为引导，不是安全校验。Provider 可以忽略文字，也可能因为协议错误、缓存或测试桩返回未提供给它的 Tool 名，第二层因此仍然必要。

## 第二层：真实执行前复检 Safety 与名称

ToolCall 最终只有经过 `executeAllowedTool` 才能进入 Registry：

```go
func executeAllowedTool(
    ctx context.Context,
    registry *tools.Registry,
    env tools.Env,
    call llm.ToolCall,
    opts toolExecutionOptions,
) tools.Result {
    if safety, ok := registry.Safety(call.Name);
        ok && !opts.allows(safety) {
        return tools.Failure(
            call.Name,
            "tool_not_allowed",
            "tool is not available in the current mode",
            map[string]any{
                "call_id": call.ID,
                "safety":  string(safety),
            },
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
        ID:        call.ID,
        Name:      call.Name,
        Arguments: json.RawMessage(call.Arguments),
    }, env)
}
```

Plan Mode 的 `AllowedSafety` 只有 ReadOnly。即使 Provider 伪造 `write_file`，或者客户端把一个旧 ToolCall 混进当前响应，执行入口也返回 `tool_not_allowed`，不会调用 Tool 实现。这个失败像其他 Observation 一样写回 Conversation，模型下一轮可以修正行为。

`AllowedNames` 是另一维限制，用于 Skill 和 SubAgent 可见工具范围。受保护的 System Tool 可以绕过名称过滤，但不能绕过前面的 Safety 检查；二者不是同一个白名单。

## Permission Mode 与 Plan Mode 谁先决定

普通 Tool 在 `permissionCheckedTool` 中先经过 Permission Engine，再进入 `executeAllowedTool`。因此一次 Plan Read 仍可能被 Session/Local/Project/User Rule Deny，也可能在 Strict Mode 下 Ask；用户批准后才继续执行期 Safety 复检。

反过来，`bypassPermissions` 只让 Permission Engine 的模式兜底返回 Allow，不能改变 `AllowedSafety`：

```text
Plan Read Tool
  -> Permission Rule / Mode: Allow、Deny 或 Ask
  -> 获得 Allow
  -> AllowedSafety(ReadOnly): 通过
  -> Registry.Execute

Provider 伪造 SideEffect Tool
  -> Permission Rule / Mode 可能 Allow 或 Ask
  -> 即使获得 Allow
  -> AllowedSafety(SideEffect): 拒绝 tool_not_allowed
  -> 不进入 Registry.Execute
```

这两个模式解决不同问题：Permission Mode 表达“用户是否授权这个目标”，Plan Mode 表达“当前工作阶段是否允许这一类能力”。前者的 Bypass 不能提升后者的能力上限。

## 双重校验不是两套独立清单

Definition 过滤和执行复检都依赖同一个 `Definition.Safety`。好处是声明只维护一次，不会出现“模型看不到但执行允许”或相反的手写名单漂移；代价是标签错误会同时污染两道检查。

例如 `load_skill` 被标为 ReadOnly 和 System，Plan Mode 可以调用它。执行会重新读取 Skill 正文、激活 SOP，并向内存 Registry 注册专用工具。它不直接修改项目文件，但确实改变了当前进程的 ActiveSkills 和可用 Registry。这里的“只读”准确含义是“不应产生项目或外部系统副作用”，不是“运行时内存完全不变”。

类似地，MCP Server 自报或适配层赋予的 Safety 若不准确，Plan Mode 不具备远端事务审计能力。要提高保证，需要让 Tool 注册和 MCP 适配承担安全分类审查，或在执行端加入参数级、远端能力级策略，而不只是增加 Prompt 文字。

## 当前 TUI 尚未接通完整 Plan-to-Do

Agent Runtime 已实现 `ModePlan`、`ModeDo` 和 `ModeChat`。`ModeDo` 会组合原任务与 Plan Text，并恢复完整工具定义；Runner 测试也直接覆盖 Plan/Do 两种 Request。

但当前生产 TUI 的输入路径只构造 Plan 或 Chat：

```go
func (m Model) requestForInput(
    text string,
) (agent.Request, string, error) {
    switch {
    case m.planMode:
        return agent.Request{
            Mode:           agent.ModePlan,
            PlanTask:       text,
            PermissionMode: m.permissionMode,
            Conversation:   m.conv,
        }, text, nil
    default:
        return agent.Request{
            Mode:           agent.ModeChat,
            UserText:       text,
            PermissionMode: m.permissionMode,
            Conversation:   m.conv,
        }, text, nil
    }
}
```

`/do` 目前只是把 `planMode` 设为 false；上一轮计划虽保存到 `lastPlan`，正常输入没有读取它来构造 `ModeDo{PlanTask, PlanText}`。因此现有产品流程是“Plan 只读规划，切回默认模式后按新的 Chat 输入执行”，不是“批准保存的 Plan 后自动进入专用 Do 请求”。

这不削弱 Plan 运行本身的双重限制，但意味着不能把 Runtime 中已经存在的 ModeDo 描述成 TUI 已完成的审批式 Plan-to-Execute 闭环。

## 完整流程

```text
TUI 在 planMode 下提交任务
  -> Runner 构造 ModePlan Request
  -> planPrompt 说明只读规划目标
  -> AllowedTools 过滤名称范围
  -> SafetyReadOnly 过滤 Tool Definition
  -> Provider 只看到只读 Tool schema
  -> 每轮注入完整或简短 Plan Reminder
  -> Provider 返回 ToolCall
  -> Permission Engine 检查目标授权
  -> executeAllowedTool 复检 AllowedSafety + AllowedNames
  -> SideEffect: tool_not_allowed，不执行
  -> ReadOnly: Registry.Execute
  -> Tool Result 回填，继续规划
  -> 无 ToolCall 时输出 Plan
```

## 测试验证了什么

Runner 测试确认 Plan Request 只带 ReadOnly Definition，Do Request 恢复完整工具；伪造 SideEffect ToolCall 时实现不会执行，Conversation 中能看到 `tool_not_allowed`。Reminder 测试覆盖完整/简短提醒节奏，Registry 测试确认名称过滤保留 System Tool，Agent 测试也覆盖 Active Skill 名称白名单的执行期拒绝。

现有测试没有证明第三方 Tool 的 Safety 标注真实可靠，也没有覆盖恶意 MCP Server 把写操作伪装成 ReadOnly、`load_skill` 的进程内状态变更边界，或生产 TUI 从 `lastPlan` 构造 ModeDo。它们分别属于信任分类和产品接线问题，不能由双重使用同一标签自动解决。

## 小结

PseudoClaude 的 Plan Mode 不只依赖提示词：模型请求前只暴露 ReadOnly Definition，ToolCall 真正执行前再按 AllowedSafety 和 AllowedNames 复检。两道校验共同处理模型误调用和隐藏调用，Permission Engine 则继续负责具体目标授权。

安全保证的上限取决于 Tool Safety 是否标注正确。当前实现已经具备 Runtime 的 Plan/Do 两种能力，但 TUI 还没有把保存的计划接入 ModeDo，这也是后续完善“规划、批准、执行”闭环时最直接的工程入口。

下一阶段进入多 Agent 协作。先比较 Fork 与预定义子 Agent 的委派模型，再依次分析前后台任务、Team Lead、Mailbox 通信和 Git worktree 隔离。
