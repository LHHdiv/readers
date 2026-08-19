---
title: "第 42 章 · 遥测 telemetry 与评测 evals"
date: 2026-07-01
summary: "**黑话速查**"
tags:
  - pi
---
# 第 42 章 · 遥测 telemetry 与评测 evals

> **黑话速查**
> - **遥测（Telemetry）**：程序在运行时"上报自己干了什么"的机制，类似飞机的黑匣子。
> - **Span（跨度）**：一次有开始、有结束的操作记录，比如"跑一轮模型调用"。可嵌套成树。
> - **Attribute（属性）**：挂在 Span 上的键值对，比如"用了哪个模型""花了多少 token"。
> - **Schema（模式）**：给遥测定下的"规矩"——哪些 span 叫什么、该带哪些属性、类型是什么。
> - **Evals（评测）**：用一批固定题目反复跑智能体，看它答对没有、花多少资源，用来做回归对比。
> - **Baseline / Candidate（基线 / 候选）**：baseline 是"上一次已知良好的版本"，candidate 是"你想验证的新版本"，对比两者看出退步还是进步。
> - **回归（Regression）**：新版本比老版本更差了，这种"倒退"是评测最想抓出来的。

## 先建立直觉

前两章讲了 Pi 怎么画界面、怎么通信。但作为一个 AI 智能体，Pi 还有一个工程上极其重要的问题没解决：

**你怎么知道它"变好了"还是"变坏了"？**

靠人肉试用是不行的——智能体每次回答都有随机性，今天试 3 次觉得还行，明天改了代码，到底有没有变差？说不清。Pi 用两样东西把这件事**变成可度量、可重复**的工程：

1. **遥测（telemetry）**：让 Pi 在运行时精确记录"每一步干了什么"——调用了哪个工具、花了多少 token、思考了多久。它不是一个糊里糊涂的"log 文件"，而是一份类型安全、带 schema 的"黑匣子记录"。
2. **评测（evals）**：用一批固定题目，把真实的 Pi 会话跑起来，把"新版本"和"老版本"的结果并排比一比，自动算出通过率、token 消耗、延迟的变化。

代码分别在 `packages/telemetry/` 和 `packages/evals/`。本章就讲清楚这两样东西，以及为什么"能度量"对智能体工程是命根子。

> **说明**
>
> **普通应用监控 vs 智能体遥测**：普通监控关心"接口 QPS、报错率、延迟分位"。但智能体的关键是**每一步的决策轨迹**——它为什么调这个工具、有没有跑偏、上下文有没有爆。Pi 的遥测围绕"agent step"设计，追踪的是推理过程，而不只是 HTTP 请求。

## 遥测：一份类型安全的契约

### 核心抽象：Span 与 Context

遥测的基本单位是 `Span`——一段"有起点有终点"的操作。Pi 在 `packages/telemetry/src/index.ts` 里定义了可嵌套的结构：

```ts
// packages/telemetry/src/index.ts:14
export interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

// packages/telemetry/src/index.ts:18
export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}
```

- `startSpan`：开一个 span，callback 执行期间它就是"当前上下文"；里面还能再 `startSpan` 开子 span，自然形成调用树。
- `addEvent`：在 span 里记一个瞬时事件（比如"开始调用工具 X"）。
- `setAttributes` / `setStatus`：补充属性、标记成功或失败（`SpanStatus` 在 `index.ts:12`）。

这套接口和业界通用的 OpenTelemetry 概念一致，所以 Pi 的遥测能对接标准后端。

### 用 Schema 把"该记什么"写死

光有接口还不够——如果每个人想记什么就记什么，数据会乱成一锅粥。Pi 用 `TelemetrySchemaDefinition`（`index.ts:66`）把"有哪些 span、每个 span 该带哪些属性、类型是什么"**作为代码写下来**：

```ts
// packages/telemetry/src/index.ts:57
export interface TelemetrySpanDefinition {
	description: string;
	parents: TelemetryParentDefinition;          // 允许挂在哪些父 span 下
	startAttributes: Record<string, TelemetryStartAttributeDefinition>; // 开始时必带/可选
	endAttributes: Record<string, TelemetryAttributeDefinition>;          // 结束时补充
	events?: Record<string, TelemetryEventDefinition>;
	status: { default: "ok"; errorWhen: string };
}
```

每个属性都声明了类型（`string` / `number` / `boolean` / 数组）、是否必填、是否敏感（`sensitive`，见 `index.ts:28` 的 `TelemetryAttributeMetadata`）。`defineTelemetrySchema`（`index.ts:72`）只是个身份辅助函数，让 schema 数据在编译期就被类型系统锁死。

### 编译期类型推断：schema 当"说明书"

最巧妙的是，Pi 用 TypeScript 的高级类型把 schema **反推成函数签名**。例如 `InferStartAttributes`（`index.ts:132`）会根据定义自动算出"这个 span 的必填属性有哪些、各自什么类型"。`createTypedSpanStarter`（`index.ts:349`）利用它，让 `startSpan("某个span名", 属性, callback)` 的**属性字段在编译期就被强制检查**——少写一个必填项，编译器直接报错。注释也点明：schema "只用于类型推断，运行时不做校验"（`index.ts:347`）。

此外还有内存实现 `InMemoryTelemetryContext`（`index.ts:357`），方便在测试里把遥测录进内存数组，回头断言"这次运行确实记了某条 span"。

> **提示**
>
> **类型安全的遥测意味着什么？** 普通 `console.log("model", x)` 哪天把字段名拼错，只有运行时才发现。Pi 把字段名、类型、必填性写进 schema，IDE 和编译器能在你写代码时就拦住错误。对"长期维护、多人协作"的智能体项目，这种约束能省掉大量隐蔽 bug。

## 评测：用真实会话驱动 Pi 做回归

光有遥测还不够——你得**主动跑**才能拿到数据。Pi 的 evals 在 `packages/evals/`。

### 把 Pi 当"被测对象"跑起来

`packages/evals/src/pi-harness.ts` 的 `runPiCodingAgent`（`pi-harness.ts:109`）做了这样一件事：在一个**干净的临时目录**里，真刀真枪地启动一个 Pi 编码智能体会话，把题目（prompt）喂给它，等它跑完，再把整个过程录下来。

关键几步：

1. `resolveModelSelection`（`pi-harness.ts:46`）：决定用哪个模型（显式指定或读 `PI_PROVIDER` / `PI_MODEL` 环境变量）。评测必须固定模型，否则"分数变化"分不清是代码改的还是模型换的。
2. 建临时工作区 `mkdtemp`（`pi-harness.ts:122`），用 `SettingsManager.inMemory()` 和隔离的 session，确保**每次评测从零开始、互不污染**（`pi-harness.ts:131`、`:141`）。
3. `promptAgent`（`pi-harness.ts:90`）：调 `session.prompt(input)` 让智能体真正去推理、调工具、改文件，等它产出 assistant 文本。
4. `toTranscriptEvents`（`pi-harness.ts:58`）：把整段对话（用户消息、助手消息、工具调用、工具结果）翻译成一份**结构化事件轨迹**——这正是 evals 关心的"agent step 记录"。

最终产出一个 `SimpleHarnessResult`，里面包含：

- `output`：智能体最终回答（或自定义评分提取的结果）。
- `events`：上面那条结构化轨迹。
- `usage`：花了多少 input/output token、多少次工具调用、预估成本（`pi-harness.ts:189`）。

### 打包成可复用 Harness

`createPiCodingAgentHarness`（`pi-harness.ts:246`）把这一切包成一个标准 `Harness`，配合 `vitest-evals`（基于 vitest 的评测框架）使用。这样写评测题就像写一个测试：给定输入，断言输出满足某条件、给个分数。

> **说明**
>
> **为什么评测必须用"真实会话"而不是 mock？** 因为智能体的价值恰恰在于它和真实文件系统、真实工具、真实模型的交互。mock 掉这些，测出来的就不是 Pi 了。Pi 的 evals 直接 `createAgentSessionServices` 拉起完整运行时，所以能抓到"真实环境下才会出的退步"。

## Baseline vs Candidate：自动算出"变好还是变坏"

评测最实用的形态是**对比**。你手上有两份结果：

- **baseline**：上次发布/已知良好的版本跑出来的结果。
- **candidate**：你刚改完想验证的新版本跑出来的结果。

`packages/evals/src/vitest-evals/summary.ts` 负责把这两份观察（observation）汇总成一份可读报告。

### 观察与配对

每条 `HarnessObservation`（`summary.ts:19`）记录：属于哪个 evalSet、哪个测试、用了哪个 baseline、哪些 candidate、重复第几次、消耗多少 token / 毫秒 / 美元，以及 `outcome`（scored / errored / …）和 `score`（分数）。

`pairObservations`（`summary.ts:196`）把"同一个测试、同一轮重复"下的 baseline 和 candidate 两两配对，只有**两边都恰好一条**才配对成功，否则记一条诊断（缺失 / 重复 / 报错）。

### 三种度量的提升（lift）

`summarizeCorrectness`（`summary.ts:247`）算"通过率提升"：

```ts
// packages/evals/src/vitest-evals/summary.ts:258
const baselinePassed = baseline.score >= 1;
const candidatePassed = candidate.score >= 1;
// 统计 baselineWins / candidateWins / ties
// lift = candidatePassRate - baselinePassRate
```

`summarizeMetric`（`summary.ts:212`）则对 token、延迟、成本算均值差（`meanDelta`）。最后 `summarizeHarnessComparisons`（`summary.ts:300`）把所有 evalSet 聚合成 `HarnessComparisonReport`，`formatHarnessComparisonReport`（`summary.ts:374`）把它打印成彩色终端报告：通过率 +/- 多少个百分点、token 增减排、延迟、预估成本变化。

> **提示**
>
> **为什么同时看通过率、token、延迟、成本？** 因为"更聪明"往往意味着"更贵"。一个改动可能让通过率涨了 2%，但 token 消耗翻倍、延迟翻倍——这种"用钱堆出来的进步"要不要接受，是报告帮你一眼看清的权衡。

## 为什么"能度量"对智能体工程至关重要

把 telemetry 和 evals 连起来看，逻辑就完整了：

```
        改了 Pi 的代码 / 提示词 / 工具
                  │
                  ▼
   评测 harness 启动真实 Pi 会话跑固定题目
   (pi-harness.ts: runPiCodingAgent)
                  │
                  ▼
   运行期间 telemetry 记录每一步 span/事件/属性
   (telemetry: startSpan / addEvent / setAttributes)
                  │
                  ▼
   产出结构化轨迹 + usage(token/延迟/成本)
                  │
                  ▼
   summary.ts 把 candidate 与 baseline 配对对比
   输出：通过率 lift、token Δ、延迟 Δ、成本 Δ
                  │
                  ▼
   人类据此判断：这次改动值得合入吗？
```

没有这层度量，智能体开发会陷入"凭感觉调参"——每次改动都说不清是变好还是变坏。有了它，Pi 的演进变成了**可重复实验**：每个 PR 都能拿出一份对比报告，证明自己没把事情搞砸、或者确实带来了提升。

> **注意**
>
> **评测的陷阱：随机性**。智能体带随机采样，同一个题跑两次答案可能不同。所以 Pi 的评测支持"重复多次"（observation 里的 `repetition` 字段，`summary.ts:13`），用多次取平均来抵消偶发波动，单跑一次就下结论是不可靠的。

## 动手：写一个评测题

理解了 harness 之后，写一个评测题其实很像写一个测试。下面是个简化示例，展示"给 Pi 一个任务、判断它做对了没有"：

```ts
import { createPiCodingAgentHarness } from "@earendil-works/pi-evals/pi-harness";
import { score } from "vitest-evals";

const harness = createPiCodingAgentHarness({
	name: "fix-typescript-error",
	// 固定模型，排除"换模型"带来的分数波动
	model: { provider: "anthropic", id: "claude-sonnet-4" },
	// 自定义输出提取：从回答里抽出"是否生成了补丁"
	output: ({ response }) => ({ fixed: /diff --git/.test(response) }),
});

await score({
	harness,
	// 输入可以是一段 prompt，或 [prompt, reload] 多步序列
	input: "仓库里 build.ts 报类型错误，请修复并给出 diff",
	// 评分函数：根据 output 给 0~2 分
	score: ({ output }) => (output.fixed ? 2 : 0),
	// 重复 3 次，抵消随机性
	repeat: 3,
});
```

这里 `score` 会把 harness 跑出来的 `output` 交给评分函数，得到 `score`（通常用 `>= 1` 视为通过，对应 `summary.ts:258` 的 `score >= 1` 判定）。`repeat: 3` 让同一题跑 3 次取平均，避免一次好运掩盖真实退步。

> **提示**
>
> **题目要"可判定"，不要"凭感觉"**。好的评测题有一个客观判据：文件是否存在、测试是否通过、diff 是否符合预期。模糊的"回答得漂不漂亮"很难自动打分，也不利于回归对比。

## 报告长什么样

跑完 baseline 和 candidate 两组评测后，`formatHarnessComparisonReport`（`summary.ts:374`）会打印类似这样的终端报告（示意）：

```
Eval Comparisons
  fix-typescript-error
      Baseline  baseline
      Candidate candidate   (3/3 pairs)
      Pass rate   +12.0 pp  (candidate 88.0%, baseline 76.0%)
        Tokens    -154.3    (candidate 1820.5, baseline 1974.8)
      Latency     +210.5ms  (candidate 3200.0ms, baseline 2990.0ms)
      Est. cost   -$0.0021  (candidate $0.0180, baseline $0.0201)
```

读这张表要抓四件事：

- **Pass rate（通过率）**：核心指标，+12pp 说明新版本明显更会做题。
- **Tokens**：变少说明更省上下文，通常越好（但太少可能漏信息）。
- **Latency（延迟）**：变长 210ms，体验略差，需要权衡。
- **Est. cost（预估成本）**：变便宜了，省钱。

权衡下来：通过率涨、成本降、只慢了一点点——这是个**可以合入**的改动。如果反过来"通过率没变、token 翻倍、成本翻倍"，那就该打回重改。

> **说明**
>
> **为什么报告要彩色高亮涨跌？** `colorDelta`（`summary.ts:346`）把"变好"标绿、"变坏"标红，让人在一长串数字里一眼抓住重点。对频繁做评测的团队，这种视觉信号能大幅降低"看报告走神漏掉退步"的风险。

## 遥测如何喂给评测

前面说 telemetry 和 evals 是两样东西，但它们在评测运行时是连着的：当 `runPiCodingAgent`（`pi-harness.ts:109`）启动真实会话时，Pi 内部每一步都会 `startSpan` 记录遥测。评测框架可以挂一个 `InMemoryTelemetryContext`（`telemetry/src/index.ts:357`），把整段运行的 span 树录进内存，事后就能分析"这次跑偏是不是卡在某个工具调用上""思考阶段花了多少 token"。

也就是说：**telemetry 提供" raw 黑匣子数据"，evals 提供"对照实验框架"，summary 提供"对比结论"**。三者合起来，让 Pi 的每一次改动都站在可度量的基础上，而不是凭直觉。

## 自查清单

- [ ] 我能区分"普通应用监控"和"智能体遥测"的关注点不同（后者追踪 agent 每一步决策）。
- [ ] 我知道 Span 是什么，以及 `startSpan` / `addEvent` / `setAttributes` / `setStatus` 的用处（`telemetry/src/index.ts:14`、`:18`）。
- [ ] 我理解为什么 Pi 用 `TelemetrySchemaDefinition` 把"该记什么"写死（`index.ts:66`），以及 schema 能在编译期强制检查属性（`index.ts:132`、`:349`）。
- [ ] 我知道 `sensitive` 属性标记的意义（`index.ts:28`），用于区分是否可上报的敏感数据。
- [ ] 我理解 evals 为什么必须用"真实 Pi 会话"而不是 mock（`pi-harness.ts:109` 的 `runPiCodingAgent`）。
- [ ] 我知道评测为什么必须固定模型（`pi-harness.ts:46` 的 `resolveModelSelection`），否则分不清变化来源。
- [ ] 我理解 baseline 与 candidate 的对比逻辑，以及 `summary.ts` 如何算通过率提升、token/延迟/成本变化（`summary.ts:247`、`:212`、`:300`）。
- [ ] 我明白为什么评测要"重复多次"来抵消随机性（`summary.ts:13` 的 `repetition`）。
