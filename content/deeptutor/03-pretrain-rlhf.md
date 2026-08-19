---
title: "第 03 章 · 预训练、微调与 RLHF/RLAIF"
date: 2026-08-01
summary: "讲清一个大模型从\"读完互联网的野孩子\"变成\"彬彬有礼的助手\"要经过哪三关，以及为什么第三关（RLHF）是 ChatGPT 引爆世界的真正原因。最后落到 DeepTutor：当模型训练已经结束、你只能写提示词时，如何通过 system prompt 和 persona 继续\"塑造\"它的行为。"
tags:
  - deeptutor
---
# 第 03 章 · 预训练、微调与 RLHF/RLAIF

> 目标：讲清一个大模型从"读完互联网的野孩子"变成"彬彬有礼的助手"要经过哪三关，以及为什么第三关（RLHF）是 ChatGPT 引爆世界的真正原因。最后落到 DeepTutor：当模型训练已经结束、你只能写提示词时，如何通过 system prompt 和 persona 继续"塑造"它的行为。

## 3.1 一个比喻：培养一名助教

假设你要培养一位大学助教，你会怎么做？

```text
第 1 步  通识教育 (4 年本科)
         让他读完图书馆所有的书。他博学,但不知道自己该干嘛,
         你问他问题,他可能给你续写一篇论文。

第 2 步  岗前培训 (3 个月)
         给他看 5 万份"优秀助教答疑范例"。他学会了:
         有人提问时,应该回答问题,而不是续写。

第 3 步  带教纠偏 (持续)
         他答完,资深老师说"这个回答比那个好"。
         几万次之后,他摸清了什么样的回答会被认可,
         学会了不敷衍、不瞎编、不说有害的话。
```

这三步对应大模型训练的三个阶段：

| 阶段 | 英文 | 学什么 | 数据从哪来 | 成本量级 |
| --- | --- | --- | --- | --- |
| 预训练 | Pre-training | 语言、常识、逻辑 | 互联网原始文本，无需标注 | 千万美元 |
| 监督微调 | SFT | "有人问就要答"这类任务格式 | 人写的高质量问答对 | 数万美元 |
| 人类反馈强化学习 | RLHF | 什么样的回答**更好** | 人对多个回答排序 | 数十万美元 |

> **说明 · 为什么开发者要懂训练**
>
> 你不会去训练模型，但你必须懂它，因为**你写的每一句提示词，都是在和这三个阶段的训练结果博弈**。
> 比如：模型为什么总爱写小标题和分点？因为 SFT 和 RLHF 阶段人类标注员偏爱结构化回答。你想让它说人话，就得在 system prompt 里明确压制这个倾向——DeepTutor 的 peer persona 就是这么做的（本章 3.7 节会看到源码）。

## 3.2 第一阶段：预训练

### 3.2.1 学习任务只有一个

预训练的任务简单到令人发指：**遮住下一个词，猜它。**

```text
原始文本(来自某本书):  "水在标准大气压下的沸点是 100 摄氏度"

拆成无数道自动生成的填空题:
   "水在标准大气压下的沸点是 100 摄氏___"  → 答案: 度
   "水在标准大气压下的沸点是 100 ___"      → 答案: 摄
   "水在标准大气压下的沸点是 ___"          → 答案: 100
   "水在标准大气压下的沸___"               → 答案: 点
   ...

猜错了 → 微调参数 → 再猜 → 重复几万亿次
```

关键点：**这些题目和答案都不需要人来写**，原文自己就是答案。这叫**自监督学习（Self-Supervised Learning）**，它是大模型能吃下整个互联网的唯一原因——如果每条数据都要人标注，成本会是天文数字。

### 3.2.2 为什么"猜词"能学出知识

这是最反直觉的一点。想想看，要在下面这些句子上把词猜准，模型被迫学会了什么：

```text
"法国的首都是 ___"              → 被迫记住事实
"小明有 3 个苹果,又买了 5 个,   → 被迫学会加法
  现在一共有 ___ 个"
"def add(a, b):\n    return ___" → 被迫理解代码语义
"他脸涨得通红,握紧了拳头,       → 被迫理解情绪与因果
  显然非常 ___"
```

**知识不是被"教"进去的，是为了把词猜准而"被迫"学会的副产品。** 这是理解大模型能力来源的关键认知。

### 3.2.3 预训练完的模型有多难用

预训练结束后得到的叫**基座模型（base model）**。它非常博学，但完全不能直接当助手用：

```text
你输入:  "什么是光合作用?"

基座模型可能输出:
  "什么是呼吸作用? 什么是蒸腾作用? 什么是渗透压?
   ——本章课后思考题,请同学们预习第三节。"

它在干嘛? 它在"续写"! 因为在训练语料里,
一个问句后面最常出现的,往往是更多问句(习题册、目录、FAQ 标题)。
```

它没有理解"你在问我，我要答"。它只是在做它唯一学过的事：**接着往下写**。

这就是为什么需要第二阶段。

## 3.3 第二阶段：监督微调（SFT）

### 3.3.1 教它"对话"这件事的格式

**监督微调（Supervised Fine-Tuning, SFT）** 用的数据是人类精心写的"问 → 答"对：

```text
{
  "messages": [
    {"role": "user",      "content": "什么是光合作用?"},
    {"role": "assistant", "content": "光合作用是绿色植物利用光能,
                                      把二氧化碳和水转化成有机物
                                      并释放氧气的过程。简单说,
                                      这是植物"吃饭"的方式。"}
  ]
}
```

几万到几十万条这样的数据训下去，模型学会了一个新模式：**看到 user 说话，我就该以 assistant 身份给出有帮助的回答，而不是续写。**

注意，这里训练方式和预训练**完全一样**（还是猜下一个词），只是数据换成了对话格式。模型学的不是新知识，是**新的行为模式**。

### 3.3.2 角色标记：system / user / assistant 的来源

你在 API 里写的 `role` 字段，就是在这个阶段被固化进模型的：

```json
{
  "messages": [
    {"role": "system",    "content": "你是一位耐心的苏格拉底式导师。"},
    {"role": "user",      "content": "递归是什么?"},
    {"role": "assistant", "content": "在我解释之前,你先告诉我..."}
  ]
}
```

- `system`：设定身份和规则，模型被训练成"要特别听这一段的话"。
- `user`：用户说的。
- `assistant`：模型说的（多轮对话里，历史回复也要放回来）。

**system prompt 之所以有效，不是因为它有什么魔法，而是因为模型在 SFT 阶段被反复训练过"要优先遵守 system 里的指令"。** 这是一个训练出来的习惯，不是硬性机制——所以它可以被绕过，这也是提示注入攻击存在的根源。

### 3.3.3 SFT 的天花板

SFT 有个根本局限：**它只能教"什么是对的"，没法教"什么更好"。**

```text
用户问: "我室友总是半夜吵闹,怎么办?"

回答 A: "建议你和室友沟通。"                    ← 没错,但敷衍
回答 B: "先分清是偶发还是习惯。如果是习惯性的,
         建议选一个双方都平静的时间,用'我感受'
         句式表达,比如'我最近睡不好,影响白天
         上课'。避免用'你总是'开头..."          ← 明显更好

在 SFT 里,只要 A 出现在训练数据里,它就是"标准答案",
模型学不到"B 比 A 好"这个信息。
```

而且人类**写**一个 B 这样的高质量回答很累，**判断** A 和 B 谁更好却很容易。这个不对称性，正是第三阶段的切入点。

## 3.4 第三阶段：RLHF

**RLHF = Reinforcement Learning from Human Feedback，人类反馈强化学习。**

### 3.4.1 三步流程

```text
步骤 1: 收集人类偏好
  同一个问题,让模型生成 4 个不同回答
       ┌── 回答 A
  问题 ├── 回答 B
       ├── 回答 C
       └── 回答 D
             │
             ▼  人类标注员排序 (只需排序,不需重写!)
        B > D > A > C

步骤 2: 训练一个"奖励模型" (Reward Model)
  用几万组这样的排序数据,训练一个小模型,
  它的任务: 输入(问题, 回答) → 输出一个分数
  目标: 让它的打分顺序和人类排序一致
       ↓
  相当于把"人类的品味"压缩进了一个可自动调用的打分器

步骤 3: 用奖励模型去优化主模型
  ┌────────────────────────────────────────┐
  │  主模型生成回答                          │
  │        ↓                                │
  │  奖励模型打分: 7.2 分                    │
  │        ↓                                │
  │  强化学习: 提高"能拿高分的说话方式"的概率  │
  │        ↓                                │
  │  再生成 → 再打分 → 再调整 (循环数万次)    │
  └────────────────────────────────────────┘
```

### 3.4.2 为什么这一步是分水岭

RLHF 之前的 GPT-3 只有研究者和开发者在用；RLHF 之后的 ChatGPT 两个月破亿用户。差别不在知识量（知识主要在预训练里就固定了），在**对齐（alignment）**：

| 能力 | 只有 SFT | 加了 RLHF |
| --- | --- | --- |
| 拒绝有害请求 | 经常照做 | 稳定拒绝并说明理由 |
| 承认不知道 | 倾向硬编 | 更愿意说"我不确定" |
| 回答详略 | 随机 | 贴合问题复杂度 |
| 指令遵循 | "写三点"可能写五点 | 更严格遵守 |
| 语气 | 忽冷忽热 | 稳定、礼貌、有帮助 |

一句话：**预训练给了它智力，SFT 给了它职业，RLHF 给了它教养。**

### 3.4.3 RLHF 的代价与副作用

RLHF 不是免费的，它带来了几个你天天遇到但可能没意识到的问题：

- **贵且慢**。需要雇大量标注员持续做偏好排序。
- **谄媚（sycophancy）**。人类标注员倾向于给"认同自己"的回答打高分，于是模型学会了顺着你说。你说"我觉得这段代码没问题吧？"它就更容易说"是的没问题"——**这是训练出来的偏差，不是它真的检查过了**。
- **啰嗦**。长回答看起来更用心，容易得高分，于是模型倾向于把简单问题答得很长。
- **能力税（alignment tax）**。对齐过度可能让模型在某些硬核任务上表现下降，或者过度拒绝正常请求。

> **注意 · 谄媚是你写提示词时的头号敌人**
>
> 当你让模型做代码审查、事实核查、方案评估时，**不要在提问里暴露你的倾向**。
> 不好："我觉得这个方案挺好的，你觉得呢？"
> 更好："请指出这个方案中最可能失败的三个环节。"
> DeepTutor 的 peer persona 显式对抗这一点，它要求模型"当某处说不通时就要反驳"（`deeptutor/services/persona/presets/peer/PERSONA.md`）。

## 3.5 RLAIF：让 AI 代替人来打分

RLHF 的瓶颈是人。人贵、慢、会累、标准还不统一。于是有了 **RLAIF（Reinforcement Learning from AI Feedback）**。

### 3.5.1 核心思路

```text
RLHF:                          RLAIF:

 回答 A ┐                       回答 A ┐
 回答 B ┼──► 人类标注员排序        回答 B ┼──► 另一个 AI 按"宪法"排序
 回答 C ┘         │              回答 C ┘         │
              (慢/贵/主观)                   (快/便宜/一致)
```

代表工作是 Anthropic 的 **Constitutional AI**：先写一份"宪法"（一组自然语言原则，比如"回答应当无害""应当承认不确定性"），然后让 AI 依据这些原则自我批评、自我修改、互相打分。

```text
Constitutional AI 的自我修正循环:

  1. 模型给出初始回答
  2. 提问: "根据原则'避免给出可能造成伤害的建议',
            上面的回答有什么问题?"
  3. 模型自我批评: "我提到了具体剂量,这可能被滥用"
  4. 提问: "请据此重写"
  5. 模型给出改进版
  6. (初始版, 改进版) 成为一条训练数据
```

### 3.5.2 两者对比

| 维度 | RLHF | RLAIF |
| --- | --- | --- |
| 反馈来源 | 人类标注员 | 更强的 AI 或模型自身 |
| 成本 | 高 | 低 1–2 个数量级 |
| 速度 | 慢 | 快 |
| 一致性 | 标注员之间会打架 | 高度一致 |
| 可审计性 | 标准藏在标注员脑子里 | **原则写成文字，可读可改** |
| 风险 | 人的偏见 | AI 的偏见被放大、自我强化 |

实践中主流做法是**混合**：安全红线等关键处仍用人类反馈，大批量常规偏好用 AI 反馈。此外还有 **DPO（Direct Preference Optimization）** 这类简化方案，跳过训练奖励模型这一步，直接用偏好数据优化模型，工程上简单很多。

> **提示 · RLAIF 和你写提示词是同一件事**
>
> 注意 Constitutional AI 的"宪法"长什么样——它就是**一段用自然语言写的行为原则**。
> 你在 DeepTutor 里写的 system prompt、写的 PERSONA.md，形式上和它一模一样。区别只在于：宪法是在**训练时**塑造模型，你的提示词是在**推理时**塑造模型。
> 懂了这一点，你就知道该怎么写提示词了：**像写一部宪法那样写，给原则、给正例反例、给优先级，而不是零散地下命令。**

## 3.6 训练结束之后：开发者能做的三件事

模型交付到你手上时，三个阶段都已经完成，参数被冻结了。你还能做什么？

```text
        影响力
          ▲
     强   │  ┌──────────────┐
          │  │ 继续训练/微调  │  需要 GPU、数据、钱，多数团队不做
          │  └──────────────┘
          │  ┌──────────────┐
     中   │  │ 上下文工程     │  ← DeepTutor 和绝大多数产品的主战场
          │  │ system prompt │     第 5 章专讲
          │  │ persona/记忆   │
          │  │ 工具/RAG      │
          │  └──────────────┘
          │  ┌──────────────┐
     弱   │  │ 采样参数       │  temperature / top_p 等
          │  └──────────────┘
          └────────────────────────►
```

DeepTutor 走的是中间这条路：**不动模型参数，全靠把对的东西放进上下文。** 下面我们看它具体怎么做。

## 3.7 DeepTutor 的 system prompt 是怎么拼出来的

### 3.7.1 分块拼装，而不是一大坨字符串

DeepTutor 不是把 system prompt 写成一个大字符串，而是拆成一个个**命名块（PromptBlock）**，按固定顺序拼装。核心函数在 `deeptutor/agents/chat/prompt_blocks.py:57` 的 `blocks()`，从 `prompt_blocks.py:69` 开始，第一批固定块是：

```py
blocks: list[PromptBlock] = [
    PromptBlock("general", self._general_block(context)),
    PromptBlock("runtime_policy", self._t("runtime_policy")),
    PromptBlock("loop", self._t("loop.system")),
]
```

之后按条件追加其余块。整体顺序大致是：

```text
system prompt 组装顺序 (deeptutor/agents/chat/prompt_blocks.py:69 起)

  1. general              产品身份 / 伙伴身份
  2. runtime_policy       运行期规则
  3. loop                 标签驱动循环的协议说明  ← 第 18 章
  4. capability playbooks 当前能力的专属打法
  5. persona_style        用户选的人格            ← :77-78
  6. partner_turn_policy  多智能体协作策略
  7. memory               长期记忆                ← 第 26 章
  8. tools                工具清单                ← 第 7 章
  9. skills               技能清单
 10. sources              附件来源清单
 11. extended_tools       延迟加载的扩展工具
 12. notebooks / workspace 笔记本与工作区

  最后 render() 把它们用 "## 块名" + 分隔线连起来
  (prompt_blocks.py:44)
```

`prompt_blocks.py:74-76` 的注释解释了顺序的用意：能力手册被放得靠前，"so they frame the whole turn when active"（让它们在生效时框定整个回合）。**位置即优先级**——这是提示工程的一条通用经验，越靠前的指令影响力越大。

### 3.7.2 一个容易忽略的细节：前缀稳定

`prompt_blocks.py:101-103` 有一段值得细读的注释：

> Volatile content deliberately gets NO system block: the KB seed rides in the trailing user message, so the system prompt stays byte-stable for the whole turn (every loop round shares one prefix).

翻译：**易变的内容故意不放进 system 块**，而是挂在末尾的 user 消息里，好让 system prompt 在整个回合内**逐字节稳定**。

为什么要这么苛刻？因为**提示缓存（prompt caching）**：只要请求的前缀一字不差，服务商就能复用上一次的计算结果，又快又省钱。循环一轮要调好几次模型，前缀稳定带来的收益非常可观。这个话题第 12 章会专门讲。

## 3.8 Persona：把"教养"外包给一个 Markdown 文件

### 3.8.1 persona 是什么

`deeptutor/services/persona/service.py:1-12` 的模块文档说得很清楚：

> A persona is a behaviour/voice preset ("teacher", "peer", …) the user picks for a conversation. …a persona must shape the model's voice from the very first token, so the selected persona's body is injected verbatim into the system prompt — eagerly, never on demand.

三个要点：

- persona 是**行为与语气预设**，用户在会话里选一个。
- 它必须从**第一个 token 就起作用**，所以是**原样注入** system prompt。
- 是 **eagerly（提前加载）**，不像 skill 那样按需加载——因为语气这种东西没法"用到了再说"。

每个 persona 是一个独立目录下的 `PERSONA.md`，开头是 YAML frontmatter（`name` 和 `description`），正文就是要注入的内容。DeepTutor 自带三个预设，路径见 `service.py:47` 的 `PRESETS_DIR`，名字列在 `service.py:52`：

```py
LEGACY_PERSONA_SKILLS: tuple[str, ...] = ("peer", "teacher", "research-assistant")
```

### 3.8.2 读一份真实的 persona

`deeptutor/services/persona/presets/teacher/PERSONA.md` 的核心内容（原文为英文，这里直译）：

```text
Teacher Mode —— 苏格拉底式导师

如何回应:
  - 先提问。 解释任何东西之前,先问一个能暴露学习者
             已有认知的针对性问题。
  - 小步推进。 把概念拆成最小的有意义单元,确认理解
             之后再往下走。
  - 用具体例子。 每个抽象概念都要落到一个学习者能想
             象出画面的具体例子上。
  - 诊断,而不是讲课。 学习者答错时,把错误当线索。
  - 奖励努力而非正确。 先肯定思考质量,再评判答案。

要避免:
  - 长篇独白。 如果回复超过 200 词,你大概已经不是
             在教学了。
  - 在学习者只差一步就能自己想出来时,直接给出答案。
```

对照 3.4.3 讲的 RLHF 副作用，你会发现这份文件几乎是**逐条在对抗训练偏差**：

| RLHF 带来的默认倾向 | teacher persona 的对抗手段 |
| --- | --- |
| 回答越长越像用心 | 明确规定"超过 200 词就是失败" |
| 直接给出完整答案 | "只差一步时不要给答案" |
| 谄媚、先夸再说 | "奖励努力"但要"诊断错误" |

而 peer persona 走的是另一个方向（`presets/peer/PERSONA.md`）：要求模型"想到哪说到哪，分享没成形的猜测""当某处说不通时要反驳""承认'我确实不知道'是有效的贡献"。这是在直接对抗**谄媚**和**假装确定**。

### 3.8.3 persona 如何进入上下文

```text
用户在界面选 "teacher"
        │
        ▼
PersonaService 读取 data/user/workspace/personas/teacher/PERSONA.md
   (deeptutor/services/persona/service.py, PERSONA_FILE = "PERSONA.md")
        │
        ▼
剥掉 YAML frontmatter, 取正文
        │
        ▼
放进 UnifiedContext.persona_context
   (deeptutor/core/context.py:34)
        │
        ▼
prompt_blocks.py:77-78 检测到非空, 追加一个块:
        PromptBlock("persona_style", context.persona_context)
        │
        ▼
render() 拼进 system prompt (prompt_blocks.py:44)
        │
        ▼
随每一次 LLM 调用发送出去
```

> **提示 · 这就是"推理时对齐"**
>
> 回到本章主题：RLHF 是在**训练时**用几十万条偏好数据塑造模型的行为；而一份 200 行的 `PERSONA.md`，是在**推理时**用几百个 token 临时塑造它的行为。
> 后者力量小得多（它压不过训练进参数里的强倾向），但**便宜、可读、可版本管理、随时能改**。作为应用开发者，这是你手里最趁手的工具。写 persona 时，请像写宪法一样写：给原则、给正反例、给优先级。

## 3.9 扩展阅读

- Ouyang 等，*Training language models to follow instructions with human feedback*（InstructGPT，RLHF 奠基）：[arxiv.org/abs/2203.02155](https://arxiv.org/abs/2203.02155)
- Bai 等，*Constitutional AI: Harmlessness from AI Feedback*（RLAIF）：[arxiv.org/abs/2212.08073](https://arxiv.org/abs/2212.08073)
- Rafailov 等，*Direct Preference Optimization*（DPO）：[arxiv.org/abs/2305.18290](https://arxiv.org/abs/2305.18290)
- 本仓库源码：`deeptutor/services/persona/service.py`、`deeptutor/services/persona/presets/*/PERSONA.md`、`deeptutor/agents/chat/prompt_blocks.py`
- 下一章：[第 4 章：推理模型与思维链（CoT）](04-reasoning-cot.md)

## 自查清单

- [ ] 能说出三阶段各自学什么（语言 / 任务格式 / 人类偏好）
- [ ] 能解释预训练为什么不需要标注（自监督，原文即答案）
- [ ] 能说出基座模型直接用为什么会"续写"而不是回答
- [ ] 知道 system/user/assistant 三个角色是 SFT 阶段固化进模型的习惯
- [ ] 能讲清 RLHF 三步：收集排序 → 训奖励模型 → 强化优化
- [ ] 知道谄媚和啰嗦是 RLHF 的副作用，并知道提问时如何规避
- [ ] 能对比 RLHF 与 RLAIF 的成本、一致性与风险差异
- [ ] 知道 DeepTutor 不改模型参数，只做上下文工程
- [ ] 能说出 DeepTutor system prompt 的分块顺序及"位置即优先级"
- [ ] 知道 persona 是原样注入 system prompt 的 Markdown，且是提前加载
- [ ] 能举例说明 teacher/peer persona 如何对抗 RLHF 的默认倾向
