---
title: "第 19 章 · 适配器模式：anthropic-messages 解剖"
date: 2026-07-01
summary: "上一章我们拆了\"OpenAI 兼容\"适配器——它把 SSE 解析甩给了官方 SDK，自己只做翻译。本章看另一类：**Anthropic 的 `messages` 接口**（`packages/ai/src/api/anthropic-messages.ts`，约 1350 行）。它不兼容 OpenAI 协议，所以…"
tags:
  - pi
---
# 第 19 章 · 适配器模式：anthropic-messages 解剖

上一章我们拆了"OpenAI 兼容"适配器——它把 SSE 解析甩给了官方 SDK，自己只做翻译。本章看另一类：**Anthropic 的 `messages` 接口**（`packages/ai/src/api/anthropic-messages.ts`，约 1350 行）。它不兼容 OpenAI 协议，所以 Pi 必须写自己的适配器，而且连 SSE 都要自己解析。

这一章你会看到 Anthropic 的三个"特产"：**thinking 块带加密签名**、**cache_control 缓存打点**、以及**错误编码在流里**。最后我们会把两张适配器放一起对比。

> **说明**
>
> **黑话速查**
> - *content_block*：Anthropic 把回复拆成"内容块"，每块带 `type`（`text`/`thinking`/`tool_use`/`redacted_thinking`）。
> - *signature（签名）*：thinking 块的加密签名，回传可续上推理上下文，但明文看不到。
> - *cache_control*：打在请求某段上的标记，告诉 Anthropic"这段请缓存"，下次命中可省钱（第 12 章讲过 prompt cache）。
> - *beta header*：Anthropic 把实验功能放在 `anthropic-beta` 请求头里开启。

## 直觉：为什么 Anthropic 适配器更"重"

OpenAI 给的是标准 `chat.completions`，SDK 帮你解析。Anthropic 给的是自己的 `messages` 接口，事件名、字段结构都不同：

- 思考叫 `thinking` 块 + `signature`，不是 OpenAI 的 `reasoning_content`；
- 工具参数增量叫 `input_json_delta`，不是 `tool_calls[].function.arguments`；
- 它用 `message_start`/`content_block_start`/`content_block_delta`/`message_stop` 一整套事件。

所以 Pi 的 Anthropic 适配器做了"全栈"工作：自建客户端、组 Anthropic 风格参数、发请求、手写 SSE 解析、翻译事件。这正好和第 18 章形成对照。

## 入口与生命周期：`stream` 函数

`anthropic-messages.ts:487` 的 `stream` 同样返回 `AssistantMessageEventStream`。它的生命周期可分成五步：

```text
1. 建客户端   createClient(...)            anthropic-messages.ts:536
2. 组参数     buildParams(model,...)        anthropic-messages.ts:549
3. 发请求     client.messages.create(       anthropic-messages.ts:560
                { ...params, stream:true }, requestOptions).asResponse()
4. 消费 SSE   iterateAnthropicEvents(...)   anthropic-messages.ts:573
5. 收尾       stream.push(done/error)       anthropic-messages.ts:758-769
```

### 第 1 步：建客户端

`anthropic-messages.ts:514-548` 建一个 `Anthropic` 客户端。如果调用方已传入 `options.client` 就直接用（`anthropic-messages.ts:517-519`），否则用 `createClient`（`anthropic-messages.ts:536`，实现见 `anthropic-messages.ts:856-936`）——里面会处理 OAuth token、GitHub Copilot 动态头、缓存 session 等。注意这里允许注入自定义 SDK 客户端（`anthropic-messages.ts:261` 的 `client?` 选项），方便接替代理或企业网关。

### 第 2 步：组参数 `buildParams`

`buildParams` 定义在 `anthropic-messages.ts:939`，把 Pi 的 `Context` 拼成 Anthropic 的 `messages.create` 参数。它要处理：系统提示、消息序列、工具定义、思考模式、缓存打点。思考模式的三种配置在 `anthropic-messages.ts:1027-1054`：

```ts
if (options?.thinkingEnabled) {
  if (/* 自适应思考模型 */) {
    params.thinking = { type: "adaptive", display };   // anthropic-messages.ts:1035
  } else {
    params.thinking = { type: "enabled", budget_tokens: ... }; // 预算式，1030 起
  }
}
```

### 第 3 步：发请求——关键差异 `.asResponse()`

`anthropic-messages.ts:559-560`：

```ts
const response = await retryProviderRequest(
  () => client.messages.create({ ...params, stream: true }, requestOptions).asResponse(),
  { ... },
);
```

注意 `.asResponse()`：它拿的是**原始 HTTP `Response`**（含 body 字节流），而不是 SDK 已经解析好的事件流。这意味着"从这一刻起，SSE 解析是 Pi 自己干的"，不像 OpenAI 适配器交给 SDK。这是两张适配器最本质的分歧点。

### 第 4 步：自建 SSE 解析 `iterateAnthropicEvents`

`anthropic-messages.ts:446-485` 是手写 SSE 事件生成器。它先调 `iterateSseMessages`（`anthropic-messages.ts:420` 一带）按行切分 SSE 帧，再把每行 `data:` 用 `parseJsonWithRepair` 解析成 Anthropic 事件：

```ts
for await (const sse of iterateSseMessages(response.body, signal)) {
  if (sse.event === "error") {
    throw new Error(sse.data);              // anthropic-messages.ts:458
  }
  if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) continue;
  const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
  yield event;
}
```

> **提示**
>
> 为什么 Anthropic 要自己写 SSE 解析？因为 Pi 想在解析层做两件事 SDK 不替它做的：(1) 用 `parseJsonWithRepair` 容错坏 JSON（见第 21 章 `json-parse.ts`）；(2) 统一把"流里报错"转成异常或事件。第 18 章的 OpenAI 适配器因为信任官方 SDK，省了这层。

拿到结构化事件后，`stream` 在 `anthropic-messages.ts:573` 用 `for await (const event of iterateAnthropicEvents(...))` 逐个翻译。

### Anthropic 特产 1：thinking 块与 signature

当事件类型是 `content_block_start` 且块为 `thinking`（`anthropic-messages.ts:596-604`）：

```ts
const block = {
  type: "thinking",
  thinking: event.content_block.thinking ?? "",
  thinkingSignature: event.content_block.signature ?? "",  // 加密签名
  index: event.index,
};
```

thinking 的签名会随 delta 持续追加——`signature_delta` 事件在 `anthropic-messages.ts:667-673`：

```ts
} else if (event.delta.type === "signature_delta") {
  if (block && block.type === "thinking") {
    block.thinkingSignature = block.thinkingSignature || "";
    block.thinkingSignature += event.delta.signature;
  }
}
```

还有 `redacted_thinking`（被安全过滤、明文不可见）块：`anthropic-messages.ts:605-614` 把它存成 `thinking: "[Reasoning redacted]"` + `thinkingSignature: data` + `redacted: true`。这套"加密签名"机制正是第 16 章 `ThinkingContent.redacted` 字段的来源；第 20 章会看到跨模型重放时怎么处理它。

### Anthropic 特产 2：cache_control 打点位置

Anthropic 的 prompt cache 靠在请求体上打 `cache_control` 标记实现。`buildParams` 在多处打点：

| 打点位置 | 代码 | 含义 |
| --- | --- | --- |
| 系统提示 | anthropic-messages.ts:981 | 缓存系统提示 |
| 工具定义末项 | anthropic-messages.ts:1321 | 缓存最后一条工具定义 |
| 最后一条用户/助手/工具结果文本 | anthropic-messages.ts:988, 997, 1256-1273 | 缓存对话历史尾部 |

例如 `anthropic-messages.ts:1256` 注释写明"把 cache_control 加到最后一条 user 消息以缓存对话历史"，`anthropic-messages.ts:1273` 实际写入 `cache_control: cacheControl`。这些打点位置由 `compat.cacheControlFormat`（types.ts:595）和 `supportsLongCacheRetention`（types.ts:637）等开关控制——和第 18 章的 `compat` 思路一致，只是换成 Anthropic 方言。

### Anthropic 特产 3：错误编码在流里

Anthropic 适配器同样遵守"失败进流不抛出"的契约。SSE 里若出现 `error` 事件，在 `iterateAnthropicEvents` 一处（`anthropic-messages.ts:458`）直接 `throw`；这个异常被外层 `try/catch`（`anthropic-messages.ts:760-769`）接住并翻译成 `error` 事件：

```ts
} catch (error) {
  for (const block of output.content) {
    delete (block as { index?: number }).index;       // 清理流式临时字段
    delete (block as { partialJson?: string }).partialJson;
  }
  output.stopReason = options?.signal?.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  stream.push({ type: "error", reason: output.stopReason, error: output });  // anthropic-messages.ts:768
  stream.end();
}
```

注意它先清理了流式专用的临时字段 `index` / `partialJson`——这些只是解析时的草稿，绝不能持久化。这与 OpenAI 适配器清理 `partialArgs`/`customInput` 的做法异曲同工（openai-completions.ts:592-598）。

### 第 5 步：收尾与 usage

`message_start` 事件（`anthropic-messages.ts:574-586`）就抓取输入 token、缓存读写 token，并用 `calculateCost` 立刻算钱。Anthropic 不返回 `total_tokens`，所以 `anthropic-messages.ts:584-585` 自己把各分量加出来。流正常结束推 `done`（`anthropic-messages.ts:758`）。

## 两张适配器对比表

| 维度 | OpenAI 兼容（第 18 章） | Anthropic（本章） |
| --- | --- | --- |
| 文件 | openai-completions.ts | anthropic-messages.ts |
| 入口 | `stream` openai-completions.ts:201 | `stream` anthropic-messages.ts:487 |
| SSE 解析 | 委托官方 SDK | 自写 `iterateAnthropicEvents`（:446） |
| 发请求方式 | `client.chat.completions.create(...).withResponse()`（:248） | `client.messages.create(...).asResponse()`（:560） |
| 思考字段 | `reasoning_content`/`reasoning`/`reasoning_text` | `thinking` 块 + `signature` |
| 思考加密 | 无 | `thinkingSignature`/`redacted_thinking`（:605） |
| 工具参数增量 | `tool_calls[].function.arguments`（:535） | `input_json_delta` + `partialJson`（:654-659） |
| 缓存机制 | 由 `compat` 开关隐式影响 | 显式 `cache_control` 打点（:981/1321/1273） |
| 停止原因 | `mapStopReason`（:1413）统一 7 值 | 内部 `mapStopReason`（:1329）映射 |
| 失败处理 | `error` 事件（:609） | `error` 事件（:768） |
| 覆盖厂商数 | 40+（靠 compat 开关） | 仅 Anthropic 系 |

> **说明**
>
> 共同点：**两者都返回 `AssistantMessageEventStream`、都遵守"失败进流不抛出"、都把工具参数当"半成品 JSON"增量解析**。这正是适配器模式的回报——上层业务完全感知不到底下是 OpenAI 还是 Anthropic。

## 为什么值得单独写一份适配器

Anthropic 协议和 OpenAI 差异足够大（事件名、思考加密、缓存打点方式都不同），复用 OpenAI 适配器不现实。但 Pi 用同一套 `ProviderStreams` 契约（`stream`/`streamSimple`）把它包成了"可替换零件"——`createProvider` 只看 `api` 字段决定调哪个适配器（第 17 章 `models.ts:779` 的 `apiFor`）。于是新增 Anthropic 系厂商，也只是在 `providers/` 下再加一个薄工厂 + 一份 JSON，逻辑全在 `anthropic-messages.ts` 这一份里。

## 自查清单

- [ ] 我知道 Anthropic 适配器约 1350 行，比 OpenAI 重（因为协议不同）
- [ ] 我看到 `stream` 入口在 anthropic-messages.ts:487
- [ ] 我知道它发请求用 `.asResponse()` 拿原始 Response（:560），自己解析 SSE
- [ ] 我理解 `iterateAnthropicEvents`（:446）是手写 SSE 解析器
- [ ] 我知道 thinking 块带 `thinkingSignature`，由 `signature_delta` 追加（:600/667）
- [ ] 我知道 `redacted_thinking` 块存成 `redacted: true`（:605-614）
- [ ] 我能在代码里指出 cache_control 的打点位置（:981/1321/1273）
- [ ] 我知道 Anthropic 的 usage 在 `message_start` 抓取并自算 total（:574-586）
- [ ] 我看到错误在 `catch` 里翻译成 `error` 事件（:760-769）
- [ ] 我能说出两张适配器在"SSE 解析"上的本质分歧
- [ ] 我知道两者都返回 `AssistantMessageEventStream`、都用半成品 JSON 解析工具参数
