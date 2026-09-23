---
title: Mini-Ollama-服务与 HTTP API
description: 说明 serve 模式的模型调度、聊天记录和 HTTP 接口。
icon: mdi:chip
order: 4
tags:
  - Projects
  - Go
  - Ollama
  - LLM
---

`serve` 启动两个部分：模型管理器和 Gin HTTP API。模型管理器负责 `llama-server` 的生命周期，API 负责模型目录、会话、聊天和服务控制。

## 模型生命周期

单个模型服务具有以下状态：`stopped`、`starting`、`ready`、`stopping` 和 `error`。启动流程如下：

1. `Controller` 根据模型名查找模型目录中的 `catalog.Entry`。
2. `Service` 选择后端端口，启动 `llama-server`。
3. `runner.WaitForHTTPReady` 轮询后端 `/health`。
4. 健康检查通过后，状态变为 `ready`，请求才会发送到后端。

`Controller.Acquire` 在请求开始时加载目标模型并增加引用计数，请求结束后释放引用。达到 `--max-loaded-models` 时，优先停止没有活动引用且最久未使用的模型。`switch` 会停止当前模型，再启动目标模型。

## 启动服务

```bash
/tmp/mini-ollama serve \
	--models-dir /path/to/models \
	--data-dir /tmp/mini-ollama-data \
	--host 127.0.0.1 \
	--port 11434
```

数据目录中的 `mini-ollama.db` 保存 conversation 和 message。模型目录可以放在大容量存储上，SQLite 数据库应放在支持文件锁的本地可写文件系统中。

## 自定义 API

接口前缀为 `/api/v1`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/v1/health` | 检查 API 是否可响应 |
| `GET` | `/api/v1/models` | 获取模型目录 |
| `POST` | `/api/v1/models/refresh` | 重新扫描模型目录 |
| `GET` | `/api/v1/status` | 获取当前服务状态 |
| `GET` | `/api/v1/metrics` | 获取后端 Prometheus 指标 |
| `POST` | `/api/v1/chat` | 发起非流式或 SSE 流式聊天 |
| `POST` | `/api/v1/conversations` | 创建会话 |
| `GET` | `/api/v1/conversations` | 列出会话 |
| `GET` | `/api/v1/conversations/:id` | 获取会话及消息 |
| `DELETE` | `/api/v1/conversations/:id` | 删除会话 |
| `POST` | `/api/v1/service/stop` | 停止当前模型 |
| `POST` | `/api/v1/service/switch` | 切换模型 |

创建会话：

```bash
curl -X POST http://127.0.0.1:11434/api/v1/conversations \
	-H 'Content-Type: application/json' \
	-d '{"model":"MODEL_NAME"}'
```

流式聊天请求包含模型名、会话 ID 和消息：

```bash
curl -N -X POST http://127.0.0.1:11434/api/v1/chat \
	-H 'Content-Type: application/json' \
	-d '{"model":"MODEL_NAME","conversation_id":"CONVERSATION_ID","message":"你好","stream":true}'
```

流式响应使用 `token`、`error` 和 `done` 事件。服务会先写入用户消息，再将完整的 assistant 响应写入 SQLite。

## OpenAI 风格接口

项目还提供以下接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/v1/models` | 返回本地模型列表 |
| `GET` | `/v1/models/:model` | 返回单个模型信息 |
| `POST` | `/v1/chat/completions` | 非流式或 SSE 流式聊天 |

聊天接口支持 `top_p`、`presence_penalty`、`frequency_penalty`、`seed`、`max_tokens`、`max_completion_tokens` 和 `stream_options.include_usage`。`n` 只支持 `1`；工具调用、`response_format` 和 `parallel_tool_calls` 当前不支持。
