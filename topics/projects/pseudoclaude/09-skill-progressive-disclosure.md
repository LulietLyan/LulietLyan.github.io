---
title: Skill 渐进披露：按需加载 SOP 与专用工具
description: How PseudoClaude exposes compact skill metadata first, then loads full SOP content and specialized tools only when requested.
date: 2026-08-28
order: 9
tags:
  - PseudoClaude
  - Skills
  - Prompt
  - Tools
---

Skill 解决的不是“再提供一个固定函数”，而是把某类任务的工作方法交给 Agent：何时使用、按什么顺序检查、需要调用哪些工具，以及怎样验收结果。这样的 SOP 往往比一条工具说明长得多。如果启动时把全部 Skill 正文放进 System Prompt，会持续占用上下文，也会让模型同时面对大量与当前任务无关的规则。

PseudoClaude 采用渐进披露：Catalog 在启动时发现完整 Skill，但初始提示词只公开名称和简介；模型判断需要某项能力后调用系统工具 `load_skill`，完整 SOP 才进入后续模型请求，目录内声明的专用工具也在此时注册。

## Skill 同时包含元数据、正文和工具规格

一个被解析的 Skill 不只是 Markdown 字符串：

```go
type Skill struct {
    Meta      SkillMeta
    Body      string
    EntryPath string
    RootDir   string
    Source    Source
    Tools     []ToolSpec
}

type SkillMeta struct {
    Name        string        `yaml:"name"`
    Description string        `yaml:"description"`
    Tools       []string      `yaml:"tools,omitempty"`
    Mode        ExecutionMode `yaml:"mode,omitempty"`
    History     HistoryMode   `yaml:"history,omitempty"`
    Model       string        `yaml:"model,omitempty"`
}
```

`SKILL.md` 的 YAML frontmatter 提供元数据，正文保存完整 SOP。目录型 Skill 还可以包含 `tools.json`，其中每个 `ToolSpec` 描述名称、说明、输入 Schema、命令和执行根目录。

解析器会拒绝空名称、空简介和空正文。专用工具的 command 数组不能为空，首个元素声明的绝对或相对路径不能通过 `..` 逃出 Skill 根目录；输入 Schema 必须是 JSON object。这里先校验本地 Skill 包的结构，真正运行命令时仍要经过普通工具执行边界。

## Catalog 负责发现与覆盖

Catalog 按三层来源扫描 Skill：

```go
func (c *Catalog) load(opts LoadOptions) {
    opts = normalizeOptions(opts)
    // 后扫描的同名技能覆盖先扫描的技能，因此优先级为：项目 > 用户 > 内置。
    c.scanBuiltin(opts.BuiltinDir)
    c.scanDir(opts.UserDir, SourceUser)
    c.scanDir(opts.ProjectDir, SourceProject)
}
```

内置 Skill 被编译进二进制；用户 Skill 默认位于 `~/.PseudoClaude/skills`；项目 Skill 位于 `<workdir>/.PseudoClaude/skills`。同名条目采用“后扫描者覆盖前者”，所以项目可以定制用户或内置 Skill，用户也可以覆盖内置版本。

单个 Skill 解析失败只产生 Warning，不会阻止其他条目进入 Catalog。启动装配还会调用 `ValidateTools` 检查 frontmatter 声明的工具依赖：依赖可以来自受保护的系统工具、Skill 自带的 `tools.json` 或主 Registry；依赖不存在的 Skill 会被移出本次 Catalog，避免向模型宣传无法完成的流程。

## 第一阶段只向模型公开索引

Catalog 内部已经保存完整正文，但 `PromptItems` 有意只导出两个字段：

```go
func (c *Catalog) PromptItems() []PromptItem {
    skills := c.List()
    out := make([]PromptItem, 0, len(skills))
    for _, skill := range skills {
        out = append(out, PromptItem{
            Name:        skill.Meta.Name,
            Description: skill.Meta.Description,
        })
    }
    return out
}
```

Runner 构造稳定 System Prompt 时，通过 `RenderSkillsCatalog` 渲染这些索引，并告诉模型在需要时调用 `load_skill`。因此“发现时读取完整文件”和“初始提示词注入完整正文”是两件不同的事：前者便于校验和快速加载，后者被刻意推迟。

假设 Catalog 中有十个 Skill，模型最初只看到十组名称和简介，不会同时看到十份 SOP。这个设计减少固定 Prompt 体积，也降低无关规则彼此干扰的概率。

## load_skill 完成真正的激活

`load_skill` 是注册在主 Registry 中的系统 Tool，Safety 为 ReadOnly。模型传入名称后，它从 Catalog 取得 Skill，并在可能的情况下重新读取正文：

```go
skill, ok := t.Catalog.Get(args.Name)
if !ok {
    return Failure(
        "load_skill",
        "unknown_skill",
        fmt.Sprintf("unknown skill %q", args.Name),
        nil,
    )
}
if latest, err := skills.ReloadSkillBody(skill); err == nil {
    // 真正加载时再读一次文件，以获取启动后的正文修改。
    skill = latest
}
rendered := skills.RenderInvocation(skill, "")
if t.Active != nil {
    t.Active.Activate(skill.Meta.Name, rendered)
}
```

重新读取让用户在程序启动后修改 `SKILL.md` 正文，下一次加载仍能拿到新内容。如果重新读取失败，当前实现保留 Catalog 中的启动快照继续执行，而不是让整个 Agent 运行失败。

`ActiveSkills` 是并发安全的有序集合。同名 Skill 再次激活会更新正文，不会重复追加；不同 Skill 按激活顺序保存。`RenderInvocation` 会替换正文中的 `$ARGUMENTS` 和 `{{arguments}}` 占位符，并在 Skill 声明工具依赖时附上 allowed tools 列表。

## 完整 SOP 在下一次模型迭代进入环境

Runner 每次请求模型前都会重新读取 ActiveSkills：

```go
environment := prompt.GatherEnvironment(
    r.Version,
    r.Provider.Name(),
    r.Provider.Model(),
    r.Env.CWD,
).Render()

if active := prompt.RenderActiveSkills(r.activeSkillEntries()); active != "" {
    environment = strings.TrimSpace(environment) + "\n\n" + active
}

modelReq := llm.Request{
    Messages: req.Conversation.Messages(),
    Tools:    defs,
    System: llm.System{
        Stable:      stableSystem,
        Environment: environment,
    },
}
```

在一次 ReAct 运行中，模型先调用 `load_skill`；工具结果回填 Conversation，下一轮迭代重新生成 Environment，于是完整 SOP 与加载结果同时进入模型上下文。Catalog 索引属于较稳定的 System 内容，Active Skill 正文属于动态环境，两者的生命周期不同。

已经激活的 Skill 会在当前会话的后续请求中继续出现，直到 ActiveSkills 被清空。因此渐进披露节省的是“未使用 Skill”的固定成本，不代表加载后的正文只占用一轮上下文。

## 专用工具也在加载时注册

目录型 Skill 的 `tools.json` 可以声明只服务于该流程的命令型工具。`load_skill` 在激活正文后，将这些 Tool 动态写入 Registry：

```go
registered := 0
if t.Registry != nil {
    for _, spec := range skill.Tools {
        if err := t.Registry.RegisterOrReplace(NewSkillTool(spec)); err == nil {
            registered++
        }
    }
}
return Success(
    "load_skill",
    fmt.Sprintf(
        "loaded skill %q (%d specialized tools registered)",
        skill.Meta.Name,
        registered,
    ),
    map[string]any{
        "skill":            skill.Meta.Name,
        "registered_tools": registered,
    },
)
```

专用工具以 Skill 根目录作为工作目录，通过 stdin 接收模型参数 JSON，并把 stdout 转换为 Tool Result。它们默认属于 `SafetySideEffect`，仍会进入 Agent 的权限判断、超时、输出截断和失败处理，而不是因为来自 Skill 就获得额外权限。

当前实现中，正文和工具定义的可见时点需要分开理解：

- `ActiveSkills` 在每轮模型请求前动态读取，所以完整 SOP 会在 `load_skill` 后的下一次 ReAct 迭代出现。
- 专用 Tool 会立即注册到 Registry，但 Runner 在进入循环前已经计算本次运行的 `defs`。因此新 Tool 的定义不会追加到当前运行已经持有的工具列表；后续新的 Runner 运行重新计算并通过模式与名称过滤后，才会向模型公开。
- `ReloadSkillBody` 只重读 Markdown；启动后修改 `tools.json` 需要先 Reload Catalog，才能更新专用工具规格。

这不是协议层限制，而是当前 Runner 对工具 Definition 使用运行级快照的结果。把“注册成功”和“本轮模型已经看到 Definition”当成同一事件，会高估动态工具在当前迭代中的可用性。

## 完整生命周期

```text
启动扫描 builtin / user / project
  -> 解析 SKILL.md 与可选 tools.json
  -> 校验依赖并建立 Catalog
  -> System Prompt 仅公开 name + description
  -> 模型调用 load_skill(name)
  -> 重读正文并渲染完整 SOP
  -> ActiveSkills 激活
  -> 专用工具注册到 Registry
  -> 下一轮 ReAct 请求注入完整 SOP
  -> 后续 Runner 运行重新筛选并公开新增 Tool Definition
```

这条链路把 Skill 分成三类状态：Catalog 中“可发现”，ActiveSkills 中“已加载”，Registry 中“工具已安装”。三个状态相关但不等价，也由不同对象负责维护。

## 失败边界与测试

Skill 的失败处理遵循局部隔离：坏文件只形成 Catalog Warning；未知名称返回 `unknown_skill`；依赖缺失的 Skill 在启动校验后被移除；正文热读取失败则回退到启动快照。专用工具的注册和执行错误由 Registry 与 Tool Result 表达，不会破坏整个 Catalog。

测试覆盖来源优先级、坏 Skill 隔离、依赖校验、`tools.json` 自带工具识别、command 路径逃逸、ActiveSkills 去重与更新、正文参数渲染、成功激活和未知 Skill。Runner 的测试验证 Catalog 索引进入 Stable System、Active Skill 正文进入动态 Environment；这两部分不会被混在同一个提示词模块中。

## 小结

PseudoClaude 的 Skill 不是启动时全部展开的提示词集合。Catalog 先提供低成本索引，`load_skill` 再按模型当前任务激活完整 SOP，并把目录型 Skill 的专用 Tool 注册到统一 Registry。完整正文、工具定义和执行权限仍分别由 Prompt、Runner、Registry 与 Permission Engine 管理。

至此，第二阶段的三篇文章完成了模型与工具生态的主线：Provider 收敛模型协议，MCP 把外部 Server 接入统一 Tool，Skill 用渐进披露控制 SOP 与专用能力的加载时机。

下一阶段回到上下文生命周期，并在第 5 篇总览之上继续下钻。下一篇先从 Session 开始，说明 Conversation 的变化如何写成 JSONL 追加日志，以及恢复器怎样从 Replace 事件重建有效历史。
