---
title: "第 13 章 · Pi 是什么：架构总览与依赖方向"
date: 2026-07-01
summary: "monorepo 这个词来自 \"monolithic repository\"：多个相互独立发布、但放在同一个 Git 仓库里管理的包。好处是互相引用源码时不用先发到 npm，本地直接 `import` 即可。"
tags:
  - pi
---
# 第 13 章 · Pi 是什么：架构总览与依赖方向

读完本章你会明白：Pi 不是一个"一个大文件写到底"的程序，而是一组**分工明确的包（package）**拼起来的。先建立直觉，再去看源码里的依赖关系，你会发现一个刻意设计出来的"叶子—根"结构。

## 一句话直觉：Pi 是干什么的

Pi 是一个**编码智能体（coding agent）**。你打开终端敲下 `pi`，它就变成你身边的"程序员同事"：读文件、改文件、跑命令、把结果喂给大模型（LLM，Large Language Model，大语言模型），再由大模型决定下一步做什么。

它的代码库是一个 **monorepo（单仓库多包）**：一个大仓库 `/Users/lijunkai/Project/pi` 里装了 11 个小包，每个小包只做一件事。这种"把大系统拆成小积木"的写法，正是为了让你能一块一块地读懂它。

> monorepo 这个词来自 "monolithic repository"：多个相互独立发布、但放在同一个 Git 仓库里管理的包。好处是互相引用源码时不用先发到 npm，本地直接 `import` 即可。

## Pi 为什么被拆成这么多包

想象你要造一台电脑。你不会把 CPU、内存、硬盘焊死在一个铁疙瘩里，而是做成独立部件：CPU 只管算、内存只管临时存、硬盘只管持久存。Pi 也这么做：

- **ai 包** = "会说话的大模型接口"（CPU）
- **agent 包** = "会调用工具、管理状态的智能体内核"（主板+调度）
- **coding-agent 包** = "面向程序员的成品 CLI"（整机外壳）
- **tui 包** = "终端界面"（显示器）
- **telemetry 包** = "运行指标记录"（体检仪）

这样做最大的好处是：**改界面不用碰大模型逻辑，改大模型逻辑不用碰界面**。每一块都能单独测试、单独读懂。

## 11 个包各自的职责

下面这张表来自各包的 `package.json` 里的 `name` 与 `description` 字段，是该文档的"事实来源"。

| 包目录 | npm 包名 | 一句话职责 |
|--------|----------|------------|
| `packages/ai` | `@earendil-works/pi-ai` | 统一的多厂商大模型接口（OpenAI / Anthropic / Google 等），自动发现模型、管理密钥 |
| `packages/agent` | `@earendil-works/pi-agent-core` | 通用智能体内核：工具调用（tool calling）、会话状态管理、附件（attachment）支持 |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | 交互式编码智能体 CLI，提供 read / bash / edit / write 工具与会话管理 |
| `packages/tui` | `@earendil-works/pi-tui` | 终端 UI 库，带"差异渲染（differential rendering）"，高效刷新文字界面 |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | 厂商中立的可观测性契约（contract）、类型化 schema 与一致性测试 |
| `packages/protocol` | `@earendil-works/pi-protocol` | 传输中立的 CBOR 二进制协议，用于远端 `pi` 会话 |
| `packages/client` | `@earendil-works/pi-client` | 基于分帧 CBOR 字节流的远端会话客户端 |
| `packages/server` | `@earendil-works/pi-server` | 实验性的服务端包，让 `pi` 以服务模式运行 |
| `packages/session-backends` | `@earendil-works/pi-session-backend-sqlite-node` | 用 Node 自带 SQLite 持久化 agent 会话（当前正式方案） |
| `packages/evals` | `@earendil-works/pi-evals` | 评测套件（private，仅开发/测试用），跑真实任务衡量 Pi 表现 |
| `packages/storage` | （legacy） | 旧的会话存储实现，已被 `session-backends` 取代，仓库里只剩 `dist/` 残留 |

> **说明 · 为什么有两个"存储"包？**
>
> 你会在 `packages/` 下同时看到 `storage` 和 `session-backends`。`storage` 是早期遗留目录，里面已经没有 `package.json`，只剩构建残留；**正式的会话后端是 `session-backends/sqlite-node`**。把旧的留着而不删，是为了兼容老会话文件，等你读源码时认准 `session-backends` 即可。

## 依赖方向：为什么是单向的

"依赖"在这里的意思是：`A 包` 的源码里写了 `import ... from "@earendil-works/pi-xxx"`（或反过来被依赖）。我们逐一核对了 11 个包的 `package.json` 里的 `dependencies`，得到下面这张**内部依赖边**（只列 Pi 自己的包，外部库如 `typebox` 不画）：

- `agent` 依赖 `ai` 和 `telemetry`
- `session-backends/sqlite-node` 依赖 `ai` 和 `agent`
- `client` 依赖 `protocol`
- `server` 依赖 `ai` 和 `protocol`
- `coding-agent` 依赖 `agent`、`ai`、`client`、`protocol`、`tui`
- `evals` 依赖 `ai` 和 `coding-agent`（仅 devDependencies）
- `ai`、`telemetry`、`tui`、`protocol` **不依赖任何 Pi 内部包**

把这些边连起来，就是一张**有向无环图（DAG，Directed Acyclic Graph）**——没有循环，没有"A 依赖 B、B 又依赖 A"的死结。

```
第 0 层（叶子，零内部依赖）:   ai      telemetry      tui      protocol
                                    │         │                    │
第 1 层:                     agent ─┘         │           client ──┘
                                    │         │              │
                          session-backends ───┘           server
                                    │
第 2 层:                     coding-agent ──► agent ──► ai
            coding-agent 还直接依赖: tui  client  protocol  ai
                                    │
第 3 层（仅评测）:           evals ──► coding-agent, ai
```

用更直白的箭头图表示 `coding-agent` 这一条"主链路"：

```
coding-agent
   │
   ├─► agent ──► ai
   │        └──► telemetry
   ├─► ai
   ├─► client ──► protocol
   ├─► protocol
   └─► tui
```

> **提示 · 关键判断：ai 为什么是"叶子"**
>
> `ai` 包是整张图里最底层的叶子——没有任何 Pi 内部包依赖它之外的 Pi 包。它被 `agent`、`coding-agent`、`server`、`session-backends`、`evals` 共同依赖，但它自己**只依赖外部厂商 SDK 和少量工具库**（如 `typebox`）。
> 
> 为什么这样设计？因为"怎么跟大模型说话"是所有上层都要用的公共能力。把它压到最底层，意味着无论你改界面、改会话存储、还是改智能体内核，**大模型接口这一层都稳定不动**，上层可以放心地 `import` 它。这就是单向依赖带来的"稳定地基"。

## 为什么依赖必须单向、不能成环

如果允许 `ai` 反过来依赖 `coding-agent`，会出两个大问题：

1. **构建死锁**：构建顺序无法排定（见下一节），编译器不知道先编译谁。
2. **改动爆炸**：改 `coding-agent` 里一个细节，可能牵连 `ai`，进而牵连所有依赖 `ai` 的包。

所以 Pi 强制了一条规则：**依赖只能从"上层业务包"指向"下层基础包"，绝不允许回头**。你在 `package.json` 里核对时也会发现：`ai` 的 `dependencies` 里完全没有 `@earendil-works/*` 开头的东西。

## 构建顺序图（从源码编译的先后）

源码是 TypeScript，需要先编译成 JS 才能跑。因为依赖是单向的，构建也**必须按依赖顺序**进行：先编译被依赖的叶子，再编译依赖它的上层。根 `package.json` 的 `build` 脚本（`package.json:16`）就写死了这个顺序：

```
tui
  → telemetry
    → ai
      → agent
        → session-backends/sqlite-node
          → protocol
            → client
              → server
                → coding-agent   （最后编译，因为它是依赖最多的"整机"）
```

对应根 `package.json:16` 的真实命令（已按 `cd` 顺序整理）：

```bash
cd packages/tui && npm run build \
&& cd ../telemetry && npm run build \
&& cd ../ai && npm run build \
&& cd ../agent && npm run build \
&& cd ../session-backends/sqlite-node && npm run build \
&& cd ../../protocol && npm run build \
&& cd ../client && npm run build \
&& cd ../server && npm run build \
&& cd ../coding-agent && npm run build
```

注意 `evals` 和 `storage` **不在构建链里**：`evals` 是测试/评测专用、不需要随 CLI 发布；`storage` 是已被取代的遗留目录。

> **注意 · 别乱改构建顺序**
>
> 如果你手动画依赖图时发现某包需要反向依赖（比如让 `ai` 用 `coding-agent` 的功能），第一反应应该是"我是不是把层次放反了"，而不是去调构建脚本。单向依赖是 Pi 的设计红线，破了它后续维护和发布都会踩坑。

## 设计哲学：极简内核 + 扩展点

读完上面你会发现 Pi 的核心思路可以浓缩成八个字：**极简内核，留出扩展点**。

- **极简内核**：`ai` 只管"和大模型对话"，`agent` 只管"跑工具、管状态"。它们都不关心你是程序员还是客服、界面是终端还是网页。内核越小，越容易读、越不容易出 bug。
- **扩展点**：真正"像程序员一样工作"的能力（read/bash/edit/write 工具、主题、技能、扩展包）都在 `coding-agent` 和扩展机制里。想加新工具？写一个扩展挂上去，不用改内核。`main.ts` 里就有一行 `const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])]`（`packages/coding-agent/src/main.ts:571`），把"内置扩展"和"外部扩展"拼在一起——这就是扩展点的入口。

用一个比喻收尾：内核像手机的**操作系统**，只提供"能跑应用、能联网"的基础能力；扩展像**App Store 里的应用**，想加什么功能装什么，不爽还能卸载，且永远不会把操作系统搞崩。Pi 把这种"内核稳、外围活"的边界划得很清楚，所以它能从"一个对话 CLI"长成"可扩展的编码智能体平台"，而代码依然可读。

```
            ┌─────────────────────────────────────┐
 内核层     │  ai  ·  agent  ·  telemetry  ·  tui  │  ← 小、稳、不依赖业务
            └───────────────┬─────────────────────┘
 扩展层                   coding-agent  +  各类 extensions
            （在扩展点挂上 read/bash/edit/write、主题、技能…）
```

这种结构的好处，等你读到第 14、15 章"怎么跑起来、怎么启动"时会更清楚：因为内核干净，启动链路才能被清晰地拆成"解析参数 → 选会话 → 建 runtime → 进模式"几步。

## 三个代表包内部长什么样（带源码索引）

光看职责表可能还是抽象。我们挑三个包，看一眼它们各自的"零件"摆在哪，你就知道分层不是空话。

### ai：统一的大模型接口

`packages/ai/src/` 下的关键文件：

- `providers/` 目录：各家厂商（OpenAI / Anthropic / Google / …）的具体对接实现，每个厂商一个文件。
- `models.ts` 与 `models-store.ts`：模型清单与运行时存储，`model-catalog.ts` 负责从厂商目录自动发现可用模型。
- `types.ts`：统一的请求/响应类型，上层不用关心背后是哪家厂商。
- `auth/` 与 `oauth.ts`：密钥与 OAuth 登录管理。

正因为 `ai` 把"厂商差异"全收在自己肚子里，上层的 `agent`、`coding-agent` 只需要写"发一条消息、收一个流式回复"，**完全不用 if/else 判断厂商**。这就是叶子包的价值。

### agent：通用智能体内核

`packages/agent/src/` 下的关键文件：

- `agent.ts`：智能体主体，负责"把消息交给模型、拿到模型想要调用的工具、执行工具、再把结果喂回模型"的循环。
- `agent-loop.ts`：上述循环的调度逻辑（常被称为 agentic loop，智能体循环）。
- `types.ts`：工具（tool）、消息（message）、状态（state）的定义。

注意 `agent` 不绑定"写代码"这件事——它只懂"模型 + 工具 + 状态"。正因如此，同一个内核既能驱动 coding-agent，也能驱动未来的客服 agent。

### coding-agent：把内核变成程序员

`packages/coding-agent/src/core/tools/` 下就是真正"像程序员一样干活"的工具：

- `read.ts`：读文件
- `bash.ts`：跑 shell 命令
- `edit.ts` / `edit-diff.ts`：改文件（含差异预览）
- `write.ts`：写文件
- `grep.ts` / `ls.ts` / `find.ts`：搜索与列目录

这些工具在 coding-agent 层被注册进 `agent` 提供的智能体循环里。结合第 13 章开头的依赖图：**coding-agent 依赖 agent（拿到循环），agent 依赖 ai（拿到模型）**，于是"程序员工具 → 智能体循环 → 大模型"三层咬合，整机就转起来了。

## 一次问答的数据流经哪些包

用"你问 Pi 一句话"为例，数据自顶向下穿过这些包：

```
你敲回车
  │
  ▼ coding-agent（TUI 收集输入，交给 AgentSession）
  │     └─ 调 agent 的智能体循环
  ▼ agent（决定：先调 read 工具看文件）
  │     └─ 执行 coding-agent 的 read.ts
  ▼ coding-agent（read.ts 读盘，返回内容）
  ▼ agent（把"文件内容"作为工具结果，再次请求模型）
  ▼ ai（把统一请求翻译给具体厂商，流式收回模型回复）
  ▼ 厂商 HTTP 接口
  │
  ▲ 回复沿原路返回：ai → agent → coding-agent(TUI 渲染给你)
```

可以看到：数据**向下**穿过越来越多的下层包，**向上**返回结果。因为依赖单向，这条回路永远不会"绕回自己"。

## 想加能力？认准扩展点，别碰内核

第 13 章说 Pi 是"极简内核 + 扩展点"。具体到代码，加新工具/新厂商最安全的落点是扩展机制，而不是改 `ai` 或 `agent`：

- 加一个**自定义厂商**：写个扩展，在 `createAgentSessionServices`（`agent-session-services.ts:158-181`）里通过 `modelRuntime.registerProvider(...)` / `registerNativeProvider(...)` 挂上即可。
- 加一个**自定义工具/技能/主题**：放进扩展或 `skills` 目录，由 `resourceLoader`（`agent-session-services.ts:148`）加载。

> 验证这一点很简单：在 `agent-session-services.ts` 里搜 `registerProvider`，你会看到扩展的"待注册厂商"正是在服务装配阶段被批量登记进 `modelRuntime` 的。内核稳定，扩展在外围生长——这正是单向依赖 + 扩展点设计的实际收益。

## 推荐阅读顺序：从叶子读起

理解了依赖方向，读源码就有了"最优路径"。既然 `ai`/`telemetry`/`tui`/`protocol` 是叶子、不依赖别人，它们最容易读懂；越往上越"业务化"、越复杂。建议顺序：

1. **`ai`**：先看 `types.ts` 和 `providers/` 之一，搞懂"统一模型接口"长啥样。
2. **`agent`**：看 `agent.ts` 与 `agent-loop.ts`，搞懂"模型—工具—状态"循环。
3. **`coding-agent`**：看 `src/cli.ts` → `src/main.ts` → `src/core/tools/`，把前两层接到"程序员工具"上。
4. **`tui` / `protocol` / `client` / `server`**：按需看，理解界面与远端通信。
5. **`evals`**：最后看，它站在最顶层，用 coding-agent 跑真实任务做评测。

> 这条顺序和"构建顺序"方向相反：构建从下往上编（先叶子），阅读也建议从下往上读（先叶子）。二者都源于同一个事实——依赖是单向的。

## 自查清单

- [ ] 我能用一句话说清 Pi 是做什么的（coding agent）
- [ ] 我知道 monorepo 是指"一个仓库里多个可独立发布的包"
- [ ] 我能列出 11 个包里至少 5 个的职责
- [ ] 我理解 `ai` 是叶子包、被最多上层依赖，自己不依赖任何 Pi 内部包
- [ ] 我能解释为什么依赖必须单向、不能成环（死锁 + 改动爆炸）
- [ ] 我能背出构建顺序的前三步：tui → telemetry → ai
- [ ] 我理解"极简内核 + 扩展点"是什么意思，并知道扩展入口在 `main.ts:571`
- [ ] 我分清了 `storage`（遗留）与 `session-backends`（正式）的关系
