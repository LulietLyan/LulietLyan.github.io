---
title: LangChain 与 LlamaIndex 的核心场景有什么不同？
description: 按原材料比较逻辑编排与数据检索两类开发需求及框架特点。
date: 2026-09-12
order: 6
tags:
  - Agent
  - Agent Engineering
  - 面试
---

> **原题 4.6：** 请比较一下两个流行的 Agent 开发框架，如 LangChain 和 LlamaIndex。它们的核心应用场景有何不同？

LangChain和LlamaIndex是构建LLM应用最流行的两个开源框架，它们都极大地简化了开发流程，但它们的**核心哲学和设计重点有所不同**，导致了它们在应用场景上的差异。

## 核心定位的差异：

* **LangChain：一个通用的LLM应用“编排”框架 (General-purpose Orchestration Framework)**
    * **哲学：** LangChain的目标是提供一个全面的工具集，用于将LLM与各种组件（工具、记忆、数据源）“链接”在一起，构建复杂的应用程序，其中Agent是其核心应用之一。它更关注于 **“工作流”的构建**。
    * **核心抽象：** Chains (调用链), Agents (智能体), Memory (记忆模块), Callbacks (回调系统)。

* **LlamaIndex：一个专注于外部数据的“数据”框架 (Data Framework for External Data)**
    * **哲学：** LlamaIndex的出发点是解决LLM与私有或外部数据连接的核心问题，即**RAG (Retrieval-Augmented Generation)**。它专注于如何高效地**摄入（ingest）、索引（index）、和查询（query）**外部数据。它更关注于**“数据流”的管理**。
    * **核心抽象：** Data Connectors (数据连接器), Indexes (索引结构), Retrievers (检索器), Query Engines (查询引擎)。

## 核心应用场景的不同：

| **特性** | **LangChain** | **LlamaIndex** |
| :--- | :--- | :--- |
| **最擅长的场景** | **构建复杂的、多步骤的Agent**：当你的应用需要调用多个不同的工具、维护复杂的对话状态、并遵循一个精心设计的执行逻辑时，LangChain的Agent Executor和Chains提供了极大的灵活性。 | **构建高性能的RAG系统**：当你的核心需求是搭建一个强大的知识库问答系统（Q&A over your data），需要处理复杂的非结构化数据（PDF, PPT）、构建高级索引（如树索引、关键词表索引）、并优化检索质量时，LlamaIndex是首选。 |
| **应用举例** | 1. 一个能上网搜索、执行代码、并调用计算器的**通用研究助手**。<br>2. 一个能连接公司内部API来查询订单、更新客户信息的**自动化客服Agent**。<br>3. 一个能执行一系列复杂操作的**自动化流程（RPA）**。 | 1. 一个能够回答关于公司内部海量技术文档问题的**开发者助手**。<br>2. 一个能够结合多份PDF财报进行深度分析和回答的**金融分析工具**。<br>3. 一个私人的、基于个人笔记库（Notion, Obsidian）的**知识管理和问答系统**。 |
| **功能交叉** | LangChain也内置了RAG功能（Document Loaders, Vector Stores, Retrievers），但相对LlamaIndex来说，其高级功能和可定制性较少。 | LlamaIndex也引入了Agent的概念（Data Agent），允许LLM智能地选择不同的数据源和查询策略，但其Agent的通用性和复杂工具编排能力不如LangChain。 |

## 总结：

* 如果你的项目**以Agent为核心，需要复杂的逻辑编排和多工具协作**，首选**LangChain**。
* 如果你的项目**以数据为核心，需要构建强大的知识库和问答能力**，首选**LlamaIndex**。
* 在实际开发中，两者也常常被**结合使用**：例如，使用LlamaIndex构建一个强大的知识库检索工具，然后将这个工具接入到LangChain构建的Agent中，让Agent能够利用这个知识库来完成更复杂的任务。
