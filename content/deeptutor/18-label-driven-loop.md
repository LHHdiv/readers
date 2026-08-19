---
title: "第 18 章 · 标签驱动 Agent 循环（灵魂）"
date: 2026-08-01
summary: "吃透 DeepTutor 最核心的设计——**强制模型每次回答第一行先写一个 `LABEL`**。这是整个项目的\"灵魂\"。读完你会明白：为什么模型不能想到哪说到哪，而要像铁路信号灯一样先亮一个\"标签\"再行动；以及这个循环到底怎么一圈圈转。"
tags:
  - deeptutor
---
# 第 18 章 · 标签驱动 Agent 循环（灵魂）

> 目标：吃透 DeepTutor 最核心的设计——**强制模型每次回答第一行先写一个 `LABEL`**。这是整个项目的"灵魂"。读完你会明白：为什么模型不能想到哪说到哪，而要像铁路信号灯一样先亮一个"标签"再行动；以及这个循环到底怎么一圈圈转。

黑话先定义：**智能体循环（agentic loop）**就是"让大模型反复调用自己"的引擎：模型想一步、可能调个工具、看结果、再想下一步，直到它觉得说完了。普通循环"想完就停"，DeepTutor 的循环则要求**每一步都先声明自己在干哪类事**。

---

## 18.1 为什么非要模型先吐一个 LABEL？

直觉：如果你让一个人"去把灯修好"，他可能闷头干半天你不知道进度。但如果你要求他**每做一步先喊一句"我在拆螺丝 / 我在换灯泡 / 我干完了"**，你随时能知道他在哪、该不该干预、有没有跑偏。

DeepTutor 对模型就是这么要求的。模块文档 `deeptutor/core/agentic/loop.py:1` 开头就说：循环驱动一次和 LLM 的对话，**直到调用方声明的某个"终止标签"触发为止**。每一次迭代就是一次 `run_labeled_step` 调用，之后循环要：

- 校验协议（只能有一个标签、不能内联重复标签、有工具标签才能带工具）
- 命中终止标签就收尾退出
- 命中工具标签就派发工具调用
- 命中中间标签（如 `THINK`）就把正文留作上下文继续转

### 三个硬理由

1. **过程可视化（看得见心跳）**。因为有标签，前端能把"思考中 / 调工具 / 收尾"做成不同动画卡片。没有标签，模型吐出一大段，你根本分不清哪句是想、哪句是结论。
2. **可靠的状态机（不会乱套）**。标签把"模型当前处于哪种状态"变成了**有限的几个枚举值**（如 `THINK`/`TOOL`/`FINISH`）。循环只需对这几个值做 `if` 判断，逻辑清晰、不会失控。这就是"状态机"——像红绿灯只有红/黄/绿。
3. **协议违规可修复（说错话能拉回来）**。模型偶尔会"忘了写标签"或"一边写标签一边偷偷调工具"。普通设计会直接崩；DeepTutor 把这种错当作**可修复的协议违规**，喂一句纠错提示让它下一轮重来（见 18.5）。

> **提示 · 一句话记住**
>
> LABEL 就是模型的"行车记录仪 + 转向灯"。它不增加智能，但让**过程透明、状态可控、错误可救**。这就是为什么一个教育智能体要强制它——学生（和你）需要看见 AI 是怎么想的。

---

## 18.2 LabelProtocol：一份"标签词汇表"

循环怎么知道哪些标签合法、哪个表示结束？答案是一个叫 `LabelProtocol` 的"声明式描述"（定义于 `deeptutor/core/agentic/loop.py:40`）。黑话**声明式（declarative）**意思是"你只说规则是什么，不用写怎么执行"。

```python
@dataclass(frozen=True)
class LabelProtocol:
    allowed: tuple[str, ...]          # :60  LLM 第一行可能吐出的所有标签
    terminal: frozenset[str]          # :61  能"退出循环"的标签
    intermediate: frozenset[str]      # :62  让循环继续转的标签（正文留作上下文）
    final: frozenset[str]             # :63  其正文要作为正文内容推送给用户
    tool_label: str | None            # :64  表示"这轮要调工具"的那个标签（None=禁用原生工具）
```

### 五组标签各管什么

| 字段 | 行号 | 含义 | 例子 |
|------|------|------|------|
| `allowed` | `loop.py:60` | 模型这一轮**可能**写的所有标签，超出的算违规 | `("THINK","TOOL","FINISH")` |
| `terminal` | `loop.py:61` | 命中即**结束循环**；结果里的 `final_label` 记是哪个触发的 | `FINISH` |
| `intermediate` | `loop.py:62` | 命中后**继续转**，把正文追加为助手上下文 | `THINK` |
| `final` | `loop.py:63` | 命中它的正文要**作为正文推给用户看**（和 terminal/intermediate 正交） | chat 的 `PAUSE` 既是中间又 final |
| `tool_label` | `loop.py:64` | 唯一表示"这轮要调工具"的标签；`None` 则本循环不启用原生工具 | `TOOL` |

> 注意 `final` 是**独立维度**：一个标签可以"是终止标签但不推正文"（比如 `REPLAN` 把文字冒泡上去但不流式显示），也可以"是中间标签但推正文"（chat 的 `PAUSE`——边转边把话念给用户听）。文档 `loop.py:48`–`55` 专门解释了这个正交关系。

不同能力的词汇表不同。文档 `deeptutor/core/agentic/labels.py:9` 明确写道：

```text
Label sets are caller-supplied: chat uses (FINISH, TOOL, THINK), a solve
step uses (THINK, TOOL, FINISH, REPLAN), plan uses (PLAN,), etc.
```

一个真实的词汇表例子在 `deeptutor/agents/question/pipeline.py:98`：

```python
_PROTOCOL_EXPLORE = LabelProtocol(
    allowed=(LABEL_THINK, LABEL_TOOL, LABEL_FINISH),
    terminal=frozenset({LABEL_FINISH}),
    intermediate=frozenset({LABEL_THINK}),
    final=frozenset({LABEL_FINISH}),
    tool_label=LABEL_TOOL,
)
```

---

## 18.3 单次步骤：run_labeled_step 怎么"探测"标签

每一轮循环调用的不是原始 LLM，而是 `run_labeled_step`（定义于 `deeptutor/core/agentic/labeled_step.py:104`）。它做的事很巧妙——**边收模型的字，边从最前面探测 `LABEL``` 前缀**。

它的产出是一个 `LabeledStepResult`（`labeled_step.py:96`）：

```python
@dataclass(frozen=True)
class LabeledStepResult:
    label: str                       # :99  解析出的标签，违规则为 LABEL_UNKNOWN
    text: str                        # :100 标签之后的正文（已清掉 <think> 标记）
    tool_calls: list[dict[str, Any]] = field(default_factory=list)  # :101 累积的工具调用
```

探测逻辑在 `deeptutor/core/agentic/labels.py:34` 的 `classify_label`：它用正则匹配开头是不是 ` ``LABEL`` `（双反引号包裹），并容忍模型偶尔少写/多写反引号的毛病。`loop.py` 的文档 `loop.py:6` 形容它为"解析第一行用于 ` ``LABEL`` ` 前缀"。

> **说明 · 流式探测的意义**
>
> 为什么是"流式探测"而不是"等模型说完再判断"？因为聊天要**实时显示**。探测到 `THINK` 就把后续字流进"思考"卡片；探测到 `FINISH` 就把字流进"正文"气泡。`labeled_step.py:208` 的 `_emit_text` 就按 `label in final_labels` 决定流向哪条通道。这正呼应 18.1 的"过程可视化"。

---

## 18.4 run_agentic_loop：一圈圈怎么转

核心调度器是 `run_agentic_loop`（`deeptutor/core/agentic/loop.py:173`）。它本质是一个 `for iteration in range(max_iter):` 的循环（`loop.py:219`），每轮按固定顺序做五件事。

```python
for iteration in range(max_iter):
    await host.guard_context_window(messages)        # :220 守卫：超长就裁剪
    before_iteration = getattr(host, "before_iteration", None)
    if before_iteration is not None:                 # :221 可选钩子：注入"你已到第 N 轮"
        await before_iteration(messages=messages, iteration=iteration, max_iterations=max_iter)
    iter_meta, final_meta = host.build_iteration_trace_meta(iteration)  # :228 建追踪元数据

    step = await run_labeled_step(...)               # :230 单次步骤：模型吐标签+正文+工具
    iterations_run += 1

    violation = _protocol_violation(step, protocol)  # :251 查协议违规
    if violation:                                    # :252 有违规 → 发重试提示 + 喂纠错
        await _emit_retry_notice(...)
        _append_repair_messages(messages=messages, iteration_text=step.text, violation=violation, host=host)
        continue                                     # :266 重来这一轮

    if step.label in protocol.terminal:              # :268 终止标签
        ...
        if step.label in protocol.final and not stream_body_live:
            await host.emit_final(step.text, final_meta)   # :291 推正文
        final_text = step.text
        final_label_seen = step.label
        completed = True
        break                                         # :295 退出循环

    if protocol.tool_label is not None and step.label == protocol.tool_label:  # :297 工具标签
        messages.append(assistant_message_with_tool_calls(step.text, step.tool_calls))
        outcome = await host.dispatch_tools(iteration=iteration, tool_calls=step.tool_calls)  # :299
        aggregated_sources.extend(outcome.sources)
        messages.extend(outcome.tool_messages)
        if outcome.pause:                             # :305 模型要暂停问用户
            resumed = await host.resolve_pause(outcome)
            if not resumed: completed = False; break
            continue
        if outcome.terminate:                         # :311 工具要求直接结束
            await host.emit_terminator(outcome.terminate_payload)
            ...
            break
        continue

    if step.label in protocol.intermediate:           # :318 中间标签（如 THINK）
        if step.label in protocol.final and step.text and not stream_body_live:
            await host.emit_final(step.text, final_meta)   # :324 中间也能推正文
        if step.text:
            messages.append({"role": "assistant", "content": step.text})  # :327 留作上下文
        on_intermediate = getattr(host, "on_intermediate", None)
        if on_intermediate is not None:
            feedback = await on_intermediate(step.label, step.text)       # :335 副作用钩子
            if feedback:
                messages.append({"role": "user", "content": feedback})
        continue

    # 兜底：任何没覆盖到的标签值 → 当作 unknown_action 修复重试
    await _emit_retry_notice(...)                     # :342
    _append_repair_messages(messages=messages, iteration_text=step.text, violation="unknown_action", host=host)
    continue
else:
    # for 循环正常跑完（预算耗尽仍无终止标签）→ 交给 host 强制收尾
    finish_text, did_finish, extra_calls = await host.force_finalize(     # :357
        messages=messages, start_iteration=max_iter,
    )
    ...
```

### 把五件事画成"双层流转图"

外层是**循环的一圈圈**（时间维度），内层是**一圈里标签的流向**（逻辑维度）：

```text
════════════════ 外层：循环迭代（loop.py:219 for） ════════════════
  iteration 0 ──► iteration 1 ──► iteration 2 ──► ... ──► iteration N
       │                │                │                     │
       │  每轮都走下面的"内层标签流转"                         │
       ▼                ▼                ▼                     ▼
  ┌──────────────────────── 内层：单轮标签流转 ───────────────────────┐
  │                                                                   │
  │   run_labeled_step (loop.py:230)                                  │
  │        │ 模型吐出 step.label + step.text + step.tool_calls        │
  │        ▼                                                         │
  │   _protocol_violation? (loop.py:251)                             │
  │      ├─ 是 → 发重试提示 + 喂纠错 → continue（回到外层下一轮）    │
  │      └─ 否 ↓                                                      │
  │   step.label 属于哪类？                                           │
  │      ├─ terminal (loop.py:268) → emit_final + break（退出外层）  │
  │      ├─ tool_label (loop.py:297) → dispatch_tools + 把结果塞回   │
  │      │                            messages → continue（下一轮）  │
  │      ├─ intermediate (loop.py:318) → 正文留作上下文 → continue   │
  │      └─ 都不属 → unknown_action 修复 → continue                  │
  └───────────────────────────────────────────────────────────────────┘
```

### 一个真实的多轮序列

你问"帮我查傅里叶变换并讲一遍"，循环可能这样转：

```text
[轮0] THINK  "我先去知识库检索一下"        → intermediate，留作上下文
[轮1] TOOL   rag(query="傅里叶变换")        → dispatch_tools 执行检索
       ↳ 工具返回 3 段资料，追加进 messages
[轮2] THINK  "资料够了，我组织一下答案"      → intermediate
[轮3] FINISH "傅里叶变换是把信号从时域…"    → terminal + final，emit_final 推给用户，break
```

> **提示 · 看不懂全貌没关系**
>
> 第一次读 `run_agentic_loop`，只看 `loop.py:268`（终止）、`loop.py:297`（工具）、`loop.py:318`（中间）这三个 `if` 分支，理解"模型吐的标签决定走哪条路"即可。其余细节（守卫、钩子、强制收尾）都是给这条主干打的补丁。

---

## 18.5 LoopHost：能力"注入"能力的桥

你可能会问：循环逻辑写在 `loop.py`，但"调工具具体怎么执行""正文怎么推给用户"——这些明显和能力有关（chat 和研究的工具体系不同）。DeepTutor 的解法是 **`LoopHost` 协议**（`deeptutor/core/agentic/loop.py:79`）：

```python
class LoopHost(Protocol):
    """Capability-supplied hooks the loop calls back into."""   # :79-84

    async def guard_context_window(self, messages): ...         # :86 裁剪超长上下文
    def build_iteration_trace_meta(self, iteration): ...        # :89 建追踪元数据
    async def dispatch_tools(self, *, iteration, tool_calls): ...  # :92 并行派发工具
    async def resolve_pause(self, dispatch): ...                # :100 处理"暂停问用户"
    async def emit_terminator(self, payload): ...              # :103 推终止工具的内容
    async def emit_final(self, text, final_meta): ...           # :106 推正文
    async def validate_terminal(self, label, text): ...         # :109 终止前状态校验
    def protocol_retry_notice(self): ...                        # :117 违规重试提示文案
    def protocol_repair_message(self, violation): ...           # :120 每类违规的纠错提示
    async def force_finalize(self, *, messages, start_iteration): ...  # :123 预算耗尽强制收尾
```

黑话**协议（Protocol）**在这里是 Python 的"结构化回调接口"：循环核心只认这几个方法名，至于 chat 怎么实现 `dispatch_tools`、研究怎么实现，循环**完全不关心**。

这正是文档 `loop.py:19` 说的：守卫、追踪、工具派发、暂停/终止、强制收尾、违规文案——这些"和能力相关的零碎"全部委托给 `LoopHost`，**循环本身保持能力无关（capability-agnostic）**。

> **说明 · 为什么这个桥重要**
>
> 它是"一套引擎、多种能力"的关键。question/research/solve 各自写一份 `LoopHost` 实现，但都复用同一个 `run_agentic_loop`（`loop.py:173`）。新增一个能力，你**几乎不用动循环核心**，只实现 `LoopHost` 那几个方法、声明一份 `LabelProtocol` 就行。这是 DeepTutor 可扩展性的根基。

---

## 18.6 _protocol_violation：四类违规

模型不总是守规矩。循环用 `_protocol_violation`（`deeptutor/core/agentic/loop.py:375`）把"说错话"分类，**返回违规键（或 None 表示合规）**：

```python
def _protocol_violation(step, protocol) -> str | None:
    if step.label == LABEL_UNKNOWN:
        return "missing_label"                         # :382 完全没写标签
    if find_inline_labels(step.text, allowed_labels=protocol.allowed):
        return "multiple_labels"                       # :384 正文里又出现了别的标签
    if protocol.tool_label is not None:
        if step.label == protocol.tool_label and not step.tool_calls:
            return "tool_without_calls"                # :387 写了 TOOL 却没带工具调用
        if step.label != protocol.tool_label and step.tool_calls:
            return f"{step.label.lower()}_with_tools"  # :396 没写工具标签却偷偷调了工具
    return None
```

### 四种违规对照表

| 违规键 | 行号 | 触发条件 | 含义 |
|--------|------|----------|------|
| `missing_label` | `loop.py:382` | `step.label == LABEL_UNKNOWN` | 模型根本没按格式写标签 |
| `multiple_labels` | `loop.py:384` | 正文里又探测到允许的标签 | 一轮里出现了第二个标签（协议要求每轮仅一个） |
| `tool_without_calls` | `loop.py:387` | 写了 `TOOL` 但没有 `tool_calls` | 说要调工具却没给工具参数 |
| `{label}_with_tools` | `loop.py:396` | 没写工具标签却带了 `tool_calls` | 偷偷调工具（如 `think_with_tools`） |

一旦判定违规，循环在 `loop.py:253` 发一条重试提示，并通过 `_append_repair_messages`（`loop.py:419`）把模型那段"没写标签的草稿"保留为助手上下文，再追加一句**纠错提示**让下一轮重来：

```python
def _append_repair_messages(*, messages, iteration_text, violation, host):
    clipped = str(iteration_text or "").strip()
    if clipped:
        messages.append({"role": "assistant", "content": clipped})   # :432 保留草稿
    messages.append({"role": "user", "content": host.protocol_repair_message(violation)})  # :433 纠错
```

这就是 18.1 说的"协议违规可修复"——**模型说错话不会让整轮崩掉，而是被拉回重来一次**。

> **注意 · 修复也有上限**
>
> 循环不是无限重试。`run_agentic_loop` 的 `for` 受 `max_iterations` 限制（`loop.py:217` 的 `max(1, max_iterations)`）。如果模型反复违规把预算耗尽，`else` 分支会调用 `host.force_finalize`（`loop.py:357`）强制收尾，避免死循环。调试时若发现"回答突然截断"，先怀疑是不是撞到了这个上限。

---

## 18.7 一个协议修复小剧场

光讲规则太抽象，看一个真实发生的"模型说错话被拉回"的例子。

**第一轮**：模型忘了写标签，直接输出正文：
```text
傅里叶变换是把信号从时域变到频域的数学工具……
```
`run_labeled_step` 解析不出前缀标签 → `step.label == LABEL_UNKNOWN`（`labels.py:17`）。循环调用 `_protocol_violation`，命中第一条（`loop.py:382`）：
```python
if step.label == LABEL_UNKNOWN:
    return "missing_label"
```
于是循环在 `loop.py:253` 发重试提示，并调用 `_append_repair_messages`（`loop.py:419`）：把这段"没标签的草稿"保留为一条 `assistant` 消息（`:432`），再追加一句**纠错提示**作为 `user` 消息（`:433`）。然后 `continue` 重来这一轮。

**第二轮**：模型这次学乖了，先亮标签：
```text
``THINK`` 我先确认用户想理解直观含义，不从公式堆起……
```
`classify_label`（`labels.py:34`）识别出 `THINK` → 走 `intermediate` 分支（`loop.py:318`），正文留作上下文，循环继续。后续轮可能 `TOOL` 检索、再 `FINISH` 收尾。

整个过程用户在前端**可能只看到一条"格式有误，正在重试"的提示**，然后正常答案就来了——这就是"协议违规可修复"带来的体验：错误被吞掉、自愈，而不是整轮崩溃。

> **提示 · 调试时怎么抓到这种修复**
>
> 在 `loop.py:251`（`violation = _protocol_violation(...)`）下断点。每次 `violation` 不为 `None`，就说明模型刚被纠过一次。反复命中，说明你的 `protocol_repair_message`（`loop.py:120`）文案不够清楚，或模型本身对该协议不适应——这时该调提示词，而不是怪循环。

---

## 18.8 守卫与可选钩子：循环主干之外的"补丁"

`run_agentic_loop` 的五步主干（18.4）之外，还有几个由 `LoopHost` 提供、循环**按需调用**的钩子。它们让循环保持简洁，又把"和能力强相关"的逻辑外置。

### 上下文守卫：guard_context_window

每轮最开头（`loop.py:220`）先调：
```python
await host.guard_context_window(messages)     # loop.py:220
```
对应 `LoopHost.guard_context_window`（`loop.py:86`）。它的活是"**把 messages 裁短，别超出模型上下文窗口**"。模型上下文有长度上限，聊久了历史会爆，这个钩子负责丢旧消息、保新消息。循环核心不关心怎么裁，只负责"每轮开头问一下 host"。

### 迭代前钩子：before_iteration

`before_iteration`（`loop.py:133`，调用处 `:221`–`227`）在守卫之后、LLM 调用之前触发。典型用途：往 `messages` 里塞一句"你已到第 N / M 轮"的小标记，让模型自己控制节奏。循环用 `getattr(host, "before_iteration", None)` 探测能力是否实现了它——没实现就跳过，实现了的才调用（`:222`）。

### 中间标签副作用：on_intermediate

`intermediate` 分支里（`:333`–`:337`）会调 `on_intermediate`：
```python
on_intermediate = getattr(host, "on_intermediate", None)
if on_intermediate is not None:
    feedback = await on_intermediate(step.label, step.text)   # :335
    if feedback:
        messages.append({"role": "user", "content": feedback})
```
这让能力在"中间标签"触发时做点副作用（如研究能力的 `APPEND` 标签往题目队列里加一块），并可返回一个反馈字符串塞回对话，让模型下轮看到"已追加第 4 块"之类的确认。

### 终止前校验：validate_terminal

命中 `terminal` 后、收尾前，循环还会问 host 一句（`:269`–`:286`）：
```python
validate_terminal = getattr(host, "validate_terminal", None)
if validate_terminal is not None:
    violation = await validate_terminal(step.label, step.text)   # :271
    if violation:
        # 当作违规，发提示 + 喂纠错 + continue（重来）
        ...
```
这是"**状态化校验**"：即便标签合法，能力也能再看一眼正文满不满足要求（比如答案里必须含引用），不满足就当违规拉回重来。

> **说明 · 这些钩子的共同设计哲学**
>
> 注意一个反复出现的写法：`getattr(host, "xxx", None)` 然后判空。这意味着**所有钩子对 LoopHost 都是可选的**——能力只实现它关心的，循环用"有没有这个方法"来决定调不调。这正是 `Protocol` 类型相比抽象基类的灵活之处：不强求每个能力都写满所有方法。

---

## 18.9 本章串起来的一句话

`ChatOrchestrator`（第 17 章）把请求路由到某个能力 → 能力声明一份 `LabelProtocol`（18.2）→ 调 `run_agentic_loop`（18.4）一圈圈转 → 每轮用 `run_labeled_step`（18.3）探测模型吐的 `LABEL` → 按标签走终止/工具/中间分支 → 模型说错话就由 `_protocol_violation`（18.6）分类并拉回重来 → 所有"和能力相关的活"都通过 `LoopHost`（18.5）桥接出去。

---

## 自查清单

- [ ] 我能说出强制模型先写 `LABEL` 的三个理由（可视化 / 状态机 / 可修复）
- [ ] 我能列出 `LabelProtocol` 的五字段（`allowed`/`terminal`/`intermediate`/`final`/`tool_label`）并说出各自行号
- [ ] 我理解 `final` 是独立维度：一个标签可以同时是中间标签又推正文（如 `PAUSE`）
- [ ] 我知道单次步骤由 `run_labeled_step`（`labeled_step.py:104`）完成，产出 `LabeledStepResult`（标签/正文/工具）
- [ ] 我能画出"外层迭代 + 内层标签流转"的双层图，并指出 `loop.py:268/297/318` 三个分支
- [ ] 我理解 `LoopHost`（`loop.py:79`）是把"能力相关逻辑"注入通用循环的桥，循环因此能力无关
- [ ] 我能说出 `_protocol_violation`（`loop.py:375`）的四种违规键及各自触发条件
- [ ] 我知道违规后会保留草稿并追加纠错提示（`loop.py:419`），且重试受 `max_iterations` 上限约束
