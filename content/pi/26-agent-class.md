---
title: "第 26 章 · Agent 类、状态机与事件订阅"
date: 2026-07-01
summary: "第 25 章的 `agent-loop` 是\"无状态引擎\"——它只管一轮轮地调模型、跑工具，却不知道\"我是谁、消息从哪来、用户有没有插话\"。本章的 `Agent` 类（`packages/agent/src/agent.ts`）才是面向使用者的\"方向盘\"：它持有整段对话、提供 `prompt/steer/cont…"
tags:
  - pi
---
# 第 26 章 · Agent 类、状态机与事件订阅

> 第 25 章的 `agent-loop` 是"无状态引擎"——它只管一轮轮地调模型、跑工具，却不知道"我是谁、消息从哪来、用户有没有插话"。本章的 `Agent` 类（`packages/agent/src/agent.ts`）才是面向使用者的"方向盘"：它持有整段对话、提供 `prompt/steer/continue`，把事件广播给订阅者，并把"中途干预"这类高级能力接到核心循环上。

## 1. 先建立直觉：为什么需要 Agent 这一层

想象你写了个聊天界面。用户能做的远不止"发一句话"：

- 发一条新指令（`prompt`）。
- agent 正在跑，用户突然插一句"等等，换个思路"（`steer`）。
- agent 干完了，用户又追一句"顺便把测试也跑了"（`followUp`）。
- 界面要实时显示"正在流式输出""某个工具正在执行""出错了"——这需要**事件订阅**。
- 用户点了"停止"，需要能 `abort`。

这些"有状态 + 交互"的事，`agent-loop` 一个都不管（它只认 `config` 里传进来的钩子）。`Agent` 把这些钩子**接到自己内部的队列与状态上**，于是简单的 `prompt()` 调用背后，是一整套状态机。

> **提示 · 黑话速查**
>
> - **状态机（state machine）**：把"当前在干什么"（idle / streaming / 出错）显式建模出来的对象。
> - **事件总线（event bus）**：一个 `subscribe` 注册、`emit` 广播的通道。
> - **steer / followUp**：运行时中途注入消息的两种时机（轮中插话 / 收尾后续问）。
> - **QueueMode**：队列的取出策略（`"one-at-a-time"` 一次一条，或 `"all"` 一次全取）。

## 2. Agent 持有什么状态

`Agent` 用一个 `MutableAgentState` 持有运行期状态（`agent.ts:61-95`），对外通过 `get state()` 暴露（`agent.ts:260-262`）：

```ts
// packages/ai/src/agent.ts:260-262
get state(): AgentState {
  return this._state;
}
```

状态里关键字段：

- `systemPrompt` / `model` / `thinkingLevel`：当前配置。
- `messages` / `tools`：会话 transcript 与可用工具（赋值会**复制顶层数组**，见 `agent.ts:84-89`，避免外部引用被意外篡改）。
- `isStreaming`：是否正在跑一轮。
- `streamingMessage`：当前正在流式生成的助手消息。
- `pendingToolCalls`：正在执行的工具调用 id 集合。
- `errorMessage`：最近一次错误。

还有两个队列（`agent.ts:176-177`）和一组可注入的钩子函数（`beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` / `prepareNextTurn` 等），它们在构造时从 `AgentOptions` 接收（`agent.ts:216-238`）。

## 3. 事件订阅：Agent 的事件总线

```ts
// packages/ai/src/agent.ts:250-253
subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
  this.listeners.add(listener);
  return () => this.listeners.delete(listener);
}
```

`subscribe` 注册一个监听器，返回"取消订阅"的函数。所有事件（来自核心循环的 `agent_start`、`message_update`、`tool_execution_start`、`agent_end`……）都会经过 `processEvents` 转成内部状态变更，再**逐个 `await` 广播给所有监听器**（`agent.ts:544-591`）：

```ts
// packages/ai/src/agent.ts:584-591
const signal = this.activeRun?.abortController.signal;
if (!signal) throw new Error("Agent listener invoked outside active run");
for (const listener of this.listeners) {
  await listener(event, signal);
}
```

注意监听器的 `signal` 是当前这一轮的 `AbortSignal`——监听器也能感知"这轮被中止了"。注释还特别说明（`agent.ts:537-543`）：`agent_end` 只代表"不再有新循环事件"，agent 要等所有 `agent_end` 监听器都 settle 后才算真正 idle。

## 4. 与核心循环的分工（方向盘与引擎）

`Agent` 不直接写循环，它把状态"翻译"成 `agent-loop` 需要的 `AgentLoopConfig`。关键在 `createLoopConfig`（`agent.ts:445-484`）：

```ts
// packages/ai/src/agent.ts:475-482
getSteeringMessages: async () => {
  if (skipInitialSteeringPoll) { skipInitialSteeringPoll = false; return []; }
  return this.steeringQueue.drain();   // 取出用户中途插的话
},
getFollowUpMessages: async () => this.followUpQueue.drain(),  // 取出收尾续问
```

看——第 25 章里 `agent-loop` 的 `pendingMessages` / `followUpMessages`，正是从这里（Agent 的队列）取的！这就把"用户插话"能力从 UI 层一路透传到了核心循环。

`shouldStopAfterTurn` 也在这里包了一层，把当前 `signal` 传进去（`agent.ts:460-462`）；`prepareNextTurn` 则支持"每轮前动态换模型/换思考强度"（`agent.ts:463-471`，对应 `agent-loop.ts:232-245` 的 `prepareNextTurn` 快照）。

## 5. 三个核心动作：prompt / steer / continue

### 5.1 prompt：开新任务

```ts
// packages/ai/src/agent.ts:348-358
async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
  if (this.activeRun) {
    throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages...");
  }
  const messages = this.normalizePromptInput(input, images);
  await this.runPromptMessages(messages);
}
```

`prompt` 要求当前**没有**活跃 run（否则报错，提示用 `steer`/`followUp` 排队）。它把字符串/图片/消息统一成 `AgentMessage[]`（`normalizePromptInput`，`agent.ts:390-407`），再经 `runWithLifecycle` 委托给 `runAgentLoop`（`agent.ts:409-423`）。

### 5.2 steer / followUp：中途干预

```ts
// packages/ai/src/agent.ts:283-290
steer(message: AgentMessage): void { this.steeringQueue.enqueue(message); }
followUp(message: AgentMessage): void { this.followUpQueue.enqueue(message); }
```

- `steer`：进 `steeringQueue`，会被内层 while 在**下一轮工具之前**注入（`agent-loop.ts:182-190`）。
- `followUp`：进 `followUpQueue`，只在 agent 本要停下时被外层取出（`agent-loop.ts:263-268`）。

队列还有 `QueueMode`（`agent.ts:264-280`）：`"one-at-a-time"`（默认，每次取一条）或 `"all"`（`PendingMessageQueue.drain`，`agent.ts:141-154`）。`clearSteeringQueue` / `clearFollowUpQueue` / `clearAllQueues` 用于清空。

### 5.3 continue：从现有 transcript 续跑

```ts
// packages/ai/src/agent.ts:361-388
async continue(): Promise<void> {
  if (this.activeRun) throw new Error("Agent is already processing...");
  const lastMessage = this._state.messages[this._state.messages.length - 1];
  if (!lastMessage) throw new Error("No messages to continue from");
  if (lastMessage.role === "assistant") {
    const queuedSteering = this.steeringQueue.drain();
    if (queuedSteering.length > 0) { await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true }); return; }
    const queuedFollowUps = this.followUpQueue.drain();
    if (queuedFollowUps.length > 0) { await this.runPromptMessages(queuedFollowUps); return; }
    throw new Error("Cannot continue from message role: assistant");
  }
  await this.runContinuation();   // 最后一条是 user/toolResult 时才合法
}
```

`continue` 很有讲究：最后一条必须是 `user` 或 `toolResult`，否则模型会拒绝（核心循环注释 `agent-loop.ts:60-62` 已说明）。如果最后一条是 `assistant`，它会先把队列里的 steer/followUp 当新消息跑。对应核心循环的 `runAgentLoopContinue`。

## 6. 生命周期与中止

`runWithLifecycle`（`agent.ts:486-509`）包住整个 run：

```ts
// packages/ai/src/agent.ts:486-509（节选）
private async runWithLifecycle(executor) {
  if (this.activeRun) throw new Error("Agent is already processing.");
  const abortController = new AbortController();
  ... this.activeRun = { promise, resolve: resolvePromise, abortController };
  this._state.isStreaming = true;
  try { await executor(abortController.signal); }
  catch (error) { await this.handleRunFailure(error, abortController.signal.aborted); }
  finally { this.finishRun(); }
}
```

它做三件事：建 `AbortController`、置 `isStreaming=true`、跑完（或失败）后 `finishRun` 清运行状态。`abort()`（`agent.ts:319-321`）只要 `activeRun?.abortController.abort()`，信号就会一路传到核心循环，让模型流、工具执行全部中断。`waitForIdle()`（`agent.ts:328-330`）返回当前 run 的 promise，方便上层"等它彻底干完"。

> **说明 · 失败也走事件流**
>
> 即使 run 抛异常，`handleRunFailure`（`agent.ts:511-527`）也会构造一条 `errorMessage` 的失败消息，并 `emit` 出完整的 `message_start`→`message_end`→`turn_end`→`agent_end` 事件序列。这意味着上层订阅者**永远能收到收尾事件**，不会出现"静默挂死"。

## 7. 状态机的边界：`reset`

```ts
// packages/ai/src/agent.ts:333-345
reset(): void {
  if (this.activeRun) throw new Error("Agent is already processing. Wait for completion before resetting.");
  this._state.messages = [];
  this._state.isStreaming = false;
  this._state.streamingMessage = undefined;
  this._state.pendingToolCalls = new Set<string>();
  this._state.errorMessage = undefined;
  this.clearFollowUpQueue();
  this.clearSteeringQueue();
}
```

`reset` 清空 transcript 与所有队列，但**必须等当前 run 结束**（否则抛错）。这保证状态机不会在跑着的时候被从脚下抽走地毯。

## 8. 衔接全景

```text
UI / 调用方
   │  prompt / steer / followUp / continue / abort
   ▼
Agent（有状态方向盘 + 事件总线）
   │  createLoopConfig：把队列/钩子注入成 AgentLoopConfig
   │  getSteeringMessages → steeringQueue.drain()
   │  getFollowUpMessages → followUpQueue.drain()
   ▼
runAgentLoop / runAgentLoopContinue（agent-loop.ts）
   │  双层 while 逐轮：think → call → observe
   │  emit 事件
   ▼
Agent.processEvents：更新 state + 广播给所有 subscribe 监听器
```

> **提示 · 一句话记忆**
>
> `Agent` = 状态机（state）+ 事件总线（subscribe）+ 两个队列（steer/followUp）+ 生命周期（prompt/continue/abort/reset）。它把"用户能做的所有交互"翻译成核心循环能懂的钩子。

## 自查清单

- [ ] 我能说出 Agent 类与 agent-loop 的分工（方向盘 vs 引擎）。- [ ] 我知道 `state` 里的关键字段（messages / isStreaming / pendingToolCalls / errorMessage）。
- [ ] 我能在源码定位 `subscribe`（`agent.ts:250`）、`steer`（`agent.ts:283`）、`followUp`（`agent.ts:288`）、`continue`（`agent.ts:361`）。
- [ ] 我理解 `steer` 与 `followUp` 的区别（轮中插话 vs 收尾续问）。
- [ ] 我知道 `getSteeringMessages` / `getFollowUpMessages`（`agent.ts:475-482`）如何接到核心循环。
- [ ] 我理解 `abort()` 通过 `AbortController` 信号透传到循环与工具。
- [ ] 我知道 `reset` 为何要求当前无活跃 run。
