---
title: "第 32 章 · 会话树、分支、fork 与导航"
date: 2026-07-01
summary: "黑话速查：**分支（branch）**不是 Git 里的分支，而是\"从对话的某个节点另开一条新线索\"。**fork** 是\"复制某段历史、从指定节点长出新分支\"的动作。**lane** 是 Pi 对\"一条分支\"的命名叫法——可以理解为\"赛道\"，每条 lane 指向它当前最新的那个节点（叶子）。"
tags:
  - pi
---
# 第 32 章 · 会话树、分支、fork 与导航

> 黑话速查：**分支（branch）**不是 Git 里的分支，而是"从对话的某个节点另开一条新线索"。**fork** 是"复制某段历史、从指定节点长出新分支"的动作。**lane** 是 Pi 对"一条分支"的命名叫法——可以理解为"赛道"，每条 lane 指向它当前最新的那个节点（叶子）。

## 先建立直觉：为什么对话要长成一棵树？

你让 Pi 改一个 bug。它试了方案 A，不好。你想："不如从刚才那步换方案 B 试试。"如果对话只能是一条直线，你就得把方案 A 的尝试全删掉、重来；可方案 A 里的探索也许有用，不该丢。

Git 用"分支"解决同样的问题——保留旧路线，从某个提交点另开新线。Pi 的会话也是**一棵树**：

```text
                    root（会话开始）
                      │
            ┌─────────┴─────────┐
            │                   │
       方案 A 的尝试         （你在这里 fork）
            │                   │
        A 改到一半            方案 B 的新尝试
            │                   │
          leaf_a              leaf_b
```

每一条消息是一个节点，靠 `parentId` 指向上一条（回顾第 31 章的 `EntryBase`，`types.ts:14-20`）。从任意节点都能长出新分支——这就是 coding agent 需要"树状会话"的根本原因：**试错成本低，随时能回头换路**。

> **说明**
>
> **直线对话 vs 树状会话**：直线只能"一条道走到黑"，想换思路得推倒重来；树状允许"保留所有探索、随时分叉"。代码任务天然充满试错，所以 Pi 把会话设计成树，而不是列表。

## lane：给每条分支起个名字

树是一堆节点，但"当前我在哪条分支上"需要一个**指针**。Pi 用 **lane（赛道）** 来表示一条分支：每个 lane 记录它"当前叶子节点（leafId）"是谁。这样：

- 会话可以有多条 lane（多条并行分支）。
- 每条 lane 是一个从根到它 leaf 的路径。
- `main` 是默认 lane（主分支）。

`getLeafIdForLane`（`packages/agent/src/harness/session/session.ts:227`）返回某 lane 当前指向的叶子；`main` 的叶子就是整个会话最新处（`session.ts:134-136`）。lane 的叶子指针本身也是一条 `lane` 类型的 mutation，写进日志——所以"你现在在哪条分支"也是可持久化、可恢复的。

## view(lane)：切到某条分支的"视图"

当你想"只看方案 B 这条分支"，不需要把整棵树搬出来，只要一个**视图（view）**。`view(lane)` 在 `packages/agent/src/harness/session/session.ts:115`：

```ts
// packages/agent/src/harness/session/session.ts:115-132
view(lane: string): SessionTree {
  if (lane === "main") return this;
  return {
    getLeafId: () => this.getLeafIdForLane(lane),
    getEntry: (id) => this.getEntry(id),
    findEntriesOnBranch: (query) => this.queryBranchEntries(lane, query),
    appendMessage: (message) => this.appendMessageToLane(lane, message),
    // ...其余方法也限定在 lane 范围内
  };
}
```

注意 `view("main")` 直接返回整个会话本身；而 `view("别的lane")` 返回一个**窄化视图**：它的 `findEntriesOnBranch`、`appendMessage` 等都自动限定在那条分支内。上层代码拿到这个视图，就像"只在这条分支上工作"，不用操心别的分支。

### 怎么取一条分支上的所有节点？

`queryBranchEntries`（`session.ts:243`）会"从某个起点（start，默认是该 lane 的 leaf）沿 `parentId` 一路向上走到根"，把这条路径上的所有 Entry 收集出来。底层依赖于第 31 章讲的 `walkToRoot`（`state.ts:301`）——沿父链回溯、同时防环。于是"一条分支"在数学上就是"leaf 到 root 的唯一路径"。

## context 重建：把一条分支变成模型能读的消息

视图给了"哪些节点属于这条分支"，但模型要的是**一串消息**。这一步由 `packages/agent/src/harness/session/context.ts` 完成。

`buildSessionContext`（`context.ts:90`）的流程：

1. `defaultContextEntryTransform`（`context.ts:45`）：先做一件聪明事——如果路径里**有过一次 compaction**，就把那次压缩的摘要（`CompactionEntry`）提到最前面，后面只跟"压缩点之后"的节点（`:56`）。这样模型先看到摘要提纲，再看近期细节。
2. `sessionEntryToContextMessages`（`context.ts:65`）：把每个 Entry 翻译成模型消息：
   - `message` → 直接变成一条 `AgentMessage`（`:71-73`）；但 `stopReason === "deferred"` 的助手消息会被跳过（`:72`，那是"推迟写盘"的占位，不算真内容）。
   - `compaction` → 变成"压缩摘要消息 + 保留的尾部"（`:75-79`）。
   - `branch_summary` → 变成"分支摘要消息"（`:81-82`）。
   - `custom` → 交给应用自定义的投影器（`:84-85`）。
   - 其余类型（模型切换、思考级别等）在上下文里不单独成消息，返回空（`:87`）。

```text
一条分支的 Entry 路径
   │  (沿 parentId 从 leaf 走到 root)
   ▼
defaultContextEntryTransform：若有 compaction，摘要置顶
   │
   ▼
sessionEntryToContextMessages：逐个翻译成 AgentMessage
   │
   ▼
buildSessionContext 拼出 { thinkingLevel, model, activeToolNames, messages }
   │
   ▼
模型拿到这份上下文，继续干活
```

> **提示**
>
> **为什么压缩摘要要"置顶"？** 因为模型读上下文是从前往后读的。把"历史摘要"放最前，模型先建立全局认知，再读最近的具体对话——符合人"先看提纲再看细节"的理解顺序。这正对应第 30 章讲的 compaction 与分支摘要。

## fork：从任意节点开一条新分支

"分叉"的核心在 `ForkOptions`（`packages/agent/src/harness/session/types.ts:359`）：

```ts
// packages/agent/src/harness/session/types.ts:359
export type ForkOptions =
  | { scope?: "branch"; entryId?: string; position?: "before" | "at" }
  | { scope: "tree" };
```

- `scope: "branch"`（默认）：从 `entryId` 指定的那个节点（及其之前的历史）复制出来，在 `position` 处（`before`=该节点之前 / `at`=该节点处）接出新分支。
- `scope: "tree"`：复制整棵树。

生成具体变更记录的是 `createForkMutations`（`packages/agent/src/harness/session/state.ts:260`）——它算出"要复制哪些 Entry、新分支的 lane 指向哪里"，产出一串 mutation。这些 mutation 经第 31 章讲的记录日志落盘，于是新会话文件里带着 `parentSessionId`（见 `jsonl/repo.ts:142` 的 `fork`），标明"我是从哪个会话分出来的"。

> **注意**
>
> **fork 不是复制整个会话再改**：它只复制"从选定节点往回走到根"的那条路径（一条分支的历史），然后在新 lane 上继续。这样既保留了来路，又不会把无关分支也搬过来，省空间也更清晰。

## 导航：在分支之间跳来跳去

有了树和 lane，导航就是"切换当前 view(lane)"。典型流程：

1. 用户在 UI 里选"回到方案 A 那个节点"。
2. 调用 fork/切换 lane，得到一个指向方案 A 分支的视图。
3. `buildSessionContext` 用该分支的 Entry 重建模型上下文。
4. 模型在"方案 A 的状态"上继续——仿佛时间倒流到那一步，但方案 B 依然完好保留在另一分支。

这正是 coding agent 相比普通聊天机器人的杀手锏：**对话可探索、可回溯、可并行**，而不只是"越聊越长的一条河"。

## 一个更具体的树示例（带节点 id）

```text
e1 (root, user: "重构 auth")
 ├─ e2 (assistant: "先读文件")
 │   └─ e3 (tool: 读 auth.ts)
 │       └─ e4 (assistant: 改 login.ts)   ← main 的 leaf
 │
 └─ e5 (fork 自 e2, assistant: "换思路用 JWT")
     └─ e6 (tool: 读 jwt 文档)            ← lane "jwt" 的 leaf
```

- `main` lane 的 leaf 是 `e4`；`jwt` lane 的 leaf 是 `e6`。
- 调 `view("jwt")` 会得到 `e1 → e2 → e5 → e6` 这条路径的上下文。
- 在 `jwt` 分支上继续，新消息会接在 `e6` 之后，不影响 `main` 分支的 `e4`。

这棵树的每一个节点都因 `parentId` 而唯一确定父辈；lane 只是指向某个叶子的"书签"。

## 常见疑问

- **分支会不会无限增多把文件撑爆？** 每条分支只是"从某节点到根的路径"，共享大量历史节点，并不复制整棵树；只有 fork 点之后的新节点是新增的，所以开销可控。
- **压缩（compaction）和分支什么关系？** 压缩发生在某条分支上，压缩摘要作为 `CompactionEntry` 写进该分支；分支摘要（branch summary）则是离开分支时留下的"回头便签"。两者都服务于"在树状历史里高效恢复上下文"。
- **删分支吗？** Pi 的 record 日志是 append-only，历史不被删除；"放弃"一条分支通常意味着不再往它的 lane 追加，而非物理删掉节点——这保证了审计与可恢复性。

## 分支与压缩如何协作？

分支（树）和压缩（摘要）看似两件事，其实紧密配合，共同解决"历史很长但窗口有限"：

- 你在某条分支上不断对话，token 逼近上限 → 该分支触发 compaction，写入一条 `CompactionEntry`（回顾第 31 章）。
- 你离开这条分支去另一条（或 fork 新分支）→ 为被离开的分支生成 `BranchSummaryEntry`（第 30 章的分支摘要）。
- 日后回到该分支：上下文重建时，先看到"分支摘要"，再沿该分支路径看"压缩摘要 + 最近原文"，快速恢复状态。

也就是说：**compaction 负责"一条分支内部"的纵向压缩，branch summary 负责"分支之间"的横向索引**。两者都写进同一份 append-only 日志，所以无论你怎么跳、怎么压，历史都在、可恢复。

## 导航的完整生命周期示例

把前几章串起来，一次"回头换思路"的全流程是：

```text
1. 会话是一棵树，main 分支 leaf=e4（方案 A 改到一半）
2. 用户点"从 e2 另开分支"
3. fork：createForkMutations(state.ts:260) 复制 e1→e2 路径
        新 lane "jwt"，新会话文件记 parentSessionId
4. 在 jwt 分支继续：view("jwt") 限定范围（session.ts:115）
        queryBranchEntries 收集 e1→e2→e5→e6（session.ts:243）
5. buildSessionContext 把这条路径翻译成模型消息（context.ts:90）
        （若有 compaction，摘要置顶 context.ts:45）
6. 模型在 jwt 分支上继续生成，新 Entry 接在 e6 之后
7. main 分支的 e4 纹丝不动，随时可切回
```

每一步都能在前面章节找到对应的源码函数与行号。这也体现了 Pi 的整体设计哲学：**一切皆日志、一切可重放、树状可探索**。

## 与其他系统的类比

| 概念 | Git | Pi 会话 |
|---|---|---|
| 节点 | commit | Entry（带 parentId） |
| 分支 | branch | lane |
| 分叉 | fork / branch | fork（ForkOptions, `types.ts:359`） |
| 历史记录 | reflog / 对象库 | append-only JSONL 日志 |
| 压缩历史 | gc / pack | compaction（摘要替换原文） |

类比有助于理解，但注意区别：Git 分支常对应"不同代码状态"，Pi 的 lane 对应"不同对话线索"；Git 会真正删除对象，Pi 是 append-only、几乎不删。

> **提示**
>
> **为什么 coding agent 比聊天机器人更需要树？** 聊天是线性的"你问我答"；coding 是"试错—回溯—换路"的探索过程。没有分支，每次试错都要推倒重来，成本极高。Pi 把会话设计成树，正是为了匹配编码工作的真实节奏。

## 多 lane 并发探索

树状会话最实用的玩法，是一次会话里**并行试多条思路**：

```text
e1 (root)
 ├─ main:  e2 → e3 → e4    （方案 A：正则改写）
 ├─ lane2: e5 → e6         （方案 B：AST 改写）
 └─ lane3: e7 → e8         （方案 C：手写替换）
```

你不必在 A/B/C 间反复"撤销重做"，而是各开一条 lane 推进。最后比较三条分支的结果，把最好的那条"扶正"成 main。这就像论文写作时同时打三份草稿，而非反复涂改一份。

每条 lane 的 leaf 指针独立（`getLeafIdForLane`，`session.ts:227`），互不影响；`view(lane)`（`session.ts:115`）随时切换你的"工作台"。这种低成本并行，是 coding agent 相比"一次只能一条线"的工具的核心优势。

## 常见反模式

- **把会话当垃圾桶**：什么都往一条 main 上堆，从不分支，最后上下文爆炸、难以回溯。正确做法：关键决策点及时 fork。
- **过度分支**：每条小尝试都开 lane，树长得没法管理。正确做法：只在"真正要换大方向"时分支。
- **忽视压缩**：以为树能无限长。其实单条分支仍有窗口上限，该压缩（compaction）时别犹豫。
- **手动改 JSONL**：有人想手编日志"修正历史"。但 `applyMutation`（`state.ts:97`）会校验 seq/parentId，手改极易导致加载失败。改历史请用 fork。

> **注意**
>
> **理解边界**：树解决了"对话线索"的可探索性，但**文件系统层面**的代码改动仍是真实的——你在分支 A 改了文件、切到分支 B，磁盘上的文件不会自动变回 B 时刻的样子。Pi 的会话树管"对话上下文"，代码文件状态需要你或工具自己管理。别把"对话回溯"误解成"代码时光机"。

## 一页速查

- **树**：由 Entry 的 `parentId` 链成；每节点是"发生过的事"。
- **lane**：一条分支的命名，指向它的 leaf（最新节点）；`main` 是默认分支。
- **view(lane)**：返回限定在该分支的视图（`session.ts:115`）。
- **一条分支** = leaf 沿 parentId 走到 root 的唯一路径（`queryBranchEntries` + `walkToRoot`）。
- **context 重建**：`buildSessionContext`（`context.ts:90`）把分支 Entry 翻译成模型消息；compaction 摘要置顶。
- **fork**：`ForkOptions`（`types.ts:359`）指定从哪分叉；`createForkMutations`（`state.ts:260`）生成变更；新会话记 `parentSessionId`。
- **导航**：切 lane → 重建上下文 → 模型在旧状态继续，他支不失。
- **与压缩协作**：compaction 管"分支内部纵向压缩"，branch summary 管"分支间横向索引"。

把这八句话背下来，本章主干就抓住了。

## 为什么这是 Pi 的"记忆方式"

传统聊天机器人"记性"就是一段不断变长的文本；Pi 的"记忆"是一棵可分支、可压缩、可持久化的树。对话不再是"越聊越长的河"，而是"可探索的地图"——你能在地图上任一点插旗（fork）、做路标（branch summary）、把走过远的路压成图例（compaction）。理解了会话树，就理解了 Pi 为什么能胜任"长程、多步、需要反复试错"的编码任务。

## 自查清单

- [ ] 我用"树"而非"直线"解释了为什么会话要支持分支——为了低成本试错、随时回头。
- [ ] 我知道 lane 是"一条分支"的命名，记录它当前的叶子节点（leafId）。
- [ ] 我理解 `main` 是默认分支；`getLeafIdForLane`（`session.ts:227`）返回某分支的叶子。
- [ ] 我知道 `view(lane)`（`session.ts:115`）返回限定在该分支内的视图，`main` 返回整棵树。
- [ ] 我明白"一条分支"= leaf 沿 parentId 走到 root 的唯一路径，靠 `queryBranchEntries`（`session.ts:243`）+ `walkToRoot`（`state.ts:301`）收集。
- [ ] 我知道 `buildSessionContext`（`context.ts:90`）把分支 Entry 翻译成模型消息；`defaultContextEntryTransform`（`context.ts:45`）会把 compaction 摘要置顶。
- [ ] 我能说出 `sessionEntryToContextMessages`（`context.ts:65`）如何处理 message/compaction/branch_summary/custom。
- [ ] 我理解 fork 通过 `ForkOptions`（`types.ts:359`）指定从哪个节点分叉，`createForkMutations`（`state.ts:260`）生成变更，新会话记 `parentSessionId`。
- [ ] 我把"导航"串起来了：切 lane → 重建上下文 → 模型在旧状态上继续，且其他分支不失。
- [ ] 我理解 append-only 日志意味着"放弃分支"是不再追加而非物理删除。
