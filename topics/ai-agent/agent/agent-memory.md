---
title: 如何设计 Agent 的短期记忆和长期记忆？
description: 比较上下文、摘要、向量数据库等记忆机制及其用途。
date: 2026-09-12
order: 4
tags:
  - Agent
  - Agent Engineering
  - 面试
---

> **原题 4.4：** Memory是 Agent 的一个关键模块。请问如何为 Agent 设计短期记忆和长期记忆系统？可以借助哪些外部工具或技术？

记忆模块是Agent打破LLM上下文窗口限制、实现持续学习和个性化的关键。设计Agent的记忆系统通常会模仿人类的记忆机制，分为短期记忆和长期记忆。

## 1. 短期记忆 (Short-Term Memory):

* **作用：** 存储当前任务的上下文信息，包括即时对话历史、中间的思考步骤（如ReAct的Scratchpad）、工具的调用结果等。它是Agent进行连贯思考和行动的基础。
* **实现方式：**
    * **LLM的上下文窗口 (Context Window):** 这是最直接的短期记忆载体。所有最近的交互都会被放入Prompt中。
    * **缓冲区 (Buffers):** 在Agent框架（如LangChain）中，通常会使用不同类型的缓冲区来管理对话历史，例如：
        * **ConversationBufferMemory:** 存储完整的对话历史。
        * **ConversationBufferWindowMemory:** 只保留最近的K轮对话。
        * **ConversationSummaryBufferMemory:** 在历史对话过长时，动态地用LLM进行总结，以节省Token。
    * **暂存器 (Scratchpad):** 用于记录ReAct框架中的“Thought-Action-Observation”轨迹，是Agent进行逐步推理的关键。

## 2. 长期记忆 (Long-Term Memory):

* **作用：** 存储跨越任务和时间维度的信息，如用户的个人偏好、过去的成功/失败经验、领域知识等。它使得Agent能够“学习”和“成长”。
* **实现方式与外部工具：** 长期记忆的核心是“**存储**”和“**检索**”，这通常需要借助外部技术，最主流的是**RAG (Retrieval-Augmented Generation)** 范式。
    * **核心技术：向量数据库 (Vector Database)**
        * **工具：** Pinecone, ChromaDB, FAISS, Weaviate等。
        * **工作流程：**
            1.  **存储（Storing/Writing）：** 当Agent获得一个有价值的信息（如用户明确给出的偏好、一个成功解决问题的完整流程）时，它会使用一个<strong>嵌入模型（Embedding Model）</strong>将这段文本信息转换成一个高维向量。然后，将这个向量及其原始文本存入向量数据库。
            2.  **检索（Retrieving/Reading）：** 在Agent进行规划或决策时，它会把当前的任务或问题也转换成一个查询向量。然后，用这个查询向量去向量数据库中进行**相似度搜索**，找出与当前情况最相关的历史记忆。
            3.  **使用（Using）：** 检索到的记忆（原始文本）会被插入到LLM的Prompt中，作为额外的上下文，来指导LLM做出更明智的决策。
    * **其他技术：**
        * **传统数据库/知识图谱：** 对于结构化或关系型数据，使用SQL数据库或图数据库（如Neoj）进行存储和精确查询也是一种有效的长期记忆形式。
