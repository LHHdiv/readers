---
title: "第 30 章 · 会话沙箱与协作"
date: 2026-08-01
summary: "**黑话解释**：\"会话（session）\"指一次连续的对话过程，从你打开到关闭，中间的所有消息都属于它。\"沙箱\"原指隔离的测试环境，这里强调\"数据边界清晰、互不串扰\"。"
tags:
  - deeptutor
---
# 第 30 章 · 会话沙箱与协作

前几章我们看了记忆、RAG、多语言。这一章把视角拉回"一次对话本身"：一个会话（session）在代码里到底是什么？它怎么和别的数据隔离开？用户在消息里附带的文件、引用的资料，是怎么被记住、又能被引用的？还有，智能体在回答你的时候，能不能**顺手去问另一个专门的小助手**？

代码核心在 `deeptutor/services/session/`，协作接口在 `deeptutor/services/subagent/`。

## 先懂直觉：什么是"会话沙箱"

你开一个聊天窗口，发几条消息，这就是一个"会话"。所谓"沙箱（sandbox）"，是指：**这个会话的数据（消息、附件、引用来源）被装在一个边界里，不会和别的会话混在一起，也不会和别的用户混在一起**。

打个比方：每个会话像一张独立的工作台。台子上摆着你这次带来的资料；你离开时，台子上的东西原样收好；下次回来，东西还在，但不会跑到别人的台子上。

> **黑话解释**："会话（session）"指一次连续的对话过程，从你打开到关闭，中间的所有消息都属于它。"沙箱"原指隔离的测试环境，这里强调"数据边界清晰、互不串扰"。

## 会话的数据模型

DeepTutor 用一个统一的会话管理器 `UnifiedSessionManager` 管理所有类型的对话（聊天、解题、出题……），靠数据里的 `mode` 字段区分。见 `deeptutor/services/session/unified_session_manager.py:15`。

它存进文件的数据结构长这样（文档写在 `unified_session_manager.py:28` 起）：

```text
{
  "session_id": "unified_<uuid>",
  "title": "新对话",
  "mode": "chat" | "deep_solve" | "deep_question" | ...,
  "enabled_tools": ["rag", "web_search"],
  "knowledge_bases": ["math-kb"],
  "messages": [ {role, content, ...}, ... ],
  "metadata": { ... },          # 各能力专属的附加信息
  "created_at": ...,
  "updated_at": ...,
}
```

创建会话时填充这些字段的逻辑在 `_create_session_data`，见 `unified_session_manager.py:50`。全局只用一个单例实例，见 `unified_session_manager.py:66` 的 `get_unified_session_manager`。

底层真正存文件的基类是 `BaseSessionManager`，见 `deeptutor/services/session/base_session_manager.py:23`，它负责把会话序列化成文件、保证文件存在等通用操作。不同对话类型靠 `_get_session_id_prefix` 这类钩子区分前缀（见 `base_session_manager.py:70`）。

## 贯穿整个回合的"上下文大包裹"

会话里的消息、附件、记忆……在一个回合（turn，一次"用户发问→模型回答"）里，会被打包成一个统一对象 `UnifiedContext`，传给能力、工具、插件去用。定义在 `deeptutor/core/context.py:34`。

它有哪些字段（见 `deeptutor/core/context.py:70` 起）：

- `session_id`：会话标识；
- `user_message`：本轮用户消息；
- `conversation_history`：按 OpenAI 格式排好的历史消息；
- `enabled_tools`：用户勾选要用的工具（空列表=全关，None=没指定）；
- `knowledge_bases`：要检索的知识库；
- `attachments`：本轮带的文件/图片（类型 `Attachment`，见 `context.py:16`）；
- `language`：界面/回答语言；
- `memory_context`：注入的记忆文本（上一章讲过，见 `context.py:80`）；
- `source_manifest`：附件来源清单（下面讲）；
- `metadata`：各能力自定义的附加字段。

> **说明 · 为什么用"一个大包裹"而不是零散传参？**
>
> 一个回合里，能力、工具、插件几十个模块都要读上下文。如果每次都零散传十几个参数，签名会又长又乱、改一处全崩。DeepTutor 把它们装进一个 `UnifiedContext` 对象统一传递——这是典型的"上下文对象（Context Object）"模式。好处是：要加新信息，往这个对象里加一个字段就行，不用改所有函数签名。

## 上下文构建器：把历史"装进窗口"

模型一次能"看"的文字长度是有限的（上下文窗口）。`ContextBuilder` 负责把很长的历史压缩、裁剪到这个窗口里，见 `deeptutor/services/session/context_builder.py:104`。

它做了几件事：

- **选最近消息**：按 token 预算挑最近的若干条，超预算就截断，见 `context_builder.py:165` 的 `_select_recent_messages`；
- **做摘要**：把太老的消息用一个小模型压缩成一段总结，见 `context_builder.py:182` 的 `_summarize`，以及专门的小代理 `_ContextSummaryAgent`（`context_builder.py:90`）；
- **拼装历史**：把"总结 + 最近消息"拼成最终历史，见 `context_builder.py:139` 的 `_build_history`。

构建结果用 `ContextBuildResult` 打包返回（含历史、摘要、token 数、预算），见 `context_builder.py:80`。在运行时里，构建过程的调用发生在 `turn_runtime.py:1387`（创建 `ContextBuilder`）和 `:1394`（调用 `builder.build`），最终把结果装进 `UnifiedContext`，见 `turn_runtime.py:1664`。

## 附件：生成物与用户上传文件

"附件（attachment）"分两类：用户上传的，以及工具**生成**的（比如代码运行产出的图、文档）。`artifact_attachments.py` 管的是后者——它们如何被从流式事件里捞出来、变成可点击的卡片。

核心函数 `artifact_attachments(event)` 从一个流式事件里取出它所携带的生成文件记录，见 `deeptutor/services/session/artifact_attachments.py:54`。流程里：

- 工具一跑完，就在 `tool_result` 事件里带上这些文件（这是"即使回合被取消也不丢"的来源），见 `artifact_attachments.py:24` 的模块说明；
- `fill_preview_text` 给某些二进制（如 .pptx）补一段纯文本预览，方便在前端抽屉里看，见 `artifact_attachments.py:87`；
- 文件 URL 是定位文件的唯一依据（`/api/outputs/` + 相对路径），见 `artifact_attachments.py:38`；
- `_resolve_artifact_path` 把 URL 还原成磁盘路径去读内容，见 `artifact_attachments.py:130`。

> **直觉**：附件就是"这次对话里能打开看的文件"。用户上传的、和工具生成的，最终都变成聊天界面里一张张可点的卡片，而不是模型把一段 `/api/outputs/xxx` 网址硬塞进回答里。

## 来源清单：跨回合记住你附过的资料

早期有个痛点：用户上一轮附了个文件，这一轮没重新附，模型就"忘了"那份资料。DeepTutor 用"来源清单（source inventory）"解决——它是**会话累计**的：当前轮附的叫"新鲜"来源，之前轮附的（沿当前分支的祖先链）叫"历史"来源，都列在清单里。见 `deeptutor/services/session/source_inventory.py:1` 的模块说明。

关键函数：

- `build_inventory`：把新鲜来源和历史来源汇总成一个清单，见 `source_inventory.py:108`；
- `render_manifest`：把清单渲染成模型能读的"来源清单文本"和"id→全文"映射，见 `source_inventory.py:165`；
- `_add_historical`：沿分支祖先链收集历史来源，见 `source_inventory.py:363`；
- `_load_lineage`：保证"兄弟分支"的来源不会串进当前分支（分支隔离），见 `source_inventory.py:532`。

数据模型上，`SourceEntry` 描述单条来源（见 `:50`），`SourceInventory` 是它们的集合（见 `:69`，`is_empty` 判断在 `:96`）。渲染时，新鲜来源给较完整的预览（2000 字，见 `:44` 的 `MANIFEST_PREVIEW_CHARS_FRESH`），历史来源只给一行身份标识——模型真需要时再调 `read_source(id)` 取全文。

```text
本轮用户发问
   │
   ├─ 新鲜来源（本轮附的文件/笔记/书）→ 完整预览
   │
   └─ 历史来源（之前轮、同分支祖先）→ 仅一行身份
        │
        ▼
   合并成 SourceInventory
        │
        ▼
   render_manifest → "来源清单文本" + {来源id: 全文}
        │
        ▼
   放进 UnifiedContext.source_manifest
        │
        ▼
   模型据此决定要不要 read_source(id)
```

## 协作：同一回合内咨询子 agent / Partner

这是本章最精彩的部分。DeepTutor 在回答你的时候，可以**把一个问题转交给另一个专门的智能体**去办，再把结果拿回来——而且这一切发生在"同一个回合"里。

### 统一的"子代理"接口

不管被咨询的是本地 CLI 工具（如 Claude Code、Codex），还是你自己的一个 Partner，代码都通过**同一个接口**驱动。这个接口叫 `SubagentBackend`，定义在 `deeptutor/services/subagent/base.py:24`：

- `detect()`：判断这个后端在不在、能不能用，见 `base.py:36`；
- `consult(question, ...)`：把一个问题抛给它，并把它的每一条原生事件实时流式回传，见 `base.py:40`。

`OnEvent` 是事件回调：每来一条原生事件就调一次，这样"慢的消费者"也能被尊重（背压）。见 `base.py:20`。返回结果 `ConsultResult` 记录这次咨询成不成、拿到什么（见 `deeptutor/services/subagent/types.py:59`）；事件类型 `SubagentEvent` 见 `types.py:39`；`detect` 的返回 `DetectResult` 见 `types.py:75`。

### Partner 后端：把问题交给"你自己的另一个智能体"

`PartnerBackend` 是其中一个后端，它不启动任何子进程，而是**通过伙伴管理器，把问题丢给你已绑定的某个 Partner 去跑**——就像你在 Partner 页面新开一个会话。见 `deeptutor/services/subagent/partner.py:51`。

它最巧妙的一点是**会话连续性**：咨询时传进来的 `session_id` 就是"伙伴会话的钥匙"。第一次咨询还没有，就现场生成一个 `dt-…` 钥匙（见 `partner.py:103`）；之后同一段 DeepTutor 对话里的每次咨询，都通过"跨回合注册表"复用同一个钥匙（见 `partner.py:12` 的模块说明）。于是：你在 DeepTutor 里和主智能体聊十轮，每轮顺带问 Partner，Partner 那边看到的是**一段完整连续的历史会话**，而不是十段互不相关的对话。

`consult` 方法本身负责：确认 Partner 存在并拉起（见 `partner.py:81` 的 `pid` 检查、`:92` 的 `get_partner`）、生成/复用会话钥匙、把伙伴的流式事件转成统一的子代理事件通道回流（见 `partner.py:122` 的 `relay`）。

### 跨回合注册表：记住"钥匙"

这套连续性的幕后，是 `deeptutor/services/subagent/sessions.py` 这个轻量注册表。它的职责写在模块说明里（见 `sessions.py:1`）：把一次咨询拿到的后端会话 id 记下来，按"聊天会话 + 连接"做键，下次咨询复用，从而让子代理跨回合保持上下文。

- `session_key(chat_session_id, connection)`：拼出注册表键，见 `sessions.py:28`；
- `get_session(key)`：取回记住的后端会话 id，见 `sessions.py:55`；
- `remember_session(key, session_id, ...)`：持久化会话 id 供下次续上，见 `sessions.py:63`；
- `forget_connection(connection)`：连接断开时清掉该连接的所有记忆，见 `sessions.py:72`。

> **提示 · "咨询子代理"和"普通工具调用"有什么不同？**
>
> 普通工具（比如 web_search）是模型直接跑一步、拿回结果。而"咨询子代理"是**把一个完整的小智能体（有自己的灵魂、资料库、技能）请进来，让它用自己的整套能力去办一件事**，再把它的思考过程和结果回流给你。对需要"专业分工"的任务（比如主智能体擅长教学、子代理擅长写代码跑测试），这种协作能各取所长。而这一切对上层能力来说是统一的——驱动 Claude Code 和驱动 Partner，代码里就是"同样的三个调用"（detect / consult / 读结果）。

## 小结：一个回合里发生了什么

把本章串起来，一次"用户发问"在后端是这样流动的：

```text
用户发问（带附件 / 引用来源 / 选记忆槽位 / 选能力）
        │
        ▼
ContextBuilder 压缩裁剪历史 → conversation_history
        │
        ▼
组装 UnifiedContext（含消息、附件、记忆、来源清单、语言…）
        │
        ▼
能力运行（可调用工具；可把难题 consult 给子代理/Partner）
        │
        ├─ RAG 检索（第27章）
        ├─ 长期记忆注入（第26章）
        └─ 子代理协作（本章）
        │
        ▼
生成回答，流式回传；附件被捞成卡片、来源进清单
```

## 会话存储：两种可替换的后端

`UnifiedSessionManager` 只管"会话长什么样、怎么建"，真正"把会话存到哪"由**会话存储（session store）**决定。DeepTutor 定义了统一的 `SessionStoreProtocol`，见 `deeptutor/services/session/protocol.py:9`——它规定了 `create_session / get_session / create_turn / append_turn_event` 等一组异步方法。

关键在于：只要满足这个协议，底层可以用不同技术实现，而上层代码完全不用改。仓库里就有两个实现：`sqlite_store.py`（单机 SQLite）和 `pocketbase_store.py`（PocketBase 远程存储）——它们都"满足协议"，所以哪天换存储，只是换个实现类，调用方一行不动。

> 这种"先定协议、再有多实现"的写法，和前面 RAG 的"先定 SubagentBackend 接口、再有 Claude Code / Partner 多个实现"是同一个套路：用接口隔离"做什么"和"怎么做"。

## 基类提供的会话操作

`BaseSessionManager` 在协议之上，给所有会话类型提供了一组通用操作（见 `deeptutor/services/session/base_session_manager.py`）：

- `create_session`：新建会话，见 `base_session_manager.py:115`；
- `get_session`：按 id 取会话，见 `:148`；
- `add_message`：往会话里追加一条消息，见 `:185`；
- `list_sessions`：列出用户的所有会话，见 `:215`；
- `delete_session`：删除会话，见 `:227`；
- `session_exists`：判断会话是否存在，见 `:252`。

`UnifiedSessionManager` 继承它，只用 `_get_session_id_prefix`、`_create_session_data` 等几个抽象方法（见 `base_session_manager.py:70/78`）定制"统一的"那部分，其余通用逻辑全部复用。

## 上下文构建的"预算分配"

`ContextBuilder` 不是随便裁历史，而是按"预算比例"精细分配。几个内部方法体现了这套预算（见 `deeptutor/services/session/context_builder.py`）：

- `_history_budget`：历史可用 token 预算 = 有效上下文窗口 × 0.35（见 `:124`）；
- `_summary_budget`：给"老消息摘要"预留的预算 = 历史预算 × 0.40（见 `:128`）；
- `_recent_budget`：最近消息的预算 = 总预算 − 摘要预算（见 `:131`）；
- `_rebuild_source_budget`：老摘要需要重算时，最多吃半个上下文窗口（见 `:134`）。

这套比例让"摘要多少、留多少最新消息"有章可循，而不是拍脑袋。模型既能看到最近的对话细节，又能通过摘要回顾更早的上下文。

## 协作事件为什么需要"映射"

`PartnerBackend.consult` 里有个 `relay` 函数（见 `deeptutor/services/subagent/partner.py:122`），它把伙伴原生的流式事件转成统一的"子代理事件"。为什么要转一道？

因为不同后端（Claude Code、Codex、Partner）吐出的事件格式千差万别：有的按调用 id 并行发工具调用、再并行发结果，导致"调用"和"结果"不相邻。DeepTutor 在 `relay` 里把同一个 `call_id` 的调用和结果"攒"到一起、按 `call → result` 成对回放（见 `partner.py:106` 起的注释），这样前端侧边栏看到的就永远是一段通顺的"调用→结果"轨迹，而不是乱序碎片。

```text
Partner 原生事件（可能乱序）
   tool_call_a   tool_call_b   tool_result_a   tool_result_b
        │
        ▼
   relay() 按 call_id 配对、重排
        │
        ▼
   统一子代理事件：call_a→result_a，call_b→result_b
        │
        ▼
   侧边栏渲染成通顺的工具调用轨迹
```

## 附件的预览文本细节

附件不只是"存个文件"，还要让前端能预览。`artifact_attachments.py` 为此做了一层处理：

- `fill_preview_text` 给附件补纯文本预览，见 `deeptutor/services/session/artifact_attachments.py:87`；
- `_needs_preview_text` 判断某个附件是否需要预览文本（见 `:99`）；
- `_fill_preview_text_sync` 是同步执行的具体填充逻辑（见 `:104`）；
- `_resolve_artifact_path` 把 `/api/outputs/...` 这种 URL 还原成磁盘路径去读内容，见 `artifact_attachments.py:130`。

为什么需要"预览文本"？因为 `.pptx`、`.doc` 这类二进制，浏览器没内置渲染器，直接打开是空白。`fill_preview_text` 给它们塞一段提取出的纯文字，前端抽屉里至少能看到"这文件讲了什么"。而 `.docx`/`.xlsx`/PDF/图片这些浏览器能直接渲染的，反而**故意不**提取——省 IO 和存储（见 `artifact_attachments.py:33` 附近的注释）。

## 来源清单的分支隔离

`source_inventory` 最巧妙的一点是"分支隔离"。DeepTutor 的对话支持"分支"（像 Git 一样从某条消息分出另一条路线）。那么：A 分支附过的资料，不该泄漏进 B 分支。

实现上，`_add_historical` 沿"当前分支的祖先链"收集历史来源（见 `deeptutor/services/session/source_inventory.py:363`），而 `_load_lineage` 负责只走祖先、不跨兄弟分支（见 `source_inventory.py:532`）。新鲜来源的预览长度由 `_clip_preview` 控制（上限 `MANIFEST_PREVIEW_CHARS_FRESH = 2000`，见 `:206`、`:44`），历史来源只渲染一行身份（`_format_size`、`:213`）。

```text
当前分支：  main ─ 消息1 ─ 消息2 ─(分支点)─ 分支A消息3
                                      └─ 分支B消息3'
来源收集（分支A本轮）：
   新鲜：本轮在 A 附的文件
   历史：沿 main→消息1→消息2→分支A消息3 的祖先链
   不收集：分支B消息3' 的来源（兄弟分支，隔离）
```

> **说明 · "分支"是什么？**
>
> 如果你用过支持"后悔、换一条路接着聊"的对话产品，那种"从某条消息另起一条线"就是分支。DeepTutor 把会话存成带父子关系的消息树，每条消息记 `parent_message_id`。来源清单据此判断"祖先链"，从而做到分支之间来源不串门。

## 一个具体例子：跨回合引用资料

看来源清单怎么解决"上一轮附的文件这轮忘了"的问题：

```text
第 1 轮：用户附了 paper.pdf，问"这论文讲了啥？"
   → 新鲜来源：paper.pdf（完整预览进清单）
   → 模型回答了，用户看懂了

第 2 轮：用户没重新附，直接问"它的实验方法是什么？"
   → 本轮无新鲜来源
   → 历史来源：沿祖先链找到第 1 轮的 paper.pdf（一行身份）
   → 清单里出现 "source_1: paper.pdf (出现在第1轮)"
   → 模型调 read_source(source_1) 取回全文
   → 基于同一份文件继续答"实验方法"
```

没有这套累计清单，第 2 轮模型就"失忆"了——它根本不知道第 1 轮附过什么。累计清单 + `read_source` 让"引用"跨回合延续。

## 常见误区

- **误区一："会话就是一串消息。"** 不全对。DeepTutor 的会话是带分支的消息树，不是简单列表；而且会话还携带附件、来源清单、记忆引用等"上下文"，远不止消息。
- **误区二："子代理和工具是一回事。"** 不同。工具是模型跑一步拿结果；子代理是请一个**完整的小智能体**用自己的全套能力办一件事，再回流过程与结果（见 `subagent/base.py:40` 的 `consult`）。
- **误区三："咨询 Partner 每次都是新对话。"** 错。靠"会话钥匙 + 跨回合注册表"（`partner.py:103`、`sessions.py:63`），同一段 DeepTutor 对话里的多次咨询，在 Partner 那边是**一段连续会话**。
- **误区四："附件和来源是重复的。"** 不是。附件是"文件本身"（可下载/预览）；来源清单是"这次对话引用了哪些资料、怎么取全文"的索引，供 `read_source` 使用。

## 会话的创建与消息追加

回到"会话怎么存"。`BaseSessionManager` 提供了一组通用操作（见 `deeptutor/services/session/base_session_manager.py`）：

- `create_session`：新建一个会话，见 `base_session_manager.py:115`；
- `get_session`：按 id 取会话内容，见 `:148`；
- `add_message`：往会话里追加一条消息，见 `:185`；
- `list_sessions`：列出用户所有会话，见 `:215`；
- `delete_session`：删除会话，见 `:227`；
- `session_exists`：判断会话是否存在，见 `:252`。

`UnifiedSessionManager` 继承它，只定制"统一的"那部分（前缀、默认标题、初始数据结构），通用存储逻辑全部复用。两种会话存储（SQLite / PocketBase）都实现 `SessionStoreProtocol`（见 `protocol.py:9`），所以换存储不影响这些操作。

## 协作的边界：谁能被咨询

`PartnerBackend.consult` 不是"谁来都行"，它先校验再执行（见 `deeptutor/services/subagent/partner.py`）：

- 没绑定 partner id 就直接返回错误（`No partner is bound...`），见 `partner.py:81`；
- 绑定的 partner 若不存在，返回错误，见 `:88` 的 `partner_exists`；
- 若 partner 没在运行，先尝试拉起，见 `:92` 的 `get_partner` 和 `:95` 的 `start_partner`；
- 拉起失败也返回明确错误，而不是卡死。

这层边界保证：咨询子代理是"受控的委托"——只有明确绑定、且确实可用的伙伴才会被请进来，避免了"随便把问题丢给一个不存在的智能体"导致的混乱。

## 设计哲学

把本章浓缩成几条"为什么这样设计"：

1. **会话即隔离边界**：消息、附件、来源都装在一个会话里，跨会话、跨用户不串扰。
2. **上下文大包裹**：用 `UnifiedContext` 统一传递，避免几十个零散参数。
3. **历史有预算**：`ContextBuilder` 按窗口比例分配摘要/最近消息，长对话也不爆窗口。
4. **附件与来源分离**：附件是"文件本身"，来源清单是"引用索引"，两者配合实现跨回合引用。
5. **协作用统一接口**：Claude Code、Codex、Partner 都走 `SubagentBackend` 的 `detect/consult`，专业分工但上层无感。
6. **连续性靠注册表**：跨回合复用会话钥匙（`sessions.py`），子代理记得住上下文。

> **提示 · 给想深入源码的人的阅读顺序**
>
> `unified_session_manager.py`（会话模型）→ `context_builder.py`（历史压缩）→ `core/context.py`（UnifiedContext）→ `artifact_attachments.py` + `source_inventory.py`（附件与来源）→ `subagent/base.py` + `partner.py` + `sessions.py`（协作与连续性）。顺着"会话→上下文→附件→协作"这条线，会话沙箱就全通了。

## 自查清单

- [ ] 我能用自己的话解释"会话沙箱"就是"数据边界清晰、互不串扰的一次对话"。
- [ ] 我知道 UnifiedSessionManager 用 `mode` 字段区分不同对话类型（unified_session_manager.py:15/50）。
- [ ] 我理解 UnifiedContext 这个"上下文大包裹"为什么比零散传参好（core/context.py:34）。
- [ ] 我能说出 ContextBuilder 怎么把长历史压进模型窗口（context_builder.py:104/165/182）。
- [ ] 我理解 artifact_attachments 管的是"工具生成的文件"，以及它怎么变成可点卡片（artifact_attachments.py:54）。
- [ ] 我知道 source_inventory 怎么做到"跨回合、按分支"记住来源（source_inventory.py:108/363/532）。
- [ ] 我能说出子代理的统一接口 SubagentBackend 有哪两个核心方法（base.py:24/36/40）。
- [ ] 我理解 PartnerBackend 怎么用"会话钥匙"实现跨回合连续咨询（partner.py:70/103）。
- [ ] 我知道跨回合注册表 sessions.py 是干什么的、为什么连接断开要清记忆（sessions.py:1/72）。
