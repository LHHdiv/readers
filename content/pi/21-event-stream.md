---
title: "第 21 章 · 流式事件流 event-stream 与增量 JSON 解析"
date: 2026-07-01
summary: "前面几章反复出现一个东西：`AssistantMessageEventStream`——适配器返回的不是\"最终答案\"，而是一个**事件流**。本章我们终于看它的内部实现：`packages/ai/src/utils/event-stream.ts`（EventStream 基类）和 `packages/ai/sr…"
tags:
  - pi
---
# 第 21 章 · 流式事件流 event-stream 与增量 JSON 解析

前面几章反复出现一个东西：`AssistantMessageEventStream`——适配器返回的不是"最终答案"，而是一个**事件流**。本章我们终于看它的内部实现：`packages/ai/src/utils/event-stream.ts`（EventStream 基类）和 `packages/ai/src/utils/json-parse.ts`（半成品 JSON 解析）。

为什么不直接等结果？因为 LLM 是**一个字一个字蹦**出来的。如果你等它全写完再显示，用户会盯着空白屏好几秒。事件流让 UI 实时"打字"，也让 Pi 主循环能在"工具调用拼到一半"时就做准备。

> **说明**
>
> **黑话速查**
> - *异步迭代器（AsyncIterable）*：能用 `for await...of` 一个一个取元素的对象，元素将来才到。
> - *Partial（半成品）*：还没完成、但已可见的进度。每个事件都带一份 `partial` 消息快照。
> - *队列（queue）*：先来先服务的数据结构，生产者 push、消费者 shift。
> - *增量 JSON 解析*：JSON 还没收完，就尝试尽可能解析已收到的部分。

## 直觉：事件流是什么

把一次模型回复想象成一场"直播"。主播（适配器）边说边发弹幕（事件），观众（UI/主循环）边看边更新。整场直播有几个固定环节：

```text
start          → 直播开始，先给个空消息骨架
text_delta ×N  → 正文一个字一个字来
thinking_delta ×N → 思考过程（如果模型有思考）
toolcall_start → 模型决定调工具
toolcall_delta ×N → 工具参数一点一点拼
toolcall_end   → 参数拼完
done / error   → 直播结束（成功 or 失败）
```

这套"环节"就是 Pi 的 `AssistantMessageEvent` 协议，定义在 `types.ts:523-539`。

## EventStream 基类：队列式异步迭代器

`event-stream.ts:4-67` 的 `EventStream<T, R>` 是一个通用模板类。它干四件事：**存事件、等消费者、判断结束、抽取最终结果**。

### 内部字段

`event-stream.ts:5-11`：

```ts
private queue: T[] = [];                                   // 已产生、还没被消费的事件
private waiting: ((value: IteratorResult<T>) => void)[] = []; // 正在等的消费者
private done = false;                                       // 是否结束
private finalResultPromise: Promise<R>;                    // 最终结果的 Promise
private resolveFinalResult!: (result: R) => void;          // 结束时的回调
private isComplete: (event: T) => boolean;                 // 怎样算"终态"
private extractResult: (event: T) => R;                    // 终态→最终结果
```

### push：生产者塞事件

`event-stream.ts:21-36`：

```ts
push(event: T): void {
  if (this.done) return;
  if (this.isComplete(event)) {            // 是 done/error？
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));  // 兑现最终结果 Promise
  }
  const waiter = this.waiting.shift();     // 有消费者在等？
  if (waiter) waiter({ value: event, done: false });
  else this.queue.push(event);             // 否则进队列缓存
}
```

精巧之处在于"生产者/消费者速度不匹配"：适配器产得快、消费者慢，事件就堆在 `queue`；反过来消费者等的时候，新事件直接交给他（`waiting`）。这就是经典的**队列式异步迭代器**。

### end / 异步迭代

`event-stream.ts:38-62`：`end()` 标记完成并唤醒所有等待者；`Symbol.asyncIterator` 用 `while(true)` 循环从队列取或等新事件，实现 `for await...of`。

### result：拿到最终结果

`event-stream.ts:64-66`：

```ts
result(): Promise<R> {
  return this.finalResultPromise;
}
```

调用方若不在乎"直播过程"，只想等"最终消息"，就 `await stream.result()`。第 13 章讲过 Pi 主循环常用 `streamSimple(...).result()` 拿完整 `AssistantMessage`。

> **提示**
>
> `EventStream` 是**泛型**（`T` 事件类型，`R` 结果类型）。`AssistantMessageEventStream` 只是把它特化：事件 `T=AssistantMessageEvent`，结果 `R=AssistantMessage`。同一份基类还能服务图片生成流（`AssistantImages`）。

## AssistantMessageEventStream：特化的"直播协议"

`event-stream.ts:69-83` 只需告诉基类"什么叫终态、终态怎么变结果"：

```ts
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",   // 终态判定
      (event) => {
        if (event.type === "done") return event.message;            // 成功→最终消息
        else if (event.type === "error") return event.error;        // 失败→错误消息
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}
```

## 事件类型：完整清单

`types.ts:523-539` 定义了 `AssistantMessageEvent` 的全部变体：

| 事件 | 含义 | 关键字段 |
| --- | --- | --- |
| `start` | 直播开始 | `partial` |
| `text_start` | 正文块开始 | `contentIndex`, `partial` |
| `text_delta` | 正文增量 | `contentIndex`, `delta`, `partial` |
| `text_end` | 正文块结束 | `contentIndex`, `content`, `partial` |
| `thinking_start` | 思考块开始 | `contentIndex`, `partial` |
| `thinking_delta` | 思考增量 | `contentIndex`, `delta`, `partial` |
| `thinking_end` | 思考块结束 | `contentIndex`, `content`, `partial` |
| `toolcall_start` | 工具调用开始 | `contentIndex`, `partial` |
| `toolcall_delta` | 工具参数增量 | `contentIndex`, `delta`, `partial` |
| `toolcall_end` | 工具参数结束 | `contentIndex`, `toolCall`, `partial` |
| `done` | 成功结束 | `reason`, `message` |
| `error` | 失败结束 | `reason`, `error` |

### 每个事件都带 `partial` 的意义

注意几乎每个事件都带 `partial: AssistantMessage`——这是"到当前为止拼出的完整消息快照"。消费者收到任意事件，都能立刻拿到一份可显示的进度（正文已到哪、思考已到哪、工具参数拼了多少）。UI 不用等 `done` 就能渲染"打字中"的效果；主循环在 `toolcall_end` 一到就能立刻去执行工具。

> **说明**
>
> `partial` 和真正的"最终消息"是同一份对象的持续生长版——适配器每收到一个 chunk 就改 `output.content`，然后 `partial` 指向这个 `output`。`done` 时 `event.message` 就是这同一份 `output`。所以 `partial` 不是拷贝，是"活着的进度"。

## 事件序列图（一次典型"带工具调用"的回复）

```text
start
  │
  ├─ thinking_start
  │     ├─ thinking_delta ×N      （模型先想）
  │     └─ thinking_end
  │
  ├─ text_start
  │     ├─ text_delta ×N          （说出"我来查一下"）
  │     └─ text_end
  │
  ├─ toolcall_start               （决定调工具）
  │     ├─ toolcall_delta ×N      （参数一点一点拼）
  │     └─ toolcall_end           （参数完整 → 主循环去执行）
  │
  └─ done  (reason: "toolUse")    ← 终态，result() 兑现
```

若中途出错或被取消，最后一条变成 `error`（`reason: "error" | "aborted"`），`result()` 兑现的是带 `errorMessage` 的消息。

## 增量 JSON 解析：parseStreamingJson

工具参数在流里是字符串碎片，适配器每收到一片就调 `parseStreamingJson` 试着解析成对象（见第 18 章 `openai-completions.ts:538`、第 19 章 `anthropic-messages.ts:659`）。为什么需要"增量"？因为 JSON 必须完整才合法：

```text
收到第 1 片:  '{"city":"北'        → 非法 JSON（引号没闭合）
收到第 5 片:  '{"city":"北京","'    → 仍非法
收到完整:     '{"city":"北京","unit":"c"}' → 合法 ✓
```

`parseStreamingJson` 要"尽量解析已收到的部分"，哪怕还不完整也返回能解析出的内容（或空对象），绝不因为不完整就崩。

### 实现：三层兜底

`json-parse.ts:104-124`：

```ts
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
  if (!partialJson || partialJson.trim() === "") return {} as T;   // 空→空对象
  try {
    return parseJsonWithRepair<T>(partialJson);                    // 第 1 层：修完再 parse
  } catch {
    try {
      const result = partialParse(partialJson);                    // 第 2 层：partial-json 库
      return (result ?? {}) as T;
    } catch {
      try {
        const result = partialParse(repairJson(partialJson));      // 第 3 层：先修控制字符再解析
        return (result ?? {}) as T;
      } catch {
        return {} as T;                                            // 全失败→空对象（不崩）
      }
    }
  }
}
```

三层顺序：
1. `parseJsonWithRepair`（`json-parse.ts:85-95`）：先 `JSON.parse`，失败再用 `repairJson` 修常见坏 JSON 后重试；
2. `partialParse`（来自 `partial-json` 库）：专门解析"未完成 JSON"，容忍未闭合结构；
3. `repairJson` + `partialParse`：先修控制字符（见下）再解析；
4. 全失败返回 `{}`——**永不抛异常**，保证流式不中断。

### repairJson：修非法 JSON 字符串

`json-parse.ts:32-83` 处理"字符串里夹了裸控制字符或错误转义"这类 LLM 常犯的错：

- 遇到字符串内的换行/制表等控制字符，转义成 `\n`/`\t`/`\uXXXX`（`:10-25, :79`）；
- 遇到非法反斜杠转义（如 `\.`），补成 `\\.`（`:53-77`）；
- 合法 `\uXXXX` 原样保留（`:60-67`）。

> **提示**
>
> `parseStreamingJson` 和 `repairJson` 是"流式健壮性"的两道保险：模型吐出的工具参数经常有未闭合引号、未转义换行，`partial-json` 容错 + `repairJson` 兜底，让 Pi 不会因为"参数还没收完"或"模型格式小瑕疵"就解析崩溃。OpenAI 适配器（:538）和 Anthropic 适配器（:659）都依赖它。

## 把三章串起来：从适配器到事件流

```text
适配器 (openai-completions.ts / anthropic-messages.ts)
   │  每收到厂商一个 chunk
   │   ├─ 累加文本/思考 → stream.push(text_delta/thinking_delta)
   │   ├─ 累加工具参数 → parseStreamingJson(片段) → stream.push(toolcall_delta)
   │   └─ 结束 → stream.push(done/error)
   ▼
AssistantMessageEventStream (event-stream.ts)
   │  EventStream 基类用 queue/waiting 调度
   │  result() 兑现最终 AssistantMessage
   ▼
主循环 / UI
   ├─ for await (event) → 实时渲染打字
   └─ await stream.result() → 拿完整消息继续下一步（如执行工具）
```

## 自查清单

- [ ] 我知道 `EventStream` 基类在 event-stream.ts:4-67
- [ ] 我能说出它的四个职责：存事件/等消费者/判结束/抽结果
- [ ] 我看到 `push` 用 queue+waiting 处理生产消费速度差（event-stream.ts:21-36）
- [ ] 我知道 `result()` 返回最终结果的 Promise（event-stream.ts:64）
- [ ] 我知道 `AssistantMessageEventStream` 在 event-stream.ts:69-83 特化了终态判定
- [ ] 我能列出事件类型：start/text_*/thinking_*/toolcall_*/done/error（types.ts:523-539）
- [ ] 我理解每个事件带 `partial` 是为了"实时可显示进度"
- [ ] 我能画出 start→text_delta→toolcall→done 的序列
- [ ] 我知道 `parseStreamingJson` 在 json-parse.ts:104-124
- [ ] 我知道它有三层兜底且"永不抛异常"（返回 {}）
- [ ] 我理解 `repairJson`（json-parse.ts:32-83）修控制字符/错误转义
- [ ] 我知道 OpenAI/Anthropic 适配器都用 `parseStreamingJson` 解析工具参数
