---
title: "第 19 章 · ChatOrchestrator 与 UnifiedContext"
date: 2026-08-01
summary: "弄明白\"一次输入\"在到达循环之前，先被谁接管、装进了什么\"行李箱\"。`ChatOrchestrator` 是统一调度中枢，`UnifiedContext` 是它一路携带、递给每个能力的\"万能上下文对象\"。读完你就能回答：为什么默认走 chat？这个对象里到底塞了哪些东西？"
tags:
  - deeptutor
---
# 第 19 章 · ChatOrchestrator 与 UnifiedContext

> 目标：弄明白"一次输入"在到达循环之前，先被谁接管、装进了什么"行李箱"。`ChatOrchestrator` 是统一调度中枢，`UnifiedContext` 是它一路携带、递给每个能力的"万能上下文对象"。读完你就能回答：为什么默认走 chat？这个对象里到底塞了哪些东西？

黑话定义：**编排（orchestrate）**原指乐团指挥——不直接演奏，而是指挥各乐器在正确时机发声。在代码里，`ChatOrchestrator` 就是那个"指挥"：它不自己生成回答，而是把请求**路由**给正确的能力，并管理事件的流出。**UnifiedContext** 则像一份"工单"，把这一次对话需要的所有信息打包，从入口一直传到工具、能力、插件里。

---

## 19.1 ChatOrchestrator 是什么

类定义于 `deeptutor/runtime/orchestrator.py:26`，文档字符串把它说得很直白（`:1`–`6`）：

```python
class ChatOrchestrator:
    """
    Routes a ``UnifiedContext`` to the correct capability, manages
    the ``StreamBus`` lifecycle, and publishes completion events.
    """
```

三个职责，正好对应三件事：

1. **路由（Routes）**：把 `UnifiedContext` 派给正确的能力。
2. **管理 StreamBus 生命周期**：为这一轮建一个事件总线、跑完关掉（见第 20 章）。
3. **发布完成事件**：转完发一个 `CAPABILITY_COMPLETE` 给全局事件总线。

它的构造函数只缓存了两个注册表（`deeptutor/runtime/orchestrator.py:32`–`34`）：

```python
def __init__(self) -> None:
    self._cap_registry = get_capability_registry()   # :33 能力注册表
    self._tool_registry = get_tool_registry()        # :34 工具注册表
```

黑话**注册表（registry）**就是一个"名字 → 对象"的查表器。能力注册表里存着 `chat`/`deep_solve`/`deep_question` 等所有能力，`ChatOrchestrator` 按需取用。

---

## 19.2 一次输入如何被路由到某个能力

入口是 `handle` 方法（`deeptutor/runtime/orchestrator.py:36`）。它先保证有会话 ID，再决定走哪个能力（`deeptutor/runtime/orchestrator.py:43`–`47`）：

```python
async def handle(self, context: UnifiedContext) -> AsyncIterator[StreamEvent]:
    if not context.session_id:
        context.session_id = str(uuid.uuid4())        # :43 没有就现场造一个

    cap_name = context.active_capability or "chat"    # :46 关键：没指定就默认 chat
    capability = self._cap_registry.get(cap_name)     # :47 去注册表取

    if capability is None:
        # 能力名不存在 → 发错误 + DONE，然后退出（deeptutor/runtime/orchestrator.py:49-67）
        ...
```

### 路由判定规则（一张表说清）

| 情况 | `context.active_capability` 的值 | 实际走的能力 | 行号 |
|------|----------------------------------|--------------|------|
| 用户在网页选了"解题" | `"deep_solve"` | `deep_solve` | `:46` 取到即用 |
| 用户在网页选了"出题" | `"deep_question"` | `deep_question` | `:46` |
| CLI 指定 `deeptutor run chat` | `"chat"` | `chat` | `:46` |
| 什么都没指定（最常见） | `None` | **`chat`**（默认） | `:46` 的 `or "chat"` |

> **提示 · 为什么默认是 chat？**
>
> 因为聊天是最高频、最通用的入口。DeepTutor 的设计哲学是"**一个运行时，多种教育模式**"——所有模式（解题、研究、可视化…）都是 chat 的"变体能力"。用户不挑，就给最普适的 chat；挑了，就精准路由。这个 `or "chat"` 是整条链路的"安全默认值"。

### 能力不存在时会怎样

如果 `cap_name` 在注册表里查不到（比如你手滑拼错），`handle` 不会崩，而是用 StreamBus 发一条错误事件和一个 `DONE`，然后 `yield` 出去就收尾（`deeptutor/runtime/orchestrator.py:49`–`67`）。这是一种**温和失败**：前端收到错误提示，而不是后端整个挂掉。

---

## 19.3 handle 怎么把"边算边推字"做成生成器

`handle` 最巧妙的地方，是它本身是一个 **`AsyncIterator`**（异步生成器）。它把"跑能力"和"吐事件"解耦（`deeptutor/runtime/orchestrator.py:83`–`114`）：

```python
async def _run() -> None:
    status = "completed"
    try:
        await capability.run(context, bus)            # :86 真正跑能力（后台进行）
    except Exception as exc:
        status = "failed"
        logger.error(...)
        await bus.error(str(exc), source=cap_name, ...)
    finally:
        await bus.emit(StreamEvent(type=StreamEventType.DONE, ...))   # :96 收尾 DONE
        await bus.close()                                            # :103 关总线
        if _turn_id:
            unregister_bus(_turn_id)

stream = bus.subscribe()                              # :107 订阅事件
task = asyncio.create_task(_run())                    # :108 能力在后台跑
async for event in stream:                            # :110 前台一个一个吐事件
    yield event
await task
await self._publish_completion(context, cap_name)     # :114 发完成事件到全局总线
```

把这张"分工图"画出来：

```text
handle(context) 这个生成器
   │
   ├─ _run() 协程（后台，task=:108）
   │      │
   │      └─ capability.run(context, bus)   (:86)
   │             │  能力内部反复往 bus 里塞事件
   │             │  （思考/工具/正文… 见第20章）
   │             ▼
   │          bus.close()  (:103)
   │
   └─ async for event in stream  (前台，:110)
          │  每收到一个 bus 事件就 yield 给上层
          ▼
       WebSocket / CLI 实时收到，推到屏幕
```

> 这就是第 17 章说的"边算边推字"的落地：能力在 `_run` 里算，事件经 `bus` 流到前台的 `async for` 循环被 `yield` 出去。两者通过 `StreamBus` 解耦（第 20 章详述）。

---

## 19.4 完成事件：_publish_completion

能力跑完、总线关掉后，`handle` 还会向**全局事件总线**发一个 `CAPABILITY_COMPLETE`（`deeptutor/runtime/orchestrator.py:116`）：

```python
async def _publish_completion(self, context: UnifiedContext, cap_name: str) -> None:
    try:
        bus = get_event_bus()
        await bus.publish(
            Event(
                type=EventType.CAPABILITY_COMPLETE,
                task_id=str(context.metadata.get("turn_id") or context.session_id),
                user_input=context.user_message,
                agent_output="",
                metadata={
                    "capability": cap_name,
                    "session_id": context.session_id,
                    "turn_id": str(context.metadata.get("turn_id", "")),
                },
            )
        )
    except Exception:
        logger.debug("EventBus publish failed (may not be running)", exc_info=True)
```

黑话**全局事件总线（EventBus）**和"本次的 StreamBus"不是一回事：StreamBus 管"这一轮往前端推的事件流"，EventBus 管"跨组件的全局通知"（比如记忆系统听到'某能力跑完了'去更新用户画像）。两者用 `try/except` 隔开——EventBus 没起也不影响主线（`deeptutor/runtime/orchestrator.py:133` 吞掉异常）。

---

## 19.5 UnifiedContext：这一轮的"万能行李箱"

能力真正拿到的，是 `UnifiedContext`。它的类定义在 `deeptutor/core/context.py:34`，文档说它是"**一个贯穿编排器、流入每一个工具/能力/插件调用的数据对象**"。

字段清单（`deeptutor/core/context.py:70`–`84`）逐一看：

```python
@dataclass
class UnifiedContext:
    session_id: str = ""                              # :70 持久会话 ID
    user_message: str = ""                            # :71 当前用户输入
    conversation_history: list[dict[str, Any]] = ...  # :72 OpenAI 格式的历史消息
    enabled_tools: list[str] | None = None            # :73 用户手动开启的可选工具
    allowed_builtin_tools: list[str] | None = None    # :74 内置工具的白名单门控
    active_capability: str | None = None              # :75 选中的能力（None=纯聊天）
    knowledge_bases: list[str] = ...                 # :76 用于 RAG 的知识库名
    attachments: list[Attachment] = ...              # :77 随消息发的图片/文件
    config_overrides: dict[str, Any] = ...            # :78 单次请求的配置覆盖（如温度）
    language: str = "en"                              # :79 UI / 回答语言
    memory_context: str = ""                          # :80 注入系统提示的记忆快照文本
    persona_context: str = ""                         # :81 人格设定（一开口就要塑声音）
    skills_manifest: str = ""                         # :82 系统提示里的 Skills 块
    source_manifest: str = ""                         # :83 附件来源清单（逐行 id/名称/类型）
    metadata: dict[str, Any] = ...                   # :84 能力专属的杂项
```

### 这些字段怎么被"装进箱子"

回想第 17 章：`_run_turn` 在 `deeptutor/services/session/turn_runtime.py:1654` 构造 `UnifiedContext`。它的值来自哪里？

| 字段 | 来源（第 17 章对应环节） |
|------|--------------------------|
| `user_message` | 前端 WS 消息体里的 `content` |
| `active_capability` | 前端传的 `capability`，或默认 `chat`（`deeptutor/runtime/orchestrator.py:46`） |
| `enabled_tools` | `start_turn` 回填的可用工具（`deeptutor/services/session/turn_runtime.py:808`–`826`） |
| `knowledge_bases` | 前端选的 KB，或会话偏好 |
| `language` | `start_turn` 补的默认语言（`deeptutor/services/session/turn_runtime.py:684`–`689`） |
| `session_id` | `handle` 里现场生成或沿用（`deeptutor/runtime/orchestrator.py:43`） |
| `metadata` | 含 `turn_id`，贯穿到事件流（第 20 章） |

### "Attachments"还有自己的小结构

`UnifiedContext` 里 `attachments` 是 `Attachment` 列表（`deeptutor/core/context.py:16` 定义）。每个附件记录类型、URL/Base64、文件名、MIME、稳定 ID、以及文档抽取出的纯文本：

```python
@dataclass
class Attachment:
    type: str                       # :19  "image" | "file" | "pdf"
    url: str = ""
    base64: str = ""
    filename: str = ""
    mime_type: str = ""
    id: str = ""                   # :26 稳定 ID，也是原始字节在存储里的目录段
    extracted_text: str = ""       # :30 PDF/DOCX 等抽取出的纯文本
```

> **说明 · 为什么用"一个对象装全部"而不是一堆参数？**
>
> 因为一次对话要带的信息太多（消息、工具、记忆、KB、附件、人格…）。如果每传一层都加参数，函数签名会爆炸。`UnifiedContext` 把这些都收进**一个 dataclass**，从入口一路传到工具层，谁需要哪样自己取。这叫"上下文对象（Context Object）"模式，是大型系统的常见做法。

---

## 19.6 路由 → 装箱 → 循环：三章连起来

把第 17、18、19 章的主角放在一张图里：

```text
用户输入
   │
   ▼
ChatOrchestrator.handle(context)        ← 第19章：路由中枢
   │   cap_name = active_capability or "chat"   (deeptutor/runtime/orchestrator.py:46)
   │   从 UnifiedContext 取出"要什么能力"
   ▼
capability.run(context, bus)            ← context 是"行李箱"(deeptutor/core/context.py:34)
   │
   ▼
run_agentic_loop(...)  /  AgentLoop     ← 第18章：标签驱动循环
   │   每轮从 context 读消息/工具/记忆，写回结果
   ▼
模型思考 / 调工具 / 收尾  →  事件经 bus 流回前端  ← 第20章
```

`UnifiedContext` 就是贯穿这三层的"血液"：入口装好，循环里被反复读写，最后事件流把它携带的 `session_id`/`turn_id` 一路带出去。

---

## 19.7 顺手可用的查询接口

`ChatOrchestrator` 还顺手提供了几个给上层（如 Web 设置页、CLI `plugin` 命令）用的查询方法（`deeptutor/runtime/orchestrator.py:136`–`146`）：

```python
def list_tools(self) -> list[str]:                  # :136 列出所有工具名
    return self._tool_registry.list_tools()
def list_capabilities(self) -> list[str]:           # :139 列出所有能力名
    return self._cap_registry.list_capabilities()
def get_capability_manifests(self) -> list[dict]:   # :142 能力的"名片"集合
    return self._cap_registry.get_manifests()
def get_tool_schemas(self, names=None):             # :145 取工具的 OpenAI schema
    return self._tool_registry.build_openai_schemas(names)
```

> **注意 · 别把 ChatOrchestrator 当成"聊天专属"**
>
> 名字带 "Chat" 容易误导：它其实是**所有能力**的统一入口，不只是聊天。`handle` 里 `or "chat"` 只是"没指定能力时的默认"，并不限制它只能跑 chat。研究、解题、出题都从同一个 `handle` 进、按 `active_capability` 分流。理解这点，才不会被类名带偏。

---

## 19.8 一个构造 UnifiedContext 的具象例子

把 19.5 的字段表落成一段"伪代码"，你会更直观地看到这个对象长什么样。假设用户在网页问"用我上传的 PDF 讲讲注意力机制"，并选了 `rag` 工具：

```python
context = UnifiedContext(
    session_id="sess_abc123",            # :70 会话 ID（或由 handle 生成）
    user_message="用我上传的 PDF 讲讲注意力机制",   # :71 当前输入
    conversation_history=[...],          # :72 之前的对话（OpenAI 格式）
    enabled_tools=["rag"],              # :73 用户开启的工具
    active_capability=None,              # :75 None → 默认 chat
    knowledge_bases=["my-pdf-kb"],      # :76 关联的知识库
    attachments=[Attachment(type="pdf", filename="paper.pdf", id="att_1", ...)],  # :77
    language="zh",                       # :79 回答语言
    memory_context="用户是研究生，偏好严谨推导",  # :80 记忆快照
    persona_context="",                 # :81 未选人格
    skills_manifest="",                 # :82 无额外技能
    source_manifest="att_1 | paper.pdf | pdf | 《注意力机制综述》...",  # :83 来源清单
    metadata={"turn_id": "turn_xyz", ...},   # :84 含轮次 ID
)
```

`ChatOrchestrator.handle` 看到 `active_capability=None`，按 `deeptutor/runtime/orchestrator.py:46` 路由到 `chat`。能力层再从这个对象里各取所需：把 `conversation_history` + `user_message` 组成对话历史、把 `enabled_tools` 解析成要挂载的工具、把 `knowledge_bases` 接进 RAG、把 `memory_context` 注入系统提示。

> **提示 · 想验证？打印它**
>
> 在 `deeptutor/services/session/turn_runtime.py:1654`（构造 `UnifiedContext` 处）之后加一行 `print(context)`，跑一次 `deeptutor run chat "你好"`，终端会把这个对象的全部字段原样打出来。这是"看见行李箱里装了什么"的最直接方式。

---

## 19.9 行李箱怎么流进循环：从 context 到 messages

你可能会疑惑：`UnifiedContext` 是编排层的概念，而第 18 章的 `run_agentic_loop` 收的是 `initial_messages`（`deeptutor/core/agentic/loop.py:175`）。两者怎么接上？

答案是**能力层做转换**：能力（如 chat 的 `AgenticChatPipeline` 或 question 的 pipeline）从 `UnifiedContext` 里取出 `conversation_history`、`user_message`、记忆、附件等，拼成一份 OpenAI 格式的 `messages` 列表，再作为 `initial_messages` 传给循环（见 `deeptutor/core/agentic/loop.py:175` 的参数名）。循环本身**从不直接读 `UnifiedContext`**——它只认 `messages` 和 `protocol` 和 `host`。

这又回到第 18 章的核心思想：`run_agentic_loop` 是能力无关的（capability-agnostic）。`UnifiedContext` 是"能力专属的 rich 对象"，`messages` 是"循环能懂的精简输入"。中间的翻译，是能力（及其 `LoopHost` 实现）的职责。

把这三层的"数据形态"排成一列：

```text
前端消息 (WS JSON)
      │  _run_turn 装配
      ▼
UnifiedContext            (deeptutor/core/context.py:34)  ← 编排层：字段最全
      │  能力层翻译（取 history/工具/记忆/附件）
      ▼
messages: list[dict]      (deeptutor/core/agentic/loop.py:175 initial_messages)  ← 循环层：OpenAI 格式
      │  run_labeled_step 每轮读它、写回它
      ▼
模型一轮轮迭代
```

> 注意 `run_agentic_loop` 会**原地修改** `initial_messages`（`deeptutor/core/agentic/loop.py:211` 的 `messages = initial_messages`，`:298`/`:327` 往里追加），所以循环结束后，`messages` 就是完整的对话历史，可被调用方取走复用（`LoopOutcome.messages`，`deeptutor/core/agentic/loop.py:370`）。

---

## 自查清单

- [ ] 我知道 `ChatOrchestrator` 的三大职责（路由 / 管理 StreamBus / 发布完成事件），定义在 `deeptutor/runtime/orchestrator.py:26`
- [ ] 我能说出路由判定的核心行：`cap_name = context.active_capability or "chat"`（`deeptutor/runtime/orchestrator.py:46`）
- [ ] 我知道没指定能力时默认走 `chat`，且能力名拼错会被温和报错而非崩溃
- [ ] 我理解 `handle` 是异步生成器：`_run` 后台跑能力、前台 `async for` 吐事件（`deeptutor/runtime/orchestrator.py:108`–`110`）
- [ ] 我知道 `_publish_completion`（`deeptutor/runtime/orchestrator.py:116`）发的是全局 EventBus 的 `CAPABILITY_COMPLETE`，和本轮 StreamBus 是两回事
- [ ] 我能列出 `UnifiedContext`（`deeptutor/core/context.py:34`）至少 6 个字段及其含义（如 `user_message`/`enabled_tools`/`memory_context` 等）
- [ ] 我理解 `UnifiedContext` 是"一个对象装全部上下文"的上下文对象模式，从入口传到工具层
- [ ] 我知道 `ChatOrchestrator` 名字带 Chat 但不是聊天专属，而是所有能力的统一入口
