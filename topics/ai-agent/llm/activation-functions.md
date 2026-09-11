---
title: LLM 常用哪些激活函数？为什么选择它们？
description: 介绍非线性的作用，以及 GeLU、SwiGLU 的原理和使用动机。
date: 2026-09-12
order: 12
tags:
  - LLM
  - Transformer
  - 面试
---

> **原题 1.12：** 激活函数有了解吗，你知道哪些LLM常用的激活函数？为什么选用它？

是的，我了解激活函数。激活函数是神经网络中至关重要的一环，它的主要作用是**为网络引入非线性（non-linearity）**。如果没有激活函数，多层神经网络本质上等同于一个单层的线性模型，无法学习和拟合复杂的数据模式。

在现代大型语言模型（Transformer架构）中，最常用的激活函数主要有两个：**GeLU** 和 **SwiGLU**。

1.  **GeLU (Gaussian Error Linear Unit):**
    * **简介：** GeLU曾是Transformer模型中的主流激活函数，被BERT、GPT-2等经典模型采用。它的数学形式是 `x \cdot \Phi(x)`，其中 `\Phi(x)` 是高斯分布的累积分布函数。
    * **为什么选用它？**
        * **平滑性：** GeLU是ReLU的一个平滑近似。相比于ReLU在0点的突变，GeLU的平滑特性使其在优化过程中梯度更稳定，更有利于模型收敛。
        * **随机正则化思想：** GeLU可以看作是综合了Dropout和ReLU的思想。它根据输入的数值大小，对其进行随机的“归零”或“保留”，但这个过程是确定性的。输入越小，其输出被“归零”的概率越高。

2.  **SwiGLU (Swish-Gated Linear Unit):**
    * **简介：** SwiGLU是目前**最先进、最主流**的选择，被Llama、PaLM、Mixtral、Gemma等一系列现代LLM广泛采用。它属于**门控线性单元（Gated Linear Unit, GLU）** 家族的变体。
    * **工作原理：** 它将前馈网络（FFN）的第一个线性层的输出 `X` 分成两部分， `A` 和 `B` 。然后通过公式 `Swish(A) \otimes B` 计算输出，其中 `Swish(x) = x \cdot \sigma(x)` ， `\sigma` 是Sigmoid函数， `\otimes` 是逐元素相乘。
    * **为什么选用它？**
        * **门控机制（Gating Mechanism）：** SwiGLU的核心优势在于其“门控”设计。 `B` 部分可以被看作一个动态的“门”，它可以根据输入内容，控制 `Swish(A)` 中的信息哪些可以通过、哪些需要被抑制。这种机制**显著增强了模型的表达能力**，使得FFN层可以更灵活地处理信息。
        * **实证效果优越：** Google在PaLM论文中的实验发现，使用SwiGLU替换标准的GeLU或ReLU，可以**显著提升模型的性能**（降低困惑度）。尽管SwiGLU会增加FFN层的参数量（因为需要两个矩阵而不是一个），但其带来的性能增益被证明是值得的。
