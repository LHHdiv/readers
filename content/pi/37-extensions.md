---
title: "第 37 章 · 扩展机制 extensions（API、runner、loader）"
date: 2026-07-01
summary: "约定：行号来自 `packages/coding-agent/src/core/extensions/` 下三个文件——`types.ts`、`runner.ts`、`loader.ts`。"
tags:
  - pi
---
# 第 37 章 · 扩展机制 extensions（API、runner、loader）

Pi 的“可定制性”几乎全部来自扩展（extensions）。一个扩展就是一个 TypeScript 模块，它能在 Pi 的生命周期里**订阅事件、注册工具、注册命令、注册快捷键、注册 CLI flag，甚至替换 UI**。本章讲清三块积木：`ExtensionAPI`（扩展能做什么的契约）、`ExtensionRunner`（事件如何分发）、`loader`（扩展如何被动态加载）。

> 约定：行号来自 `packages/coding-agent/src/core/extensions/` 下三个文件——`types.ts`、`runner.ts`、`loader.ts`。

## 37.1 设计哲学：最小内核 + 扩展点

Pi 的核心保持精简，把“可变化的能力”开放成**扩展点（extension points）**。源码头部注释（`types.ts:1`–`types.ts:9`）概述了扩展能做的五件事：

- 订阅 agent 生命周期事件
- 注册 LLM 可调用工具
- 注册命令、快捷键、CLI flag
- 通过 UI 原语与用户交互
- 注册/覆盖模型 provider

这种“内核小、扩展多”的结构意味着：你想加一个新功能（比如支持某个内部 API、加一个 `/deploy` 命令），**通常不必改 Pi 核心代码，只要写一个扩展**。

> **提示**
>
> 把 Pi 想成一个“插座板”：核心提供固定的插孔（扩展点），扩展是插上去的电器。插上什么、插多少，决定了这个 Pi 实例最终“会做什么”。这正是 Pi 能既保持核心稳定、又能被社区无限扩展的原因。

## 37.2 ExtensionAPI：扩展能做什么的契约

`ExtensionAPI` 接口定义在 `types.ts:1198`–`types.ts:1437`（具体实现见 `loader.ts` 的 `createExtensionAPI`），是传给扩展工厂函数的那个 `pi` 对象。它分几大组能力：

**（1）事件订阅**——`on(event, handler)` 的一组重载（`types.ts:1205`–`types.ts:1244`）。覆盖整个生命周期的 **33 种事件**，按类别大致有：

- 会话类：`session_start`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_shutdown`、`session_before_tree`、`session_tree` 等
- Agent 类：`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`
- 工具类：`tool_call`、`tool_result`、`tool_execution_start/update/end`
- 模型类：`model_select`、`thinking_level_select`
- 输入/输出类：`input`、`context`、`before_provider_request`、`before_provider_headers`、`after_provider_response`、`before_agent_start`、`user_bash`

```ts
// packages/coding-agent/src/core/extensions/types.ts:1205（节选）
on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;  // :1241
// ...共 33 种事件重载...
```

**（2）工具注册**——`registerTool(tool)`（`types.ts:1251`），让 LLM 能调用你定义的能力。

**（3）命令 / 快捷键 / flag**——`registerCommand`（`types.ts:1260`）、`registerShortcut`（`types.ts:1263`）、`registerFlag`（`types.ts:1272`）。

**（4）消息 / 入口渲染**——`registerMessageRenderer`（`types.ts:1289`）、`registerMarkdownTransformer`（`types.ts:1292`）、`registerEntryRenderer`（`types.ts:1295`）等，让扩展自定义某种消息类型如何渲染。

**（5）动作**——`sendMessage`、`sendUserMessage`（`types.ts:1312`）、`appendEntry`、`setModel`（`types.ts:1353`）、`setThinkingLevel`（`types.ts:1359`）、`registerProvider` / `unregisterProvider`（`types.ts:1417`）等。

> **提示**
>
> 扩展拿到的是 `pi` 这个对象。**它本质上是一个“能力清单”**：你能调的方法，就是 Pi 愿意开放给你的能力。看 `ExtensionAPI` 的接口，就等于看 Pi 把所有“可定制点”摊开给你看。

## 37.3 ExtensionRunner：事件如何分发

`ExtensionAPI` 是“契约”，真正干活的是 `ExtensionRunner`，类定义在 `runner.ts:268`–`runner.ts:1236`。

它最重要的能力是**事件分发**。`emit()` 方法（`runner.ts:801`–`runner.ts:833`）是所有事件的总出口：传入一个事件对象，它就把这个事件逐个交给所有订阅了该事件的扩展 handler。特别地，对于 `session_before_*` 这类事件，它还会检查 handler 返回的 `cancel` 字段，从而**允许扩展阻止某个操作**（如阻止切换会话）。

围绕 `emit`，runner 提供了一组语义化的包装方法，对应不同事件：

- `emitToolCall()`（`runner.ts:932`–`runner.ts:953`）：工具调用前通知扩展，可改写/拦截。
- `emitContext()`（`runner.ts:984`–`runner.ts:1014`）：每次 LLM 请求前，让扩展改消息。
- `emitBeforeAgentStart()`（`runner.ts:1081`–`runner.ts:1145`）：agent 跑之前，让扩展追加自定义消息或改写系统提示词。
- `emitInput()`（`runner.ts:1196`–`runner.ts:1235`）：用户输入到达时，让扩展拦截/改写。

`bindCore()`（`runner.ts:314`–`runner.ts:412`）是另一个关键点：它把扩展注册阶段“排队”的 action（如 provider 注册）真正刷到核心运行时上——因为加载扩展时核心还没就绪，所以先排队、绑定时再落地。

```text
   某个事件产生（如 message_end）
            │
            ▼
   ExtensionRunner.emit(event)        runner.ts:801
            │  逐个调用
            ▼
   ┌─── 扩展 A 的 handler ───┐
   ├─── 扩展 B 的 handler ───┤   每个 handler 都可：读事件 / 改内容 / 取消操作
   └─── 扩展 C 的 handler ───┘
            │
            ▼
   继续原流程（持久化 / 发给模型 / 渲染）
```

> **说明**
>
> `emitBeforeAgentStart` 是扩展“注入系统提示词”的主要通道：扩展可以在 agent 真正跑之前，往消息列表里加一段“系统级提示”，或改写已有的系统提示词。这也是为什么有些扩展能让 Pi 在每次回答前都遵守某条额外规则。

## 37.4 注册与分发：扩展如何注入命令和工具

扩展通过 `ExtensionAPI.registerCommand` / `registerTool` 把自己“登记”到 runner 内部的数据结构。当：

- 用户在交互模式输入 `/我的命令`，`AgentSession._tryExecuteExtensionCommand()`（`agent-session.ts:1278`）会向 runner 查询并执行该命令（`agent-session.ts:1284` 的 `getCommand`）。
- LLM 决定调用某个工具，runner 的 `emitToolCall`（`runner.ts:932`）先让扩展“过一道”，再真正执行。

```text
   扩展模块 (pi) => { pi.registerCommand("deploy", handler); pi.registerTool(myTool); }
            │
            ▼
   ExtensionRunner 内部登记表
   ├─ commands:  Map<name, handler>
   ├─ tools:     Map<name, definition>
   ├─ shortcuts: Map<key, handler>
   └─ flags:     Map<name, config>
            │
      ┌─────┴─────────────┐
      ▼                   ▼
  用户输入 /deploy       LLM 调用 tool
      │                   │
      ▼                   ▼
  runner.getCommand()   runner.emitToolCall()
      │                   │
      ▼                   ▼
  执行 handler          拦截/改写后执行
```

> **说明**
>
> “扩展注册的命令/工具”和“内置命令/工具”走的是**同一套调度**。这也是为什么扩展能做得和 Pi 原生功能一样自然——它们不是“外挂”，而是同一个机制上的不同来源。第 39 章你会看到内置斜杠命令也是类似结构。

## 37.5 loader：扩展如何被动态加载

扩展要能“即插即用”，得解决一个现实问题：**Pi 是编译/打包后的程序，扩展却可能是用户随手写的 TS 文件**。这就需要动态加载器，定义在 `loader.ts`。

关键部件：

- `VIRTUAL_MODULES`（`loader.ts:50`–`loader.ts:74`）：把 Pi 内部的各个包（如 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`）映射成虚拟模块，让扩展在 Bun 二进制模式下也能 `import` 它们。
- `createExtensionRuntime()`（`loader.ts:174`–`loader.ts:242`）：先创建一个“动作还是空壳（throwing stubs）”的运行时，等 runner 绑定后再补全。
- `createExtensionAPI()`（`loader.ts:249`–`loader.ts:426`）：构造出那个 `pi` 对象——注册类方法（如 `registerTool`）只是把东西写进扩展结构，动作类方法（如 `sendMessage`）则转交给 runtime。
- `loadExtensionModule()`（`loader.ts:436`–`loader.ts:464`）：用 `createJiti(...)` 来加载 TS 扩展模块（支持虚拟模块与别名），这是“能直接加载 .ts 扩展”的技术关键（`loader.ts:444` 起用 `createJiti` 并注入 `VIRTUAL_MODULES`）。
- `discoverAndLoadExtensions()`（`loader.ts:689`–`loader.ts:737`）：扫描**项目本地 + 全局 + 配置路径**三处，找到所有扩展入口并加载。

```ts
// packages/coding-agent/src/core/extensions/loader.ts:436（节选）
async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
    const jiti = createJiti(import.meta.url, {
        // ...virtualModules: VIRTUAL_MODULES, tryNative: false...
    });
    await jiti.import(extensionPath);
}
```

> **提示**
>
> 用 `jiti` 而不是直接 `import()`，是因为 jiti 能在运行时**即时编译并加载 TypeScript**，无需预先 `tsc` 编译。这让扩展作者“改完 .ts 文件，`/reload` 一下就能生效”，开发体验极其顺滑。

## 37.6 一个事件的生命周期（以 agent_end 为例）

把前面几块串起来，看一次事件是怎么流动的：

```text
AgentSession 跑完一轮 agent
      │
      ▼
runner.emit({ type: "agent_end", ... })        runner.ts:801
      │
      ▼
逐个调用订阅了 agent_end 的扩展 handler
（这些 handler 在加载扩展时就通过 pi.on("agent_end", ...) 登记了）
      │
      ▼
扩展做自己的事：写日志 / 发通知 / 改持久化
      │
      ▼
原流程继续（如渲染最终消息、更新状态栏）
```

注意 handler 在“加载期”登记、在“运行期”被调用——这正是 `ExtensionRunner` 把“注册”和“分发”解耦的价值：加载时只是登记，运行时才真正触发，互不阻塞。

## 37.7 扩展的完整生命周期

把三块拼起来，一个扩展从磁盘到生效的路径是：

```text
   磁盘上的扩展 .ts 文件
            │  discoverAndLoadExtensions()   loader.ts:689
            ▼
   loadExtensionModule() 用 jiti 加载   loader.ts:436
            │  执行扩展工厂函数 (pi) => { pi.on(...); pi.registerTool(...) }
            ▼
   createExtensionAPI() 构造 pi 对象      loader.ts:249
   注册信息写入 Extension 结构（commands/tools/...）
            │
            ▼
   runner.bindCore() 把排队的 action 刷到核心   runner.ts:314
            │
            ▼
   运行中：事件产生 → runner.emit() 分发给各 handler   runner.ts:801
```

## 37.8 小结

扩展机制 = **契约（ExtensionAPI）+ 调度器（ExtensionRunner）+ 加载器（loader）**。

- `ExtensionAPI` 用 33 种事件的 `on()` 和一组 `register* / send* / set*` 方法，把 Pi 的可定制点全部开放（`types.ts:1198`）。
- `ExtensionRunner` 负责把事件分发给所有订阅者，并允许扩展拦截、改写、甚至取消操作（`emit` 在 `runner.ts:801`）。
- `loader` 用 jiti + 虚拟模块，把用户写的 TS 扩展即时加载进已打包的 Pi（`loader.ts:50`、`:436`）。

> **说明**
>
> 想自己写一个扩展？最小模板就是：`export default (pi: ExtensionAPI) => { pi.on("agent_end", () => {...}); }`。把它放进 Pi 的扩展目录，重启或 `/reload`，你的逻辑就会在每次 agent 结束时触发。是不是比想象中简单？

## 37.9 动手写一个最小扩展

光看接口容易飘，直接上一个能跑的极简扩展，把“契约 + 注册 + 事件”三件事串起来：

```ts
// my-greeter-extension.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default (pi: ExtensionAPI) => {
  // (1) 订阅生命周期事件：agent 每次跑完，往 stderr 打一行日志
  pi.on("agent_end", () => {
    console.error("[greeter] agent finished a turn");
  });

  // (2) 注册一个斜杠命令 /hello
  pi.registerCommand("hello", {
    description: "让 Pi 向你问好",
    handler: async (ctx) => {
      // 通过命令上下文把一条消息塞回会话
      await ctx.session.sendUserMessage("你好，这是来自扩展的问候 👋");
    },
  });

  // (3) 注册一个 LLM 可调用的工具（伪代码，示意签名）
  // pi.registerTool({ name: "weather", ... });
};
```

把它放进 Pi 的扩展目录（用户级 `~/.pi/extensions` 或项目级 `.pi/extensions`），重启或 `/reload` 后：

- 每次 agent 结束，终端会多一行 `[greeter] agent finished a turn`（事件订阅生效）。
- 输入框敲 `/hello`，Pi 会立刻把“你好，这是来自扩展的问候”作为用户消息发出来（命令注册生效）。

> **提示**
>
> 这个例子恰好印证了本章反复说的三点：`ExtensionAPI` 是契约（你能调 `pi.on` / `pi.registerCommand`），`ExtensionRunner` 负责在 `agent_end` 时把事件分发到你的 handler，而 `loader` 用 jiti 把这份 `.ts` 即时加载进 Pi。三块积木，缺一不可。

## 37.10 ExtensionAPI 能力分组速查

把 `ExtensionAPI` 的方法按能力分组列在这里，方便回查（`types.ts:1198` 起）：

| 能力组 | 代表方法 | 行号 |
| --- | --- | --- |
| 事件订阅 | `on(event, handler)` | `types.ts:1205`（`tool_call` 在 `:1241`） |
| 工具注册 | `registerTool(tool)` | `types.ts:1251` |
| 命令/快捷键/flag | `registerCommand` / `registerShortcut` / `registerFlag` | `:1260` / `:1263` / `:1272` |
| 渲染定制 | `registerMessageRenderer` / `registerEntryRenderer` | `:1289` / `:1295` |
| 消息/动作 | `sendUserMessage` / `setModel` / `setThinkingLevel` | `:1312` / `:1353` / `:1359` |
| Provider | `registerProvider` / `unregisterProvider` | `:1417` / `:1433` |

记住：这张表里的每一个方法，背后都对应 `ExtensionRunner` 里的一段调度逻辑，和 `loader` 里的一段加载/绑定逻辑。扩展机制就是把“契约—调度—加载”三层缝在一起。

## 自查清单

- [ ] 我能否说出 Pi “最小内核 + 扩展点”的设计哲学？
- [ ] 我能否指出 `ExtensionAPI` 的定义位置（`types.ts:1198`）并列举它提供的几组能力？
- [ ] 我能否说明 `on()` 覆盖了多少种事件（提示：33 种），并举一两个事件名？
- [ ] 我能否解释 `ExtensionRunner.emit()` 如何分发事件，以及 `session_before_*` 为何能取消操作（`runner.ts:801`）？
- [ ] 我能否说出 `emitToolCall` / `emitBeforeAgentStart` / `emitInput` 各自对应哪类事件及行号？
- [ ] 我能否解释扩展注册的命令/工具如何被调度（runner 内部表 + getCommand / emitToolCall）？
- [ ] 我是否理解 `bindCore` 为何要“先排队、后落地”（`runner.ts:314`）？
- [ ] 我是否理解 loader 用 jiti + 虚拟模块实现“即时加载 TS 扩展”（`loader.ts:50`、`:436`）？
- [ ] 我能否复述一个扩展从磁盘到生效的完整生命周期？
