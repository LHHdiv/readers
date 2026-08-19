---
title: "第 04 章 · 推理模型与思维链（CoT）"
date: 2026-08-01
summary: "讲清楚为什么让模型\"先想再答\"能大幅提高正确率，思维链（CoT）到底是什么，o1/R1 这类\"推理模型\"和普通模型的本质区别在哪，以及为什么它们慢却准。最后看 DeepTutor 如何在源码里同时接住两种截然不同的\"思考流\"。"
tags:
  - deeptutor
---
# 第 04 章 · 推理模型与思维链（CoT）

> 目标：讲清楚为什么让模型"先想再答"能大幅提高正确率，思维链（CoT）到底是什么，o1/R1 这类"推理模型"和普通模型的本质区别在哪，以及为什么它们慢却准。最后看 DeepTutor 如何在源码里同时接住两种截然不同的"思考流"。

## 4.1 从一道小学数学题说起

请看下面两次真实风格的对话。同一个模型，同一道题，只差一句话。

```text
【第一次】
用户: 食堂有 23 个苹果,午餐用掉了 20 个,又买了 6 个。现在有几个?
模型: 27 个。                                      ← 错了

【第二次】
用户: 食堂有 23 个苹果,午餐用掉了 20 个,又买了 6 个。
      现在有几个?请一步一步思考。
模型: 好的,我们一步步来。
      1. 一开始有 23 个苹果。
      2. 午餐用掉 20 个,还剩 23 - 20 = 3 个。
      3. 又买了 6 个,现在是 3 + 6 = 9 个。
      答案是 9 个。                                ← 对了
```

模型没变，参数没变，温度没变。只加了"请一步一步思考"六个字，答案就从错变对。

**为什么？** 要回答这个问题，得回到第 1 章那个本质：模型在做的事是"预测下一个词"。

## 4.2 为什么"想一想"真的有用

### 4.2.1 每个 token 的计算量是固定的

这是理解 CoT 的钥匙。

模型生成每一个 token，走的都是完全相同的一趟计算：过完所有 Transformer 层，输出一个概率分布。**这趟计算的量是固定的，不会因为问题难就自动变多。**

```text
不给思考空间:

  [题目 tokens] ──► 一趟固定计算 ──► "2"
                        ↑
              整道题的加减法必须在这一趟里
              "一次性"算完 —— 层数不够就只能猜


给了思考空间:

  [题目] ──► 计算 ──► "23"
  [题目 23] ──► 计算 ──► "-"
  [题目 23 -] ──► 计算 ──► "20"
  [题目 23-20] ──► 计算 ──► "="
  [题目 23-20=] ──► 计算 ──► "3"        ← 中间结果被写进了上下文
  [... 3] ──► 计算 ──► "+"
  [... 3 +] ──► 计算 ──► "6"
  [... 3+6=] ──► 计算 ──► "9"

  每一步都是一趟完整计算,而且能读到前面步骤的结果
```

**思维链的本质，是把"深度不够"换成"长度足够"。** 模型的层数是固定的（比如 80 层），一个 token 只能过 80 层；但如果它先输出 200 个中间步骤的 token，等效算力就变成了 200 × 80 层。

> **提示 · 一个精确的类比**
>
> 让你**心算** `23 × 47`，你可能算错。给你**草稿纸**，你几乎一定算对。
> 模型的上下文就是它的草稿纸。CoT 就是"允许打草稿"。
> 不让打草稿还要求答对，是在为难它——**这不是它笨，是你没给工作空间。**

### 4.2.2 还有第二个原因：把自己引到对的语料分布上

模型输出 "一步步来：1. 一开始有 23 个苹果" 之后，它接下来面对的上下文，长得非常像训练语料里**数学题详解**的样子。而在那类语料里，下一个 token 通常是正确的推导。

反过来，如果它张口就报一个数字，它的上下文更像"闲聊里随口答题"，那种语料的正确率本身就低。

> 一句话：**CoT 既给了模型更多算力，也把它"引导"到了更靠谱的那片语料分布上去。**

## 4.3 思维链（CoT）的几种玩法

### 4.3.1 Zero-shot CoT：最便宜的一招

就是那句咒语。

```text
在问题末尾加一句:
  "请一步一步思考。"
  "Let's think step by step."
```

2022 年有论文发现，仅这一句就能让某些数学基准的准确率从 17% 跳到 78%。这是提示工程史上性价比最高的发现之一。

### 4.3.2 Few-shot CoT：给它看范例

给几个"带完整推导过程"的例子，模型会模仿这个格式。

```text
问: 停车场有 5 辆车,又开进来 2 辆,一共几辆?
答: 原本 5 辆,开进来 2 辆,5 + 2 = 7。答案是 7。

问: 小红有 8 支笔,送给同学 3 支,还剩几支?
答: 原本 8 支,送出 3 支,8 - 3 = 5。答案是 5。

问: 书架上有 15 本书,拿走 6 本,又放回 4 本,现在几本?
答: ← 模型会自动模仿上面的推导格式
```

比 zero-shot 更稳，代价是每次请求都要多花几百个 token。

### 4.3.3 Self-Consistency：多想几遍投票

同一道题让模型用较高 temperature 生成 5 条不同的推理路径，然后对最终答案投票。

```text
路径 1: ... → 答案 9
路径 2: ... → 答案 9
路径 3: ... → 答案 7    (中间算错了一步)
路径 4: ... → 答案 9
路径 5: ... → 答案 9
                ↓
        投票: 9 得 4 票 → 输出 9
```

道理很朴素：**错误是随机的，正确是收敛的。** 五条路错的地方各不相同，但对的地方都一样。代价是成本乘以 5。

### 4.3.4 三者对比

| 方法 | 额外成本 | 效果提升 | 什么时候用 |
| --- | --- | --- | --- |
| Zero-shot CoT | 几乎为零 | 中 | 永远可以先试这个 |
| Few-shot CoT | 每次多几百 token | 中偏高 | 输出格式要求严格时 |
| Self-Consistency | 成倍 | 高 | 高价值、可容忍慢的任务 |
| 换推理模型 | 单价高、延迟高 | 最高 | 真正的硬骨头 |

## 4.4 推理模型：把思考内建进模型

前面三种都是**你在提示词里教模型思考**。2024 年之后出现了另一条路：**在训练阶段就把"长时间思考"训练进去**，代表是 OpenAI 的 o1/o3 系列和 DeepSeek 的 R1。

### 4.4.1 关键区别

```text
普通模型 + CoT 提示:

  你必须写: "请一步一步思考"
  思考过程 = 正常输出的一部分,用户直接看到
  思考长度 = 几十到几百 token
  思考质量 = 靠提示词碰运气


推理模型 (o1 / R1 类):

  你什么都不用写
  模型自己先进入"思考阶段",生成大量思考 token
  这些 token 可能被隐藏,或放在单独的字段里
  思考长度 = 几千到几万 token
  思考质量 = 训练时用强化学习专门优化过
```

### 4.4.2 思考 token 是什么

**思考 token（reasoning tokens）** 是模型在给出正式答案前，为自己生成的中间推理内容。三个特点：

1. **它们算钱**。虽然你可能看不到它们，但它们占用计算、消耗上下文预算、计入账单。一道题的思考 token 可能是答案 token 的 20 倍。
2. **它们占窗口**。思考内容也要塞进上下文，长思考会挤占可用空间。
3. **它们通常不进入下一轮历史**。多轮对话时，上一轮的思考过程一般会被丢弃，只保留最终答案。

### 4.4.3 推理模型怎么训出来的

简化版流程（以公开的 R1 类方法为例）：

```text
  给模型一道有标准答案的题 (数学/代码,答案可自动验证)
              │
              ▼
  让它生成很长的思考过程,再给出答案
              │
              ▼
  自动判分: 答案对不对? 格式规不规范?
              │
              ▼
  强化学习: 提高"能导向正确答案的思考方式"的概率
              │
              ▼
  循环数百万次
              │
              ▼
  模型自发学会: 拆解问题、验算、发现错误后回头改正
```

最有意思的现象是**"顿悟时刻"**：训练到一定程度，模型会自发在思考里写出"等等，我上面这一步好像错了，让我重新算"这样的话。**没有人教它自我纠错，这是为了拿到正确答案而涌现出来的策略。**

> **说明 · 为什么是数学和代码先突破**
>
> 因为这两个领域的答案**可以被机器自动验证**——数学题有标准答案，代码能跑单元测试。有了自动判分器，就能做大规模强化学习，不需要人来标注。
> 而"这篇作文写得好不好"没法自动判分，所以推理模型在开放式写作上的提升远不如在数学和代码上明显。这也提示你：**任务能不能自动验证，决定了 AI 在这个领域进步的速度。**

## 4.5 快思考 vs 慢思考：什么时候用哪个

心理学家卡尼曼把人的思维分成两个系统：系统 1（快、直觉、自动）和系统 2（慢、费力、逻辑）。这个框架套在模型上非常贴切。

| 维度 | 普通模型（快思考） | 推理模型（慢思考） |
| --- | --- | --- |
| 首字延迟 | 几百毫秒 | 数秒到数分钟 |
| 单次成本 | 低 | 高（思考 token 占大头） |
| 简单任务 | 又快又好 | **过度思考，反而变差** |
| 数学/逻辑/规划 | 容易出错 | 明显更强 |
| 创意写作 | 更自然 | 有时显得刻板 |
| 适合场景 | 对话、摘要、改写、分类 | 证明题、复杂调试、多步规划 |

**"用推理模型做所有事"是新手最常见的浪费。** 让 o1 级别的模型去做"把这段话改得口语一点"，你付了 10 倍的钱、等了 10 倍的时间，结果可能还不如普通模型自然。

```text
                      任务需要多步推理吗?
                             │
              ┌──────────────┴──────────────┐
             否                             是
              │                             │
      需要多轮交互/低延迟?              步骤能被验证吗?
              │                             │
      ┌───────┴───────┐            ┌────────┴────────┐
     是              否           是                否
      │               │            │                 │
   普通模型      普通模型+CoT    推理模型        推理模型 +
   (系统 1)                                    人工检查
```

## 4.6 DeepTutor 如何处理"思考"

DeepTutor 面对一个很现实的工程难题：**它要同时支持普通模型和推理模型，而这两类模型吐"思考"的方式完全不同。**

### 4.6.1 三种思考流

```text
方式 A: 独立字段 (o1 / R1 经由部分 provider)
   服务端返回的每个数据块里有 delta.reasoning_content
   思考期间 delta.content 是空的!

方式 B: 内联标签 (很多开源推理模型)
   思考内容混在正文里,用 <think> ... </think> 包起来
   例: "<think>先算 23-20=3...</think>``FINISH``答案是 9"

方式 C: 协议标签 (DeepTutor 自己定义,适用于所有模型)
   要求模型第一行输出 ``THINK``,后面跟思考内容
   这一轮不算结束,循环继续
```

三种方式，DeepTutor 在 `deeptutor/core/agentic/labeled_step.py` 里全部接住，并且**统一路由到同一个界面区域**。

### 4.6.2 方式 A：拦住"独立字段"

源码在 `deeptutor/core/agentic/labeled_step.py:473`：

```py
reasoning_text = getattr(delta, "reasoning_content", None) or getattr(
    delta, "reasoning", None
)
if reasoning_text and label is None:
    output_chars_seen += len(reasoning_text)
    saw_pre_label_think = True
    await _open_sub_trace()
    await stream.thinking(
        reasoning_text,
        source=source,
        stage=stage,
        metadata=merge_trace_metadata(iter_meta, {"trace_kind": "llm_chunk"}),
    )
```

紧邻的注释（`labeled_step.py:462-472`）解释了为什么必须有这一段：

> Reasoning models that surface chain-of-thought via the dedicated `reasoning_content` (or `reasoning`) field … emit *no* `delta.content` during the reasoning phase. Without this branch the UI would sit frozen for the entire reasoning duration…

翻译成人话：**推理模型思考的那几十秒里，正文字段一个字都不发。如果不单独处理这个字段，用户会看到界面死住不动，然后答案突然蹦出来。** 所以要把 reasoning 流实时推进"思考"面板。

注意这里的兼容写法：先试 `reasoning_content`，取不到再试 `reasoning`——不同服务商字段名不统一，这是真实工程中必须处理的脏活。

### 4.6.3 方式 B：剥掉内联的 think 标签

`labeled_step.py:73` 和 `:77` 定义了 `_THINK_OPEN_RE` / `_THINK_CLOSE_RE` 两个正则，用来在流里识别 think 开闭标记。模块文档 `labeled_step.py:18-27` 描述了处理策略：

- 标签**之前**的 think 前奏被识别出来，实时推进思考子轨迹（和 THINK 标签走同一条路由）。
- think 结束后，**恢复标签探测**，继续按协议解析。
- think 的开闭标记本身**不发给用户**，只留在缓冲区里，最后由 `clean_thinking_tags` 从正文中剥掉。

有个细节值得欣赏：`labeled_step.py:68-69` 的注释说明，正则要求反引号成对出现，因为"单侧可选的反引号会贪婪匹配"。这种边界处理，就是"能跑的 demo"和"能上线的产品"之间的差距。

### 4.6.4 方式 C：把思考变成协议的一部分

DeepTutor 最优雅的一招，是**不依赖模型自带推理能力，直接把"思考"定义成循环协议里的一个合法动作**。

`deeptutor/core/agentic/labels.py:9-10` 的模块文档写道：*Label sets are caller-supplied: chat uses `(FINISH, TOOL, THINK)`, a solve step uses `(THINK, TOOL, FINISH, REPLAN)`…*

来看一个真实的协议定义，`deeptutor/agents/research/pipeline.py:128`：

```py
_PROTOCOL_REPHRASE = LabelProtocol(
    allowed=(LABEL_THINK, LABEL_TOOL, LABEL_FINISH),
    terminal=frozenset({LABEL_FINISH}),
    intermediate=frozenset({LABEL_THINK}),
    final=frozenset({LABEL_FINISH}),
    tool_label=LABEL_TOOL,
)
```

对照 `deeptutor/core/agentic/loop.py:40` 的 `LabelProtocol` 定义读这五个字段：

- `allowed`：模型这一轮允许输出的标签。
- `terminal`：会**结束**循环的标签，这里只有 FINISH。
- `intermediate`：**不结束**循环的标签——THINK 在这里。
- `final`：内容要作为正式答案发给用户的标签。THINK 不在其中，所以它的内容进思考面板，不进答案区。
- `tool_label`：代表"这一轮要调工具"的那个标签。

于是就有了这样的运行图：

```text
       ┌──────────── 循环 (loop.py:173 run_agentic_loop) ────────────┐
       │                                                            │
   消息历史 ──► 调用模型 ──► 解析第一行标签                            │
       ▲                         │                                  │
       │            ┌────────────┼────────────┐                     │
       │        ``THINK``    ``TOOL``     ``FINISH``                 │
       │            │            │            │                     │
       │      进思考面板     执行工具      作为答案输出                 │
       │      文本追加进      结果追加       ↓                        │
       │      消息历史        进消息历史   退出循环                     │
       │            │            │                                  │
       └────────────┴────────────┘                                  │
                 循环继续,下一轮                                      │
       └────────────────────────────────────────────────────────────┘
```

**这个设计的妙处在于：即使你接的是一个完全没有推理能力的普通小模型，它也能在 DeepTutor 里"分步思考"** ——因为思考不是模型的内建能力，而是循环协议赋予它的一个动作选项。模型只要会输出 THINK 三个字母，就获得了"这轮我先不答，我先想想"的权利。

### 4.6.5 开关思考：reasoning_params.py

不同服务商开关思考的参数名各不相同，DeepTutor 把这些差异集中在 `deeptutor/services/llm/reasoning_params.py`。`reasoning_params.py:7` 的 `_THINKING_STYLE_MAP` 列出三种风格，`:12` 的 `_PROVIDER_THINKING_STYLES` 做映射：

| 服务商 | 用的参数风格 |
| --- | --- |
| deepseek / volcengine / byteplus | thinking 字段（enabled / disabled） |
| dashscope | `enable_thinking` 布尔 |
| minimax | `reasoning_split` |

还有一个很有实战价值的细节，在 `reasoning_params.py:25-31`。注释写道：某些模型**默认就开着思考**，如果不显式关掉，它会**把整个 `max_tokens` 预算全烧在推理上**，导致正式答案被截断。于是有了这张名单：

```py
_PROVIDER_DEFAULT_OFF_PATTERNS: dict[str, tuple[str, ...]] = {
    "gemini": ("gemini-2.5", "gemini-3"),
}
```

`reasoning_params.py:63` 的 `default_reasoning_effort_for` 就是这条规则的唯一出口，注释特别强调它是 "the single source of truth"，保证三条不同的执行路径（openai SDK 路径、aiohttp 兜底路径等）对"哪些模型要默认关思考"的判断完全一致。

> **注意 · 这是一个你迟早会踩的坑**
>
> "模型只回了半句话就断了"——很多人第一反应是网络问题或者 bug。真实原因常常是：**思考默认开着，把输出预算吃光了。**
> 排查顺序：看 `max_tokens` 设了多少 → 看用量里 reasoning tokens 占了多少 → 看这个模型是不是默认开思考。

## 4.7 给应用开发者的六条实践建议

1. **默认别上推理模型**。先用普通模型 + 一句 CoT 提示，不够再升级。
2. **给思考留预算**。用推理模型时把 `max_tokens` 调大，否则答案会被思考挤掉。
3. **别把思考过程当答案**。思考内容可能自相矛盾、可能中途走错路，最终答案才算数。DeepTutor 把它路由到独立面板而不是答案区，正是这个原因。
4. **多轮对话丢掉旧思考**。上一轮的推理过程留在历史里，只会白白占窗口。
5. **想省钱就用协议级思考**。像 DeepTutor 的 THINK 标签那样，用普通模型 + 循环实现分步推理，成本远低于推理模型。
6. **让思考可见**。用户等待 30 秒不知道发生了什么会焦虑；把思考流式展示出来，等待就变成了"看它干活"。这就是 4.6.2 那段源码存在的产品价值。

## 4.8 扩展阅读

- Wei 等，*Chain-of-Thought Prompting Elicits Reasoning in Large Language Models*（2022）：[arxiv.org/abs/2201.11903](https://arxiv.org/abs/2201.11903)
- Kojima 等，*Large Language Models are Zero-Shot Reasoners*（"let's think step by step"）：[arxiv.org/abs/2205.11916](https://arxiv.org/abs/2205.11916)
- Wang 等，*Self-Consistency Improves Chain of Thought Reasoning*：[arxiv.org/abs/2203.11171](https://arxiv.org/abs/2203.11171)
- DeepSeek-AI，*DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning*：[arxiv.org/abs/2501.12948](https://arxiv.org/abs/2501.12948)
- 本仓库源码：`deeptutor/core/agentic/labeled_step.py`、`deeptutor/services/llm/reasoning_params.py`、`deeptutor/agents/research/pipeline.py`
- 下一章：[第 5 章：Token、上下文窗口与上下文工程](05-token-context.md)

## 自查清单

- [ ] 能解释为什么"一步一步思考"能提高正确率（深度换长度）
- [ ] 知道每个 token 的计算量固定，中间步骤给了模型额外算力
- [ ] 能区分 Zero-shot CoT、Few-shot CoT、Self-Consistency 三种玩法
- [ ] 知道"思考 token"要算钱、占窗口、通常不进入下一轮历史
- [ ] 能说出推理模型为何先在数学和代码上突破（答案可自动验证）
- [ ] 知道简单任务上推理模型可能因过度思考而变差
- [ ] 能说出 DeepTutor 接住的三种思考流（独立字段 / 内联标签 / 协议标签）
- [ ] 知道 `reasoning_content` 期间正文为空，不特判会导致界面假死
- [ ] 能读懂 `LabelProtocol` 里 terminal 与 intermediate 的区别
- [ ] 知道 THINK 标签让普通模型也能获得"分步思考"能力
- [ ] 知道"回答被截断"可能是默认开启的思考吃光了 `max_tokens`
