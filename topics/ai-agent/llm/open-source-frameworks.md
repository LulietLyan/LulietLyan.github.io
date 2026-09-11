---
title: 了解哪些大模型开源框架？如何讨论 Qwen 与 DeepSeek？
description: 整理训练、模型生态与推理框架，并保留 Qwen、DeepSeek 的论文阅读提示。
date: 2026-09-12
order: 15
tags:
  - LLM
  - Transformer
  - 面试
---

> **原题 1.15：** 开源框架了解过哪些？Qwen，Deepseek的论文是否有研读过，说一下其中的创新点主要体现在哪？

**整理说明：** 原材料给出了开源框架介绍；Qwen 与 DeepSeek 的创新点部分只有论文阅读提示。

## 开源框架：

* **基础框架：** **PyTorch** 是目前大模型研究和开发的事实标准，提供了灵活的张量计算和自动微分能力。
* **模型与生态：** **Hugging Face Transformers** 是最重要的模型库和生态系统，它极大地降低了使用和分享模型的门槛。
* **大规模训练：** **DeepSpeed** (微软) 和 **Megatron-LM** (英伟达) 是进行大规模分布式训练的核心框架，它们实现了上述的3D并行、ZeRO等关键技术。
* **高效推理：** **vLLM**, **TensorRT-LLM** 等框架专注于优化LLM的推理速度和吞吐量，通过PagedAttention等技术来解决KV Cache的显存瓶颈。

## Qwen系列（可以参考开源论文自行回答，Qwen2.5，Qwen3系列）

## Deepseek系列（可以参考开源论文自行回答，如GRPO）
