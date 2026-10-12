---
title: 关于 HTTP 首部字段
description: 从内容协商、条件请求、跨源访问、反向代理与追踪上下文等介绍 HTTP 请求和响应中的首部字段。
date: 2026-10-13
order: 1
tags:
  - HTTP
  - Header Fields
  - Caching
---

HTTP 报文由起始行、首部字段和可选的报文主体组成。首部字段是跟在起始行后面的键值对，用来描述报文本身，以及传递缓存、凭证、跨源策略、代理链等信息。

很多资料通常会写到 `Host`、`Content-Type`、`Content-Length`、`User-Agent`、`Date`。但在真实开发场景中，针对不同的问题例如内容协商、跨域访问、反向代理等等还有更多更丰富的字段：

```http
GET /api/user HTTP/1.1
Host: example.com
Authorization: Bearer <access_token>
Accept: application/json
```

## 请求首部

客户端发给服务端的字段。HTTP/1.1 的请求行给出方法、目标与版本；其余控制信息放在首部里。

### 内容协商与报文描述

`Content-Type` 描述**当前报文主体**的媒体类型。`Accept` 描述**希望对端返回**的媒体类型。二者方向不同。

```http
POST /api/orders HTTP/1.1
Host: shop.example.com
Content-Type: application/json
Accept: application/json

{"productId": 1001, "quantity": 2}
```

服务端用 `Content-Type` 决定如何解析请求体，用 `Accept` 决定响应用哪种表示。只看其中一个，无法同时判断“进来的是什么”和“对方要什么”。

| 字段 | 含义 |
| --- | --- |
| `Host` | HTTP/1.1 请求的目标主机与端口。虚拟主机和反向代理按它选站点。HTTP/2 对应伪首部 `:authority` |
| `Accept` | 可接受的响应媒体类型，可带质量值 `q` |
| `Accept-Encoding` | 可接受的内容编码，如 `gzip`、`br` |
| `Accept-Language` | 可接受的自然语言 |
| `Content-Type` | 请求体的媒体类型 |
| `Content-Length` | 请求体的十进制字节长度 |
| `Content-Encoding` | 请求体已使用的内容编码 |
| `User-Agent` | 客户端软件标识 |

`Content-Encoding` 与 `Transfer-Encoding` 不是同一件事。前者作用于**表示**（representation），压缩后的字节就是资源内容的一部分；后者是 HTTP/1.1 的**传输编码**，常见值为 `chunked`，属于逐跳机制，不进入缓存键，也不改变资源本身。HTTP/2 用帧传递报文，不再使用 `Transfer-Encoding: chunked`。

`TE` 声明可接受的传输编码，与 `Accept-Encoding` 也不相同。HTTP/2 里 `TE` 只允许取 `trailers`。

### 来源

| 字段 | 含义 |
| --- | --- |
| `Origin` | 请求发起方的源：方案、主机、端口，不含路径 |
| `Referer` | 来源页面的 URI。规范沿用了拼写错误的字段名 |
| `Sec-Fetch-Site` | 发起方与目标站点的关系：`same-origin`、`same-site`、`cross-site`、`none` |
| `Sec-Fetch-Mode` | 请求模式：`cors`、`navigate`、`no-cors`、`same-origin`、`websocket` |
| `Sec-Fetch-Dest` | 请求目标：`document`、`image`、`script`、`empty` 等 |

`Origin` 由浏览器在跨源请求、以及部分同源的非 GET 请求上设置，供 CORS 与 CSRF 相关检查使用。`Referer` 可能被 `Referrer-Policy` 裁成只含源、改成更短的路径，或完全不发送。服务端若把 `Referer` 当成不可伪造的身份依据，会得到错误结论：它可以被客户端改写，也可以被策略删掉。

`Sec-Fetch-*` 属于 Fetch 元数据请求首部，由浏览器设置，脚本不能改。它们用来区分“用户打开页面”“跨站嵌入图片”“跨源 `fetch`”等不同发起方式。

### 凭证

| 字段 | 含义 |
| --- | --- |
| `Authorization` | 认证凭证。常见方案有 `Basic`、`Bearer`、`Digest` |
| `Cookie` | 此前由 `Set-Cookie` 写入、且匹配当前请求的 Cookie |
| `X-CSRF-Token` | 常见的自定义字段，用来携带 CSRF 令牌，不是 HTTP 标准字段 |

```http
GET /api/profile HTTP/1.1
Host: api.example.com
Authorization: Bearer <access_token>
```

```http
GET /api/profile HTTP/1.1
Host: api.example.com
Cookie: JSESSIONID=abc123
```

`Authorization` 通常由客户端代码或 HTTP 库显式写入。`Cookie` 由浏览器按域名、路径、`Secure`、`HttpOnly`、`SameSite` 等属性自动附带。二者可以同时出现，协议并不规定它们互斥。

`Cookie` 能被浏览器跨请求自动带上，因此依赖 Cookie 的状态变更接口还需要额外的 CSRF 防护。`X-CSRF-Token` 只是其中一种约定名称；具体叫什么由应用自己定。

### 缓存与范围请求

缓存语义由 RFC 9111 规定。请求侧常见字段：

| 字段 | 含义 |
| --- | --- |
| `Cache-Control` | 请求对缓存的约束，如 `no-cache`、`no-store`、`max-age=0` |
| `If-None-Match` | 带上已有 `ETag`；资源未变时可得到 `304 Not Modified` |
| `If-Modified-Since` | 按修改时间做同样的再验证 |
| `If-Match` | 仅当当前 `ETag` 匹配时才执行写操作 |
| `If-Unmodified-Since` | 仅当资源在给定时间后未修改时才执行 |
| `If-Range` | 与 `Range` 一起使用，避免在资源已变时拼出错误的部分内容 |
| `Range` | 只要资源的某个字节区间 |

```http
GET /app.js HTTP/1.1
Host: example.com
If-None-Match: "v123"
```

资源未变时：

```http
HTTP/1.1 304 Not Modified
ETag: "v123"
```

`304` 没有报文主体，客户端继续使用本地已缓存的表示。

`Cache-Control: no-cache` 允许存储该响应，但在拿出来复用前必须与源服务器再验证。`no-store` 要求不要把该报文存进缓存。把 `no-cache` 读成“禁止缓存”会与实现不符。

`If-Match` 用于避免丢失更新：客户端先读到某个 `ETag`，写回时带上它；若中间已被别人改过，源服务器应拒绝这次写。这与只读场景下的 `If-None-Match` 方向相反。

`Range` 请求成功时状态码是 `206 Partial Content`，响应带 `Content-Range`。视频拖动进度、大文件续传都走这条路径。

### 连接、升级与代理

| 字段 | 含义 |
| --- | --- |
| `Connection` | HTTP/1.x 的连接选项，如 `keep-alive`、`close`；也用来列出逐跳首部 |
| `Keep-Alive` | HTTP/1.0 持久连接的参数提示 |
| `Expect` | 常见值为 `100-continue`，先问服务器是否愿意接收主体 |
| `Upgrade` | 请求把当前连接换成另一种协议，例如 WebSocket |
| `Forwarded` | RFC 7239 定义的代理链信息，可含 `for`、`proto`、`host`、`by` |
| `X-Forwarded-For` | 业界沿用的客户端地址链，不是 HTTP 标准字段 |
| `X-Forwarded-Proto` | 业界沿用的原始 URL 方案 |
| `X-Forwarded-Host` | 业界沿用的原始 `Host` |

HTTP/1.1 默认持久连接，`Connection: keep-alive` 在 HTTP/1.1 里多半是冗余的。`Connection`、`Keep-Alive`、`Upgrade`、`Transfer-Encoding` 属于逐跳首部：只对当前这一跳有意义，代理转发时不应原样传到下一跳。

HTTP/2 用二进制帧在一条连接上复用多个流，不再用上述字段管理连接。RFC 9113 禁止在 HTTP/2 中使用 `Connection`、`Keep-Alive`、`Proxy-Connection`、`Transfer-Encoding`、`Upgrade`。不能把 HTTP/1.1 的连接规则套到 HTTP/2 上。

WebSocket 在 HTTP/1.1 上的握手依赖 `Upgrade`：

```http
GET /chat HTTP/1.1
Host: example.com
Connection: Upgrade
Upgrade: websocket
```

请求经过反向代理后，后端看到的 `Host` 和对端地址往往已经变成内网值。代理用 `Forwarded` 或 `X-Forwarded-*` 把外面的信息带进来：

```http
GET /api/user HTTP/1.1
Host: backend:8080
X-Forwarded-For: 203.0.113.10
X-Forwarded-Proto: https
X-Forwarded-Host: api.example.com
```

`X-Forwarded-For` 是逗号分隔的地址列表。客户端可以在到达第一台代理之前自己写入该字段。只有当可信代理会覆盖或追加，并且后端按“从右往左、只信任已知代理这一跳”的规则解析时，才能把它用于访问控制。无条件取最左边的地址，等于允许伪造来源 IP。

`Forwarded` 是同一问题的标准写法，例如 `Forwarded: for=203.0.113.10;proto=https;host=api.example.com`。部署里两种字段经常并存。

## 响应首部

服务端返回给客户端的字段。状态码说明结果类别，首部说明如何理解主体、能否缓存、浏览器是否允许跨源读取。

### 表示与部分内容

| 字段 | 含义 |
| --- | --- |
| `Content-Type` | 响应体的媒体类型 |
| `Content-Length` | 响应体字节长度 |
| `Content-Encoding` | 响应体的内容编码 |
| `Content-Language` | 表示所使用的自然语言 |
| `Content-Disposition` | `inline` 或 `attachment`，以及建议的文件名 |
| `Content-Range` | `206` 响应中，这一段对应的字节范围 |
| `Accept-Ranges` | 是否接受范围请求，常见值为 `bytes` |
| `ETag` | 该表示的实体标签，有强标签与弱标签 `W/"..."` |
| `Last-Modified` | 该表示的最后修改时间 |

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="report.pdf"
Content-Length: 102400
```

`Content-Disposition: attachment` 提示用户代理把主体当附件保存，而不是在页面里打开。非 ASCII 文件名应使用 RFC 8187 的 `filename*`，不能假定所有客户端都按同一种方式解码 `filename`。

### 缓存

| 字段 | 含义 |
| --- | --- |
| `Cache-Control` | 响应的缓存指令，如 `public`、`private`、`no-store`、`max-age=3600` |
| `Expires` | 用 HTTP 日期给出过期时刻；与 `max-age` 同时出现时，以 `Cache-Control` 为准 |
| `ETag` | 后续条件请求要比对的版本标识 |
| `Last-Modified` | 后续可用 `If-Modified-Since` 再验证 |
| `Vary` | 该响应随哪些请求首部变化，缓存必须把这些字段纳入匹配键 |
| `Age` | 该响应在共享缓存中已经停留的秒数 |

```http
HTTP/1.1 200 OK
Cache-Control: public, max-age=3600
ETag: "abc123"
Vary: Accept-Encoding
```

`public` 允许共享缓存（包括 CDN）存储。`private` 只允许私有缓存存储，通常指浏览器为单一用户保存的缓存。`max-age` 给出新鲜期；过了新鲜期，缓存仍可保留陈旧响应，但再用之前要再验证，除非另有 `stale-while-revalidate` 一类指令。

`Vary: Accept-Encoding` 表示 gzip 与未压缩是两份不同的表示，不能把其中一份发给声明了另一种 `Accept-Encoding` 的客户端。漏写 `Vary` 时，共享缓存可能把压缩后的主体交给不能解压的客户端。

### 跨源访问与浏览器策略

跨源资源共享（CORS）约束的是**浏览器里的脚本**能否读取这次响应，不是服务端认不认这个调用方。命令行客户端、服务端对服务端的请求不受这些字段限制。

预检请求由浏览器发 `OPTIONS`，并带上：

| 字段 | 含义 |
| --- | --- |
| `Access-Control-Request-Method` | 真正要发出的方法 |
| `Access-Control-Request-Headers` | 真正要带上的非简单首部 |

对应的响应字段：

| 字段 | 含义 |
| --- | --- |
| `Access-Control-Allow-Origin` | 允许读取该响应的源。带凭证时不能是 `*`，且一次只能给出一个源 |
| `Access-Control-Allow-Methods` | 允许的方法 |
| `Access-Control-Allow-Headers` | 允许的请求首部 |
| `Access-Control-Expose-Headers` | 允许脚本读取的响应首部。未列出的自定义字段对 `fetch` 不可见 |
| `Access-Control-Allow-Credentials` | 是否允许带 Cookie 等凭证的跨源请求 |
| `Access-Control-Max-Age` | 预检结果可被缓存的秒数 |

跨源请求要携带 Cookie 时，前端需使用凭证模式（如 `fetch` 把 `credentials` 设为 `include`），服务端需返回 `Access-Control-Allow-Credentials: true`，并把 `Access-Control-Allow-Origin` 设成具体源。带凭证时该字段不能为 `*`。

其它常见的浏览器策略字段：

| 字段 | 含义 |
| --- | --- |
| `Set-Cookie` | 写入 Cookie。属性包括 `Domain`、`Path`、`Expires`/`Max-Age`、`Secure`、`HttpOnly`、`SameSite` |
| `Strict-Transport-Security` | HSTS：在有效期内只允许用 HTTPS 访问该主机 |
| `Content-Security-Policy` | 限制页面能加载和执行的资源。`frame-ancestors` 控制谁可以嵌入本页 |
| `X-Content-Type-Options` | 值为 `nosniff` 时，禁止用户代理根据内容猜测媒体类型 |
| `X-Frame-Options` | 控制本页能否被放入 iframe。较新的替代是 CSP 的 `frame-ancestors` |
| `Referrer-Policy` | 控制后续请求如何发送 `Referer` |
| `Permissions-Policy` | 控制页面能否使用摄像头、麦克风等特性 |

`Set-Cookie` 是响应字段；之后的请求把匹配的 Cookie 放在 `Cookie` 里带回去。`HttpOnly` 使文档内脚本读不到该 Cookie。`SameSite=Lax` 或 `Strict` 限制跨站请求是否附带它；`SameSite=None` 必须同时带 `Secure`。

`X-Frame-Options` 仍能见到，但同一份文档里如果也有 CSP `frame-ancestors`，以 CSP 为准。

### 重定向、认证挑战与限流

| 字段 | 含义 |
| --- | --- |
| `Location` | `3xx` 的跳转目标，或 `201 Created` 中新资源的 URI |
| `WWW-Authenticate` | 与 `401 Unauthorized` 一起使用，给出认证方案和参数 |
| `Allow` | 与 `405 Method Not Allowed` 一起使用，列出该资源支持的方法 |
| `Retry-After` | `429` 或 `503` 时，给出应等待的秒数或 HTTP 日期 |
| `Date` | 报文产生的时刻 |
| `Server` | 源服务器软件标识，可以省略 |
| `Via` | 报文经过的代理或网关 |

`Location` 在重定向里是“再请求哪里”，在 `201` 里是“新建的资源在哪里”，不要只按“跳转”一种意思来读。

`WWW-Authenticate: Bearer realm="api"` 告诉客户端用哪种方案重试。只返回 `401` 而不带该字段，也能拒绝访问，但不符合“挑战—应答”的完整语义。

### 追踪

| 字段 | 含义 |
| --- | --- |
| `traceparent` | W3C Trace Context 的追踪上下文：版本、trace-id、parent-id、标志 |
| `tracestate` | 与 `traceparent` 配套的厂商侧状态 |
| `X-Request-ID` | 常见的自定义请求关联标识，不是 HTTP 标准字段 |
| `Server-Timing` | 向浏览器暴露各阶段耗时，供性能面板读取 |

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req-a81c
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

`traceparent` 有固定格式，用于把一次调用在多个服务中的跨度串起来。`X-Request-ID` 没有标准语义，网关、应用和日志系统只要约定同一个名字即可。二者都可以出现在请求里，由第一跳生成后沿调用链传递；响应里回传是为了让客户端或排障方拿到同一个标识。

历史上不少扩展字段以 `X-` 开头。RFC 6648 已经不建议再用这个前缀来标记“非标准”，但 `X-Forwarded-For`、`X-Request-ID`、`X-Content-Type-Options` 仍广泛存在。见到 `X-` 只说明它多半不是 RFC 9110 里的字段，并不自动意味着可以忽略或可以信任。
