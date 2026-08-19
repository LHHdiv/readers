---
title: "第 25 章 · 核心循环 agent-loop（灵魂，逐行）"
date: 2026-07-01
summary: "如果说 Pi 是一只\"会自己干活的智能体\"，那 `agent-loop.ts` 就是它的心脏。模型思考一次、调用工具、看到结果、再思考——这个\"永动机\"式的循环全在这里。本章逐行拆解，让你看懂 Pi 是怎么\"一遍遍跟模型对话直到任务完成\"的。这是全项目的灵魂文件。"
tags:
  - pi
---
# 第 25 章 · 核心循环 agent-loop（灵魂，逐行）

> 如果说 Pi 是一只"会自己干活的智能体"，那 `agent-loop.ts` 就是它的心脏。模型思考一次、调用工具、看到结果、再思考——这个"永动机"式的循环全在这里。本章逐行拆解，让你看懂 Pi 是怎么"一遍遍跟模型对话直到任务完成"的。这是全项目的灵魂文件。

## 1. 先建立直觉：agent 到底在循环什么

一个 coding agent 的工作方式，和人类程序员很像：

```text
你: 把 README 改成中文。
模型: 我先读一下 README 文件（调用 read 工具）
模型: 读到了，我看到是英文，现在写一份中文版（调用 write 工具）
模型: 写好了，任务完成。
```

这一来一回，**不是一次函数调用，而是一个循环**。每一轮里模型可能：只说话、说话+调工具、或调多个工具。循环要处理"调工具→拿结果→再喂给模型"这种反复的回填。Pi 用**双层 while** 把这个复杂度管得井井有条。

> **提示 · 黑话速查**
>
> - **turn（一轮）**：模型产生一次回复（可能含多个工具调用）并被执行、回填的整个过程。
> - **follow-up（续问）**：agent 本该停下时，外部又塞进来的新消息。
> - **steering（中途干预）**：agent 正在干活时，用户插话。
> - **stopReason**：模型为什么停（stop / toolUse / length / error / aborted）。

## 2. 三个入口：agentLoop → runAgentLoop → runLoop

调用栈是三层：

```ts
// packages/ai/src/agent-loop.ts:31-54
export function agentLoop(prompts, context, config, signal, streamFn) {
  const stream = createAgentStream();
  void runAgentLoop(prompts, context, config, async (event) => stream.push(event), signal, streamFn)
    .then((messages) => stream.end(messages));
  return stream;
}
```

- `agentLoop`（`agent-loop.ts:31`）：对外的同步入口，**立即返回**一个 `EventStream`（见第 21 章）。它把真正的活交给 `runAgentLoop` 异步跑，`emit` 的事件实时推给流。
- `runAgentLoop`（`agent-loop.ts:95-118`）：准备上下文（把 prompts 拼进 `currentContext.messages`），发 `agent_start` / `turn_start` / `message_*` 事件，然后调 `runLoop`。最后返回累积的 `newMessages`。
- `runLoop`（`agent-loop.ts:155-275`）：**真正的核心双层循环**，下面详讲。

还有个变体 `agentLoopContinue` / `runAgentLoopContinue`（`agent-loop.ts:64-143`）：不从新 prompt 开始，而是从当前上下文"接着跑"（最后一条消息必须是 user 或 toolResult，不能是 assistant）。这在 agent 被打断后重试时有用。

## 3. 双层 while：外层管"续问"，内层管"一轮"

```ts
// packages/ai/src/agent-loop.ts:169-272（节选核心）
// 外层循环：当 agent 本要停下、却冒出 follow-up 消息时，重新进来
while (true) {
  let hasMoreToolCalls = true;

  // 内层循环：处理同一段对话里的工具调用与中途干预
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    if (!firstTurn) { await emit({ type: "turn_start" }); }
    else { firstTurn = false; }

    // ① 先把用户中途插的话（steering）注入
    if (pendingMessages.length > 0) { ... currentContext.messages.push(message); ... }

    // ② 让模型思考并产出回复（可能含工具调用）
    const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
    newMessages.push(message);

    // 出错/中止 → 直接结束整个 agent
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      await emit({ type: "turn_end", ... });
      await emit({ type: "agent_end", messages: newMessages });
      return;
    }

    // ③ 看模型有没有调工具
    const toolCalls = message.content.filter((c) => c.type === "toolCall");
    if (toolCalls.length > 0) {
      const executedToolBatch = (message.stopReason === "length")
        ? await failToolCallsFromTruncatedMessage(toolCalls, emit)   // 输出被截断了，工具参数不可信
        : await executeToolCalls(currentContext, message, config, signal, emit);
      toolResults.push(...executedToolBatch.messages);
      hasMoreToolCalls = !executedToolBatch.terminate;
      for (const result of toolResults) { currentContext.messages.push(result); newMessages.push(result); }
    }

    await emit({ type: "turn_end", message, toolResults });

    // ④ 是否该停？shouldStopAfterTurn 钩子
    if (await config.shouldStopAfterTurn?.({ message, toolResults, ... })) {
      await emit({ type: "agent_end", messages: newMessages });
      return;
    }
    pendingMessages = (await config.getSteeringMessages?.()) || [];
  }

  // 内层结束（这一轮没工具可调了）→ 看有没有 follow-up
  const followUpMessages = (await config.getFollowUpMessages?.()) || [];
  if (followUpMessages.length > 0) { pendingMessages = followUpMessages; continue; }  // 外层再转一圈
  break;  // 没有任何后续 → 真正停下
}
```

### 3.1 外层 while 的意义

外层只做一件事：**agent 本来要停了，但外部队列里又塞了"续问"（follow-up）**。比如你设了"每天定时让 agent 汇报一次"，当上一次汇报结束，定时器又丢进一条新指令——外层 `continue` 把 `pendingMessages` 设为 follow-up，`break` 不出，循环再来一圈。没有任何续问时 `break`，整个 agent 结束（`agent-loop.ts:270-272`）。

### 3.2 内层 while 的意义

内层是"单轮对话内部"：模型可能调 1 个工具、调 5 个工具、或调完工具后还想再调。`hasMoreToolCalls` 为 true 就继续转，直到模型不再调工具（或所有工具都 `terminate`）。中途用户插话（`pendingMessages`）也会让内层继续（`agent-loop.ts:174` 的 `|| pendingMessages.length > 0`）。

## 4. 一轮的三阶段：think → call → observe

内层每一圈，本质就是这三步，对应代码：

```text
① streamAssistantResponse  →  思考 / 产出回复（think）
        │  （模型返回，可能带 toolCall 块）
② executeToolCalls          →  调用工具（call）
        │  （拿到工具结果）
③ createToolResultMessage   →  观察回填（observe）
        └─ 结果 push 进 messages，下一轮模型就能"看到"
```

### 4.1 思考：`streamAssistantResponse`（`agent-loop.ts:281-372`）

它把 `AgentMessage[]` 转换成 LLM 能懂的 `Message[]`（通过 `config.convertToLlm`，`agent-loop.ts:295`），构建 `Context`，解析可能过期的 API key（`agent-loop.ts:305-306`），然后调用 `streamFunction` 流式拿到模型回复。关键点：**流式事件被实时写回 `context.messages`**（`agent-loop.ts:321`、`337`），并 `emit` 出 `message_update` 等事件，UI 才能边想边显示。

### 4.2 调用：`executeToolCalls`（`agent-loop.ts:411-426`）

```ts
// packages/ai/src/agent-loop.ts:411-426
async function executeToolCalls(currentContext, assistantMessage, config, signal, emit) {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  const hasSequentialToolCall = toolCalls.some(
    (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);   // 一个个跑
  }
  return executeToolCallsParallel(...);       // 一起跑
}
```

工具执行前先过校验（第 23 章）：`prepareToolCall` 内部调 `validateToolArguments`（`agent-loop.ts:618`）。被 `beforeToolCall` 拦截的调用会被直接标记错误（`agent-loop.ts:619-647`），不会真正执行。

### 4.3 观察回填：`createToolResultMessage`（`agent-loop.ts:777-791`）

```ts
// packages/ai/src/agent-loop.ts:777-791
function createToolResultMessage(finalized): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content ?? [],    // 无内容也归一为空数组
    details: finalized.result.details,
    usage: finalized.result.usage,
    ...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}
```

工具结果被封装成 `toolResult` 消息，push 回 `currentContext.messages`（`agent-loop.ts:218-221`）。下一轮循环里，模型就能"看到"自己工具调用的结果——这就是 **observe（观察）**。

## 5. 并行还是串行？

模型经常**一次返回多个工具调用**（比如"同时读 3 个文件"）。Pi 两种都支持：

- **并行**（`executeToolCallsParallel`，`agent-loop.ts:489-554`）：所有工具调用先 `prepare`，再用 `Promise.all` 一次性执行（`agent-loop.ts:540-542`），最后按顺序回填结果。速度快，但工具之间不能互相依赖。
- **串行**（`executeToolCallsSequential`，`agent-loop.ts:433-487`）：一个接一个 `for` 循环执行，每个结果立刻回填。

选择逻辑（`agent-loop.ts:422`）：**全局 `config.toolExecution === "sequential"` 时全部串行；或者某个工具自己声明了 `executionMode: "sequential"` 时，该轮也串行**。后者很实用——比如"写文件"工具标了 sequential，而"读文件"可以并行，互不影响。

> **注意 · 输出被截断时绝不执行工具**
>
> 如果模型这一轮是 `stopReason === "length"`（输出 token 不够、被砍断），它发出的工具参数很可能是残缺的 JSON。这类调用**宁可全部失败也不执行**（`failToolCallsFromTruncatedMessage`，`agent-loop.ts:211-213`、`381-406`），并回一条错误让模型重发完整参数。这是防止"拿半个参数去删文件"的安全阀。

## 6. 终止条件

循环在以下情况停下：

1. **模型回复是 error / aborted** → 整个 agent 立即 `return`（`agent-loop.ts:196-200`）。
2. **`shouldStopAfterTurn` 钩子返回 true** → 这一轮后主动停（`agent-loop.ts:247-257`）。上层（如 coding-agent）用它实现"达到最大轮数就停""用户点了停止"等策略。
3. **内层没有工具调用、且没有任何 steering 消息** → `hasMoreToolCalls` 保持 false，跳出内层（`agent-loop.ts:206`、`174`）。
4. **外层检查 follow-up 为空** → `break`，agent 真正结束（`agent-loop.ts:263-272`）。

```text
            ┌─────────────────────────────────────────────┐
            │  外层 while(true)                            │
            │   │                                         │
            │   │  内层 while(hasMoreToolCalls || steering)│
            │   │   │                                     │
            │   │   ├─ 注入 steering 消息                 │
            │   │   ├─ ② streamAssistantResponse (think)  │
            │   │   ├─ 有 toolCall?                       │
            │   │   │    └─ executeToolCalls (call)       │
            │   │   │         └─ 并行/串行执行            │
            │   │   ├─ createToolResultMessage (observe)  │
            │   │   ├─ shouldStopAfterTurn? → 是则退出    │
            │   │   └─ 取 steering，转下一圈              │
            │   │                                         │
            │   └─ 内层结束 → 检查 follow-up              │
            │        ├─ 有 → pendingMessages=followUp,    │
            │        │     continue（外层再来一圈）        │
            │        └─ 无 → break（agent 结束）          │
            └─────────────────────────────────────────────┘
```

## 7. 与第 26 章的衔接

`agent-loop.ts` 是"无状态"的执行引擎：它**不知道**自己被谁调用、消息从哪来。真正"有状态、能订阅事件、能中途 steer/followUp"的是 `Agent` 类（第 26 章）。`Agent` 把 `getSteeringMessages` / `getFollowUpMessages` 这两个钩子接到自己的队列上（`agent.ts` 的 `createLoopConfig`），于是"用户插话"才能力透到本文件的 `pendingMessages` 里。简单说：**agent-loop 是引擎，Agent 是方向盘**。

## 自查清单

- [ ] 我能画出双层 while：外层管 follow-up，内层管一轮工具调用。
- [ ] 我知道一轮的三阶段：think（streamAssistantResponse）/ call（executeToolCalls）/ observe（createToolResultMessage）。
- [ ] 我能在源码定位 `runLoop`（`agent-loop.ts:155`）、内层 `while`（`agent-loop.ts:174`）、外层 `while`（`agent-loop.ts:170`）。
- [ ] 我理解并行 vs 串行的判定（`agent-loop.ts:422` 的 `config.toolExecution` 与工具 `executionMode`）。
- [ ] 我知道 `stopReason === "length"` 时工具为何被整体拒绝。
- [ ] 我能列出至少 3 个终止条件。
- [ ] 我理解 agent-loop 是"无状态引擎"，状态由 Agent 类持有。
