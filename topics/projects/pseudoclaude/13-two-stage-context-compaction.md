---
title: 长上下文治理：Tool Result 落盘与历史摘要
description: How PseudoClaude spills large tool results to disk and summarizes older history near the context limit while preserving recent tool-call closure.
date: 2026-08-28
order: 13
tags:
  - PseudoClaude
  - Context Window
  - Compact
  - Go
---

先给结论：PseudoClaude 的长上下文治理不是一上来就“总结所有东西”。它先做便宜、确定的事：把特别大的 Tool Result 搬到磁盘；如果这样还不够，再做昂贵、有损的事：让模型把旧历史总结成摘要。

可以把它想成清理书桌：

```text
桌上太挤
  -> 先把厚厚的工具输出放进文件柜，只在桌上留标签和前几行
  -> 再看桌面是不是还挤
  -> 如果还挤，把旧聊天整理成摘要
  -> 最近几条原话继续留在桌上，方便接着干活
```

对应到代码里的完整顺序是：

```text
Runner 每轮请求模型前
  -> ManageContext
  -> Layer 1: OffloadToolResults
  -> Replace Conversation 为“预览快照”
  -> 重新估算 Token 水位
  -> Layer 2: compactConversation
  -> Replace Conversation 为“摘要 + 近期原文”
  -> 请求主模型
```

长会话的上下文增长有两种形态：一次读取大文件或运行测试可能瞬间产生巨型 Tool Result；普通对话、代码分析和多轮工具调用则会缓慢累积。两层策略正好分别处理这两类问题：Layer 1 处理“突然冒出来的大块工具结果”，Layer 2 处理“整段历史越来越长”。

## 两层策略使用不同预算

核心常量直接表达当前实现的取舍：

```go
const (
    // Layer 1 用字节阈值处理本地 ToolResult，大结果先落盘，不需要额外调用模型。
    SingleToolResultLimitBytes   = 50000
    ToolRoundAggregateLimitBytes = 200000

    // Layer 2 用 Token 预算保护模型窗口，自动摘要会提前留下输出空间和安全余量。
    SummaryReserveTokens     = 20000
    AutoSafetyMarginTokens   = 13000
    ManualSafetyMarginTokens = 3000

    // 摘要后仍保留一段近期原文，避免刚发生的细节只剩有损摘要。
    RecentKeepTokens   = 10000
    RecentKeepMessages = 5

    AutoFailureLimit      = 3
    EstimateCharsPerToken = 3.5

    // 落盘预览只保留头部线索，全文通过预览里的路径按需重新读取。
    PreviewHeadBytes = 2048
    PreviewHeadLines = 20

    SummaryRetryLimit = 3
)
```

Layer 1 的阈值按字节计算，因为它处理的是本地字符串和文件；Layer 2 按 Token 预算触发，因为它保护的是 Provider Context Window。二者不能直接用同一数值替代。

## Runner 在每次模型请求前治理上下文

Compact 不是任务结束后的清理，而是 ReAct 每轮请求前的前置步骤：

```go
if r.Compact != nil {
    r.dispatchHook(ctx, hook.EventPreCompact, permissionMode, hook.Payload{"trigger": "auto"})
    // ManageContext 会先做本地 ToolResult 落盘，再按水位决定是否请求摘要模型。
    out, err := compact.ManageContext(ctx, compact.ManageInput{
        Conversation: req.Conversation,
        Runtime:      r.Compact,
        Provider:     r.Provider,
        Trigger:      compact.TriggerAuto,
        OnProgress: func(message string) {
            sendEvent(ctx, events, Event{
                Type: EventProgress, Iteration: iteration, Message: message,
            })
        },
    })
    if out.TriggeredLayer1 {
        sendEvent(ctx, events, Event{
            Type: EventProgress, Iteration: iteration,
            Message: fmt.Sprintf(
                "工具结果已落盘：%d 个；estimated tokens %d -> %d",
                out.OffloadedCount, out.BeforeTokens, out.AfterTokens,
            ),
        })
    }
    if out.TriggeredLayer2 {
        sendEvent(ctx, events, Event{
            Type: EventProgress, Iteration: iteration,
            Message: fmt.Sprintf(
                "上下文已压缩：estimated tokens %d -> %d",
                out.BeforeTokens, out.AfterTokens,
            ),
        })
    }
    r.dispatchHook(ctx, hook.EventPostCompact, permissionMode, hook.Payload{
        "trigger":       "auto",
        "before_tokens": out.BeforeTokens,
        "after_tokens":  out.AfterTokens,
    })
    if err != nil {
        sendEvent(ctx, events, Event{
            Type: EventError, Iteration: iteration, Err: err,
        })
        sendStop(ctx, events, iteration, StopStreamError, err.Error())
        return
    }
}
```

因此，刚产生的 Tool Result 会先进入 Conversation 和 Session JSONL；下一次模型迭代前，它才可能被 Layer 1 替换成预览。落盘控制的是后续模型可见上下文，不会从追加式 JSONL 中抹除此前已经记录的原始 Entry。

## Layer 1 先处理单个尖峰

`OffloadToolResults` 复制消息，遍历尚未做过决定的 Tool Result。单条内容超过 50,000 bytes 时立即落盘：

```go
for i := range out {
    if out[i].ToolResult == nil {
        continue
    }
    result := out[i].ToolResult
    id := toolResultID(*result, i)
    decision, preview, ok := rt.existingDecision(id)
    if ok {
        if decision == DecisionReplace {
            result.Content = preview
        }
        continue
    }
    if len(result.Content) > SingleToolResultLimitBytes {
        next, err := replaceToolResult(rt, id, result.Content)
        if err != nil {
            firstErr = keepFirst(firstErr, err)
            failed[id] = true
            continue
        }
        result.Content = next
    }
}
```

Runtime 的 Replacement Ledger 按 Call ID 记录 Keep 或 Replace。相同结果在后续检查中复用决定和预览，不会每轮重复写文件。Ledger 只存在于当前 Compact Runtime；恢复历史 Session 时会创建新的空 Ledger，再根据当前 Conversation 重新判断。

## 同一轮聚合过大时优先卸载最大结果

多个单项都低于 50,000 bytes，合计仍可能很大。实现先找到同一个 Assistant ToolCall 后连续出现的 ToolResult 组，计算尚未替换的总字节数，再按候选大小降序落盘：

```go
sort.SliceStable(candidates, func(i, j int) bool {
    return candidates[i].size > candidates[j].size
})
for _, candidate := range candidates {
    if total <= ToolRoundAggregateLimitBytes {
        break
    }
    result := out[candidate.index].ToolResult
    next, err := replaceToolResult(
        rt, candidate.id, result.Content,
    )
    if err != nil {
        firstErr = keepFirst(firstErr, err)
        failed[candidate.id] = true
        continue
    }
    result.Content = next
    total -= candidate.size
}
```

选择最大项是一个局部贪心策略：目标只是用尽量少的替换次数把本轮总量降到 200,000 bytes 以内，不需要求解全局最优组合。对于一次工具轮次中的几十个结果，排序成本可以忽略。

## 落盘后保留可恢复线索

原文写入当前 Session 的 `tool-results/<safe-call-id>.txt`。Conversation 中的替代文本包含原字节数、完整路径、最多 20 行且最多 2,048 bytes 的 UTF-8 安全头部，以及要求重新读文件而不要猜测全文的提醒：

```go
func previewHead(content string) string {
    // 预览只截取头部，目的是给模型一点上下文线索，而不是替代完整 ToolResult。
    lines := strings.SplitAfter(content, "\n")
    if len(lines) > PreviewHeadLines {
        lines = lines[:PreviewHeadLines]
    }
    head := strings.Join(lines, "")
    if len(head) <= PreviewHeadBytes {
        return head
    }
    cut := PreviewHeadBytes
    for cut > 0 && !utf8.ValidString(head[:cut]) {
        cut--
    }
    return head[:cut]
}

func buildPreview(originalBytes int, head string, spillPath string) string {
    var b strings.Builder
    // 预览必须包含落盘路径，后续需要全文时才能用文件读取工具找回原始结果。
    fmt.Fprintf(&b, "[content offloaded] original size: %d bytes\n", originalBytes)
    fmt.Fprintf(&b, "[saved to] %s\n", spillPath)
    b.WriteString("[head preview]\n")
    b.WriteString(head)
    if head != "" && !strings.HasSuffix(head, "\n") {
        b.WriteByte('\n')
    }
    b.WriteString("\n完整内容已保存到上述路径；如需完整内容，请使用文件读取工具读取该路径。不要凭头部预览猜测全文。")
    return b.String()
}

func replaceToolResult(rt *Runtime, id, content string) (string, error) {
    path, err := spillToolResult(rt.Snapshot().Session, id, content)
    if err != nil {
        return content, err
    }
    preview := buildPreview(len(content), previewHead(content), path)
    rt.markReplace(id, preview)
    return preview, nil
}

func spillToolResult(session Session, id, content string) (string, error) {
    name := safeFileName(id)
    path := filepath.Join(session.SpillDir, name+".txt")
    if _, err := os.Stat(path); err == nil {
        return path, nil
    } else if !os.IsNotExist(err) {
        return path, err
    }
    if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
        return path, err
    }
    return path, nil
}
```

只有文件写入成功后才 MarkReplace。失败时保留原始 Content，并且不冻结 Ledger 决策；目录恢复后，下次检查仍可以重试。这保证压缩失败不会用一条指向不存在文件的预览替换可用原文。

## Token 估算结合供应商 Usage Anchor

没有 Provider Usage 时，估算器累计 Role、Content、ToolCall 和 ToolResult 的 Go 字符串字节数，再除以 3.5：

```go
func EstimateMessages(messages []llm.Message) int64 {
    if len(messages) == 0 {
        return 0
    }
    chars := messageChars(messages)
    if chars == 0 {
        return 0
    }
    return int64(math.Ceil(
        float64(chars) / EstimateCharsPerToken,
    ))
}

func EstimateWithAnchor(messages []llm.Message, anchor UsageAnchor) int64 {
    if anchor.Tokens <= 0 ||
        anchor.MessageCount < 0 ||
        anchor.MessageCount > len(messages) {
        return EstimateMessages(messages)
    }
    return anchor.Tokens +
        EstimateMessages(messages[anchor.MessageCount:])
}
```

Runner 每轮收到 Usage 后记录 Token 数和当时 Message Count。后续估算以真实 Usage 为锚点，只估算锚点之后新增的消息，减少纯字符估算的累计误差。Conversation 被 Replace 后，Runtime 会用新消息估算值重置 Anchor。

这里的 `chars` 实际来自 Go `len(string)`，是字节数而不是 Unicode 字符数。中英文和代码的 Token 比例差异很大，因此 3.5 只是提前留余量的启发式估算，不是 tokenizer 的精确结果。

## Layer 2 的触发顺序

`ManageContext` 总是先运行 Layer 1，再重新估算 Token。自动摘要阈值是：

```text
estimated tokens >= context window - 20,000 - 13,000
```

OpenAI 默认 128,000 窗口时约在 95,000 触发；Anthropic 默认 200,000 时约在 167,000 触发。未知或无效窗口回退为 128,000。

```go
func shouldAutoCompact(tokens, contextWindow int64) bool {
    if contextWindow <= 0 {
        contextWindow = defaultFallbackContextWindow
    }
    return tokens >= contextWindow-
        SummaryReserveTokens-
        AutoSafetyMarginTokens
}
```

20,000 Token 为摘要请求和输出预留空间，13,000 是自动触发安全余量。阈值判断在 Layer 1 之后进行，所以一个大结果成功落盘后可能已经回到安全范围，无需发起额外模型请求。

## 摘要请求与过长重试

摘要 Provider Request 不带 Tools，只包含一条用户消息。Prompt 要求模型先输出 `<analysis>`，再输出固定九部分的 `<summary>`；程序只保留最后一组 summary 标签中的文本，没有标签时回退为整个响应。

如果 Provider 将错误归一为 `llm.ErrPromptTooLong`，实现最多尝试四次，每次删除最旧一条输入消息：

```go
func summarize(
    ctx context.Context,
    provider llm.Provider,
    messages []llm.Message,
    safetyMargin int64,
    contextWindow int64,
) (string, error) {
    input := cloneMessages(messages)
    var lastErr error
    for attempt := 0;
        attempt <= SummaryRetryLimit && len(input) > 0;
        attempt++ {
        summary, err := summarizeOnce(ctx, provider, input)
        if err == nil {
            return summary, nil
        }
        if !errors.Is(err, llm.ErrPromptTooLong) {
            return "", err
        }
        lastErr = err
        input = dropOldestSummaryInput(input)
    }
    if lastErr == nil {
        lastErr = errors.New("summary input is empty")
    }
    return "", lastErr
}
```

其他 Provider 错误和空摘要不重试，直接返回 Runner。每次只删除一条消息的实现简单，但可能切断摘要输入中的 ToolCall/ToolResult 配对；近期闭环保护发生在摘要成功后的保留阶段，并不覆盖这个 retry 输入。

## 摘要之后保留近期完整调用闭环

`SelectRecent` 从尾部向前累计；历史足够长时同时满足约 10,000 estimated tokens 和 5 条消息两个条件，历史较短时则全部保留。之后再检查起点：

```go
func SelectRecent(messages []llm.Message) []llm.Message {
    if len(messages) == 0 {
        return nil
    }
    start := len(messages)
    var tokens int64
    for start > 0 {
        start--
        tokens += EstimateMessages(messages[start : start+1])
        if tokens >= RecentKeepTokens &&
            len(messages)-start >= RecentKeepMessages {
            break
        }
    }
    start = ExpandToToolBoundary(messages, start)
    return cloneMessages(messages[start:])
}
```

如果起点落在 ToolResult 上，`ExpandToToolBoundary` 向前寻找对应 Call ID 的 Assistant ToolCall，并把起点扩展到那里。最终 Conversation 由三条压缩元消息和近期原文组成：

```text
user: 历史会话摘要
assistant: 已记录压缩后的历史摘要
user: 摘要不是原文，需要细节时重新读取
...至少 5 条且约 10,000 Token 的近期完整消息...
```

近期事实可能同时出现在摘要和原文中。当前实现接受这部分重复，以换取最近工作状态、错误和工具调用参数不被有损摘要单独控制。

## 失败熔断与手动压缩

自动摘要失败会增加 Runtime 计数；成功则归零。连续失败三次后，后续自动调用直接跳过 Layer 2，避免每轮都重复消耗同一个失败请求。`/compact` 调用 `ForceCompact`，不检查自动熔断，可以给用户一次显式重试机会。

当前实现还有几项需要准确陈述的边界：

- Layer 1 落盘失败会保留原文，但 `ManageContext` 最终把该错误返回 Runner，当前 ReAct 运行会以 Stream Error 停止，而不是仅显示 Warning 后继续。
- 手动 `ForceCompact` 直接进入 Layer 2，不先运行 Layer 1。
- `ManualSafetyMarginTokens`、传给 `summarize` 的 `safetyMargin` 和 `contextWindow` 当前未在函数体中用于裁剪或预算，所以 3,000 Token 手动余量实际上没有改变摘要请求。
- `ErrAutoCompactTripped` 已声明但没有返回。熔断后自动路径安静跳过摘要，调用方无法从 error 判断是“未到阈值”还是“已经熔断”。
- 摘要过长重试删除单条消息而不是完整对话轮次，最多四次也不保证足以让极长输入进入窗口。
- Spill 文件已存在时直接复用，不校验内容；Call ID 清洗后的文件名理论上可能碰撞。
- Replacement Ledger 不随 Session 恢复，重新打开会话后会重新评估已有预览和结果。

## 完整流程

```text
下一次 ReAct 模型请求前
  -> 读取 Conversation + Usage Anchor
  -> Layer 1: 单项 > 50,000 bytes 立即落盘
  -> Layer 1: 单轮 > 200,000 bytes 优先落盘最大项
  -> Replace Conversation 为预览快照
  -> 重新估算 Token
  -> 未到窗口阈值：直接请求主模型
  -> 到达阈值且未熔断：请求摘要模型
  -> Prompt Too Long：最多三次额外重试
  -> 提取 summary
  -> 在历史足够时选择至少 10,000 Token / 5 条近期消息
  -> 向前扩展 ToolCall 边界
  -> 摘要元消息 + 近期原文 Replace Conversation
  -> 重置 Usage Anchor
  -> 请求主模型
```

## 测试验证了什么

Compact 测试覆盖单项落盘、文件内容、预览复用、失败后可重试、聚合场景优先选择最大结果、去除 analysis、近期 ToolCall/ToolResult 闭环、自动失败三次熔断、手动绕过熔断，以及摘要请求不携带工具。Agent 测试验证 Compact 在普通模型请求前运行。

当前测试没有覆盖手动余量参数的效果、真实 tokenizer 误差、超大 JSONL 行恢复、Spill 文件名碰撞和完整 Provider 上下文极限集成。这些也是现阶段不能从单元测试外推的保证。

## 小结

PseudoClaude 把长上下文治理拆成两个不同成本层级：大 Tool Result 用本地文件做确定性、可重新读取的卸载；缓慢增长的历史则在窗口阈值前交给 LLM 摘要，并用近期原文和 Tool 调用边界保留执行连续性。

至此，第三阶段完成了状态持久化主线：Session 负责恢复原始会话演进，Instructions 保存显式规则，Memory 沉淀跨会话知识，Compact 控制单次会话送入模型的体积。

下一阶段转向 Tool Call 的安全与权限边界。先从 `run_command` 的危险命令硬拒绝开始，再依次分析工作区路径沙箱、分层规则、交互审批和 Plan Mode 的双重只读校验。
