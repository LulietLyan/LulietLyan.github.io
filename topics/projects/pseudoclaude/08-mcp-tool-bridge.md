---
title: MCP 工具桥接：从远端发现到本地注册
description: How PseudoClaude connects stdio and Streamable HTTP MCP servers, discovers remote capabilities, and adapts them into local tools.
date: 2026-08-28
order: 8
tags:
  - PseudoClaude
  - MCP
  - Tools
  - Go
---

内置 Tool 适合实现项目稳定依赖的文件、搜索和命令能力，但不适合把每一种外部服务都编译进主程序。PseudoClaude 通过 Model Context Protocol 接入外部工具：启动时连接配置的 MCP Server，发现它们公开的工具，再适配到已有的 `tools.Tool` 接口。

这条链路位于 `internal/mcp`。它不另建一套执行系统，而是把 MCP 当作 Tool 的远端实现，因此前文介绍的模型过滤、Permission Engine、Allowed Safety 和 Registry 校验仍然有效。

## 一份配置，两种传输

MCP Server 可以是本地子进程，也可以是 HTTP 服务。配置类型将两种传输需要的字段放在同一对象中：

```go
const (
    TransportStdio TransportType = "stdio"
    TransportHTTP  TransportType = "http"
)

type ServerConfig struct {
    Type      TransportType
    Command   string
    Args      []string
    Env       map[string]string
    URL       string
    Headers   map[string]string
    ReadOnly  bool
}
```

`stdio` 必须提供 command，可附加参数和环境变量；`http` 必须提供 URL，可附加请求头。`ReadOnly` 是项目侧的 Server 级安全覆盖，适合管理员确认整个 Server 只提供查询能力的场景。

配置同时从用户目录和项目目录加载。项目层出现同名 Server 时，会整体覆盖用户层对象，而不是逐字段合并。环境变量展开只发生在 `env` 和 `headers` 中；变量缺失会形成 Warning。单个配置项无效也只记录问题，不阻止其他 Server 启动。

## SDKDialer 将传输收敛为 Session

项目使用 MCP 官方 Go SDK 处理握手和协议消息。`SDKDialer` 根据配置创建 transport，但两条路径最终都返回同一个 `ClientSession`：

```go
switch cfg.Type {
case TransportStdio:
    cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
    cmd.Env = mergeEnv(os.Environ(), cfg.Env)
    transport = &sdkmcp.CommandTransport{Command: cmd}
case TransportHTTP:
    httpClient := &http.Client{
        Transport: headerRoundTripper{
            base:    http.DefaultTransport,
            headers: cfg.Headers,
        },
    }
    transport = &sdkmcp.StreamableClientTransport{
        Endpoint:   cfg.URL,
        HTTPClient: httpClient,
    }
default:
    return nil, fmt.Errorf("unsupported MCP transport type %q", cfg.Type)
}

session, err := client.Connect(ctx, transport, nil)
```

stdio transport 管理本地命令的输入输出；Streamable HTTP transport 通过自定义 `RoundTripper` 注入 headers。该 RoundTripper 会 clone 原始 request 后再写 header，避免修改调用方共享的请求对象。

当前源码还有一个需要明确记录的生命周期边界：`SDKDialer` 使用 `exec.CommandContext(ctx, ...)` 创建 stdio 子进程，而 Manager 传入的 `connectCtx` 会在该 Server 完成首次发现后被取消。Go 会在这个上下文结束时中断仍在运行的命令，因此真实 stdio Server 可能在工具发现成功后随即退出。现有 Manager 测试注入的是 Fake Dialer，尚未覆盖这一进程生命周期；要完整验证 stdio 接入，需要增加真实子进程集成测试，并把“初始化超时”和“Session 存活上下文”分开。

握手之后，上层只看到三个动作：`ListTools`、`CallTool` 和 `Close`。Manager 不需要知道 Session 背后是子进程还是网络连接。

## 工具发现需要处理分页与不完整声明

SDK Session 的 `ListTools` 会循环读取 cursor，直到 Server 不再返回 `NextCursor`。每个远端工具被转换为项目内部的中间结构：

```go
for {
    params := &sdkmcp.ListToolsParams{}
    if cursor != "" {
        params.Cursor = cursor
    }
    result, err := s.session.ListTools(ctx, params)
    if err != nil {
        return nil, err
    }
    for _, tool := range result.Tools {
        if tool == nil {
            continue
        }
        out = append(out, RemoteTool{
            Name:        tool.Name,
            Description: tool.Description,
            InputSchema: schemaMap(tool.InputSchema),
            ReadOnly:    tool.Annotations != nil && tool.Annotations.ReadOnlyHint,
        })
    }
    if result.NextCursor == "" {
        break
    }
    cursor = result.NextCursor
}
```

这里的 `ReadOnlyHint` 只是远端声明，随后还要转换为 PseudoClaude 的 Safety。Schema 会被规整为 `map[string]any`；缺少 Schema 时，适配器使用一个空 object schema，保证它仍满足 Provider 的工具定义格式。

## Manager 内部并发，对调用方同步

`NewManager` 会按名称排序 Server，然后为每个 Server 启动独立 goroutine。连接、MCP 握手和首次 `tools/list` 共享一个 connect timeout；所有 goroutine 结束后函数才返回：

```go
var mu sync.Mutex
var wg sync.WaitGroup
for _, name := range names {
    name := name
    server := cfg.Servers[name]
    wg.Add(1)
    go func() {
        defer wg.Done()
        connectCtx, cancel := context.WithTimeout(ctx, opts.ConnectTimeout)
        defer cancel()

        session, err := opts.Dialer.Dial(connectCtx, name, server, opts.ClientInfo)
        if err != nil {
            mu.Lock()
            manager.issues = append(manager.issues, Issue{
                Server: name, Stage: "connect", Message: err.Error(),
            })
            mu.Unlock()
            return
        }
        remoteTools, err := session.ListTools(connectCtx)
        if err != nil {
            _ = session.Close()
            mu.Lock()
            manager.issues = append(manager.issues, Issue{
                Server: name, Stage: "list_tools", Message: err.Error(),
            })
            mu.Unlock()
            return
        }
        // ...排序、适配并合并 remoteTools...
    }()
}
wg.Wait()
```

“内部并发、对调用方同步”让多个网络连接可以同时等待，也保证 `main.go` 拿到 Manager 时，工具集合和 Issue 已经稳定。某个 Server 连接失败只产生 `connect` Issue；`tools/list` 失败会先关闭该 Session，再产生 `list_tools` Issue。其他 Server 可以照常完成初始化。

Manager 最后保留成功建立的 Session、适配后的 Tool、统计信息和问题列表。进程退出时，`Close` 会并行关闭这些 Session，并受独立的 close timeout 约束。

## 适配：命名空间、Schema 与 Safety

不同 Server 可能都公开 `search`。适配器将名称改成 `mcp__<server>__<tool>`，例如 `mcp__github__get_issue`，再检查它是否只包含 Provider 支持的字符。无效名称和同一 Server 内的重复名称会被跳过并记录 `adapt_tool` Issue。

核心适配逻辑如下：

```go
fullName := FullToolName(serverName, remote.Name)
safety := tools.SafetySideEffect
if remote.ReadOnly {
    safety = tools.SafetyReadOnly
}

return &remoteTool{
    fullName:    fullName,
    serverName:  serverName,
    remoteName:  remote.Name,
    session:     session,
    callTimeout: callTimeout,
    definition: tools.Definition{
        Name:        fullName,
        Description: description,
        InputSchema: schema,
        Safety:      safety,
    },
}, nil
```

安全默认值是保守的：远端没有明确声明 ReadOnly 时，一律按 Side Effect 处理。Server 配置的 `read_only` 会先把该 Server 的全部远端工具强制标记为只读。这样，Plan Mode 不会因为外部工具漏写 annotation 而错误放行。

## Manager 发现，Registry 才负责注册

Manager 持有适配后的 Tool 和底层 Session，但不会直接修改全局 Registry。装配发生在 `main.go`：

```go
mcpManager := mcp.NewManager(context.Background(), mcpCfg, mcp.ManagerOptions{
    ClientInfo: mcp.ClientInfo{Name: "PseudoClaude", Version: "dev"},
})
defer mcpManager.Close()

mcpStats := mcpManager.Stats()
for _, tool := range mcpManager.Tools() {
    if err := registry.Register(tool); err != nil {
        fmt.Fprintf(os.Stderr, "MCP 工具注册提示: %s: %v\n", tool.Definition().Name, err)
        continue
    }
    mcpStats.Registered++
}
```

这一区分保留了清晰的所有权：MCP Manager 负责连接生命周期和发现结果，Registry 负责整个 Agent 的工具名称、定义校验和执行入口。注册成功后，MCP Tool 与内置 Tool 进入同一条 Provider 和 Agent 链路。

## 调用如何回到远端 Server

模型传入的参数必须是 JSON object。`remoteTool.Execute` 解码后建立 call timeout，用远端原始名称调用 Session，再将结果归一为 `tools.Result`：

```go
result, err := t.session.CallTool(callCtx, t.remoteName, args)
if err != nil {
    return tools.Failure(t.fullName, "mcp_call_error", message, t.metadata(0))
}
content := strings.Join(result.TextBlocks, "\n")
metadata := t.metadata(result.NonTextDropped)
if result.IsError {
    return tools.Failure(t.fullName, "mcp_tool_error", content, metadata)
}
return tools.Success(t.fullName, content, metadata)
```

传输或超时错误使用 `mcp_call_error`；Server 正常响应但将业务结果标为错误时，使用 `mcp_tool_error`。二者不能混为一谈，否则 Agent 无法区分连接问题与工具自身拒绝执行。

当前实现保留所有文本 content block，并用换行拼接；图片、音频等非文本内容暂不进入 Conversation，只在 metadata 的 `non_text_dropped` 中计数。这是现阶段适配范围，而不是 MCP 协议本身的限制。

## 从启动到执行的完整路径

```text
用户配置 + 项目配置
  -> 校验并展开 env / headers
  -> stdio 或 Streamable HTTP transport
  -> MCP initialize / ClientSession
  -> 分页 tools/list
  -> RemoteTool
  -> 命名空间 + Schema + Safety 适配
  -> main.go 注册到 Registry
  -> Provider 向模型公开 Definition
  -> Agent 权限检查
  -> remoteTool.Execute / tools/call
  -> tools.Result 回填 Conversation
```

MCP 只扩展能力来源，不绕开既有安全边界。一个远端工具即使连接成功，也必须先通过名称适配和 Registry 注册；真正调用时仍要经过 Allowed Tools、Permission Engine、输入校验和超时控制。

## 测试关注什么

`internal/mcp` 的测试覆盖配置层覆盖规则和环境变量展开、HTTP header clone、Server 失败隔离、`tools/list` 失败时关闭 Session、命名空间和 Safety 适配、参数类型校验、调用超时、传输错误与业务错误区分，以及 Manager 的正常关闭和关闭超时。

这些测试将 MCP 拆成可替换的 Dialer 和 ClientSession，不需要真的启动外部 Server 就能验证 Manager 的并发与失败路径。

## 小结

PseudoClaude 通过官方 SDK 支持 stdio 和 Streamable HTTP 两种 MCP 传输，用 Manager 并发完成连接与工具发现，再将远端声明保守地适配为项目统一 Tool。最终注册仍由 `main.go` 和 Registry 完成，因此外部能力可以复用原有的模型契约、权限和执行保护。

下一篇介绍另一种工具扩展方式：Skill 如何先以名称和简介进入提示词，再按需加载完整 SOP，并注册目录内声明的专用工具。
