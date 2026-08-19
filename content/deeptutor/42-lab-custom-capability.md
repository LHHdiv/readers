---
title: "第 42 章 · 动手实践三：写一个自定义能力（Capability）"
date: 2026-08-01
summary: "第 41 章你给智能体装了一只\"手\"（工具）。这章你要写一整段\"剧本\"——一个**能力（Capability）**。能力是 DeepTutor 里\"深度模式\"的载体：`deep_solve`（深度解题）、`deep_question`（深度出题）、`mastery_path`（掌握路径）都是能力。读完你就能定义自…"
tags:
  - deeptutor
---
# 第 42 章 · 动手实践三：写一个自定义能力（Capability）

第 41 章你给智能体装了一只"手"（工具）。这章你要写一整段"剧本"——一个**能力（Capability）**。能力是 DeepTutor 里"深度模式"的载体：`deep_solve`（深度解题）、`deep_question`（深度出题）、`mastery_path`（掌握路径）都是能力。读完你就能定义自己的深度模式，并让它在内部自动跑循环、调工具。

本章引用来自 `deeptutor/core/capability_protocol.py`、`deeptutor/core/agentic/loop.py`、`deeptutor/runtime/bootstrap/builtin_capabilities.py`、`deeptutor/runtime/registry/capability_registry.py` 以及真实调用点 `deeptutor/agents/question/pipeline.py`。

## 能力到底是什么（先直觉，后原理）

**直觉**：如果工具是"单步动作"，能力就是"多步剧本 + 一个导演"。比如"深度出题"这个能力，剧本可能是：先探索学生水平 → 再规划题目 → 最后生成题目。导演（能力本身）按剧本一步步走，每一步都可能调用工具、和模型对话。

**原理**：在 DeepTutor 中，能力是一个继承自 `BaseCapability` 的类。它的 `run(context, stream)` 方法里，通常会调用 `run_agentic_loop` 去驱动那套"标签驱动循环"（第 30 章讲过：模型每次先自报 `THINK`/`TOOL`/`FINISH` 等标签，循环按标签路由）。区别在于：工具只跑一次，能力是把多次循环、多个阶段编排起来的"容器"。

```text
用户选择某个深度模式（如 deep_question）
        │
        ▼
系统按名字找到对应 Capability 实例
        │  登记关系见 builtin_capabilities.py:3
        ▼
capability.run(context, stream)       核心剧本
        │
        ├─► run_agentic_loop(...)  ← 第 1 阶段循环（如探索）
        │         │
        │         ▼
        │   模型 THINK/TOOL/FINISH，循环调用工具
        │
        ├─► run_agentic_loop(...)  ← 第 2 阶段循环（如规划）
        │
        └─► run_agentic_loop(...)  ← 第 3 阶段循环（如生成）
```

## 真源码的两个零件

### 零件一：CapabilityManifest —— 能力的"简历"

定义在 `deeptutor/core/capability_protocol.py:20`。它是纯静态元数据，描述这个能力叫什么、分几个阶段、用哪些工具：

```python
@dataclass
class CapabilityManifest:
    name: str
    description: str
    stages: list[str] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    cli_aliases: list[str] = field(default_factory=list)
    request_schema: dict[str, Any] = field(default_factory=dict)
    config_defaults: dict[str, Any] = field(default_factory=dict)
```

`name` 就是用户选择的模式名（如 `deep_question`）；`stages` 是阶段清单，主要给界面和追踪用；`tools_used` 列出它依赖的工具名。

### 零件二：BaseCapability —— 能力的基类

定义在 `deeptutor/core/capability_protocol.py:33`。子类必须提供 `manifest` 并实现 `run`：

```python
class BaseCapability(ABC):
    manifest: CapabilityManifest

    @abstractmethod
    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        ...

    @property
    def name(self) -> str:          # capability_protocol.py:62
        return self.manifest.name

    @property
    def stages(self) -> list[str]:  # capability_protocol.py:67
        return self.manifest.stages
```

`run` 是唯一要你写逻辑的地方。它接收两个参数：`context`（统一上下文，含会话、配置、记忆）和 `stream`（事件总线，用来把进度/正文推给前端）。`context` 与 `stream` 的类型都从 `deeptutor/core/capability_protocol.py:16-17` 导入，是整个系统贯穿各层的标准接口。

> **提示 · run 不返回值，而是"边跑边推"**
>
> 注意 `run` 返回 `None`。能力不把最终答案"return"给谁，而是通过 `stream` 把正文、阶段、引用实时推给前端。这样做才能让长任务在前端一点点"流式"显示出来，而不是憋到最后一次性吐出。

## 循环是怎么被能力驱动的

能力内部几乎都靠 `run_agentic_loop` 这个"发动机"。它的核心声明在 `deeptutor/core/agentic/loop.py:173`：

```python
async def run_agentic_loop(
    *,
    initial_messages: list[dict[str, Any]],
    protocol: LabelProtocol,
    client: Any,
    model: str | None,
    completion_kwargs: dict[str, Any],
    binding: str | None,
    tool_schemas: list[dict[str, Any]] | None,
    stream: StreamBus,
    source: str,
    stage: str,
    max_iterations: int,
    host: LoopHost,
    usage: UsageTracker | None = None,
    stream_body_live: bool = False,
    eager_sub_trace: bool = False,
    implicit_think_label: str | None = None,
) -> LoopOutcome:
```

其中有几个你必须理解的"搭档"：

- `LabelProtocol`（`deeptutor/core/agentic/loop.py:39`）：声明本能力允许哪些标签、哪个是终止标签、哪个代表调工具。循环靠它判断"模型这句话想干嘛"。
- `LoopHost`（`deeptutor/core/agentic/loop.py:79`）：能力实现的回调集合。循环本体保持"通用"，所有能力专属逻辑（上下文窗口裁剪、工具分发、暂停处理）都甩给 `host`。换句话说，**`host` 是你把能力接进循环的地方**。
- `LoopOutcome`（`deeptutor/core/agentic/loop.py:67`）：循环跑完交出的结果，含 `final_label`、`final_text`、`iterations`、`messages` 等——你下一步可以拿它继续。

真实世界里，一次调用长这样（取自 `deeptutor/agents/question/pipeline.py:664`）：

```python
host = _ExploreLoopHost(pipeline=self, stream=stream, context=context, client=client)
outcome = await run_agentic_loop(
    initial_messages=messages,
    protocol=_PROTOCOL_EXPLORE,
    client=client,
    model=self.model,
    completion_kwargs=self._completion_kwargs(DEFAULT_MAX_TOKENS),
    binding=self.binding,
    tool_schemas=tool_schemas,
    stream=stream,
    source=SOURCE,
    stage=STAGE_EXPLORING,
    max_iterations=self.max_explore_iterations,
    host=host,
    usage=self.usage,
    stream_body_live=True,
    eager_sub_trace=True,
)
finish_text = (outcome.final_text or "").strip()
```

## 模板：自定义一个多阶段能力

下面是一份**可照抄**的骨架。我们写一个 `deep_quiz`（深度出题）能力，内部只跑一个探索循环（你可以照着复制出更多阶段）：

```python
# my_capabilities/quiz_capability.py
from dataclasses import dataclass, field
from typing import Any

from deeptutor.core.agentic.loop import (
    LabelProtocol, LoopHost, LoopOutcome, run_agentic_loop,
)
from deeptutor.core.capability_protocol import (
    BaseCapability, CapabilityManifest,
)
from deeptutor.core.stream_bus import StreamBus
from deeptutor.core.context import UnifiedContext


# 1) 告诉循环：这个能力用哪些标签
_QUIZ_PROTOCOL = LabelProtocol(
    allowed=("THINK", "TOOL", "FINISH"),
    terminal=frozenset({"FINISH"}),
    intermediate=frozenset({"THINK"}),
    final=frozenset({"FINISH"}),
    tool_label="TOOL",
)


# 2) 实现 host：把循环通用逻辑接到你的业务上
class _QuizLoopHost(LoopHost):
    def __init__(self, *, stream, context, client):
        self.stream = stream
        self.context = context
        self.client = client

    async def guard_context_window(self, messages):
        return None  # 简单能力可不裁剪

    def build_iteration_trace_meta(self, iteration):
        return {}, {}

    async def dispatch_tools(self, *, iteration, tool_calls):
        # 这里调用 ToolRegistry 真正执行工具，返回 DispatchOutcome
        from deeptutor.runtime.registry import get_tool_registry
        registry = get_tool_registry()
        results = []
        for call in tool_calls:
            name = call.get("name") or call.get("function", {}).get("name")
            args = call.get("arguments", {}) or call.get("function", {}).get("arguments", {})
            out = await registry.execute(name, **args)
            results.append(out)
        return results

    async def emit_final(self, text, final_meta):
        await self.stream.content(text)  # 把最终正文推给前端

    def protocol_retry_notice(self):
        return "格式不对，请重试。"

    def protocol_repair_message(self, violation):
        return "请第一行以 LABEL 开头：THINK/TOOL/FINISH"


# 3) 能力本体
class DeepQuizCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="deep_quiz",
        description="根据用户水平生成针对性练习题。",
        stages=["explore", "generate"],
        tools_used=["rag", "get_weather"],
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        system_prompt = "你是一个出题专家。先 THINK 规划，再 FINISH 输出题目。"
        user_text = context.user_message or "给我出几道微积分题"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ]
        client = context.llm_client  # 从上下文取模型客户端

        host = _QuizLoopHost(stream=stream, context=context, client=client)
        outcome: LoopOutcome = await run_agentic_loop(
            initial_messages=messages,
            protocol=_QUIZ_PROTOCOL,
            client=client,
            model=context.model,
            completion_kwargs={},
            binding=None,
            tool_schemas=None,          # 想用原生工具调用就传 schemas
            stream=stream,
            source=self.manifest.name,
            stage="explore",
            max_iterations=8,
            host=host,
        )
        # outcome.final_text 已是最终题目，已通过 emit_final 推给前端
        return
```

注意三块拼图：`LabelProtocol` 决定标签词汇；`_QuizLoopHost` 实现 `LoopHost` 的回调（最关键是 `dispatch_tools` 去 `ToolRegistry.execute`，见 `deeptutor/runtime/registry/tool_registry.py:128`）；`run` 只是把它们组装好交给 `run_agentic_loop`（`deeptutor/core/agentic/loop.py:173`）。

> **注意 · host 是"接线的地方"，不是"可选的"**
>
> 很多人照抄时漏掉 `host`，结果循环不知道怎么分发工具、怎么把正文推出去。记住：循环本体是能力无关的"发动机"，**所有你的专属行为都通过实现 `LoopHost` 的方法接线**（`deeptutor/core/agentic/loop.py:79`）。最少也要实现 `dispatch_tools`、`emit_final`、`protocol_repair_message` 这几个。

## 登记：让系统"认识"你的能力

写好的类还只是代码，必须登记两步：

**第一步：在 builtin 清单里登记"名字 → 类路径"**

`deeptutor/runtime/bootstrap/builtin_capabilities.py:3` 是一个字典，把能力名映射到"模块:类名"：

```python
BUILTIN_CAPABILITY_CLASSES: dict[str, str] = {
    "chat": "deeptutor.agents.chat.capability:ChatCapability",
    "deep_solve": "deeptutor.capabilities.solve.capability:DeepSolveCapability",
    "deep_question": "deeptutor.agents.question.capability:DeepQuestionCapability",
    "deep_research": "deeptutor.agents.research.capability:DeepResearchCapability",
    "math_animator": "deeptutor.agents.math_animator.capability:MathAnimatorCapability",
    "visualize": "deeptutor.agents.visualize.capability:VisualizeCapability",
    "mastery_path": "deeptutor.capabilities.mastery.capability:MasteryPathCapability",
}
```

把你的加进去：

```python
    "deep_quiz": "my_capabilities.quiz_capability:DeepQuizCapability",
```

**第二步：让 CapabilityRegistry 加载它**

`CapabilityRegistry` 定义在 `deeptutor/runtime/registry/capability_registry.py:39`。`load_builtins()`（`:49`）遍历上面的字典，用 `importlib` 动态导入类并 `register`（`:45`）：

```python
def load_builtins(self) -> None:
    for name, class_path in BUILTIN_CAPABILITY_CLASSES.items():
        ...
        cls = _import_capability_class(class_path)   # 动态 import
        self.register(cls())                          # capability_registry.py:45
```

全局单例 `get_capability_registry()`（`deeptutor/runtime/registry/capability_registry.py:108`）第一次调用就会 `load_builtins()` + `load_plugins()`。前端选择深度模式时，走的正是 `facade.start_turn`（`deeptutor/app/facade.py:114`）→ `turn_runtime.start_turn`（`deeptutor/services/session/turn_runtime.py:682`）这条链，最终按名字取到你的能力实例。

```text
builtin_capabilities.py:3 的字典
        │  名字 → "模块:类名"
        ▼
CapabilityRegistry.load_builtins()   capability_registry.py:49
        │  importlib 动态导入
        ▼
register(实例)                        capability_registry.py:45
        │
        ▼
用户选 deep_quiz → get_capability_registry().get("deep_quiz")
        │
        ▼
capability.run(context, stream)
```

## 真实范例与你的模板对照

内置的 `deep_question` 能力（入口 `deeptutor/agents/question/capability:DeepQuestionCapability`，登记于 `builtin_capabilities.py:6`）内部就是多个 `run_agentic_loop` 串起来：探索阶段（`:664` 那次调用）、规划阶段、生成阶段。它和你刚写的 `DeepQuizCapability` 骨架**完全同构**——只是阶段更多、host 更精细。`mastery_path`（`builtin_capabilities.py:10`）则是把"掌握度追踪"能力化的例子。先抄骨架跑通一个阶段，再逐步加阶段，是最稳的写法。

> **说明 · 能力名就是入口钥匙**
>
> 和工具一样，能力也靠名字被找到。`manifest.name` 必须和你在 `builtin_capabilities.py:3` 字典里写的 key 一致，否则前端选了模式也加载不到。命名统一用小写加下划线。

## 自查清单

- [ ] 我能区分"工具=单步动作"与"能力=多步剧本 + 导演"
- [ ] 我知道 CapabilityManifest（capability_protocol.py:20）与 BaseCapability（:33）各自负责什么
- [ ] 我理解 run(context, stream) 通过 stream 推结果，而不是 return 一个答案
- [ ] 我在模板里正确实现了 LabelProtocol（loop.py:39）来描述标签词汇
- [ ] 我实现了 LoopHost 的关键回调，尤其是 dispatch_tools 去 ToolRegistry.execute
- [ ] 我调用了 run_agentic_loop（loop.py:173）并把 host / protocol / stream 接好
- [ ] 我把能力加进了 builtin_capabilities.py:3 的字典，并确认名字一致
- [ ] 我理解 CapabilityRegistry.load_builtins（capability_registry.py:49）会动态导入并 register 我的类
