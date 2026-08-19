---
title: "第 18 章 · 适配器模式：openai-completions 解剖"
date: 2026-07-01
summary: "上一章我们看到 DeepSeek 只写了 15 行工厂，就靠 `openAICompletionsApi()` 复用了一个\"OpenAI 兼容适配器\"。本章我们就钻进这个适配器：`packages/ai/src/api/openai-completions.ts`（约 1600 行），看它到底把\"厂商协议\"翻译成…"
tags:
  - pi
---
# 第 18 章 · 适配器模式：openai-completions 解剖

上一章我们看到 DeepSeek 只写了 15 行工厂，就靠 `openAICompletionsApi()` 复用了一个"OpenAI 兼容适配器"。本章我们就钻进这个适配器：`packages/ai/src/api/openai-completions.ts`（约 1600 行），看它到底把"厂商协议"翻译成了什么"统一事件流"。

**适配器模式（Adapter Pattern）**的精髓一句话：让两个接口不一样的对象能一起工作。Pi 的 `openAICompletionsApi` 就是适配器——左边对接 OpenAI 及其几十个兼容厂商的"方言协议"，右边输出 Pi 统一的 `AssistantMessageEventStream`（第 21 章细讲）。上层业务永远只看右边。

> **说明**
>
> **黑话速查**
> - *适配器（Adapter）*：把 A 接口翻译成 B 接口的转换器。这里把厂商 SSE 流翻译成 Pi 事件流。
> - *SSE（Server-Sent Events）*：服务端单向推送，用 `data:` 行持续发 JSON 片段，是流式 LLM 的主流传输方式（第 11 章讲过）。
> - *ChatCompletionChunk*：OpenAI 流式返回的每一个小块，含 `choices[].delta`。
> - *finish_reason*：OpenAI 告诉"为什么停"的字段（`stop`/`length`/`tool_calls` 等）。
> - *compat.thinkingFormat*：一个开关，决定"思考参数"用哪种方言拼进请求体。

## 直觉：适配器在整条链路的位置

Pi 主循环要发一条消息，链路是：

```text
主循环 ──stream(model,context,options)──▶ Provider.stream
        （统一接口）            │
                                ▼
                        openAICompletionsApi.stream   ◀── 本章主角（适配器）
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
        组请求体          调 OpenAI SDK        翻译每个 chunk
     (buildParams)      (client.chat.        → Pi 事件
                          completions.create)
```

适配器做三件事：**组请求**（把 Pi 的 `Context` 拼成 OpenAI 格式）、**发请求**（交给 OpenAI 官方 SDK）、**翻响应**（把 SDK 给的 `ChatCompletionChunk` 翻译成 Pi 的 `text_delta`/`toolcall_delta` 等事件）。

## 入口：`stream` 函数

主入口是 `openai-completions.ts:201` 的 `stream`：

```ts
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
  model, context, options?,
): AssistantMessageEventStream => { ... }
```

它第一件事（`openai-completions.ts:206-225`）先 `new AssistantMessageEventStream()`，并准备一个空的 `output: AssistantMessage`（初始 `stopReason: "pending"`）。随后在 `(async () => {...})()` 里跑真正逻辑，最后 `return stream`（`openai-completions.ts:590` 之后）。

> **提示**
>
> 注意返回类型 `AssistantMessageEventStream`——调用方拿到的不是"最终结果"，而是一个**事件流**。模型边生成边吐事件，UI 能实时显示打字效果。这是 Pi 流式体验的基础。详见第 21 章。

## 第一步：组请求体 `buildParams`

适配器先把 Pi 的 `Context`（系统提示、消息、工具）翻译成 OpenAI 的 `chat.completions` 请求体。真正发请求在 `openai-completions.ts:237`：

```ts
let params = buildParams(model, context, options, compat, cacheRetention, grammarToolInputProperties);
```

`buildParams` 里最精彩的是**思考参数方言分发**（`openai-completions.ts:749-833`）。同一份"让模型思考"的意图，不同厂商要的字段名完全不同：

| `thinkingFormat` | 拼进请求体的字段 | 定义位置 |
| --- | --- | --- |
| `deepseek` | `thinking: {type:"enabled"}` + `reasoning_effort` | openai-completions.ts:797-806 |
| `openrouter` | `reasoning: { effort }` | openai-completions.ts:807-816 |
| `qwen` | `enable_thinking` + `reasoning_effort` | openai-completions.ts:762-769 |
| `together` | `reasoning: { enabled }` + `reasoning_effort` | openai-completions.ts:822-830 |
| `zai` | `thinking: {type:"enabled"}` + `reasoning_effort` | openai-completions.ts:749-761 |
| `ant-ling` | `reasoning: { effort }` | openai-completions.ts:817-821 |
| `chat-template` / `baseten` | `chat_template_kwargs` / `chat_template_args` | openai-completions.ts:770-796 |

看 DeepSeek 这段（`openai-completions.ts:797-806`）：

```ts
} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
  if (options?.reasoningEffort) {
    (params as any).thinking = { type: "enabled" };
  } else if (model.thinkingLevelMap?.off !== null) {
    (params as any).thinking = { type: "disabled" };
  }
  if (options?.reasoningEffort && compat.supportsReasoningEffort) {
    (params as any).reasoning_effort =
      model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
  }
}
```

这正对应第 17 章 JSON 里 DeepSeek 的 `"thinkingFormat": "deepseek"` 与 `thinkingLevelMap.high="high"`——适配器读取这些开关，把 Pi 统一的 `reasoning` 档位翻译成 DeepSeek 认识的 `thinking`/`reasoning_effort`。

### 方言自动探测：detectCompat

如果模型没显式写 `compat`，适配器会用 `detectCompat`（`openai-completions.ts:1444`）从 `provider` 名和 `baseUrl` 推断。例如 `openai-completions.ts:1461`：

```ts
const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
```

这保证了"连 URL 长得像 DeepSeek"的自定义端点也能被正确识别。开关全集定义在 `types.ts:545-605`（`OpenAICompletionsCompat`），含 `supportsStore`/`supportsDeveloperRole`/`requiresToolResultName`/`requiresAssistantAfterToolResult` 等几十个。

## 第二步：发请求（交给 OpenAI 官方 SDK）

`openai-completions.ts:247-254` 真正发起调用：

```ts
const { data: openaiStream, response } = await retryProviderRequest(
  () => client.chat.completions.create(params, requestOptions).withResponse(),
  { maxRetries: options?.maxRetries, ... },
);
```

关键点：**这里用的是 OpenAI 官方 TypeScript SDK**（`client.chat.completions.create`）。SDK 内部已经帮你把 HTTP SSE 解析成了 `ChatCompletionChunk` 对象流。

> **说明**
>
> 所以严格说，`openai-completions.ts` 自己**不写 SSE 解析器**——它把"拆 SSE 帧"这件脏活委托给了官方 SDK。适配器真正的价值在"第三步"：把 SDK 给的结构化 chunk 翻译成 Pi 的统一事件。这和第 19 章的 Anthropic 适配器形成鲜明对比（Anthropic 那边是 `.asResponse()` 拿到原始 `Response`，自己手写 SSE 解析）。

## 第三步：翻译 chunk → Pi 事件

拿到 `openaiStream` 后，适配器进入 `for await (const chunk of openaiStream)`（`openai-completions.ts:441`），逐个 chunk 翻译。

### 文本增量

`openai-completions.ts:473-487`：当 `choice.delta.content` 有内容，累加进 `textBlock` 并推 `text_delta` 事件：

```ts
block.text += choice.delta.content;
stream.push({ type: "text_delta", contentIndex: ..., delta: choice.delta.content, partial: output });
```

### 思考增量（多字段容错）

不同厂商把"思考内容"放在不同字段名。适配器用一个候选列表兜底（`openai-completions.ts:493-520`）：

```ts
const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
```

先试 `reasoning_content`（DeepSeek/llama.cpp 用），再试 `reasoning`、`reasoning_text`——避免重复。命中后推 `thinking_delta` 事件。这正是 DeepSeek 兼容 OpenAI 却在思考字段上"略有不同"时的兼容处理。

### 工具调用增量（半成品 JSON）

`openai-completions.ts:522-549` 处理 `choice.delta.tool_calls`。每个工具调用按 `index` 归并到同一块，参数片段累加进 `partialArgs`，并立刻用 `parseStreamingJson` 解析成"半成品"对象：

```ts
block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
block.arguments = parseStreamingJson(block.partialArgs);   // 第 21 章细讲
stream.push({ type: "toolcall_delta", contentIndex: ..., delta, partial: output });
```

注意：工具参数在流里是**一点一点拼出来的字符串**，每收到一点就尝试解析一次（可能解析失败，返回空对象，等下次有更多字符再试）。这就是"增量 JSON 解析"——第 21 章主角。

### 停止原因：mapStopReason

流结束时，OpenAI 用 `choice.finish_reason` 表示为什么停。适配器在 `openai-completions.ts:463-471` 读取，并统一翻译成 Pi 的 `StopReason`：

```ts
function mapStopReason(reason): { stopReason: StopReason; errorMessage?: string }
```

定义在 `openai-completions.ts:1413-1437`，映射表：

| OpenAI `finish_reason` | Pi `stopReason` | 出处 |
| --- | --- | --- |
| `stop` / `end` | `stop` | openai-completions.ts:1419-1421 |
| `length` | `length` | openai-completions.ts:1422-1423 |
| `function_call` / `tool_calls` | `toolUse` | openai-completions.ts:1424-1426 |
| `content_filter` | `error`（带消息） | openai-completions.ts:1427-1428 |
| `network_error` | `error`（带消息） | openai-completions.ts:1429-1430 |
| 其它未知 | `error` | openai-completions.ts:1431-1435 |

若厂商不报 `finish_reason`（`supportsFinishReason=false`），适配器兜底推断（`openai-completions.ts:579-581`）：内容里有工具调用就当 `toolUse`，否则当 `stop`。

## 收尾：done / error 两种终态

成功时在 `openai-completions.ts:589-590` 推 `done` 事件并 `stream.end()`；出错时（包括被 `AbortSignal` 取消）在 `openai-completions.ts:591-610` 把 `stopReason` 设为 `aborted` 或 `error`，推 `error` 事件。**所有失败都编码在流里，不向外抛异常**——这是 Pi 的硬性契约（types.ts:316-324 注释写明了）。

## 为什么 OpenAI 兼容能覆盖 40+ 厂商

答案藏在 `compat` 这套开关里。一个 `openAICompletionsApi` 适配器，靠一份"方言配置"就服务了 DeepSeek、OpenRouter、Qwen、Together、Z.ai、Groq、Cerebras、NVIDIA、Moonshot、MiniMax……几十家。它们协议骨架相同（都是 `chat.completions` + SSE），差异只是：

- 思考参数叫 `thinking` 还是 `reasoning.effort`（由 `thinkingFormat` 决定）；
- 是否支持 `store`/`developer` 角色/`strict`（由 `supportsXxx` 决定）；
- 字段细节（由 `requiresToolResultName` 等决定）。

这些差异全部被收敛成一个 `compat` 对象，而不是复制几十份适配器代码。

```text
厂商响应 (ChatCompletionChunk)
        │  (OpenAI SDK 已解析 SSE)
        ▼
  openai-completions.ts 适配器
        │  buildParams: 用 compat 组方言请求体
        │  for chunk: 翻译 content/reasoning/tool_calls
        │  mapStopReason: 统一停止原因
        ▼
  统一事件流 (AssistantMessageEventStream)
   start → text_delta* → thinking_delta* → toolcall_delta* → done/error
```

> **提示**
>
> 思考题：既然 OpenAI 兼容厂商这么多，为什么 Pi 不彻底"一刀切"？因为 `compat` 里那些 `supportsXxx` 默认值往往是"按 URL 自动探测"（见 `types.ts:546-604` 注释里的 "auto-detected from URL"）。探测失败或厂商偷偷改接口时，仍可在 JSON 目录里显式覆盖——第 17 章 DeepSeek 的 `supportsStore:false` 就是这种显式覆盖。

## 自查清单

- [ ] 我知道适配器模式把"厂商协议"翻译成"统一事件流"
- [ ] 我能说出 `stream` 入口在 openai-completions.ts:201
- [ ] 我知道请求体由 `buildParams` 组装（openai-completions.ts:237）
- [ ] 我理解 `thinkingFormat` 决定思考参数用哪种方言（openai-completions.ts:749-833）
- [ ] 我看到 DeepSeek 分支知道它用 `thinking`+`reasoning_effort`（openai-completions.ts:797）
- [ ] 我知道本适配器把 SSE 解析委托给 OpenAI 官方 SDK，自己不写解析器
- [ ] 我知道思考字段用 `reasoning_content`/`reasoning`/`reasoning_text` 兜底（openai-completions.ts:493）
- [ ] 我知道工具参数在流里是"半成品 JSON"，每片都尝试解析（openai-completions.ts:538）
- [ ] 我能背出 `mapStopReason` 把 `tool_calls` 翻成 `toolUse`（openai-completions.ts:1426）
- [ ] 我理解 `compat` 开关是"一个适配器覆盖 40+ 厂商"的关键
- [ ] 我知道失败编码在 `error` 事件里而非抛出异常（types.ts:316-324）
