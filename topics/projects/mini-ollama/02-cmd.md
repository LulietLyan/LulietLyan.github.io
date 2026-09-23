---
title: Mini-Ollama-命令行
description: 使用 Cobra 注册命令、解析参数，并启动本地模型服务。
icon: mdi:chip
order: 3
tags:
  - Projects
  - Go
  - Ollama
  - LLM
---

Mini-Ollama 的命令行由 Cobra 构建。`main.go` 创建根命令并调用 `ExecuteContext`，`cmd/cmd.go` 注册各个子命令。

## 命令树

当前根命令注册以下子命令：

| 命令 | 作用 |
| --- | --- |
| `version` | 显示 `llama-server` 版本 |
| `run MODEL` | 直接运行一个本地 GGUF 模型 |
| `serve [MODEL]` | 启动模型管理器和 HTTP API |
| `models` | 列出、刷新或校验模型目录 |
| `chat MODEL` | 通过 HTTP API 进行流式聊天 |
| `tui` | 打开终端界面 |
| `stop` | 停止当前加载的模型 |
| `switch MODEL` | 切换当前模型 |
| `import-hf MODEL_NAME` | 下载或读取 Hugging Face 权重并生成 GGUF |

注册方式位于 `cmd/cmd.go`：

```go
rootCmd.AddCommand(
	newVersionCommand(),
	newServeCommand(),
	newModelsCommand(),
	newChatCommand(),
	newTUICommand(),
	newStopCommand(),
	newSwitchCommand(),
	newRunCommand(),
	newImportHFCommand(),
)
```

## Cobra 参数

每个命令使用一个 `cobra.Command` 描述命令名、说明、位置参数和处理函数。参数数量通过 `Args` 检查：

- `cobra.NoArgs`：不接受位置参数，例如 `version`、`models`、`tui`。
- `cobra.ExactArgs(1)`：接受一个位置参数，例如 `run MODEL`、`chat MODEL`、`switch MODEL`。
- `cobra.MaximumNArgs(1)`：最多接受一个位置参数，即 `serve [MODEL]`。

标志通过 `command.Flags()` 注册，处理函数从结构体中读取解析结果。`run` 与 `serve` 共享模型路径、上下文长度、GPU 层数、设备、切分方式和自动 GPU 分配等选项，但两者的运行方式不同：`run` 只管理一个直接启动的 `llama-server`，`serve` 还会启动模型管理器和 HTTP API。

## `run MODEL`

`run` 首先将参数解析为绝对路径，要求文件扩展名为 `.gguf` 且文件为普通文件。随后根据选项构造 `llama-server` 参数，启动子进程，并轮询 `/health`，直到服务就绪：

```bash
/tmp/mini-ollama run /path/to/model.gguf \
	--device 0 \
	--gpu-layers all \
	--context-size 4096
```

`--auto-gpu` 会读取 NVIDIA GPU 的空闲显存，结合模型大小、上下文长度和保留显存计算需求；必要时生成 `CUDA_VISIBLE_DEVICES`、`--split-mode` 和 `--tensor-split`。

## `serve [MODEL]`

`serve` 默认监听 `127.0.0.1:11434`，模型目录和数据目录可以通过参数指定：

```bash
/tmp/mini-ollama serve \
	--models-dir /path/to/models \
	--data-dir /tmp/mini-ollama-data \
	--auto-gpu \
	--max-loaded-models 2
```

服务启动后，`Controller` 按模型名加载 `llama-server`。请求结束后释放模型引用；达到 `--max-loaded-models` 时，只淘汰没有活动请求的最久未使用模型。服务收到 `SIGINT` 或 `SIGTERM` 后，会先关闭 HTTP server，再停止已加载的模型。

## 其他命令

`models` 使用 `--refresh` 重新扫描模型目录，`--verify` 校验 manifest 中的大小和 SHA-256，`--json` 输出 JSON。`chat`、`tui`、`stop` 和 `switch` 通过 `--server` 指定 Mini-Ollama API，默认值为 `http://127.0.0.1:11434`。

```bash
/tmp/mini-ollama models --refresh --verify
/tmp/mini-ollama chat MODEL_NAME
/tmp/mini-ollama switch MODEL_NAME
/tmp/mini-ollama stop
/tmp/mini-ollama tui
```

`import-hf` 的参数和处理流程见[模型目录与 Hugging Face 导入](/topics/projects/mini-ollama/04-models-and-import)。
