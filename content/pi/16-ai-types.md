---
title: "第 16 章 · 类型系统 types.ts（消息 / 内容块 / 模型 / 选项）"
date: 2026-07-01
summary: "Pi 的 `packages/ai` 是整个项目的\"大模型接入层\"。它不直接写业务，而是把所有厂商（OpenAI、Anthropic、DeepSeek、Google……）的聊天接口统一成一套 Pi 自己定义的类型与协议。这一层的总图纸，就是 `packages/ai/src/types.ts`。"
tags:
  - pi
---
# 第 16 章 · 类型系统 types.ts（消息 / 内容块 / 模型 / 选项）

Pi 的 `packages/ai` 是整个项目的"大模型接入层"。它不直接写业务，而是把所有厂商（OpenAI、Anthropic、DeepSeek、Google……）的聊天接口统一成一套 Pi 自己定义的类型与协议。这一层的总图纸，就是 `packages/ai/src/types.ts`。

本章我们只讲这张图纸上最关键的几块：消息（Message）、内容块、模型（Model）、以及请求选项。读完你会明白：Pi 内部无论调用哪个厂商，手里拿的都是同一套"积木"，厂商差异被挡在了更下层。

## 一句话直觉：为什么需要统一类型

不同厂商的 API 返回长得很不一样。OpenAI 叫 `chat.completions`，返回 `choices[].message`；Anthropic 叫 `messages`，返回 `content[]` 里每种块带 `type`；DeepSeek 又几乎照搬 OpenAI。如果上层业务直接对接每一家，代码会被"方言"淹没。

Pi 的做法是：在最底层先定义一套"普通话"——也就是 `types.ts` 里的 `Message`、`Content`、`Model`、`Usage`。所有适配器（第 18、19 章会讲）的职责，就是把厂商方言翻译成这套普通话。所以读懂 `types.ts`，就等于拿到了整栋楼的"户型图"。

> **说明**
>
> **黑话速查**
> - *类型（type）*：这里指 TypeScript 的"类型定义"，相当于给数据画的结构图，规定一段数据必须有哪些字段。
> - *消息（Message）*：一次对话里的一条记录，可能是用户说的、模型回的、或工具执行的结果。
> - *内容块（Content Block）*：一条消息内部更小的单元，比如"一段文字""一张图""一次工具调用"。
> - *角色（role）*：消息是谁发的——`user`（用户）、`assistant`（模型）、`toolResult`（工具结果）。
> - *stopReason*：模型为什么停下输出，是本章重点。

## 三种角色：Message 的并集

Pi 把对话中的所有消息抽象成三种 `role`，并定义在 `types.ts:455` 的联合类型里：

```ts
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

| 角色 | 类型 | 定义位置 | 含义 |
| --- | --- | --- | --- |
| `user` | `UserMessage` | types.ts:409 | 用户输入，可含文字和图片 |
| `assistant` | `AssistantMessage` | types.ts:415 | 模型回复，含正文、思考、工具调用 |
| `toolResult` | `ToolResultMessage` | types.ts:437 | 工具（函数）执行后的返回 |

### UserMessage（用户消息）

定义在 `types.ts:409-413`：

```ts
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number; // Unix 毫秒时间戳
}
```

注意 `content` 既可以是纯字符串，也可以是"文本块 + 图片块"的数组。纯文本时直接写字符串，带图时拆成块数组。

### AssistantMessage（模型回复）

定义在 `types.ts:415-435`，是最复杂的一条，因为它要同时携带正文、思考过程和工具调用：

```ts
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  usage: Usage;
  stopReason: StopReason;   // 本章核心
  errorMessage?: string;
  // ...还有 responseId / diagnostics / deferred / rawStopReason 等
  timestamp: number;
}
```

它比 `UserMessage` 多了 `api` / `provider` / `model` / `usage` / `stopReason` 等字段——因为一条模型回复必须能追溯"是谁、用哪个接口、花了多少 token、为什么停的"。

### ToolResultMessage（工具结果）

定义在 `types.ts:437-453`，关键字段是 `toolCallId`，用来和某条 `ToolCall` 配对：

```ts
export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;   // 对应哪次工具调用
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;     // 工具本身执行失败了吗
  timestamp: number;
}
```

## 内容块：一条消息由哪些"零件"拼成

模型回复的 `content` 是一个块数组，Pi 支持四种块（前三种在 `AssistantMessage`，第四种在工具里）：

| 块类型 | 接口 | 定义位置 | 作用 |
| --- | --- | --- | --- |
| `text` | `TextContent` | types.ts:338 | 普通文字输出 |
| `thinking` | `ThinkingContent` | types.ts:344 | 思考/推理过程（可能加密签名） |
| `image` | `ImageContent` | types.ts:354 | 图片（base64） |
| `toolCall` | `ToolCall` | types.ts:360 | 一次工具调用请求 |

### TextContent

`types.ts:338-342`：

```ts
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string; // OpenAI responses 的 legacy id
}
```

### ThinkingContent（思考块）

`types.ts:344-352`，这是"推理模型"（会先把思路想一遍再答）的关键：

```ts
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string; // 加密签名，用于多轮继续推理
  redacted?: boolean;         // 被安全过滤了，原文是密文
}
```

> **提示**
>
> `thinkingSignature` 和 `redacted` 一对字段专门处理"加密思考"。Anthropic、OpenAI 部分模型会把思考内容加密后再还给你，你回传签名即可续上上下文，但看不到明文。第 19、20 章会具体看到它怎么被传递。

### ImageContent（图片块）

`types.ts:354-358`：图片以 `data`（base64 字符串）+ `mimeType`（如 `image/png`）存储。

### ToolCall（工具调用块）

`types.ts:360-368`：

```ts
export interface ToolCall {
  type: "toolCall";
  id: string;            // 唯一 id，ToolResult 用它回配对
  name: string;          // 调用哪个工具
  arguments: Record<string, any>; // 参数（流式时是"半成品"）
  thoughtSignature?: string;      // Google 专属
  namespace?: string;             // OpenAI Responses 动态工具命名空间
}
```

## stopReason：模型为什么停下

`AssistantMessage.stopReason` 的类型定义在 `types.ts:393`：

```ts
export type StopReason =
  | "pending" | "stop" | "length"
  | "toolUse" | "error" | "aborted" | "deferred";
```

这 7 个值是 Pi 的"统一停止原因"，无论底层厂商返回什么 `finish_reason`，适配器都会翻译成这 7 个之一（第 18、19 章会看到 `mapStopReason`）。它们的含义与对 Pi 主循环的影响如下：

| stopReason | 字面 | 含义 | 主循环下一步（直觉） |
| --- | --- | --- | --- |
| `pending` | 挂起 | 还没开始真正输出（初始占位） | 继续等流；正常不该作为终态 |
| `stop` | 正常停 | 自然说完，没再要工具 | 一轮对话结束，把回复交给用户 |
| `length` | 长度到 | 触到 `maxTokens` 上限被截断 | 截断：可续写或提示"超长" |
| `toolUse` | 要工具 | 模型决定调用工具 | 执行工具→把结果作为 `toolResult` 回灌，再请求一轮 |
| `error` | 出错 | 厂商报错/内容过滤/无法解析 | 终止，向上抛 `errorMessage` |
| `aborted` | 被取消 | 用户或超时中断（AbortSignal） | 终止，当作用户主动停下 |
| `deferred` | 异步 | 厂商说"稍后取结果"（长任务） | 改用 `fetchDeferred` 轮询拿最终消息 |

> **提示**
>
> 最关键的两个是 `stop` 和 `toolUse`。Pi 主循环看到 `toolUse` 不会结束对话，而是去执行工具、再把结果塞回消息列表继续聊——这正是"智能体会自己调工具"的实现基础。连续 `toolUse` 几次，模型就一步步把任务做完。

## Model：一个模型的所有静态信息

`Model<TApi>` 接口定义在 `types.ts:794-823`，描述"某个具体模型"的几乎全部固定属性（价格、窗口、能力）。它的几个重点字段：

```ts
export interface Model<TApi extends Api> {
  id: string;            // 如 "deepseek-v4-flash"
  name: string;          // 展示名
  api: TApi;             // 用哪个适配器，如 "openai-completions"
  provider: ProviderId;  // 厂商，如 "deepseek"
  baseUrl: string;       // 接口地址
  reasoning: boolean;    // 是否支持思考
  thinkingLevelMap?: ThinkingLevelMap; // 思考档位映射
  input: ("text" | "image")[];          // 输入模态
  cost: ModelCost;        // 价格
  contextWindow: number;  // 上下文窗口 token 数
  maxTokens: number;      // 单次最大输出 token
  compat?: ...;            // 厂商方言覆盖（第 18 章重点）
}
```

### cost：价格

`ModelCost` 在 `types.ts:788-791`，按每百万 token 计费的四种单价，还支持分档（tiers）：

```ts
export interface ModelCostRates {
  input: number;     // $/百万输入 token
  output: number;    // $/百万输出 token
  cacheRead: number; // $/百万缓存命中
  cacheWrite: number;// $/百万缓存写入
}
```

### contextWindow / maxTokens

- `contextWindow`（`types.ts:808`）：模型一次能"看"的 token 上限（含历史）。
- `maxTokens`（`types.ts:809`）：单次回复最多生成多少 token。第 12 章讲过，两者之差决定历史能塞多少。

### thinkingLevelMap：思考档位

`types.ts:82-84` 定义思考档位（`minimal`/`low`/`medium`/`high`/`xhigh`/`max`），`Model` 用 `thinkingLevelMap` 把 Pi 的统一档位映射到该模型真正认识的字符串，`null` 表示该档位不支持。例如 DeepSeek 把 `high` 映射成字符串 `"high"`，而 `minimal/low/medium` 标为 `null`（不支持）。

### compat：厂商方言覆盖

`types.ts:814-822` 是最有意思的一段：

```ts
compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
       : TApi extends "anthropic-messages" ? AnthropicMessagesCompat
       : ...;
```

`compat` 的类型会随 `api` 不同而不同——OpenAI 兼容接口用 `OpenAICompletionsCompat`（含 `thinkingFormat` 等几十个开关），Anthropic 用 `AnthropicMessagesCompat`（含 `cacheControlFormat`、`supportsStrictTools` 等）。这套"方言开关"是适配器覆盖 40+ 厂商的核心，第 18 章会专门拆。

## 请求选项：StreamOptions 与 ProviderRequestOptions

上层调用模型时传的"怎么发请求"参数，主要在两个接口：

### ProviderRequestOptions（底层通用）

`types.ts:120-173`，覆盖认证、传输、生命周期钩子：

| 字段 | 定义位置 | 作用 |
| --- | --- | --- |
| `apiKey` | types.ts:124 | 直接给密钥 |
| `signal` | types.ts:121 | 取消信号（AbortSignal） |
| `env` | types.ts:136 | 厂商级环境变量覆盖 |
| `fetch` | types.ts:130 | 自定义 fetch 实现 |
| `onResponse` | types.ts:145 | 收到 HTTP 响应后回调 |
| `timeoutMs` | types.ts:159 | 超时毫秒 |
| `maxRetries` | types.ts:164 | 最大重试次数 |

### StreamOptions（流式选项）

`types.ts:175-219` 在底层之上加了流式专属项：`temperature`、`maxTokens`、`samplingParams`、`cacheRetention`、`sessionId`、`transport` 等。其中 `samplingParams`（`types.ts:189`）很巧妙——直接把 `top_p`、`top_k` 等厂商私有采样参数透传进去，让 OpenAI 兼容服务器（llama.cpp、vLLM、SGLang）能用上 Pi 没建模的参数。

> **说明**
>
> `samplingParams` 是一个"逃生舱"：Pi 不认识每个厂商的所有奇怪参数，但又不想为了它们逐个加字段。于是开放一个 `Record<string, unknown>`，由适配器原样塞进请求体。见 `types.ts:182-189` 注释。

### SimpleStreamOptions：给主循环用的简版

`types.ts:304-310` 在 `StreamOptions` 上加了 `reasoning`（思考档位）和 `deferred`（异步响应）等高级开关，是 Pi 主循环实际调用的选项类型。

## 一条消息在内存里的样子

把上面所有积木拼起来，一条"模型回复 + 工具调用"在 Pi 内部大概是：

```ts
{
  role: "assistant",
  content: [
    { type: "thinking", thinking: "我需要先查天气…", thinkingSignature: "…" },
    { type: "text", text: "我来帮你查一下。" },
    { type: "toolCall", id: "call_01", name: "get_weather", arguments: { city: "北京" } },
  ],
  provider: "deepseek", api: "openai-completions", model: "deepseek-v4-flash",
  stopReason: "toolUse", usage: { input: 12, output: 30, /* … */ },
  timestamp: 1723545600000,
}
```

## 自查清单

- [ ] 我能说出 `Message` 的三种 `role` 分别是什么（types.ts:455）
- [ ] 我知道 `AssistantMessage.content` 可能包含哪三种块（types.ts:417）
- [ ] 我能解释 `toolCallId` 在 `ToolResultMessage` 里的作用（types.ts:439）
- [ ] 我能列出 `stopReason` 全部 7 个取值（types.ts:393）
- [ ] 我知道 `toolUse` 在 Pi 主循环里意味着"继续对话"而不是"结束"
- [ ] 我理解 `thinkingSignature` / `redacted` 是干嘛的（types.ts:344-352）
- [ ] 我知道 `Model.cost` 的四种单价单位都是"每百万 token"（types.ts:776-781）
- [ ] 我能说出 `contextWindow` 与 `maxTokens` 的区别（types.ts:808-809）
- [ ] 我知道 `compat` 的类型会随 `api` 变化（types.ts:814-822）
- [ ] 我理解 `samplingParams` 是给厂商私有参数留的"逃生舱"（types.ts:189）
