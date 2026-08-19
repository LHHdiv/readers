---
title: "第 34 章 · AgentSession 核心会话抽象"
date: 2026-07-01
summary: "约定：本章行号来自 `packages/coding-agent/src/core/agent-session.ts`、同目录的 `agent-session-runtime.ts` 与 `agent-session-services.ts`，以及运行时层 `packages/agent` 的 `Agent` 类…"
tags:
  - pi
---
# 第 34 章 · AgentSession 核心会话抽象

在第 33 章里，我们看到 `main.ts` 的 runtime 工厂最终产出了 `AgentSessionRuntime`。而真正“能跑起来一个会话”的核心对象，是 **`AgentSession`**。本章就把它拆开讲清楚：它是什么、封装了哪些能力、和运行时层的 `Agent` 类是什么关系，以及“产品层（coding-agent）”如何通过它去编排“运行时层（agent）”。

> 约定：本章行号来自 `packages/coding-agent/src/core/agent-session.ts`、同目录的 `agent-session-runtime.ts` 与 `agent-session-services.ts`，以及运行时层 `packages/agent` 的 `Agent` 类（通过类型导入使用）。

## 34.1 AgentSession 是什么

`AgentSession` 是一个**对“一次会话”的完整封装**。文件头部的注释（`agent-session.ts:1`–`agent-session.ts:14`）列得明明白白，它在三种运行模式（交互、打印、RPC）之间**共享**，并且封装了这些东西：

- Agent 状态的访问（模型、思考档位、消息列表等）
- 事件订阅，并且**自动做会话持久化**（消息落盘到 JSONL）
- 模型与思考档位（thinking level）的管理
- 压缩（compaction，手动与自动）
- Bash 执行
- 会话切换（switch）与分支（fork）

换句话说：**三种模式各自只负责“怎么把输入显示出来、把输出呈现出去”（I/O 层），而 `AgentSession` 负责“把这些输入喂给 Agent、把 Agent 产生的消息存好、在需要时压缩上下文、在需要时换盘子（切会话）”这些业务内核。** 这正是第 13 章讲过的“产品层编排运行时层”的具体落地。

```ts
// packages/coding-agent/src/core/agent-session.ts:305
export class AgentSession {
    readonly agent: Agent;                 // 运行时层的 Agent 实例
    readonly sessionManager: SessionManager;
    readonly settingsManager: SettingsManager;
    // ...
}
```

## 34.2 三个一组：session / runtime / services

要理解 `AgentSession`，必须先理解它身边的两个搭档，三者共同组成“会话抽象三件套”：

| 对象 | 定义位置 | 职责 |
| --- | --- | --- |
| `AgentSessionServices` | `agent-session-services.ts:73` | 一组“服务”集合：cwd、模型运行时、设置管理器、资源加载器、诊断器 |
| `AgentSession` | `agent-session.ts:305` | 会话业务内核：封装 Agent + 事件 + 持久化 + 模型/压缩/分支 |
| `AgentSessionRuntime` | `agent-session-runtime.ts:74` | “运行环境”：把 session 和 services 包在一起，并提供切会话/分支/导入等外壳操作 |

`AgentSessionServices` 接口定义在 `agent-session-services.ts:73`–`agent-session-services.ts:80`，包含：`cwd`、`agentDir`、`modelRuntime`、`settingsManager`、`resourceLoader`、`diagnostics` 等。它由 `createAgentSessionServices()`（`agent-session-services.ts:135`–`agent-session-services.ts:193`）创建——内部会构造 `ModelRuntime`、`SettingsManager`，再 `new DefaultResourceLoader(...)`，并把待加载的扩展 provider 注册进去（`applyExtensionFlagValues` 见 `agent-session-services.ts:82`）。

`AgentSessionRuntime` 类定义在 `agent-session-runtime.ts:74`–`agent-session-runtime.ts:406`，它通过 `session` / `services` 两个 getter 暴露内部对象，并实现了：

- `switchSession()`（`agent-session-runtime.ts:196`–`agent-session-runtime.ts:224`）
- `newSession()`（`agent-session-runtime.ts:226`–`agent-session-runtime.ts:260`）
- `fork()`（`agent-session-runtime.ts:262`–`agent-session-runtime.ts:352`）
- `importFromJsonl()`（`agent-session-runtime.ts:361`–`agent-session-runtime.ts:396`）
- `dispose()`（`agent-session-runtime.ts:398`–`agent-session-runtime.ts:405`）

> **提示**
>
> 记忆口诀：**services 是“食材厨具”，session 是“正在炒的这盘菜”，runtime 是“端盘子的服务员还能换盘子”**。三件套里，session 是被操作的核心，runtime 是给模式（交互/RPC/打印）用的统一手柄。

## 34.3 构造函数：一出生就“订阅”Agent

`AgentSession` 的构造函数定义在 `agent-session.ts:377`–`agent-session.ts:403`。它做的最关键的一件事，是在 `agent-session.ts:395` 立刻订阅了底层 `Agent` 的事件：

```ts
// packages/coding-agent/src/core/agent-session.ts:395
this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
```

也就是说，从 `AgentSession` 诞生的那一刻起，底层 `Agent` 每产生一条消息、每调用一次工具，`_handleAgentEvent`（`agent-session.ts:610`–`agent-session.ts:681`）都会被触发。这个内部处理器做两类重要工作：

1. **先通知扩展**（`agent-session.ts:634`：`await this._emitExtensionEvent(event)`）——把事件转成扩展能订阅的形式。
2. **再做会话持久化**（`agent-session.ts:640` 起）：当 `message_end` 事件到来时，普通 LLM 消息会被 `sessionManager.appendMessage(...)` 落盘（`agent-session.ts:656`），自定义消息走 `appendCustomMessageEntry(...)`（`agent-session.ts:644`）。

这就是为什么你用 Pi 聊完天关掉终端，下次还能“恢复会话”——**持久化就藏在事件订阅里**。

## 34.4 事件订阅：不止给内部用

`AgentSession` 自己订阅了 `Agent` 还不够，它还对外提供 `subscribe()`（`agent-session.ts:815`–`agent-session.ts:825`），让任何模式都能监听会话事件：

```ts
// packages/coding-agent/src/core/agent-session.ts:815
subscribe(listener: AgentSessionEventListener): () => void {
    this._eventListeners.push(listener);
    return () => {
        const index = this._eventListeners.indexOf(listener);
        if (index !== -1) this._eventListeners.splice(index, 1);
    };
}
```

返回的“取消订阅函数”很重要：交互模式在切换/重建会话时会调用它来避免内存泄漏（见 `interactive-mode.ts` 的 `rebindCurrentSession` 里 `this.unsubscribe?.()`）。

`AgentSessionEvent` 是会话层对底层 `AgentEvent` 的扩展（`agent-session.ts:141`–`agent-session.ts:183`），在 `agent_end`、`message_end` 等基础上，增加了 `queue_update`、`compaction_start/end`、`thinking_level_changed`、`auto_retry_*`、`summarization_retry_*` 等**只有“会话”才有的语义**。例如“压缩开始/结束”“思考档位变化”这些事件，是底层的纯 Agent loop 不关心的，但 `AgentSession` 关心——因为它们与会话的展示和管理直接相关。

## 34.5 对外暴露的只读状态

`AgentSession` 提供了一组 getter，让各模式随时读取会话状态：

```ts
// packages/coding-agent/src/core/agent-session.ts
get state()                // :863  完整 Agent 状态
get model()                // :868  当前模型（可能未选）
get thinkingLevel()       // :873  当前思考档位
get isStreaming()         // :878  是否正在跑
get isIdle()               // :883  是否空闲
get systemPrompt()        // :888  当前生效的系统提示词
get sessionFile()         // :970  会话文件路径
get sessionId()            // :975  会话 ID
get messages()            // :955  全部消息（含自定义类型）
```

这些 getter 大多只是简单地把 `this.agent.state.xxx` 暴露出来，例如 `agent-session.ts:863`–`agent-session.ts:865` 直接返回 `this.agent.state`。也就是说，`AgentSession` 在运行时层 `Agent` 之上包了一层“带会话语义”的视图。

## 34.6 提示（prompt）：会话的输入主入口

用户每发一句话，最终都会调用 `AgentSession.prompt()`（`agent-session.ts:1116`–`agent-session.ts:1273`）。这个函数很长，但逻辑很清晰，大致分这几步：

1. 若以 `/` 开头且是扩展命令，先尝试执行扩展命令（`agent-session.ts:1124`–`agent-session.ts:1131`，见 `_tryExecuteExtensionCommand` `agent-session.ts:1278`）。
2. 若正在压缩中，拒绝提交（`agent-session.ts:1133`）。
3. 触发 `input` 事件让扩展有机会拦截/改写输入（`agent-session.ts:1142`–`agent-session.ts:1157`）。
4. 展开技能命令（`/skill:name`）与提示词模板（`agent-session.ts:1162`）。
5. 若正在流式输出，按 `steer` / `followUp` 入队（`agent-session.ts:1167` 起）。
6. 否则校验模型与 API key（`agent-session.ts:1186`–`agent-session.ts:1203`）。
7. 触发 `before_agent_start` 扩展事件，允许扩展改写系统提示词（`agent-session.ts:1233`）。
8. 真正交给 `this.agent.prompt(messages)` 跑（`agent-session.ts:1272`，经 `_runAgentPrompt` `agent-session.ts:1063`）。

还有一个容易混淆的点：**流式输出时不能提交新提示，只能排队**。`prompt()` 在 `agent-session.ts:1167` 检测到 `isStreaming` 后，会根据 `streamingBehavior` 走 `steer`（`agent-session.ts:1343`）或 `followUp`（`agent-session.ts:1363`）——这就是“边跑边插话”的实现基础。

> **说明**
>
> `steer`（插话）和 `followUp`（追问）的区别：`steer` 会在当前助手回合的工具调用之间立刻插入；`followUp` 要等 Agent 完全处理完、队列里没有别的消息时才处理。二者都通过 `agent.steer()` / `agent.followUp()` 最终落到底层 `Agent`。

## 34.7 排队与取消：clearQueue / sendCustomMessage

除了普通提示，`AgentSession` 还提供几个“会话级”消息操作：

- `clearQueue()`（`agent-session.ts:1518`–`agent-session.ts:1526`）：清空 steer/followUp 队列并返回被清掉的内容，常用于用户按 Esc 中断后把待发消息退回编辑器。
- `sendCustomMessage()`（`agent-session.ts:1437`–`agent-session.ts:1471`）：发送一个“自定义类型”的消息（不属于普通 user/assistant/tool，而是扩展定义的语义消息），可带 `deliverAs` 决定作为 steer/followUp/nextTurn 投递。
- `waitForIdle()`（`agent-session.ts:1556`）：等待 Agent 跑完、队列清空，常在扩展命令里用来“等这一轮结束再继续”。

这些方法是**扩展能深度参与会话流程**的接口——比如一个扩展想“在下一轮开始前塞一条上下文”，就用 `sendCustomMessage(..., { deliverAs: "nextTurn" })`。

## 34.8 模型与思考档位管理

`AgentSession` 把“换模型”“切思考档位”也收归自己管理：

- `setModel(model)`（`agent-session.ts:1586`–`agent-session.ts:1601`）：校验 auth 后写入 `agent.state.model`，并追加到会话记录、写入默认设置，再发 `model_select` 事件。
- `cycleModel(direction)`（`agent-session.ts:1609`–`agent-session.ts:1673`）：在 `--models` 限定的“作用域模型”或“全部可用模型”里循环切换。
- `setThinkingLevel(level)`（`agent-session.ts:1684`–`agent-session.ts:1706`）：把思考档位夹到当前模型支持的范围，并在变化时落盘、发 `thinking_level_select` 事件。

这些操作之所以放在 `AgentSession` 而不是让模式各自实现，是因为它们都涉及**持久化 + 扩展事件通知 + 对底层 `Agent` 状态的写入**这三件必须一起做的事。

## 34.9 工具注册表：setActiveToolsByName

`AgentSession` 内部维护一个工具注册表（`agent-session.ts:367`–`agent-session.ts:370`：`_toolRegistry`、`_toolDefinitions`、片段与准则 Map）。它提供：

- `getActiveToolNames()`（`agent-session.ts:901`）：当前启用的工具名。
- `getAllTools()`（`agent-session.ts:908`）：所有已配置工具的详情。
- `setActiveToolsByName(names)`（`agent-session.ts:928`–`agent-session.ts:943`）：按名字启用一组工具，并**重建系统提示词**（因为可用工具变了，提示词里的工具清单也要变）。

这就是为什么你在界面上开关某些工具后，提示词会相应更新——`setActiveToolsByName` 在 `agent-session.ts:941` 调了 `_rebuildSystemPrompt`，把新工具片段重新拼进 `_baseSystemPrompt`。

## 34.10 压缩（compaction）与分支

当上下文太长，`AgentSession` 负责压缩。`compact()`（`agent-session.ts:1790`–`agent-session.ts:1933`）会先 abort 当前运行，再调用 `session_before_compact` 扩展事件（允许扩展自定义压缩，`agent-session.ts:1818`），接着调用运行时层的 `compact()` 生成摘要，最后把压缩条目写进会话、重建 `agent.state.messages`。

判断“是否需要自动压缩”由 `_checkCompaction()`（`agent-session.ts:1962` 起）负责：它处理两类情况——上下文溢出（overflow，可重试）和超过阈值（threshold，只压不重试）。这也是为什么 Pi 聊很久也不会“爆上下文”——`AgentSession` 在每轮结束自动兜底。

## 34.11 它与运行时层 Agent 的关系

`AgentSession` 在 `agent-session.ts:18` 通过类型导入了运行时层的 `Agent`、`AgentState`、`AgentTool` 等。关系可以一句话概括：

- **`Agent`（运行时层）** 是“会思考的引擎”：它跑 agentic loop、调用工具、产出消息。
- **`AgentSession`（产品层）** 是“会话管理器”：它持有 `Agent` 的引用（构造函数 `agent-session.ts:378`），订阅其事件、做持久化、管模型/压缩/分支，并把这个“带会话语义”的对象暴露给三种模式。

```text
        ┌─────────────── 三种模式（I/O 层）───────────────┐
        │  InteractiveMode   PrintMode     RpcMode        │
        └───────────────────────┬─────────────────────────┘
                                 │ 使用统一的 runtime 手柄
                                 ▼
                     AgentSessionRuntime (runtime 外壳)
                                 │ 持有
                                 ▼
        ┌──────────────── AgentSession（会话内核）───────────────┐
        │  · 订阅 Agent 事件 → 自动持久化                          │
        │  · prompt() 输入入口 / steer / followUp                 │
        │  · setModel / cycleModel / setThinkingLevel            │
        │  · compact() / fork / switch 的会话侧逻辑              │
        │  · setActiveToolsByName → 重建系统提示词               │
        │  · 持有并暴露底层 Agent 的状态                           │
        └───────────────────────────┬──────────────────────────┘
                                     │ 持有
                                     ▼
                       Agent（运行时层：思考引擎）
```

> **提示**
>
> 你可能会问：为什么不直接让交互模式去操作 `Agent`？答案是**复用与一致性**。所有模式共享同一个 `AgentSession`，意味着持久化、扩展事件、压缩策略都只有一份实现，不会因为“换了种用法”就行为不一致。这是 Pi 架构里“产品层编排运行时层”思想的典型体现。

## 34.12 小结

`AgentSession` 是 Pi 产品层的中枢。它不负责具体“怎么画界面”，而是把“一次会话应该有的全部状态与行为”收敛到一个对象里，再交给交互、打印、RPC 三种模式去复用。理解了它，你再看任何模式的源码，都会先问一句：“它怎么拿到的 `AgentSession`，又调用了它的哪个方法？”

## 34.13 一次会话的时序：从敲回车到落盘

把前面几节串起来，用户“敲下回车”之后发生了什么？下面这条时序线把各角色的协作讲清楚：

```text
用户         交互模式            AgentSession               Agent(运行时)        会话文件
 │  输入文本    │                     │                         │                  │
 │────────────►│                     │                         │                  │
 │             │ session.prompt()    │                         │                  │
 │             │────────────────────►│                         │                  │
 │             │                     │ before_agent_start 事件 │                  │
 │             │                     │────────────────────────►│ 跑 agentic loop  │
 │             │                     │                         │─── 产生消息 ────►│
 │             │                     │ 订阅到 Agent 事件       │                  │
 │             │                     │── 通知扩展 + 持久化 ────────────────────────►│ appendMessage
 │             │  渲染事件           │                         │                  │
 │◄────────────│◄───────────────────│                         │                  │
 │  看到回答    │                     │                         │                  │
```

注意：**持久化（落盘）发生在 `AgentSession` 订阅 `Agent` 事件的环节**，而不是在模式层。这正是“业务内核放一处”的另一个好处——不管你用哪种模式，消息的保存逻辑只有一份。

## 34.14 我们为什么花一整章讲它

`AgentSession` 是 Pi 产品层里“承上启下”的那块基石：

- **对下**，它持有并编排运行时层的 `Agent`，把“会思考的引擎”包成“带会话语义的对象”。
- **对上**，它给三种模式提供统一的 `runtime` 手柄（经 `AgentSessionRuntime`），让交互、打印、RPC 不用各自实现持久化、压缩、换模型。

如果你只记一句：在 Pi 里，凡是“和一次会话有关的状态与行为”，先去 `AgentSession` 找；凡是“怎么把会话显示出来”，才去看某个模式。这个二分法能帮你快速定位几乎任何一行产品层代码。

## 34.15 关键方法速查表

把本章出现的核心方法集中列在这里，方便回查：

| 方法 | 行号 | 作用 |
| --- | --- | --- |
| `AgentSession`（类） | `agent-session.ts:305` | 会话业务内核 |
| 构造函数 | `agent-session.ts:377` | 订阅 `Agent` 事件、装配内部状态 |
| `subscribe()` | `agent-session.ts:815` | 对外暴露事件订阅 |
| `prompt()` | `agent-session.ts:1116` | 会话输入主入口 |
| `clearQueue()` | `agent-session.ts:1518` | 清空 steer/followUp 队列 |
| `sendCustomMessage()` | `agent-session.ts:1437` | 发送自定义类型消息 |
| `waitForIdle()` | `agent-session.ts:1556` | 等待 Agent 跑完、队列清空 |
| `setModel()` | `agent-session.ts:1586` | 切换模型 |
| `setThinkingLevel()` | `agent-session.ts:1684` | 切换思考档位 |
| `setActiveToolsByName()` | `agent-session.ts:928` | 启用工具组并重建系统提示词 |
| `compact()` | `agent-session.ts:1790` | 压缩会话上下文 |
| `_checkCompaction()` | `agent-session.ts:1962` | 判断是否需要自动压缩 |

## 自查清单

- [ ] 我能否解释 `AgentSession` 在三种模式间共享、负责“业务内核”的定位？
- [ ] 我能否区分 `services` / `session` / `runtime` 三件套各自的职责与定义行号？
- [ ] 我能否说明构造函数为何在 `agent-session.ts:395` 立刻订阅 Agent 事件，以及这如何驱动持久化？
- [ ] 我能否说出 `AgentSessionEvent` 相比底层 `AgentEvent` 多了哪些“会话语义”事件（`:141`）？
- [ ] 我能否说出 `prompt()` 的主要步骤，以及流式时为何只能 `steer`/`followUp`？
- [ ] 我能否解释 `clearQueue` / `sendCustomMessage` / `waitForIdle` 各自的用途？
- [ ] 我能否说明 `setModel` 与 `setThinkingLevel` 为什么要落盘并触发扩展事件？
- [ ] 我能否解释 `setActiveToolsByName` 为何会重建系统提示词（`:928`、`:941`）？
- [ ] 我能否说明 `compact()` 在压缩前会先询问扩展（`session_before_compact`）？
- [ ] 我是否理解 `AgentSession`（产品层）与 `Agent`（运行时层）的“管理器 vs 引擎”关系？
