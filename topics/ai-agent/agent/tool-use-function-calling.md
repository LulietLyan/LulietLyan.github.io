---
title: LLM 如何学会调用外部 API 和工具？
description: 从 Function Calling 解释工具描述、参数生成、调用执行与结果反馈。
date: 2026-09-12
order: 5
tags:
  - Agent
  - Agent Engineering
  - 面试
---

> **原题 4.5：** Tool Use是扩展 Agent 能力的有效途径。请解释 LLM 是如何学会调用外部 API 或工具的？（可以从 Function Calling 的角度解释）

LLM学会调用外部API或工具，是其从一个纯粹的“语言模型”转变为一个“行动执行者”的关键一步。这一能力的核心是让LLM能够**理解何时需要使用工具**，以及**如何以结构化的方式表达使用哪个工具和传递什么参数**。目前，主流的实现方式是**Function Calling**。

## Function Calling的工作原理如下：

1.  **工具定义与注册 (Tool Definition & Registration):**
    * 我们首先需要以一种机器可读的方式，向LLM“描述”我们有哪些可用的工具。这个描述通常是一个**结构化的模式（Schema）**，比如JSON Schema。
    * 对于每一个工具，我们需要定义：
        * **函数名称 (Function Name):** 例如，`get_current_weather`。
        * **函数描述 (Function Description):** 用自然语言清晰地描述这个函数的功能。例如，“获取指定城市的实时天气信息”。这个描述至关重要，因为LLM会根据它来判断何时使用该工具。
        * **参数列表 (Parameters):** 定义函数需要哪些输入参数，每个参数的名称、类型、和描述。例如，参数 `location` (string, "城市名") 和 `unit` (enum, "温度单位，可以是celsius或fahrenheit")。

2.  **LLM的决策与意图识别 (LLM's Decision & Intent Recognition):**
    * 在与用户交互时，我们将用户的提问**连同所有已注册的工具描述**一起发送给LLM。
    * LLM（如GPT-4, Gemini等）经过了特殊的指令微调，使其能够理解这种“工具描述”的格式。
    * LLM会分析用户的意图。如果它认为只靠自身知识无法回答，且用户的意图与某个工具的功能相匹配，它就会决定调用该工具。

3.  **生成结构化的调用指令 (Generating Structured Calling Instructions):**
    * 当LLM决定调用工具时，它的输出**不再是自然语言文本**，而是一个特殊格式的、结构化的**JSON对象**（或其他格式）。
    * 这个JSON对象会精确地包含：
        * **要调用的函数名称**。
        * **一个包含所有参数名和值的对象**。
    * 例如，对于用户提问“今天新加坡天气怎么样？”，LLM可能输出：
      ```json
      {
        "tool_call": {
          "name": "get_current_weather",
          "arguments": {
            "location": "Singapore",
            "unit": "celsius"
          }
        }
      }
      ```

4.  **外部执行与结果返回 (External Execution & Result Return):**
    * Agent的控制代码（Orchestrator）会捕获这个特殊的JSON输出。
    * 它会解析JSON，找到函数名和参数，然后在**外部环境中实际执行**这个函数（例如，调用一个真实的天气API）。
    * 函数执行完毕后，会返回一个结果（例如，`{"temperature": 32, "condition": "sunny"}`）。

5.  **整合结果并生成最终回复 (Integrating Result & Generating Final Response):**
    * 控制代码将工具的返回结果**再次格式化**，并将其作为新的上下文信息，连同之前的对话历史一起，再次发送给LLM。
    * 这一次，LLM已经获得了它需要的信息。它会基于这个结果，生成一个最终的、流畅的自然语言回答给用户，例如：“今天新加坡的天气是晴天，温度为32摄氏度。”
