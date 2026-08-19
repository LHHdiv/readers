---
title: "第 08 章 · 智能体范式：ReAct、Plan-and-Execute、Reflection"
date: 2026-08-01
summary: "把\"智能体到底怎么循环干活\"这件事讲透。三种主流范式各自的思路、优缺点、适用场景，全部用大白话 + ASCII 图说明。最后点明 DeepTutor 选的是第四条路——标签驱动（label-driven），并带你读它的真源码。"
tags:
  - deeptutor
---
# 第 08 章 · 智能体范式：ReAct、Plan-and-Execute、Reflection

> 目标：把"智能体到底怎么循环干活"这件事讲透。三种主流范式各自的思路、优缺点、适用场景，全部用大白话 + ASCII 图说明。最后点明 DeepTutor 选的是第四条路——标签驱动（label-driven），并带你读它的真源码。

---

## 8.1 先想清楚：为什么需要"范式"

第 7 章我们知道了模型可以请求调用工具。但一个真实任务往往需要**很多步**：

```text
用户："帮我看看我上传的论文里，作者用的实验方法有没有明显缺陷。"

需要做的事：
  1. 从知识库里检索"实验方法"相关段落
  2. 读一遍，发现提到了样本量
  3. 再检索"样本量 / 被试人数"
  4. 综合判断
  5. 写出结论
```

问题来了：**谁来决定这 5 步的顺序？什么时候停？中间发现方向错了怎么办？**

这就是"智能体范式"要回答的问题。范式 = **组织多步推理与行动的固定套路**。

> **说明 · 黑话拆解：什么叫"智能体循环"（agent loop）**
>
> 就是一个 `while` 循环。每一圈里：把当前对话历史发给模型 → 模型说话 → 如果它要调工具就执行并把结果加进历史 → 进入下一圈；如果它给出了最终答案，就跳出循环。
> 所有智能体框架，剥开花哨的包装，核心都是这个循环。区别只在于：**循环里让模型输出什么格式、循环怎么判断该停**。

---

## 8.2 范式一：ReAct（推理 + 行动交替）

### 8.2.1 名字的由来

ReAct = **Rea**soning + **Act**ing，出自 2022 年的论文《ReAct: Synergizing Reasoning and Acting in Language Models》（Yao et al., ICLR 2023，[arxiv.org/abs/2210.03629](https://arxiv.org/abs/2210.03629)）。

核心主张一句话：**别让模型只想不做，也别让它只做不想，要一步想一步做。**

### 8.2.2 它长什么样

经典 ReAct 让模型按固定格式输出三段：

```text
Thought:      我需要先知道这篇论文的实验方法是什么
Action:       rag(query="实验方法 experimental design")
Observation:  [程序执行后填入] 检索到：本研究采用双盲随机对照...

Thought:      提到了 32 名被试，样本量可能偏小，我要确认一下
Action:       rag(query="样本量 参与者人数 sample size")
Observation:  [程序执行后填入] 共招募 32 名大学生志愿者...

Thought:      样本量小且全是大学生，外部效度存疑，够写结论了
Action:       Finish
```

`Thought`（想）和 `Action`（做）交替，`Observation`（看到的结果）由程序填入。

### 8.2.3 循环图

```text
        +---------------------------+
        |   把历史发给模型          |
        +-------------+-------------+
                      |
                      v
             +--------+--------+
             | 模型输出         |
             | Thought + Action |
             +--------+--------+
                      |
              Action 是 Finish?
                 /         \
              是             否
              /               \
             v                 v
        +--------+     +----------------+
        | 输出   |     | 执行工具        |
        | 最终   |     | 把 Observation  |
        | 答案   |     | 追加进历史      |
        +--------+     +--------+-------+
                                |
                                +---> 回到顶部
```

### 8.2.4 优缺点

| 方面 | 说明 |
|------|------|
| 优点 | 灵活，能随时根据新信息改方向；实现简单；调试直观（Thought 全看得见） |
| 优点 | 错了能立刻纠正，不会一条道走到黑 |
| 缺点 | **没有全局观**。它只看下一步，可能在局部绕圈子 |
| 缺点 | 长任务容易迷失，忘了最初目标 |
| 缺点 | 每步都要完整重发历史，token 消耗随步数线性增长 |

ReAct 适合：**步数不太多（3～10 步）、路径不确定、需要边看边调整**的任务。绝大多数聊天型智能体用的都是它。

---

## 8.3 范式二：Plan-and-Execute（先规划，再执行）

### 8.3.1 思路

先让模型（或一个专门的"规划器"）把整个任务拆成一份**计划清单**，然后逐项执行。类似人做项目：先列 to-do list，再一条条打勾。

### 8.3.2 它长什么样

```text
== 规划阶段（调用模型 1 次）==
PLAN:
  1. 检索论文的实验方法章节
  2. 检索样本量与被试构成
  3. 检索统计方法与显著性检验
  4. 对照方法学常见缺陷清单逐条比对
  5. 汇总成结论

== 执行阶段（逐条跑）==
  [1] 执行 -> 结果A
  [2] 执行 -> 结果B
  [3] 执行 -> 结果C
  [4] 执行 -> 结果D
  [5] 汇总 -> 最终答案
```

### 8.3.3 循环图

```text
   用户请求
      |
      v
 +----------+
 | 规划器    |  一次性产出完整计划
 | (Planner) |
 +----+-----+
      |
      v
  [步骤1][步骤2][步骤3][步骤4][步骤5]
      |     |      |      |      |
      v     v      v      v      v
   执行  执行   执行   执行   执行
      |     |      |      |      |
      +-----+------+------+------+
                   |
                   v
          任何一步严重偏离?
             /        \
           是          否
           /            \
          v              v
     +---------+    +----------+
     | REPLAN  |    | 汇总输出 |
     | 重新规划 |    +----------+
     +----+----+
          |
          +--> 回到规划器
```

### 8.3.4 优缺点

| 方面 | 说明 |
|------|------|
| 优点 | **有全局观**，不会绕圈；步骤可并行；进度可展示给用户（进度条） |
| 优点 | 执行阶段可以用便宜的小模型，只有规划用贵模型，省钱 |
| 缺点 | 计划是"盲拟"的——规划时还没看到任何真实数据，容易脱离实际 |
| 缺点 | 中途发现计划错了，重规划（replan）的成本高 |

Plan-and-Execute 适合：**目标明确、步骤可预见、步数多（10 步以上）**的任务。比如"写一篇结构化报告""批量处理 50 个文件"。

> **提示 · 关键的第三个状态：REPLAN**
>
> 纯 Plan-and-Execute 有个致命弱点：计划定死了。所以工业实现几乎都会加一个 `REPLAN` 出口——执行到一半发现现实和计划不符，允许推翻重来。
> DeepTutor 的 solve 能力就有这个设计。看 `deeptutor/core/agentic/labels.py:9` 的文档注释：
> 
> > Label sets are caller-supplied: chat uses `(FINISH, TOOL, THINK)`, a solve step uses `(THINK, TOOL, FINISH, REPLAN)`, plan uses `(PLAN,)`, etc.
> 
> 注意 solve 的标签集里明确带 `REPLAN`，而 chat 没有。**不同任务用不同的"动作词汇表"，这是很成熟的设计。**

---

## 8.4 范式三：Reflection（自我反思）

### 8.4.1 思路

前两种范式都是"往前走"。Reflection 加了一个**回头看**的环节：产出答案后，让模型（或另一个模型）批判自己的答案，然后据此改进。

灵感来自 Reflexion 论文（Shinn et al., NeurIPS 2023，[arxiv.org/abs/2303.11366](https://arxiv.org/abs/2303.11366)）。

### 8.4.2 它长什么样

```text
第 1 轮  生成：写出对论文方法的批评意见（草稿 v1）
第 2 轮  反思：作为严格的审稿人，指出上面这份批评的问题
              -> "你只说了样本量小，没有说明为什么这会影响
                  结论；也没有提到缺少对照组这个更严重的问题"
第 3 轮  修订：根据反思意见重写（草稿 v2）
第 4 轮  反思：还有问题吗？ -> "可以了"
        输出 v2
```

### 8.4.3 循环图

```text
   任务
    |
    v
 +---------+
 | 生成器   |----> 草稿 v1
 +---------+          |
    ^                 v
    |            +---------+
    |            | 评审器   |  换个角色/换个提示词
    |            | (Critic) |  找茬、打分、列出缺陷
    |            +----+----+
    |                 |
    |            合格? / 达到最大轮数?
    |              /        \
    |            否          是
    |            /            \
    +-----------+              v
     带着批评意见            输出最终版
     重新生成
```

### 8.4.4 优缺点

| 方面 | 说明 |
|------|------|
| 优点 | 质量提升明显，尤其在写作、代码、推理题上 |
| 优点 | 能发现"自己看不见的错"——换个角色提问，模型的注意力会转移 |
| 缺点 | **贵**。每轮反思都是一次完整调用，2～3 轮就是 3～4 倍成本 |
| 缺点 | 可能陷入"反复修改但没变好"，甚至越改越差 |
| 缺点 | 模型对自己的评价不可靠，有时会自信地认可错误答案 |

Reflection 适合：**质量比速度重要、有明确评价标准**的任务。比如生成教学材料、代码、论文摘要。

### 8.4.5 让反思真正有效的两个技巧

1. **换视角，不要只说"检查一下"**。有效的反思提示是"你现在是一位苛刻的期刊审稿人"，无效的是"请检查上面的回答是否正确"。
2. **给它可验证的标尺**。能跑测试就跑测试，能对照 rubric 就对照 rubric。**基于外部反馈的反思远强于纯自省。**

---

## 8.5 三种范式对比

| 维度 | ReAct | Plan-and-Execute | Reflection |
|------|-------|------------------|------------|
| 核心动作 | 想一步做一步 | 先列清单再执行 | 做完再回头改 |
| 全局观 | 弱 | 强 | 中 |
| 灵活性 | 强 | 弱（除非 replan） | 中 |
| token 成本 | 中 | 中低（执行可用小模型） | 高 |
| 适合步数 | 3～10 | 10+ | 1～3 轮迭代 |
| 典型场景 | 对话助手、检索问答 | 报告生成、批处理 | 写作、代码、解题 |
| 主要风险 | 局部绕圈 | 计划脱离实际 | 烧钱、原地打转 |

> **注意 · 现实中没有纯粹的单一范式**
>
> 真实产品几乎都是混合体。典型组合：外层 Plan-and-Execute 给全局节奏，每个步骤内部跑 ReAct 小循环，关键产出前加一次 Reflection。
> 所以你的目标不是"选一个范式"，而是**理解每种范式解决的具体痛点**，然后按需组装。

---

## 8.6 DeepTutor 的选择：标签驱动（label-driven）

### 8.6.1 它是什么

DeepTutor 走了第四条路——**和 ReAct 同源，但把"这一轮我要干什么"强制成一个必须出现在首行的大写标签**。

看 `deeptutor/core/agentic/labels.py:3` 的模块文档：

> The agentic engine drives LLM calls with a `` ``LABEL`` ``+content protocol: prompts require one allowed label, double-backtick-wrapped, on the first line of every reply, then the rest of the content.

翻译：每一轮回复的**第一行必须是一个用双反引号包起来的标签**，比如：

```text
``TOOL``
我需要先检索一下这篇论文的实验方法。
```

或者：

```text
``FINISH``
这篇论文的实验方法主要有两个问题：第一……
```

### 8.6.2 为什么这样设计（对比 ReAct）

ReAct 的 `Thought:` / `Action:` 也是格式约定，但有两个实际问题：

1. **解析要等**。你得等模型输出到 `Action:` 那一行才知道它要干什么。而在**流式输出**场景下，你希望第一个字出来就知道该往哪个 UI 通道路由。
2. **格式不统一**。不同能力（聊天、解题、规划）需要的动作集不同，硬套一套 Thought/Action 很别扭。

标签驱动的解法：

- **标签在第一行** → 一旦读到标签就能立刻决定路由，剩下的内容边流边转发。这对做"打字机效果"至关重要。
- **标签集可配置** → 每个能力自定义自己的动作词汇表。

第二点在 `labels.py:9` 写得很清楚：

```text
Label sets are caller-supplied: chat uses ``(FINISH, TOOL, THINK)``, a solve
step uses ``(THINK, TOOL, FINISH, REPLAN)``, plan uses ``(PLAN,)``, etc.
```

### 8.6.3 标签的语义定义

标签集的结构定义在 `deeptutor/core/agentic/loop.py:39`：

```py
@dataclass(frozen=True)
class LabelProtocol:
    """Declarative description of a capability's label vocabulary.

    * ``allowed``      — every label the LLM may emit on the first line.
    * ``terminal``     — labels that exit the loop. ...
    * ``intermediate`` — labels that keep the loop running ...
    * ``final``        — labels whose post-label text should be emitted as
      body content via the host's ``emit_final``. ...
    * ``tool_label``   — the single label that means "call tools this
      round" (or ``None`` to disable native tool calling for this loop).
    """

    allowed: tuple[str, ...]
    terminal: frozenset[str]
    intermediate: frozenset[str]
    final: frozenset[str]
    tool_label: str | None
```

五个集合，把一个标签的三种正交属性拆开了：

- **能不能出现**（`allowed`）
- **出现后循环停不停**（`terminal` vs `intermediate`）
- **文字要不要给用户看**（`final`）

注释里举了个精妙的例子（`loop.py:47`）：

> a terminal label may opt out of body emission (e.g. `REPLAN` bubbles up text without streaming), and an intermediate label may opt **in** to body emission so its text appears in the user-facing chat bubble while the loop continues (e.g. chat's `PAUSE` — narrate to the user mid-reasoning without ending the turn).

也就是说：
- `REPLAN` 会终止循环，但文字**不给用户看**（那是给上层调度器的）。
- `PAUSE` 不终止循环，但文字**要给用户看**（AI 中途跟你说一句"我先查一下资料"）。

**把"停不停"和"看不看得见"解耦，是这个设计最漂亮的地方。**

### 8.6.4 标签解析：一个充满现实妥协的函数

理论上模型总会老老实实输出 ` ``TOOL`` `。现实中不会。`labels.py:34` 的 `classify_label` 就是专门处理这些不听话的情况：

```py
def classify_label(
    buffer: str,
    *,
    allowed_labels: tuple[str, ...],
    final: bool = False,
) -> tuple[str, str] | None:
```

它返回 `(标签, 标签后面的文字)`，或者 `None`（表示"还不确定，继续等下一个字符块"）。

它容忍的几种模型跑偏：

| 模型实际输出 | 处理 |
|--------------|------|
| ` ``TOOL`` ` | 标准形式，直接匹配（`labels.py:66`） |
| `` `TOOL` `` 或 ```` ```TOOL``` ```` | 反引号数量不对，正则用 `(?P<ticks>`+)` 兼容 |
| `TOOL 我要检索` | 完全没反引号，走 bare-label 兜底（`labels.py:89`） |
| ` ``FINISH``你好` | 标签后没换行直接接正文，也认（`labels.py:57` 注释专门解释了） |
| 开头有零宽字符/空白 | `strip_label_probe_prefix`（`labels.py:24`）先清洗 |
| `FINISHED` | **不认**，因为 bare 形式要求后面跟分隔符，防误判 |

那个 `FINISHED` 的例子特别值得琢磨。源码注释（`labels.py:83`）：

> Bare-label fallback: only when the label is followed by a clear separator so we don't false-positive on a body that happens to start with a token like `FINISHED`.

如果不加这个判断，用户问"实验做完了吗"，模型回答开头是"FINISHED 的实验有三组……"，就会被误判成结束标签。**这就是真实项目里那些看似啰嗦的判断存在的理由。**

### 8.6.5 找不到标签怎么办

`labels.py:17` 定义了两个常量：

```py
LABEL_UNKNOWN = "UNKNOWN"
LABEL_PROBE_MAX_CHARS = 64
```

规则是（`labels.py:47` 注释）：缓冲区超过 64 个字符还没匹配到任何允许的标签，就判定为 `UNKNOWN`。

为什么要有上限？因为不能无限等下去——模型可能压根忘了输出标签。**必须有一个"放弃等待"的阈值**，这是所有流式解析器的通用原则。

然后循环层会做什么？看 `loop.py:251`：

```py
violation = _protocol_violation(step, protocol)
if violation:
    await _emit_retry_notice(...)
    _append_repair_messages(
        messages=messages,
        iteration_text=step.text,
        violation=violation,
        host=host,
    )
    continue
```

**发现协议违规 → 不崩溃、不放弃，而是往对话里追加一条"修复消息"告诉模型哪儿错了，然后 `continue` 重来一轮。** 这是一种非常务实的容错：把模型的失误当成一次可纠正的对话，而不是异常。

### 8.6.6 还有一层防线：正文里的偷跑标签

`labels.py:98` 的 `find_inline_labels` 处理另一种违规：模型在正文中间又来了一个标签。

```py
def find_inline_labels(text: str, *, allowed_labels: tuple[str, ...]) -> list[str]:
    """Return labels that appear inside post-label body text.

    The protocol requires exactly one label per reply (on the first line).
    A second label found at the start of a later body line is a violation
    worth flagging. Mentions inside prose such as "next I should use
    ``TOOL``" are not action labels and must not trigger repair loops.
    """
```

注意最后一句的细腻之处：模型在句子中间**提到** ` ``TOOL`` `（比如"接下来我应该用 TOOL"）不算违规，只有**独占一行开头**的才算。所以正则里用了 `(?m)^[^\S\r\n]*`——必须在行首。

### 8.6.7 标签驱动的完整循环图

```text
                 initial_messages
                        |
                        v
     +------------------------------------------+
     |  for iteration in range(max_iterations):  |  loop.py:219
     +------------------+-----------------------+
                        |
                        v
             guard_context_window()          loop.py:220
             （防止历史撑爆上下文窗口）
                        |
                        v
             run_labeled_step(...)           loop.py:230
                        |
              流式读取，边读边探测标签
                        |
              classify_label()               labels.py:34
                 /            \
          没探到(>64字符)      探到 LABEL
                |                  |
                v                  v
           UNKNOWN            按标签路由后续文字
                |                  |
                +--------+---------+
                         |
                         v
              _protocol_violation()          loop.py:251
                    /         \
                  有违规       正常
                   /             \
                  v               v
        追加修复消息 + continue    label 属于 terminal?
        loop.py:260                  /            \
                |                  是              否
                +<---------+       /                \
                           |      v                  v
                           |  结束循环          执行工具 / 追加中间文字
                           |  返回 LoopOutcome        |
                           |                          v
                           +--------------------------+
```

---

## 8.7 该怎么选

给你一个实用的决策顺序：

1. **先用 ReAct**。90% 的场景够用，实现最简单，出问题最好查。
2. 发现模型**在局部绕圈、忘记全局目标** → 加规划层，升级成 Plan-and-Execute（记得留 `REPLAN` 出口）。
3. 发现**答案质量不稳定、有明显低级错误** → 在输出前加一次 Reflection（注意成本，通常只做 1 轮）。
4. 发现**需要流式 UI、不同能力需要不同动作集** → 考虑标签驱动这类显式协议。
5. 无论选哪种，**都要有轮次上限**（DeepTutor 用 `max_iterations`，见 `loop.py:217` 的 `max_iter = max(1, max_iterations)`）和**协议违规的修复路径**。

> **说明 · 给零基础读者：不要被论文名字吓到**
>
> ReAct、Reflexion 这些名字听起来高深，但你已经看完了它们的全部核心思想——就是"想一步做一步"和"做完回头改"。论文的贡献主要是**证明这样做确实更好**（跑了大量基准测试），而不是发明了什么复杂算法。
> **这个领域的门槛不在数学，在工程细节**：怎么解析不听话的输出、怎么控制成本、怎么防止死循环。这些恰恰是你读源码能学到而读论文学不到的。

---

## 8.8 本章要点回顾

- 智能体范式解决的是"多步任务怎么组织"的问题，本质都是一个带工具执行的 while 循环。
- **ReAct**：想一步做一步，灵活但没全局观，适合 3～10 步的不确定任务。
- **Plan-and-Execute**：先列计划再执行，有全局观但计划可能脱离实际，必须配 `REPLAN` 出口。
- **Reflection**：做完回头批判并改进，质量高但贵，换视角 + 外部反馈才有效。
- 真实产品都是混合范式，理解痛点比选型更重要。
- DeepTutor 用**标签驱动**：首行强制一个大写标签（`labels.py:3`），标签集按能力配置（`labels.py:9`），语义由 `LabelProtocol` 的五个集合描述（`loop.py:39`）。
- 标签驱动相对 ReAct 的优势是**流式友好**（第一行就能路由）和**词汇表可定制**。
- `classify_label`（`labels.py:34`）容忍多种模型格式跑偏，但拒绝 `FINISHED` 这类误匹配（`labels.py:83`）。
- 超过 `LABEL_PROBE_MAX_CHARS`（`labels.py:18`，64 字符）判为 `UNKNOWN`；违规不崩溃，而是追加修复消息重来（`loop.py:260`）。

---

## 自查清单

- [ ] 我能用一句话概括 ReAct、Plan-and-Execute、Reflection 各自的核心动作。
- [ ] 我能画出 ReAct 的循环图，并说明 `Observation` 是谁填进去的。
- [ ] 我能说出 Plan-and-Execute 的最大风险，以及 `REPLAN` 为什么是必需的。
- [ ] 我能说出为什么"请检查一下"式的反思无效，什么样的反思提示才有效。
- [ ] 我能解释 DeepTutor 的标签驱动和 ReAct 的相同点与不同点，尤其是"为什么标签必须在第一行"。
- [ ] 我能打开 `deeptutor/core/agentic/loop.py:39`，说出 `LabelProtocol` 五个字段各自的含义。
- [ ] 我能解释为什么 `terminal` 和 `final` 要拆成两个独立集合，并举出 `REPLAN` 和 `PAUSE` 两个例子。
- [ ] 我能说出 `classify_label`（`labels.py:34`）为什么不把 `FINISHED` 识别成 `FINISH`。
- [ ] 我能解释 `LABEL_PROBE_MAX_CHARS = 64`（`labels.py:18`）这个上限存在的必要性。
- [ ] 我能说清协议违规时循环的处理方式（`loop.py:251`–`loop.py:266`），以及为什么它比抛异常更好。
