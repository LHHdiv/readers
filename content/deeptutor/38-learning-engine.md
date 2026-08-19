---
title: "第 38 章 · 学习引擎：让 AI 导师知道\"你到底学会没\""
date: 2026-08-01
summary: "读者画像：你完全不懂编程，但想成为智能体开发者。本章讲 DeepTutor 怎么当个\"负责任的老师\"——它不只给你讲，还会**自动判题、追踪你每点的掌握度、决定下一步该教啥、并按遗忘曲线安排复习**。这套机制在 `deeptutor/learning/` 里。"
tags:
  - deeptutor
---
# 第 38 章 · 学习引擎：让 AI 导师知道"你到底学会没"

> 读者画像：你完全不懂编程，但想成为智能体开发者。本章讲 DeepTutor 怎么当个"负责任的老师"——它不只给你讲，还会**自动判题、追踪你每点的掌握度、决定下一步该教啥、并按遗忘曲线安排复习**。这套机制在 `deeptutor/learning/` 里。

## 38.1 直觉：好老师脑子里的四件事

一个真人好老师，心里一直在算四笔账：

1. **你这题答对没？**（判分）
2. **你这个点掌握了几成？**（掌握度）
3. **下一步该考你/教你什么？**（策略）
4. **哪些旧知识该安排复习了？**（复习调度）

DeepTutor 把这四笔账拆成四个独立模块，再用一个"学习服务"把它们串起来。先记住这张总图：

```text
用户答题
   │
   ▼
grading.py   判分（对/错 + 错在哪类）
   │
   ▼
mastery.py   算掌握度（近期表现加权）
   │
   ▼
scheduler.py 排复习（遗忘曲线）
   │
   ▼
policy.py    定下一步（还教不教、该复习谁）
   │
   ▼
service.py   总调度 + 落盘（storage.py）
```

> **说明 · 四个文件名先混个脸熟**
>
> - `grading.py`：判分器
> - `mastery.py`：掌握度计算器
> - `policy.py`：学习策略（决定下一步）
> - `scheduler.py`：间隔复习调度器
> - `service.py` + `storage.py`：总指挥 + 存档

## 38.2 数据模型：知识有"类型"，进度有"结构"

在讲算法前，先看 `deeptutor/learning/models.py` 怎么定义"学什么"和"学到哪了"：

```text
models.py:L24    class KnowledgeType(str, Enum):   # 知识类型
models.py:L36    class ErrorType(str, Enum):       # 错误类型
models.py:L61    class LearningStage(str, Enum):   # 学习阶段
models.py:L80    class KnowledgePoint(BaseModel):  # 一个知识点
models.py:L89    class LearningModule(BaseModel):  # 一个模块（含多个知识点）
models.py:L107   class QuizAttempt(BaseModel):     # 一次答题记录
models.py:L164   class PendingQuestion(BaseModel): # 等待用户回答的题
models.py:L185   class LearningProgress(BaseModel):# 整本书的学习进度
```

`KnowledgeType`（`models.py:24`）把知识分成四类，这直接决定了"怎么算学会"：

| 类型 | 含义 | 怎么算掌握 |
| --- | --- | --- |
| `MEMORY` | 记忆型（背的） | 靠做对题的次数 |
| `CONCEPT` | 概念型（理解的） | 靠老师判断你讲得对不对 |
| `PROCEDURE` | 程序型（步骤） | 靠做对题的次数 |
| `DESIGN` | 设计型（创造的） | 靠老师判断 |

`LearningProgress`（`models.py:185`）是"整本书的学习账本"：里面记着 `mastery_levels`（各科掌握度）、`qualitative_mastery`（概念/设计型是否过关）、`review_queue`（复习队列）、`pending_question`（当前那道待答题）等。注意 `pending_question` 的注释特意说：**标准答案存在服务端，绝不经过模型**——这样判分才不会被 AI"自己给自己放水"。

### 38.2.1 为什么用"枚举"而不是随便写字符串

你可能会想：知识类型直接写 `"memory"` 字符串不行吗？DeepTutor 偏要用 `KnowledgeType` 枚举（`models.py:24`），原因是：

- **拼错就报错**：写 `"memroy"` 会立刻被 Python 拦下，而不是悄悄存个错误值日后炸库。
- **自带兼容旧数据**：枚举里有 `_missing_` 方法，能把老版本的 `"记忆型"` 自动映射成新版的 `MEMORY`（`models.py:9` 的 `_KNOWLEDGE_TYPE_LEGACY`）。所以老书升级后进度照样读得动。
- **IDE 能自动补全**：写代码时输入 `KnowledgeType.` 就弹出所有可选值，减少查文档。

> **说明 · 小习惯，大收益**
>
> 凡是"取值有限且固定"的字段（状态、类型、阶段），优先用枚举而非裸字符串。这是写可靠系统的基本功，你从现在就养成。

## 38.3 判分：grading.py 怎么打分

`deeptutor/learning/grading.py` 是判分器，主函数是 `grade_answer`：

```text
grading.py:L13    def grade_answer(user_answer, expected_answer, question_type="short") -> bool:
grading.py:L52    def classify_error(user_answer) -> ErrorType:
```

`grade_answer`（`grading.py:13`）按题型不同用不同判法：
- `choice`（选择题）：直接比对选项。
- `short`（简答）：做规范化比对（去空格、忽略大小写等）。
- `open`（开放题）：走更宽松的语义匹配。

判完对/错，若错了，`classify_error`（`grading.py:52`）进一步把错误归类成 `METACOGNITIVE`（元认知错误，比如"你根本不知道自己不会"）或 `APPLICATION_ERROR`（应用错误，知道原理但用错）。这个分类后面会喂给"错误诊断"，让老师知道该补哪块。

> **提示 · 判分要"确定性"**
>
> `grade_answer` 是纯函数——同样输入永远同样输出，不调 LLM。好处是：判分稳定、可复现、不会这次算你对、下次算你错。凡是"有标准答案"的事，都该用确定性逻辑，而不是丢给 AI 自由发挥。

## 38.4 掌握度：mastery.py 怎么算"几成"

判了一道题的对错，怎么变成"这个点掌握度 0.83"？看 `deeptutor/learning/mastery.py`：

```text
mastery.py:L17    _RECENCY_WEIGHTS = (0.5, 0.7, 0.85, 0.95, 1.0)
mastery.py:L21    _CONFIDENCE_CAP = {1: 0.5, 2: 0.8}
mastery.py:L24    def compute_mastery(correctness: list[bool]) -> float:
mastery.py:L37        return min(score, _CONFIDENCE_CAP.get(len(recent), 1.0))
```

核心思想三点：

1. **近因加权**：最近几次表现权重更高（`_RECENCY_WEIGHTS`，`mastery.py:17`）。你昨天全对、今天就错，系统更信"今天退步了"，而不是简单求平均。
2. **证据不足要封顶**：只做 1 次对，最多算你 0.5 掌握；做 2 次对，封顶 0.8（`_CONFIDENCE_CAP`，`mastery.py:21`）。防止"蒙对一次就以为全会"。
3. **封顶用 `min`**：`compute_mastery`（`mastery.py:24`）最后 `min(score, 置信上限)`，证据少时绝不给高分。

画成直觉图：

```text
你答了 5 次：对 错 对 对 对
              │  │  │  │  │
              ▼  ▼  ▼  ▼  ▼
权重(近大远小):0.5 0.7 0.85 0.95 1.0
              │
              ▼
加权平均 → 再 min(置信上限) → 掌握度
```

## 38.5 策略：policy.py 决定"下一步教啥"

掌握度有了，老师得决定"现在干啥"。`deeptutor/learning/policy.py` 是决策中枢：

```text
policy.py:L35    QUANTITATIVE_GATE = {MEMORY: 0.9, PROCEDURE: 0.9, ...}  # 量化过关线
policy.py:L43    QUALITATIVE_TYPES = frozenset({CONCEPT, DESIGN})        # 需老师判的类型
policy.py:L61    def is_mastered(progress, kp) -> bool:                 # 这点过关没？
policy.py:L90    def due_reviews(progress, now=None) -> list[ReviewTask]:# 该复习谁？
policy.py:L99    class NextStep:                                        # 下一步描述
policy.py:L163   def next_objective(progress, now=None) -> NextStep:   # 算下一步
```

两种"过关标准"：
- **量化过关**（`QUANTITATIVE_GATE`，`policy.py:35`）：记忆型/程序型靠掌握度，比如 ≥0.9 算过关。
- **定性过关**（`QUALITATIVE_TYPES`，`policy.py:43`）：概念型/设计型无法靠刷题，得老师（或模型）判断你"讲明白了"才算 `qualitative_mastery=True`（`is_mastered` 在 `policy.py:61/67/75` 分别处理两类）。

`next_objective`（`policy.py:163`）给出下一步，优先级顺序是：

```text
1. 还有没开始的 pending 知识点？ ──► 去教它
2. 有到期的复习任务？ ──► 去复习 (due_reviews, policy.py:90)
3. 第一个还没掌握的点？ ──► 继续教
4. 都掌握了？ ──► 完成 🎉
```

`NextStep`（`policy.py:99`）把这个决策打包成结构化的"下一步指令"，前端和导师智能体照着执行。

> **说明 · 量化 vs 定性，一句话**
>
> "会背/会算"能靠刷题分数判断（量化）；"真懂/会设计"得靠表达判断（定性）。好的评测系统一定同时有这两条线，DeepTutor 用 `KnowledgeType` + `qualitative_mastery` 把这件事做进了数据模型。

## 38.6 复习调度：scheduler.py 与遗忘曲线

人的记忆会忘。DeepTutor 用**间隔重复（spaced repetition）**安排复习，在 `deeptutor/learning/scheduler.py`：

```text
scheduler.py:L13    INTERVAL_SEQUENCES = {MEMORY: [0,1,3,7,14,30,60], ...}  # 复习间隔(天)
scheduler.py:L28    class SpacedRepetitionScheduler:
scheduler.py:L36    def get_initial_state(...)                  # 初始复习状态
scheduler.py:L45    def schedule_next(...)                      # 算下次复习时间
scheduler.py:L78    def build_review_queue(self, progress) -> list[ReviewTask]:  # 排复习队列
```

`INTERVAL_SEQUENCES`（`scheduler.py:13`）是核心技术：记忆型知识的复习间隔是第 0、1、3、7、14、30、60 天——越往后隔得越久，但每次答对就往后推一格；答错则回退重来。`schedule_next`（`scheduler.py:45`）按"连续答对几次"在序列里前进/后退，`build_review_queue`（`scheduler.py:78`）把所有"到点的复习"排成队列，交给 `policy.py` 的 `due_reviews` 取用。

复习节奏示意：

```text
第0天 学 ──► 第1天 复习(对) ──► 第3天 复习(对) ──► 第7天 ...
                     │                     │
                     └─ 若答错 ─► 退回更短间隔重来
```

> **提示 · 间隔重复是"抗遗忘"的利器**
>
> 这不是 DeepTutor 发明，而是认知科学的经典结论（艾宾浩斯遗忘曲线）。把它写进 `scheduler.py`，导师就能在"你快忘的时候"精准推复习，而不是天天重复或永远不复习。

### 38.6.1 调度怎么"进退"

`SpacedRepetitionScheduler` 的状态机很简单：每个知识点维护 `interval_index`（在间隔序列里的位置）和 `consecutive_correct`（连续答对次数）。

- 你答对一次：`interval_index` 前进一格，下次复习按更长间隔安排（`schedule_next`，`scheduler.py:45`）。
- 你答错：`consecutive_correct` 清零、`interval_index` 回退，间隔变短，马上再练。
- `build_review_queue`（`scheduler.py:78`）扫描所有知识点，把"当前时间 ≥ `next_review_at`"的挑出来，交给 `policy.due_reviews`（`policy.py:90`）排进今日任务。

这样系统既不会"考太频惹人烦"，也不会"考太疏全忘光"——永远卡在遗忘边缘轻轻一推，记忆最牢固。这叫**最优难度（desirable difficulty）**。

## 38.7 总指挥：service.py 把一切串起来

单独的判分、掌握度、调度、策略，得有人"按顺序调用、并且存盘"。这就是 `deeptutor/learning/service.py` 的 `LearningService`：

```text
service.py:L25     class LearningService:
service.py:L29     def get_or_create(self, book_id) -> LearningProgress:  # 取/建进度账本
service.py:L41     def replace_modules(self, progress, modules):          # 注入课程结构
service.py:L96     def record_quiz_attempt(self, progress, attempt):     # 记一次答题
service.py:L161    def grade_and_record(self, ...):                      # 判分+掌握+调度+落盘
```

最关键的是 `grade_and_record`（`service.py:161`），它是"单一可信源（single source of truth）"：一条调用链把四步串好——

```text
grade_and_record (service.py:161)
   │
   ├─ 1. grade_answer       判分        (grading.py:13)
   ├─ 2. compute_mastery    更新掌握度   (mastery.py:24)
   ├─ 3. scheduler          重排复习     (scheduler.py)
   ├─ 4. 重建 review_queue   刷新复习队列
   └─ 5. 持久化            落盘          (storage.py)
```

代码注释强调它"fail-closed"（失败即关闭）：任何一步出错都不会写出半成品状态，保证账本永远一致。`get_or_create`（`service.py:29`）则保证"每本书只有一本进度账本"，重复进入不会新建第二本。`record_quiz_attempt`（`service.py:96`）负责把单次答题写进 `QuizAttempt` 列表，供掌握度算法回看历史。

## 38.8 存档：storage.py 的原子读写

最后，账本要落盘。`deeptutor/learning/storage.py` 很薄但很重要：

```text
storage.py:L16    class LearningStore:
storage.py:L21    def _path(self, book_id):     # 校验 book_id，防路径穿越
storage.py:L26    def save(self, progress):     # 带 CAS 锁，version++
storage.py:L34    def load(self, book_id):      # 读
storage.py:L50    def list_all(self) -> list[str]:  # 列出所有进度
```

两个稳健细节：

- `_path`（`storage.py:21`）会**校验 `book_id`**，防止有人传入 `../../etc/passwd` 这类恶意路径（路径穿越攻击）。
- `save`（`storage.py:26`）带 **CAS 锁**并 `version++`：如果存的时候版本号对不上（说明并发被改过），就拒绝覆盖，避免两个进程互相踩踏丢数据。

> **注意 · 别小看"校验输入"**
>
> `_path` 校验 `book_id` 看似多余，却是安全基本功。任何"用外部字符串拼文件路径"的地方，都必须先验证，否则就是潜在的入侵口。这和第 25 章沙箱、第 36 章只读根fs 是同一套"默认不信任"思维。

## 38.4.1 举个掌握度的小例子

假设某"记忆型"知识点，你连答 5 次：`对 错 对 对 对`。

- 近因权重取最近 5 个：`(0.5, 0.7, 0.85, 0.95, 1.0)`（`mastery.py:17`）。
- 加权：`(1·0.5 + 0·0.7 + 1·0.85 + 1·0.95 + 1·1.0) / 总和`。
- 你有 5 次证据，超过 `_CONFIDENCE_CAP` 的封顶范围（最多管到 2 次），所以不再封顶，得到高分。

但若只答了 1 次且对：`min(1.0, 0.5)` = **0.5**（`mastery.py:37` 的 `min`）。系统说："才对一次，别飘，先记 0.5。"这就是证据封顶在起作用。

## 38.3.1 判分示例

```python
from deeptutor.learning.grading import grade_answer, classify_error

# 选择题：直接比对
grade_answer("B", "B", question_type="choice")        # True

# 简答题：忽略大小写/空格后比对
grade_answer("  Hello ", "hello", question_type="short")  # True

# 开放题答错 → 归类错误类型
err = classify_error("我不确定这道题在问什么")
# 返回 METACOGNITIVE 或 APPLICATION_ERROR 之一
```

注意 `grade_answer` 不碰网络、不调模型，纯本地计算——所以同一份答案，任何时候判都一样，评测才可信。

## 38.10 串起来：一次答题的完整旅程

把全章模块接成一条时间线，你就能"看见" DeepTutor 怎么当老师：

```text
导师出了一道题（存进 pending_question, models.py:164）
      │
      ▼
你提交答案
      │
      ▼
LearningService.grade_and_record (service.py:161)
      │
      ├─► grading.grade_answer       判对/错        (grading.py:13)
      │       └─ classify_error       错则归类       (grading.py:52)
      │
      ├─► mastery.compute_mastery     刷新掌握度     (mastery.py:24)
      │
      ├─► scheduler.schedule_next     重排复习间隔   (scheduler.py:45)
      │       └─ build_review_queue    重建复习队列  (scheduler.py:78)
      │
      ├─► policy.is_mastered / next_objective        (policy.py:61/163)
      │       决定：这个点过关没？下一步教/复习啥？
      │
      └─► LearningStore.save          原子落盘       (storage.py:26)
              │
              ▼
        下次导师出题，就基于更新后的 LearningProgress
```

你会发现：**所有模块都围绕 `LearningProgress`（`models.py:185`）这一本账本读写**。判分往里写对/错，掌握度往里写分数，策略从里读来决定下一步，调度往里写复习计划——它是整个学习引擎的"事实中枢"。

## 38.11 给未来智能体开发者的启示

这一章你其实掌握了一套**"可评估的学习系统"设计范式**，它能用在任何需要"教人/教模型"的场景：

1. **把"知识"建模成有类型的对象**（`KnowledgeType`）：不同类型用不同评测方式。
2. **判分走确定性逻辑**（`grading.py`）：有标准答案就不要交给 AI 自由判。
3. **掌握度要"近因加权 + 证据封顶"**（`mastery.py`）：避免一次蒙对就误判。
4. **下一步决策集中在一个函数**（`next_objective`）：逻辑清晰、易测试。
5. **长任务/共享状态要原子落盘 + 版本锁**（`storage.py`）：防止并发与崩溃破坏数据。

把这五条记住，你未来做"自适应测验""员工培训 bot""模型能力评测"都能直接套。

## 自查清单

- [ ] 我能说出学习引擎的五个模块各自职责（grading/mastery/policy/scheduler/service）。
- [ ] 我知道 `KnowledgeType` 四种类型（`models.py:24`）及"量化 vs 定性"过关区别。
- [ ] 我理解 `grade_answer`（`grading.py:13`）按题型判分，且是确定性函数。
- [ ] 我明白掌握度为何要"近因加权 + 证据封顶"（`mastery.py:17/21/37`）。
- [ ] 我能说出 `next_objective`（`policy.py:163`）的优先级顺序（待学→复习→未掌握→完成）。
- [ ] 我知道间隔重复间隔序列 `INTERVAL_SEQUENCES`（`scheduler.py:13`）的含义。
- [ ] 我理解 `grade_and_record`（`service.py:161`）是"单一可信源"，串起判分→掌握→调度→落盘。
- [ ] 我知道 `storage.py` 用 `_path` 校验 `book_id`（`storage.py:21`）防路径穿越。
- [ ] 我明白 `pending_question` 的标准答案存在服务端、不经模型（`models.py:164`）。
- [ ] 我能画出自"答题"到"落盘"的整条学习引擎数据流。

> **提示 · 这一章的"隐藏主线"**
>
> 注意一个贯穿全章的设计哲学：**每个模块只做一件事，且输入输出都是清晰的数据结构（`models.py` 定义的那些类）**。判分不碰掌握度，掌握度不碰调度，调度不碰落盘。模块之间通过 `LearningProgress` 这本账本通信。这种"高内聚、低耦合"让每个模块都能单独测试、单独替换——你未来写任何复杂系统，都该追求这种清爽边界。
