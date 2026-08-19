---
title: "第 37 章 · \"活书\"引擎：把知识源自动编译成一本会生长的书"
date: 2026-08-01
summary: "读者画像：你完全不懂编程，但想成为智能体开发者。本章讲 DeepTutor 最神奇的一部分——它不会写死教材，而是**根据你给的源代码/资料，现场\"编译\"出一本结构化的书**，并且这书会随知识更新而\"生长\"。我们叫它\"活书（living book）\"。"
tags:
  - deeptutor
---
# 第 37 章 · "活书"引擎：把知识源自动编译成一本会生长的书

> 读者画像：你完全不懂编程，但想成为智能体开发者。本章讲 DeepTutor 最神奇的一部分——它不会写死教材，而是**根据你给的源代码/资料，现场"编译"出一本结构化的书**，并且这书会随知识更新而"生长"。我们叫它"活书（living book）"。

## 37.1 直觉：普通书和"活书"的区别

普通电子书是**写死的**：作者写好 HTML，读者只读。DeepTutor 的"活书"是**生成式的**：你给它一个 GitHub 仓库或一堆文档，它先"理解"这些内容，再自动规划出章节（Spine）、页面（Page），再在每页里填充各种"积木块"（Block：正文、测验、图示、代码……）。

为什么叫"活"？因为知识源会变（比如源码更新了），书可以重新编译、局部刷新，而不是整本重写。这也是 `deeptutor/book/` 这个模块存在的意义。

> **说明 · 三个核心名词**
>
> - **Book（书）**：最终成品，一本可教学的结构化书。
> - **Spine（书脊）**：书的"目录骨架"，由若干 Chapter（章）组成。
> - **Page（页）/ Block（块）**：一页由多个内容块拼成，块是最小教学单元。

## 37.2 数据模型：书是怎么被"定义"出来的

一切从 `deeptutor/book/models.py` 的一组枚举和模型开始。先看清"状态"和"类型"两套枚举：

```text
models.py:L29   class BookStatus(str, Enum):        # 整本书的状态
models.py:L38   class PageStatus(str, Enum):        # 单页的状态
models.py:L47   class BlockStatus(str, Enum):       # 单个块的状态
models.py:L55   class BlockType(str, Enum):         # 块的种类
models.py:L82   class ContentType(str, Enum):       # 内容性质（理论/推导/历史/练习…）
```

`BookStatus`（L29）描述整本书处在"构思中 / 编译中 / 就绪 / 出错"等阶段；`PageStatus`（L38）、`BlockStatus`（L47）同理细化到页和块。这种"每一层都有自己的状态机"的设计，让前端可以精确显示进度条。

`BlockType`（L55）定义了能生成哪些"积木"：

| 块类型 | 作用 | 直觉 |
| --- | --- | --- |
| TEXT | 正文段落 | 老师讲解 |
| CALLOUT | 重点提示框 | "注意！" |
| QUIZ | 小测验 | 考考你 |
| FIGURE | 图示 | 一图胜千言 |
| CODE | 代码块 | 看真实代码 |
| INTERACTIVE | 交互题 | 动手做 |
| FLASH_CARDS | 闪卡 | 记忆卡 |
| DEEP_DIVE | 深挖 | 进阶内容 |
| CONCEPT_GRAPH | 概念图 | 知识关系网 |

`ContentType`（L82）则标一块内容"是什么性质"：`THEORY`（理论）、`DERIVATION`（推导）、`HISTORY`（历史）、`PRACTICE`（练习）、`CONCEPT`（概念）、`OVERVIEW`（概览）。这让同一页可以混排"先讲理论、再给推导、最后练习"。

承载这些的模型类：

```text
models.py:L193   class Chapter(BaseModel):   # 一章
models.py:L255   class Spine(BaseModel):     # 书脊 = 多章
models.py:L326   class Block(BaseModel):     # 一个内容块
models.py:L363   class Page(BaseModel):      # 一页 = 多个块
models.py:L426   class Book(BaseModel):      # 一本书 = 书脊 + 页面
models.py:L299   class ExplorationReport:    # 探索知识源后的报告
models.py:L406   class Progress:             # 读者学习进度
```

注意它们都基于 `pydantic` 的 `BaseModel`——意思是：这些不是随便的字典，而是**有字段校验的数据结构**。这正是"编译"能可靠进行的前提：每个块、每页都有明确形状。

## 37.3 BookEngine：整本书的"总指挥"

`deeptutor/book/engine.py` 里的 `BookEngine` 是总指挥。它一出生就准备好了"编译器"：

```text
engine.py:L85    class _BookRuntime:                 # 每本书一个异步队列
engine.py:L100   class BookEngine:
engine.py:L112       options=compiler_options or CompilerOptions(phase=2),
```

`BookEngine.__init__` 里直接 `BookCompiler(CompilerOptions(phase=2))`（`engine.py:112`），即"第二阶段编译器"。`_BookRuntime`（`engine.py:85`）为每本书维护一个 `asyncio.Queue`，让"编译任务"可以排队、异步执行，不阻塞界面。

一本书的诞生分多个阶段，对应 `BookEngine` 的几个关键方法：

```text
engine.py:L200   async def create_book(...)          # 阶段1：构思出书的草稿
engine.py:L281   async def confirm_proposal(...)     # 阶段2：确认书的大纲提案
engine.py:L582   async def confirm_spine(...)        # 确认书脊（章结构），建空页壳
engine.py:L699   async def compile_page(...)         # 编译单页（填内容块）
engine.py:L773   async def _enqueue_pending_pages(...)  # 把待编译页入队
engine.py:L833   async def _worker_loop(...)         # 后台工人循环取任务编译
```

把它们连成一张流程图：

```text
用户给知识源
      │
      ▼
create_book (L200)  ──► 阶段1 构思：IdeationAgent 想主题
      │                   SourceExplorer 探源
      │                   SpineSynthesizer 拟大纲
      ▼
confirm_proposal (L281) ──► 你确认/微调大纲
      │
      ▼
confirm_spine (L582)  ──► 建"空页壳"，注入 Overview 章
      │                   auto_compile 触发
      ▼
_enqueue_pending_pages (L773) ──► 待编译页进队列
      │
      ▼
_worker_loop (L833) 不断取页 ──► compile_page (L699)
                                     │
                                     ▼
                              BookCompiler 逐块生成
```

> **提示 · 为什么用"队列 + 工人循环"**
>
> 一本大书可能几百页，不可能瞬间生成完。`_enqueue_pending_pages` 把活儿排进队，`_worker_loop` 在后台一块块做。这样既不会卡死界面，也方便"先出一页给你看，后面继续编译"。这是**生产者—消费者模型**，你以后写任何"慢慢生成大内容"的系统都会用到。

## 37.4 BookCompiler：真正"写"书的编译器

`deeptutor/book/compiler.py` 是落地的编译器。`CompilerOptions`（`compiler.py:46`）控制编译行为，`BookCompiler`（`compiler.py:69`）是执行者。

核心方法是 `compile_page`（`compiler.py:88`）：它先"按需规划"这页要哪些块，再逐个生成，每生成一个就立刻持久化（防止中途崩溃丢进度）。

```text
compiler.py:L88    async def compile_page(self, page, ...)
compiler.py:L194   async def _generate_block(self, block, ...)
compiler.py:L216       generator = self.registry.get(block.type)   # 按块类型找生成器
compiler.py:L253   def attach_bridge_text(...)                     # 给块之间加过渡文字
compiler.py:L305   def _plan_if_needed(...)                       # 这页没规划就先规划
compiler.py:L348   def _finalize_page_status(page)                # 定页状态：就绪/部分/出错
```

`_generate_block`（`compiler.py:194`）是最妙的一行：`self.registry.get(block.type)`（`compiler.py:216`）。意思是：**块的类型决定了"谁来做它"**。正文块交给正文生成器，测验块交给测验生成器——这就是"注册表模式（registry pattern）"。

`_finalize_page_status`（`compiler.py:348`）给整页下最终结论：`READY`（齐活）、`PARTIAL`（部分完成）、`ERROR`（出错）。即使某个块失败，页面也不会整体崩掉，而是标记为部分完成——非常稳健。

### 37.4.1 一个块是怎么被"写"出来的

把 `_generate_block`（`compiler.py:194`）的内部步骤摊开看，会发现它非常"克制"：

1. 拿到 `block.type`（比如 `QUIZ`）。
2. `self.registry.get(block.type)`（`compiler.py:216`）查出对应工匠。
3. 调工匠的 `generate`，把 LLM 产出的内容填进块。
4. `attach_bridge_text`（`compiler.py:253`）在块与块之间补一句过渡话（让书读起来连贯，不像积木硬拼）。
5. 立刻把这块持久化，再生成下一块。

这种"生成即保存"的节奏，是容错的关键：哪怕第 5 块时进程被杀，前 4 块也已经落盘，重启后接着做就行。

> **说明 · "生成即保存"原则**
>
> 别等全部做完再一次性写入。每完成一个小单元就存一次盘。长任务里这是保命习惯——你永远不知道下一秒会不会断电、崩溃或被用户强制退出。

## 37.5 块生成器注册表：一块一"工匠"

`deeptutor/book/blocks/base.py` 定义了"块生成器"的抽象与注册表：

```text
blocks/base.py:L75    class BlockContext:                    # 生成某块时的上下文
blocks/base.py:L116   class BlockGenerator(ABC):             # 抽象基类：每个块一种工匠
blocks/base.py:L164   class BlockGeneratorRegistry:          # 注册表：类型→生成器
blocks/base.py:L183   def get_block_registry() -> ...         # 取全局注册表
blocks/base.py:L190   def _build_default_registry() -> ...    # 默认注册全部工匠
```

`BlockGenerator`（`blocks/base.py:116`）是所有"块工匠"的父类，子类只需实现 `generate`；`_build_default_registry`（`blocks/base.py:190`）把 Text / Callout / Quiz / Code / Figure / Timeline / FlashCards / DeepDive / ConceptGraph / Section 等生成器**一一登记**到注册表里。

配合前面 `_generate_block` 里的 `self.registry.get(block.type)`（`compiler.py:216`），整个链条就通了：

```text
BookCompiler 想生成一块
      │  知道 block.type = "QUIZ"
      ▼
registry.get("QUIZ")  ──► 找到 QuizGenerator
      │
      ▼
QuizGenerator.generate(...)  ──► 产出一道测验块
```

> **说明 · 注册表模式一句话**
>
> "**按名字查工匠**"。新增一种块？写个新生成器、去注册表登记即可，编译器一行都不用改。这是可扩展架构的典型套路。

## 37.6 页面规划：这页该放哪些块

不是随便塞块。`deeptutor/book/agents/page_planner.py` 负责"规划一页的内容结构"：

```text
page_planner.py:L60    _PHASE1_TYPES = ...                  # 第一阶段允许的块类型
page_planner.py:L74    _TEMPLATES_V2 = ...                 # ContentType → (块类型, 参数) 模板
page_planner.py:L167   def _build_block(...)                # 按模板造一个块
page_planner.py:L191   def _static_plan(...)                # 静态规划（不调 LLM）
page_planner.py:L256   class SectionArchitect:              # 章节架构师
page_planner.py:L357   class PagePlanner:                   # 页面规划师
```

关键在 `_TEMPLATES_V2`（`page_planner.py:74`）：它是一张"**内容性质 → 该放哪些块**"的映射表。比如"理论"页可能安排 [概述块, 正文块, 重点框]，而"练习"页安排 [正文块, 测验块, 闪卡]。这样每页结构有章法，不是 LLM 天马行空。

`SectionArchitect`（`page_planner.py:256`）管"这一章里各页怎么排"，`PagePlanner`（`page_planner.py:357`）管"单页内部块怎么排"。两者配合，书就有了层次。

## 37.7 上游三件套：构思、探源、拟大纲

`BookEngine.create_book` 背后站着三个 Agent（智能体）：

```text
ideation_agent.py:L20    class IdeationAgent:        # 构思：这本书讲什么
ideation_agent.py:L41    def process(...)            # 产出书主题/提案
source_explorer.py:L97   class SourceExplorer:       # 探源：读懂知识源
source_explorer.py:L131  def explore(...)            # 产出探索报告
spine_synthesizer.py:L82 class SpineSynthesizer(BaseAgent):  # 拟大纲
spine_synthesizer.py:L114 def synthesize(...)        # 草稿→批评→修订
```

`IdeationAgent`（`ideation_agent.py:20`）想出"这本书该讲啥"；`SourceExplorer`（`source_explorer.py:97`）把你的源码/文档读一遍，产出 `ExplorationReport`（`models.py:299`）；`SpineSynthesizer`（`spine_synthesizer.py:82`）则用"草稿→批评→修订"（`synthesize` 里 `_draft/_critique/_revise`）的方式把大纲打磨可靠——和写论文先打草稿再自我审稿一个道理。

> **提示 · 智能体的"自我审稿"**
>
> `SpineSynthesizer` 不是一次生成就完事，而是先写 `_draft`、再 `_critique` 挑毛病、最后 `_revise` 改。这种"生成—批评—修订"循环，是高质量 AI 内容的通用手法，你写任何生成式系统都可借鉴。

## 37.8 事件流：让前端"实时看到"编译进度

编译是慢活，前端要能实时显示"正在生成第 3 页第 2 块"。靠的是 `deeptutor/book/streaming.py` 的事件流：

```text
streaming.py:L17    SOURCE = "book_engine"          # 事件来源标识
streaming.py:L21    STAGE_IDEATION = "ideation"     # 阶段：构思
streaming.py:L28    STAGE_COMPILATION = "compilation"  # 阶段：编译
streaming.py:L29    STAGE_BLOCK = "block"           # 阶段：单块
streaming.py:L33    class BookStream:               # 书事件流
streaming.py:L94    async def book_event(...)       # 发一条书事件
```

每当进入一个新阶段（如 `STAGE_COMPILATION`）或生成一个块（`STAGE_BLOCK`），代码就调 `book_event`（`streaming.py:94`）广播一条事件。前端订阅这些事件，就能把进度条、转圈圈、逐块出现的效果做出来。这和第 20 章讲的"事件流"是同一套机制，只是来源标成了 `book_engine`（`streaming.py:17`）。

## 37.9 知识健康：书会不会"过期"

知识源会变，书也得知道自己"是否还跟得上源"。`deeptutor/book/kb_health.py` 负责这事：

```text
kb_health.py:L68    def fingerprint_kbs(...)           # 给知识源算"指纹"
kb_health.py:L102   def detect_kb_drift(...)           # 检测源是否漂移（变了）
kb_health.py:L155   def refresh_book_fingerprints(...) # 刷新书的指纹
kb_health.py:L255   def scan_log_health(...)           # 扫描日志健康度
```

`fingerprint_kbs`（`kb_health.py:68`）给知识源算一个"指纹"（类似内容摘要哈希）；`detect_kb_drift`（`kb_health.py:102`）比较新旧指纹，发现源变了就提示"这本书该重编译了"。这就是"活书"能"活"的技术支点——它知道自己何时该刷新。

## 37.10 存储：编译好的书落在哪

和别的模块一样，书也用原子写（atomic write）落盘。`deeptutor/book/storage.py` 顶部注释（`storage.py:7`）描述了目录结构：`book_{id}/manifest.json`、`spine.json`、`pages/` 等。关键方法：

```text
storage.py:L65    class BookStorage:
storage.py:L83    def list_book_ids(...)             # 列出所有书
storage.py:L98    def save_book(...)                 # 存整本书
storage.py:L104   def load_book(...)                 # 读整本书
storage.py:L44    def _atomic_write_json(...)        # 原子写，防写崩
```

`_atomic_write_json`（`storage.py:44`）先把内容写临时文件、再改名覆盖，确保"要么旧版、要么新版"，绝不会写出半截损坏的 JSON——这对"编译到一半断电"的场景至关重要。

## 37.11 状态机：每一层都有自己的"进度条"

回到 37.2 的枚举，我们把三套状态对照着看，能更理解"活书"是怎么被监控的：

| 层级 | 枚举 | 典型取值 |
| --- | --- | --- |
| 书 | `BookStatus` (`models.py:29`) | DRAFT / COMPILING / READY / ERROR |
| 页 | `PageStatus` (`models.py:38`) | PENDING / COMPILING / READY / PARTIAL / ERROR |
| 块 | `BlockStatus` (`models.py:47`) | PENDING / GENERATING / READY / ERROR |

为什么层层都有状态？因为一本大书是"逐页、逐块"慢慢生成的。前端只要读这些状态，就能精确画出"书 60%、第 3 页生成中、第 2 块失败"这样的细粒度进度。状态机让"不确定的长任务"变得**可观测、可恢复**。

> **提示 · 长任务的第一原则**
>
> 任何"可能跑很久的生成任务"，都要给每个粒度（整体/页/块）配状态，并支持"部分成功"。DeepTutor 的 `_finalize_page_status`（`compiler.py:348`）即使某块失败也标记为 `PARTIAL` 而非全崩，正是这个原则的体现。

## 37.12 串起来：从仓库到一本书（端到端）

把全章串成一条完整链路，你就拥有了一张"活书全景图"：

```text
你提供：一个 GitHub 仓库 / 一堆文档
      │
      ▼
[1] IdeationAgent 构思主题        (ideation_agent.py:20)
[2] SourceExplorer 读源出报告      (source_explorer.py:97)
[3] SpineSynthesizer 拟大纲        (spine_synthesizer.py:82)
      │  BookEngine.create_book (engine.py:200)
      ▼
你确认大纲 (confirm_proposal, engine.py:281)
      │
      ▼
[4] confirm_spine 建空页壳         (engine.py:582)
[5] PagePlanner 规划每页块结构      (page_planner.py:357)
      │
      ▼
[6] _worker_loop 后台取页           (engine.py:833)
[7] BookCompiler.compile_page       (compiler.py:88)
[8] registry.get(type) 找工匠生成块 (compiler.py:216)
[9] book_event 实时广播进度          (streaming.py:94)
      │
      ▼
[10] BookStorage 原子落盘            (storage.py:98)
      │
      ▼
你读到一本结构化、可交互的"活书" 📖
      │
      │  (日后源码变了)
      ▼
[11] kb_health 检测漂移，提示重编译  (kb_health.py:102)
```

## 37.13 给未来智能体开发者的启示

读完这章，你掌握的不是一个"书的模块"，而是一套**通用范式**：

1. **内容即数据**：用 `pydantic` 模型（`models.py`）把"书/页/块"定义清楚，后续所有逻辑才有抓手。
2. **生成即流水线**：把大任务拆成"构思→规划→逐块生成→落盘"，用队列异步推进。
3. **可扩展靠注册表**：新增内容类型不必改编译器，只去注册表登记新工匠。
4. **长任务要可观测**：用事件流 + 分层状态机，让用户随时知道进度、让系统能从部分失败中恢复。

这套思路，换个领域（比如"自动生成测试用例""自动生成 API 文档"）完全能复用。

## 自查清单

- [ ] 我能用一句话解释"活书（living book）"和普通电子书的区别。
- [ ] 我知道 Book 的四个层级：Book → Spine(Chapter) → Page → Block（`models.py:426/255/363/326`）。
- [ ] 我理解 `BlockType`（`models.py:55`）和 `ContentType`（`models.py:82`）各自的用途。
- [ ] 我能说出 `BookEngine` 造书的几个阶段方法：`create_book`/`confirm_spine`/`compile_page`（`engine.py:200/582/699`）。
- [ ] 我理解"注册表模式"：`compiler.py:216` 的 `self.registry.get(block.type)` 如何按类型找生成器。
- [ ] 我知道页面规划靠 `_TEMPLATES_V2`（`page_planner.py:74`）决定每页放哪些块。
- [ ] 我明白 `SpineSynthesizer` 用"草稿→批评→修订"循环（`spine_synthesizer.py:114`）打磨大纲。
- [ ] 我知道编译进度通过 `book_event`（`streaming.py:94`）实时广播给前端。
- [ ] 我理解"知识健康"靠 `fingerprint_kbs`/`detect_kb_drift`（`kb_health.py:68/102`）发现书过期。
- [ ] 我知道书用原子写落盘（`storage.py:44`），避免写一半损坏。
