---
title: "第 26 章 · 三层长期记忆 L1/L2/L3"
date: 2026-08-01
summary: "**黑话解释**：\"门面模式（Facade）\"是一种代码组织方式——把一堆复杂的内部功能包装成一个简单的对外接口，调用方不用关心内部怎么实现。`MemoryStore` 就是这个门面，定义在 `deeptutor/services/memory/store.py:68`。"
tags:
  - deeptutor
---
# 第 26 章 · 三层长期记忆 L1/L2/L3

你有没有过这种感觉：换一个新智能体，它好像完全不认识你。你昨天跟它说过"我喜欢用例子讲概念"，今天它又从头问一遍。DeepTutor 想解决的问题就是这个：让智能体**记住你是谁、你在学什么、你偏好什么**，并且这种记忆能跨会话长期存在。

本章我们拆解 DeepTutor 的"三层长期记忆"系统。读完你会明白：记忆不是把聊天记录全存下来，而是像人一样**分层沉淀**——先记流水账，再提炼要点，最后归纳成档案。

## 先建立直觉：记忆为什么分三层

想象一个学生在记笔记：

- **L1（原始痕迹）**：上课时随手记下的每一句话、每一个动作，按时间顺序堆在草稿本上，原封不动，绝不修改。
- **L2（表面摘要）**：课后把某一门课的草稿整理成"这门课我学到了什么"的小结。
- **L3（综合档案）**：期末把好几门课的小结，归纳成"我是谁、我在学什么、我有什么偏好"的正式档案。

DeepTutor 用的就是这个思路。代码里把这套系统放在 `deeptutor/services/memory/` 目录，整个子系统的职责说明写在 `deeptutor/services/memory/__init__.py:1`。对外入口是一个叫 `MemoryStore` 的门面类（"门面"的意思：外面的人只跟它打交道，它再去调度内部细节）。

> **黑话解释**："门面模式（Facade）"是一种代码组织方式——把一堆复杂的内部功能包装成一个简单的对外接口，调用方不用关心内部怎么实现。`MemoryStore` 就是这个门面，定义在 `deeptutor/services/memory/store.py:68`。

## L1：原始痕迹（trace）

L1 是记忆的**最底层**，也是最忠实的一层。它的工作只有一个：**把发生过的事件原样记下，绝不加工**。

关键代码在 `deeptutor/services/memory/trace.py`。它有几个重要特点：

- **追加式写入（append-only）**：事件只能往末尾加，不能修改、不能删除。这就是为什么叫"痕迹"——像脚印一样，踩下去就留下了。见 `deeptutor/services/memory/trace.py:66` 的 `append` 函数。
- **每天一个文件**：同一个"面（surface）"当天的事件都写进 `YYYY-MM-DD.jsonl` 这个文件。`.jsonl` 是"每行一个 JSON"的格式，方便一行行读取。见 `deeptutor/services/memory/trace.py:69`。
- **绝不拖累主流程**：记录记忆这件事如果出错，绝不能让用户的对话卡住。所以 `append` 函数用 `try/except` 把错误吞掉只记日志，见 `deeptutor/services/memory/trace.py:73`。
- **按面加锁串行写**：同一进程里多个回合同时记同一面的痕迹时，用 `asyncio.Lock` 保证不会把两行 JSON 交错写坏，见 `deeptutor/services/memory/trace.py:27` 的 `_lock_for`。
- **多面并存**："面（surface）"指 DeepTutor 里不同的功能场景，比如聊天（chat）、笔记（notebook）、测验（quiz）、知识库（kb）、书籍（book）、伙伴（partner）、协作写作（cowriter）。这些面在 `deeptutor/services/memory/paths.py:33` 用 `Surface` 类型枚举出来。

每个 L1 事件是一个 `TraceEvent` 对象，包含：事件 id、时间戳、属于哪个面、事件类型、具体内容、关联的会话和回合。见 `deeptutor/services/memory/trace.py:35`。

除了写入，`trace.py` 还提供了一组"读取"辅助函数，供上层整理记忆时挑选范围：

- `iter_since(surface, since)`：按时间顺序遍历某个面、某个时间点之后的事件，见 `trace.py:89`；
- `iter_by_ids(ids)`：跨面按 id 把事件找回来（溯源时用），见 `trace.py:115`；
- `count_since(surface, since)`：统计某面最近有多少条新事件（用来算"积压量"），见 `trace.py:131`；
- `latest_ts(surface)`：取某面最近一次事件的时间戳，见 `trace.py:135`。

下面是 L1 → L2 → L3 的整体流向，用一段缩进图表示：

```text
用户在各面操作（聊天/笔记/测验/读书…）
        │
        ▼
   L1 原始痕迹（trace）
   trace/<面>/<日期>.jsonl   （原样追加，永不修改）
        │   consolidate（整理）
        ▼
   L2 表面摘要（每面一份）
   L2/<面>.md               （提炼这一面学到的要点）
        │   consolidate（再提炼）
        ▼
   L3 综合四文档（跨面合并）
   L3/recent.md    最近动态
   L3/profile.md   用户画像
   L3/scope.md     知识范围
   L3/preferences.md  偏好（手动写，不自动整理）
        │   注入
        ▼
   下一回合的 system prompt（让智能体"认得你"）
```

## L2：表面摘要（consolidator）

L1 是流水账，量大但"没消化"。L2 负责把某一面最近的痕迹**提炼成要点**，写成一份 markdown 文档，文件名是 `L2/<面>.md`。

### 文档长什么样：脚注式引用

L2/L3 文档不是随便的 markdown，而是带"脚注引用"的结构化格式。规则写在 `deeptutor/services/memory/document.py:1`：

```text
# <标题>

## <板块名>
- <要点文字> [^1][^2] <!--m_xxx-->
- <要点文字> [^3]     <!--m_yyy-->

---

[^1]: notebook:abc
[^2]: chat:def
[^3]: chat:ghi
```

也就是说：每条要点后面挂一串 `[^n]` 脚注，文档末尾再列出每个脚注对应哪条 L1 痕迹（比如 `chat:def`）。条目本身还有一个隐藏的 `<!--m_xxx-->` 锚点，就是它的唯一 id（`Entry` 类定义在 `document.py:64`）。这套格式让"每条记忆都能溯源到原始事件"成为可能。

### 提炼过程

做这件提炼工作的模块叫 `consolidator`（"整合器"），主入口在 `deeptutor/services/memory/consolidator/`。核心算法在 `deeptutor/services/memory/consolidator/modes/update.py:80` 的 `run_update` 函数，它大致分这几步：

1. **算"新增"**：把这次整理和上一次之间新增的痕迹挑出来，靠 `*.meta.json` 里记的"已处理 id 集合"做差集。见 `deeptutor/services/memory/consolidator/modes/update.py:150`。
2. **切块（chunk）**：如果新增内容太多，按字数预算切成几块，但**绝不从段落中间切断**。见 `deeptutor/services/memory/consolidator/modes/update.py:197` 调用 `chunk_with_boundary`。
3. **逐块调用 LLM 提取事实**：每块发给语言模型，让它返回"事实清单"。见 `deeptutor/services/memory/consolidator/modes/update.py:254` 的 `call_llm`。
4. **校验引用**：每条事实必须能指向一条 L1 痕迹（溯源），不合格的会被丢掉。见 `deeptutor/services/memory/consolidator/modes/update.py:266` 的 `validate_fact_refs`。
5. **原子写入**：用 `AddOp` 把事实追加进文档，整块成功才落盘。见 `deeptutor/services/memory/consolidator/modes/update.py:288`。

### 元信息副档：靠"已见过哪些 id"避免重复

每次整理后，DeepTutor 会在 `L2/<面>.meta.json` 记下一个"已见 id 集合"。下一次整理时，只处理"没见过的"，而不是全量重扫。这套 sidecar 机制在 `deeptutor/services/memory/consolidator/meta.py:1` 说明，`L2Meta` 的定义见 `meta.py:54`，落盘函数在 `meta.py:68`。L3 同理，只不过它按"面"分别记已见 id（`L3Meta` 见 `meta.py:88`，保存见 `meta.py:102`）。

> **提示 · 为什么"可追溯"很重要？**
>
> 每条 L2 要点下面都挂着指向 L1 原始痕迹的引用（例如 `chat:01HX...`）。这意味着：**智能体说的每一句关于你的话，都能翻回原始记录去核对**。这既防止了"记忆编造"，也让用户能在界面上检查"它凭什么这么说"。L3 指向 L2 文件，L2 再指向 L1 痕迹，形成一条最多三跳的溯源链（见 `deeptutor/services/memory/consolidator/modes/update.py:466` 的注释）。

### 原子操作：加 / 改 / 删

L2/L3 的写入是"增量追加"——新的事实不断加进去，而不是每次重写整份文件。这靠 `deeptutor/services/memory/ops.py` 里的"操作（op）"机制实现：一次可以批量做"加 / 改 / 删"三种操作，要么全部成功，要么全部不做（原子性）。

- `AddOp`（加一条，见 `ops.py:24`）、`EditOp`（改一条，见 `ops.py:32`）、`DeleteOp`（删一条，见 `ops.py:40`）。
- 加操作有字数上限（`_MAX_TEXT_LEN = 240`，见 `ops.py:18`），删操作的原因必须是限定集合之一（`_DELETE_REASONS`，如 `contradicted`/`superseded`/`stale`，见 `ops.py:20`）。
- 一批操作里如果"同一 id 既改又删"，直接整体拒绝——防止模型自相矛盾。校验在 `_validate`，见 `ops.py:68`；真正执行在 `apply`，见 `ops.py:120`。

### 还有 audit / dedup / merge 三种模式

`consolidator` 不止"更新"一种动作，还提供：

- `run_audit`：逐行对照原始证据审计现有文档；
- `run_dedup`：迭代式合并/删除重复条目（`DedupResult` 见 `deeptutor/services/memory/consolidator/modes/dedup.py:43`，零编辑时提前停止省 token）；
- `run_merge`：合并相邻相似条目。

更新成功后默认会自动触发去重（由 settings 里的 `dedup.auto_after_update` 控制），见 `update.py:325`。

## L3：综合四文档（snapshot）

L3 是记忆的**最高层**，也是最"像档案"的一层。它不再按面分文件，而是按**用途**分成四份，都放在 `L3/` 目录：

- `recent.md`：最近动态摘要
- `profile.md`：用户画像（你是谁、水平如何）
- `scope.md`：知识范围（你已经掌握了哪些领域）
- `preferences.md`：偏好（你喜欢的讲解风格、拒绝过的选项）

四份文档的清单名称定义在 `deeptutor/services/memory/paths.py:39` 的 `L3Slot`。从 L2 升到 L3 的逻辑同样在 `update.py`，由 `_run_update_l3` 驱动，见 `deeptutor/services/memory/consolidator/modes/update.py:363`。它把**所有面**的 L2 文档收集起来，挑出新增条目，再提炼成对应槽位（slot）的 L3 内容。

> **注意一个例外**：`preferences.md` 是**手动写、不自动整理**的。代码里明确禁止对它做自动整合，见 `deeptutor/services/memory/store.py:154`（`raise ValueError("preferences.md is not auto-consolidated")`）。原因是偏好是用户明确表达的东西，不该被模型"重新解读"。写偏好走专门的 `write_preference` 接口，见 `deeptutor/services/memory/store.py:194`。而且为了避免同一偏好被反复写入变成重复条目，`write_preference` 会先做"去重判断"，见 `store.py:222` 的 `_find_duplicate_preference`。

另外有一个细节值得提：L3 的引用只指到 **L2 文件级别**，而不细到 L2 的某一条。代码注释说这是为了给用户一条"干净的引用链"。见 `deeptutor/services/memory/consolidator/modes/update.py:466`。

## Memory Graph：一张可溯源的记忆网

把前面三层的引用关系串起来，就得到一张"记忆图谱（Memory Graph）"：

```text
L3/profile.md  ──"见 L2/profile 的要点"──▶  L2/profile.md
L2/profile.md  ──"依据 chat:01HX..."──▶       L1 痕迹 trace/chat/...jsonl
                                                  │
                                          原始聊天原文（真相之源）
```

换句话说：L3 说"你是什么样的人"，它引用 L2 说"这是从哪门课小结来的"，L2 再引用 L1 说"这是哪天的哪句话"。**任何一层结论都能一路追到原始对话**。这就是"可溯源"——不是一句空话，而是文件之间用 id 串起来的硬链接。

快照子系统（snapshot）负责给 L1 做"当前状态 vs 上次状态"的差异记录，文件在 `deeptutor/services/memory/snapshot/store.py`。它维护 `state.json`（当前实体的指纹映射）和 `changes.jsonl`（变更日志），见 `deeptutor/services/memory/snapshot/store.py:39`。整合器据此判断"哪些 L1 内容还没被 L2 消化"。

## 记忆如何"注入"智能体，实现个性化

记忆存好了，关键是用起来。DeepTutor 在**每个回合开始时**把 L3 记忆读出来，塞进给模型的系统提示（system prompt），让模型这一轮"带着对你的了解"来回答。

这个注入点发生在会话运行时 `turn_runtime.py`。流程是：

1. 前端在请求里带上 `memory_references`（用户希望本回合启用哪些记忆槽位）。见 `deeptutor/services/session/turn_runtime.py:172` 的 `_extract_memory_references`。
2. 只要有记忆槽位被勾选，就调用 `read_l3_concat()` 把四份 L3 文档拼成一段文本。见 `deeptutor/services/session/turn_runtime.py:1402`。
3. 这段文本被装进 `UnifiedContext.memory_context` 字段。见 `deeptutor/services/session/turn_runtime.py:1664`。
4. `UnifiedContext` 是贯穿整个回合的"上下文大包裹"，定义在 `deeptutor/core/context.py:34`。`memory_context` 这个字段在 `deeptutor/core/context.py:80`。

`read_l3_concat` 本身在 `store.py`，它把四份 L3 文档按顺序拼接，如果一份都没有就返回提示语"还没有记忆"。见 `deeptutor/services/memory/store.py:93`。而在前端能直接用的 `read_memory` / `write_memory` 工具，最终也是调用同一个 `read_l3_concat`，见 `deeptutor/tools/builtin/__init__.py:751` 和 `:764`、`deeptutor/tools/builtin/__init__.py:818`。

> **说明 · 对照 Pi：为什么"无内置长期记忆"是短板？**
>
> 很多通用助手（比如你单独用 Pi 这类纯聊天产品）每次对话都是"白纸一张"——它们要么不存长期记忆，要么记忆是产品方黑盒、你无法查看和纠正。DeepTutor 的设计反其道而行：记忆是**分层的、可溯源的、用户可编辑的**。你可以在"记忆"页面直接增删 L2/L3 的条目，也能看到每条记忆背后的原始痕迹。这种"看得见、改得了"的长期记忆，正是教育智能体能做到"因材施教"的基础。

## 一个运维细节：多用户隔离与迁移

DeepTutor 支持多用户。记忆的存储路径不是写死的，而是通过 `PathService` 在**调用时**解析到"当前用户"的目录。代码在 `deeptutor/services/memory/paths.py:60` 的 `memory_root`。还有一个巧妙的设计：当用户以"伙伴（partner）"身份运行时，它读的是**拥有者**的记忆，而不是伙伴自己空白的记忆空间——这是通过 `memory_path_service_override` 上下文管理器实现的，见 `deeptutor/services/memory/paths.py:30`。

另外，升级时旧版记忆文件（v1 的两文件格式）会被自动迁移到 `memory/backup/<时间戳>/`，见 `deeptutor/services/memory/store.py:330` 的 `migrate_v1_if_needed`；历史上 `tutorbot` 这个旧面名也曾被重命名为 `partner`，见 `store.py:359` 的 `migrate_partner_surface_if_needed`。这些迁移都是幂等的——跑过一次就不会再动。

## store.py：记忆系统的对外方法一览

前面看到的内存逻辑，绝大多数都通过 `MemoryStore` 这个门面暴露。除了一开始提到的 `emit`（写 L1）、`read_l3_concat`（拼 L3），它还提供了一批读写 L2/L3 的方法：

- `read_doc(layer, key)` / `read_raw(layer, key)`：读取某层某文档，不存在就返回空文档或空串，见 `deeptutor/services/memory/store.py:81` 和 `:87`；
- `overwrite_doc(layer, key, md)`：用户在记忆工作台里手动保存（整篇覆盖），见 `store.py:106`；
- `delete_entry(layer, key, entry_id)`：删除文档里某一条记忆，见 `store.py:112`；
- `update_l2(surface, ...)` / `update_l3(slot, ...)`：触发 L2/L3 的自动整合（consolidate），见 `store.py:125` 和 `:144`；
- `apply_ops_payload(layer, key, ops)`：先预览、再应用的"两步式"编辑流（工作台用），见 `store.py:165`；
- `overview()`：返回所有 L2/L3 文档的概览（是否存在、条目数、积压量），见 `store.py:261`。

> **提示 · 为什么 L2/L3 既能"自动整合"又能"手动编辑"？**
>
> 自动整合让记忆持续从痕迹里生长；手动编辑让你能纠正模型可能的偏差。两者不冲突：`overwrite_doc` 和 `delete_entry` 是用户直接改，`update_l2/update_l3` 是系统自动长。幂等锁（`_lock_for`，见 `store.py:318`）保证同一文档同一时刻只有一个写入者，不会互相覆盖。

## 记忆的可调设置

整合器不是写死参数的，而是从一个"设置"对象读。定义在 `deeptutor/services/memory/settings.py`。值得记住的几个旋钮：

- `UpdateSettings`：L2/L3 整合时的"字符预算"（l2_budget=20、l3_budget=10），见 `settings.py:21`；
- `DedupSettings`：去重迭代次数（默认 3）以及"更新后是否自动去重"，见 `settings.py:33`；
- `MergeSettings`：合并（把重复引用折叠成一个脚注）在哪些动作后自动跑，见 `settings.py:39`；
- `ChunkingSettings`：切块时的重叠比例、边界（段落/句子）、最小/最大字符数，见 `settings.py:48`；
- `ReferenceSettings`：是否强制要求每条事实带引用、是否丢弃非法引用，见 `settings.py:56`。

这套设置统一存在 `data/user/settings/main.yaml` 的 `memory:` 子树下，前端"记忆设置"页面读写的就是它（见 `settings.py:1` 的说明）。算法代码只通过 `load_memory_settings()` 取用，从不在模块里写死常量。

## 记忆更新的触发时机

记忆不是自动发生的，也不是每句话都立刻整理。它的触发点主要在两个地方：

1. **手动触发**：用户在"记忆"页面点"更新"，前端调后端的 consolidator 运行接口。路由在 `deeptutor/api/routers/memory.py`：概览 `GET /overview`（见 `:84`）、读文档 `GET /doc/{layer}/{key}`（见 `:140`）、手动覆盖 `PUT /doc/...`（见 `:151`）、删条目 `DELETE /doc/.../entry/{id}`（见 `:159`）、启动整合任务 `POST /runs/start`（见 `:308`）。
2. **会话运行时顺带写入**：会话里的 RAG 查询、聊天等事件会经 `get_memory_store().emit(...)` 落进 L1 痕迹（如 `service.py:151` 的 RAG 查询痕迹），之后再择机整合到 L2/L3。

```text
用户行为 / 会话事件
   │
   ├─ 聊天、检索、笔记… → emit(TraceEvent) → L1 痕迹
   │
   └─ 用户点"更新记忆" → POST /runs/start
                              │
                              ▼
                   consolidator.run_update（L1→L2→L3）
                              │
                              ▼
              记忆文档更新 + meta.json 记录"已见 id"
```

## L1 痕迹的读取与溯源

记忆整合时要"挑出新增的、没处理过的痕迹"，靠的是 `trace.py` 里的一组读取函数（这些函数在 consolidator 算"新增"时被调用）：

- `iter_since(surface, since)`：按时间顺序遍历某面、某个时间点之后的事件，见 `deeptutor/services/memory/trace.py:89`；
- `iter_by_ids(ids)`：跨面按 id 把事件找回来——溯源时从一条 L2 引用反查原始 L1 事件就靠它，见 `trace.py:115`；
- `count_since(surface, since)`：统计某面最近有多少条新事件，用来算"积压量"（积压 = 上次整合后新增的痕迹数），见 `trace.py:131`；
- `latest_ts(surface)`：取某面最近一次事件的时间戳，见 `trace.py:135`。

这些函数都做了"读坏也不崩"的处理：文件缺了、某一行 JSON 坏了，就跳过而不是抛异常（见 `trace.py:111` 的 `except OSError`）。因为记忆读取是后台活儿，绝不值得为它打断主流程。

## 文档的解析与序列化

L2/L3 文档不是随便的 markdown，而是带"脚注引用"的结构化格式，由 `deeptutor/services/memory/document.py` 负责解析和写回：

- 文档格式约定（每条要点挂 `[^n]` 脚注、文末列 ` [^n]: ref`、要点带 `<!--m_xxx-->` 锚点）写在 `document.py:1`；
- `Entry` 是单条记忆的数据类（id / section / text / refs），见 `document.py:64`；
- 解析用的正则（如条目 id 形如 `m_xxx`、脚注标记 `\[\^n\]`）见 `document.py:41` 和 `:50`；
- 关键性质：`serialize(parse(x))` 是幂等的——同一份文档解析再写回，内容不变（见 `document.py:32` 的说明），这保证了"读→改→写"循环不会悄悄损坏文档。

## 一个具体例子：三天学微积分

把前面所有零件串成一个场景，你就能直观感受三层记忆怎么工作：

```text
第 1 天：用户在 chat 面问了 5 道微积分题
   → 5 条 L1 痕迹写入 trace/chat/Day1.jsonl
   → 用户点"更新记忆"
   → consolidator 把 Day1 痕迹提炼成 L2/chat.md 的 3 条要点
     （每条挂 chat:xxx 引用，指回 Day1 痕迹）

第 2 天：用户在 notebook 面记了"泰勒展开笔记"
   → L1 痕迹写入 trace/notebook/Day2.jsonl
   → 整合出 L2/notebook.md
   → L3/scope.md 被更新："用户正在学微积分，含泰勒展开"

第 3 天：用户问"你还记得我学到哪了吗？"
   → 前端勾选 memory_references=[profile, scope]
   → 运行时 read_l3_concat 把 L3 四文档拼好
   → 注入 system prompt
   → 模型答："你这两天在学微积分，笔记里记了泰勒展开…"
       （每句都能经 L2 → L1 溯源核对）
```

注意：第 3 天模型"认得你"，**不是因为它记住了聊天原文，而是因为 L3 档案被注入了 prompt**。这正是长期记忆的本质——把沉淀好的档案，在每次对话开始时喂给模型。

## 常见误区

- **误区一："记忆就是把聊天记录全存下来。"** 错。L1 只存"事件痕迹"（带类型的结构化记录），L2/L3 更是提炼后的要点，不是原始对话堆砌。
- **误区二："记忆会自动实时更新。"** 不全对。L1 是实时写的，但 L2/L3 的提炼通常由用户手动触发或择机运行（`update_l2/update_l3`），不是每句话都立刻整合。
- **误区三："模型自己决定记什么。"** 不对。L2/L3 的每条事实都必须带合法的 L1 引用，非法引用会被 `validate_fact_refs` 丢弃（见 `update.py:266`），防止模型凭空编造记忆。
- **误区四："记忆是全局共享的。"** 错。记忆按用户隔离（`paths.memory_root` 经 PathService 解析到当前用户），多用户之间互不串扰。

## 用户能直接用的记忆工具

记忆不是只能后台自动跑，用户（和模型）也能主动读写。DeepTutor 在 `deeptutor/tools/builtin/__init__.py` 里提供了两个内置工具：

- `read_memory`：读取 L3 综合记忆，底层就是调 `read_l3_concat()`，见 `deeptutor/tools/builtin/__init__.py:751` 和 `:764`；
- `write_memory`：写入偏好（走 `store.write_preference`），见 `deeptutor/tools/builtin/__init__.py:818`。

模型在对话中可以用 `write_memory` 记下"用户偏好用例子讲解"这类信息，下次对话经注入就能用上。而 `read_memory` 让模型随时回看"我对这个用户已知什么"。

## L3 四文档的默认标题

新建 L3 文档时如果还没内容，会先给一个默认标题。规则在 `store.py` 的 `_default_title`，见 `deeptutor/services/memory/store.py:444`：

- `recent` → "Recent summary"
- `profile` → "User profile"
- `scope` → "Knowledge scope"
- `preferences` → "Preferences"

注意标题是英文的——因为记忆文档本身是可被模型读取的"事实库"，用英文标题不影响中文用户（内容由整合器按用户语言生成）。标题只是个锚点。

## 记忆系统的设计哲学

把本章浓缩成几条"为什么这样设计"：

1. **分层沉淀，而非堆砌原文**：L1 忠实记录 → L2 按面提炼 → L3 跨面归纳。越往上越"像档案"，越往下越"像原料"。
2. **每条记忆可溯源**：L3→L2→L1 的引用链，让任何结论都能追到原始对话，防止编造。
3. **自动 + 手动双通道**：系统自动从痕迹长记忆，用户也能手动纠正，互不冲突。
4. **注入即个性化**：长期记忆的本质，是把沉淀好的 L3 档案在每次对话开始时喂给模型——模型"认得你"，靠的是注入，不是它自己记。
5. **隔离与可迁移**：按用户隔离；升级时旧格式自动迁移、不丢数据。

> **提示 · 给想深入源码的人的阅读顺序**
>
> 如果这章激发了你读真实代码的兴趣，建议按这个顺序：`trace.py`（L1 怎么写）→ `document.py`（L2/L3 长什么样）→ `ops.py`（怎么原子增删改）→ `consolidator/modes/update.py`（L1→L2→L3 怎么提炼）→ `store.py`（门面与注入）→ `turn_runtime.py`（记忆怎么进 prompt）。顺着这条线，三层记忆就全通了。

## 自查清单

- [ ] 我能用自己的话解释 L1 / L2 / L3 分别是什么、各存在哪个目录。
- [ ] 我理解"追加式写入（append-only）"为什么对 L1 很重要，以及它写在哪个文件（trace.py:66）。
- [ ] 我知道 L2/L3 文档的"脚注引用"格式，以及每条要点怎么挂回 L1（document.py:1）。
- [ ] 我能说出 consolidator 把 L1 提炼成 L2 的大致 5 个步骤（update.py:80）。
- [ ] 我理解 meta.json 里的"已见 id 集合"有什么用，如何避免每次全量重扫（meta.py:54）。
- [ ] 我知道 ops 的三种操作（加/改/删）和"原子性"是什么意思（ops.py:120）。
- [ ] 我能说出 L3 的四份文档分别叫什么、各记录什么内容（paths.py:39）。
- [ ] 我理解为什么 `preferences.md` 是手动写、不自动整理的（store.py:154）。
- [ ] 我能画出 L3 → L2 → L1 的溯源链，并说出"可溯源"的好处。
- [ ] 我知道记忆是在哪个代码位置被注入到 system prompt 的（turn_runtime.py:1402）。
