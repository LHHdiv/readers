---
title: "第 30 章 · 上下文压缩 compaction（阈值/溢出/摘要）"
date: 2026-07-01
summary: "黑话速查：**上下文窗口（context window）**是模型\"一次能记住的文字总量\"，像一张固定大小的便签纸。**compaction** 是把又长又旧的对话\"压成一份摘要\"腾出空间的过程，中文常译作\"压缩\"或\"压实\"。**token** 是模型计量文字的单位，大致可理解为\"词或字片段\"。"
tags:
  - pi
---
# 第 30 章 · 上下文压缩 compaction（阈值/溢出/摘要）

> 黑话速查：**上下文窗口（context window）**是模型"一次能记住的文字总量"，像一张固定大小的便签纸。**compaction** 是把又长又旧的对话"压成一份摘要"腾出空间的过程，中文常译作"压缩"或"压实"。**token** 是模型计量文字的单位，大致可理解为"词或字片段"。

## 先说为什么非压不可

模型不是无限记忆。每次对话，所有历史消息（你说的话、它回的话、工具输出）都要原样塞进上下文窗口。窗口一旦装满，就塞不下了——新消息进不来，模型要么报错，要么开始"忘事"乱答。

但代码智能体的对话往往很长：你让它改十个文件、跑二十次命令，工具输出动辄几万字符。所以 Pi 必须学会"忘掉细节、留下要点"，这就是 compaction。它把旧对话交给另一个 LLM 读一遍，生成一份结构化摘要，再用"摘要"替换掉"原文"。

> **说明**
>
> **压掉的是"原文"，留住的是"要点"**：摘要不是随便删字，而是用 LLM 重新归纳——哪些文件改了、改到哪一步、用户要什么。模型拿着摘要，仍能接着把活干完。这就像考前把整本书提炼成复习提纲。

## 三种触发时机

Pi 在 `packages/coding-agent/src/core/agent-session.ts` 的 `_checkCompaction`（`packages/coding-agent/src/core/agent-session.ts:1962`）里判断"现在要不要压"。压缩原因有三种，类型定义在 `packages/agent/src/harness/session/types.ts:127`：

```ts
// packages/agent/src/harness/session/types.ts:127
export type CompactionReason = "manual" | "threshold" | "overflow";
```

| 触发方式 | 含义 | 代码位置 |
|---|---|---|
| `manual` | 用户/上层主动要求压缩 | 主动 emit：`agent-session.ts:1793` |
| `threshold` | 上下文用量超过阈值（快满了） | `agent-session.ts:2049` 调 `_runAutoCompaction("threshold", ...)` |
| `overflow` | 已经溢出（模型吐出的回复本身装不下） | `agent-session.ts:1994`/`1998`/`2021` 调 `_runAutoCompaction("overflow", ...)` |

- **threshold（阈值）**：核心判断在 `shouldCompact`（`packages/coding-agent/src/core/compaction/compaction.ts:235`），规则是"当前 token 数 > 窗口大小 − 预留量"就触发：

```ts
// packages/coding-agent/src/core/compaction/compaction.ts:235-237
export function shouldCompact(contextTokens, contextWindow, settings): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

- **overflow（溢出）**：当模型刚生成的回复本身就超出窗口（或接近可恢复长度），由 `isContextOverflow` 等判定（`agent-session.ts:1994`），必须立刻压，否则连结果都存不下。

> **提示**
>
> **为什么分两个自动原因？** 阈值触发是"预防性"的——还没爆就先压，体验平滑；溢出触发是"抢救性"的——已经爆了，压缩后再把超长回复重试或截断保存。两者都走 `_runAutoCompaction`，但语义和后续处理不同。

## 配置：留多少、保多少

压缩行为由一组设置控制，默认值在 `packages/coding-agent/src/core/compaction/compaction.ts` 的 `DEFAULT_COMPACTION_SETTINGS`（约 `:128-135`）：

```ts
// packages/coding-agent/src/core/compaction/compaction.ts（节选自 DEFAULT_COMPACTION_SETTINGS）
reserveTokens: 16384,     // 窗口要预留 16K token 给"正在生成"的内容
keepRecentTokens: 20000,  // 压缩时，最近约 20K token 的原文保留不动
```

- `reserveTokens`：窗口不能 100% 占满，要留一块给"模型马上要生成的回复"，否则生成到一半就爆。
- `keepRecentTokens`：压缩时，**最近**的约 20K token 原文保留，只把更早的压成摘要——越近的对话越重要，不该丢细节。

## 切点查找：从哪一刀切开？

压缩不能随便从中间切断，否则会切坏一条"工具调用—工具结果"的配对（模型问了工具、结果还没回来就被砍了，上下文就残缺）。Pi 用"切点（cut point）"概念解决。

- `isCutPointMessage`（`compaction.ts:308`）：判断某条消息是否适合作为切点。工具结果（tool result）**不能**做切点。
- `findValidCutPoints`（`compaction.ts:351`）：在一区间内找出所有合法切点。
- `findCutPoint`（`compaction.ts:403`）：从**最新往最旧**累加 token，直到累计达到 `keepRecentTokens`（约 `compaction.ts:429` 的 `accumulatedTokens >= keepRecentTokens` 判断）。意思是：保留最近的约 20000 token 原文不动，只把更早的部分压成摘要。

```text
时间 →  旧 ←─────────── 切点 ───────────→ 新
        ┌─────────────┐  ┌──────────────┐
        │ 压成摘要     │  │ 原文完整保留 │
        │ (交给 LLM)   │  │ (最近 20K)   │
        └─────────────┘  └──────────────┘
```

## 怎么压：LLM 生成结构化摘要

真正的核心是 `compact`（`packages/coding-agent/src/core/compaction/compaction.ts:817`）。流程大致是：

1. `prepareCompaction`（`compaction.ts:710`）先算出切点（`:738` 调 `findCutPoint`）。
2. 把"切点之前的历史"交给 LLM 生成摘要：`generateSummaryWithUsage`（`compaction.ts:622`）。
3. 如果切点附近有一段"单个回合太大、整体留不住"的前缀，单独用 `generateTurnPrefixSummary`（`compaction.ts:924`，提示词 `TURN_PREFIX_SUMMARIZATION_PROMPT` 在 `:795`）处理。
4. 把历史摘要 + 回合前缀摘要合并，作为新的上下文起点。

摘要提示词有两套：

- 首次摘要：`SUMMARIZATION_PROMPT`（`compaction.ts:467`）
- 增量更新（已有旧摘要，只并入新内容）：`UPDATE_SUMMARIZATION_PROMPT`（`compaction.ts:500`）。代码在 `:643` 选择用哪套——有旧摘要就用 UPDATE，否则用首次。

### 摘要失败怎么办？重试

LLM 偶尔会"偷懒"或输出不合规。Pi 用 `completeSummarization`（`compaction.ts:562`）做完整调用与校验，并在结果不合要求时**重试**。整个过程由 `generateSummaryWithUsage` 里的 `reserveTokens`（`compaction.ts:590`、`:638` 取 `0.8 * reserveTokens` 作为摘要预算）控制摘要自身占用的 token 上限。

```text
对话过长
   │
   ▼
_checkCompaction 判定 (manual / threshold / overflow)
   │
   ▼
prepareCompaction：findCutPoint 找切点（保留最近 keepRecentTokens）
   │
   ▼
generateSummaryWithUsage：旧历史 → LLM 摘要（必要时 completeSummarization 重试）
   │   （可选）generateTurnPrefixSummary：超大回合前缀 → 摘要
   ▼
合并成"摘要 + 最近原文"，替换掉旧上下文
   │
   ▼
模型拿压缩后的上下文继续干活
```

## 把"改了哪些文件"也喂给摘要

好的摘要要包含"这次会话改动了哪些文件"。工具函数在 `packages/coding-agent/src/core/compaction/utils.ts`：

- `extractFileOpsFromMessage`（`:29`）：从一条消息里抽取文件读/改操作。
- `computeFileLists`（`:62`）：汇总成"读了哪些 / 改了哪些"两份清单。
- `formatFileOperations`（`:72`）：把清单格式化成文本塞进摘要。
- `serializeConversation`（`:109`）：把对话序列化成摘要输入；其中工具结果只截取前 `TOOL_RESULT_MAX_CHARS = 2000` 字符（`:89`、`:144`），避免单个超长输出撑爆摘要请求。
- 系统提示词 `SUMMARIZATION_SYSTEM_PROMPT`（`:156`）规定摘要的"标准格式"。

## 分支摘要：离开一条支线前先留纸条

会话是树状的（下一章细讲）。当你从一条分支跳到另一条、或 fork 出新的分支时，Pi 会为"被离开的那条分支"生成一份**分支摘要（branch summary）**，方便日后回来时快速恢复上下文。相关代码在 `packages/coding-agent/src/core/compaction/branch-summarization.ts`：

- `collectEntriesForBranchSummary`（`branch-summarization.ts:108`）：收集该分支从共同祖先到分支末端的全部条目。
- `prepareBranchEntries`（`branch-summarization.ts:195`）：在 token 预算内挑出要纳入摘要的消息。
- `generateBranchSummary`（`branch-summarization.ts:293`）：调用 LLM 生成，提示词 `BRANCH_SUMMARY_PROMPT`（`:258`）。

> **说明**
>
> **普通 compaction vs 分支摘要**：前者是"对话太长，把旧的压成摘要好继续"；后者是"我要离开这条分支了，先留一份摘要，方便以后回来"。一个为了"前进"，一个为了"回头"。分支摘要最终作为 `BranchSummaryEntry` 写进会话日志（回顾第 31 章的 `types.ts:53`）。

## 一个具体例子：压缩前后

假设会话已经积累了很多轮：你让 Pi 读了 5 个文件、跑了 8 次命令、改了 3 个文件。

- **压缩前**：上下文里塞着这 16 次交互的完整原文，token 数逼近窗口上限，`shouldCompact` 返回真。
- **压缩时**：`findCutPoint` 保留最近约 20K token（比如最后两次交互），把前面 14 次交给 LLM 归纳成一份结构化摘要，类似：

```text
摘要：用户在重构 auth 模块。已读 src/auth.ts / login.ts / session.ts；
已确认用 JWT 替换 cookie；改好了 login.ts 的签发逻辑；session.ts 还没动。
下一步：把 session.ts 也改成 JWT 校验。
```

- **压缩后**：上下文开头变成"这份摘要 + 最近两次交互原文"，token 数大幅下降，模型既能接住历史要点，又有空间继续干活。

## 还有一份 harness 层的 compaction 实现

除了 `packages/coding-agent/src/core/compaction/` 这套"核心算法"，`packages/agent/src/harness/compaction/` 里还有一份 harness（宿主适配）层的实现。两者职责互补：

- 核心层（`core/compaction`）管"算法"：怎么找切点、怎么调 LLM 生成摘要、怎么合并。
- harness 层管"集成"：怎么估算当前上下文占了多少 token、何时触发、和会话存储怎么对接。

harness 层的 `shouldCompact`（`packages/agent/src/harness/compaction/compaction.ts:247-250`）和 `DEFAULT_COMPACTION_SETTINGS`（`packages/agent/src/harness/compaction/compaction.ts:158-162`）与核心层语义一致，只是服务于"已经落盘为会话日志"的场景。理解"两层分离"有助于你以后在别的项目里复用压缩算法，而不必绑定 Pi 的具体会话格式。

## token 估算：怎么知道快满了？

触发压缩的前提是"知道现在占了多少 token"。这靠 **token 估算**完成——精确分词太慢，工程上常用"近似估算"（比如按字符数 / 系数折算）。harness 层的 `estimateTokens`（`packages/agent/src/harness/compaction/compaction.ts:271-311`）就是做这件事：把当前所有消息粗略换算成 token 数，再和 `contextWindow - reserveTokens` 比较。估算不必百分百精确，只要"快满时能及时报警"就够了。

## 回合前缀（turn prefix）为什么单独处理？

有一种尴尬情况：某一次"回合"本身巨大——模型一口气生成了超长内容，连"这一回合"都放不进 `keepRecentTokens` 的保留区。此时不能简单地把整回合塞进"最近原文"，否则会爆窗。Pi 的处理是：

1. `findCutPoint` 找到切点后，切点附近可能还留着"这一超大回合的前缀"。
2. 这部分前缀单独交给 `generateTurnPrefixSummary`（`compaction.ts:924`，提示词 `TURN_PREFIX_SUMMARIZATION_PROMPT` 在 `:795`）压成摘要。
3. 最终上下文 = "历史摘要" + "回合前缀摘要" + "回合后缀（真正的近期内容）"。

换句话说，普通的 `compact`（`compaction.ts:817`）会把"历史摘要"和"回合前缀摘要"两件事都做掉，确保即使单个回合超大也能被收进窗口。这是压缩逻辑里最"兜底"的一层。

## 压缩前后的对话结构变化（Entry 视角）

从会话日志（第 31 章）的角度看，一次压缩会在日志里写入一条 `CompactionEntry`（`types.ts:44`），它记录了：

- `summary`：生成的摘要文本。
- `tokensBefore`：压缩前占用的 token 数。
- `retainedTail`：保留下来的"最近原文"消息（不进摘要，直接续在摘要后）。
- `compactionReason`：这次是 `manual` / `threshold` / `overflow` 哪一种（见 `types.ts:146`）。

于是"压缩"不是删历史，而是"在日志里钉一颗书签"：模型重建上下文时（第 32 章），遇到 `CompactionEntry` 就把摘要前置、再接 `retainedTail`。历史原文仍在日志里、可审计，只是不再逐字喂给模型。

## 压缩触发点全景

把三种触发原因放回一个时间轴，更直观：

```text
对话进行中……
   │
   ├─ token 用量爬升，但未超阈值          → 不压缩，正常继续
   │
   ├─ contextTokens > 窗口 − reserveTokens → threshold 触发（预防性）
   │        （_checkCompaction 在 agent-session.ts:2049 发现）
   │
   ├─ 模型刚生成的回复本身就装不下         → overflow 触发（抢救性）
   │        （isContextOverflow 在 agent-session.ts:1994 判定）
   │
   └─ 用户手动点"压缩"                    → manual 触发
            （主动 emit compaction_start，agent-session.ts:1793）
```

无论哪种，最终都汇入 `_runAutoCompaction`（`agent-session.ts:2058`）或对应的手动流程，调用第 30 章讲的 `compact`（`compaction.ts:817`）生成摘要。区别在于**原因会被记进 `CompactionEntry.compactionReason`**，方便日后排查"这次压缩是为啥发生的"。

## 摘要长什么样（结构示例）

`SUMMARIZATION_PROMPT`（`compaction.ts:467`）要求 LLM 产出"结构化上下文检查点摘要"。一份示意如下：

```text
# 上下文检查点摘要
## 目标
用户要在 auth 模块用 JWT 替换 cookie 鉴权。
## 已完成
- 读了 src/auth.ts、login.ts、session.ts
- 改好 login.ts 的签发逻辑（用 jsonwebtoken 签发）
## 待办 / 当前状态
- session.ts 的校验逻辑尚未改
- 尚未写测试
## 关键文件
- 已读：src/auth.ts, login.ts, session.ts
- 已改：login.ts
## 最近意图
下一步把 session.ts 也改成 JWT 校验。
```

这种"目标 / 已完成 / 待办 / 文件清单 / 最近意图"的结构，正是 `utils.ts` 的 `extractFileOpsFromMessage`（`utils.ts:29`）和 `formatFileOperations`（`utils.ts:72`）要提取并塞进摘要的内容。模型拿到它，等于拿到了一份"项目进度周报"，能立刻接手。

> **说明**
>
> **摘要不是备忘，是"可接手的上下文"**：好的压缩摘要让模型在丢掉原文后，仍能准确继续。这也是为什么 Pi 宁可花一次 LLM 调用去生成摘要，也不直接粗暴截断——截断会丢语义，摘要保住语义。

## 压缩相关术语速查

| 术语 | 含义 | 代码位置 |
|---|---|---|
| `shouldCompact` | 阈值判定：用量超窗口减预留即触发 | `compaction.ts:235` |
| `reserveTokens` | 给"正在生成"预留的 token（默认 16384） | `compaction.ts:134` |
| `keepRecentTokens` | 压缩时保留的最近原文量（默认 20000） | `compaction.ts:135` |
| `findCutPoint` | 从新往旧找切点，保留最近若干 token | `compaction.ts:403` |
| `SUMMARIZATION_PROMPT` | 首次摘要提示词 | `compaction.ts:467` |
| `UPDATE_SUMMARIZATION_PROMPT` | 增量摘要提示词 | `compaction.ts:500` |
| `completeSummarization` | 带校验与重试的摘要调用 | `compaction.ts:562` |
| `compact` | 压缩主流程：切点+摘要+合并 | `compaction.ts:817` |
| `CompactionReason` | `manual`/`threshold`/`overflow` | `types.ts:127` |
| 分支摘要 | 离开分支前留的摘要 | `branch-summarization.ts:293` |

## 自查清单

- [ ] 我知道 compaction 是为了突破"上下文窗口有限"这个硬约束。
- [ ] 我能说出三种触发原因：`manual`（手动）、`threshold`（超阈值）、`overflow`（已溢出），类型定义在 `types.ts:127`。
- [ ] 我知道 `shouldCompact`（`compaction.ts:235`）的判定是"contextTokens > 窗口 − reserveTokens"。
- [ ] 我理解 `reserveTokens=16384` 是给"正在生成"留的空，`keepRecentTokens=20000` 是保留的最近原文量（约 `compaction.ts:128-135`）。
- [ ] 我理解"切点"不能切在工具结果上：`isCutPointMessage`（`compaction.ts:308`）把关。
- [ ] 我知道 `findCutPoint`（`compaction.ts:403`）从新往旧累加，保留最近约 `keepRecentTokens` token 原文。
- [ ] 我明白摘要由 LLM 生成：首次用 `SUMMARIZATION_PROMPT`（`compaction.ts:467`），增量用 `UPDATE_SUMMARIZATION_PROMPT`（`:500`），且 `completeSummarization`（`:562`）会重试。
- [ ] 我知道工具结果在摘要输入里只截前 2000 字符：`TOOL_RESULT_MAX_CHARS`（`utils.ts:89`）。
- [ ] 我区分得开"普通 compaction（为前进）"与"分支摘要（为回头）"（见 `branch-summarization.ts`）。
