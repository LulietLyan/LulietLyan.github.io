---
title: MHA、MQA、GQA 有什么区别？
description: 比较注意力头的组织方式，以及模型效果、KV Cache 和推理成本的权衡。
date: 2026-09-12
order: 4
tags:
  - LLM
  - Transformer
  - 面试
---

> **原题 1.4：** 你知道MHA，MQA，GQA的区别吗？详细解释一下。

MHA、MQA和GQA是Transformer模型中三种不同的注意力机制变体，它们的主要区别在于如何组织和共享Query、Key和Value的“头”（Head），核心目标是在模型效果和推理效率（特别是显存占用）之间做出不同的权衡。

## 1. MHA (Multi-Head Attention)

这是原始Transformer论文中提出的标准注意力机制。

* **工作原理：**
    1.  将输入的Q、K、V向量分别通过 `N` 个独立的线性变换，得到 `N` 组不同的 `Q_i, K_i, V_i` 头（ `i=1, ..., N` ）。
    2.  这 `N` 组头在各自的子空间中并行地计算注意力（Scaled Dot-Product Attention）。
    3.  将 `N` 个头计算得到的输出向量拼接（Concatenate）起来。
    4.  最后通过一个线性变换将拼接后的向量映射回原始维度。
* **结构：** `N` 个Query头， `N` 个Key头， `N` 个Value头。
* **优点：** 效果最好，模型能力最强。每个头可以在不同的表示子空间中学习到不同的信息。
* **缺点：** 推理成本高。在自回归生成任务中，需要缓存每一层的Key和Value（即KV Cache），MHA的KV Cache大小与头的数量`N`成正比，显存占用非常大，限制了长序列的生成。

## 2. MQA (Multi-Query Attention)

为了解决MHA在推理时的显存瓶颈而被提出。

* **工作原理：**
    1.  与MHA一样，有 `N` 个独立的Query头。
    2.  **核心区别：** 所有的 `N` 个Query头共享**同一个**Key头和**同一个**Value头。
* **结构：** `N` 个Query头，**1个**Key头，**1个**Value头。
* **优点：** 极大地降低了推理成本。KV Cache的大小不再依赖于头的数量 `N` ，相比MHA减小了 `N` 倍，显著降低了显存占用，并加快了推理速度。
* **缺点：** 可能会导致模型性能的下降。因为所有Query头被迫从同样的一组Key和Value中提取信息，模型的表达能力受到了一定的限制。

## 3. GQA (Grouped-Query Attention)

GQA是MHA和MQA之间的一个折中方案，旨在平衡性能和效率。

* **工作原理：**
    1.  将 `N` 个Query头分成 `G` 组。
    2.  **核心区别：** 每组内的Query头共享一个Key头和一个Value头。总共有 `G` 个Key头和 `G` 个Value头。
* **结构：** `N` 个Query头，**G个**Key头，**G个**Value头。（通常 `1 < G < N` ）。
* **说明：**
    * 当 `G=N` 时，GQA等价于MHA。
    * 当 `G=1` 时，GQA等价于MQA。
* **优点：** 在推理效率上远超MHA，同时在模型性能上优于MQA。它提供了一个灵活的旋钮，可以根据具体需求在效率和效果之间进行调整。Llama 2等模型就采用了GQA。

## 总结：

| 特性 | MHA (Multi-Head Attention) | MQA (Multi-Query Attention) | GQA (Grouped-Query Attention) |
| :--- | :--- | :--- | :--- |
| **结构** | N个Q头, N个K头, N个V头 | N个Q头, 1个K头, 1个V头 | N个Q头, G个K头, G个V头 |
| **模型质量** | 最高 | 可能下降 | 接近MHA，优于MQA |
| **推理效率** | 最低 (KV Cache大) | 最高 (KV Cache小) | 居中，远好于MHA |
| **应用** | BERT, GPT-3 | PaLM | Llama 2, Mixtral |
