---
title: "第 34 章 · 前端 Next.js"
date: 2026-08-01
summary: "后端讲完了，这一章看看\"脸面\"——用户真正看到的网页界面。它基于 **Next.js** 框架，用 **React** 渲染。本章只做\"鸟瞰\"，不抠每个组件，重点是：框架到底是什么版本、前端怎么连上后端那条 WebSocket、以及事件流怎么变成你屏幕上的气泡和工具卡。"
tags:
  - deeptutor
---
# 第 34 章 · 前端 Next.js

后端讲完了，这一章看看"脸面"——用户真正看到的网页界面。它基于 **Next.js** 框架，用 **React** 渲染。本章只做"鸟瞰"，不抠每个组件，重点是：框架到底是什么版本、前端怎么连上后端那条 WebSocket、以及事件流怎么变成你屏幕上的气泡和工具卡。

> **说明 · 什么是 Next.js / React（先直觉后原理）**
>
> 直觉：网页不是一张写死的图，而是一棵"组件树"。React 让你用"组件"这种积木拼页面，数据一变，相关积木自动重画。Next.js 是 React 的"全套脚手架"——它管路由、管打包、管服务端渲染，让你专注写页面。
> 
> 原理：React 用"状态（state）"驱动"界面（UI）"——界面是状态的函数。DeepTutor 前端把"从 WebSocket 收到的事件"维护进状态，React 发现状态变了就重渲染对应区域，于是你看到答案实时冒出来。Next.js 则把这些页面组织成 `app/` 下的路由目录。

## 一、真实版本号（已核实，勿凭记忆）

打开 `web/package.json` 确认，当前依赖里：

- **Next.js**：`^16.2.3`（`web/package.json:35`）—— 这是第 16 代大版本。
- **React**：`^19.0.0`（`web/package.json:36`）与之配套，`react-dom` 同为 19（`web/package.json:38`）。
- **开发/构建脚本**：`dev` 用自定义的 `scripts/dev.mjs`（`web/package.json:6`），`build` 是标准 `next build`（`web/package.json:8`）。

 注意：仓库根 `README.md:178` 的历史记录里曾提到"Next.js 16 & React 19 升级"，与当前 `package.json` 一致，说明这套版本是较新的统一升级结果。写文档时务必以 `package.json` 为准，不要套用旧规范里的版本号。

其它值得留意的前端依赖（都在 `web/package.json`）：`react-markdown`（渲染模型返回的 Markdown）、`mermaid` 与 `cytoscape`（画图/可视化）、`i18next`（多语言）、`framer-motion`（动画）、`tailwindcss`（样式）。这些对应了聊天里"公式/图表/国际化"等能力。

## 二、目录结构（鸟瞰）

`web/` 下的关键部分：

| 目录 / 文件 | 作用 |
| --- | --- |
| `app/` | Next.js 路由页面（`(auth)` 登录、`(workspace)` 工作区、`(admin)` 管理台等） |
| `components/` | 可复用 UI 组件，按功能分子目录：`chat/`、`mcp/`、`partners/`、`knowledge/`、`settings/`…… |
| `lib/` | 纯逻辑/工具，`unified-ws.ts` 就在这一层 |
| `hooks/` | React 自定义钩子（把"取数据/订阅事件"封装成可复用逻辑） |
| `context/` | React 上下文（跨组件共享的全局状态，如登录用户） |
| `i18n/` `locales/` | 多语言文案 |

聊天相关的组件在 `components/chat/`，而 MCP 伴侣机器人相关 UI 在 `components/mcp/`、`components/partners/`（这与后端的 `deeptutor/services/mcp/` 和 `deeptutor/partners/` 一一呼应：后端管能力，前端管展示）。

```text
浏览器
   │
   │  用户打字、点按钮（React 组件，components/chat）
   ▼
 UnifiedWSClient (lib/unified-ws.ts)
   │  ── WebSocket ──►  /api/v1/ws  (后端 unified_ws.py)
   │  ◄── 事件流 ───
   ▼
 把事件写进 React 状态 (hooks/context)
   │
   ▼
 React 重渲染 → 气泡 / 工具卡 / 引用 出现在屏幕
```

## 三、WebSocket 客户端：unified-ws.ts

前端连后端的那根"电话线"就是 `web/lib/unified-ws.ts`。它导出一个类 `UnifiedWSClient`（`web/lib/unified-ws.ts:159`），封装了连接、心跳、重连三件事。

**1）连接**（`web/lib/unified-ws.ts:185` 的 `connect`）：它用 `new WebSocket(wsUrl("/api/v1/ws"))` 建立连接。连上后（`onopen`）会启动心跳，并且如果之前有"正在跑的回合"，会立刻发一个 `resume_from` 把中断的流续上（`web/lib/unified-ws.ts:197`）。

**2）收消息**（`web/lib/unified-ws.ts:206` 的 `onmessage`）：每收到一条 JSON，就解析成 `StreamEvent`。这里有个关键过滤：如果事件类型是 `ping` 或 `pong`（心跳包），**直接丢弃**，不交给上层——否则屏幕上会冒出一堆"Unknown type"的报错行（`web/lib/unified-ws.ts:216`）。同时它记下 `turn_id` 和最大的 `seq`，用于断线后从哪续传。

**3）心跳与重连**：每 30 秒发一次 `ping`（`web/lib/unified-ws.ts:261` 的 `startHeartbeat`，间隔常量在 `:154`），如果 45 秒没收到任何消息就主动断线重连（`HEARTBEAT_TIMEOUT_MS` 在 `:155`）。重连最多 5 次、按 2 的幂退避（`web/lib/unified-ws.ts:288` 的 `attemptReconnect`，基础延迟 `:157`）。

> **提示 · 为什么前端也要做心跳**
>
> 后端不知道"你这边网络断了没"，它只会一直等着发。如果连接悄悄死了，后端发的事件全丢、前端却以为还在跑。前端主动 30 秒 ping 一次、45 秒没回就判定"死了"去重连，等于自己给自己装了"生命探测器"。这和第 33 章后端回 `pong` 是对应的。

## 四、事件类型有哪些

`unified-ws.ts` 顶部定义了 `StreamEventType`（`web/lib/unified-ws.ts:17`）。这些类型名和后端 Python 里的事件类型一一对应，前端靠它们决定怎么渲染：

| 事件类型 | 含义 | 前端通常怎么画 |
| --- | --- | --- |
| `thinking` | 模型在思考 | 一个小转圈/思考中提示 |
| `content` | 正文片段 | 追加到当前气泡 |
| `tool_call` | 调用了某工具 | 一张"工具卡"（显示正在做什么） |
| `tool_result` | 工具返回结果 | 工具卡的展开内容 |
| `sources` | 引用来源 | 答案下方的"引用"列表 |
| `progress` | 进度 | 进度条/百分比 |
| `result` / `done` | 本轮结束 | 收尾、允许输入 |
| `error` | 出错 | 红色错误提示 |

`StreamEvent` 的字段（`web/lib/unified-ws.ts:33`）包括 `type`、`content`、`metadata`、`session_id`、`turn_id`、`seq` 等——`seq` 就是事件的序号，前端用它保证事件按顺序拼接、断线续传时不重不漏。

前端发往后端也用一套类型化的消息（`web/lib/unified-ws.ts:52` 起）：`StartTurnMessage`（开聊）、`SubscribeTurnMessage`、`ResumeTurnMessage`、`CancelTurnMessage`、`SubmitUserReplyMessage`（回答 `ask_user` 提问）等。它们的 `type` 字段字符串与第 33 章后端 `unified_ws.py` 的分发分支完全对得上——**前后端靠这套字符串契约协作**。

## 五、渲染：从事件到画面

前端不深抠组件，但给你一个心智模型：

- `hooks/` 里有个钩子负责"建立和 WebSocket 的连接、把事件喂给状态"。
- `context/` 里保存"当前会话、当前用户"等跨页面共享的状态。
- `components/chat/` 里的组件订阅这些状态：来一个 `content` 事件就把字追到气泡末尾；来一个 `tool_call` 就插入一张工具卡；来 `sources` 就在末尾挂引用列表。

因为 React 是"状态驱动界面"，所以前端代码里**几乎没有"手动操作 DOM"**，全是"事件 → 改状态 → React 自动重画"。这也是为什么同样的事件流，网页和 IM 通道能各自用完全不同的方式展示（网页画卡片，微信发纯文本，见第 32 章）。

> **说明 · 前后端如何保持一致**
>
> 最容易出的 bug 是：后端改了事件 `type` 名字，前端还在听旧名字，结果某类消息"看不见"。DeepTutor 的解法是**契约同源**——两端的类型名都来自同一套协议定义，前端 `StreamEventType` 的注释明确写"mirror Python StreamEventType"（`web/lib/unified-ws.ts:15`）。改协议时两头一起改，才能不脱节。

## 六、开发时怎么跑

本地开发用 `npm run dev`（实际调 `scripts/dev.mjs`，`web/package.json:6`），它启动 Next.js 开发服务器，通常监听 3000 端口；后端 FastAPI 另起一个服务（见第 33 章 CORS 里对 3000 端口的放行）。两者通过 `/api/v1/ws` 这条 WebSocket 沟通。生产环境则是 `npm run build` 再 `npm start`。

## 七、发起一轮对话：StartTurnMessage 长啥样

前端不是随便发个字符串给后端的。它构造一个**强类型**的消息对象 `StartTurnMessage`（`web/lib/unified-ws.ts:52`）。里面字段很多，挑常用的：

| 字段 | 含义 |
| --- | --- |
| `type` | 固定 `"message"` 或 `"start_turn"` |
| `content` | 用户这轮说的文字 |
| `tools` | 允许模型用哪些工具（白名单） |
| `capability` | 走哪种"能力"（如 chat / visualize） |
| `knowledge_bases` | 附带哪些知识库 |
| `session_id` | 归属哪个会话（不填就新建） |
| `attachments` | 附件（图片等，可传 base64 或 url） |
| `language` | 回复语言 |
| `notebook_references` | 关联的笔记本 |
| `persona` | 用哪个人格 |
| `llm_selection` | 选哪个模型配置 |
| `parent_message_id` | 编辑分支：在树的哪个节点下续写 |

注意 `parent_message_id`（`web/lib/unified-ws.ts:85` 注释）：它能让"重新编辑某条消息"变成"在那个节点下开一个分支"，而不是简单追加到末尾——这是对话"版本树"能力的客户端入口。这些字段名和后端 `TurnRequest`（`deeptutor/app/facade.py:114` 接收的对象）是对应的。

## 八、路由目录：app/ 的三类页面

`web/app/` 下按"路由组"组织页面，目录名带括号表示"只是分组、不进 URL 路径"：

- `(auth)`：登录、注册、找回密码等认证相关页。
- `(workspace)`：登录后的主工作区——聊天、知识库、笔记、可视化等。
- `(admin)`：管理员后台——用户管理、授权、全局设置。
- 根下还有 `layout.tsx`（所有页面的外壳）和 `globals.css`（全局样式）。

这种"按用户身份分目录"的组织，恰好对应后端第 35 章的"admin / user 作用域"——前端页面和后端权限是同构的。

## 九、状态从哪来：hooks 与 context

React 推崇"状态上提、单向流动"。DeepTutor 前端用两层来管状态：

- `context/`：放**跨页面共享**的全局状态，比如"当前登录用户""当前语言"。组件无论嵌多深都能直接读，不必一层层传 props。
- `hooks/`：放**可复用的取数/订阅逻辑**。比如有一个钩子专门负责"建立 WebSocket 连接、把事件喂进状态、断线自动重连"。组件只管"我要用对话"，不用管连接的脏活。

`components/chat/` 里的聊天组件订阅这些状态：来一个 `content` 事件就追到气泡末尾；来一个 `tool_call` 就插一张工具卡；来 `sources` 就挂引用。因为 React 是"状态→界面"的纯函数式映射，**几乎没有手动操作 DOM 的代码**。

## 十、组件与后端模块的呼应

前端 `components/` 下的子目录，几乎和后端模块一一呼应：

| 前端组件目录 | 对应的后端模块 |
| --- | --- |
| `components/chat/` | 对话内核（ChatOrchestrator） |
| `components/mcp/` | `deeptutor/services/mcp/` |
| `components/partners/` | `deeptutor/partners/` |
| `components/knowledge/` | 知识库模块 |
| `components/settings/` | 各类 settings 路由 |
| `components/quiz/` `components/visualize/` | 测验 / 可视化能力 |

这种"前端展示层 ↔ 后端能力层"的对称，让你顺着任一功能（比如 MCP）就能在两端找到对应代码，是阅读整个项目的捷径。

## 十一、多语言 i18n

`web/i18n/` 与 `web/locales/` 放多语言文案。界面上所有可见文字都走 `i18next`（`web/package.json:31`）的翻译键，而非硬编码中文/英文。这呼应了后端：对话请求里也有 `language` 字段（`unified-ws.ts:66`），前后端一起保证"用户看到的语言"和"模型回复的语言"一致。

## 十二、开发 / 构建 / 校验脚本

`package.json` 的 `scripts` 里除了 `dev`/`build`/`start`，还藏了不少工程化工具：

- `perf:check`（`web/package.json:12`）：用 `scripts/route_budgets.mjs` 检查每个路由的性能预算，防止页面变臃肿。
- `i18n:parity` / `i18n:audit`（`web/package.json:14` / `:15`）：核对各语言文案是否齐全、有无遗漏键。
- `audit`（`web/package.json:18`）：用 Playwright 跑一套 UI 审计测试。

这些不是智能体功能，但决定了"一个能上线的产品"还需要多少周边工程。理解它们，你才明白从"能跑的 demo"到"能用的产品"中间还差多少。

> **提示 · 想看实时效果？**
>
> 本地依次启动后端（FastAPI，见第 33 章）和前端（`npm run dev`，默认 3000 端口），浏览器打开后就能在聊天框打字。打开浏览器开发者工具的 Network 面板，筛选 WS，你能直接看到 `start_turn` 请求和后端推回的一连串 `content`/`tool_call`/`done` 事件——把第 33、34 章串起来看，理解会非常具体。

## 十三、一个 StreamEvent 的真实样子

后端推过来的每个事件，前端解析成 `StreamEvent`（`web/lib/unified-ws.ts:33`）。一个"内容片段"事件长这样（示意）：

```json
{
  "type": "content",
  "source": "chat",
  "stage": "answer",
  "content": "相对论的核心是……",
  "metadata": {},
  "session_id": "sess_abc",
  "turn_id": "turn_123",
  "seq": 7,
  "timestamp": 1723536000000
}
```

前端 `onmessage`（`unified-ws.ts:206`）拿到后，先看 `type`：是 `content` 就追加到气泡、是 `tool_call` 就插工具卡、是 `done` 就允许输入。`seq` 用来保证顺序和断线续传不重不漏（`unified-ws.ts:218` 取最大值）。注意 `ping`/`pong` 在这里被直接 `return` 丢弃（`unified-ws.ts:216`）——心跳不该变成屏幕上的"Unknown type"报错行。

## 十四、组件树的一瞥

虽然不深抠组件，但给你一个 React 组件树的直觉：

```text
App                        ← app/layout.tsx 外壳
 ├─ AuthProvider          ← context/ 里的登录态
 │   └─ ChatPage          ← app/(workspace) 下某路由
 │       ├─ MessageList   ← components/chat/
 │       │   ├─ UserBubble
 │       │   ├─ AssistantBubble  ← 订阅事件流、按 type 渲染
 │       │   │   ├─ ToolCard      ← tool_call / tool_result
 │       │   │   └─ SourceList    ← sources
 │       │   └─ ThinkingIndicator ← thinking
 │       └─ Composer      ← 输入框，发 StartTurnMessage
```

关键：`AssistantBubble` 不是"一次性拿到完整答案"，而是**订阅事件流、随到随画**。"状态变 → 自动重画"是 React 的精髓，也是流式聊天体验顺畅的根本原因。

## 十五、Next.js 的 App Router 是什么

`web/app/` 用的是 Next.js 的 **App Router** 模式：目录即路由，`page.tsx` 是页面，`layout.tsx` 是包裹层。带括号的目录（如 `(auth)`、`(workspace)`）是"路由组"——它组织代码但不往 URL 里加路径段。这套约定让你加页面时"建个文件夹就行"，和后端 `channels/` 的"加个文件就行"异曲同工：都是**约定优于配置**。

## 十六、本地怎么跑起来看效果

开发模式下：后端用 `deeptutor start`（或对应启动脚本）起 FastAPI，前端 `npm run dev`（`web/package.json:6`）起 Next.js 开发服务器（默认 3000 端口）。两者通过 `/api/v1/ws` 通信。第 33 章提过，后端 CORS 默认放行 3000 端口（`main.py:82`），所以本地不会跨域报红。

想验证自己读懂没？打开浏览器开发者工具 → Network → 筛选 WS，你能直接看到：
1. 前端发出 `{"type":"start_turn", ...}`；
2. 后端狂推一连串 `thinking` / `content` / `tool_call` / `done`；
3. 断开网络再连，前端自动发 `resume_from` 续上。

把第 33、34 章对照着看，这一幕就全串起来了。

> **说明 · 前端这一层"薄"在哪**
>
> DeepTutor 前端几乎不写业务逻辑——判断"用户能用哪些工具/模型"、决定"这条消息发给谁"、做"权限校验"，全在后端。前端只负责：连 WebSocket、收事件、画界面、发消息。这种"前端薄、后端厚"的分工，让安全和逻辑都集中在服务端，也让你学源码时把重心放在 `deeptutor/` 后端上。

## 十七、前端为什么"薄"

反复强调一点：DeepTutor 前端几乎不写业务逻辑。判断"用户能用哪些工具/模型"、做"权限校验"、决定"消息发给谁"，**全在后端**。前端只做四件事：连 WebSocket、收事件、画界面、发消息（`lib/unified-ws.ts` 的 `UnifiedWSClient` 就是这层薄壳）。

这样设计的好处：

- **安全集中在服务端**：哪怕有人绕过前端直接调接口，后端照样拦（见第 35 章授权）。
- **逻辑只写一遍**：同样的"能用哪些模型"判断，后端 `model_access.py:59` 一处裁决，网页和 IM 共用，不会出现"界面显示能用、一选就报错"。
- **前端可替换**：哪天想换框架（或出手机 App），只要照着 `unified-ws.ts` 实现同一套消息契约即可。

## 十八、一图总结前端

```text
浏览器 (Next.js 16 / React 19)
   │
   ├─ app/        路由页面 (auth / workspace / admin)
   ├─ components/  UI 积木 (chat / mcp / partners / knowledge ...)
   ├─ hooks/      取数 / 订阅逻辑
   ├─ context/    跨页全局状态
   └─ lib/unified-ws.ts  ← 与后端唯一的"电话线"
            │
            │  WebSocket /api/v1/ws
            ▼
     后端 unified_ws.py (第33章)
            │
            ▼
   事件流 type: content/tool_call/sources/done ...
            │
            ▼
   React 状态变化 → 自动重绘 → 气泡/工具卡/引用 出现在屏幕
```

> **提示 · 给"想做智能体开发者"的下一步**
>
> 读到这里，你已经能把"用户说话 → 界面出现答案"这条链路从前端追到后端再到内核。下一步建议：打开 `web/lib/unified-ws.ts` 和 `deeptutor/api/routers/unified_ws.py` 并排看，把每个 `type` 字符串在两端对一遍——这是把"架构理解"变成"能动手改代码"的关键一跃。

## 十九、常见误区与小结

- 误区：前端很复杂、逻辑都在这里。正解：前端"薄"，判断与权限都在后端，前端只连 WS、收事件、画界面（`unified-ws.ts:159`）。
- 误区：版本号凭记忆写。正解：必须以 `web/package.json` 为准——Next.js `^16.2.3`、React `^19.0.0`（`package.json:35` / `:36`）。
- 误区：心跳是后端的事。正解：前端 `UnifiedWSClient` 自己 30s ping、45s 判定死连接并重连（`unified-ws.ts:154`）。
- 误区：ping/pong 会显示成消息。正解：`onmessage` 里直接丢弃心跳包（`unified-ws.ts:216`），否则屏幕冒出 "Unknown type" 报错行。
- 误区：前后端事件类型各写各的。正解：靠同一套 `type` 字符串契约协作，注释写明 "mirror Python StreamEventType"（`unified-ws.ts:15`）。

| 你看到的 | 背后发生的事 |
| --- | --- |
| 网页上答案一个字一个字冒 | 后端推 `content` 事件，React 状态驱动重绘 |
| 聊天里出现一张"工具卡" | 后端推 `tool_call`/`tool_result`，前端插卡 |
| 答案下方有"引用"列表 | 后端推 `sources`，前端挂引用 |
| 断网后自动恢复 | 前端 `resume_from` 续传断点后事件 |

> **提示 · 一句话收尾**
>
> 前端是 DeepTutor 的"脸"，但它几乎不思考——真正的智能在 `deeptutor/` 后端。学智能体开发，重心应放在后端那条"请求 → 引擎 → 事件流"的主链上。

## 二十、给零基础读者的上手路线

如果你是完全不懂编程、但想成为智能体开发者，建议按这条路线动手：

- 第一步：先在本机把 DeepTutor 跑起来，用网页版和它聊几次，建立"它能做什么"的直觉。
- 第二步：打开浏览器开发者工具，看 WebSocket 里 `start_turn` 和回推的 `content` 事件，把第 33、34 章在真实界面上对照一遍。
- 第三步：读 `web/lib/unified-ws.ts`，只关注 `connect`、`onmessage`、`send` 三个方法，弄懂"连、收、发"。
- 第四步：读后端 `deeptutor/api/routers/unified_ws.py` 的 `start_turn` 分支，看一条消息怎么进、事件怎么出。
- 第五步：回头读第 31、32、35 章，理解"外挂工具、IM 入口、多用户隔离"这三块是怎么挂到这条主链上的。

> **提示 · 不要试图一次读懂全部**
>
> 智能体项目动辄几万行。先抓住"用户说话 → 事件流回来"这条最粗的主链，再像剥洋葱一样往外层扩展。每多懂一层（API、前端、MCP、Partners、隔离），你离"能自己改"就近一步。

> **说明 · 前端与后端版本为什么重要**
>
> `web/package.json` 里的 Next.js 16 / React 19 不是装饰——大版本升级常常改 API 写法。比如 React 19 对 `useFormState`、Ref 处理有变化，Next.js 16 的 App Router 也有行为调整。所以**写前端代码前先确认 package.json 的真实版本**，别拿旧教程的写法硬套。这也是为什么任务强调"先 Read 核实、勿凭规范猜"。

## 黑话小词典

| 黑话 | 人话解释 |
| --- | --- |
| Next.js | React 的"全家桶"框架，管路由、打包、渲染 |
| React | 用"组件积木"拼页面、靠"状态"自动重画的 UI 库 |
| 组件 component | 页面上可复用的一个小积木（按钮、气泡、卡片） |
| 状态 state | 当前界面长啥样所依赖的数据，变了界面就重画 |
| 钩子 hook | 把"取数据/订阅"等逻辑封装好可复用的函数 |
| 上下文 context | 跨很多组件共享的全局数据（如登录用户） |
| App Router | Next.js 用"目录=路由"的组织方式 |
| 心跳 heartbeat | 定时发个小包证明"我还活着"，死了就重连 |

## 自查清单

- [ ] 我核实过：Next.js 是 `^16.2.3`、React 是 `^19.0.0`（`web/package.json:35` / `:36`）
- [ ] 我能说出 Next.js/React 各自负责什么（脚手架 vs 状态驱动 UI）
- [ ] 我知道聊天组件在 `components/chat/`，MCP/Partner UI 在 `components/mcp/`、`components/partners/`
- [ ] 我理解 `UnifiedWSClient` 负责连接、心跳、重连三件事（`lib/unified-ws.ts:159`）
- [ ] 我知道 `onmessage` 里会丢弃 `ping`/`pong` 心跳包（`lib/unified-ws.ts:216`）
- [ ] 我讲得出前端为什么也要做 30s 心跳 + 45s 超时判定（`lib/unified-ws.ts:154`）
- [ ] 我能列出几种 StreamEventType，并知道它们决定怎么渲染
- [ ] 我理解前后端靠同一套事件 `type` 字符串契约协作（`lib/unified-ws.ts:15`）
