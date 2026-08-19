---
title: "第 10 章 · 协议与生态：MCP、Tool Use、多智能体（Pi 为何不支持 MCP）"
date: 2026-07-01
summary: "聊生态前，先把三个概念钉死，免得后面打架："
tags:
  - pi
---
# 第 10 章 · 协议与生态：MCP、Tool Use、多智能体（Pi 为何不支持 MCP）

## 10.1 先厘清三个常被混用的词

聊生态前，先把三个概念钉死，免得后面打架：

- **Tool Use（工具调用）**：第 7 章讲的，模型输出 `tool_call`、宿主执行的机制。是一种**能力**，不是协议。
- **MCP（Model Context Protocol，模型上下文协议）**：Anthropic 2024 年提出的**开放标准**，规定"Agent 和外部工具/数据源之间怎么通信"。是一种**协议**。
- **Multi-Agent（多智能体）**：让多个智能体分工协作完成任务的**架构模式**。

一句话：`Tool Use` 是"能不能调"，`MCP` 是"按什么规矩调"，`Multi-Agent` 是"几个 agent 一起调"。

> **提示 · 协议解决什么问题**
>
> 没有协议时，每个工具都得给每个 Agent 单独写适配代码——N 个工具 × M 个 Agent = N×M 份对接。协议把"工具怎么暴露能力"标准化，工具写一次，所有遵守协议的 Agent 都能用，对接降到 N+M。这就是"USB-C 思维"：接口统一，谁插谁用。

## 10.2 MCP 是什么，解决什么

**MCP（Model Context Protocol）** 由 Anthropic 提出，目标是给 AI 应用一个统一方式去连外部能力——文件、数据库、浏览器、日历、SaaS……它定义了三类原语：

- **Tools**：Agent 可以调用的动作（类似函数调用）。
- **Resources**：Agent 可以读取的数据（类似文件/文档）。
- **Prompts**：预置的提示模板。

一个 MCP Server 是一个独立进程，Agent（MCP Client）通过标准传输（stdio / SSE 等）和它通信。生态里已出现大量现成 MCP server，这是它最大的卖点：**即插即用**。

```text
传统（无协议）：
  Agent ──专属代码──▶ 工具A
  Agent ──专属代码──▶ 工具B
  （每加一个工具都要写一遍对接）

MCP：
  Agent(MCP Client) ──标准协议──▶ MCP Server A（工具/资源/提示）
                                 ──标准协议──▶ MCP Server B
  （工具按协议暴露，Agent 一次对接通吃）
```

## 10.3 Tool Use 与 MCP 的区别

这俩不在同一层，别比错维度：

| 维度 | Tool Use | MCP |
|------|----------|-----|
| 性质 | 模型能力（机制） | 通信标准（协议） |
| 关心 | 模型如何产出调用、宿主如何执行 | Agent 与工具间传输格式/生命周期 |
| 依赖 | 任何支持 function calling 的模型都有 | 需 Agent 和工具都实现该协议 |
| 类比 | "会说外语" | "约定用英语这种外语" |

可以这样串：**MCP 是管道，Tool Use 是流经管道的内容**。Pi 这样的 Agent 内核自带 Tool Use（第 7 章的 `ToolCall`/`ToolResultMessage`）；它只是没内置 MCP 这条"管道"。

## 10.4 多智能体（Multi-Agent）协作

复杂任务让一个 agent 从头扛到尾，容易上下文爆掉、职责混乱。多智能体把它拆给"专业分工"的几个 agent：

- **主管（Orchestrator）**：拆任务、派活、汇总。
- ** worker（执行者）**：各管一摊（如一个专读代码、一个专写测试）。

```text
        用户
          │
          ▼
     主管 Agent
       ├──▶ 代码阅读 Agent ──结果──┐
       ├──▶ 修复 Agent ───────────┤
       └──▶ 测试 Agent ───────────┘
          │                        │
          ▼                        ▼
       汇总成最终答案
```

好处是各 agent 上下文短、职责清；坏处是协调开销大、传递信息易失真。是否上多智能体，看任务复杂度。

## 10.5 Pi 为什么刻意不支持 MCP

这是本章重点，也是 Pi 的设计哲学缩影。先说**可核实的事实**：

- Pi 根版本 `0.0.3`（见 `package.json` 的 `"version"`）。
- Pi 的 README 强调**极简内核 + 扩展点**：`README.md:40` 写明"Pi does not include a built-in permission system..."，并以启动者权限运行；`README.md:44` 举例用 **"Gondolin extension"** 把内置工具和命令路由进沙箱——可见其思路是"内核少，能力靠扩展补"，而非"把行业标准全焊进核心"。
- 通读 `README.md` 与 `AGENTS.md`，**没有任何内置 MCP 客户端/Server 的实现**。Pi 的统一工具机制走的是自家的 `Tool` / `ToolCall`（`packages/ai/src/types.ts:502`、`:360`），工具在 `Context.tools` 里声明，不依赖外部 MCP 进程。

> **说明 · Pi 的取舍逻辑（基于源码与 README 推断）**
>
> 1. **多数"接外部能力"的需求，一个 CLI 工具 + 一份说明（Skill）就覆盖了**——比起运行一个 MCP Server 进程更轻。Pi 的工具就是普通函数，`description` 写清即被模型选用（第 7.3 节）。
> 2. **真要接 MCP，自己写 Extension 接**，不绑架所有用户为它付出体积与复杂度。README 的"extension"措辞（如 Gondolin extension）正是这条路线。
> 3. **保持内核极简**：不内置权限系统、不内置 MCP，边界交给部署层（容器/沙箱）。
> 
> 换言之，Pi 把"是否引入 MCP 这一重量级协议"的选择权**留给使用者和扩展作者**，而不是默认塞进核心。

> **注意 · 这不是"MCP 不好"**
>
> Pi 不支持 MCP 是工程取舍，不是价值判断。如果你做垂直场景（如只改自家代码库），Skill + 自定义工具更轻；如果你要接一大堆现成 SaaS 连接器，MCP 的生态即插即用就很香。选哪种，看你的用户群和场景。

## 10.6 生态对比表

把本章涉及的几种"接外部能力"方式放一起比：

| 方式 | 是什么 | 接入成本 | 生态复用 | Pi 的态度 |
|------|--------|----------|----------|-----------|
| Tool Use（原生） | 模型函数调用机制 | 低（写个函数） | 无（各 Agent 自写） | **核心支持**（ToolCall/ToolResultMessage） |
| Skill（说明包） | 一份文档教模型做事 | 低（写 Markdown） | 中（可分享） | 推荐主路线之一 |
| Extension（扩展） | 代码给程序加能力 | 中（写代码） | 中 | 推荐，用来接 MCP 等 |
| MCP（协议） | 统一工具通信标准 | 中（实现 Client/Server） | 高（海量现成 server） | 不内置，需自写扩展接 |

## 10.7 MCP 的传输与生命周期（细节）

理解 MCP 为什么"重"，看它的运行方式就明白：MCP Server 通常是**一个独立进程**，和 Agent 之间通过传输层通信。官方支持两种传输：

- **stdio（标准输入输出）**：Agent 用子进程方式拉起 Server，靠 stdin/stdout 收发 JSON-RPC 消息。好处是本地安全、无需开端口；坏处是每个 Server 占一个进程。
- **SSE / HTTP**：Server 跑成网络服务，Agent 通过 HTTP + SSE 连接，适合远程共享的 Server。

```text
Agent (MCP Client)
   │  JSON-RPC over stdio 或 HTTP/SSE
   ▼
MCP Server（独立进程）
   ├── Tools：暴露可调用的动作
   ├── Resources：暴露可读取的数据
   └── Prompts：暴露提示模板
```

一次典型交互：Agent 先 `list_tools` 问"你有哪些工具"，Server 回清单；Agent 决定调用后发 `call_tool`，Server 执行并返回结果。整套**握手、发现、调用、返回**都要按协议规约实现——这就是为什么"内置 MCP"会给 Agent 核心增加可观的复杂度与攻击面。

## 10.8 MCP 的代价与风险（别只看好处）

- **进程与运维开销**：N 个 MCP Server = N 个常驻进程/服务，要管启动、崩溃、版本。
- **安全边界**：Server 能做的事由它自己定义，恶意或出错的 Server 可能读敏感文件、发网络请求。Pi 的 README（`README.md:40`）反复强调"以启动者权限运行、无内置权限系统"，可见它对"默认放权给外部进程"是谨慎的。
- **抽象泄漏**：协议再标准，各家 Server 质量参差，模型拿到的工具描述好坏不一，效果取决于 Server 作者。

> **注意 · "能接"不等于"该接"**
>
> MCP 生态即插即用很诱人，但每多一个外部 Server，就多一份依赖与风险面。Pi 选择不默认背这个包袱，把"要不要接、接哪个"变成使用者的显式决策——这和第 8.5 节"人在回路/把关落部署层"是同一个工程价值观。

## 10.9 Pi 的 Skill 与 Extension 路线（细说）

既然不内置 MCP，Pi 用什么补"外接能力"？两条主角路线（在 README 的学习文档与项目结构里反复出现）：

- **Skill（技能包）**：一份 Markdown 文档（常叫 `SKILL.md`），用自然语言教模型"遇到某类任务该怎么做"。它不是代码，是"知识 + 步骤说明书"。模型读到它就知道该调哪些已有工具、按什么顺序。最轻，零进程。
- **Extension（扩展）**：用代码给 Pi 加新能力（新工具、新传输、甚至自己实现一个 MCP Client）。README 的 "Gondolin extension"（`README.md:44`）就是个例子——它把内置工具和命令路由进沙箱微 VM。

```text
需求：让 Pi 连某个数据库
  方案 A（Skill）：写一份"怎么用 sqlite CLI 查库"的 SKILL.md → 模型用现有 shell 工具执行
  方案 B（Extension）：写代码包一个 MCP Client 真接 MCP Server → 能力最强但最重
  Pi 的立场：默认 A 够用就 A，要 B 你自己写扩展，不强制所有人背 B
```

> **说明 · 一句话区分**
>
> Skill = "教模型做事的说明书"（零代码、可分享）；Extension = "给程序加能力的代码"（要写、要维护）。两者合起来覆盖了绝大多数 MCP 能覆盖的场景，且更轻、更可控。

## 10.10 生态地图：除了 MCP 还有哪些"接外部能力"的思路

MCP 不是唯一答案。把视野打开，行业里"让 agent 用上外部能力"的路线至少有这几条，理解它们能避免"言必称 MCP"：

- **原生 Tool Use（函数调用）**：第 7 章的机制，最轻，模型原生支持。
- **Skill（提示包）**：用文档教模型怎么用现有工具，零代码。
- **Extension（代码扩展）**：给 agent 运行时加新工具/新传输，要写代码。
- **MCP（标准协议）**：统一 Client/Server 通信，生态最大但最重。
- **Function Calling 网关 / API 层**：如把一堆内部 API 包成统一 tool 暴露，介于 Extension 与 MCP 之间。

```text
轻 ───────────────────────────────▶ 重
原生ToolUse  Skill  Extension  函数网关    MCP
(零依赖)   (零代码) (写代码)  (封装API)  (独立进程+协议)
```

Pi 站在"轻"这一侧：核心只做原生 Tool Use，重活交给 Skill/Extension。这不代表轻一定对，只代表 Pi 的目标用户更偏向"垂直、可控、少依赖"的场景。

## 10.11 一个最小 MCP-vs-Skill 决策表

当你纠结"这能力用 MCP 还是用 Skill/Extension 做"时，问自己三问：

| 问题 | 选 Skill/Extension | 选 MCP |
|------|--------------------|--------|
| 这个能力是否通用到很多人都要用现成 Server？ | 否（自家场景） | 是（海量现成 SaaS 连接器） |
| 是否介意多一个常驻进程/依赖？ | 介意（要轻） | 不介意（已接纳生态） |
| 是否需要跨多个不同 Agent 复用同一套对接？ | 否（只给 Pi 用） | 是（多 Agent 共享） |

三问里多数答"否"，就走 Skill/Extension；多数答"是"，再考虑 MCP。Pi 把"回答这些问题"的责任交给你，而不是替你默认引入 MCP——这是它极简内核哲学的延伸。

> **说明 · 回到 Pi 的真实代码**
>
> Pi 的工具机制是自有的 `Tool` / `ToolCall`（`types.ts:502`、`:360`），在 `Context.tools` 声明；README 用 "Gondolin extension" 举例说明"扩展点"怎么接。全仓库**无 MCP Client 实现**。所以"Pi 不支持 MCP"不是口号，是代码结构事实——它把接 MCP 的可能性留给 Extension 作者，而非内核。

## 10.12 对"自己造 Agent"的启示

从 Pi 的取舍能提炼出几条可迁移经验：

1. **先问"真的需要协议吗"**：很多需求一个工具函数就解决，别一上来引重依赖。
2. **内核与扩展解耦**：把"思考循环"（agent-loop）和"接外部能力的管道"分开，换协议/换模型不伤筋骨（呼应第 8.7 节）。
3. **把关放在部署层**：权限、沙箱这类"安全边界"放到运行环境，而非塞进模型循环（呼应第 8.5 节 Pi 的沙箱策略）。
4. **工具声明要轻**：用 JSON Schema + 好 `description` 就够了，模型的 Tool Use 比想象中够用。

> **提示 · 一句话记住本章**
>
> MCP 是"统一管道"，Tool Use 是"流经的内容"，Multi-Agent 是"多个工人"；Pi 选择把管道交给扩展、把内核留给 Tool Use——极简，但把选择权留给你。

## 10.13 协议与生态一句话收尾

用一张"轻重光谱"收束全章：

```text
轻 ──────────────────────────────── 重
原生Tool  Skill  Extension  函数网关   MCP
（Pi 核心）（推荐）（接 MCP 用）（封装）（生态最大）
```

Pi 把重心压在"轻"侧：核心只做原生 Tool Use，能力用 Skill/Extension 补，MCP 这种重协议交给需要的人自己接。这不是"MCP 不好"，而是"把选择权留给你"的工程态度。理解这一点，你就读懂了 Pi 在协议与生态上的全部立场。

## 10.14 如果真要给 Pi 接 MCP（扩展作者视角）

Pi 不内置 MCP，但"真要接"是被允许的——走 Extension 路线自己实现 MCP Client。最小轮廓：

```text
① 写扩展：在 packages/agent 或你的宿主里，实现一个 MCP Client
          （按 MCP 规范连 stdio/HTTP 的 Server，做 list_tools / call_tool）
② 转译：把 MCP Server 的 Tools/Resources 映射成 Pi 的 Tool / ToolResultMessage
          （types.ts:502 / :437）——让 Pi 循环"以为"在用原生工具
③ 注册：把这些转译后的 Tool 塞进 Context.tools（types.ts:512）
④ 跑循环：Pi 的 agent-loop 照常跑，模型像调原生工具一样调 MCP 工具
```

要点：MCP 的复杂度被**封在扩展里**，Pi 内核始终只见 `ToolCall`/`ToolResultMessage`。这正是"内核极简、重逻辑外置"的范例——也解释了为什么 README 敢说"不内置 MCP"却不挡你用 MCP。

> **说明 · 读到这里你应该建立的认知**
>
> Pi 的每一个"不做"（不内置 MCP、不内置权限系统、不内置子智能体），背后都是同一个设计判断：**把通用发动机留在核心，把场景化、可能很重的能力外推给扩展/部署层**。学 Pi 源码，学的不是"它做了什么功能"，而是"它如何决定什么不做"——这比功能列表更值钱。

## 10.15 名词速查表（防混淆）

收尾前把本章最容易混的词再钉一遍：

| 词 | 一句话定义 | 是能力/协议/架构？ |
|----|------------|-------------------|
| Tool Use | 模型输出 tool_call、宿主执行 | 能力（机制） |
| Function Calling | Tool Use 的同义说法（OpenAI 叫法） | 能力（机制） |
| MCP | Agent 与外部工具/数据源的通信标准 | 协议 |
| Skill | 教模型做事的 Markdown 说明书 | 轻量扩展（零代码） |
| Extension | 给 agent 加能力的代码 | 扩展（要写代码） |
| Multi-Agent | 多个 agent 分工协作 | 架构模式 |

> **提示 · 考试式自检**
>
> 随便说一个词，你能立刻答出"它是能力、协议、还是架构？它解决谁的对接问题？"——答得上，本章就过关了。

## 自查清单

- [ ] 我能区分 Tool Use、MCP、Multi-Agent 分别在哪一层（能力/协议/架构）。
- [ ] 我能说清"协议"解决的是 N×M 对接爆炸问题。
- [ ] 我能列出 MCP 的三类原语（Tools/Resources/Prompts）。
- [ ] 我知道 Pi 在 README 里体现的"极简内核 + 扩展点"思路（如 Gondolin extension）。
- [ ] 我能说出 Pi 不支持 MCP 的两条主要理由（CLI+Skill 够轻 / 真要接自己写扩展）。
- [ ] 我能画出"原生工具 / Skill / Extension / MCP"四者的生态对比表要点。
- [ ] 我能复述"自己造 Agent"的 4 条启示中的至少 2 条。
