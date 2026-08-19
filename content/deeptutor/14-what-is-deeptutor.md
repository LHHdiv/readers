---
title: "第 14 章 · DeepTutor 是什么"
date: 2026-08-01
summary: "把 DeepTutor 当\"一个人\"来认识——它是什么出身、现在多大、什么性格（设计理念）、和市面上常见的 coding agent 有什么不同。读完这章，你对整个项目会有一个\"人设级\"的把握，后续每一章都是给这个人添细节。"
tags:
  - deeptutor
---
# 第 14 章 · DeepTutor 是什么

> 目标：把 DeepTutor 当"一个人"来认识——它是什么出身、现在多大、什么性格（设计理念）、和市面上常见的 coding agent 有什么不同。读完这章，你对整个项目会有一个"人设级"的把握，后续每一章都是给这个人添细节。

黑话先定义：**智能体框架（agent framework）** 是"造智能体的脚手架"——它帮你把大模型、工具、记忆、知识库、前后端串起来，你不用从零造轮子。**agent-native** 是 DeepTutor 对自己架构的定位：整个系统围绕"智能体循环"来组织，而不是把 AI 当作一个普通 API 调用塞进传统 MVC 里。

---

## 14.1 一句话定位

DeepTutor 是一个**开源的、agent-native 的、终身个性化辅导智能体（lifelong personalized tutoring agent）**。

拆开看：

- **开源**：Apache 2.0 许可，源码全开放，可以自由学习、修改、商用（保留署名即可）。
- **agent-native**：系统核心是一个"智能体循环"，所有功能（问答、解题、检索、出题）都长在这个循环上。
- **终身（lifelong）**：不是聊完就忘，它有长期记忆（第 13/26 章），认识你、记得你的薄弱点。
- **个性化（personalized）**：讲解方式、难度、题材会随你的画像调整。
- **辅导（tutoring）**：教育定位——讲过程、出题、批改、追踪掌握度，不是简单问答。

## 14.2 版本与规模（真实数据）

### 14.2.1 版本号怎么来的

DeepTutor 的版本号有单一事实来源：`deeptutor/__version__.py`。项目文档明确写着（`deeptutor/__version__.py:1` 起）：

```python
"""Single source of truth for the DeepTutor version.
...
CI verifies the tag matches this value before publishing to PyPI;
the web sidebar badge and CLI banner read from this file directly.
"""
__version__ = "1.5.11"   # deeptutor/__version__.py:11
```

版本号集中在一处，CI、网页角标、CLI 横幅都读这一个文件——这是"单一事实来源"的工程实践：改版本号只改一处，不会出现"网页显示 1.5.11、pip 装的是 1.5.9"的错位。

### 14.2.2 项目规模（以仓库现状为准）

| 维度 | 数值（当前仓库） | 说明 |
|------|----------------|------|
| 后端 Python | 600+ 个 .py 文件 | `deeptutor/` 下 |
| 前端 TypeScript | 250+ 个 .tsx / .ts | `web/` 下（Next.js） |
| 测试 | 310+ 个测试文件 | `tests/` |
| 内置能力（Capability） | 7 个 | chat / deep_solve / deep_question / deep_research / visualize / math_animator / mastery_path（`deeptutor/runtime/bootstrap/builtin_capabilities.py:4-10`） |
| Partner 通道 | 19 个 | IM 伴侣机器人通道（第 32 章） |
| 主依赖组 | [cli] / [server] / [partners] / [matrix] / [math-animator] / [dev] / [all] | `pyproject.toml` |

> **说明 · 数字会变，结构不变**
>
> 上面数字是当前快照（根版本 1.5.11）。上游一升级数字就变，但"三层入口 + 调度器 + 能力 + 循环 + 工具 + 总线"的整体结构是稳定的——**学结构，不背数字**。

## 14.3 三扇门一个内核

DeepTutor 有**三个入口**，但共用**一个内核**：

```text
        ┌─────────────────────────────────────────────┐
        │              DeepTutor 内核                   │
        │   ChatOrchestrator → Capability → AgentLoop  │
        │   （调度器）      （能力）      （智能体循环）    │
        └──────────┬──────────────┬─────────────┬──────┘
                   │              │             │
          ┌────────▼───┐  ┌───────▼────┐  ┌─────▼──────┐
          │ CLI (Typer) │  │ WebSocket   │  │ Python SDK │
          │ 命令行      │  │ /api/v1/ws  │  │ DeepTutorApp│
          └────────────┘  └────────────┘  └────────────┘
```

- **CLI**：`deeptutor run chat "..."` / `deeptutor chat`（交互式 REPL），适合脚本和命令行使用。
- **WebSocket**：`/api/v1/ws`，前端网页（Next.js）走这条路，支持双向事件流（第 33 章）。
- **Python SDK**：`deeptutor.app.facade.DeepTutorApp`（`facade.py:56`），让你在自己的 Python 程序里直接调用（第 40 章动手实践）。

三条路最终都汇到同一个 `start_turn`（`deeptutor/services/session/turn_runtime.py:682`），保证"不管从哪扇门进来，行为一致"。这是 agent-native 架构的典型标志：**内核稳定，入口可扩展**。

## 14.4 DeepTutor 与通用 coding agent 的差异

市面上很多智能体工具（如 Pi、Claude Code 类产品）是"编程助手"定位。DeepTutor 是教育定位，差异不是"换了个 UI"，而是**架构上的实质区别**：

| 维度 | 通用 coding agent（如 Pi） | DeepTutor |
|------|---------------------------|-----------|
| 定位 | 帮你写/改代码 | 辅导你学会（教育） |
| 循环 | 通用 agent loop | 标签驱动 loop（强制过程可视化，`loop.py:40`） |
| 长期记忆 | 通常无内置，靠会话文件 | 三层记忆 L1/L2/L3（`services/memory/`） |
| 知识库 | 可选 | 多引擎 RAG（LlamaIndex/GraphRAG/LightRAG 等，第 27 章） |
| MCP | 部分支持 | 完整支持（第 31 章） |
| 教学引擎 | 无 | grading / mastery / policy / scheduler（`deeptutor/learning/`） |
| 协作通道 | 少 | 19 通道 Partner（IM 伴侣机器人，第 32 章） |

> **提示 · 为什么要知道这些差异**
>
> 你最终要用 DeepTutor 的架构做**自己的业务**。搞清楚"它和通用 agent 差在哪"，你就知道：哪些是**通用资产**（循环、工具、总线，你做任何 agent 都该学），哪些是**教育专属**（三层记忆、掌握度，你要做教育就用、做别的业务就替换）。

## 14.5 它"开箱"能做什么（真实能力清单）

基于 `deeptutor/runtime/bootstrap/builtin_capabilities.py:4-10` 的真实能力注册表：

| 能力名 | 干什么 | 对应代码 |
|--------|--------|---------|
| `chat` | 默认聊天+工具调用（最常用） | `agents/chat/capability.py` |
| `deep_solve` | 分阶段深度解题（规划→推理→书写） | `capabilities/solve/capability.py` |
| `deep_question` | 生成好问题（教学出题） | `agents/question/capability.py` |
| `deep_research` | 多步联网研究并出报告 | `agents/research/capability.py` |
| `visualize` | 可视化（SVG/Chart.js/Mermaid/Manim） | `agents/visualize/capability.py` |
| `math_animator` | 数学动画（Manim） | `agents/math_animator/capability.py` |
| `mastery_path` | 掌握度引导学习（引导式对话+教学工具） | `capabilities/mastery/capability.py` |

这些能力都是"标签驱动循环"上长出来的不同"岗位"——循环是发动机，能力是变速箱档位。第 23 章逐个拆。

## 14.6 关联阅读

- 第 15 章：四层架构——从"这是什么"到"内部怎么分层"。
- 第 17 章：启动链路——从命令行一路走到循环。
- 第 23 章：七大能力逐一拆解。

## 自查清单

- [ ] 我能用一句话说出 DeepTutor 的定位（开源、agent-native、终身个性化辅导智能体）。
- [ ] 我知道版本号的单一事实来源是 `deeptutor/__version__.py:11`。
- [ ] 我能画出"三扇门（CLI/WS/SDK）一个内核"的结构。
- [ ] 我知道三个入口最终汇到哪个函数（`turn_runtime.py:682 start_turn`）。
- [ ] 我能说出 DeepTutor 与通用 coding agent 的至少 4 个架构差异。
- [ ] 我能背出 7 个内置能力的名字（chat/deep_solve/deep_question/deep_research/visualize/math_animator/mastery_path）。
- [ ] 我知道内置能力注册表在 `builtin_capabilities.py:4-10`。
