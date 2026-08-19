---
title: "第 12 章 · 提示缓存（Prompt Cache）与成本经济"
date: 2026-07-01
summary: "**Prompt Cache = 把\"稳定的长前缀\"存起来复用，对命中部分打折；省钱省时的杠杆 = 被缓存 token 数 × 复用轮数。**"
tags:
  - pi
---
# 第 12 章 · 提示缓存（Prompt Cache）与成本经济

## 12.1 痛点：重复的前缀在反复"烧钱"

每次调用 LLM，你都要把**系统提示 + 工具声明 + 历史对话**整包发上去。其中很多内容是**每轮都不变**的：

- 系统提示（system prompt）：基本固定。
- 工具声明（tools）：同一个 agent 用的工具集基本不变。
- 长上下文前部：前几轮对话不会改。

但供应商**按 token 数收费**，也按 token 数做前向计算（prefill）。如果每轮都把这一大坨重复内容重新传、重新算，既贵又慢。这就是 **Prompt Cache（提示缓存）** 要解决的问题。

> **提示 · 一个生活类比**
>
> 像你每周给同一家公司发邮件，开头"尊敬的 XX 公司、我是 Pi 用户、以下是我的诉求"每次都一样。如果邮局说"信封每个字都按字数收费"，你巴不得邮局"记住这段开头，只对新内容计费"。Prompt Cache 就是供应商替你"记住前缀"，对命中的部分打折甚至不计费。

## 12.2 核心概念：缓存命中与 cache_control

Prompt Cache 的思路：

- 你标记 prompt 里**哪些前缀值得缓存**（如系统提示末尾、最后一个工具定义后）。
- 供应商把这段前缀的"计算结果"存一段时间。
- 下次请求若**前缀一致**，直接复用缓存：这部分叫**缓存命中（cache read）**，计费大幅降低；首次写入缓存叫 **cache write**，可能略贵一点（一次性成本）。

在 Anthropic 系协议里，用 `cache_control` 标记断点；OpenAI/DeepSeek 系多用 `prompt_cache_key` / 会话亲和来路由。Pi 在 `packages/ai/src/types.ts:104` 定义了缓存保留档位：

```ts
export type CacheRetention = "none" | "short" | "long";
```

- `none`：不缓存。
- `short`：短保留（如 5 分钟内命中，各家不同）。
- `long`：长保留（如 1 小时，Anthropic 的 `cache_control.ttl: "1h"`、OpenRouter 的 `prompt_cache_retention: "24h"`）。

> **说明 · Pi 怎么打缓存标记**
>
> 在 `packages/ai/src/api/openai-completions.ts:943`，`applyAnthropicCacheControl` 会给三处加 `cache_control`：系统提示（`addCacheControlToSystemPrompt`）、**最后一个工具定义**（`addCacheControlToLastTool`，`:979`）、最后一条对话消息（`addCacheControlToLastConversationMessage`）。这正对应"系统提示 + 工具声明 + 近期上下文"三段最该缓存的内容。暴露给用户的开关是 `StreamOptions.cacheRetention`（`types.ts:200`），默认 `"short"`。

## 12.3 clampOpenAIPromptCacheKey：给缓存键"限长"

OpenAI 系的缓存靠 `prompt_cache_key` 做会话/缓存路由标识。但 key 太长会被供应商拒绝。Pi 在 `packages/ai/src/api/openai-prompt-cache.ts:3` 提供裁剪函数：

```ts
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");  // 超 64 字符就截断
}
```

逻辑很直白：key 为空返回空；不超过 64 字符原样返回；超了就**按字符截断到前 64 个**。注意用 `Array.from(key)` 而非 `key.slice`——因为要保证**按 Unicode 码点（而非 UTF-16 单元）截断**，避免把多字节字符（如 emoji、中文）砍成乱码。

它在 `openai-completions.ts:700` 被这样用：仅当命中 OpenAI 官方域或要求 `long` 保留时，才把 `options?.sessionId` 经 `clampOpenAIPromptCacheKey` 处理后塞进 `prompt_cache_key`，其余情况为 `undefined`（即不强制走缓存键路由）。

## 12.4 各供应商缓存计费差异（概念层）

不同家的"缓存怎么算钱"各不相同，写代码对接时要查各自文档。本章给**差异维度**，不背书具体数字（价格会变）：

| 供应商倾向 | 写入(cache write) | 命中(cache read) | 备注 |
|------------|-------------------|------------------|------|
| OpenAI | 通常不单独报 write 计费 | 命中部分显著低于 input | 靠 `prompt_cache_key` 路由 |
| DeepSeek | 有独立 cache 计费档 | 命中档很低 | 对小模型极友好 |
| Anthropic | 写入 1 次略贵 | 命中档很低；`1h` 比 `5m` 贵一点 | 用 `cache_control.ttl` |

> **注意 · 别把"缓存命中"当免费**
>
> 多数家缓存命中仍**收费，只是比普通 input 便宜很多**（常见 1/10 量级，以各家文档为准）。而且缓存有**生存窗口**：过了 `short`/`long` 期限，前缀失效，下次又按全价 input 计。所以"频繁复用同一长前缀"才划算——这正好契合"长系统提示 + 固定工具声明"的场景。

## 12.5 为什么长系统提示 + 工具定义最适合缓存

回到第 7、10 章：一个 coding agent 的 `Context` 里，系统提示和工具声明往往**又长又稳定**——

- 系统提示可能几百到几千字（角色设定、规则、禁忌）。
- 工具声明是完整的 JSON Schema 列表（每个工具的参数结构），动辄数千 token。

这两块每轮请求都带着、却几乎不变。把它们标成缓存前缀后：

```text
第 1 轮：系统提示(写缓存) + 工具(写缓存) + 新对话   → 付 cacheWrite + input + output
第 2 轮：系统提示(命中!)   + 工具(命中!)   + 新对话   → 付 cacheRead(很便宜) + input + output
第 3 轮：系统提示(命中!)   + 工具(命中!)   + 新对话   → 同上
...
```

长上下文 + 固定工具 = 缓存收益最大。反之，如果每次系统提示都变、工具集频繁变，前缀对不上，缓存几乎白建。

## 12.6 成本四维度：input / output / cacheRead / cacheWrite

Pi 在 `Usage` 类型（`packages/ai/src/types.ts:370`）把一次调用的 token 拆成四块，正是为了精确计费：

```ts
export interface Usage {
  input: number;       // 未命中缓存的输入 token
  output: number;      // 模型生成的 token
  cacheRead: number;   // 命中缓存、复用的 token
  cacheWrite: number;  // 首次写入缓存的 token
  totalTokens: number;
  cost: {
    input: number;     // 各维度花费（美元）
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

注意 `cost` 里四项**一一对应** `input/output/cacheRead/cacheWrite`——这就是成本经济的"仪表盘"。在 `openai-completions.ts:1386`，Pi 把供应商返回的 `cached_tokens` 映射到 `cacheRead`、`cache_write_tokens` 映射到 `cacheWrite`，并保证 `input = prompt_tokens - cacheRead - cacheWrite`（已缓存的不重复算 input）。

计费单价由 `Model.cost` 定义（`packages/ai/src/types.ts:776`）：

```ts
export interface ModelCostRates {
  input: number;     // $/百万 token
  output: number;    // $/百万 token
  cacheRead: number; // $/百万 token（通常最低）
  cacheWrite: number;// $/百万 token（通常最高，一次性）
}
export interface ModelCost extends ModelCostRates {
  tiers?: ModelCostTier[];   // 可选：按输入量分档计价
}
```

> **说明 · 读账单要看四个数**
>
> 优化成本时，别只盯 `total`。重点看 `cacheRead / cacheWrite` 占比：cacheRead 越高，说明缓存命中越多、越省钱；cacheWrite 频繁出现，说明前缀老在变、缓存在反复重建——这时该检查系统提示/工具是否没必要每轮变。

## 12.7 给"自己造 Agent"的成本建议

1. **系统提示和工具声明尽量稳定**，让缓存前缀长期命中。
2. **开缓存**（`cacheRetention` 设 `short`/`long`），长上下文场景几乎必开。
3. **监控 cacheRead 占比**作为"缓存是否有效"的健康度指标。
4. **别为缓存硬塞长前缀**：如果前缀本就不长，缓存收益覆盖不了 write 成本。
5. **换供应商比对四档单价**：同任务在不同家，cacheRead/cacheWrite 策略差异可能让总价差几倍。

## 12.8 会话亲和（Session Affinity）与命中率

缓存要命中，前提是"同一段前缀被送到**同一个缓存副本**"。在分布式部署里，请求可能被负载均衡到不同副本，而缓存只存在于某些副本上。为此供应商提供**会话亲和**：用 `session_id` 等标识，把同一会话的请求尽量路由到同一后端，提升缓存命中。Pi 在 `types.ts:112` 定义 `SessionAffinityFormat`（`"openai" | "openai-nosession" | "openrouter"`），由 `StreamOptions.sessionId`（`types.ts:206`）传入，并在 `openai-completions.ts:713` 把它映射成对应请求头/字段。简言之：**想稳命中缓存，得让请求"认得路"回到同一个缓存**。

## 12.9 缓存失效与淘汰

缓存不是永久的。除了 `CacheRetention` 的时间窗（`short`/`long`），还有两类"前缀变了就失效"：

- **前缀被改动**：你中途改了系统提示或加了工具，前缀对不上，旧缓存作废，重新 `cacheWrite` 一遍。
- **超出最小缓存长度**：多数家要求前缀至少达到某个 token 数（如 1024）才值得缓存，太短不缓存。

> **注意 · 别为了"凑缓存"硬加长前缀**
>
> 有人想"既然长前缀适合缓存，那我往系统提示里狂塞东西"。错。多余内容既占 context 又稀释注意力，且一旦改动就整段失效。缓存优化前提是"前缀本来就长且本来就稳定"——不是为了缓存而制造长前缀。

## 12.10 算一笔账：开缓存能省多少

举个直觉例子（数字仅示意，单价以各家文档为准）：

```text
场景：一个 coding agent，系统提示+工具声明共 4000 token，每轮新对话 500 token，输出 800 token
不开缓存（每轮）：
  花费 ≈ (4000+500) × input单价 + 800 × output单价
开缓存（第 2 轮起）：
  花费 ≈ 500 × input单价 + 4000 × cacheRead单价(很低) + 800 × output单价

若 cacheRead 单价 ≈ input 单价的 1/10：
  每轮省下的 ≈ 4000 × (input - cacheRead) ≈ 4000 × 0.9 × input单价
  长会话累计非常可观
```

关键杠杆：**被缓存的 token 数 × 复用轮数**。前缀越长、轮数越多，`cacheRead` 累计越大，省得越多。这也反向说明：短对话、一次性任务，开缓存收益有限，甚至被 `cacheWrite` 的一次性成本抵消。

## 12.11 成本之外的工程账

缓存不只省钱，还**省时间**：命中缓存的前缀不用重新做 prefill（前向计算），首 token 延迟更低。对"交互式 coding agent"这种追求响应快的场景，延迟收益有时比那点钱更重要。所以 `cacheRetention` 默认 `"short"`（`types.ts:200`）是个合理起点——大多数交互会话在短窗口内高频复用同一前缀，short 档刚好覆盖，又不占长保留的稀缺额度。

> **说明 · 给使用者的三句口诀**
>
> 前缀要稳、键要短、命中要看。前缀稳（系统提示/工具别老变）才能让缓存活；键短（`clampOpenAIPromptCacheKey` 保证 ≤64）才能被路由；命中看（盯 `cacheRead` 占比）才能知道省没省。

## 12.12 缓存与隐私/合规

缓存是把"前缀"存在供应商一侧的。这带来两个常被忽视的点：

- **敏感内容别进缓存前缀**：系统提示里若含密钥、个人信息，缓存后可能在保留期内被复用计算，扩大暴露面。把敏感数据放在**每轮变化的尾部**（如用户本次输入），而非被缓存的固定前缀。
- **跨租户隔离**：如果你给多个用户共用同一前缀做缓存，要确认供应商按"你的账号/缓存键"隔离，别让 A 用户的缓存命中泄漏给 B。Pi 的 `prompt_cache_key` 路由（`clampOpenAIPromptCacheKey` 产出）就是这一隔离的抓手之一。

> **注意 · 缓存不是加密保险箱**
>
> 缓存只是"复用计算结果"，不隐含额外保密。含机密的前缀要么别缓存（`CacheRetention: "none"`），要么确保内容本身已脱敏。安全边界仍由你的部署与供应商协议决定，缓存无能为力。

## 12.13 监控看板该挂哪些指标

要持续知道缓存"值不值"，建议在账单/监控里盯这几个数（都来自 `Usage`，`types.ts:370`）：

| 指标 | 怎么算 | 健康信号 |
|------|--------|----------|
| 缓存命中率 | cacheRead / (cacheRead + input) | 越高越省（长会话应 > 60%） |
| 写缓存频率 | cacheWrite 出现次数/占比 | 频繁说明前缀在变，缓存被反复重建 |
| 缓存节省 | (input - cacheRead) × (input单价 - cacheRead单价) | 应随轮数单调累积 |
| 总成本结构 | cost.input / output / cacheRead / cacheWrite | 看钱主要花在哪 |

```text
健康：  cacheRead 占比高、cacheWrite 偶发 → 前缀稳、命中多
告警：  cacheWrite 每轮都有、cacheRead 低 → 前缀老变、缓存在空转
```

把这些指标接进你的可观测性系统，比"月底看总账单吓一跳"强得多。Pi 把四类 token 拆得清清楚楚，正是为了方便你做这种精细化核算。

## 12.14 本章关键点回顾

- Prompt Cache 解决"重复前缀反复计费/重算"，对命中部分打折。
- `CacheRetention`（`types.ts:104`）分 none/short/long；Pi 默认 short。
- `clampOpenAIPromptCacheKey`（`openai-prompt-cache.ts:3`）把缓存键截断到 64 字符，且按 Unicode 码点安全截断。
- 缓存最适"长系统提示 + 固定工具声明"；成本看 input/output/cacheRead/cacheWrite 四维度（`Usage`，`types.ts:370`）。

## 12.15 成本经济一句话收尾

把全章收成一句可带走的话：

> **Prompt Cache = 把"稳定的长前缀"存起来复用，对命中部分打折；省钱省时的杠杆 = 被缓存 token 数 × 复用轮数。**

记账看四个维度 `input / output / cacheRead / cacheWrite`（`Usage`，`types.ts:370`），其中 `cacheRead` 占比是"缓存有没有用"的体温计。优化口诀：**前缀要稳、键要短、命中要看**。这不仅是省钱技巧，更是长上下文 coding agent 能做到"反应快、单价低"的工程底座。

## 12.16 延伸：缓存与批处理是两条不同的省钱路

别把 Prompt Cache 当成唯一省钱手段。另一条常见路是**批处理（Batch）**：把不急着要结果的请求攒一批，用供应商的离线批接口跑，单价常打对折，但延迟高（按小时计）。两者取向相反：

| 手段 | 省在哪 | 代价 | 适合 |
|------|--------|------|------|
| Prompt Cache | 重复前缀不重算/不重复计费 | 几乎无 | 交互式、前缀稳定 |
| Batch | 离线批量跑，单价更低 | 高延迟（小时级） | 离线任务、评测、大规模处理 |

```text
交互式 coding agent → 用 Prompt Cache（要快、前缀稳）
离线给 1 万文件生成摘要 → 用 Batch（不急、量大）
```

聪明的成本工程是"按场景选路"：能缓存的缓存，能批的批，二者不冲突，可叠加。Pi 的 `Usage` 把 cache 维度拆清楚，正是为了让你在做这种取舍时有数据可依。

> **说明 · 成本意识的起点**
>
> 很多初学者只关心"模型聪不聪明"，老手更关心"这一轮花了多少、值不值"。把 `input/output/cacheRead/cacheWrite` 四栏当成仪表盘常看，你对 Agent 的理解会从"能跑"跃迁到"跑得经济"——这是从玩具走向生产的隐形门槛。

## 自查清单

- [ ] 我能解释 Prompt Cache 解决的是"重复前缀反复计费"问题。
- [ ] 我知道 CacheRetention 的三种档位（none/short/long）及其含义。
- [ ] 我能说出 Pi 给哪三处加 cache_control（系统提示/最后一个工具/最后对话消息）。
- [ ] 我知道 clampOpenAIPromptCacheKey 把缓存键截断到多少字符，以及为何用 Array.from。
- [ ] 我能列出成本的四个 token 维度（input/output/cacheRead/cacheWrite）。
- [ ] 我理解为什么"长系统提示 + 固定工具声明"最适合缓存。
- [ ] 我知道 cacheRead 占比高代表什么（缓存命中多、更省钱）。
