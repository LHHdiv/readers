---
title: "第 15 章 · 四层架构：Tool → Capability → Loop → 应用"
date: 2026-08-01
summary: "给 DeepTutor 的\"骨架\"拍一张 X 光片——从下到上四层（工具、能力、循环、应用）各是什么、依赖方向朝哪、每层对应哪些真实文件。读完这章，你脑子里会有一个\"抽屉式\"的架构模型：以后读任何一章，都知道它属于哪个抽屉、抽屉之间怎么衔接。"
tags:
  - deeptutor
---
# 第 15 章 · 四层架构：Tool → Capability → Loop → 应用

> 目标：给 DeepTutor 的"骨架"拍一张 X 光片——从下到上四层（工具、能力、循环、应用）各是什么、依赖方向朝哪、每层对应哪些真实文件。读完这章，你脑子里会有一个"抽屉式"的架构模型：以后读任何一章，都知道它属于哪个抽屉、抽屉之间怎么衔接。

黑话先定义：**分层架构（layered architecture）** 是把系统按职责切成若干层，下层不依赖上层、上层只调用下层。**依赖方向** 指"谁引用谁"——画图时箭头从"使用方"指向"被使用方"。

---

## 15.1 一张图看四层

```text
┌──────────────────────────────────────────────────────────────┐
│ ④ 应用层（App）       CLI / WebSocket / Python SDK             │
│   三扇门：deeptutor_cli/ · api/routers/unified_ws.py ·        │
│           app/facade.py:56 DeepTutorApp                       │
├──────────────────────────────────────────────────────────────┤
│ ③ 能力层（Capability）   业务编排：一个能力 = 一个"岗位"        │
│   capability_protocol.py:33 BaseCapability                    │
│   builtin_capabilities.py:4-10 七个能力注册表                  │
│   agents/chat · capabilities/solve · agents/visualize ...     │
├──────────────────────────────────────────────────────────────┤
│ ② 循环层（Loop）         智能体引擎：标签驱动循环（发动机）      │
│   core/agentic/loop.py:173 run_agentic_loop                   │
│   core/agentic/labeled_step.py · labels.py · tool_dispatch.py │
│   core/agentic/tool_arg_guard.py · client.py                  │
├──────────────────────────────────────────────────────────────┤
│ ① 工具层（Tool）         最小的可复用能力单元                   │
│   core/tool_protocol.py:48 ToolDefinition                     │
│   core/tool_protocol.py:122 ToolResult                        │
│   core/tool_protocol.py:206 BaseTool                          │
│   tools/builtin/（reason.py、rag 等具体工具）                   │
└──────────────────────────────────────────────────────────────┘
        依赖方向：① ← ② ← ③ ← ④（上层使用下层，下层不认识上层）
```

**核心原则：依赖只往下，不往上。** 工具层不知道"能力"是什么；循环层只认"工具接口"，不知道哪个能力在用自己。这样每一层都可以独立替换、独立测试——这就是架构的价值。

## 15.2 第一层：工具层（Tool）——最小的积木

工具是"一件具体能干的事"：联网搜索、检索知识库、执行代码、深度推理……每个工具三件套定义在 `deeptutor/core/tool_protocol.py`：

```python
class ToolDefinition:
    # tool_protocol.py:48  工具的"身份证"：名字、描述、参数 schema
    name: str
    description: str
    input_schema: dict   # 参数怎么填（JSON Schema）
    ...

class ToolResult:
    # tool_protocol.py:122  工具执行完的"回执"：结果、错误、元数据
    ...

class BaseTool(ABC):
    # tool_protocol.py:206  所有工具的抽象基类：必须实现 run()
    ...
```

工具层的特点：

- **小**：一个工具只做一件事（`tools/builtin/reason.py` 就是"调一次深度推理"）。
- **自描述**：`ToolDefinition` 把"我能干什么、参数怎么填"写成 schema，喂给模型，模型才能"想调用我"（第 7 章函数调用）。
- **可插拔**：加一个新工具 = 写一个 `BaseTool` 子类 + 注册（第 22/41 章）。

## 15.3 第二层：循环层（Loop）——发动机

循环层是整个系统的**发动机**：它拿着工具列表，一遍遍问模型"下一步干嘛"，模型说要调工具就去调、说思考就继续、说结束就收尾。核心在 `deeptutor/core/agentic/loop.py`：

```python
class LabelProtocol:
    # loop.py:40  标签词汇表（哪些标签合法、哪个算结束）
    ...

class LoopHost(Protocol):
    # loop.py:79  能力注入循环的"插座"（第 18 章详讲）
    ...

async def run_agentic_loop(...):
    # loop.py:173  主循环：守卫→钩子→单步→违规修复→分支
    ...
```

配套文件：

- `labeled_step.py:104 run_labeled_step`：流式跑一步（收 chunk、探测标签，第 11 章）；
- `labels.py:34 classify_label`：从输出开头识别标签；
- `tool_dispatch.py`：模型要调工具时，负责真去执行并回灌结果；
- `tool_arg_guard.py`：工具参数守卫（防注入、防非法参数）。

> **说明 · 循环层为什么不认识"能力"**
>
> `run_agentic_loop` 只和"标签协议 + 工具接口"打交道。它不知道自己在跑"解题"还是"出题"——那是能力层的事。这种解耦让**循环可以被任何能力复用**，也让循环本身可以被单独测试。

## 15.4 第三层：能力层（Capability）——岗位编排

能力是"一个完整的业务岗位"：解题、出题、研究、可视化、引导学习……每个能力：

1. 声明自己（`CapabilityManifest`，`capability_protocol.py:21`）；
2. 继承 `BaseCapability`（`capability_protocol.py:33`）实现 `run()`；
3. 在 `run()` 里**调用 `run_agentic_loop`**（复用发动机），并按业务需要配置标签、工具、阶段。

```python
class BaseCapability(ABC):
    # capability_protocol.py:33  所有能力的抽象基类
    ...
    async def run(self, ctx: UnifiedContext) -> None:  # 能力的主入口
        ...
```

能力的注册表在 `deeptutor/runtime/bootstrap/builtin_capabilities.py:4-10`——一个"名字 → 类路径"的映射表：

```python
CAPABILITY_CLASS_PATHS = {
    "chat": "deeptutor.agents.chat.capability:ChatCapability",                 # :4
    "deep_solve": "deeptutor.capabilities.solve.capability:DeepSolveCapability",  # :5
    "deep_question": "deeptutor.agents.question.capability:DeepQuestionCapability", # :6
    "deep_research": "deeptutor.agents.research.capability:DeepResearchCapability", # :7
    "math_animator": "deeptutor.agents.math_animator.capability:MathAnimatorCapability", # :8
    "visualize": "deeptutor.agents.visualize.capability:VisualizeCapability",  # :9
    "mastery_path": "deeptutor.capabilities.mastery.capability:MasteryPathCapability", # :10
}
```

**"能力"与"工具"的关系一句话**：工具是"会不会干一件事"，能力是"要不要干一件业务"——能力会**组合多个工具**来完成一个业务目标（比如 `deep_research` 会同时用 `web_search` + `reason` + `write_note`）。

## 15.5 第四层：应用层（App）——三扇门

应用层是"用户碰到的入口"，它把内核包装成可用的产品形态：

- **CLI**：`deeptutor_cli/main.py`（Typer 命令行）；
- **WebSocket**：`deeptutor/api/routers/unified_ws.py`（网页前端入口，双向事件流）；
- **Python SDK**：`deeptutor/app/facade.py:56 DeepTutorApp`（程序化调用）。

应用层做三件事：**收请求 → 组装 `UnifiedContext`（`core/context.py:34`）→ 调用 `ChatOrchestrator` 选能力**。调度器的角色：

```text
一次请求的"跨层之旅"（四层全部参与）:

  应用层:  用户输入 → unified_ws / CLI / SDK
              │
              ▼
  应用层:  turn_runtime.py:682 start_turn 组装 UnifiedContext
              │
              ▼
  能力层:  ChatOrchestrator（orchestrator.py:26）按 context 选能力
              │        默认 chat
              ▼
  循环层:  能力.run() 内部调用 run_agentic_loop（loop.py:173）
              │        循环一遍遍问模型
              ▼
  工具层:  模型要调工具 → tool_dispatch 执行 BaseTool.run()
              │        结果回灌，循环继续
              ▼
  循环层:  命中终止标签 → 收尾
              │
              ▼
  应用层:  所有事件经 StreamBus 推回前端（第 20 章）
```

## 15.6 四层带来的"可迁移能力"

看懂四层，你就拿到了"造任何 agent"的模板：

| 你要做的 | 动哪层 | 哪些不用动 |
|---------|--------|-----------|
| 做个新工具 | 第 1 层（写 BaseTool 子类+注册） | 2/3/4 层全不动 |
| 做个新能力（新业务） | 第 3 层（写 BaseCapability 子类+注册） | 1 层复用现成工具，2 层复用循环 |
| 换个产品壳（小程序/桌面端） | 第 4 层（新增入口） | 1/2/3 层全不动 |
| 换模型厂商 | 服务层（第 24 章，LLM 服务层） | 四层结构不动 |

> **提示 · 一句话记住本章**
>
> **工具是积木，循环是发动机，能力是岗位，应用是门面**。依赖只往下，上层不认识下层——这就是 DeepTutor 能让你"只写业务、不碰骨架"的架构基础。

## 15.7 关联阅读

- 第 22 章：BaseTool 三件套与工具注册表。
- 第 18 章：循环层（标签驱动）逐行。
- 第 23 章：BaseCapability 与七大能力。
- 第 33 章：应用层三扇门与 API。

## 自查清单

- [ ] 我能画出四层架构图并标出依赖方向（只往下）。
- [ ] 我知道工具层三件套（ToolDefinition:48 / ToolResult:122 / BaseTool:206）各是什么。
- [ ] 我知道循环层主入口是 `run_agentic_loop`（loop.py:173）。
- [ ] 我能说出"能力层如何复用循环"（BaseCapability.run 内部调 run_agentic_loop）。
- [ ] 我知道能力注册表在 `builtin_capabilities.py:4-10`，并能背出 3 个能力名。
- [ ] 我能说清"能力"与"工具"的区别（业务 vs 单件事）。
- [ ] 我能说出应用层三扇门（CLI / WS / SDK）及各自的真实文件。
- [ ] 我能填出"做新工具/新能力/换壳"分别动哪一层。
