---
title: "第 20 章 · 消息转换 transformMessages 两遍处理"
date: 2026-07-01
summary: "OpenAI Responses API 生成的 id 是 450+ 字符、带 `|` 等特殊符号；Anthropic 要求 id 匹配 `^[a-zA-Z0-9_-]+$` 且最多 64 字符。"
tags:
  - pi
---
# 第 20 章 · 消息转换 transformMessages 两遍处理

前面三章我们讲了"模型类型"和"两个适配器"。但适配器拿到消息前，还有一道必经关卡：**`transformMessages`**（`packages/ai/src/api/transform-messages.ts`，全文 223 行）。它负责把 Pi 内部的消息列表"归一化"成当前目标厂商能接受的样子。

为什么需要这层？因为各厂商对"消息长啥样"有各自的怪规矩：有的不支持图片、有的对 thinking 块敏感、有的工具 id 只允许 64 个字符、有的要求 user/toolResult 必须严格交替……`transformMessages` 就是专门消除这些差异的"翻译前的翻译"。

> **说明**
>
> **黑话速查**
> - *归一化（normalize）*：把五花八门的数据整理成统一、合规的形态。
> - *跨厂商（cross-provider）*：从"模型 A 产生的历史"切去"发给模型 B"时，A 的怪癖 B 可能不认。
> - *孤儿工具调用（orphan tool call）*：某条 assistant 调了工具，但对话里找不到对应的 toolResult。
> - *toolCallId 重写*：把过长/含特殊字符的工具 id 改成目标厂商允许的形式。

## 直觉：这层解决什么问题

想象一段对话历史是"Claude（Anthropic）"生成的，里面工具 id 是 `toolu_01AbCd...`（64 位合规）。现在你要把它发给"OpenAI Responses"——它生成的 id 是 450+ 字符、还带 `|` 这种特殊符号。如果直接把 OpenAI 产生的历史回灌给 Anthropic，Anthropic 会因为 id 不合规直接报错。

`transformMessages` 就干这种"按目标厂商体检 + 修补"的活。它接收 `(messages, model, normalizeToolCallId?)`，返回修好的新数组。

> **提示**
>
> `transformMessages` 在第 17、18 章的适配器里被调用——适配器组请求体前，会先用它把 `context.messages` 过一遍。它是"适配器"和"原始历史"之间的一道保险。详见 `openai-completions.ts` 的 `convertMessages`（:1047）链路与 Anthropic 的 `buildParams` 消息转义（:1178 起）。

## 整体结构：两遍处理

`transformMessages` 主体在 `transform-messages.ts:64-223`，清晰分成两遍：

```text
输入 messages
   │
   ├─ 预处理：把 null/undefined content 补成 []（:73）
   ├─ 图片降级：不支持图的模型，图→占位文本（:74, 第二遍前）
   │
   ▼
第一遍：逐消息归一（:77-156）
   - user：原样过
   - toolResult：按 id 映射表改 id
   - assistant：thinking 跨模型处理 + toolCall id 重写 + 清签名
   │
   ▼
第二遍：修复孤儿工具调用（:158-223）
   - 遍历，遇 user/结尾时给没结果的 toolCall 补合成 toolResult
   - 跳过 stopReason=error/aborted 的不完整 assistant
   │
   ▼
输出修好的 messages
```

## 预处理与图片降级

入口前先有一行（`transform-messages.ts:73`）把 `content` 为 `null`/`undefined` 的消息补成空数组——这是为兼容"手搓历史、旧会话文件、自定义工具"等不严谨来源：

```ts
const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
```

随后 `downgradeUnsupportedImages`（`transform-messages.ts:35-57`）判断：如果目标模型 `model.input` 不含 `"image"`，就把 user/toolResult 里的图片块替换成占位文本。

- user 图占位：`"(image omitted: model does not support images)"`（:12）
- toolResult 图占位：`"(tool image omitted: model does not support images)"`（:13）

`replaceImagesWithPlaceholder`（`transform-messages.ts:15-33`）会合并连续占位、避免重复刷屏。这正对应第 17 章 DeepSeek 的 `"input": ["text"]`——DeepSeek 不吃图，历史里若有图就被自动降级成一行提示文字。

## 第一遍：逐消息归一

`transform-messages.ts:77-156` 用 `.map` 逐条处理。三类角色行为不同：

### user：原样过

`transform-messages.ts:79-81`——用户消息不改动（图片已在前面降级）。

### toolResult：按映射表改 id

`transform-messages.ts:84-90`——如果这张 toolResult 的 `toolCallId` 在"id 映射表"里有新值，就替换。映射表由下面 assistant 处理时填充。

### assistant：三件事

`transform-messages.ts:93-154` 对每个 assistant 消息的内容块做归一，先判断是否"同模型"（`transform-messages.ts:95-98`）：

```ts
const isSameModel =
  assistantMsg.provider === model.provider &&
  assistantMsg.api === model.api &&
  assistantMsg.model === model.id;
```

`isSameModel` 决定"这历史是不是目标模型自己产的"——跨模型时很多块要改。

**1) thinking 块跨模型处理**（`transform-messages.ts:100-117`）：

| 情况 | 处理 | 行号 |
| --- | --- | --- |
| 红加密 `redacted` 且跨模型 | 直接丢弃（别的模型看不懂密文） | :104-106 |
| 同模型且有 `thinkingSignature` | 保留（含空思考，OpenAI 加密推理要回传） | :109 |
| 空思考且跨模型 | 丢弃 | :111 |
| 同模型 | 保留 thinking 块 | :112 |
| 跨模型、有内容 | 转成普通 `text` 块 | :113-116 |

> **说明**
>
> 为什么跨模型要把 thinking 转成 text？因为"思考过程"是某模型的内部语言，另一个模型未必能理解，甚至会因为格式不对报错。转成 text，目标模型就把它当普通上下文读。但**同模型**要保留 thinking（尤其带 `thinkingSignature` 的加密思考），否则多轮推理会断。

**2) toolCall id 重写（跨模型）**（`transform-messages.ts:127-145`）——本章重点：

```ts
if (!isSameModel && normalizeToolCallId) {
  const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
  if (normalizedId !== toolCall.id) {
    toolCallIdMap.set(toolCall.id, normalizedId);   // 记下来，待会儿改 toolResult
    normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
  }
}
```

文件头注释（`transform-messages.ts:59-63`）点明动机：

> OpenAI Responses API 生成的 id 是 450+ 字符、带 `|` 等特殊符号；Anthropic 要求 id 匹配 `^[a-zA-Z0-9_-]+$` 且最多 64 字符。

所以跨到 Anthropic 时，`normalizeToolCallId` 回调会把超长 id 重写成合规短 id，并写入 `toolCallIdMap`——第一遍后续处理 toolResult 时就靠这张表把对应的 result 也改掉，保证"调用"和"结果"id 始终配对。

**3) 清 Google 专属签名**（`transform-messages.ts:131-134`）：跨模型时删掉 `thoughtSignature`（Google 专属），免得别家不认。

## 第二遍：修复孤儿工具调用

第一遍只保证"每条消息自身合规"。但厂商还有**顺序/配对**约束：一条 assistant 调了工具，就得有对应的 toolResult，否则 API 报错。`transformMessages` 用第二遍（`transform-messages.ts:158-223`）补这个洞。

### 合成空 toolResult

核心函数 `insertSyntheticToolResults`（`transform-messages.ts:163-180`）：遍历累计的"待处理 toolCall"，凡是找不到对应 toolResult 的，就合成一个：

```ts
result.push({
  role: "toolResult",
  toolCallId: tc.id,
  toolName: tc.name,
  content: [{ type: "text", text: "No result provided" }],
  isError: true,                          // 标记为错误结果
  timestamp: Date.now(),
} as ToolResultMessage);
```

注意 `isError: true`——这是"占位失败结果"，让 API 的配对约束满足，同时告诉模型"这工具没结果"。

### 触发时机

`transform-messages.ts:182-217` 遍历第一遍结果，三类触发点：

| 遇到 | 动作 | 行号 |
| --- | --- | --- |
| 新的 assistant（有挂起孤儿） | 先插入合成结果，再处理本条 | :186-187 |
| 下一个 user 消息 | 插入合成结果（user 打断了工具流） | :210-213 |
| 遍历到结尾仍有孤儿 | 最后再插入一次（:219-220） | :220 |

同时，`existingToolResultIds` 集合（`transform-messages.ts:162, 208`）记录已出现的真实 toolResult id，避免给"已有结果"的调用再补合成结果。

### 跳过不完整 assistant

`transform-messages.ts:194-197` 有个关键保护：

```ts
if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
  continue;   // 整条跳过
}
```

为什么？因为 `error`/`aborted` 的 assistant 是"半成品"（可能只有思考没正文、工具调用不完整）。重放它们会触发厂商报错（注释举了 OpenAI "reasoning without following item" 的例子）。正确做法是"从最后一个有效状态重试"，所以直接丢弃这些不完整轮。

> **注意**
>
> 这一步很隐蔽但很重要：如果你曾看到 Pi 重放历史时厂商报"消息顺序非法"，多半是漏了孤儿 toolResult 或混入了 aborted 的不完整轮。第二遍就是专门堵这两个坑的。

## 为什么各厂商对消息顺序这么挑剔

不同 API 对 `user` / `assistant` / `toolResult` 的交替规则不同，举几个真实约束（部分在 `OpenAICompletionsCompat` 里可见，types.ts:558-561）：

- `requiresToolResultName`：工具结果必须带 `name` 字段（types.ts:559）；
- `requiresAssistantAfterToolResult`：toolResult 之后若要再发 user，中间必须插一条 assistant（types.ts:561）；
- Anthropic 硬性要求每个 `tool_use` 块都有对应的 `tool_result` 块，否则报错。

`transformMessages` 不穷举每家规则，而是用"补合成 toolResult + 跳过不完整 assistant"这套通用手段，让绝大多数厂商都能接收——这也是为什么它放在"适配器调用前"而不是"某家适配器内部"。

## 完整示例：Claude 历史 → 发给 DeepSeek

假设历史是 Claude 生成、含一次工具调用，但缺结果：

```text
[user, assistant(调用 toolu_01X, 但无对应 toolResult), user]
```

过 `transformMessages`（目标 DeepSeek，OpenAI 兼容）：

1. 图片降级：DeepSeek 不吃图，若有图→占位（本例无）。
2. 第一遍：assistant 的 toolCall id 若需重写则写映射表；thinking 块跨模型→转 text 或丢弃。
3. 第二遍：遇到第二个 user 时，发现 `toolu_01X` 无 result → 插入合成 `toolResult(isError:true, "No result provided")`；再推 user。

输出：

```text
[user, assistant(工具调用), toolResult(合成, 错误), user]
```

DeepSeek 收到的是"合法配对"的历史，不再报错。

## 自查清单

- [ ] 我知道 `transformMessages` 在 adapters 调之前做"消息归一"（transform-messages.ts:64）
- [ ] 我能说出它分"两遍处理"（:77 第一遍，:158 第二遍）
- [ ] 我知道图片降级会把图换成占位文本（:12-13, :35-57）
- [ ] 我看到 `isSameModel` 决定 thinking 块保留还是转 text（:95-117）
- [ ] 我知道跨模型 thinking 转 text、同模型保留（:113-116）
- [ ] 我知道 toolCall id 重写是因为 Anthropic 限 64 字符、OpenAI 有 450+ 字符（:59-63）
- [ ] 我看到 `toolCallIdMap` 用来同步改 toolResult 的 id（:139, :85-89）
- [ ] 我知道孤儿 toolCall 会补合成 `toolResult(isError:true)`（:163-180）
- [ ] 我知道三个触发插入合成结果的时机（:186-187, :210-213, :220）
- [ ] 我知道 `stopReason=error/aborted` 的 assistant 会被整条跳过（:194-197）
- [ ] 我理解这层存在是为了消各厂商对"消息顺序/配对"的约束差异
