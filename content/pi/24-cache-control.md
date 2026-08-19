---
title: "第 24 章 · 提示缓存与 cache_control"
date: 2026-07-01
summary: "大模型按 token 收费，**每发一次请求都要把整段对话历史（含系统提示词）重新传给服务器**。如果一段长系统提示词在 100 轮对话里每次都重传，成本会爆炸。解决方案是 **prompt cache（提示缓存）**：把\"不变的那部分\"在服务器上缓存起来，后续只传差异，命中缓存的 token 价格通常只要 1/…"
tags:
  - pi
---
# 第 24 章 · 提示缓存与 cache_control

> 大模型按 token 收费，**每发一次请求都要把整段对话历史（含系统提示词）重新传给服务器**。如果一段长系统提示词在 100 轮对话里每次都重传，成本会爆炸。解决方案是 **prompt cache（提示缓存）**：把"不变的那部分"在服务器上缓存起来，后续只传差异，命中缓存的 token 价格通常只要 1/10。本章讲 Pi 如何在 OpenAI 兼容协议下落地这套机制。

## 1. 先建立直觉：缓存解决什么

假设你给 Pi 装了一个 8000 字的"项目规则"系统提示词，模型每轮都要它。没有缓存时：

```text
第 1 轮请求: [系统提示 8k][历史 2k]          → 付 10k token 的钱
第 2 轮请求: [系统提示 8k][历史 4k]          → 付 12k token 的钱
第 3 轮请求: [系统提示 8k][历史 6k]          → 付 14k token 的钱
...每轮都重复付那 8k 系统提示词的钱
```

有缓存时，服务器记住"这段 8k 我见过了"，后续只按 `cacheRead`（缓存命中）计费，单价极低。这就是第 12 章讲的"成本经济"的关键杠杆之一。

> **提示 · 黑话速查**
>
> - **prompt cache**：服务商在服务器端缓存某段输入，命中后该段不计原价。
> - **cache_control**：在请求里标记"从哪一段开始缓存"的标记（Anthropic 风格）。
> - **cache key**：标识一段缓存内容的键，OpenAI 用它把多次会话关联到同一份缓存。
> - **ephemeral（短暂）**：缓存类型，通常几分钟。

## 2. 在 OpenAI 兼容协议里打缓存标记

OpenAI 的原生 Chat Completions 协议没有 `cache_control` 字段，但很多网关（如 OpenRouter 代理的 Anthropic 模型）支持 **Anthropic 风格的 `cache_control`**。Pi 在 `packages/ai/src/api/openai-completions.ts` 里做这件事。

### 2.1 决定要不要打标记

```ts
// packages/ai/src/api/openai-completions.ts:931-941
function getCompatCacheControl(compat, cacheRetention) {
  if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
    return undefined;   // 只有声明支持 anthropic 缓存格式、且允许缓存时才打
  }
  const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}
```

`cacheControlFormat` 来自厂商兼容性探测：只有 `provider === "openrouter" && model.id 以 "anthropic/" 开头` 时才是 `"anthropic"`（`openai-completions.ts:1493`）。`cacheRetention` 来自 `resolveCacheRetention`（`openai-completions.ts:191-199`），可由环境变量 `PI_CACHE_RETENTION="long"` 提升到长缓存（1 小时）。

### 2.2 三个缓存落点

一旦决定打标记，就调用 `applyAnthropicCacheControl`：

```ts
// packages/ai/src/api/openai-completions.ts:943-951
function applyAnthropicCacheControl(messages, tools, cacheControl) {
  addCacheControlToSystemPrompt(messages, cacheControl);          // ① 系统提示词
  addCacheControlToLastTool(tools, cacheControl);                 // ② 最后一个工具
  addCacheControlToLastConversationMessage(messages, cacheControl); // ③ 最后一条对话消息
}
```

为什么是这三处？因为缓存是"前缀缓存"——从消息开头到第一个 `cache_control` 之间的内容会被整体缓存。落点设计遵循经验法则：

- **系统提示词打缓存**（`addCacheControlToSystemPrompt`，`openai-completions.ts:953-963`）：最大、最稳定，收益最高。
- **最后一个工具打缓存**（`addCacheControlToLastTool`，`openai-completions.ts:979-989`）：工具定义通常很长且相对稳定，把 `cache_control` 挂在 `tools` 数组最后一项上。
- **最后一条 user/assistant/tool 消息打缓存**（`addCacheControlToLastConversationMessage`，`openai-completions.ts:965-977`）：缓存到"上一轮结束"为止，这样下一轮新增的那一点内容只需要增量计费。

`cache_control` 实际是挂到文本块上：

```ts
// packages/ai/src/api/openai-completions.ts:1008-1045
function addCacheControlToTextContent(message, cacheControl) {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) return false;
    message.content = [{ type: "text", text: content, cache_control: cacheControl }];
    return true;
  }
  // 否则从数组末尾往前找最后一个 text 块，给它打标记
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === "text") {
      const textPart = part as ChatCompletionTextPartWithCacheControl;
      textPart.cache_control = cacheControl;
      return true;
    }
  }
  return false;
}
```

注意它总是挂在"最后一个 text 块"上，这符合"前缀缓存到此处"的语义。

## 3. 缓存 key 为什么会被截断到 64 字符

OpenAI 的 `prompt_cache_key` 有长度上限。Pi 用一个常量 + 截断函数处理：

```ts
// packages/ai/src/api/openai-prompt-cache.ts:1-8
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
```

> **说明 · 为什么需要截断？**
>
> `prompt_cache_key` 在 OpenAI 服务端用来把你的多次会话关联到**同一份缓存**。它通常由 Pi 的 `sessionId` 充当（见下方 `buildParams`）。但 `sessionId` 可能很长（比如带路径或 UUID 拼接）。如果超过服务端限制直接整段拒绝请求，反而是"为了缓存反而发不出去"。所以 Pi 在发送前先 `clamp`（夹紧）到 64 字符以内——**宁可只用 key 的前 64 字符，也不要因为超长而丢失整个缓存能力**。用 `Array.from` 而不是 `.slice` 是因为要考虑 Unicode 代理对，避免截断半个字符。

### 3.1 在哪里调用截断

```ts
// packages/ai/src/api/openai-completions.ts:700-705
const params = {
  model: model.id,
  messages,
  stream: true,
  prompt_cache_key:
    (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
    (cacheRetention === "long" && compat.supportsLongCacheRetention)
      ? clampOpenAIPromptCacheKey(options?.sessionId)   // 这里截断
      : undefined,
  prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
};
```

可以看到：`prompt_cache_key` 只在"直连 OpenAI 官方（`api.openai.com`）且允许缓存"，或"长缓存模式且厂商支持"时才设置，且一定经过 `clampOpenAIPromptCacheKey` 截断。它把 `options.sessionId` 作为 key，让同一会话的多轮请求复用缓存。

## 4. 缓存命中如何计费（回到成本）

真正花钱的地方在 `parseChunkUsage`（`openai-completions.ts:1375-1411`）。它从服务商返回的 usage 里拆解：

```ts
// packages/ai/src/api/openai-completions.ts:1386-1407
const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
```

- `cacheRead`：命中缓存的 token，单价极低。
- `cacheWrite`：本次新写入缓存的 token（首次出现缓存段时产生）。
- `input`：真正按原价计费的"增量"输入。

最后 `calculateCost(model, usage)` 把这些折算成钱。这正是第 12 章"成本经济"里说的：**让稳定前缀（系统提示、工具定义）走缓存，只为新内容付费**。

## 5. 一图看懂 Pi 的缓存落地

```text
一次请求组装（buildParams）
  │
  ├─ 是否支持 anthropic 缓存格式 且 允许缓存?
  │     └─ 是 → 生成 cacheControl = {type:"ephemeral", ttl?}
  │
  ├─ applyAnthropicCacheControl
  │     ├─ 系统提示词最后一个 text 块 → cache_control
  │     ├─ tools 数组最后一项        → cache_control
  │     └─ 最后一条对话消息 text 块   → cache_control
  │
  └─ prompt_cache_key 设置（仅 OpenAI 官方 / 长缓存）
        └─ clampOpenAIPromptCacheKey(sessionId)  → 不超过 64 字符
              │
   服务端返回 usage: cached_tokens / cache_write_tokens
              │
   parseChunkUsage → 区分 input / cacheRead / cacheWrite → calculateCost
```

> **提示 · 工程启示**
>
> 缓存标记不是"塞得越多越好"。前缀缓存要求被缓存的**前缀保持稳定**——一旦前缀变了，缓存就失效。Pi 选择"系统提示词 + 工具 + 到上一轮为止的对话"作为缓存边界，正是因为这些内容在单轮内基本不变。如果你想自己调 prompt，记住：**越靠前、越稳定、越大的内容，越值得打 cache_control**。

## 自查清单

- [ ] 我能解释 prompt cache 为什么省钱（命中缓存 token 单价低）。
- [ ] 我知道 Pi 在 OpenAI 兼容协议下用哪三处 `cache_control`（系统/工具/最后对话）。
- [ ] 我能在源码定位 `applyAnthropicCacheControl`（`openai-completions.ts:943`）与 `getCompatCacheControl`（`openai-completions.ts:931`）。
- [ ] 我知道 `prompt_cache_key` 为什么被截断到 64 字符（`openai-prompt-cache.ts:1`）。
- [ ] 我理解 `cacheRetention` 可由 `PI_CACHE_RETENTION=long` 提升到 1h/24h。
- [ ] 我能把本章与第 12 章成本经济（input/cacheRead/cacheWrite 拆分）联系起来。
