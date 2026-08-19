---
title: "第 21 章 · 回合运行时 turn runtime"
date: 2026-08-01
summary: "**黑话先定义**"
tags:
  - deeptutor
---
# 第 21 章 · 回合运行时 turn runtime

你发一句"帮我解这道积分题"，DeepTutor 背后就跑起了一个**回合（turn）**。本章讲清楚：一次用户输入是怎么被封装成一个回合的、它如何被写进数据库（落库）、实时事件是怎么一边跑一边推给前端的、附件/人格/技能是怎么被注进上下文的、多用户下模型授权如何把关、以及服务器崩溃重启后为什么不会"半截对话"丢失——也就是 restart-safe（重启可恢复）设计。

本卷面向完全不懂编程的读者，所以先把黑话摆平。

> **黑话先定义**
> - *回合 turn*：用户的一轮发言 + 智能体的一整轮回复，算一个回合。它是一条"正在进行的任务"记录。
> - *会话 session*：一场连续对话，里面有许多条消息，可以跨多个回合。
> - *落库*：把数据写进持久存储（SQLite 文件或 PocketBase 数据库），关掉程序也不会丢。
> - *restart-safe*：程序中途崩了/被重启，再启动时能发现"上次有个任务没跑完"，并把它标记为失败而不是卡死。
> - *事件 stream event*：系统边跑边产生的一条条小通知，比如"模型吐了一个字""工具开始跑"，前端靠它实时刷新界面。
> - *附件 attachment*：用户随消息上传的文件（图片、PDF、代码等）。

## 一句话直觉

把"用户发一句话"想象成寄一封挂号信：邮局先给信编个号（创建回合），信在分拣中心一路流转（执行），每到一个节点都盖个戳（写事件），最后送达并归档（保存助手回复 + 标记完成）。如果邮局半夜着火重建了，信封上的编号还在，工作人员一看"这封还在途中"就知道它其实已经寄不出去了，于是盖上"已中断"的章，让你重新寄一次。这就是回合运行时在做的事。

## 入口：start_turn 做了什么

所有回合都从 `TurnRuntimeManager.start_turn` 开始。它在 `deeptutor/services/session/turn_runtime.py:682` 定义。这个函数很长，可以拆成三层工作：

1. **归一化输入**：确认能力（capability）名、语言，把前端传来的"仅运行时使用"的隐藏参数剥出来（`deeptutor/services/session/turn_runtime.py:691` 的 `runtime_only_keys` 元组，比如 `_regenerate`、`_superseded_turn_id`、`subagent_consult_budget`）。
2. **确定身份与权限**：它会去查当前用户被允许用哪些模型、哪些工具（`deeptutor/services/session/turn_runtime.py:819` 的 `allowed_optional_tools`，`deeptutor/services/session/turn_runtime.py:765` 的非管理员必须有模型授权，否则直接报错而非悄悄用全局模型）。
3. **落库 + 起后台任务**：先 `ensure_session` 拿到会话（`deeptutor/services/session/turn_runtime.py:717`），再把"偏好"写回会话（`deeptutor/services/session/turn_runtime.py:843`），接着 `create_turn` 建回合（`deeptutor/services/session/turn_runtime.py:844`），最后用 `asyncio.create_task` 把真正的执行扔到后台（`deeptutor/services/session/turn_runtime.py:873`）。

```text
start_turn(payload)
   │
   ├─ 归一化 capability / language / config   deeptutor/services/session/turn_runtime.py:683
   ├─ 权限与模型校验（非管理员必须授权）        deeptutor/services/session/turn_runtime.py:765
   ├─ ensure_session  -> 会话行                  deeptutor/services/session/turn_runtime.py:717
   ├─ update_session_preferences                deeptutor/services/session/turn_runtime.py:843
   ├─ create_turn  -> 回合行 (status=running)    deeptutor/services/session/turn_runtime.py:844
   └─ create_task(_run_turn)  -> 后台跑          deeptutor/services/session/turn_runtime.py:873
```

注意一个关键设计：`start_turn` 几乎立刻就返回 `(session, turn)` 给前端，真正的"思考与回答"是在后台任务 `_run_turn` 里异步跑的（`deeptutor/services/session/turn_runtime.py:1199`）。这样前端一边显示"正在输入"，一边通过另一个通道（订阅）实时收事件，互不阻塞。

> **说明 · 为什么用"后台任务"而不是同步跑完？**
>
> 因为大模型生成答案可能要好几秒甚至几十秒。如果 `start_turn` 等答案出来才返回，前端那次 HTTP 请求会一直挂着、容易超时。后台跑 + 事件订阅，让前端先拿到"回合已创建"，再慢慢收字。这也是聊天软件"打字机"效果的来源。

## 回合对象：_TurnExecution

后台任务用一个数据盒子 `_TurnExecution` 来记账（`deeptutor/services/session/turn_runtime.py:608`）。它记着：

- `turn_id` / `session_id` / `capability`：这是哪个回合、哪场会话、用的哪种能力。
- `subscribers`：有哪些"实时订阅者"（比如 WebSocket 连接）在等着收事件。
- `events`：本进程内缓存的事件列表。
- `task`：真正的 asyncio 任务对象。

判断"这个回合是不是还在本进程里活着"靠 `_has_live_execution`（`deeptutor/services/session/turn_runtime.py:650`）：看 `_executions` 字典里有没有这条记录、且任务还没跑完。这个信息只存在于内存，**数据库里并不知道进程是否还活着**——这正是后面"重启可恢复"要解决的问题。

## 回合里到底记了什么数据

一个回合并非只存"问题+答案"。为了把上下文原样还原，运行时在落库用户消息时，会把一整套"前端环境快照"一起存进去，函数叫 `_request_snapshot_metadata`（`deeptutor/services/session/turn_runtime.py:209`）。它把这些都塞进一条快照（`deeptutor/services/session/turn_runtime.py:225`）：

- `content`：用户原文。
- `capability`：这次用哪种能力（chat / deep_solve / …）。
- `enabledTools` / `knowledgeBases`：用户当时开了哪些工具、挂了哪些知识库（`deeptutor/services/session/turn_runtime.py:228`）。
- `language`：界面语言。
- 各种引用：笔记本引用、历史引用、题目库引用、书目引用（`deeptutor/services/session/turn_runtime.py:236` 起）。
- `persona` / `memoryReferences`：人格设定、记忆引用。

另外，模型（尤其聊天）有时会随消息附带记忆槽引用 `MemoryReference`，类型定义在 `deeptutor/services/session/turn_runtime.py:30`，可选 `"recent"`/`"profile"`/`"scope"`/`"preferences"`/`"summary"`。`_extract_memory_references`（`deeptutor/services/session/turn_runtime.py:172`）会校验并清洗这些引用，只保留白名单里的值。

还有个贴心小函数 `_clip_text`（`deeptutor/services/session/turn_runtime.py:111`）：把过长的内容截断到 4000 字符并标 `[truncated]`，防止某段日志或错误把数据库行撑爆。

## 多用户与模型授权门

DeepTutor 支持多用户，不同用户能被分配不同模型。`start_turn` 里有一段专门的授权逻辑（`deeptutor/services/session/turn_runtime.py:739` 起）：

- 若前端没指定 `llm_selection`，就回退到用户会话里存的偏好（`deeptutor/services/session/turn_runtime.py:741`）。
- 若用户是管理员，可以留空（用全局默认模型）。
- 若用户非管理员，则**必须有可用的模型授权**，否则直接报清晰错误：`"No LLM model is assigned to your account. Please contact an administrator."`（`deeptutor/services/session/turn_runtime.py:770`）。这是单一把关点，和前端锁、HTTP 接口共用同一逻辑（`deeptutor/services/session/turn_runtime.py:766` 注释）。
- 非管理员若没显式选模型，会从"被授权的模型清单"里钉第一个可用模型（`deeptutor/services/session/turn_runtime.py:774` 起，调 `redacted_model_access` / `has_capability_access`）。
- 选定后还会用 `merge_personal_llm_profiles` + `apply_llm_selection_to_catalog`（`deeptutor/services/session/turn_runtime.py:784` 起）校验，确保用户自选的"个人模型"也真实可用。

这套门禁保证：**永远不会因为授权遗漏而悄悄退化到管理员的全局模型**，从而把别的用户的额度/密钥暴露出去。

## 重启可恢复：孤儿回合回收

这是本章的重点。`running` 状态是"进程本地"的概念：数据库里一行写着 `running`，但如果承载它的进程被重启，那行就永远卡在 `running` 了。

解决办法是：**每次开新回合之前，先把这场会话里所有还写着 running 的旧回合清一遍**。

```text
start_turn
   └─ _recover_orphan_running_turns_for_session   deeptutor/services/session/turn_runtime.py:828
          │
          └─ 对每条 list_active_turns 返回的回合:
                 └─ _fail_orphan_running_turn       deeptutor/services/session/turn_runtime.py:677
                        │
                        ├─ 状态不是 running？直接返回
                        ├─ 本进程还活着（_has_live_execution）？不动它
                        └─ 否则 update_turn_status(failed,
                              "Turn interrupted by server restart...")
                              deeptutor/services/session/turn_runtime.py:674
```

`_fail_orphan_running_turn` 在 `deeptutor/services/session/turn_runtime.py:661`：它先判断"是不是 running"，再判断"本进程是不是还握着它的执行权"；只有当数据库说 running、而本进程根本没有对应的活任务时，才把它改成 `failed`，并写上那句友好的错误 `deeptutor/services/session/turn_runtime.py:138` 定义的 `_INTERRUPTED_TURN_ERROR`：*"Turn interrupted by server restart. Please retry your message."*

这种"运行时自己负责判定存活，而不是让存储层去猜"的方式，让回收逻辑和具体数据库后端解耦——不管底层是 SQLite 还是 PocketBase，恢复逻辑都一样。这正是 `deeptutor/services/session/turn_runtime.py:664` 注释强调的：liveness（存活）检查属于运行时，不属存储。

> **提示 · 为什么不在数据库里直接删掉孤儿回合？**
>
> 因为如果直接删，前端那个"乐观显示"的临时消息就找不到对应记录了，反而会乱。改成 `failed` 是更安全的"盖棺定论"：用户看到"已中断，请重发"，重新发一次即可，数据链条始终完整。

## 回合状态机

一个回合在其生命周期里会经历若干状态。终态集合在 `_FINAL_TURN_STATUSES`（`deeptutor/services/session/turn_runtime.py:38`）：`completed` / `failed` / `cancelled` / `rejected`。状态迁移大致是：

```text
running ──正常跑完──> completed
running ──出错──────> failed
running ──用户取消──> cancelled   (cancel_turn, deeptutor/services/session/turn_runtime.py:992)
running ──拒绝──────> rejected
running ──重启无主──> failed      (孤儿回收, deeptutor/services/session/turn_runtime.py:674)
```

`_resolve_turn_outcome`（`deeptutor/services/session/turn_runtime.py:51`）从事件流里推算最终状态；如果事件里出现了带 `turn_terminal` 标记的 ERROR 事件，就按它的 `status` 收尾（`deeptutor/services/session/turn_runtime.py:65` 起），且若状态是 `completed` 却来自错误，会强制改成 `failed`（`deeptutor/services/session/turn_runtime.py:69`）——保证"出错绝不伪装成功"。

## 附件怎么处理

用户发的文件（图片、PDF 等）不会一直以 base64 文本塞在消息里。`_run_turn` 开头就处理附件（`deeptutor/services/session/turn_runtime.py:1297`）：

1. 每条附件先尝试把原始字节上传到附件存储 `attachment_store.put`（`deeptutor/services/session/turn_runtime.py:1330`），拿到一个稳定 URL。上传失败不致命，仍可用内存里的数据抽取（`deeptutor/services/session/turn_runtime.py:1337` 注释）。
2. 再用 `extract_documents_from_records`（`deeptutor/services/session/turn_runtime.py:1344`）抽取文档文本（PDF 文字、图片 OCR 等）。
3. 落库时**强制清空 base64**（`deeptutor/services/session/turn_runtime.py:1363`），只保留 URL——这样数据库行不会因大文件而膨胀，前端预览靠 URL 重新拉取（`deeptutor/services/session/turn_runtime.py:1360` 注释）。

```text
附件进入 _run_turn                    deeptutor/services/session/turn_runtime.py:1297
   ├─ 上传原字节 -> 拿 URL            deeptutor/services/session/turn_runtime.py:1330
   ├─ 抽取文档文本                    deeptutor/services/session/turn_runtime.py:1344
   └─ 落库时清空 base64，只留 URL      deeptutor/services/session/turn_runtime.py:1363
```

## 人格与技能怎么注入

智能体的"语气"和"可用技能"也是在 `_run_turn` 里现拼的：

- **人格 persona**：`_run_turn` 在 `deeptutor/services/session/turn_runtime.py:1409` 起解析用户指定的 persona，优先自己的 workspace，非管理员再回退到管理员预设（`deeptutor/services/session/turn_runtime.py:1419`）。人格文本会作为系统提示的一部分注入，从第一个 token 就塑造语气。
- **技能 skills**：`deeptutor/services/session/turn_runtime.py:1431` 起汇总用户可见的技能清单，并区分"始终注入"的 `always` 技能（`deeptutor/services/session/turn_runtime.py:1433`）和"按需加载"的技能。聊天能力走"轻量清单 + read_skill 按需读取"路线（`deeptutor/services/session/turn_runtime.py:1453` 的 `is_chat_capability` 判断），其他能力则把整块上下文拼进用户消息。

## 消息如何落库

真正执行发生在 `_run_turn`（`deeptutor/services/session/turn_runtime.py:1199`）。它先准备好各种上下文（附件、记忆、人格、技能清单等），然后调用 `ChatOrchestrator` 去驱动智能体循环（`deeptutor/services/session/turn_runtime.py:1703`）。循环每吐出一个事件，运行时就同时做两件事：

1. **实时推送**给订阅者（前端立刻看到字一个个冒出来）。
2. **挑选能持久化的内容**，攒到 `content_segments` 里（`deeptutor/services/session/turn_runtime.py:1714`）。

这里有几个筛选细节值得说：

- `_should_capture_assistant_content`（`deeptutor/services/session/turn_runtime.py:41`）：判断某条内容事件要不要计入"最终答案"。它依赖 `_ANSWER_CONTENT_CALL_KINDS` 白名单（`deeptutor/services/session/turn_runtime.py:37`），只收 `llm_final_response` 和 `agent_loop_round` 这类"正经回答"事件。
- 智能体循环会先输出一段"旁白（narration）"再调用工具，那段旁白只是过程痕迹，不该作为最终答案。`_narration_marker_call_id`（`deeptutor/services/session/turn_runtime.py:77`）专门识别这种旁白并排除，`_assemble_persisted_answer`（`deeptutor/services/session/turn_runtime.py:97`）负责把旁白滤掉再拼答案，还会清掉模型爱塞的 `<think>` 标签。
- 终态怎么算？`_resolve_turn_outcome`（`deeptutor/services/session/turn_runtime.py:51`）从事件流里推算出最终状态（`completed`/`failed`/`cancelled`/`rejected`，见 `_FINAL_TURN_STATUSES` 在 `deeptutor/services/session/turn_runtime.py:38`）和错误信息。

落库分两步，顺序很重要：

```text
_run_turn
   ├─ （可选）add_message(user)        写用户消息   deeptutor/services/session/turn_runtime.py:1631
   ├─ 驱动 ChatOrchestrator           边跑边推事件  deeptutor/services/session/turn_runtime.py:1705
   ├─ assistant_content = 拼装答案     deeptutor/services/session/turn_runtime.py:1733
   ├─ add_message(assistant)          写助手回复    deeptutor/services/session/turn_runtime.py:1741
   ├─ _flush_buffered_events          补发缓冲事件  deeptutor/services/session/turn_runtime.py:1769
   └─ update_turn_status(...)         回合终结      deeptutor/services/session/turn_runtime.py:1774
```

用户消息在 `deeptutor/services/session/turn_runtime.py:1631` 用 `store.add_message(role="user", ...)` 写入；助手回复在 `deeptutor/services/session/turn_runtime.py:1741` 写入，并通过 `parent_message_id` 挂到用户消息下面，形成"一问一答"的父子链。最后 `update_turn_status`（`deeptutor/services/session/turn_runtime.py:1774`）把回合状态从 `running` 改成终态之一，回合正式结束。

> 关于"分支编辑"：`_run_turn` 支持 `parent_message_id`（`deeptutor/services/session/turn_runtime.py:1268`）。当用户在旧消息上"改一句重新问"，新消息会挂在那个旧消息下面当"兄弟节点"，而不是追加到末尾。这让对话树可以分叉，LLM 只看那条分支的祖先链。`add_message` 的 `parent_kwargs`（`deeptutor/services/session/turn_runtime.py:1628`）就是为此服务。

## 实时事件订阅：subscribe_turn

前端不是"等答案好了来取"，而是订阅回合、一边收一边显示。`subscribe_turn` 在 `deeptutor/services/session/turn_runtime.py:1039`，它的逻辑是：

1. 先读已落库的历史事件 `get_turn_events`（`deeptutor/services/session/turn_runtime.py:1044`），把"之前已经发生的"一次性补发给新订阅者（避免重连后界面空白）。
2. 如果这个回合已经不在 `running`（`deeptutor/services/session/turn_runtime.py:1095`），但前端还没收到终态事件，就**合成**一个 DONE 或 ERROR 事件 `_synthesize_done_event`（`deeptutor/services/session/turn_runtime.py:1139`）/ `_synthesize_error_event`（`deeptutor/services/session/turn_runtime.py:1172`），让前端能正常收尾。

这套"先补历史、再转直播、必要时合成终态"的机制，保证了即使订阅者中途加入或重连，也能拿到完整、闭合的事件流。

```text
subscribe_turn(turn_id)              deeptutor/services/session/turn_runtime.py:1039
   │
   ├─ 补发已落库历史事件               deeptutor/services/session/turn_runtime.py:1044
   ├─ 回合仍在跑？直播后续事件
   └─ 已结束但无终态事件？合成 DONE/ERROR  deeptutor/services/session/turn_runtime.py:1139
```

## 标题自动生成

每个会话在侧边栏要显示一个标题。标题由模型生成，但模型爱加一堆废话（引号、`Title:` 前缀、表情符号），所以 `_sanitize_session_title`（`deeptutor/services/session/turn_runtime.py:141`）会反复"剥包装"：去 `*`、`#`、前缀、外围引号、结尾标点，最后截断到 80 字符（`deeptutor/services/session/turn_runtime.py:169`）。它在 `_maybe_generate_session_title`（`deeptutor/services/session/turn_runtime.py:1808`）里被调用，且刻意放在 DONE 之后（`deeptutor/services/session/turn_runtime.py:1801`）——这样"答案存盘"和"计时器停"不被标题生成拖慢。

## 取消与重生成

运行时还提供两个配套操作：

- `cancel_turn`（`deeptutor/services/session/turn_runtime.py:992`）：把正在跑的回合标记为 `cancelled`（`deeptutor/services/session/turn_runtime.py:999`）。注意它先检查状态是否还是 `running`，不是就不动。
- `regenerate_last_turn`（`deeptutor/services/session/turn_runtime.py:876`）：删掉末尾的助手消息，用"不重复写用户消息"的方式重跑上一轮（`deeptutor/services/session/turn_runtime.py:884` 的 `_persist_user_message=False` + `_regenerate=True`）。原始用户消息保留，相当于"换个答法再答一次"。

## 存储层：同一套接口，两种落地

回合和消息都不是直接写文件，而是经过一个**存储协议 `SessionStoreProtocol`**（`deeptutor/services/session/protocol.py:23` 起定义 `ensure_session`、`create_turn`、`add_message`、`update_turn_status` 等方法）。好处是上面所有这些代码完全不知道底下到底是 SQLite 还是 PocketBase。

| 方法 | 协议定义位置 | SQLite 实现 | PocketBase 实现 |
| --- | --- | --- | --- |
| create_turn | deeptutor/services/session/protocol.py:28 | deeptutor/services/session/sqlite_store.py:578 | deeptutor/services/session/pocketbase_store.py:461 |
| add_message | deeptutor/services/session/protocol.py:46 | deeptutor/services/session/sqlite_store.py:897 | deeptutor/services/session/pocketbase_store.py:323 |
| update_turn_status | deeptutor/services/session/protocol.py:36 | deeptutor/services/session/sqlite_store.py:654 | deeptutor/services/session/pocketbase_store.py:562 |
| get_active_turn | deeptutor/services/session/protocol.py:32 | deeptutor/services/session/sqlite_store.py:618 | deeptutor/services/session/pocketbase_store.py:522 |

> **说明 · 为什么需要"统一会话管理器"？**
>
> `UnifiedSessionManager`（`deeptutor/services/session/unified_session_manager.py:16`）把聊天、解题、提问等所有模式都塞进同一个文件/集合里，只用 `mode` 字段区分（`deeptutor/services/session/unified_session_manager.py:25`）。这样无论用户切到哪种"深度模式"，对话历史都还在同一场会话里，不会开新坑。它的 `get_unified_session_manager`（`deeptutor/services/session/unified_session_manager.py:72`）也是全局单例。

## 暂停与续传：ask_user 不会丢回合

有些工具（如 `ask_user`）会让智能体中途停下来问用户一个问题，等用户答了再继续。这不是新建回合，而是同一回合内的"暂停-续跑"。运行时在 `_run_turn` 一开始就建好一个回复队列 `reply_queue`（`deeptutor/services/session/turn_runtime.py:1229`），并把它塞进上下文的 `wait_for_user_reply` 钩子里（`deeptutor/services/session/turn_runtime.py:1699`）。工具暂停时，前端发来的回答会进这个队列，循环从队列取出后继续——回合始终是同一条。

## 崩溃场景复盘

把前面串起来，看两种崩溃：

```text
场景 A：执行中途进程被杀
   数据库：turn 仍为 running，user/assistant 消息可能只写了一半
   重启后：下一个 start_turn 触发 _recover_orphan...
           -> 把该 turn 标 failed（deeptutor/services/session/turn_runtime.py:674）
   前端：重发消息 -> 新建回合，干净重来

场景 B：执行成功但还没写 final status 时崩
   与 A 同归：孤儿回收把它标 failed，用户重发即可
```

关键点：**最终状态只在 `_run_turn` 末尾那一次 `update_turn_status` 落库（`deeptutor/services/session/turn_runtime.py:1774`）**。在此之前任何崩溃都让回合停在 `running`，而 `running` 在重启后一定会被回收成 `failed`。所以系统永远处于"要么是明确终态，要么会被回收成终态"的闭环里，不会卡死。

## 消息树、分支与计数

对话不是永远线性的。用户在历史某条消息上"改一句重问"，就会产生**分支**。`_run_turn` 通过 `parent_message_id`（`deeptutor/services/session/turn_runtime.py:1268`）支持这一点：前端显式带 `parent_message_id` 时，新消息就挂在那条父消息下当兄弟节点（`deeptutor/services/session/turn_runtime.py:1270` 起解析），否则才追加到末尾。LLM 取历史时也只取"该父消息的祖先链"（`deeptutor/services/session/turn_runtime.py:1372` 的 `get_messages_for_context`，`leaf_message_id=branch_parent_id`），不会把无关分支混进来。

分支还影响上下文预算。`_count_branch_user_turns`（`deeptutor/services/session/turn_runtime.py:299`）会统计某分支下有多少条用户消息，用来决定"这段历史该截取多长"。分支编辑让"回到过去改一句、看不同答案"成为可能，而不会污染主线。

```text
主线:   A -> B -> C -> D
改 B 重问:
        A -> B -> B'（B' 是 B 的兄弟，挂在 A 下）
        LLM 只看 A -> B' 这条祖先链，不看 C、D
```

## 实时事件发布的内部机制

前端之所以能"边跑边看"，靠的是运行时把每个事件同时推给订阅者、并缓冲一份。`_run_turn` 开头就准备好几个收集器：

- `assistant_events`（`deeptutor/services/session/turn_runtime.py:1206`）：缓存所有发给前端的事件，落库终态时要用。
- `content_segments` / `narration_call_ids`（`deeptutor/services/session/turn_runtime.py:1211`）：分别攒"可见内容"和"需排除的旁白 id"。
- `generated_attachments` / `seen_artifact_urls`（`deeptutor/services/session/turn_runtime.py:1224`）：收集模型这次生成的文件（如代码产物），按 URL 去重。

回合一开始，运行时先发一个 `SESSION` 事件（`deeptutor/services/session/turn_runtime.py:863`），告诉前端"这是哪场会话、哪个回合"（元数据在 `deeptutor/services/session/turn_runtime.py:851` 构造）。执行中，每来一个事件都经 `_publish_live_event` 推给所有订阅者，并挑出要持久化的内容。跑完后，`_flush_buffered_events`（`deeptutor/services/session/turn_runtime.py:1769`）把缓冲的事件一次性补发，确保不丢。最后生成的文件还会在落库前抽预览文本 `fill_preview_text`（`deeptutor/services/session/turn_runtime.py:1729`），否则 Office 类二进制文件在浏览器里打开是空的。

## 标题只在特定条件下生成

标题生成不是每次都做，而是被精确定义在 `_run_turn` 末尾（`deeptutor/services/session/turn_runtime.py:1801`）：只有当 **不是重生成**、且 **回合状态是 completed** 时才调 `_maybe_generate_session_title`（`deeptutor/services/session/turn_runtime.py:1808`）。这样设计的意图写在注释里（`deeptutor/services/session/turn_runtime.py:1802`）：让"答案存盘"和"计时器停"不被标题生成拖慢——标题是可有可无的元信息，在前端短暂保持 socket 开着时再补发即可。失败、取消、重生成的回合都不生成标题，避免浪费一次模型调用。

> **提示 · 为什么把"非核心工作"挪到 DONE 之后？**
>
> 因为对用户来说，"答案已经存好、可以关掉等待"那一刻最重要。标题、预览抽取这类"锦上添花"的事如果卡在关键路径上，会让用户多等。DeepTutor 把这类事往后挪，是典型的"先交付核心、再补周边"的工程取舍。

## 小结

回合运行时就是把"用户一句话"变成一条可追踪、可恢复、可落库的任务记录。`start_turn`（`deeptutor/services/session/turn_runtime.py:682`）负责建档、做多用户模型授权门、起后台任务；`_run_turn`（`deeptutor/services/session/turn_runtime.py:1199`）负责处理附件、注入人格与技能、驱动智能体、筛选可持久化内容、按"先写消息、后写终态"的顺序落库；孤儿回合回收（`deeptutor/services/session/turn_runtime.py:677`）保证重启后不卡死；`subscribe_turn`（`deeptutor/services/session/turn_runtime.py:1039`）负责实时事件推送与重连补发；存储层用统一协议屏蔽 SQLite / PocketBase 差异。

## 一次完整回合的时序回放

把本章所有角色串成一条时间线，看清"用户点发送"到"答案落库"的全过程：

```text
t0  前端 POST 一条用户消息
t1  start_turn(payload)                      deeptutor/services/session/turn_runtime.py:682
      ├─ 权限/模型授权门                      deeptutor/services/session/turn_runtime.py:765
      ├─ ensure_session                      deeptutor/services/session/turn_runtime.py:717
      ├─ create_turn (running)               deeptutor/services/session/turn_runtime.py:844
      └─ create_task(_run_turn)              deeptutor/services/session/turn_runtime.py:873   <- 立刻返回给前端
t2  前端带着 turn_id 订阅事件
      subscribe_turn 补发历史 + 直播          deeptutor/services/session/turn_runtime.py:1039
t3  _run_turn 后台跑：                        deeptutor/services/session/turn_runtime.py:1199
      ├─ 处理附件/人格/技能
      ├─ ChatOrchestrator.handle(context)     deeptutor/services/session/turn_runtime.py:1703
      │     每个事件 -> _publish_live_event -> 前端实时显示
      ├─ add_message(user)                    deeptutor/services/session/turn_runtime.py:1631
      ├─ add_message(assistant)               deeptutor/services/session/turn_runtime.py:1741
      └─ update_turn_status(completed)        deeptutor/services/session/turn_runtime.py:1774
t4  前端收到 DONE，渲染完成
```

注意 t1 和 t3 是"发起"与"执行"解耦的：前端不等答案，靠订阅拿进度。这也是为什么重启后能用孤儿回收兜底——执行权只在 `_executions` 内存字典里（`deeptutor/services/session/turn_runtime.py:629`），进程没了，字典就没了，但数据库里 `running` 的回合会被下一个 `start_turn` 的回收逻辑（`deeptutor/services/session/turn_runtime.py:828`）清掉。

## 回合与能力、工具的关系

回合是"一次任务"的容器，但它自己不干活：

- **能力**决定"这条流水线怎么编排"（见第 23 章）。回合把 `capability` 名带给编排器（`deeptutor/services/session/turn_runtime.py:1703` 的 `ChatOrchestrator`），编排器按名找能力类并 `run`。
- **工具**是能力/循环手里的"零件"。回合构造的 `UnifiedContext`（`deeptutor/services/session/turn_runtime.py:1654`）里带着 `enabled_tools`，循环据此知道这次能调哪些工具（见第 22 章）。
- **LLM 服务层**（第 24 章）是真正"说话"的嘴，能力/工具内部都通过它调用模型。

所以四层是套娃关系：**回合 ⊃ 能力 ⊃ 工具 ⊃ LLM 调用**。回合运行时站在最外层，负责把这一切"装进一条可恢复、可落库的任务记录"里。

> **提示 · 读源码的入口建议**
>
> 想从零理解一次对话，就从 `deeptutor/services/session/turn_runtime.py:682` 的 `start_turn` 往下读，沿着 `create_turn` → `create_task(_run_turn)` → `ChatOrchestrator.handle` 这条主链，再分别跳到第 23/22/24 章看能力、工具、LLM 服务层。本章是"总装线"，其他三章是"零件车间"。

## 自查清单

- [ ] 我能用自己的话解释"回合 turn"和"会话 session"的区别。
- [ ] 我知道 `start_turn` 在 `deeptutor/services/session/turn_runtime.py:682`，它几乎是立刻返回、真正执行在后台 `_run_turn`。
- [ ] 我理解非管理员必须被分配模型授权，否则 `start_turn` 直接报错（`deeptutor/services/session/turn_runtime.py:770`）。
- [ ] 我理解 `running` 是进程本地概念，所以重启后需要"孤儿回合回收"。
- [ ] 我能说出 `_fail_orphan_running_turn`（`deeptutor/services/session/turn_runtime.py:661`）在什么条件下把回合标为 `failed`。
- [ ] 我知道回合终态有 completed/failed/cancelled/rejected（`deeptutor/services/session/turn_runtime.py:38`）。
- [ ] 我知道消息落库顺序是：先 `add_message(user)`、再 `add_message(assistant)`、最后 `update_turn_status`。
- [ ] 我理解 `_should_capture_assistant_content`（`deeptutor/services/session/turn_runtime.py:41`）和旁白过滤（`deeptutor/services/session/turn_runtime.py:77`）如何决定哪些内容成为"最终答案"。
- [ ] 我知道附件落库时会清空 base64、只留 URL（`deeptutor/services/session/turn_runtime.py:1363`）。
- [ ] 我理解 `SessionStoreProtocol` 让上层代码不关心底层是 SQLite 还是 PocketBase。
- [ ] 我能解释 `ask_user` 的暂停-续跑为什么不新建回合（`deeptutor/services/session/turn_runtime.py:1229`）。
- [ ] 我明白为什么"先写消息、后写终态"能让系统永不卡死。
