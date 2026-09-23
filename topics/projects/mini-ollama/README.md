---
title: Mini-Ollama
description: 基于 Go、Cobra、Gin 和 llama.cpp 的本地 GGUF 模型命令行工具。
icon: mdi:chip
order: 1
tags:
  - Projects
  - Go
  - Ollama
  - LLM
---

Mini-Ollama 是一个学习型 Go 项目，通过 llama.cpp 的 `llama-server` 运行本地 GGUF 模型。项目提供 Cobra 命令行、Gin HTTP API、Bubble Tea TUI 和 SQLite 聊天记录，不重新实现模型推理。

Linux + CUDA 是当前主要验收环境，服务模式支持按配置加载多个模型，并在达到数量上限时淘汰没有活动请求的最久未使用模型。`run MODEL` 可以绕过服务 API，直接启动一个 `llama-server` 进程。

当前实现包括：

- 扫描本地 GGUF 文件和 `manifest.json`，校验文件大小与 SHA-256。
- 启动、健康检查、停止和切换 `llama-server`。
- 手动指定 GPU，或根据 NVIDIA 空闲显存自动选择 GPU。
- CLI 多轮聊天、SSE 流式输出、TUI 和 SQLite conversation/message 存储。
- `/api/v1` 自定义 API 与 OpenAI 风格 `/v1` API。
- 从固定 Hugging Face commit 下载权重，转换为 F16 GGUF，再量化为 Q4_K_M GGUF。

本栏目按实现顺序记录环境准备、命令行、服务与 API、模型目录和模型导入：

- [环境准备](/topics/projects/mini-ollama/01-environment)
- [命令行实现](/topics/projects/mini-ollama/02-cmd)
- [服务与 HTTP API](/topics/projects/mini-ollama/03-service-api)
- [模型目录与 Hugging Face 导入](/topics/projects/mini-ollama/04-models-and-import)

开源仓库：[LulietLyan/mini-ollama](https://github.com/LulietLyan/mini-ollama)
