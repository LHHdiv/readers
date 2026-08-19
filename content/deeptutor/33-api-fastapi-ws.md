---
title: "第 33 章 · API 层 FastAPI / WebSocket"
date: 2026-08-01
summary: "前面几章都在讲\"内核能力\"。但用户总得有个入口来触发对话吧？这一章讲 DeepTutor 对外暴露的\"门面\"——基于 FastAPI 的 HTTP 接口，以及一条贯穿全场的 WebSocket 长连接。"
tags:
  - deeptutor
---
# 第 33 章 · API 层 FastAPI / WebSocket

前面几章都在讲"内核能力"。但用户总得有个入口来触发对话吧？这一章讲 DeepTutor 对外暴露的"门面"——基于 FastAPI 的 HTTP 接口，以及一条贯穿全场的 WebSocket 长连接。

很多人以为"智能体开发"就是调模型。其实一个能用的产品，一半功夫在**接口层**：怎么接收请求、怎么认证、怎么把模型一个字一个字蹦出来的过程实时推回给前端。本章带你把这个门面拆开看。

> **说明 · 什么是 WebSocket（先直觉后原理）**
>
> 直觉：普通 HTTP 像寄信——你写一封、对方回一封，问完就断。WebSocket 像打电话——拨通后双方一直在线，对方可以随时说话，不用你每次都重新拨号。
> 
> 原理：DeepTutor 的对话是"流式"的（答案边生成边发），如果用普通 HTTP 每发一个字就重新请求一次，既慢又浪费。所以用 WebSocket：前端和后端建立一条长连接，后端把每个事件（思考中、工具调用、最终答案……）顺着这条连接源源不断推过来。

## 一、三种入口，殊途同归

DeepTutor 有三条"发起一次对话"的路径，但它们最终都汇到一个函数：`AppFacade.start_turn`（`deeptutor/app/facade.py:114`）。理解这一点很重要——**入口可以有很多，核心只一处**。

| 入口 | 适用场景 | 怎么到 start_turn |
| --- | --- | --- |
| CLI（命令行） | 本地敲命令 | 直接调 `facade.start_turn` |
| WebSocket | 网页/IM 实时对话 | `unified_ws.py` 收到消息后调 `runtime.start_turn` |
| SDK | 别人把 DeepTutor 当库调用 | 直接调 `facade.start_turn` |

注意 WebSocket 路径里有一层 `runtime.start_turn`（`deeptutor/app/facade.py:120`），而 facade 的 `start_turn` 在它之上又包了一层：先解析能力名、再调 runtime、最后把"语言/笔记引用"等偏好写回会话（`deeptutor/app/facade.py:126`）。所以 facade 是更靠外的"门面"，runtime 是更靠内的"引擎"。

```text
CLI  /  SDK 调用
        │
        ▼
 AppFacade.start_turn()            ← deeptutor/app/facade.py:114
        │  (解析能力名、写回偏好)
        ▼
 runtime.start_turn()

网页 WebSocket 消息
        │
        ▼
 unified_websocket()              ← deeptutor/api/routers/unified_ws.py:45
        │  (认证、按 type 分发)
        ▼
 runtime.start_turn()             ← unified_ws.py:119
        │
        ▼
   同一条对话引擎（ChatOrchestrator）
```

> **提示 · 为什么统一到一个 start_turn**
>
> 如果 CLI、网页、SDK 各自写一套"开启对话"的逻辑，三处就会慢慢长歪、行为不一致，改一个 bug 要改三处。把它们都汇到 `start_turn`，等于给"开始一次对话"这件事定了**唯一真相源**。想加新入口（比如以后做个手机 App），只要最后调 `start_turn` 就行。

## 二、唯一的 WebSocket 端点

整个实时对话只用一个端点：`/api/v1/ws`。它定义在 `deeptutor/api/routers/unified_ws.py:45` 的 `unified_websocket`。文件开头（`unified_ws.py:7` 起）列了一长串客户端能发的消息 `type`，挑重点：

- `message` / `start_turn`：开启新一轮对话（`unified_ws.py:114`）。
- `subscribe_turn` / `subscribe_session`：只听某个回合/会话的事件流。
- `ping`：客户端心跳，服务端回 `pong`（`unified_ws.py:137`）。
- `cancel_turn`：取消正在跑的回合（`unified_ws.py:213`）。
- `submit_user_reply`：当用户被问问题（`ask_user`）暂停时，把答案送回去让循环继续（`unified_ws.py:226`）。
- `user_input`：往回合的"输入总线"塞一条用户回答（`unified_ws.py:297`）。

## 三、连接进来先过"认证"这一关

WebSocket 不像普通接口能用 FastAPI 的依赖注入做鉴权，所以认证是**在处理器内部**手动做的：`unified_ws.py:50` 调 `ws_require_auth(ws)`，如果返回的是"认证失败"标记就直接 return 关掉连接。确认通过后才 `await ws.accept()` 正式建立连接（`unified_ws.py:54`）。

连上之后，后端用 `safe_send` 这个内部函数发消息（`unified_ws.py:58`）。它有个小心机：序列化时用 `default=str`，意思是"万一某个事件里有无法 JSON 序列化的怪值，也别让整条推送通道崩掉"——否则一次序列化失败就会把 socket 标记为关闭，用户看到的就是"流突然冻住"。

## 四、按消息 type 分发（大 if 链）

WebSocket 处理器主体是一个 `while` 循环，不断 `receive_text` 收消息、解析成 JSON、再按 `msg_type` 走不同分支（`unified_ws.py:112` 起）。这是一个清晰的分发器：

```text
收到一条 JSON 消息
        │
        ▼
 解析出 msg_type
        │
        ├─ "message"/"start_turn"  → runtime.start_turn(msg)
        │                            然后 subscribe_turn 开始听事件
        ├─ "ping"                  → 回 "pong"
        ├─ "subscribe_turn"        → 订阅某回合事件流
        ├─ "cancel_turn"           → runtime.cancel_turn
        ├─ "submit_user_reply"     → runtime.submit_user_reply
        ├─ "user_input"            → 写进那个回合的 StreamBus
        ├─ "regenerate"            → 重跑最后一条用户消息
        └─ 其它                    → 回 "Unknown type" 错误
```

最常用的是 `start_turn` 分支（`unified_ws.py:114`）：它先 `runtime.start_turn(msg)` 拿到 `(session, turn)`，若抛 `RuntimeError`（比如"已有回合在跑"）就给用户回一条错误事件；成功则立刻 `subscribe_turn(turn["id"])` 开始把事件流推回去（`unified_ws.py:134`）。

## 五、事件是怎么"流"回前端的

你打字问问题后，网页上答案是一个字一个字出现的，背后就是这条事件流。机制是这样：

1. `runtime.start_turn` 真正执行对话，过程中会不断产生事件（思考、工具调用、内容片段……）。
2. WebSocket 端用 `subscribe_turn` 开一个异步任务（`unified_ws.py:80` 的 `subscribe_turn`），里面 `async for event in runtime.subscribe_turn(turn_id, ...)` 不断拿到事件，逐个 `safe_send` 推给前端（`unified_ws.py:85`）。
3. 前端收到事件后渲染成气泡、工具卡等（前端怎么渲染见第 34 章）。

`user_input` 分支（`unified_ws.py:297`）则展示了另一条反向通道：当对话中需要"暂停等用户输入"（比如 `ask_user`），前端把答案通过 `bus.submit_input` 塞进那个回合的输入总线，循环就能继续往下走。

> **注意 · 断线了怎么办**
>
> 网络会抖。后端有个 `check_active_turn` 分支（`unified_ws.py:161`）专门处理"客户端说有个回合在跑，但我这进程其实没在跑"的情况——通常是重启后残留的脏数据。后端会去查到底是真在跑还是"僵尸记录"，僵尸的就标记为取消，好让客户端能重新发起。这是真实部署里很常见的坑：别假设客户端记的"我在跑"一定和服务器一致。

## 六、整个 API 应用怎么装配起来

后端不只是 WebSocket，还有几十个普通 HTTP 接口（知识库、笔记、设置、伙伴……）。它们都在 `deeptutor/api/main.py` 里被装配到一个 FastAPI 应用上。

- `app = FastAPI(...)` 在 `deeptutor/api/main.py:234` 创建，并设了 `lifespan`（启动/关闭钩子）。
- 几十个 router 在 `deeptutor/api/main.py:312` 附近被 import，然后在 `:350` 之后逐个 `app.include_router(...)` 挂到 `/api/v1/...` 前缀下。
- 我们的 WebSocket 端点挂在 `deeptutor/api/main.py:476`：`app.include_router(unified_ws.router, prefix="/api/v1", ...)`。注意注释特意说明"认证在处理器内部做"，因为标准 FastAPI 依赖注入对 WebSocket 不好使。

`lifespan`（`deeptutor/api/main.py:102`）在启动时干一堆初始化：校验工具一致性、初始化 LLM 客户端、启动事件总线、自动启动 Partners、启动定时任务、迁移旧版记忆……关闭时则反向收尾，包括**关闭所有 MCP 连接**（`deeptutor/api/main.py:198` 调 `get_mcp_manager().shutdown()`）。这正是第 31 章说的"每个 MCP 服务器有自己的 AsyncExitStack，必须在关闭时正规拆除"。

## 七、一个安全的细节：CORS

前端跑在另一个端口（开发时通常是 3000），浏览器出于安全会限制跨域请求。后端在 `deeptutor/api/main.py:283` 构建 CORS 设置：如果鉴权**没开**（本地单机模式），就放宽到允许任意来源（`allow_origin_regex = r"https?://.*"`）；一旦开了鉴权，就只认显式配置的来源（`deeptutor/api/main.py:93`）。这个"本地宽松、上鉴权就收紧"的策略，是兼顾开发便利和生产安全的典型做法。

```text
HTTP 请求进来
        │
        ▼
 selective_access_log 中间件（只记非 200）
        │
        ▼
 CORS 校验（本地宽松 / 生产收紧）
        │
        ▼
 路由到对应 router
   /api/v1/ws            →  unified_ws（内部认证）
   /api/v1/knowledge ... →  各业务 router（依赖注入认证）
```

## 八、更多消息类型详解

除了 `start_turn` 和 `ping`，处理器还处理几类值得理解的消息：

- **`regenerate`（重生成）**（`unified_ws.py:262`）：把当前会话最后一条用户消息"重跑一遍"成全新回合，替换掉末尾的助手回复。可以带 `overrides` 覆盖模型/工具/知识库等。如果已有回合在跑会报 `regenerate_busy`，如果没有历史用户消息会报 `nothing_to_regenerate`。
- **`check_active_turn`（查活动回合）**（`unified_ws.py:161`）：客户端刷新时问"这个会话有没有正在跑的回合"。关键逻辑是它会去核实"持久化里写着 running 的那条，到底是不是真在跑"——重启后遗留的脏记录会被标成取消（`unified_ws.py:186`），避免客户端被假"正在跑"挡住、没法发起新回合。
- **`resume_from`（断线续传）**（`unified_ws.py:196`）：重连后带着 `turn_id` 和 `seq` 订阅，只听"我断线之后"的事件，不重听旧的。这和第 34 章前端 `UnifiedWSClient` 在 `onopen` 时发 `resume_from` 正好配对。
- **`unsubscribe`**（`unified_ws.py:204`）：取消之前建的订阅，按 `turn_id` 或 `session_id` 停掉对应的转发任务。

## 九、订阅任务是怎么管的

每次 `subscribe_turn`，处理器都开一个**独立的 asyncio 任务**去监听事件流并推送（`unified_ws.py:80` 的 `subscribe_turn` 内部 `asyncio.create_task`）。所有这类任务记在 `subscription_tasks` 字典里（`unified_ws.py:56`）。好处是：一个 WebSocket 连接上能同时订阅多个回合/会话的流，互不阻塞。

连接断开或出错时（`unified_ws.py:320` 的 `finally`），会遍历把这些订阅任务全部取消、并 `reset_current_user` 清掉当前用户上下文——**这一步很关键**：不清的话，当前请求的"用户身份"会泄漏到后续复用的连接/任务里，造成越权。这和第 35 章的 `ContextVar` 生命周期是配套的。

## 十、其它 HTTP 接口一览

WebSocket 只管"对话流"，其余功能都是普通 HTTP 接口，全在 `deeptutor/api/main.py` 里挂载。挑几个有代表性的：

| 前缀 | 负责什么 | 代码位置 |
| --- | --- | --- |
| `/api/v1/knowledge` | 知识库增删查 | `main.py:374` |
| `/api/v1/sessions` | 会话列表/重命名/删除 | `main.py:401` |
| `/api/v1/settings/mcp` | 管理员 MCP 服务器配置 | `main.py:422` |
| `/api/v1/space/mcp` | 用户自建 MCP（仅 `_auth`） | `main.py:432` |
| `/api/v1/partners` | Partner 管理（admin） | `main.py:464` |
| `/api/v1/multi-user` | 多用户授权/用户管理 | `main.py:363` |
| `/api/v1/auth` | 登录/登出/注册（公开） | `main.py:350` |

注意一个安全细节：`space_mcp`（用户自建 MCP）和 `space_cli_apps` 只挂了 `_auth`（登录即可），因为路由内部自己按 owner 解析、且只允许远程传输（`main.py:428` 注释）；而 `partners` 挂的是 `_admin`，因为 Partner 是管理员管的全局资源。

## 十一、启动钩子 lifespan 里还干了啥

`lifespan`（`main.py:102`）是应用"开/关"的总开关。启动时除了前面提的，还有：

- `validate_tool_consistency`（`main.py:112` / 定义在 `:43`）：校验"能力清单里引用的工具名"确实都注册在运行时工具表里。若有漂移（引用了不存在的工具），直接抛错拒绝启动——防止配置和代码对不上导致运行时才崩。
- 启动事件总线 `get_event_bus().start()`（`main.py:125`）、自动启动 Partners（`main.py:134`）、启动定时任务 `get_cron_service()`（`main.py:141`）、Ping PocketBase（`main.py:148`）、迁移 v1 记忆（`main.py:157`）。
- 关闭时反向收尾：停定时任务、停 Partners、关 MCP 连接、关 LLM 连接池、关事件总线（`:177` 起）。

## 十二、还有第二个 WebSocket：Quiz 评判

除了对话用的 `/api/v1/ws`，还有一个 `quiz_judge` 的 WebSocket（`main.py:480`，路由在 `deeptutor/api/routers/quiz_judge.py`）。它服务于"测验自动评判"场景，独立成端点是为了不和对话流抢通道。两者都因为 FastAPI 依赖注入对 WebSocket 不好使，而把认证放在处理器内部（见 `main.py:478` 注释）。

```text
浏览器/IM
   │
   ├─► /api/v1/ws       统一对话流（unified_ws.py）
   │        │
   │        ├─ start_turn → runtime.start_turn → 对话内核
   │        └─ 事件经订阅任务实时推回
   │
   └─► /api/v1/quiz_judge  测验评判流（quiz_judge.py）
```

> **注意 · 认证的两个位置别混淆**
>
> 普通 HTTP 接口用 `Depends(require_auth)` 在路由层拦（FastAPI 依赖注入）；WebSocket 因为没有好用的依赖注入，只能在处理函数开头手动 `ws_require_auth`（`unified_ws.py:50`）。读源码时看到两种写法都是"同一套鉴权"，只是实现位置不同。改安全逻辑时两处都要看。

## 十三、前端发来的 start_turn 长啥样

第 34 章讲前端会发一个 `start_turn` 消息。它在 WebSocket 上实际是这样一个 JSON（示意，字段与后端 `TurnRequest` 对应）：

```json
{
  "type": "start_turn",
  "session_id": "sess_abc",
  "content": "用费曼学习法讲相对论",
  "capability": "chat",
  "knowledge_bases": ["admin:kb:physics"],
  "language": "zh",
  "tools": ["search_kb", "mcp_notion_find"],
  "llm_selection": { "profile_id": "openai", "model_id": "gpt-4o" }
}
```

后端 `unified_ws.py:114` 收到后，透传给 `runtime.start_turn(msg)`（`unified_ws.py:119`），再往前走到 `AppFacade.start_turn`（`facade.py:114`）做能力名解析，最后落到 `runtime.start_turn`（`facade.py:120`）。一条消息从"网络字节"到"真正开聊"，中间经过这三层。

## 十四、错误事件长啥样

不是所有推送都是成功内容。失败时后端会发一个 `error` 类型事件（`unified_ws.py:313`）。它大致是：

```json
{
  "type": "error",
  "source": "unified_ws",
  "content": "Unknown type: foobar",
  "metadata": { "turn_terminal": true, "status": "rejected" }
}
```

注意 `turn_terminal: true`：它告诉前端"这一轮到此为止、可以重新发起了"。`start_turn` 分支里构造错误事件时（`unified_ws.py:121`）也带这个标记，配合第 32 章 Partners 里 `check_active_turn` 清理脏记录，保证"卡住的回合"能被用户重新发起。

## 十五、访问日志中间件

`selective_access_log`（`main.py:268`）是个 HTTP 中间件：它只对**非 200** 的响应记访问日志。`main.py:246` 的注释解释原因——前端 polling 的 `/settings`、`/tools`、`/knowledge/list` 这些 200 请求太吵，记了反而淹没真正要关注的错误。这是"日志要有信号、别有噪音"的典型取舍。

## 十六、CORS 的两种模式

`_build_cors_settings`（`main.py:71`）在启动时决定 CORS 策略：

- **鉴权关闭（本地）**：`allow_origin_regex = r"https?://.*"`，即"放行任意来源"——方便本地单机随便连（`main.py:93`）。
- **鉴权开启（生产）**：只允许 `allow_origins` 里显式配置的那些来源，且 `allow_credentials=True`（`main.py:90` / `:294`）——跨域带凭证时必须精确匹配，不能再用通配。

这和第 35 章的"鉴权开关决定宽松/严格"是一脉相承的设计哲学：本地图方便、生产图安全。

```text
请求进入 FastAPI
   │
   ├─ selective_access_log：非 200 才记日志
   ├─ CORS 校验：本地通配 / 生产显式来源
   └─ 路由分发
        ├─ /api/v1/ws      → unified_ws（内部认证）
        ├─ /api/v1/...     → 各业务 router（依赖注入认证）
        └─ /api/v1/multi-user → admin 授权接口
```

> **提示 · start_turn 的三层调用到底是哪三层**
>
> 记住这个顺序，读 API 代码就不会迷路：① `unified_ws.py:119` 的 `runtime.start_turn(msg)`（WebSocket 层入口）→ ② `facade.py:114` 的 `AppFacade.start_turn`（门面：解析能力、写偏好）→ ③ `facade.py:120` 的 `self.runtime.start_turn(...)`（真正的引擎）。"门面"和"引擎"是两层，别混为一谈。

## 十七、从请求到事件：一张时序图

把"用户敲回车"到"看到答案"的完整时序画出来，你会更清楚各层协作：

```text
前端 (第34章)               unified_ws.py             facade/runtime            对话内核
   │                            │                          │                     │
   │── start_turn JSON ───────►│                          │                     │
   │                            │── runtime.start_turn ──►│                     │
   │                            │        (unified_ws:119) │── start_turn ──────►│
   │                            │                          │   (facade.py:114)   │ 跑循环
   │                            │◄─ subscribe_turn 订阅 ──│                     │ 产生事件
   │◄──── 事件流 (content/ ─────│◄── safe_send 推送 ─────│◄── 事件 ────────────│
   │     tool_call/done) ──────│   (unified_ws:85)       │                     │
   │                            │                          │                     │
   │── (可选) cancel_turn ────►│── runtime.cancel_turn ──│────────────────────►│ 中断
```

注意两个并行的事：① 主流程 `start_turn` 真正开跑；② 同时开一个订阅任务把事件流推回前端。这两件事由同一个 WebSocket 处理器里的两个协程分别负责，互不阻塞。

## 十八、一图总结 API 层

```text
                    FastAPI 应用 (api/main.py:234)
        ┌───────────────────────────────────────────────┐
        │  lifespan: 启动初始化 / 关闭收尾 (main.py:102)  │
        │  CORS: 本地宽松 / 生产收紧 (main.py:71)          │
        │  selective_access_log: 只记非200 (main.py:268)  │
        ├───────────────────────────────────────────────┤
        │  HTTP routers (几十个) 挂 /api/v1/...           │
        │    knowledge / sessions / settings / mcp ...    │
        │  multi-user router (admin, main.py:363)         │
        ├───────────────────────────────────────────────┤
        │  WebSocket /api/v1/ws (unified_ws.py:45)        │
        │    认证→按type分发→订阅事件流→推回前端           │
        │  WebSocket /api/v1/quiz_judge (判题)            │
        └───────────────────────────────────────────────┘
                         │
                         ▼
             AppFacade.start_turn (facade.py:114)
                         │
                         ▼
              统一的对话引擎 (ChatOrchestrator)
```

> **说明 · 学完这章你该建立的直觉**
>
> 无论用户从 CLI、网页 WebSocket 还是 SDK 进来，**最后都落在同一个 `start_turn`**。所以"加一种接入方式"是低成本的事，难的是"把对话引擎本身做好"。API 层本质就是"把外面千奇百怪的请求，翻译成引擎听得懂的一句话"。

## 十九、常见误区

- 误区：WebSocket 和 HTTP 用同一套鉴权。正解：HTTP 用依赖注入 `require_auth`，WS 在处理器内手动 `ws_require_auth`（`unified_ws.py:50`）。
- 误区：`start_turn` 在 `facade.py` 和 `runtime` 是同一层。正解：`facade.start_turn`（`facade.py:114`）是门面（解析能力、写偏好），`runtime.start_turn`（`facade.py:120`）才是引擎，分两层。
- 误区：事件流靠主流程顺手推。正解：开了一个独立的订阅任务（`unified_ws.py:80`）专门监听并 `safe_send`。
- 误区：连接断了用户得手动重连。正解：前端发 `resume_from`（`unified_ws.py:196`）自动续传断点之后的事件。
- 误区：所有日志都记。正解：`selective_access_log`（`main.py:268`）只记非 200，避免 polling 噪音淹没错误。

## 黑话小词典

| 黑话 | 人话解释 |
| --- | --- |
| FastAPI | Python 的 Web 框架，用来写 HTTP 接口 |
| WebSocket | 拨通后一直连着、双方随时互发的"电话"，不同于一问一答的 HTTP |
| 路由 router | 一段 URL（如 `/api/v1/knowledge`）对应的一组接口 |
| 门面 facade | 对外统一包装的一层，隐藏内部复杂度（AppFacade） |
| 依赖注入 Depends | FastAPI 在调用接口前自动先跑的"前置检查"（如鉴权） |
| 事件流 event stream | 后端把思考/工具/答案等事件顺着连接一个个推过来 |
| 生命周期 lifespan | 应用启动和关闭时统一做的事（初始化/清理） |

## 自查清单

- [ ] 我能说出 DeepTutor 的三种入口，以及它们都汇到 `facade.start_turn`（`facade.py:114`）
- [ ] 我知道 WebSocket 端点只有一个：`/api/v1/ws`（`unified_ws.py:45`）
- [ ] 我理解 WebSocket 为什么比普通 HTTP 更适合"流式回复"
- [ ] 我知道连接进来先在 `unified_ws.py:50` 做认证，通过才 accept
- [ ] 我能描述处理器怎么按 `msg_type` 分发消息（大 if 链）
- [ ] 我讲得出事件流是怎么通过 `subscribe_turn` 推回前端的（`unified_ws.py:80`）
- [ ] 我知道 `start_turn` 和 `runtime.start_turn` 的层级关系（`facade.py:120`）
- [ ] 我了解 `lifespan` 在关闭时会正规拆除 MCP 连接（`main.py:198`）
