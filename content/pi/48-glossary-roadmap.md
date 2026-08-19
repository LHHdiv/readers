---
title: "第 48 章 · 术语总表与进阶路线"
date: 2026-07-01
summary: "这是全文档的收尾。前面 47 章从 Transformer 讲到桌面端 Agent，术语散落各处。本章把它们收成一张\"速查表\"，再告诉你\"下一步去哪\"。建议把本章当书签——以后忘记某个词，先来这翻。"
tags:
  - pi
---
# 第 48 章 · 术语总表与进阶路线

这是全文档的收尾。前面 47 章从 Transformer 讲到桌面端 Agent，术语散落各处。本章把它们收成一张"速查表"，再告诉你"下一步去哪"。建议把本章当书签——以后忘记某个词，先来这翻。

## 核心术语总表

### 基础概念

- **Agent（智能体）**：能感知输入、自主调用工具、多步完成目标的程序。Pi 就是这样一个编码智能体。
- **LLM（大语言模型）**：基于海量文本训练、能续写/理解语言的模型，如 DeepSeek、Claude。Agent 的"大脑"。
- **Transformer**：现代 LLM 的底层神经网络结构，靠注意力机制处理序列（第 2 章）。
- **token（词元）**：模型处理文本的最小单位，中文约 1-2 字一个 token。计费与长度都按 token 算。
- **context window（上下文窗口）**：模型单次能"看到"的最大 token 数。超出需压缩或截断。
- **pretrain / RLHF（预训练 / 人类反馈强化学习）**：模型训练的两阶段，前者学语言，后者学"符合人类偏好"（第 3 章）。
- **reasoning model（推理模型）**：会在回答前做显式思考（如 DeepSeek-R1 类），对应 Pi 的 `thinkingLevel`。

### 工具与交互

- **function calling（函数调用 / 工具调用）**：LLM 输出"我要调用某函数并传这些参数"的结构化指令，由外部执行（第 7 章）。
- **tool（工具）**：智能体可调用的具体能力，如 `read`/`bash`/`edit`/`write`。Pi 默认内置这四个（`sdk.ts:245`）。
- **ReAct**：推理(Reason)与行动(Act)交替的 agent 范式，是 agent-loop 的思想来源（第 8 章）。
- **agent-loop（智能体循环）**："思考→行动→观察"反复执行的圈，是 Agent 类内部的核心（`sdk.ts:294` 的 `new Agent`）。
- **streaming（流式）**：模型边生成边返回 token，而非等全部生成完。Pi 用事件流呈现（第 11、21 章）。
- **stopReason（停止原因）**：一轮生成的结束标志，`stop`/`toolUse`/`length`/`error` 等，决定下一步动作。

### 知识与检索

- **RAG（检索增强生成）**：先检索外部知识再让模型回答，缓解"知识过时/幻觉"（第 9 章）。
- **vector DB（向量数据库）**：把文本转向量存储，按相似度检索，是 RAG 的常用底座。
- **MCP（模型上下文协议）**：让模型统一接入外部工具/数据源的开放协议（第 10 章）。

### 工程与成本

- **prompt cache（提示缓存）**：把重复的系统提示/工具定义缓存复用，命中后输入更便宜、首字更快（第 12 章）。
- **prompt engineering（提示工程）**：通过组织输入文本引导模型更好回答的技巧（第 6 章）。
- **adapter（适配器）**：把不同 provider 的 API 差异统一成 Pi 内部格式的层，如 OpenAI/Anthropic adapter（第 18、19 章）。
- **provider（模型供应商）**：提供模型 API 的服务方，如 DeepSeek、Anthropic。Pi 通过 `registerProvider` 接入（第 17 章、`types.ts:1417`）。

### Pi 特有概念

- **compaction（压缩）**：上下文接近上限时，把早期对话总结成摘要、丢弃原文，保留记忆（第 30 章）。
- **session tree（会话树）**：一次会话可分支（fork）、可跳转的历史树，比线性聊天更灵活（第 32 章）。
- **extension（扩展）**：`default function(pi)` 形式的插件，可注册工具/命令、订阅事件、接 provider（第 45 章、`types.ts`）。
- **skill（技能）**：以文件形式存在的可复用指令块，模型在对话中按需调用（见 `skills.ts` 导出）。
- **ExtensionAPI**：传给扩展工厂函数的对象，含 `on`/`registerTool`/`registerCommand`/`registerProvider`（`types.ts:1198`）。
- **customTools**：通过 `createAgentSession({ customTools })` 额外注册的工具（`sdk.ts:73`）。
- **createAgentSession**：一站式创建会话的 SDK 入口，封装好整套 agent-loop（`sdk.ts:169`）。
- **AgentSession**：会话对象，提供 `prompt()` 发消息、`subscribe()` 订阅事件（`agent-session.ts`）。

### 通信与可观测

- **CBOR**：一种二进制序列化格式，Pi 的 RPC 模式用它高效传输事件流。
- **RPC（远程过程调用）**：让外部程序远程驱动 Pi 的模式（`runRpcMode`，`index.ts:350`）。
- **telemetry（遥测）**：运行指标采集，用于排查与优化（如 token 用量、工具耗时）。
- **event bus（事件总线）**：扩展间通信的共享通道（`pi.events`，`types.ts:1436`）。
- **before_provider_request / after_provider_response**：扩展可拦截/观测每次模型请求与响应的钩子（`types.ts:676/692`）。

### 部署与运维词

- **build（构建）**：把 TS 源码编译成可加载的 JS（dist），多包仓库改核心后必须重 build。
- **dist（产物目录）**：构建输出，运行时实际被 `require`/`import` 的是它，不是 `src`。
- **workspace（工作区）**：npm/pnpm 的多包管理方式，Pi 用它在单仓里管理 agent-core/ai/coding-agent。
- **jiti**：TS 直加载器，Pi 用它免编译加载扩展的 `.ts` 入口。
- **SettingsManager**：运行时设置管理，含 provider 重试、超时、主题等（`index.ts:259` 导出）。
- **ModelRuntime**：模型与鉴权的运行时封装，由 `createAgentSession` 内部创建（`sdk.ts:45`）。
- **SessionManager**：会话持久化管理层，把对话写成 jsonl 以支持恢复/分支（第 31 章）。
- **ResourceLoader**：项目资源（技能/提示/扩展）的发现与加载器（`index.ts:197`）。
- **abort（中止）**：中断当前流式轮次，扩展上下文用 `ctx.abort()`（`types.ts:336`）。

### 自测：术语连连看

合上文档，看能否答出（答案即上面定义）：

- Q1：`agent-loop` 三步是哪三步？ → A：思考→行动→观察
- Q2：`context window` 超了会怎样？ → A：触发 compaction 压缩
- Q3：DeepSeek 的 key 环境变量叫什么？ → A：`DEEPSEEK_API_KEY`（`deepseek.ts:11`）
- Q4：扩展入口写在 `package.json` 的哪个字段？ → A：`pi.extensions`
- Q5：默认内置工具是哪四个？ → A：read/bash/edit/write（`sdk.ts:245`）
- Q6：`createAgentSession` 在第几章讲、源码哪行？ → A：第 44 章，`sdk.ts:169`
- Q7：想让工具并发执行改哪个字段？ → A：`executionMode: "parallel"`（`types.ts:477`）
- Q8：流式输出对应哪个订阅事件？ → A：`message_update`（`types.ts:749`）

> **说明**
>
> 答错任意一题，回去对应章节重读一遍。这 8 题覆盖了"能动手"的最低术语门槛；全对，说明你已具备独立做第 46 章桌面 Agent 的词汇量。

### 常见误解澄清

- **误解**：Agent = 一个超大的 prompt。→ 错。Agent 是"循环 + 工具 + 记忆"的运行系统，prompt 只是其中一小块。
- **误解**：token = 字。→ 近似但不等价。中文约 1-2 字一个 token，英文约 4 字符一个，公式化内容更密。
- **误解**：context window 越大越聪明。→ 错。窗口是"容量"不是"能力"，超出才需压缩，过大反而更贵更慢。
- **误解**：function calling 是 LLM 自己跑代码。→ 错。LLM 只输出"调用意图"，真正执行在你的代码里（第 7 章）。
- **误解**：extension 能改 Pi 核心逻辑。→ 部分能（事件拦截/注册），但核心循环在 `Agent` 类，扩展是挂件不是内核。
- **误解**：DeepSeek 要改 Pi 源码才能用。→ 错。provider 已内置，填 `DEEPSEEK_API_KEY` 即可（`deepseek.ts:10-11`）。

> **注意**
>
> 这些误解是初学者最高频的。尤其"function calling 是模型跑代码"这一条，会让很多人以为让 LLM 调工具很危险——其实危险操作由你的 `execute` 决定，模型只是"点单"。

### 一词多义提醒

有些词在 Pi 内外含义略有差异，别混：

- **session**：通用指"一次对话"；Pi 里特指可分支、可持久化的 `SessionManager` 会话树（第 32 章），不是简单数组。
- **tool**：通用指函数；Pi 里特指 `ToolDefinition` 结构，含 schema 与 `execute`，且会被 LLM 按需调用。
- **provider**：通用指"供应方"；Pi 里特指经 `registerProvider` 接入的模型服务，含 baseUrl/auth/models。
- **runtime**：通用指"运行时"；Pi 里 `ModelRuntime`/`ExtensionRuntime` 是具体封装对象，不是抽象概念。

### 其它常见词

- **thinkingLevel**：思考强度档位 `off/minimal/low/medium/high/max`，会被钳制到模型能力（`sdk.ts:50`、`types.ts:242`）。
- **ToolDefinition**：注册工具所需结构：`name/description/parameters/execute`（`types.ts:449`）。
- **SlashCommand（斜杠命令）**：以 `/` 开头的用户指令，如 `/model`、`/compact`，可由扩展注册（`types.ts:1175`）。
- **trust（项目信任）**：是否信任某项目的本地资源（提示/技能），影响是否自动加载（`types.ts:531`）。

> **说明**
>
> 以上约 40 条。建议初学者先吃透加粗的 12 个核心词（Agent、LLM、token、context window、function calling、ReAct、agent-loop、streaming、RAG、MCP、provider、extension），其余是它们的延伸。

## 下一步去哪：进阶阅读

### 1. 读 Pi 各包的 README 与 docs

仓库内 `packages/*` 下通常有 README，`packages/coding-agent/docs/` 有扩展等专题文档（如 `examples/extensions/README.md` 引用的 `docs/extensions.md`）。这是离源码最近的一手资料。

### 2. 顺一遍关键源码路径（按重要性）

| 你想深入 | 起点文件 | 关键行 |
|----------|----------|--------|
| 会话怎么建 | `packages/coding-agent/src/core/sdk.ts` | `createAgentSession` `:169` |
| 循环怎么转 | `packages/coding-agent/src/core/agent-session.ts` | `prompt` `:1116` |
| 工具怎么跑 | `packages/coding-agent/src/core/tools/` | `index.ts` 导出 |
| 压缩怎么触发 | `packages/coding-agent/src/core/compaction/` | `shouldCompact` |
| 扩展怎么挂 | `packages/coding-agent/src/core/extensions/types.ts` | `ExtensionAPI` `:1198` |
| DeepSeek 怎么接 | `packages/ai/src/providers/deepseek.ts` | `:10-11` |

### 3. 可以动手改的源码点（由易到难）

- **加一个内置工具**：在 `packages/coding-agent/src/core/tools/` 仿写，再在 `sdk.ts` 的默认工具列表（`:245`）里启用。
- **改默认系统提示**：定位 `buildSystemPrompt`（`agent-session.ts` 引用），调整 Guidelines。
- **调压缩策略**：改 `DEFAULT_COMPACTION_SETTINGS`（`index.ts:37` 导出）的阈值。
- **接新 provider**：仿 `deepseek.ts` 写一个 `createProvider`，或写扩展用 `registerProvider`（第 45 章）。
- **自定义流式格式**：改 `streamSimple` 相关适配（参考 `custom-provider-anthropic`）。

> **提示**
>
> 改 Pi 源码前，先在 `labs/mini-agent.mjs` 那种极简环境验证逻辑，再动真包。真包改动务必重新 build（第 47 章排错第一象限）。新手最容易踩的坑是"改了没 build"，以为是逻辑错。

## 社区与贡献路径

- **本地先跑通**：按第 14 章 `run-pi` 在本地把 Pi 跑起来，这是一切贡献的前提。
- **从扩展起步贡献**：比起改核心，先写扩展验证想法（第 45 章），扩展风险低、可独立发布。
- **提 issue / PR**：遇到 bug 先按第 47 章自查；确认是 Pi 的问题再带上最小复现去仓库提 issue。
- **读 tests 学约定**：仓库测试是最好的"用法范例"，比文档更贴源码当前状态。
- **保持版本意识**：RPC/CBOR 等跨进程通信对 Pi 两端版本敏感，协作时对齐版本。

## 你的学习路线图（回顾）

```
基础层   第1-12章   AI 是什么：Transformer / token / 提示 / 函数调用 / RAG / MCP / 流式 / 缓存
   │
架构层   第13-24章  Pi 怎么搭：分层 / 启动链 / provider / adapter / 消息转换 / 事件流 / 鉴权
   │
核心层   第25-32章  agent-loop / Agent 类 / 工具管线 / 内置工具 / 压缩 / 会话树
   │
落地层   第43-46章  三个项目 → SDK 调用 → 写扩展 → DeepSeek 桌面端 Agent
   │
保障层   第47-48章  排错调优 + 术语总表（你在这里）
```

> **说明**
>
> 恭喜你走完 48 章。从"AI 是什么"到"自己做一个 DeepSeek 桌面端 Agent"，这条路的每一块拼图你都已经拿到。下一步不是再读，而是**动手做**——把第 46 章的骨架真正跑起来，然后改成你自己的产品。

## 术语权重：先记哪些

术语分三档，按"不认识就寸步难行"的程度排序：

| 档位 | 术语 | 不认识的后果 |
|------|------|--------------|
| 必背（12 个） | Agent / LLM / token / context window / function calling / ReAct / agent-loop / streaming / RAG / MCP / provider / extension | 读不懂任何一章 |
| 应知（Pi 特有） | compaction / session tree / skill / customTools / createAgentSession / ExtensionAPI / thinkingLevel / ToolDefinition | 做不了落地项目 |
| 了解（运维） | CBOR / RPC / telemetry / jiti / ModelRuntime / SessionManager / ResourceLoader | 排错时卡壳 |

> **说明**
>
> "必背"档错了任一个，前面 42 章等于白读；"应知"档错了，第 43-46 章动手会卡；"了解"档错了，第 47 章排错会慢，但不阻塞主线。按档分配精力。

## 速记口诀（背下来）

- **一个循环**：思考→行动→观察（ReAct / agent-loop）
- **两个窗口**：上下文窗口（看多少）、token（计费单位）
- **三类扩展能力**：工具、命令、provider
- **四个内置工具**：read / bash / edit / write（`sdk.ts:245`）
- **五层落地**：基础→架构→核心→落地→保障（第 1-48 章）
- **六字心法**：Pi 是引擎，壳自己写（第 46 章）

## 给不同背景读者的路线建议

- **纯前端 / Vue 背景**：重点啃第 46 章（Electron 壳）+ 第 44 章（SDK 调用），原理章节可速读。
- **后端 / Node 背景**：第 44 章 SDK + 第 45 章扩展最对口，桌面壳按需。
- **算法 / ML 背景**：第 1-12 章是主场，重点补第 25-32 章的工程化（循环、工具、压缩）。
- **零基础**：严格按 1→48 顺序，别跳，每章末尾"自查清单"全勾完再进下一章。

## 一句话收尾

你已从"AI 是什么"走到"自己造一个 DeepSeek 桌面端 Agent"。知识不是用来收藏的——把第 46 章的骨架 `npm run dev` 跑起来，才是这 48 章真正的句号。

## 没搞懂？回看章节索引

按"你想搞清楚的事"快速定位：

| 我想搞清楚 | 回看章节 |
|------------|----------|
| AI 到底怎么工作的 | 第 1-5 章（历史/Transformer/预训练/推理模型/token） |
| 怎么让模型调我的函数 | 第 7 章（function calling）+ 第 28 章（工具管线） |
| agent-loop 为什么是循环 | 第 8 章（范式）+ 第 25 章（loop 本体） |
| 上下文满了怎么办 | 第 5 章（context）+ 第 30 章（compaction） |
| 怎么在代码里开车 | 第 44 章（SDK）+ 第 14 章（run-pi） |
| 怎么加自己的工具 | 第 45 章（扩展）+ `examples/extensions/` |
| 怎么做桌面应用 | 第 46 章（Electron+Vue） |
| 跑不通了查什么 | 第 47 章（排错） |

## 中英对照速查

| 中文 | 英文 | 中文 | 英文 |
|------|------|------|------|
| 智能体 | Agent | 工具 | Tool |
| 大语言模型 | LLM | 函数调用 | Function Calling |
| 词元 | Token | 推理范式 | ReAct |
| 上下文窗口 | Context Window | 流式 | Streaming |
| 检索增强 | RAG | 模型上下文协议 | MCP |
| 提示缓存 | Prompt Cache | 适配器 | Adapter |
| 供应商 | Provider | 扩展 | Extension |
| 压缩 | Compaction | 会话树 | Session Tree |
| 技能 | Skill | 中止 | Abort |
| 引擎封装层 | Runtime | 事件总线 | Event Bus |

> **说明**
>
> 这份中英对照专治"读英文文档时每个词都眼熟、连起来不懂"。先把左列中文词和本章定义对上号，再回头看 Pi 源码里的英文标识符（如 `createAgentSession`、`registerTool`），就会顺很多。

## 自查清单

- [ ] 我能不看文档说出 Agent / LLM / token / context window / function calling 的含义
- [ ] 我理解 ReAct 与 agent-loop 的关系，知道 Pi 在哪行起循环（`sdk.ts:294`）
- [ ] 我分得清 provider / adapter / extension 三者职责
- [ ] 我知道 compaction、session tree、skill、customTools 是 Pi 特有概念
- [ ] 我清楚 DeepSeek 接入点在 `deepseek.ts:10-11`
- [ ] 我知道进阶阅读优先看各包 README 与 `docs/extensions.md`
- [ ] 我列得出"想深入可改"的 3 个以上源码点
- [ ] 我明白贡献从"跑通本地 + 写扩展"起步，而非直接改核心
- [ ] 我已决定动手把第 46 章桌面 Agent 骨架真正跑起来
