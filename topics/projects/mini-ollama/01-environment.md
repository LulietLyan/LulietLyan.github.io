---
title: Mini-Ollama-环境准备
description: 构建 llama.cpp 的 llama-server、初始化 Go 项目并检查 CUDA 后端。
icon: mdi:chip
order: 2
tags:
  - Projects
  - Go
  - Ollama
  - LLM
---

开发环境需要准备 Go、CMake、Ninja、CUDA，以及项目指定版本的 `llama.cpp`。仓库已有 `go.mod`，不需要重新执行 `go mod init`。

## 开发环境

当前开发和验证环境：

- Ubuntu 20.04.4 LTS，Linux 5.13.0-30-generic
- Intel Xeon Gold 6348，112 个逻辑 CPU
- 8 张 NVIDIA GeForce RTX 3090
- NVIDIA 驱动 550.120，CUDA Toolkit 12.4.99
- Go 1.25.0，CMake 4.0.2，Ninja 1.11.1
- 主机架构 x86_64

CMake、Ninja 和 Python 由本机 conda 环境管理。构建脚本会从可用的 `g++-13` 到 `g++` 中选择 CUDA 主机编译器。

## 拉取 llama.cpp

`scripts/bootstrap.sh` 从 `ollama/LLAMA_CPP_VERSION` 读取版本，确保 `third_party/llama.cpp` 固定在该 commit：

```bash
source ~/.bashrc
./scripts/bootstrap.sh
```

脚本会检查目标目录是否为 Git 仓库，必要时只拉取指定 commit，并在最后再次校验实际 commit。

## 构建 llama-server

Linux 构建启用 CUDA，架构设置为 `86`；macOS arm64 构建启用 Metal：

```bash
./scripts/build-llama-server.sh
```

产物为：

```text
build/llama-server/bin/llama-server
```

Hugging Face 导入还需要 `llama-quantize`：

```bash
cmake --build build/llama-server --target llama-quantize --parallel 4
```

使用以下命令检查构建结果：

```bash
build/llama-server/bin/llama-server --version
ldd build/llama-server/bin/llama-server | grep -Ei 'cuda|cublas|ggml-cuda'
```

输出包含 `libggml-cuda.so`、`libcudart.so`、`libcublas.so` 和 `libcuda.so` 时，说明该可执行文件包含 CUDA 后端。

## 构建 Mini-Ollama

仓库根目录已有 Go 模块，直接下载依赖并构建：

```bash
go mod download
go build -o /tmp/mini-ollama .
```

默认模型目录为 `~/.mini-ollama/models`，默认数据目录为 `~/.mini-ollama`。服务启动时会在数据目录中创建 `mini-ollama.db`。
