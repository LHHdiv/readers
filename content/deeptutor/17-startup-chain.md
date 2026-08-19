---
title: "第 17 章 · 启动链路全解析"
date: 2026-08-01
summary: "把\"我在网页输入框敲了一句话，回车\"到\"这句话最终进入智能体循环\"之间，经过的每一个代码环节都标出来、讲清楚。读完你能在脑子里画出一条从前端到 `loop.py` 的调用链。"
tags:
  - deeptutor
---
# 第 17 章 · 启动链路全解析

> 目标：把"我在网页输入框敲了一句话，回车"到"这句话最终进入智能体循环"之间，经过的每一个代码环节都标出来、讲清楚。读完你能在脑子里画出一条从前端到 `loop.py` 的调用链。

黑话定义：**调用链（call chain）**就是"谁调用了谁"的先后顺序，像多米诺骨牌一样，推倒第一张，后面的依次倒下。本章就是把这张骨牌一张张标上 `文件:行号`。

---

## 17.1 两个入口：网页和命令行

一次用户输入有两条来路：

1. **网页（WebSocket）**：你在浏览器 `http://127.0.0.1:3782` 的输入框打字，前端通过一条长连接 WebSocket 把消息发到后端。
2. **命令行（CLI）**：你直接在终端敲 `deeptutor run chat "你好"`。

它们最终汇合到同一个地方——`TurnRuntimeManager.start_turn`。下面分别说。

### 入口 A：WebSocket

后端的 WebSocket 端点定义在 `deeptutor/api/routers/unified_ws.py:45`：

```python
@router.websocket("/ws")
async def unified_websocket(ws: WebSocket) -> None:
```

它先校验身份（`deeptutor/api/routers/unified_ws.py:50` 的 `ws_require_auth`），然后进入一个大循环，按消息的 `type` 分发。当收到 `message` 或 `start_turn` 时（`deeptutor/api/routers/unified_ws.py:114`）：

```python
if msg_type in {"message", "start_turn"}:
    from deeptutor.services.session import get_turn_runtime_manager
    runtime = get_turn_runtime_manager()
    try:
        _, turn = await runtime.start_turn(msg)
    except RuntimeError as exc:
        ...
    await subscribe_turn(turn["id"], after_seq=0)
    continue
```

注意它做了两件事：`runtime.start_turn(msg)` 真正开跑，然后 `subscribe_turn(...)` 把这条轮次的事件**转发**给前端（见第 20 章）。

### 入口 B：命令行

命令行 `deeptutor run` 在 `deeptutor_cli/main.py:75` 定义。它构造一个请求对象，调 `run_turn_and_render` 直接驱动一轮。CLI 路径更短，但本质也是"构造上下文 → 跑能力"。本章以更完整的网页路径为主线。

> **说明 · 为什么 WebSocket 而不是普通 HTTP？**
>
> 聊天是"流式"的——模型边想边吐字，网页要实时显示。普通 HTTP 请求是一问一答、收完才回；WebSocket 是一条**一直开着**的双向通道，后端能主动把一个个事件推给前端。这正是第 20 章"事件流"的物理基础。

---

## 17.2 汇合点：TurnRuntimeManager.start_turn

无论网页还是命令行，开新的一轮都会走到 `deeptutor/services/session/turn_runtime.py:682` 的 `start_turn`。这个函数的前半段是**"把请求收拾干净"**：

- 确定能力名（默认 `chat`，见后面 17.4）：`deeptutor/services/session/turn_runtime.py:683`
- 补默认语言、校验能力配置：`deeptutor/services/session/turn_runtime.py:684`–`709`
- 处理 mastery path / persona / 模型选择等会话偏好：`deeptutor/services/session/turn_runtime.py:717`–`843`
- 回填可用工具列表、套用管理员工具白名单：`deeptutor/services/session/turn_runtime.py:808`–`826`

收拾完，它真正"开一张轮次工单"并**在后台起一个任务**（`deeptutor/services/session/turn_runtime.py:844` 和 `:873`）：

```python
turn = await self.store.create_turn(session["id"], capability=capability)   # :844
execution = _TurnExecution(
    turn_id=turn["id"],
    session_id=session["id"],
    capability=capability,
    payload=dict(payload),
)
...
async with self._lock:
    self._executions[turn["id"]] = execution
    execution.task = asyncio.create_task(self._run_turn(execution))          # :873
return session, turn
```

黑话 `asyncio.create_task` 就是"把这个活儿丢到后台去跑，不阻塞当前函数"。所以 `start_turn` 几乎立刻返回，真正的推理在 `_run_turn` 这个后台任务里进行。

---

## 17.3 后台任务：_run_turn 组装上下文

`_run_turn` 是真正干活的。它最关键的一步是**把零散的请求拼成一个统一的"上下文对象" `UnifiedContext`**，然后在 `deeptutor/services/session/turn_runtime.py:1703`–`1705`：

```python
context = UnifiedContext(                                    # :1654 附近构造
    session_id=...,
    user_message=...,
    enabled_tools=...,
    knowledge_bases=...,
    ...
)
...
orch = ChatOrchestrator()                                     # :1703
async for event in orch.handle(context):                      # :1705
    ...  # 把事件转发到持久化 + 实时订阅者
```

`__TurnExecution`

---

## 17.4 调度中枢：ChatOrchestrator.handle

`ChatOrchestrator`（定义于 `deeptutor/runtime/orchestrator.py:26`）是整个系统的**统一路由入口**。所有消费者——CLI、WebSocket、SDK——都调它的 `handle` 方法（`deeptutor/runtime/orchestrator.py:36`）。

它干的第一件事就是**路由**：看你想要哪个能力（`deeptutor/runtime/orchestrator.py:43`–`47`）：

```python
async def handle(self, context: UnifiedContext) -> AsyncIterator[StreamEvent]:
    if not context.session_id:
        context.session_id = str(uuid.uuid4())        # :43 没会话就造一个
    cap_name = context.active_capability or "chat"    # :46 没指定就默认 chat
    capability = self._cap_registry.get(cap_name)     # :47 去能力注册表取
```

如果能力名不存在，它会通过 StreamBus 发一个错误事件然后退出（`deeptutor/runtime/orchestrator.py:49`–`67`）。

拿到能力后，它**把整轮推理包在一个后台 `_run` 协程里**，并让 `handle` 本身变成一个"事件生成器"（`deeptutor/runtime/orchestrator.py:83`–`114`）：

```python
async def _run() -> None:
    status = "completed"
    try:
        await capability.run(context, bus)            # :86 真正跑这个能力
    except Exception as exc:
        status = "failed"
        ...
    finally:
        await bus.emit(StreamEvent(type=StreamEventType.DONE, ...))   # :96
        await bus.close()
        if _turn_id:
            unregister_bus(_turn_id)

stream = bus.subscribe()                              # :107
task = asyncio.create_task(_run())                    # :108
async for event in stream:                            # :110 把事件一个一个吐出去
    yield event
await task
await self._publish_completion(context, cap_name)     # :114 发完成事件
```

这里有个**精巧的设计**：`capability.run(context, bus)` 在后台跑，而 `handle` 在前台"边等边吐事件"。能力内部往 `bus` 里塞事件，`handle` 就一个一个 `yield` 给上层（WebSocket 或 CLI）。这就是"一边算、一边把字推到屏幕"的实现机制。

---

## 17.5 能力层：capability.run

`capability.run(context, bus)` 是具体能力的入口。以默认的 **chat** 为例，`deeptutor/agents/chat/capability.py:25`：

```python
async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
    pipeline = AgenticChatPipeline(language=context.language)
    await pipeline.run(context, stream)
```

chat 这边走的是自己的 `AgentLoop`（`deeptutor/core/agentic/loop.py:171` 定义类，`:196` 是 `run` 方法），它内部实现了一套与 `loop.py` 同构的标签驱动迭代。

而**问题 / 研究 / 解题**等能力（`deeptutor/agents/research/pipeline.py`）则直接调用**共享引擎** `run_agentic_loop`（`deeptutor/core/agentic/loop.py:173`）。例如问题能力的探索阶段：

```python
outcome = await run_agentic_loop(                       # question/deeptutor/agents/question/pipeline.py:664
    initial_messages=messages,
    protocol=_PROTOCOL_EXPLORE,
    client=client,
    model=model,
    ...
    host=host,
    max_iterations=max_iter,
)
```

> **提示 · chat 为什么有自己的循环，还要共享引擎？**
>
> 早期 chat 历史久，有自己一套迭代逻辑；后来团队把"标签驱动循环"抽成了通用引擎 `loop.py`，新问题类能力（question/research/solve）直接复用它。两者**协议思想完全一致**（强制标签、守卫、违规修复），只是代码归属不同。学原理，吃透 `loop.py` 就够了——它是被设计成"所有能力共享"的那一个。

---

## 17.6 十步全景图

把上面所有环节拼成一条**从用户输入到进入循环**的 10 步链路：

```text
[1] 你在网页输入框敲字，回车
        │  (WebSocket 长连接)
        ▼
[2] deeptutor/api/routers/unified_ws.py:45  unified_websocket 收到 type=message
        │
        ▼
[3] deeptutor/api/routers/unified_ws.py:114 分发到 runtime.start_turn(msg)
        │
        ▼
[4] deeptutor/services/session/turn_runtime.py:682  start_turn：校验/补默认/套白名单
        │
        ▼
[5] deeptutor/services/session/turn_runtime.py:844  create_turn 开一张轮次工单
        │
        ▼
[6] deeptutor/services/session/turn_runtime.py:873  create_task(_run_turn) 后台起任务
        │
        ▼
[7] deeptutor/services/session/turn_runtime.py:1654  _run_turn 组装 UnifiedContext
        │
        ▼
[8] deeptutor/runtime/orchestrator.py:26/36  ChatOrchestrator.handle(context)
        │  路由：cap_name = active_capability or "chat"  (deeptutor/runtime/orchestrator.py:46)
        ▼
[9] deeptutor/runtime/orchestrator.py:86  capability.run(context, bus)
        │  ├─ chat → AgentLoop.run          (agent_deeptutor/core/agentic/loop.py:196)
        │  └─ question/research → run_agentic_loop  (deeptutor/core/agentic/loop.py:173)
        ▼
[10] 进入标签驱动循环：模型每轮先吐 LABEL，再吐正文
        │   (run_labeled_step: deeptutor/core/agentic/labeled_step.py:104)
        ▼
    模型开始思考 / 调工具 / 收尾 …… 事件经 bus 流回前端
```

每一步都对应一个真实 `文件:行号`，你可以用编辑器跳过去核实。

---

## 17.7 这条链上每个角色的"职责卡"

| 环节 | 文件:行号 | 一句话职责 |
|------|-----------|-----------|
| WebSocket 端点 | `deeptutor/api/routers/unified_ws.py:45` | 收前端消息、按 type 分发 |
| 开跑入口 | `deeptutor/services/session/turn_runtime.py:682` | 校验请求、建轮次、起后台任务 |
| 上下文装配 | `deeptutor/services/session/turn_runtime.py:1654` | 把请求拼成 `UnifiedContext` |
| 路由中枢 | `deeptutor/runtime/orchestrator.py:26/36` | 选能力、把事件流式吐出 |
| 能力入口 | `deeptutor/agents/chat/capability.py:25` | 进入具体能力（chat 等） |
| 共享循环引擎 | `deeptutor/core/agentic/loop.py:173` | 标签驱动迭代（question/research/solve） |
| chat 自有循环 | `agent_deeptutor/core/agentic/loop.py:171` | chat 的标签驱动迭代 |
| 单次 LLM 调用 | `deeptutor/core/agentic/labeled_step.py:104` | 探测标签 + 流式收字 |

> **注意 · 别在错误的地方找"循环"**
>
> 新手最常犯的错误：在 `chat/capability.py` 里找 `run_agentic_loop`，找不到就以为"循环不存在"。其实 **chat 用自己的 `AgentLoop`**，而**共享引擎在 `core/agentic/loop.py`**。`loop.py` 才是第 18 章要重点拆的"灵魂"。记住：能力层只是"积木"，循环引擎在更底层。

---

## 17.8 小实验：在链路每个环节都打一个日志

想亲眼确认这条链？在以上每个 `文件:行号` 处加一行：

```python
import logging
logging.getLogger(__name__).warning("REACHED step N: <描述>")
```

然后 `deeptutor start --dev`，在网页发一句"你好"。你会看到日志从 `[2]` WebSocket 一路打到 `[10]` 循环——证明你真的把整条调用链走通了。

---

## 17.9 session_id 与 turn_id：贯穿全链的"身份证"

前面反复出现 `session_id` 和 `turn_id`，这里讲清它们怎么一路传下去，因为第 20 章的事件流全靠它们定位。

- **session_id**（会话）：一整个对话的 ID。`handle` 在 `deeptutor/runtime/orchestrator.py:43` 里"没有就现场造一个"：
  ```python
  if not context.session_id:
      context.session_id = str(uuid.uuid4())        # deeptutor/runtime/orchestrator.py:43
  ```
  之后它被写进每一个 `StreamEvent` 的 `session_id` 字段（`deeptutor/core/stream.py:56`），前端据此把事件归到正确的会话。
- **turn_id**（轮次）：一次"用户发一句 → 模型答完"的 ID。`start_turn` 通过 `create_turn`（`deeptutor/services/session/turn_runtime.py:844`）生成，存进 `context.metadata["turn_id"]`（`deeptutor/runtime/orchestrator.py:74` 读取）。它更重要的用途是**注册到全局 bus 表**（第 20 章）：`deeptutor/runtime/orchestrator.py:78`–`81` 用 `turn_id` 调 `register_bus`，这样前端发 `user_input` 时能靠 `turn_id` 找回那一轮的 `StreamBus`（`deeptutor/api/routers/unified_ws.py:304`）。

把这两个 ID 的流向画出来：

```text
start_turn (deeptutor/services/session/turn_runtime.py:682)
   │   create_turn → 生成 turn_id            (:844)
   │   session 已存在则沿用 session_id
   ▼
_run_turn (deeptutor/services/session/turn_runtime.py:1654)
   │   UnifiedContext(session_id=..., metadata={turn_id:...})
   ▼
ChatOrchestrator.handle (deeptutor/runtime/orchestrator.py:43/74)
   │   context.session_id 读写；context.metadata["turn_id"] 读取
   │   register_bus(turn_id, bus)               (:81)
   ▼
   每个 StreamEvent 都带 session_id + turn_id  (deeptutor/core/stream.py:56/57)
        │
        ▼
   前端按 session_id 归会话；按 turn_id 续接/重放
```

> **说明 · 为什么需要两层 ID？**
>
> 一个 session 里可以有多轮 turn（你连续问好几句）。只有 `session_id` 没法区分"这是第几轮的回答"；只有 `turn_id` 又没法把多轮串成一个会话。两者配合，前端既能"按会话显示历史"，又能"对某一轮断线重连"。这是多轮对话系统的基本功。

---

## 17.10 排错：链路卡住时查哪里

如果发消息没反应，按这张表从外往里查：

| 现象 | 优先查的环节 | 行号 |
|------|--------------|------|
| 前端连不上 | WebSocket 端点 / 端口映射 | `deeptutor/api/routers/unified_ws.py:45`、`README.md:318` |
| 收到 `Unknown capability` 错误 | 能力名拼写 / 注册表 | `deeptutor/runtime/orchestrator.py:49` |
| 开了轮次但无事件流出 | `_run_turn` 是否真的调了 `handle` | `deeptutor/services/session/turn_runtime.py:1705` |
| 能力跑崩但前端只看到 failed | `handle` 的 `except` 分支 | `deeptutor/runtime/orchestrator.py:87` |
| 模型相关配置错 | `model_catalog.json` / Settings | `README.md:451` |

最稳的调试手法：在 `deeptutor/services/session/turn_runtime.py:1705`（`orch.handle(context)`）和 `deeptutor/core/agentic/loop.py:219`（循环 `for`）各下一个断点。前者命中说明"请求已进编排器"，后者命中说明"已进入智能体循环"——两处之间若断了，问题在能力层或上下文装配。

> **注意 · 别把"慢"当"卡"**
>
> 大模型首 token 往往要等 0.5–3 秒，期间前端可能"看着没动"。第 18 章讲过 `labeled_step.py` 会在首个 token 到达前先开一个"推理中"子卡片（`deeptutor/core/agentic/labeled_step.py:375` 的 `eager_sub_trace`），就是为了消除这段"空窗期"。先看网络面板有没有 pending 的请求，再判断是不是真卡了。

## 17.11 一条命令看清链路

各模块都通过统一的 `StreamBus` 吐事件（`deeptutor/core/stream_bus.py:31`）。想直观看一条请求从进来到进循环，可以在 `deeptutor/services/session/turn_runtime.py:1705` 之前临时加一行日志打印 `context.active_capability`，或在 `deeptutor/core/agentic/loop.py:219` 打印 `iteration` 计数器。每次请求会在终端按时间顺序刷出：

```text
[TurnRuntime] new turn, capability=chat, turn_id=...
[Orchestrator] route -> chat
[Loop] iteration=0, label=ACT
[Loop] iteration=1, label=FINAL
```

> **说明 · 为什么计数器好用**
>
> `run_agentic_loop` 里的循环带一个 `iteration` 计数（`deeptutor/core/agentic/loop.py:219` 的 `for`）。模型每"想一轮"就 +1。正常对话通常 1–3 轮就 `FINAL` 收尾；如果看到它刷到几十轮还在 `ACT`，多半是工具调用死循环或协议被反复修复（`deeptutor/core/agentic/loop.py:375` 的 `_protocol_violation` 触发了重发）。这个计数器是排查"转圈不停"的第一抓手。

---

## 自查清单

- [ ] 我能说出用户请求的两个入口（WebSocket 与 CLI）分别在哪里接收
- [ ] 我知道无论哪条入口，最终都汇合到 `deeptutor/services/session/turn_runtime.py:682` 的 `start_turn`
- [ ] 我能解释 `asyncio.create_task` 在 `deeptutor/services/session/turn_runtime.py:873` 的作用：后台起任务、不阻塞返回
- [ ] 我知道 `ChatOrchestrator.handle` 在 `deeptutor/runtime/orchestrator.py:46` 用 `active_capability or "chat"` 决定走哪个能力
- [ ] 我能区分 chat 走 `AgentLoop`（`agent_deeptutor/core/agentic/loop.py:171`）与其他能力走共享 `run_agentic_loop`（`deeptutor/core/agentic/loop.py:173`）
- [ ] 我能默画"10 步链路图"的前 5 步（网页→WS→start_turn→create_turn→_run_turn）
- [ ] 我知道 `deeptutor/runtime/orchestrator.py:86` 的 `capability.run(context, bus)` 是进入具体能力的地方
- [ ] 我理解为什么"边算边推字"靠的是 `handle` 在前台 `yield`、能力在后台往 `bus` 塞事件
