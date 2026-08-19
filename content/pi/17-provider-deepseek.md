---
title: "第 17 章 · Provider 抽象与 DeepSeek 接入（真实 15 行拆解 + JSON 目录）"
date: 2026-07-01
summary: "上一章我们看了 `types.ts` 这张图纸。本章看一个真实案例：Pi 怎么把 DeepSeek 接进来。你会惊讶地发现，整个接入文件 `packages/ai/src/providers/deepseek.ts` 只有 **15 行**（deepseek.ts:1-15）。"
tags:
  - pi
---
# 第 17 章 · Provider 抽象与 DeepSeek 接入（真实 15 行拆解 + JSON 目录）

上一章我们看了 `types.ts` 这张图纸。本章看一个真实案例：Pi 怎么把 DeepSeek 接进来。你会惊讶地发现，整个接入文件 `packages/ai/src/providers/deepseek.ts` 只有 **15 行**（deepseek.ts:1-15）。

为什么这么短？因为 Pi 把"厂商接入"拆成了三层：**工厂函数（15 行）+ 模型目录 JSON + 通用 Provider 构造器 `createProvider`**。DeepSeek 这种"OpenAI 兼容"厂商，只需把三块拼起来即可，几乎不用写逻辑。

> **说明**
>
> **黑话速查**
> - *Provider（厂商）*：提供服务的一方，如 DeepSeek、OpenAI、Anthropic。
> - *Provider 工厂*：一个返回 `Provider` 对象的函数，把 id/密钥/模型列表/适配器绑在一起。
> - *模型目录（Model Catalog）*：一份描述"该厂商有哪些模型、各模型参数多少"的数据（这里是 JSON）。
> - *OpenAI 兼容*：很多新厂商故意让自己的接口和 OpenAI 一模一样，好处是同一套代码能直接复用。

## 直觉：接入一个厂商要回答哪四个问题

Pi 接入任何厂商，本质是在回答四个问题：

1. **你是谁？** id 叫什么、展示名是什么、接口地址 `baseUrl` 在哪。
2. **怎么认证？** 密钥从哪个环境变量读（`DEEPSEEK_API_KEY`）。
3. **你有哪些模型？** 一份模型目录。
4. **用哪个适配器说话？** 即 `api`——OpenAI 风格就用 `openAICompletionsApi`。

DeepSeek 因为是 OpenAI 兼容，第 4 问直接复用现成适配器；第 3 问是一份 JSON；第 1、2 问在 15 行工厂里写死。于是文件极短。

## 15 行工厂逐字段拆解

先贴出 `deepseek.ts:1-15` 全文，再逐字段解释：

```ts
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

export function deepseekProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
    models: Object.values(DEEPSEEK_MODELS),
    api: openAICompletionsApi(),
  });
}
```

| 行号 | 代码 | 作用 |
| --- | --- | --- |
| deepseek.ts:1 | `import openAICompletionsApi` | 引入 OpenAI 兼容适配器（lazy 加载） |
| deepseek.ts:2 | `import envApiKeyAuth` | 引入"从环境变量读密钥"的认证助手 |
| deepseek.ts:3 | `import createProvider` | 引入通用 Provider 构造器（第 16 章铺垫） |
| deepseek.ts:4 | `import DEEPSEEK_MODELS` | 引入模型目录（下节讲） |
| deepseek.ts:6 | `export function deepseekProvider()` | 工厂函数，返回 `Provider<"openai-completions">` |
| deepseek.ts:8 | `id: "deepseek"` | 厂商唯一标识，写进 `Model.provider` |
| deepseek.ts:9 | `name: "DeepSeek"` | 给人看的名字 |
| deepseek.ts:10 | `baseUrl: "https://api.deepseek.com"` | 接口根地址 |
| deepseek.ts:11 | `auth: envApiKeyAuth(...)` | 认证：从 `DEEPSEEK_API_KEY` 读密钥 |
| deepseek.ts:12 | `models: Object.values(DEEPSEEK_MODELS)` | 把模型目录展平成数组 |
| deepseek.ts:13 | `api: openAICompletionsApi()` | 用 OpenAI 兼容适配器收发消息 |

> **提示**
>
> 注意 `api: openAICompletionsApi()` 这一行——它返回的是一个 `ProviderStreams`（含 `stream`/`streamSimple`）。DeepSeek 没写自己的适配逻辑，纯粹"借用"了 OpenAI 的。这正是"OpenAI 兼容"红利的直接体现。

## 模型目录：一份 JSON 撑起全部模型

`deepseek.ts:4` 引入的 `DEEPSEEK_MODELS` 来自 `providers/deepseek.models.ts`。这个文件只有 9 行，它的工作是把 `data/deepseek.json` 这份"真·模型目录"展平成 Pi 的 `Model` 数组：

```ts
import values from "./data/deepseek.json" with { type: "json" };
import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";

export const DEEPSEEK_MODELS: ModelCatalog<typeof values, "deepseek"> =
  flattenModelCatalog("deepseek", values);
```

其中 `data/deepseek.json` 是真实数据（不是编造的）。它顶层键是 `api` 名（`openai-completions`），其下是各模型的条目。下面完整展示其中一个真实条目 `deepseek-v4-flash`（来自 `providers/data/deepseek.json`）：

```json
{
  "deepseek-v4-flash": {
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "baseUrl": "https://api.deepseek.com",
    "provider": "deepseek",
    "reasoning": true,
    "input": ["text"],
    "cost": {
      "input": 0.14, "output": 0.28,
      "cacheRead": 0.0028, "cacheWrite": 0
    },
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "compat": {
      "supportsStore": false,
      "supportsDeveloperRole": false,
      "requiresReasoningContentOnAssistantMessages": true,
      "thinkingFormat": "deepseek"
    },
    "thinkingLevelMap": {
      "minimal": null, "low": null, "medium": null,
      "high": "high", "max": "max"
    }
  }
}
```

### 这个条目告诉 Pi 的事

| 字段 | 本条目的值 | 含义 |
| --- | --- | --- |
| `id` / `name` | `deepseek-v4-flash` / `DeepSeek V4 Flash` | 模型标识与展示名 |
| `api` | `openai-completions` | 走 OpenAI 兼容适配器 |
| `reasoning` | `true` | 支持思考（推理） |
| `input` | `["text"]` | 只吃文字，不吃图（第 20 章会用到） |
| `cost.input` | `0.14` | 输入 0.14 美元/百万 token（真实值） |
| `cost.output` | `0.28` | 输出 0.28 美元/百万 token（真实值） |
| `cost.cacheRead` | `0.0028` | 缓存命中 0.0028 美元/百万 token |
| `cost.cacheWrite` | `0` | DeepSeek 不收缓存写入费 |
| `contextWindow` | `1000000` | 上下文窗口 100 万 token（真实值） |
| `maxTokens` | `384000` | 单次最多输出 38.4 万 token |
| `compat.thinkingFormat` | `"deepseek"` | 思考参数用 DeepSeek 方言（第 18 章重点） |
| `compat.requiresReasoningContentOnAssistantMessages` | `true` | 重放历史时要带 `reasoning_content` 字段 |
| `thinkingLevelMap.high` | `"high"` | 把 Pi 的 `high` 档映射成字符串 `"high"` |
| `thinkingLevelMap.minimal/low/medium` | `null` | 这三档 DeepSeek 不支持 |

> **说明**
>
> 同文件里还有 `deepseek-v4-pro` 条目：价格为 `input 0.435` / `output 0.87` / `cacheRead 0.003625`，窗口同样是 `1000000`、上限 `384000`，`thinkingFormat` 同样是 `"deepseek"`。Pro 比 Flash 贵约 3 倍，这是真实的目录数据。

## 通用构造器：`createProvider` 与 `createModels`

工厂最关键的 `createProvider(...)` 来自 `models.ts:762`。它是一个"把零件组装成 Provider"的通用函数，所有厂商共用。它的入参接口 `CreateProviderOptions` 在 `models.ts:739-754`：

```ts
export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
  auth: ProviderAuth;                       // 必须有认证
  models: readonly Model<TApi>[];           // 静态模型列表
  fetchModels?: (...) => Promise<...>;      // 可选：动态拉模型
  filterModels?: (...) => ...;
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>; // 适配器
}
```

`createProvider` 内部做的事（`models.ts:762-862`）主要是：

1. 合并"静态模型 + 动态模型"得到 `getModels`（`models.ts:766-774`）。
2. 判断 `api` 是单个适配器还是按 `model.api` 分发的映射（`models.ts:775-779`），生成 `apiFor(model)` 分发器。
3. 返回带 `stream` / `streamSimple` / `refreshModels` / `filterModels` 的 `Provider` 对象（`models.ts:794-832`）。

也就是说，DeepSeek 那 15 行里 `createProvider({...})` 调用，最终产出一个真正能被 Pi 主循环调用的 `Provider`。DeepSeek 自己一行适配器逻辑都没写。

> **提示**
>
> `createProvider` 允许 `api` 是一张"按 `model.api` 分发"的表（`models.ts:753`）。这解释了为什么有些厂商能同时支持多种接口（比如既 OpenAI 又 Anthropic 风格）——只要传一张映射表即可。DeepSeek 是单接口，所以直接传单个 `openAICompletionsApi()`。

### createModels：另一个工厂

除了 `createProvider`，`models.ts:735` 还有 `createModels(options)`——它返回 `MutableModels`，是"管理所有 Provider 的容器"（增删查、按 `provider+model` 取模型、统一发起 `stream`）。`createProvider` 造"单个厂商"，`createModels` 造"厂商总管理处"。本书第 13 章已讲过 Pi 整体架构，这里只需记住：DeepSeek 的最终归宿是被登记进这个总管理处。

## 为什么加一个 OpenAI 兼容厂商只需 15 行 + 一份 JSON

把上面三块连起来，答案就清楚了：

```text
deepseek.ts (15 行)  ── 工厂：拼装 4 要素
   │  id / baseUrl / auth  ── 写死（每行几个字符）
   │  models  ────────────── 来自 DEEPSEEK_MODELS（JSON 展平）
   │  api  ───────────────── 来自 openAICompletionsApi()（复用）
   ▼
createProvider()  ────────── 通用构造器，所有厂商共用
   ▼
Provider<"openai-completions">  ── 可被主循环调用
```

关键在于 Pi 把"差异"全部外置到了两处：

1. **协议差异** → 由 `api`（适配器）吸收。OpenAI 兼容厂商直接复用 `openAICompletionsApi`，省掉整块协议代码（第 18 章会看到这个适配器如何把几十家厂商的"方言"用一个 `compat.thinkingFormat` 开关区分开）。
2. **模型差异** → 由 JSON 目录吸收。价格、窗口、是否支持思考、思考方言开关，全写在 `data/*.json` 里，不进代码。

所以新增一个"也是 OpenAI 兼容"的厂商（比如某个新出的 `myllm.com`），你几乎只要：

- 复制 `deepseek.ts`，把 `id`/`name`/`baseUrl`/`DEEPSEEK_API_KEY` 改成自己的；
- 写一份 `data/myllm.json`，把模型参数填进去；
- 在 `deepseek.models.ts` 同款文件里 `flattenModelCatalog("myllm", values)`。

逻辑零新增。这就是为什么 Pi 能轻松挂上 40+ 厂商——绝大多数都是"OpenAI 兼容"的复制粘贴 + 一份 JSON。

> **注意**
>
> 只有"非 OpenAI 兼容、且有特殊协议"的厂商（如 Anthropic 的 `messages` 接口、Google 的 `generateContent`、AWS Bedrock）才需要写自己的适配器文件（第 19 章的 `anthropic-messages.ts` 就是这种，上千行）。DeepSeek 因为兼容 OpenAI，才幸运地只要 15 行。

## 自查清单

- [ ] 我能背出 DeepSeek 接入文件只有 15 行（deepseek.ts:1-15）
- [ ] 我知道工厂函数回答了哪四个问题（身份/认证/模型/适配器）
- [ ] 我看到 `api: openAICompletionsApi()` 明白这是"复用 OpenAI 适配器"（deepseek.ts:13）
- [ ] 我知道密钥来自 `DEEPSEEK_API_KEY` 环境变量（deepseek.ts:11）
- [ ] 我能说出 `data/deepseek.json` 里 `deepseek-v4-flash` 的真实价格与窗口
- [ ] 我知道 `reasoning: true` 表示 DeepSeek 支持思考（deepseek.json）
- [ ] 我知道 `compat.thinkingFormat: "deepseek"` 是思考参数的方言开关
- [ ] 我理解 `flattenModelCatalog` 把 JSON 展平成 `Model` 数组（deepseek.models.ts:7-8）
- [ ] 我知道 `createProvider` 定义在 models.ts:762，是通用构造器
- [ ] 我能解释"为什么新 OpenAI 兼容厂商只需 15 行 + 一份 JSON"
