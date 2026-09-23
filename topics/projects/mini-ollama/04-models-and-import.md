---
title: Mini-Ollama-模型目录与 Hugging Face 导入
description: 说明 GGUF 模型目录、manifest 校验和 Hugging Face 导入流程。
icon: mdi:chip
order: 5
tags:
  - Projects
  - Go
  - Ollama
  - LLM
---

## 模型目录

默认目录为 `~/.mini-ollama/models`，也可以通过 `--models-dir` 或 `MINI_OLLAMA_MODELS_DIR` 指定。

顶层 `.gguf` 文件的文件名（去掉扩展名）就是模型名：

```text
models/
└── Llama-3.2-1B-Instruct-Q4_K_M.gguf
```

模型也可以放在子目录中。目录内有一个 GGUF 文件时，目录名默认作为模型名；有多个 GGUF 文件时，必须提供 `manifest.json`：

```text
models/
└── Qwen3-8B/
    ├── Qwen3-8B-Q4_K_M.gguf
    └── manifest.json
```

`manifest.json` 的字段如下：

```json
{
  "name": "Qwen3-8B",
  "description": "local Qwen model",
  "file": "Qwen3-8B-Q4_K_M.gguf",
  "size_bytes": 5120000000,
  "sha256": "64-character-hexadecimal-digest"
}
```

扫描模型时会检查 `file` 不能越出模型目录，`size_bytes` 不能为负数，`sha256` 必须是 64 位十六进制字符串。使用 `--verify` 时，程序会重新计算文件大小和 SHA-256。

```bash
/tmp/mini-ollama models --models-dir /path/to/models
/tmp/mini-ollama models --models-dir /path/to/models --refresh --verify
/tmp/mini-ollama models --models-dir /path/to/models --json
```

## Hugging Face 导入

`import-hf` 有两种输入方式：

- 远程仓库：必须提供 `OWNER/REPO` 和 40 位 commit revision。
- 本地权重：提供包含 `config.json` 和 `.safetensors` 文件的目录。

远程导入示例：

```bash
source ~/.bashrc
conda activate mini-ollama-hf

/tmp/mini-ollama import-hf MODEL_NAME \
	--repo OWNER/REPO \
	--revision 40-character-commit-sha \
	--models-dir /path/to/models \
	--work-dir /path/to/external/cache \
	--python "$(command -v python)" \
	--quantizer build/llama-server/bin/llama-quantize
```

已有本地权重时使用 `--source-dir`：

```bash
/tmp/mini-ollama import-hf MODEL_NAME \
	--source-dir /path/to/hf-weights \
	--models-dir /path/to/models \
	--work-dir /path/to/external/cache \
	--python "$(command -v python)" \
	--quantizer build/llama-server/bin/llama-quantize
```

导入流程为：

1. 下载并校验固定 revision 的 Hugging Face 文件，或校验本地权重目录。
2. 使用 `convert_hf_to_gguf.py` 生成 F16 GGUF。
3. 使用 `llama-quantize` 生成 Q4_K_M GGUF。
4. 计算 SHA-256，写入 `manifest.json`，再将结果发布到模型目录。

`--models-dir` 与 `--work-dir` 必须位于仓库外，二者不能重叠。模型发布使用临时目录和原子重命名，已有同名模型时导入会直接失败。
