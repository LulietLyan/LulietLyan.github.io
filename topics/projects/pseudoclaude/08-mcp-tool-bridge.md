---
title: MCP 工具桥接：一个远端工具如何走进 Agent
description: How PseudoClaude turns a configured MCP server into a model-visible tool and routes each call back to the remote session.
date: 2026-08-28
updated: 2026-08-30
order: 8
tags:
  - PseudoClaude
  - MCP
  - Tools
  - Go
---

模型不会直接连接 MCP Server，也不会理解 stdio、HTTP 或 Go SDK。它最终看到的，仍然只是一个名字、一段说明和一份 JSON 参数格式。真正把外部服务变成这种“模型工具”的，是 `internal/mcp` 这一层。

这一层最容易被一堆名词讲复杂。本文不从接口定义出发，而是跟着一个具体工具走完整条路：把名为 `context7` 的 MCP Server 接入 PseudoClaude，再观察它公开的 `search_docs` 怎样被模型发现、选择、执行，最后把结果送回模型。

文中的 Go 代码均截取自项目源码，并为阅读补充了意图注释。完整实现可以直接查看 [`config.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/mcp/config.go)、[`manager.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/mcp/manager.go)、[`sdk.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/mcp/sdk.go)、[`tool.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/internal/mcp/tool.go) 和 [`main.go`](https://github.com/LulietLyan/PseudoClaude/blob/main/cmd/PseudoClaude/main.go)。

## 先看一遍完整旅程

`search_docs` 从配置文件走到模型，再回到远端 Server，完整路径如下：

```text
.PseudoClaude/config.yaml
  -> LoadConfig 读取并校验 context7
  -> NewManager 请 SDKDialer 建立连接
  -> SDK 完成 MCP initialize 握手
  -> sdkSession.ListTools 取得 search_docs
  -> AdaptTool 包装成 mcp__context7__search_docs
  -> main.go 注册进统一 Registry
  -> Provider 把工具说明发给模型
  -> 模型返回 ToolCall
  -> Agent 完成模式、白名单和权限检查
  -> Registry 找到 remoteTool
  -> remoteTool.Execute 调用远端 search_docs
  -> 文本结果变成 tools.Result
  -> Result 写回 Conversation，供模型继续回答
```

这条链路里有两个名字，需要先记住：

```text
mcp__context7__search_docs  本地全名：模型、权限系统和 Registry 使用
search_docs                 远端原名：context7 Server 使用
```

本地全名负责避免冲突，远端原名负责正确调用 Server。后面的适配器会同时保存它们。

## 第一站：配置文件只描述“去哪里找 Server”

最小的 stdio 配置如下：

```yaml
mcp_servers:
  context7:
    type: stdio
    command: npx
    args:
      - -y
      - "@upstash/context7-mcp"
```

这表示 PseudoClaude 需要启动一个本地子进程，并通过它的标准输入输出交换 MCP 消息。配置还支持另一种形态：

```yaml
mcp_servers:
  docs_api:
    type: http
    url: https://docs.example.com/mcp
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
```

HTTP Server 已经在别处运行，PseudoClaude 只需要连接 URL。`${MCP_TOKEN}` 在加载时从当前进程环境中取得。

### 两层配置怎样合并

项目会读取两份文件：

```text
~/.PseudoClaude/config.yaml           用户级配置
<workspace>/.PseudoClaude/config.yaml 项目级配置
```

下面是 `LoadConfig` 的核心流程。注释强调每一步产生了什么数据：

```go
func LoadConfig(root string) (Config, []LoadIssue) {
    // 第一步：确定用户级和项目级文件的位置。
    userPath, projectPath := configPaths(root)

    // 第二步：分别读取。某一层损坏时，另一层仍然可以继续生效。
    user, userIssues := loadRawConfig(userPath)
    project, projectIssues := loadRawConfig(projectPath)
    issues := append([]LoadIssue{}, userIssues...)
    issues = append(issues, projectIssues...)

    // 第三步：项目中的同名 Server 整体替换用户配置。
    // 这里不是逐字段合并，所以不会把旧 command 残留到新的 HTTP 配置中。
    merged := mergeRawServers(user.MCPServers, project.MCPServers)

    // servers 只接收已经展开变量并通过校验的配置。
    servers := make(map[string]ServerConfig)
    for name, raw := range merged {
        // 只在 env 和 headers 中展开 ${NAME}。
        expandedEnv, envIssues := expandMapValues(name, raw.Env)
        expandedHeaders, headerIssues := expandMapValues(name, raw.Headers)
        issues = append(issues, envIssues...)
        issues = append(issues, headerIssues...)
        raw.Env = expandedEnv
        raw.Headers = expandedHeaders

        // stdio 必须有 command；HTTP 必须有 URL。
        // 不合法的 Server 进入 issues，但不会阻止其他 Server。
        server, validationIssues, ok := validateServer(name, raw)
        issues = append(issues, validationIssues...)
        if ok {
            servers[name] = server
        }
    }
    return Config{Servers: servers}, issues
}
```

这里有三个容易忽略的行为：

1. 项目级配置在校验前覆盖用户级配置。若用户层的 `context7` 合法，而项目层同名配置非法，最终结果是该 Server 被删除，不会自动退回用户版本。
2. 未定义环境变量会展开成空字符串并产生 `LoadIssue`。这不会立即淘汰 Server，因此空 Authorization 仍可能进入连接阶段。
3. `read_only: true` 不是程序验证出来的安全结论，而是配置作者主动声明“我信任这个 Server 的全部工具都是只读”。它会减少后续限制，不能把它理解为额外加固。

配置完成后，`LoadConfig` 不会连接任何服务。它只是把磁盘上的宽松 YAML 收窄成 Manager 能使用的 `Config`。

## 第二站：Manager 请 Dialer 建立会话

主程序把有效配置交给 `NewManager`：

```go
// 此时只完成了配置读取，还没有启动 stdio 进程或发出 HTTP 请求。
mcpManager := mcp.NewManager(context.Background(), mcpCfg, mcp.ManagerOptions{
    ClientInfo: mcp.ClientInfo{Name: "PseudoClaude", Version: "dev"},
})

// Manager 持有成功建立的会话，所以主程序退出时由它统一关闭。
defer mcpManager.Close()
```

假设配置里有 `context7`、`github` 和 `docs_api` 三个 Server，Manager 会为三者分别启动连接任务。这样一个连接在等待网络时，不会挡住另外两个。

下面截取单个 Server 的处理过程：

```go
go func() {
    defer wg.Done()

    // 连接、MCP 握手和第一次 tools/list 共用这 30 秒预算。
    connectCtx, cancel := context.WithTimeout(ctx, opts.ConnectTimeout)
    defer cancel()

    // Dial 成功意味着已经拿到可发送 MCP 请求的 Session。
    session, err := opts.Dialer.Dial(
        connectCtx,
        name,
        server,
        opts.ClientInfo,
    )
    if err != nil {
        // 一个 Server 失败只形成启动提示，其他连接继续运行。
        mu.Lock()
        manager.issues = append(manager.issues, Issue{
            Server:  name,
            Stage:   "connect",
            Message: err.Error(),
        })
        mu.Unlock()
        return
    }

    // 连接成功还不够：没有工具目录，模型仍然不知道它能做什么。
    remoteTools, err := session.ListTools(connectCtx)
    if err != nil {
        // 这条 Session 已无法完成初始化，必须立即释放。
        _ = session.Close()
        mu.Lock()
        manager.issues = append(manager.issues, Issue{
            Server:  name,
            Stage:   "list_tools",
            Message: err.Error(),
        })
        mu.Unlock()
        return
    }

    // 后续会逐个包装 remoteTools，再一次性合并进 Manager。
}()
```

`NewManager` 会等所有任务结束后再返回。所以从 `main.go` 看，它仍然是一个普通的同步初始化函数：返回时工具集合已经确定，不会一边注册一边变化。

### 几个统计数字到底表示什么

```text
Configured  通过配置校验的 Server 数
Connected   Dial 和第一次 tools/list 都成功的 Server 数
Discovered  Server 原始返回的工具数
Adapted     成功包装成本地 Tool 的数量
Registered  main.go 最终成功注册到 Registry 的数量
```

因此，“连接成功”在这里不只表示网络打通，还要求取得工具目录。一个会握手但不能列工具的 Server，对当前 Agent 没有可用价值。

## 第三站：SDKDialer 把配置变成真正连接

Manager 默认使用 `SDKDialer`。它先创建官方 SDK Client，再根据配置选择 stdio 或 Streamable HTTP：

```go
func (SDKDialer) Dial(
    ctx context.Context,
    name string,
    cfg ServerConfig,
    info ClientInfo,
) (ClientSession, error) {
    // 握手时告诉 Server：连接者是 PseudoClaude。
    impl := &sdkmcp.Implementation{Name: info.Name, Version: info.Version}
    client := sdkmcp.NewClient(impl, nil)

    var transport sdkmcp.Transport
    switch cfg.Type {
    case TransportStdio:
        // stdio：启动本地进程，MCP JSON 从 stdin/stdout 往返。
        cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
        // 子进程继承当前环境；配置中的键覆盖同名值。
        cmd.Env = mergeEnv(os.Environ(), cfg.Env)
        cmd.Stderr = &bytes.Buffer{}
        transport = &sdkmcp.CommandTransport{Command: cmd}

    case TransportHTTP:
        // HTTP：不用启动进程，只给每个 SDK 请求加上配置 Header。
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

    // Connect 会真正启动进程或连接端点，并完成 MCP initialize 握手。
    session, err := client.Connect(ctx, transport, nil)
    if err != nil {
        return nil, err
    }
    return &sdkSession{serverName: name, session: session}, nil
}
```

initialize 可以理解为双方第一次见面时确认三件事：使用哪个 MCP 协议版本、客户端和 Server 分别是谁、双方支持哪些能力。完成后返回的 `ClientSession` 才能继续发送 `tools/list` 和 `tools/call`。

HTTP 分支还有一个很小但重要的细节：`headerRoundTripper` 不直接修改 SDK 创建的请求，而是先复制：

```go
func (h headerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
    base := h.base
    if base == nil {
        base = http.DefaultTransport
    }

    // 复制后再写 Header，避免污染 SDK 或其他调用者持有的原请求。
    next := req.Clone(req.Context())
    for name, value := range h.headers {
        next.Header.Set(name, value)
    }
    return base.RoundTrip(next)
}
```

### 当前 stdio 生命周期有一个真实缺陷

Manager 传入的是只服务于“连接、握手、首次发现”的 `connectCtx`，但 stdio 分支用它创建了 `exec.CommandContext`。当首次 `tools/list` 完成后，Manager 执行 `cancel()`；Go 会用这个 Context 中断仍在运行的子进程。

```text
本来希望：connectCtx 只限制初始化最多 30 秒
实际发生：connectCtx 同时控制了 stdio Server 的整个进程寿命
结果可能：启动时发现工具成功，真正调用时进程已经退出
```

这不是 MCP 协议限制，而是两个生命周期被错误绑在一起。修复方向是让 stdio 进程使用覆盖完整 Session 寿命的 Context，连接超时只约束 initialize 和首次发现。

## 第四站：tools/list 可能不止一页

连接成功后，Server 可能这样分页返回工具：

```text
第 1 页：search_docs、get_library，NextCursor="page-2"
第 2 页：resolve_name，NextCursor=""
最终结果：search_docs、get_library、resolve_name
```

`sdkSession.ListTools` 会一直跟随游标，直到 `NextCursor` 为空：

```go
func (s *sdkSession) ListTools(ctx context.Context) ([]RemoteTool, error) {
    var out []RemoteTool
    var cursor string

    for {
        params := &sdkmcp.ListToolsParams{}
        if cursor != "" {
            // 从上一页告诉我们的下一位置继续读取。
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
            // 只保留下游真正需要的字段，不让 SDK 类型扩散到整个项目。
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
    return out, nil
}
```

此时得到的 `RemoteTool` 还不能直接交给模型。它的名字可能和其他 Server 冲突，Schema 可能为空，Safety 也还没有转换成本项目认识的分类。

当前循环还默认 Server 会正确推进游标。若恶意或损坏的 Server 永远返回同一个非空 `NextCursor`，循环只能依靠 Context 超时结束，没有额外的页数或重复游标保护。

## 第五站：把远端工具包装成本地 Tool

假设 `context7` 返回：

```text
Name:        search_docs
Description: Search documentation for a query.
InputSchema: {type: object, properties: {query: {type: string}}}
ReadOnly:    true
```

`AdaptTool` 会做四件事：增加 Server 前缀、补齐空说明、补齐空 Schema、转换 Safety。

```go
func AdaptTool(
    serverName string,
    remote RemoteTool,
    session ClientSession,
    callTimeout time.Duration,
) (tools.Tool, *Issue) {
    // search_docs 在本地改名为 mcp__context7__search_docs。
    // 模型和 Registry 使用全名，远端 Session 仍使用原名。
    fullName := FullToolName(serverName, remote.Name)
    if !ValidToolName(fullName) {
        return nil, &Issue{
            Server: serverName,
            Tool:   remote.Name,
            Stage:  "adapt_tool",
            Message: fmt.Sprintf(
                "MCP 工具名 %q 包含 provider 不支持的字符，已跳过",
                fullName,
            ),
        }
    }

    // 模型必须看到说明；Server 没给时生成一条最低限度的提示。
    description := strings.TrimSpace(remote.Description)
    if description == "" {
        description = fmt.Sprintf(
            "Tool %q from MCP server %q.",
            remote.Name,
            serverName,
        )
    }

    // 空 Schema 至少收窄到“参数必须是 JSON object”。
    schema := remote.InputSchema
    if len(schema) == 0 {
        schema = map[string]any{"type": "object"}
    }

    // 不确定时按可能有副作用处理，避免默认放宽权限。
    safety := tools.SafetySideEffect
    if remote.ReadOnly {
        safety = tools.SafetyReadOnly
    }

    if callTimeout <= 0 {
        callTimeout = defaultCallTimeout
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
}
```

包装完成后，`remoteTool` 有两副面孔：

```text
Definition()  给模型看的菜单项：名字、说明、参数格式、Safety
Execute()     模型选中以后真正调用远端 Session 的代码
```

### ReadOnlyHint 不能天然可信

代码采用了“没有明确只读就按 SideEffect”的默认值，这一半是保守的。但只要远端设置 `ReadOnlyHint=true`，它就会进入本地 `SafetyReadOnly`，进而影响三个关键行为：

1. Plan Mode 会向模型公开它。
2. Permission Engine 会按读取工具处理它。
3. 多个只读调用可能并发执行。

[官方 Go SDK v1.5.0 对 Tool Annotation 的说明](https://github.com/modelcontextprotocol/go-sdk/blob/v1.5.0/mcp/protocol.go#L1333-L1340)明确指出：它们只是提示，不能假设不可信 Server 会如实描述行为。当前适配器却把这个提示直接接入了权限决策。因此，一个恶意 Server 可以把删除操作谎报成只读工具。

要建立更强边界，远端工具应默认保持 SideEffect，只有用户配置、可信 Server 清单或本地策略明确授权时才升级为 ReadOnly。现有 `read_only: true` 可以承担显式信任声明，但它的命名应让用户清楚：这是放宽分类，不是加强隔离。

## 第六站：Manager 发现工具，Registry 才正式接纳

Manager 负责连接和包装，但不会偷偷修改全局 Registry。`main.go` 在所有 MCP Server 初始化完毕后逐个注册：

```go
// Stats 返回值是副本；Registered 只描述本次主 Registry 的实际接纳数量。
mcpStats := mcpManager.Stats()

for _, tool := range mcpManager.Tools() {
    // Registry 会拒绝空名称和重复名称。
    // 因此“成功适配”仍不等于“成功注册”。
    if err := registry.Register(tool); err != nil {
        fmt.Fprintf(
            os.Stderr,
            "MCP 工具注册提示: %s: %v\n",
            tool.Definition().Name,
            err,
        )
        continue
    }
    mcpStats.Registered++
}
```

注册完成后，Registry 不再区分它来自 MCP、内置代码还是 Skill。Provider 从同一个 Registry 取得 Definition；Agent 也从同一个入口检查和执行。

模型最终看到的菜单项大致如下：

```json
{
  "name": "mcp__context7__search_docs",
  "description": "Search documentation for a query.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" }
    }
  }
}
```

模型只能根据这段定义生成 ToolCall。它不能持有 Session，也不能绕过本地代码直接访问 Server。

## 第七站：模型选中工具后，调用怎样回到远端

假设模型返回：

```json
{
  "id": "call_01",
  "name": "mcp__context7__search_docs",
  "arguments": { "query": "Go context cancellation" }
}
```

Agent 先检查当前模式、工具白名单和权限。通过后，Registry 根据全名找到 `remoteTool`，再调用它的 `Execute`：

```go
func (t *remoteTool) Execute(
    ctx context.Context,
    input json.RawMessage,
    env tools.Env,
) tools.Result {
    // MCP tools/call 的 arguments 应当是 JSON object。
    // 数组、字符串和损坏的 JSON 都不会发给远端。
    args, err := decodeArguments(input)
    if err != nil {
        return tools.Failure(
            t.fullName,
            "invalid_arguments",
            err.Error(),
            t.metadata(0),
        )
    }

    if ctx == nil {
        ctx = context.Background()
    }
    callCtx, cancel := context.WithTimeout(ctx, t.callTimeout)
    defer cancel()

    // 本地使用 fullName 路由，但 Server 只认识 remoteName=search_docs。
    result, err := t.session.CallTool(callCtx, t.remoteName, args)
    if err != nil {
        message := err.Error()
        if errors.Is(callCtx.Err(), context.Canceled) ||
            errors.Is(callCtx.Err(), context.DeadlineExceeded) {
            message = callCtx.Err().Error()
        }
        // 电话没有打通：网络、会话或超时错误。
        return tools.Failure(
            t.fullName,
            "mcp_call_error",
            message,
            t.metadata(0),
        )
    }

    // 当前只把文本块送回模型；多个文本块用换行连接。
    content := strings.Join(result.TextBlocks, "\n")
    metadata := t.metadata(result.NonTextDropped)
    for key, value := range result.Metadata {
        metadata[key] = value
    }

    if result.IsError {
        if strings.TrimSpace(content) == "" {
            content = "MCP tool returned an error"
        }
        // 电话打通了，但远端工具报告执行失败。
        return tools.Failure(
            t.fullName,
            "mcp_tool_error",
            content,
            metadata,
        )
    }
    return tools.Success(t.fullName, content, metadata)
}
```

四种常见结果可以这样区分：

| 输入或远端行为 | 本地结果 |
| --- | --- |
| 参数是 `[]`、字符串或损坏 JSON | `invalid_arguments` |
| Session 已断、HTTP 失败或调用超时 | `mcp_call_error` |
| 请求到达 Server，但工具返回 `IsError=true` | `mcp_tool_error` |
| 正常返回文本 | `OK=true` |

“电话没打通”和“电话打通但对方办事失败”必须分开。Agent 遇到前者可能需要检查连接，遇到后者则应该阅读工具给出的业务错误。

### 结果适配目前会丢掉什么

`sdkSession.CallTool` 只保存文本 content block。图片、音频等内容不会进入 Conversation，只增加 `non_text_dropped` 计数；SDK 的结构化结果也没有完整传递到本地 `tools.Result`。

还有一个较隐蔽的来源问题：本地先写入 `server`、`remote_tool` 和 `non_text_dropped`，随后再合并远端 Metadata。若远端返回同名键，它可以覆盖本地记录。更稳妥的做法是保留本地键的优先级，或把远端 Metadata 放进独立命名空间。

### 实际调用有两层超时

`remoteTool` 默认设置 30 秒调用超时，但 Registry 外层还会使用 `tools.Env.Timeout`。TUI 的默认 Env Timeout 是 10 秒，所以正常主流程通常先在 10 秒处结束，而不是等待 MCP 的 30 秒。

```text
Registry 外层：默认 10 秒
remoteTool 内层：默认 30 秒
实际效果：先到期的 Context 终止调用
```

这不一定错误，但配置含义容易误导。若希望 `ManagerOptions.CallTimeout` 真正控制 MCP 调用，应让 Registry 的单工具 Timeout 与它保持一致，或只保留一个明确的超时来源。

## 失败不会让整个 Agent 无法启动

MCP 是可选的外部能力，因此这部分大量使用“记录问题并继续”的策略：

```text
配置文件不存在         视为这一层没有配置
用户级 YAML 损坏       项目级配置仍可生效
单个 Server 配置非法   只跳过该 Server
某个 Server 连接失败   其他 Server 继续连接
某个工具名称非法       只跳过该工具
Registry 名称冲突      只跳过本次注册
```

这让内置文件、搜索和命令工具不依赖 MCP Server 是否健康。但“继续启动”也意味着问题必须被清楚展示，否则用户只会看到模型突然少了某项能力。项目用 `LoadIssue` 和 `Issue` 区分配置阶段与连接阶段，再由 `main.go` 打印启动提示。

## 测试证明了什么，又没有证明什么

当前 `internal/mcp` 测试覆盖率为 `70.3%`。配置、Manager 和 Tool 包装的大部分分支有单元测试：

| 已覆盖行为 | 测试方式 |
| --- | --- |
| 用户级与项目级覆盖 | 临时目录写入两份 YAML |
| 环境变量展开边界 | `t.Setenv` 后检查结果和 Issue |
| 一个 Server 失败不影响另一个 | 注入 `stubDialer` |
| `tools/list` 失败后关闭 Session | 注入 `stubSession` |
| 名称前缀、Schema 和 Safety | 直接调用 `AdaptTool` |
| 参数、远端业务错误、调用错误 | 预设 `CallResult` 和 error |
| Manager 关闭超时 | 注入永不返回的 `Close` |

但 `sdk.go` 中的 `Dial`、`ListTools`、`CallTool`、`mergeEnv` 和 `schemaMap` 当前语句覆盖率都是 `0%`。默认测试没有真正启动 stdio MCP Server，也没有建立 Streamable HTTP 会话。

因此，现有测试能够证明“Manager 面对一个符合接口约定的 Session 时怎样工作”，不能证明“官方 SDK 的真实 Session 已被正确创建和维持”。最需要补充的是：

1. 启动一个最小 stdio Server，完成握手、发现、调用和关闭，直接暴露 Context 生命周期问题。
2. 用测试 HTTP Server 验证 Header、分页、错误响应和 Session 关闭。
3. 构造重复游标，确认分页不会无界循环。
4. 构造伪造 `ReadOnlyHint` 的写工具，验证本地信任策略。
5. 验证结构化内容、非文本内容和 Metadata 冲突的处理方式。

## 回到最初的 search_docs

现在可以不借助抽象术语，把整个过程重新说一遍：

1. 配置文件告诉 PseudoClaude 用 `npx` 启动 `context7`。
2. SDK 与进程完成 MCP 握手，并分页取得 `search_docs`。
3. 适配器把它改名为 `mcp__context7__search_docs`，补齐说明、Schema 和 Safety。
4. `main.go` 把包装后的工具注册到统一 Registry。
5. Provider 只把工具菜单项发给模型，不暴露 Session。
6. 模型选择工具并给出 JSON 参数。
7. Agent 完成模式和权限检查，Registry 找到对应 `remoteTool`。
8. `remoteTool` 用远端原名 `search_docs` 发起 `tools/call`。
9. 文本结果被整理成统一 `tools.Result`，写回 Conversation。

MCP 在 PseudoClaude 中没有另起一套工具系统。它做的是一件很具体的事：把“执行发生在外部 Server”包装成普通 Tool，让模型可见性、权限检查、超时、错误结构和 ReAct 循环继续复用原来的路径。

下一篇介绍另一种扩展方式：Skill 不负责连接远端协议，而是先给模型一个简短索引，再按任务需要加载完整 SOP 和专用工具。
