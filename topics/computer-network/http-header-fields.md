---
title: 关于 HTTP 首部字段
description: 梳理 HTTP 首部字段的常见用途，涵盖内容协商、缓存、跨源访问、反向代理与请求追踪。
date: 2026-10-13
order: 1
tags:
  - HTTP
  - Header Fields
  - Caching
---

HTTP 报文由起始行、首部字段和可选的报文主体组成。首部字段以 `字段名: 字段值` 的形式出现，负责描述报文、协商传输方式，以及传递缓存、认证和代理等信息。

例如，一个携带访问令牌、希望接收 JSON 的请求：

```http
GET /api/user HTTP/1.1
Host: example.com
Authorization: Bearer <access_token>
Accept: application/json
```

常见的 `Host`、`Content-Type` 和 `Content-Length` 只是基础。实际开发中，缓存验证、跨源请求、反向代理和链路追踪也会涉及大量首部字段。

## 请求首部

### 1. 内容协商与报文描述

理解这组字段，首先要区分两个方向：

- `Content-Type`：**当前报文主体是什么类型。**
- `Accept`：**希望对方返回什么类型。**

```http
POST /api/orders HTTP/1.1
Host: shop.example.com
Content-Type: application/json
Accept: application/json

{"productId": 1001, "quantity": 2}
```

服务端根据 `Content-Type` 解析请求体，并可根据 `Accept` 选择响应表示。二者互不替代。

| 字段 | 作用 |
| --- | --- |
| `Host` | 指定请求目标的主机和端口，常用于虚拟主机路由 |
| `Accept` | 声明可接受的响应媒体类型，可使用 `q` 设置优先级 |
| `Accept-Encoding` | 声明可接受的内容编码，如 `gzip`、`br` |
| `Accept-Language` | 声明偏好的自然语言 |
| `Content-Type` | 指定报文主体的媒体类型 |
| `Content-Length` | 报文主体的字节长度 |
| `Content-Encoding` | 指定主体使用的内容编码 |
| `User-Agent` | 标识客户端软件 |

HTTP/2 中，目标主机信息由伪首部 `:authority` 表达；HTTP/1.1 通常使用 `Host`。

#### `Content-Encoding` 与 `Transfer-Encoding`

两者处理的是不同层面的问题。

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `Content-Encoding` | 表示内容的编码方式 | `gzip`、`br` |
| `Transfer-Encoding` | HTTP/1.1 消息的传输编码 | `chunked` |

`Content-Encoding: gzip` 表示主体经过压缩；`Transfer-Encoding: chunked` 则表示消息采用分块传输，不需要预先给出完整主体的长度。

HTTP/2 使用帧传输数据，不使用 HTTP/1.1 的 `Transfer-Encoding: chunked`。另外，`TE` 声明客户端可接受的传输特性；在 HTTP/2 中，它只允许取值 `trailers`。

### 2. 来源与请求上下文

| 字段 | 作用 |
| --- | --- |
| `Origin` | 标识请求源，由方案、主机和端口组成，不含路径 |
| `Referer` | 指向来源页面的 URI，字段名沿用了历史拼写 |
| `Sec-Fetch-Site` | 描述请求方与目标之间的站点关系 |
| `Sec-Fetch-Mode` | 描述请求模式，如 `cors`、`navigate` |
| `Sec-Fetch-Dest` | 描述请求目标，如 `document`、`image`、`script` |

`Origin` 常用于 CORS 检查，也可辅助 CSRF 防护。浏览器会在跨源请求以及部分同源的非 GET 请求中发送它。

`Referer` 受 `Referrer-Policy` 控制，可能只包含源，也可能完全省略。它还可以被非浏览器客户端伪造，因此不适合作为身份认证依据。

`Sec-Fetch-*` 是 Fetch Metadata 字段，浏览器用它们描述请求的发起方式。普通网页脚本不能直接设置这些受限字段，服务端可以据此制定请求过滤策略。

### 3. 身份认证与 Cookie

| 字段 | 作用 |
| --- | --- |
| `Authorization` | 携带认证凭证，常见方案包括 `Basic`、`Bearer` |
| `Cookie` | 携带与当前请求匹配的 Cookie |
| `X-CSRF-Token` | 应用常用的 CSRF 令牌字段，名称由项目约定 |

**令牌认证示例：**

```http
GET /api/profile HTTP/1.1
Host: api.example.com
Authorization: Bearer <access_token>
```

**Cookie 会话示例：**

```http
GET /api/profile HTTP/1.1
Host: api.example.com
Cookie: JSESSIONID=abc123
```

`Authorization` 通常由客户端代码或 HTTP 库设置；`Cookie` 则由浏览器根据域名、路径、`Secure`、`SameSite` 等规则决定是否附带。

两种方式可以同时使用。

需要注意的是，浏览器可能自动携带 Cookie，因此依赖 Cookie 维持会话的状态变更接口应做好 CSRF 防护。`X-CSRF-Token` 只是常见约定，并非 HTTP 标准字段。

### 4. 缓存验证与范围请求

缓存相关机制主要涉及两类操作：**验证资源是否更新，以及获取资源的一部分。**

| 字段 | 作用 |
| --- | --- |
| `Cache-Control` | 控制缓存行为，如 `no-cache`、`no-store` |
| `If-None-Match` | 根据 `ETag` 验证资源是否变化 |
| `If-Modified-Since` | 根据修改时间进行验证 |
| `If-Match` | 仅当当前 `ETag` 满足条件时执行操作 |
| `If-Unmodified-Since` | 资源未在指定时间后修改时才执行操作 |
| `Range` | 请求资源的指定字节范围 |
| `If-Range` | 资源未变化时请求部分内容，否则获取完整表示 |

#### 使用 `ETag` 验证缓存

客户端已有缓存时，可以将服务器此前返回的 `ETag` 放进 `If-None-Match`：

```http
GET /app.js HTTP/1.1
Host: example.com
If-None-Match: "v123"
```

若资源未发生变化，服务器返回：

```http
HTTP/1.1 304 Not Modified
ETag: "v123"
```

`304` 不携带响应主体，客户端继续使用本地缓存。

#### `no-cache` 不等于 `no-store`

| 指令 | 含义 |
| --- | --- |
| `no-cache` | 可以存储，但复用前必须重新验证 |
| `no-store` | 不应存储该报文 |
| `max-age=0` | 响应立即变为陈旧，通常需要重新验证 |

这些指令的具体效果还会受到其他缓存规则的影响。

#### 条件写入与部分内容

`If-Match` 常用于避免并发更新覆盖彼此的修改。客户端读取资源时取得 `ETag`，更新时带上该标签；如果资源已被其他请求修改，服务器就可以拒绝本次更新。

`Range` 则用于下载部分内容，例如视频拖动进度或大文件断点续传：

```http
GET /video.mp4 HTTP/1.1
Host: example.com
Range: bytes=1000-1999
```

服务器支持该范围请求时，可返回 `206 Partial Content`，并通过 `Content-Range` 标明本次返回的字节区间。

### 5. 连接管理、协议升级与代理

| 字段 | 作用 |
| --- | --- |
| `Connection` | 声明 HTTP/1.x 连接选项，如 `close` |
| `Keep-Alive` | 提供持久连接参数提示 |
| `Expect` | 常用于 `100-continue`，先确认服务器是否准备接收主体 |
| `Upgrade` | 请求将当前连接升级到其他协议 |
| `Forwarded` | 标准化表达代理链信息 |
| `X-Forwarded-For` | 传递客户端地址链的常见扩展字段 |
| `X-Forwarded-Proto` | 传递代理前的原始协议 |
| `X-Forwarded-Host` | 传递代理前的原始主机信息 |

HTTP/1.1 默认使用持久连接，因此一般不需要显式添加 `Connection: keep-alive`。

#### 逐跳首部

`Connection`、`Keep-Alive`、`Upgrade` 和 `Transfer-Encoding` 等字段涉及当前连接或这一跳的传输行为。代理转发消息时，需要按照协议规则处理逐跳首部，不能简单地把它们原样传给下一跳。

HTTP/2 采用二进制帧和多路复用机制，不再使用 HTTP/1.1 的连接管理方式。RFC 9113 禁止在 HTTP/2 中使用 `Connection`、`Keep-Alive`、`Proxy-Connection`、`Transfer-Encoding` 和 `Upgrade` 等字段。

#### WebSocket 协议升级

HTTP/1.1 的 WebSocket 握手使用 `Upgrade`：

```http
GET /chat HTTP/1.1
Host: example.com
Connection: Upgrade
Upgrade: websocket
```

这组字段只适用于相应的 HTTP/1.1 握手流程，不能直接套用到 HTTP/2。

#### 反向代理与客户端地址

请求经过反向代理后，后端看到的连接地址和 `Host` 可能已变成代理或内网信息。代理可以通过扩展字段传递外部请求信息：

```http
GET /api/user HTTP/1.1
Host: backend:8080
X-Forwarded-For: 203.0.113.10
X-Forwarded-Proto: https
X-Forwarded-Host: api.example.com
```

`X-Forwarded-For` 通常以逗号分隔多个地址，但客户端也可能在请求到达第一台代理前自行添加该字段。

**安全要点：** 后端只能信任已知代理按约定写入的信息，并根据可信代理链解析客户端地址。直接取最左侧地址作为真实 IP，可能导致来源地址伪造。

标准化的 `Forwarded` 字段也能表达类似信息：

```http
Forwarded: for=203.0.113.10;proto=https;host=api.example.com
```

两种格式在实际部署中都很常见。

## 响应首部

响应首部描述服务器返回的表示、缓存策略、浏览器安全策略，以及重定向和认证等处理结果。

### 1. 表示与文件下载

| 字段 | 作用 |
| --- | --- |
| `Content-Type` | 指定响应主体的媒体类型 |
| `Content-Length` | 响应主体的字节长度 |
| `Content-Encoding` | 指定响应主体的内容编码 |
| `Content-Language` | 指定表示所使用的自然语言 |
| `Content-Disposition` | 提示如何处理主体，如内联显示或下载 |
| `Content-Range` | 标明部分响应对应的字节区间 |
| `Accept-Ranges` | 声明支持的范围单位，常见值为 `bytes` |
| `ETag` | 表示当前版本的实体标签 |
| `Last-Modified` | 表示资源的最后修改时间 |

文件下载示例：

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename="report.pdf"
Content-Length: 102400
```

`Content-Disposition: attachment` 提示客户端将内容作为附件处理，而不是直接在页面内显示。

需要指定非 ASCII 文件名时，可使用 RFC 8187 定义的 `filename*` 参数，以明确字符编码。例如：

```http
Content-Disposition: attachment; filename="report.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf
```

### 2. 响应缓存

| 字段 | 作用 |
| --- | --- |
| `Cache-Control` | 设置缓存策略 |
| `Expires` | 指定响应的过期时间 |
| `ETag` | 提供版本验证标识 |
| `Last-Modified` | 提供最后修改时间 |
| `Vary` | 指定哪些请求首部会影响响应表示 |
| `Age` | 表示响应在共享缓存中已存在的秒数 |

示例：

```http
HTTP/1.1 200 OK
Cache-Control: public, max-age=3600
ETag: "abc123"
Vary: Accept-Encoding
```

常见的缓存指令：

- `public`：允许共享缓存存储。
- `private`：响应只能存储在私有缓存中。
- `no-store`：不应存储该报文。
- `max-age=3600`：响应在指定的新鲜期内可直接复用。

响应过期后，缓存通常仍可保留它，并在再次使用前进行验证；是否允许直接使用陈旧响应，还取决于其他缓存指令和协议规则。

`Expires` 提供绝对过期时间；如果同时存在有效的 `Cache-Control: max-age`，通常优先采用后者。

#### 为什么需要 `Vary`？

假设服务器会根据 `Accept-Encoding` 返回压缩或未压缩的内容：

```http
Vary: Accept-Encoding
```

缓存必须将 `Accept-Encoding` 纳入响应匹配条件，避免把一种编码的表示错误地提供给不适用的客户端。

### 3. 跨源资源共享（CORS）

CORS 控制的是**浏览器中的脚本能否读取跨源响应**，不是服务端是否接受请求。命令行工具和服务端之间的 HTTP 请求不会因为缺少 CORS 响应字段而自动受到浏览器同源策略的限制。

#### 预检请求

当请求不满足 CORS 简单请求条件时，浏览器可能先发送 `OPTIONS` 预检请求。

| 请求字段 | 作用 |
| --- | --- |
| `Origin` | 标识请求来源 |
| `Access-Control-Request-Method` | 声明实际请求使用的方法 |
| `Access-Control-Request-Headers` | 声明实际请求准备携带的首部 |

服务器通过以下响应字段声明允许的跨源访问范围：

| 响应字段 | 作用 |
| --- | --- |
| `Access-Control-Allow-Origin` | 指定允许的来源 |
| `Access-Control-Allow-Methods` | 指定允许的方法 |
| `Access-Control-Allow-Headers` | 指定允许的请求首部 |
| `Access-Control-Expose-Headers` | 指定脚本可读取的额外响应首部 |
| `Access-Control-Allow-Credentials` | 是否允许跨源请求携带凭证 |
| `Access-Control-Max-Age` | 指定预检结果的缓存时间 |

#### 携带 Cookie 的跨源请求

前端需要使用凭证模式，例如：

```javascript
fetch("https://api.example.com/profile", {
  credentials: "include"
});
```

服务端则需要返回：

```http
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
```

**携带凭证时，`Access-Control-Allow-Origin` 不能使用 `*`，必须返回明确的来源。**

另外，CORS 允许脚本读取响应，不等于接口已经完成身份认证或权限检查。服务端仍须独立验证用户身份和访问权限。

### 4. Cookie 与浏览器安全策略

| 字段 | 作用 |
| --- | --- |
| `Set-Cookie` | 在客户端设置 Cookie |
| `Strict-Transport-Security` | 启用 HSTS，要求后续通过 HTTPS 访问 |
| `Content-Security-Policy` | 限制页面可以加载和执行的资源 |
| `X-Content-Type-Options` | 使用 `nosniff` 禁止媒体类型嗅探 |
| `X-Frame-Options` | 限制页面被嵌入 `frame` 的方式 |
| `Referrer-Policy` | 控制后续请求发送的 `Referer` |
| `Permissions-Policy` | 控制摄像头、麦克风等浏览器特性的使用权限 |

#### Cookie 属性

服务器通过 `Set-Cookie` 设置 Cookie，浏览器在后续匹配的请求中使用 `Cookie` 将其发送回来。

| 属性 | 作用 |
| --- | --- |
| `Domain` | 指定适用的域 |
| `Path` | 指定适用的路径 |
| `Expires` / `Max-Age` | 设置过期时间或有效时长 |
| `Secure` | 仅通过安全连接发送 |
| `HttpOnly` | 禁止页面脚本直接读取该 Cookie |
| `SameSite` | 限制 Cookie 在跨站请求中的发送行为 |

`SameSite=None` 必须同时设置 `Secure`。`SameSite=Lax` 和 `SameSite=Strict` 则会对跨站发送施加不同程度的限制。

#### CSP 与 iframe

`Content-Security-Policy` 的 `frame-ancestors` 指令可以指定哪些来源允许嵌入当前页面。它比单独使用 `X-Frame-Options` 更灵活。

当 CSP 的 `frame-ancestors` 生效时，浏览器会优先采用 CSP 的嵌入控制规则。

### 5. 重定向、认证与限流

| 字段 | 常见用途 |
| --- | --- |
| `Location` | 指定重定向目标，或 `201 Created` 新建资源的位置 |
| `WWW-Authenticate` | 在 `401 Unauthorized` 响应中提供认证挑战 |
| `Allow` | 在 `405 Method Not Allowed` 响应中列出支持的方法 |
| `Retry-After` | 建议客户端等待一段时间后重试 |
| `Date` | 报文产生的日期和时间 |
| `Server` | 标识服务器软件，可省略 |
| `Via` | 记录报文经过的代理或网关 |

`Location` 的含义取决于状态码：

- `3xx`：告诉客户端应该请求哪个 URI。
- `201 Created`：指出新建资源的位置。

认证挑战示例：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="api"
```

`WWW-Authenticate` 告诉客户端服务器支持的认证方案及相关参数。`Retry-After` 则可与 `429 Too Many Requests` 或 `503 Service Unavailable` 等响应配合，给出建议的重试时间。

### 6. 分布式追踪与性能分析

| 字段 | 作用 |
| --- | --- |
| `traceparent` | 传递 W3C Trace Context 中的追踪标识、父级跨度标识和标志 |
| `tracestate` | 传递与追踪上下文配套的厂商状态 |
| `X-Request-ID` | 应用常用的请求关联标识，属于自定义字段 |
| `Server-Timing` | 向浏览器提供服务器处理阶段的耗时信息 |

示例：

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: req-a81c
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

`traceparent` 按 W3C Trace Context 规定的格式传递上下文，便于将多个服务中的调用关联起来。

`X-Request-ID` 没有统一的 HTTP 标准语义，通常由网关或应用生成，再由日志系统和下游服务共同使用。它也可以随响应返回，方便客户端反馈问题时定位日志。

## 关于 `X-` 前缀

历史上，很多自定义首部以 `X-` 开头。RFC 6648 已不建议继续使用该前缀来专门标记非标准字段，但已有字段仍被广泛采用。

例如：

- `X-Forwarded-For`：代理链中的客户端地址信息。
- `X-Request-ID`：请求关联标识。
- `X-Content-Type-Options`：浏览器安全策略。

字段是否标准、是否可信，应结合协议定义和部署环境判断，不能只凭 `X-` 前缀下结论。

---

## 参考规范

- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
- [RFC 9113 — HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)
- [RFC 6265 — HTTP State Management Mechanism](https://www.rfc-editor.org/rfc/rfc6265)
- [RFC 7239 — Forwarded HTTP Extension](https://www.rfc-editor.org/rfc/rfc7239)
- [RFC 8187 — Encoded HTTP Header Parameter Values](https://www.rfc-editor.org/rfc/rfc8187)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
