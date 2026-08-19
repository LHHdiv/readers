---
title: "第 20 章 · 事件流 event stream 与流式回屏幕"
date: 2026-08-01
summary: "弄懂 DeepTutor 在\"算的时候\"是怎么把每一个进展（思考、调工具、出正文）**实时送到你屏幕上**的。核心是两个部件：`StreamBus`（进程内的事件广播站）和 `StreamEvent`（每个事件的标准信封）。读完你能画出\"一个 emit 怎样同时喂给多个订阅者\"，以及 WebSocket 怎样把这…"
tags:
  - deeptutor
---
# 第 20 章 · 事件流 event stream 与流式回屏幕

> 目标：弄懂 DeepTutor 在"算的时候"是怎么把每一个进展（思考、调工具、出正文）**实时送到你屏幕上**的。核心是两个部件：`StreamBus`（进程内的事件广播站）和 `StreamEvent`（每个事件的标准信封）。读完你能画出"一个 emit 怎样同时喂给多个订阅者"，以及 WebSocket 怎样把这些事件推到前端。

黑话定义：**事件流（event stream）**就是"把程序运行过程中的每一步，打包成一个个小事件，按顺序流出去"。不是等全部算完再给结果，而是**边发生边广播**。`StreamBus` 是广播站，`StreamEvent` 是广播里每一句话的标准格式。

---

## 20.1 StreamEvent：每个事件的标准信封

先看法典 `deeptutor/core/stream.py:17`）：

```python
class StreamEventType(str, Enum):
    STAGE_START = "stage_start"
    STAGE_END = "stage_end"
    THINKING = "thinking"
    OBSERVATION = "observation"
    CONTENT = "content"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    PROGRESS = "progress"
    SOURCES = "sources"
    RESULT = "result"
    ERROR = "error"
    SESSION = "session"
    SESSION_META = "session_meta"
    DONE = "done"
    WAIT_FOR_INPUT = "wait_for_input"
```

每个具体事件是一个 `StreamEvent` 数据类（`deeptutor/core/stream.py:51`–`59`）：

```python
@dataclass
class StreamEvent:
    type: StreamEventType           # :51 语义类型（THINKING / CONTENT / TOOL_CALL…）
    source: str = ""                # :52 谁产生的（哪个能力/工具，如 "deep_solve"）
    stage: str = ""                 # :53 在该来源内部的当前阶段（如 "planning"）
    content: str = ""               # :54 人类可读的文本负载
    metadata: dict[str, Any] = ...  # :55 结构化数据（工具参数、来源、指标…）
    session_id: str = ""            # :56 会话 ID
    turn_id: str = ""               # :57 轮次 ID
    seq: int = 0                    # :58 序号
    timestamp: float = ...          # :59 创建时的 Unix 时间戳
```

### 信封字段对照表

| 字段 | 行号 | 装什么 | 例子 |
|------|------|--------|------|
| `type` | `:51` | 事件种类 | `content` / `tool_call` |
| `source` | `:52` | 生产者 | `chat` / `rag` |
| `stage` | `:53` | 阶段 | `reasoning` |
| `content` | `:54` | 文字 | "正在检索…" |
| `metadata` | `:55` | 结构化附加 | `{"args": {...}}` |
| `session_id`/`turn_id` | `:56`/`:57` | 归属 | 用于前端定位某轮 |
| `seq` | `:58` | 序号 | 保证顺序 |

它还有一个 `to_dict()`（`deeptutor/core/stream.py:61`）把所有字段序列化成字典，方便后面转 JSON 推向前端或写成 NDJSON 日志。

> **提示 · 为什么需要统一信封？**
>
> 没有统一格式，每个工具想怎么发就怎么发，前端要写一堆 `if` 去适配。有了 `StreamEvent`，**所有生产者（工具、能力、插件）都说同一种"事件语言"**，前端只认 `type` + `content` + `metadata` 三样，就能渲染一切。这是"协议化"的好处。

---

## 20.2 StreamBus：进程内的"广播站"（fan-out）

`StreamBus` 定义在 `deeptutor/core/stream_bus.py:35`）：

```python
class StreamBus:
    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[StreamEvent | None]] = []   # :35 订阅者队列
        self._closed = False
        self._history: list[StreamEvent] = []                            # :37 历史事件（供重放）
        self._input_listeners: list[asyncio.Queue[str]] = []             # :38 等待用户输入的队列
```

### emit：一次发射，全员接收（fan-out）

`emit`（`deeptutor/core/stream_bus.py:40`）就是把事件**同时塞进每个订阅者的队列**：

```python
async def emit(self, event: StreamEvent) -> None:
    if self._closed:
        return
    self._history.append(event)                  # :44 先存进历史
    for q in self._subscribers:                  # :45 遍历所有订阅者
        await q.put(event)                       # :46 每个队列都放一份
```

黑话 **fan-out（扇出）** 就是"一个输入，分发给多个消费者"。一次 `emit`，N 个订阅者各自收到一份——CLI 渲染器、WebSocket 推送器、JSON 记录器，可以同时都在听。

### subscribe：新订阅者还能"补看历史"

`subscribe`（`deeptutor/core/stream_bus.py:48`）更妙：它先**重放已经发出的历史事件**，再接上实时队列：

```python
async def subscribe(self) -> AsyncIterator[StreamEvent]:
    q: asyncio.Queue[...] = asyncio.Queue()
    self._subscribers.append(q)                  # :51 注册自己
    replay_count = len(self._history)            # :56 记下当前历史长度
    try:
        for event in self._history[:replay_count]:
            yield event                           # :58-59 先补看已发生事件
        if self._closed and q.empty():
            return
        while True:
            event = await q.get()                # :63 再收实时事件
            if event is None:
                break
            yield event
    finally:
        self._subscribers.remove(q)              # :68 退订时移除
```

这个"先重放、后实时"的设计，是**断线重连**的物理基础：用户在 WS 中途掉线，重连后 `subscribe_turn(after_seq=...)` 能从历史补起，不丢事件（见 20.4）。

### close：广播结束信号

`close`（`deeptutor/core/stream_bus.py:70`）给每个队列塞一个 `None`，订阅者读到 `None` 就知道"流结束了"：

```python
async def close(self) -> None:
    self._closed = True
    for q in self._subscribers:
        await q.put(None)                        # :74 每个队列发终止符
```

### fan-out 一图流

```text
能力内部调用：  await bus.content("正在检索…")
                        │
                        ▼  emit (deeptutor/core/stream_bus.py:40)
            ┌───────────┴───────────────┐
            │  self._subscribers 列表     │
            │  [ Queue_A, Queue_B, Queue_C ]   (deeptutor/core/stream_bus.py:35)
            └───────────┬───────────────┘
        ┌───────────────┼───────────────────┐
        ▼               ▼                   ▼
   Queue_A          Queue_B             Queue_C
        │               │                   │
        ▼               ▼                   ▼
  订阅者1：        订阅者2：            订阅者3：
  CLI 渲染器     WebSocket 推送器    JSON 记录器
  （终端显示）   （推前端）          （写日志/持久化）
```

> **说明 · 为什么用队列而不是回调？**
>
> 回调（callback）会让生产者直接调用消费者，耦合紧、易死锁。队列（Queue）把"生产"和"消费"解耦：能力只管 `emit`，至于谁在听、听的人慢不慢，都不影响它。这正是第 17、19 章"边算边推字"能顺畅工作的底层机制。

---

## 20.3 便捷发射方法：让生产者少写样板

`StreamBus` 给每种事件类型都提供了**便捷方法**，生产者不用每次手搓 `StreamEvent`。例如 `content`（`deeptutor/core/stream_bus.py:106`）、`thinking`（`:123`）、`tool_call`（`:157`）、`tool_result`（`:175`）、`progress`（`:193`）、`error`（`:245`）等。

以 `content` 为例（`deeptutor/core/stream_bus.py:106`）：

```python
async def content(self, text, source="", stage="", metadata=None) -> None:
    await self.emit(
        StreamEvent(type=StreamEventType.CONTENT, source=source, stage=stage,
                    content=text, metadata=metadata or {})
    )
```

这些便捷方法本质都是 `emit` 的薄封装，保证所有事件都带齐信封字段。

还有一个特别的方法 **`wait_for_input` / `submit_input`**（`deeptutor/core/stream_bus.py:262` / `:294`），它实现了"模型暂停问用户、用户回答后继续"的闭环：

```python
async def wait_for_input(self, prompt, source="", stage="", timeout=None) -> str:
    await self.emit(StreamEvent(type=StreamEventType.WAIT_FOR_INPUT, ...))   # :276
    input_queue: asyncio.Queue[str] = asyncio.Queue()
    self._input_listeners.append(input_queue)                               # :285
    try:
        return await asyncio.wait_for(input_queue.get(), timeout=timeout)   # :287
    ...

def submit_input(self, content: str) -> None:                               # :294
    for q in self._input_listeners:
        q.put_nowait(content)                                              # :297
    self._input_listeners.clear()
```

---

## 20.4 WebSocket 路由：把事件推到前端

回到第 17 章的入口 `unified_ws.py`。当用户发 `message`，后端 `start_turn` 开跑后，WS 会**立刻订阅这一轮的事件流**（`deeptutor/api/routers/unified_ws.py:80`–`89`）：

```python
async def subscribe_turn(turn_id: str, after_seq: int = 0) -> None:
    from deeptutor.services.session import get_turn_runtime_manager
    async def _forward() -> None:
        runtime = get_turn_runtime_manager()
        async for event in runtime.subscribe_turn(turn_id, after_seq=after_seq):
            await safe_send(event)                       # :86 把事件推给前端
    await stop_subscription(turn_id)
    subscription_tasks[turn_id] = asyncio.create_task(_forward())
```

`_forward` 里那个 `async for event in runtime.subscribe_turn(...)` 拿到的，正是第 19 章 `ChatOrchestrator.handle` 通过 `bus.subscribe()` 吐出的 `StreamEvent`；`safe_send`（`deeptutor/api/routers/unified_ws.py:58`）把它 `json.dumps` 后 `ws.send_text` 推到浏览器。

### 用户的回答怎么回流

当模型用 `bus.wait_for_input` 暂停问用户（如 `ask_user` 工具），前端把答案作为 `user_input` 消息发回（`deeptutor/api/routers/unified_ws.py:297`）：

```python
if msg_type == "user_input":
    turn_id = str(msg.get("turn_id") or "").strip()
    ...
    from deeptutor.core.stream_bus import get_bus
    bus = get_bus(turn_id)                            # :304 按 turn_id 找到那一轮的 bus
    if bus is None:
        ...
    bus.submit_input(str(msg.get("content") or ""))   # :310 喂回 bus，唤醒 wait_for_input
    continue
```

这里用到了 `deeptutor/core/stream_bus.py:313` 的 `register_bus` / `:323` 的 `get_bus`——编排器在 `handle` 里（`deeptutor/runtime/orchestrator.py:78`–`81`）为这一轮注册了 bus，前端才能靠 `turn_id` 精准找到它并喂回答案。

### 前端接收一图流

```text
后端能力：bus.content("答案是…")   emit (deeptutor/core/stream_bus.py:40)
        │
        ▼
ChatOrchestrator.handle: async for event → yield   (deeptutor/runtime/orchestrator.py:110)
        │
        ▼
TurnRuntimeManager._run_turn 把事件持久化 + 转发
        │
        ▼
unified_ws subscribe_turn._forward: safe_send(event)  (deeptutor/api/routers/unified_ws.py:86)
        │  json.dumps → ws.send_text
        ▼
浏览器收到 JSON 事件 → 按 type 渲染（正文气泡 / 工具卡片 / 思考动画）
```

> **说明 · "一次发一行"就是 NDJSON**
>
> `StreamEvent.to_dict()` 转成的字典，经 `json.dumps` 就是一行 JSON。CLI 的 `--format json` 模式（见 `README.md:717` 的 NDJSON 说明）也是这样：每个事件一行，机器可读。这就是"流式"在传输层的样子——不必等全部完成，来一个推一个。

---

## 20.5 与 Pi 类 agent 事件流的异同（概念对照）

很多现代智能体框架（如以"事件流驱动的 agent CLI"为代表的 Pi 类工具）也采用"统一事件 + 流式输出"的设计。和 DeepTutor 对照：

### 相同点

1. **统一事件信封**：都用一个结构化事件（类型 + 负载 + 元数据）代替"直接吐字符串"。DeepTutor 是 `StreamEvent`（`deeptutor/core/stream.py:37`），Pi 类工具通常也是 `type` + `data` 的 JSON 事件。
2. **流式而非批式**：都不是"算完才给"，而是边发生边推（思考、工具调用、结果逐步可见）。
3. **可重放/可持久化**：都支持把事件序列存下来，供回放或审计。

### 不同点

| 维度 | DeepTutor 的 StreamBus | 一般 Pi 类 agent 事件流 |
|------|------------------------|--------------------------|
| 物理位置 | **进程内**的 asyncio 队列 fan-out（`deeptutor/core/stream_bus.py:35`） | 常是**跨进程/跨网络**的 stdout JSON 流或 gRPC |
| 多消费者模型 | 一个 bus 多个 `Queue` 订阅者，且**新订阅者能重放历史**（`deeptutor/core/stream_bus.py:48`） | 多为"单一消费者"的管道，重连靠外部重放 |
| 用户输入回流 | 内置 `wait_for_input`/`submit_input` + `turn_id` 注册表（`deeptutor/core/stream_bus.py:262`/`:313`） | 多靠外部 TTY / 交互外壳注入，无内建回合路由 |
| 与能力解耦 | 事件格式和"标签驱动循环"正交，所有能力共用（`loop.py`） | 事件流常和特定 agent 运行时强绑定 |

> **提示 · 一句话总结差异**
>
> Pi 类工具的事件流像是"**音箱对外广播**"——主要给终端用户听；DeepTutor 的 `StreamBus` 更像是"**内部交换机**"——既喂前端，也喂 CLI、JSON 记录器，还支持断线重连重放和用户答案回流，因为它要同时服务网页、命令行、SDK 多种消费者。

---

## 20.6 三章收尾：事件流是"灵魂循环"的嘴巴

回看第 18 章的标签驱动循环：模型每轮吐出 `THINK`/`TOOL`/`FINISH`，循环据此分支；而**每一步进展都通过 `bus.emit(StreamEvent(...))` 说出去**——思考进 `thinking` 事件、工具进 `tool_call`/`tool_result`、正文进 `content`、结束进 `DONE`。

也就是说：

```text
标签驱动循环（第18章：大脑怎么想）
        │  每步都 bus.emit(...)
        ▼
StreamBus（本章：嘴巴怎么说）            UnifiedContext（第19章：带什么行李）
        │  fan-out 一次发射、多个订阅者
        ▼
WebSocket 推送 → 浏览器实时渲染
```

**没有事件流，再聪明的循环用户也看不见**。事件流是把"内部智能"翻译成"用户能感知的界面"的那根管道。

---

## 20.7 事件类型速查表（全部 15 种）

把 `deeptutor/core/stream.py:17` 的枚举逐条配上"它什么时候出现、前端怎么用"，方便你对照：

| 类型 | 行号 | 触发场景 | 前端常见渲染 |
|------|------|----------|--------------|
| `stage_start` / `stage_end` | `:20`/`:21` | 进入 / 离开一个阶段 | 阶段进度条的开合 |
| `thinking` | `:22` | 模型思考片段（如 `THINK` 标签正文） | 灰色"推理中"卡片 |
| `observation` | `:23` | 观察到的中间事实 | 观察记录行 |
| `content` | `:24` | 最终正文片段（如 `FINISH`） | 主回答气泡 |
| `tool_call` | `:25` | 模型发起工具调用 | 工具调用卡片（含参数） |
| `tool_result` | `:26` | 工具返回结果 | 工具结果展开区 |
| `progress` | `:27` | 进度 / 状态文本 | 状态行（如"检索中"） |
| `sources` | `:28` | 引用来源列表 | 文末"参考来源" |
| `result` | `:29` | 结构化结果数据 | 结果面板 |
| `error` | `:30` | 出错 | 红色错误提示 |
| `session` | `:31` | 会话级通知（含 session_id/turn_id） | 初始化握手 |
| `session_meta` | `:32` | 会话元数据 | 元信息更新 |
| `done` | `:33` | 本轮结束 | 收尾、允许输入 |
| `wait_for_input` | `:34` | 模型暂停问用户（如 `ask_user`） | 弹出问答卡片 |

> 这 15 种就是 DeepTutor "事件语言"的全部词汇。凡是能力、工具、插件想让前端看见的，都归到这 15 类之一——这就是为什么前端不需要为每种能力写定制逻辑。

> **说明 · 怎么快速看真实事件？**
>
> 跑 `deeptutor run chat "你好" --format json`（`README.md:717` 提到的 NDJSON 模式），终端会**每行一个 JSON 事件**原样打印。把这条命令当"事件流显微镜"，你能在不动前端的情况下，看清一次回答里到底 emit 了哪些 `type`、顺序如何。这是学事件流最省事的办法。

---

## 20.8 一个完整事件序列示例

把 20.7 的表格落成一次真实回答的事件流（省略 `timestamp`/`seq` 等字段，聚焦语义）：

```json
{"type":"session","source":"orchestrator","metadata":{"session_id":"sess_1","turn_id":"turn_1"}}
{"type":"thinking","source":"chat","content":"用户问你好，直接问候即可，无需工具。"}
{"type":"content","source":"chat","content":"你好！"}
{"type":"content","source":"chat","content":"我是 DeepTutor，有什么想学的？"}
{"type":"done","source":"chat","metadata":{"status":"completed"}}
```

如果带了一次工具调用，序列会变成：

```json
{"type":"thinking","source":"chat","content":"我需要查知识库。"}
{"type":"tool_call","source":"chat","content":"rag","metadata":{"args":{"query":"傅里叶变换"}}}
{"type":"tool_result","source":"chat","content":"<3 段检索结果…>","metadata":{"tool":"rag"}}
{"type":"thinking","source":"chat","content":"资料够，组织答案。"}
{"type":"content","source":"chat","content":"傅里叶变换是…"}
{"type":"sources","source":"chat","metadata":{"sources":[{"id":"kb_1","title":"…"}]}}
{"type":"done","source":"chat","metadata":{"status":"completed"}}
```

注意事件**顺序天然就是时间顺序**——前端按到达顺序渲染，就自动得到了"先思考、再调工具、出结果、附来源、收尾"的动画效果。这正是"流式"相对于"等全部算完再给"的体验优势。

> **提示 · 事件流里的"空窗"从哪来**
>
> `thinking` 到 `content` 之间可能有几百毫秒的无事件间隙（模型在生成、首 token 未到）。第 18 章讲过 `deeptutor/core/agentic/labeled_step.py:375` 的 `eager_sub_trace` 会在首个 token 前先发一个 `progress(stage=call_status, running)` 事件，让前端提前显示"推理中"，消除这段空窗。事件流和循环是**协同**的：循环负责"早发信号"，bus 负责"准时送达"。

---

## 自查清单

- [ ] 我能列出 `StreamEvent` 的关键信封字段（`type`/`source`/`stage`/`content`/`metadata`），并说出行号（`deeptutor/core/stream.py:51`）
- [ ] 我知道事件类型是个枚举 `StreamEventType`（`deeptutor/core/stream.py:17`），含 `CONTENT`/`TOOL_CALL`/`DONE` 等
- [ ] 我理解 fan-out：一次 `emit`（`deeptutor/core/stream_bus.py:40`）会把事件放进所有订阅者队列（`:45`–`:46`）
- [ ] 我知道 `subscribe`（`deeptutor/core/stream_bus.py:48`）会先重放历史再接实时，这是断线重连的基础
- [ ] 我知道 `close`（`deeptutor/core/stream_bus.py:70`）靠塞 `None` 通知订阅者"流结束"
- [ ] 我能说出 WebSocket 怎样把事件推前端：`subscribe_turn._forward` → `safe_send(event)`（`deeptutor/api/routers/unified_ws.py:86`）
- [ ] 我知道用户回答通过 `user_input` 消息 → `get_bus(turn_id)` → `bus.submit_input` 回流（`deeptutor/api/routers/unified_ws.py:297`/`:310`）
- [ ] 我能对比 DeepTutor StreamBus 与 Pi 类事件流：前者是进程内 fan-out+重放+答案回流，后者多为单一管道
