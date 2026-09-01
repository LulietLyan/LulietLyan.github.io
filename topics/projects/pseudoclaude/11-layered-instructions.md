---
title: 分层指令：项目与用户规则如何进入 System Prompt
description: How PseudoClaude loads layered PSEUDOCLAUDE.md files, expands relative references safely, and builds a stable system prompt.
date: 2026-08-28
order: 11
tags:
  - PseudoClaude
  - Instructions
  - Prompt
  - Go
---

先给结论：项目规则和用户规则没有走一套神秘的“覆盖系统”。它们本质上是几份 Markdown 文件，启动时被读出来、标上来源、按固定顺序拼成一段 `Custom Instructions`，再塞进稳定的 System Prompt。

最简单的流水线是这样：

```text
PSEUDOCLAUDE.md
  -> Loader 读取三层文件
  -> 展开安全范围内的 @include
  -> 拼成带 Source 标题的文本
  -> TUI 保存到 Runner.Instructions
  -> Runner 构造 Stable System Prompt
  -> Provider 发给模型
```

所以这里的“分层”只表示“从哪些地方读、按什么顺序拼”。它不是权限系统，也不会判断两条自然语言规则谁更高级。Loader 的工作很朴素：找到内容，安全展开引用，保留来源边界。

## 三个固定来源

Loader 只检查三个位置：

| 顺序 | 层名 | 文件位置 | include 边界 |
| --- | --- | --- | --- |
| 1 | `project-root` | `<project>/PSEUDOCLAUDE.md` | 项目根目录 |
| 2 | `project-config` | `<project>/.PseudoClaude/PSEUDOCLAUDE.md` | 项目根目录 |
| 3 | `user` | `~/.PseudoClaude/PSEUDOCLAUDE.md` | 用户 `.PseudoClaude` 目录 |

源码中的层定义直接表达了这个顺序：

```go
func (l Loader) Layers() []Layer {
    // 三层来源按写入 Prompt 的顺序返回；这里不表达覆盖或权限优先级。
    maxDepth := l.MaxDepth
    if maxDepth <= 0 {
        maxDepth = DefaultMaxDepth
    }
    _ = maxDepth
    return []Layer{
        // 项目根规则面向整个仓库，include 只能留在项目根内。
        {Name: "project-root", Path: filepath.Join(l.ProjectRoot, FileName), Boundary: l.ProjectRoot},
        // 项目配置目录放 PseudoClaude 专用规则，也共享项目根 include 边界。
        {Name: "project-config", Path: filepath.Join(l.ProjectRoot, ".PseudoClaude", FileName), Boundary: l.ProjectRoot},
        // 用户规则跨项目复用，include 被限制在用户的 .PseudoClaude 目录中。
        {Name: "user", Path: filepath.Join(l.UserHome, ".PseudoClaude", FileName), Boundary: filepath.Join(l.UserHome, ".PseudoClaude")},
    }
}
```

工作区根目录文件适合放随仓库共享的工程规则，项目配置目录适合放 PseudoClaude 专用说明，用户层适合放跨项目协作偏好。当前实现不沿工作目录逐级向父目录搜索，也不加载任意文件名。

## Load 负责拼接，不负责覆盖

每一层不存在时会安静跳过；`Stat` 出现其他错误时记录 Warning。存在的文件交给 include expander，随后带来源标题写入结果：

```go
func (l Loader) Load() LoadResult {
    maxDepth := l.MaxDepth
    if maxDepth <= 0 {
        maxDepth = DefaultMaxDepth
    }
    exp := expander{maxDepth: maxDepth}
    var result LoadResult
    // parts 保留每一层完整文本，最后用 --- 分隔；没有做规则去重或覆盖。
    var parts []string
    for _, layer := range l.Layers() {
        // 顶层文件不存在是正常状态：没有该层就跳过。
        if _, err := os.Stat(layer.Path); os.IsNotExist(err) {
            continue
        } else if err != nil {
            result.Warnings = append(result.Warnings, err.Error())
            continue
        }
        // 每个顶层文件使用自己的边界，防止 @include 跨出所属范围。
        content, warnings := exp.expand(layer.Path, layer.Boundary, 0, map[string]struct{}{})
        result.Warnings = append(result.Warnings, warnings...)
        result.Loaded = append(result.Loaded, layer.Path)
        // Source 标题给模型保留来源信息，便于理解冲突来自哪一层。
        parts = append(parts, fmt.Sprintf("## Source: %s (%s)\n\n%s", layer.Name, layer.Path, strings.TrimSpace(content)))
    }
    result.Content = strings.TrimSpace(strings.Join(parts, "\n\n---\n\n"))
    return result
}
```

分隔线和 `## Source` 标题让模型看到规则来自哪里。若项目规则与用户规则冲突，两段都会出现，并保持 project-root、project-config、user 的文本顺序。顺序可以影响模型理解，却不构成程序级的 deny/allow 优先级；强安全约束仍应由 Tool、Permission 和 Plan Mode 实现。

## include 只识别独占一行的相对引用

大型项目可能希望把构建、测试和代码风格拆成多个文件。Loader 支持下面的语法：

```text
项目约定正文

@include docs/build-rules.md
@include docs/testing-rules.md
```

正则要求 `@include` 独占整行，路径不能为空且不能是绝对路径：

```go
var includeLine = regexp.MustCompile(`^\s*@include\s+(.+?)\s*$`)

func isIncludeLine(line string) (string, bool) {
    // 只有独占一行的 @include 才是指令；正文里的普通文字不会被误展开。
    m := includeLine.FindStringSubmatch(line)
    if len(m) != 2 {
        return "", false
    }
    rel := strings.TrimSpace(m[1])
    // 只允许相对路径，具体越界检查留给 expand 的 boundary。
    if rel == "" || filepath.IsAbs(rel) {
        return "", false
    }
    return rel, true
}
```

正文中的 `please @include a.md` 不会被识别，绝对路径也不会读取。未识别的行会原样留在 Prompt 中，因此“拒绝 include”不等于删除这行自然语言。

## 递归展开的多层保护

`expand` 在读取文件前检查深度、边界、调用栈环路和二进制特征。读者可以把它想成“先看门禁，再开文件”：

```go
func (e expander) expand(path, boundary string, depth int, visited map[string]struct{}) (string, []string) {
    // 这些检查都发生在 ReadFile 之前，尽量把错误 include 变成可见 warning。
    if depth > e.maxDepth {
        w := fmt.Sprintf("<!-- @include 超过最大嵌套深度，已跳过: %s -->", path)
        return w, []string{w}
    }
    abs, err := filepath.Abs(path)
    if err != nil {
        w := fmt.Sprintf("<!-- @include 路径错误，已跳过: %s -->", path)
        return w, []string{w}
    }
    if !insideBoundary(abs, boundary) {
        w := fmt.Sprintf("<!-- @include 路径越界，已跳过: %s -->", path)
        return w, []string{w}
    }
    if _, ok := visited[abs]; ok {
        w := fmt.Sprintf("<!-- @include 检测到环路，已跳过: %s -->", path)
        return w, []string{w}
    }
    data, err := os.ReadFile(abs)
    if err != nil {
        w := fmt.Sprintf("<!-- @include 不可读取，已跳过: %s -->", path)
        return w, []string{w}
    }
    if looksBinary(data) {
        w := fmt.Sprintf("<!-- @include 疑似二进制文件，已跳过: %s -->", path)
        return w, []string{w}
    }

    // 复制 visited 是为了让它表达当前递归调用栈，而不是全局已读文件集合。
    nextVisited := make(map[string]struct{}, len(visited)+1)
    for k, v := range visited {
        nextVisited[k] = v
    }
    nextVisited[abs] = struct{}{}

    var warnings []string
    lines := strings.Split(string(data), "\n")
    for i, line := range lines {
        rel, ok := isIncludeLine(line)
        if !ok {
            continue
        }
        // include 路径永远相对当前文件所在目录解析，便于规则文件就近引用材料。
        includePath := filepath.Join(filepath.Dir(abs), rel)
        expanded, ws := e.expand(includePath, boundary, depth+1, nextVisited)
        lines[i] = expanded
        warnings = append(warnings, ws...)
    }
    return strings.Join(lines, "\n"), warnings
}
```

默认最大深度为 5；根文件的 depth 是 0，所以超过限制的下一层会替换成 HTML Comment Warning。`visited` 在每个递归分支复制，它表达的是当前 include 调用栈：A 引用 B、B 再引用 A 会被拦截，但两个互不相干的分支可以合法复用同一个文件。

二进制判断只检查前 512 字节是否包含 NUL。它是避免明显误读的轻量启发式规则，不是完整文件类型识别。

## 指令怎样进入模型请求

主入口在其他运行时对象之前加载指令，并把 Warning 转成启动状态：

```go
// 从工作区加载 instructions，它会在后面作为持久上下文灌入 TUI。
instructionResult := instructions.NewLoader(cwd).Load()

// 最后把前面所有准备好的组件注入 TUI。
// 这里采用链式 WithXXX，是因为各个子系统之间有依赖，需要按顺序填充。
model := tui.New(cfg.Providers, cwd, registry, permissionEngine).
    WithAgentHandle(agentHandle).
    WithWorktrees(worktreeMgr).
    WithSkills(skillCatalog, activeSkills).
    WithHooks(hookEngine).
    WithSubAgents(subagentCatalog, taskManager).
    WithTeams(teamManager).
    WithPersistentContext(instructionResult.Content, memoryManager).
    WithStartupStatus(startup...)
```

TUI 将文本保存到 Runner。每次新的 Agent Run 构造稳定 System Prompt 时，Instructions 被放入优先级 80 的可选模块：

```go
func OptionalModules(inputs PromptInputs) []Module {
    return []Module{
        // Custom Instructions 承载 PSEUDOCLAUDE.md 拼接结果；它是提示词文本，不是权限规则。
        {Name: "Custom Instructions", Priority: PriorityCustomInstructions, Content: inputs.Instructions},
        {Name: "Available Skills", Priority: PriorityActiveSkills, Content: inputs.SkillsCatalog},
        {Name: "Long-Term Memory", Priority: PriorityLongTermMemory, Content: inputs.Memory},
    }
}
```

`AssembleSystem` 按数值排序并用空行连接非空模块，所以固定身份、安全、工作模式和工具规则位于 Custom Instructions 之前，Skill Catalog 与 Memory Index 位于其后。最终 Provider 看到的是一段组装后的 System 文本，而不是能由运行时强制执行的多级权限对象。

## 为什么把 Instructions 放在稳定部分

三层文件在进程启动时读取一次，同一次 Agent Run 中不会变化。把它们放在 Stable System 而不是每轮 Environment，有两个收益：语义上与动态 CWD、日期和 Active Skill 分离；支持缓存的 Provider 也更容易复用稳定前缀。

代价是热更新不存在。用户修改 `PSEUDOCLAUDE.md` 后，当前进程不会自动 Reload，需要重启程序才能得到新文本。这和 Skill 的 `ReloadSkillBody` 行为不同，不能类推。

## 当前实现的安全与容量边界

- `insideBoundary` 使用 `filepath.Abs` 和 `filepath.Rel` 做词法判断，没有解析符号链接。边界内的 symlink 仍可能指向项目或用户目录之外，当前测试也没有覆盖这一逃逸路径。
- Loader 没有限制单文件大小、展开后的总字节数或 include 数量。合法但巨大的规则树会直接增加每次模型请求的固定上下文成本。
- `Layers` 中对 `MaxDepth` 的局部规范化结果没有被使用；真正生效的是 `Load` 创建 expander 时的同类处理。这段重复代码不改变当前行为，但容易让维护者误判深度配置的归属。
- Warning 会同时进入启动状态，并以 HTML Comment 形式留在展开内容中。模型仍会看到这段诊断文本。
- 三层规则没有冲突解析和显式优先级语义。把用户层排在最后不代表它能覆盖前面的项目规则，更不能越过程序的固定安全边界。
- include 只在启动时读取，运行中被引用文件的变化同样不会生效。

这些约束说明 Instructions 是“受控加载的 Prompt 数据”，不是安全策略语言。

## 完整流程

```text
main 获取 cwd 和 user home
  -> 枚举 project-root / project-config / user
  -> 跳过不存在的顶层文件
  -> 递归展开整行相对 @include
  -> 深度 / 词法边界 / 环路 / NUL 检查
  -> 添加 Source 标题并按固定顺序拼接
  -> TUI.WithPersistentContext
  -> Runner.BuildSystemPrompt
  -> Custom Instructions stable module
  -> Provider 请求
```

## 测试验证了什么

Instructions 测试验证三个来源均被加载、顺序为项目根目录到用户层、相对 include 能展开、循环产生 Warning、非独占语法和绝对路径不被识别。Prompt 测试验证模块按 Priority 排序并跳过空内容。当前缺少 symlink 逃逸、总容量限制和运行时 Reload 的测试，因为这些能力尚未实现。

## 小结

PseudoClaude 用三个固定 `PSEUDOCLAUDE.md` 来源承载显式持久规则，用递归 expander 处理可复用片段，再把带来源边界的结果作为 Custom Instructions 放入稳定 System Prompt。Loader 解决的是发现和安全读取，规则冲突与行为强制仍由模型语义和执行期安全模块分别承担。

下一篇进入模型筛选后的持久知识：长期 Memory 如何只分析本轮新增消息，在后台生成项目级或用户级结构化变更。
