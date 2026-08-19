---
title: "第 11 章 · 流式输出、SSE 与增量解析"
date: 2026-07-01
summary: "对比 WebSocket：WebSocket 是双向全双工，能来回发；SSE 是单向（服务器→客户端）、基于普通 HTTP，更简单、自带断线重连。LLM 回答这种\"服务器一直推、客户端基本只发一次提问\"的场景，SSE 刚好够用。Pi 在 `packages/ai/src/types.ts:106` 把 `Tran…"
tags:
  - pi
---
# 第 11 章 · 流式输出、SSE 与增量解析

## 11.1 为什么 LLM 要"流式"输出

你用 ChatGPT 时，答案是**一个字一个字蹦出来**的，不是憋半天一次性给整段。这背后是**流式（Streaming）**。为什么费这个劲？

- **体感延迟**：模型可能要生成几千 token，等全部生成完再显示，用户得干瞪眼十几秒。流式让第一个字在几百毫秒内就出现。
- **可打断**：用户看到跑偏可以提前停止（abort），省 token。
- **工具参数边生成边解析**：第 7 章讲过，模型产出 `tool_call` 的 `arguments` 是一段 JSON。如果这段 JSON 很长，流式可以**一边出一边试着解析**，不用等整段到齐。

> **提示 · 流式不改变"生成本质"**
>
> 模型还是一个 token 一个 token 吐，流式只是"每吐一个就立刻网上发"，而不是"攒齐了再发"。底层是同一个自回归生成，上层是传输时机不同。

## 11.2 SSE：服务器主动推消息的轻量协议

最常见的流式传输协议是 **SSE（Server-Sent Events，服务器发送事件）**。它是基于 HTTP 的单向通道：**服务器可以主动、持续地往客户端推文本**，客户端只收不发（发指令另走普通请求）。

SSE 的报文长这样（每行 `data:` 开头，空行分隔事件）：

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"choices":[{"delta":{"content":"你"}}]}

data: {"choices":[{"delta":{"content":"好"}}]}

data: {"choices":[{"delta":{"content":"，"}}]}

data: [DONE]
```

> 对比 WebSocket：WebSocket 是双向全双工，能来回发；SSE 是单向（服务器→客户端）、基于普通 HTTP，更简单、自带断线重连。LLM 回答这种"服务器一直推、客户端基本只发一次提问"的场景，SSE 刚好够用。Pi 在 `packages/ai/src/types.ts:106` 把 `Transport` 定义为 `"sse" | "websocket" | "websocket-cached" | "auto"`，可见 SSE 是其支持的传输之一。

## 11.3 增量 token 如何边生成边显示

流式的最小单元就是"增量（delta）"：每次服务器推一小块新文本，客户端把它**追加**到已显示内容后面。伪代码：

```text
显示缓冲 = ""
收到 data: {"delta":{"content":"你"}}  → 显示缓冲 += "你" → 屏幕显示 "你"
收到 data: {"delta":{"content":"好"}}  → 显示缓冲 += "好" → 屏幕显示 "你好"
收到 data: {"delta":{"content":"，"}}  → 显示缓冲 += "，" → 屏幕显示 "你好，"
...
收到 [DONE]                            → 结束
```

这就是"打字机效果"的实现原理——没有任何魔法，就是不断 append。

## 11.4 半成品 JSON 如何增量解析

难点来了：工具的 `arguments` 是一段 JSON，而这段 JSON 是**流式吐出**的。你可能在 JSON 还没闭合时就收到前半截：

```text
第 1 个 chunk: {"city": "北
第 2 个 chunk: 京"}
```

这是个**不完整的 JSON**，直接 `JSON.parse` 会报错。怎么办？Pi 在 `packages/ai/src/utils/json-parse.ts:104` 提供 `parseStreamingJson`，专门处理这种"可能残缺"的 JSON：

```ts
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
  if (!partialJson || partialJson.trim() === "") {
    return {} as T;
  }
  try {
    return parseJsonWithRepair<T>(partialJson);   // 先尝试修复后标准解析
  } catch {
    try {
      const result = partialParse(partialJson);    // 再尝试 partial-json 容错解析
      return (result ?? {}) as T;
    } catch {
      try {
        const result = partialParse(repairJson(partialJson)); // 修复后再容错
        return (result ?? {}) as T;
      } catch {
        return {} as T;                            // 实在不行返回空对象，不崩
      }
    }
  }
}
```

它的策略是**层层兜底**：标准解析 → 修复控制字符后解析 → `partial-json` 库容错解析（允许未闭合结构）→ 修复后再容错 → 实在不行返回 `{}`。也就是说，即使 JSON 还是半成品，也能尽量取出已完整的部分（如已收到的 `"city": "北` 里的 key），让 UI 能提前预览工具参数。

> `repairJson`（`json-parse.ts:32`）负责把字符串里裸控制字符转义、把非法反斜杠补齐，避免模型吐出的"脏 JSON"直接炸掉解析。

> **说明 · Pi 在流式里怎么用 parseStreamingJson**
>
> 在 `packages/ai/src/api/openai-completions.ts:538`，每收到一个 `tool_calls[].function.arguments` 的 delta，就拼到 `block.partialArgs` 上，并立刻 `block.arguments = parseStreamingJson(block.partialArgs)`。所以 `ToolCall.arguments` 在流式过程中是"渐进填充"的——这也解释了为什么第 7 章说 `arguments` 已经是解析好的对象。

## 11.5 Pi 的事件流：AssistantMessageEvent

Pi 没有把"原始 SSE 块"直接丢给上层，而是先**归一化成一套事件协议 `AssistantMessageEvent`**（`packages/ai/src/types.ts:523`）。这样不管底层是 OpenAI、Anthropic 还是 Google，上层都收到同一套事件：

```ts
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: ...; message: AssistantMessage }
  | { type: "error"; reason: ...; error: AssistantMessage };
```

观察命名规律：`*_start` 开场、`*_delta` 增量、`*_end` 收尾，分别覆盖 text / thinking / toolcall 三类内容。每次事件都带一个 `partial: AssistantMessage`——即"到目前为止累积出的完整消息快照"。上层想显示进度，读 `delta` 即可；想要全量，读 `partial` 即可。

## 11.6 事件流的实现骨架

承载这些事件的是 `AssistantMessageEventStream`（`packages/ai/src/utils/event-stream.ts:69`），它继承自通用 `EventStream<T, R>`（`:4`）。`EventStream` 是个**可异步遍历的队列**：生产者 `push(event)` 塞事件，消费者用 `for await ... of stream` 取事件；遇到 `done` 或 `error` 事件就判定结束并产出最终 `AssistantMessage`。

```ts
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",  // 完成判定
      (event) => (event.type === "done" ? event.message            // 提取最终结果
                  : event.type === "error" ? event.error : ...),
    );
  }
}
```

## 11.7 一张"模型 → SSE → 逐事件 → UI"的流图

把前面串起来：

```text
┌──────────┐   HTTP 流(SSE)   ┌──────────────────┐   归一化    ┌──────────────────────┐   订阅   ┌────────┐
│  LLM 服务 │ ──data:块──────▶ │  Provider 适配层  │ ──事件───▶ │ AssistantMessageEvent │ ──────▶ │  UI   │
│  (吐token)│                  │ (openai-completions│ │  Stream  │                      │         │ 打字机│
└──────────┘                  └──────────────────┘            └──────────────────────┘         └────────┘
     │                                  │                              │
     │ 1. 吐 text_delta                 │ 2. 转成                       │ 3. 上层 for await
     │ 2. 吐 tool_calls.arguments 碎片   │    text_delta /               │    收到 *_delta 就 append
     │                                  │    toolcall_delta 事件         │    收到 done 就结束
     │                                  │ 4. 调 parseStreamingJson      │
     │                                  │    渐进填 ToolCall.arguments   │
```

> **提示 · 为什么 Pi 要"再包一层事件流"**
>
> 直接暴露各家原始 SSE 块，上层就得为每个供应商写一套解析。Pi 用 `AssistantMessageEvent` 把差异吞掉：上层只认一套事件，换模型/换供应商不用改 UI。这也是 `packages/ai` "统一多供应商 API" 的体现（呼应第 8.7、10.5 节的解耦思想）。

## 11.8 中止（abort）与 error 事件

流式不是"一发不回"。用户可能中途点停止，或网络/供应商出错。Pi 的事件协议为此准备了两种终结事件（`types.ts:539`）：

- **`error`**：流异常结束，`reason` 为 `"aborted"` 或 `"error"`，携带最终的 `AssistantMessage`（含 `errorMessage`）。`aborted` 通常是用户/代码主动取消（传入 `AbortSignal`），`error` 是供应商或运行时真的炸了。
- **`done`**：正常结束，`reason` 为 `"stop" | "length" | "toolUse" | "deferred"`。

```text
正常：start → ...delta... → done(stop)
取消：start → ...delta... → error(aborted)   ← 用户点了停止
失败：start → ...delta... → error(error)      ← 供应商 500
```

> **提示 · 为什么要区分 aborted / error**
>
> UI 体验不同：被取消可以"保留已生成的部分、提示已停止"；真正报错应"提示失败、可能要重试"。`AssistantMessageEvent` 把 `stopReason` 细细拆开（`types.ts:393`），就是让上层能按状态做对的事，而不是一刀切。

## 11.9 背压（Backpressure）：消费者别被冲垮

模型可能吐得很快，而你的 UI 渲染慢。如果生产者（供应商）一股脑推、消费者（UI）来不及处理，中间队列会爆。流式的正确姿态是**背压**：消费者处理完一个事件，才向生产者要下一个。`EventStream`（`event-stream.ts:4`）的设计正是如此——它内部维护 `queue` 和 `waiting` 两个结构：消费者没空时事件进队列，消费者空了就从队列取，二者通过 Promise 协调，天然实现了"生产—消费"的节奏匹配，不会无脑堆积。

## 11.10 thinking delta：让"思考"也可见

不只是最终文本能流式。支持推理的模型（如带 `thinking` 的供应商）会把**思考过程**也当一种内容块流式吐出。Pi 的事件协议里有专门的 `thinking_start` / `thinking_delta` / `thinking_end`（`types.ts:528`），和 `text_*` 平行。这样 UI 能边显示"模型在想什么"，边等"最终答什么"，用户体验更透明。

```text
事件顺序示例：
  text_start    → "我先看看报错"
  text_delta ×N → 逐字补"我先看看报错"
  text_end
  thinking_start → （模型内部推理开始）
  thinking_delta ×N → 逐字显示推理过程
  thinking_end
  toolcall_start → 决定调 read_file
  toolcall_delta ×N → 参数 JSON 边出边解析（见 11.4 节）
  toolcall_end
```

> **说明 · 把三种内容当成"并列轨道"**
>
> text / thinking / toolcall 在 `AssistantMessageEvent` 里是**三条平行的内容轨道**，各有一套 start/delta/end。`contentIndex` 标的是"这是第几个内容块"，避免不同轨道、不同块的事件串味。理解这点，你就能正确驱动任何流式 UI。

## 11.11 客户端如何消费事件流（伪代码直觉）

上层 UI 拿到 `AssistantMessageEventStream` 后，典型用法是一个 `for await` 循环，逐个事件处理：

```text
for event of stream:                      // 异步遍历事件
  switch event.type:
    case "text_delta":     把 event.delta 追加到文本框
    case "thinking_delta": 把 event.delta 追加到"思考"折叠区
    case "toolcall_delta": 用 parseStreamingJson 更新"待调用工具"预览
    case "toolcall_end":   显示"即将调用 X(args)"
    case "error":          提示失败 / 已取消
    case "done":           收尾，启用输入框
finalMessage = await stream.result()      // 拿最终完整 AssistantMessage
```

注意两个出口：循环里用 `event.delta` 做**实时 UI**，`stream.result()` 拿**最终全量消息**做持久化/下一步逻辑。两者互补，不用二选一。

## 11.12 调试流式：看原始块还是看事件

排错时两层视角都该会：

- **看原始 SSE 块**：确认供应商真在推、字段名对不对（如 OpenAI 的 `choices[].delta`，Anthropic 的 `content_block_delta`）。问题常在"映射层把某家字段认错"。
- **看 Pi 事件**：确认 `parseStreamingJson` / 事件归一化有没有把 delta 正确累计进 `partial`。问题常在"增量拼接/解析"环节。

```text
排错路径：
  模型没输出？ ──▶ 看原始块：供应商到底推了没
  输出断断续续？ ─▶ 看事件：delta 有没有漏、partial 对不对
  工具参数解析错？─▶ 看 parseStreamingJson：半成品 JSON 容错是否生效
```

> **提示 · 流式调试的黄金法则**
>
> 永远先确认"上游给了什么"（原始块），再确认"中间怎么变的"（事件/partial）。跳步直接看 UI，往往分不清是供应商的锅还是自己映射层的锅。Pi 把映射收敛到 `packages/ai/src/api/*` 几个适配文件，定位问题比散落各处更轻松。

## 11.13 本章关键点回顾

- 流式是为降延迟、可打断、可增量解析工具参数。
- SSE 是服务器单向推文本的轻量 HTTP 协议；与 WebSocket 区别在双向 vs 单向。
- 增量 token 就是不断 append 到显示缓冲。
- 半成品 JSON 用 `parseStreamingJson`（`json-parse.ts:104`）容错解析，让工具参数边出边可用。
- Pi 用 `AssistantMessageEvent`（`types.ts:523`）统一各家事件，上层只订阅一套。

## 11.14 流式一句话收尾

把全章收成一句可带走的话：

> **流式 = 把"攒齐再发"改成"边出边发"；SSE 是服务器单向推的轻量管道；Pi 再用统一事件流把各家差异吞掉，让 UI 只认一套 `AssistantMessageEvent`。**

记住三个层次：最底是供应商的原始 SSE 块，中间是 Pi 的归一化事件（`text_*`/`thinking_*`/`toolcall_*` 三轨道），最上是你的 UI 做实时 append。排错先证"上游给了什么"，再看"中间怎么变的"。这层解耦，正是 `packages/ai` "统一多供应商 API" 的设计红利。

## 自查清单

- [ ] 我能说出流式输出的三个好处（降延迟/可打断/增量解析参数）。
- [ ] 我能口述 SSE 报文长什么样（`data:` 行 + 空行）。
- [ ] 我能区分 SSE（单向）和 WebSocket（双向）的适用差异。
- [ ] 我知道"半成品 JSON"为什么不能直接 parse，以及 Pi 用哪个函数兜底（parseStreamingJson）。
- [ ] 我能说出 parseStreamingJson 的兜底层级（标准→修复→partial→修复后partial→空对象）。
- [ ] 我能列出 AssistantMessageEvent 里 text/toolcall 各自的 start/delta/end 事件名。
- [ ] 我理解 Pi 为什么要在原始 SSE 之上再包一层统一事件流（解耦供应商）。
