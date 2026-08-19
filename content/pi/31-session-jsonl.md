---
title: "第 31 章 · 会话数据模型与 JSONL 持久化"
date: 2026-07-01
summary: "黑话速查：**会话（session）**是你和 Pi 的一次完整对话过程。**持久化（persistence）**是把内存里的数据\"落盘\"到文件、断电也不丢。**append-only（只追加）**是一种日志写法：只往末尾加新记录，从不修改或删除旧的——像记账本，只能往下写，不能涂改。"
tags:
  - pi
---
# 第 31 章 · 会话数据模型与 JSONL 持久化

> 黑话速查：**会话（session）**是你和 Pi 的一次完整对话过程。**持久化（persistence）**是把内存里的数据"落盘"到文件、断电也不丢。**append-only（只追加）**是一种日志写法：只往末尾加新记录，从不修改或删除旧的——像记账本，只能往下写，不能涂改。

## 先建立直觉：会话为什么不能只存"最终结果"？

最省事的办法是：对话结束后，把"最终状态"（比如当前文件长什么样）存一份。但 Pi 不这么做，原因有两条：

1. **可恢复**：如果存到一半程序崩了，只存最终态就会彻底损坏、无法修复。而"记账本"式日志，崩了最多丢最后一条没写完的记录，前面都还在。
2. **可 fork（分叉）**：代码智能体常要"从刚才某个节点换一种思路试试"。如果只存最终结果，就回不去了；而完整记录每一步，就能从任意旧节点长出新分支。

所以 Pi 的会话本质是一份 **record 日志（record log）**：每一次"新增一条消息、开始一个操作、写了段记录"都作为一条 *mutation（变更）* 追加进文件。内存状态则随时由这些 mutation 重新算出来。

> **说明**
>
> **record 日志 = 事件溯源（event sourcing）**：不存"现在是什么"，而存"发生过什么"。要得到现在，就把所有事件按顺序重放一遍。好处是历史完整、可审计、可恢复——代价是重启时要重放。Pi 用这套思路管理会话，和很多数据库、分布式系统的底层思路一致。

## 数据模型：Entry 与 LaneRecord 两种记录

会话日志里有两种"主角"，定义在 `packages/agent/src/harness/session/types.ts`。

### Entry：会话树上的节点

每条 Entry 都带基础字段 `id / seq / parentId / timestamp`（`EntryBase`，`types.ts:14-20`）。`parentId` 指向上一条，于是所有 Entry 串成一棵**树**（下一章详讲）。Entry 有七种变体：

| 变体 | 含义 | 位置 |
|---|---|---|
| `MessageEntry` | 一条用户/助手消息 | `types.ts:22` |
| `ModelChangeEntry` | 切换了模型 | `types.ts:28` |
| `ThinkingLevelEntry` | 切换了思考强度 | `types.ts:34` |
| `ActiveToolsEntry` | 切换了启用的工具集 | `types.ts:39` |
| `CompactionEntry` | 一次上下文压缩记录 | `types.ts:44` |
| `BranchSummaryEntry` | 一条分支摘要 | `types.ts:53` |
| `CustomEntry` | 应用自定义的扩展条目 | `types.ts:61` |

七者联合为 `Entry` 类型（`types.ts:67-74`）。注意：连"改了模型""压了上下文"都是一条 Entry，因为它们都是"会话历史里发生的事"，需要被重放。

### LaneRecord：某条车道上的过程记录

除了树上的节点，还有一类记录描述"一次操作内部发生了什么"——比如一个工具什么时候开始跑、队列里排了什么。它们带 `lane` 字段，叫 `LaneRecord`（`RecordBase` 在 `types.ts:80-85`），共九种：

| 变体 | 含义 | 位置 |
|---|---|---|
| `OperationStartedRecord` | 一次操作（run/compaction/navigation）开始 | `types.ts:87` |
| `AbortRequestedRecord` | 请求中止 | `types.ts:115` |
| `OperationFinishedRecord` | 操作结束 | `types.ts:120` |
| `StepAttemptRecord` | 一轮模型尝试 | `types.ts:129` |
| `ToolStartedRecord` | 某个工具开始执行 | `types.ts:150` |
| `QueueEnqueuedRecord` | 任务入队 | `types.ts:162` |
| `QueueCancelledRecord` | 任务出队/取消 | `types.ts:178` |
| `WriteDeferredRecord` | 写入被推迟 | `types.ts:184` |
| `UsageRecord` | token 用量统计 | `types.ts:190` |

九者联合为 `LaneRecord`（`types.ts:203-212`）。

## 状态机：applyMutation 把关每一条变更

内存状态由 `SessionState`（`packages/agent/src/harness/session/state.ts:50`）维护。所有新记录都要经过 `applyMutation`（`state.ts:97`）这个"守门员"。它会做关键校验：

- **seq 必须连续**：下一条的 `seq` 必须等于当前 `sequence + 1`（`state.ts:104` 的 `if (seq !== this.sequence + 1) invalid(...)`）。这保证日志不被篡改、不丢顺序。
- **parentId 链合法**：新 Entry 的父节点必须真实存在。
- **防环**：`walkToRoot`（`state.ts:301`）沿 `parentId` 向上走，用于检测是否会形成环（树不允许有环）。

> **提示**
>
> **seq 连续 + parentId 链 = 防篡改**：如果有人手改日志文件插了一条假记录，seq 或 parentId 就会对不上，`applyMutation` 直接报错。这就是为什么 Pi 敢信任这份日志——它在加载时就校验结构完整性。

fork（从某节点分叉出新会话）也通过状态机生成变更：`createForkMutations`（`state.ts:260`）算出"复制哪些历史、以哪个节点为起点"。

## JSONL v4：每行一条 JSON 的持久化格式

Pi 把日志写成 **JSONL**——JSON Lines，即"每行一个独立 JSON 对象，行之间用换行分隔"。这种格式天然适合 append-only：新记录直接往文件末尾加一行。`packages/agent/src/harness/session/jsonl/` 目录专门负责编解码。

### 文件头

每个会话文件第一行是 header，声明 `version: 4`（即"JSONL v4"格式）。解码时 `decodeHeader`（`jsonl/codec.ts:70`）会校验版本，不支持就报错（`jsonl/codec.ts:73` 的 `value.version !== 4`）。header 还记录 `id / createdAt / cwd / parentSessionId` 等（`JsonlV4Header`，`jsonl/types.ts:47`）。

### 四种 mutation 行

除 header 外，每一行是一条 mutation，分四种 `kind`：

- `entry`：`parseEntryMutation`（`jsonl/codec.ts:131`）解析，校验 7 种 entry 类型（`ENTRY_TYPES`，`jsonl/codec.ts:7-15`）。
- `record`：`parseRecordMutation`（`jsonl/codec.ts:146`）解析，校验 9 种 record 类型（`RECORD_TYPES`，`jsonl/codec.ts:16-26`）。
- `lane`：车道指针（记录某 lane 当前叶子节点）。
- `fact`：会话级别的附注（如命名 `name`、标签 `label`），`parseFactMutation`（`jsonl/codec.ts:181`）处理。

总入口 `decodeMutation`（`jsonl/codec.ts:203`）按 `kind` 分派。编码则反过来，`encodeMutation`（`jsonl/codec.ts:229`）把 mutation 序列化成一行 JSON。

### 一段真实的会话文件长什么样

下面是一份**示意**（字段经简化，真实文件每行是一个 JSON 对象）：

```text
{"kind":"header","version":4,"id":"sess-abc","createdAt":1700000000000,"cwd":"/proj"}
{"kind":"entry","seq":1,"id":"e1","parentId":null,"type":"message","message":{"role":"user","content":"改一下登录"}}
{"kind":"entry","seq":2,"id":"e2","parentId":"e1","type":"message","message":{"role":"assistant","content":"好的，我先读文件"}}
{"kind":"record","seq":3,"id":"r1","lane":"main","type":"tool_started","tool":"read"}
{"kind":"entry","seq":4,"id":"e3","parentId":"e2","type":"message","message":{"role":"tool","content":"..."}}
{"kind":"lane","seq":5,"lane":"main","leafId":"e3"}
{"kind":"fact","seq":6,"fact":"name","name":"登录改造"}
```

注意：每行末尾有换行；`seq` 从 1 递增、连续不断；`parentId` 把 message 串成链；`lane` 行记录"main 分支现在停在 e3"。这就是一份可被完整重放的会话日志。

### 校验与报错

解码过程可能抛 `JsonlDecodeError`（`jsonl/errors.ts:4`），分 `syntax`（JSON 写坏了）和 `schema`（结构不合法）两类。文件级错误由 `invalidFile`（`jsonl/errors.ts:25`）包装成 `SessionError`。

## 两个关键工程细节：torn-tail 修复与原子发布

这两点决定了"崩溃也不丢数据"，值得细看。

### 1. torn-tail 修复（断尾修复）

如果 Pi 正在追加最后一行时进程被杀死，文件末尾就会留下一行**没写完的半截 JSON（torn tail）**。加载时 `JsonlSessionStorage.load`（`jsonl/storage.ts:69`）逐行解析，一旦发现"最后一行且是语法错误"，就判定为断尾，把前面**有效的部分**原子地重写回去（`jsonl/storage.ts:84-92`）：

```ts
// packages/agent/src/harness/session/jsonl/storage.ts:84-92
const isTornTail = index === physicalLines.length - 1 && mutationResult.error.kind === "syntax";
if (isTornTail) {
  const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
  await publishFileAtomically(fs, path, async (tempPath) => {
    fileResult(await fs.writeFile(tempPath, validPrefix), `Failed to stage torn-tail repair ${path}`);
  });
  return storage;
}
```

换句话说：**只丢那条没写完的半截，前面所有完整记录都保住**。加载器还会在文件不以换行结尾时补一个换行（`:104-106`），保证格式整齐。

### 2. 原子发布（atomic publish）

写文件时不能直接覆盖原文件——写到一半崩溃会让原文件变残缺。Pi 用 `publishFileAtomically`（`jsonl/storage.ts:33`）：

1. 先在旁边写一份临时文件 `xxx.jsonl.tmp`（`:38`）。
2. 等临时文件**完整写好**后，用 `renameFile` 一次性把临时文件改名成正式文件名（`:41`）。
3. 改名在文件系统上是"瞬间完成"的原子操作——要么旧文件在，要么新文件在，不会卡在半途。

> **注意**
>
> **为什么不直接 append？** 普通 append 已经够安全（只追加、崩了顶多断尾）。但"fork 生成新会话""修复断尾"这类需要**整文件重写**的操作，必须用临时文件 + 原子改名，否则重写途中崩溃就会毁掉整个会话。`publishFileAtomically` 注释（`jsonl/storage.ts:23-32`）说明了这一点。

### 串行化写入

所有写操作经 `enqueue`（`jsonl/storage.ts:258`）串成一条"尾部 Promise 链"（一个接一个跑），避免并发写入把行顺序打乱。`appendMutation`（`jsonl/storage.ts:267`）才是真正 `appendFile` 落盘的地方；`appendEntry`（`jsonl/storage.ts:154`）在上层拼接好 `parentId`/`seq`/`timestamp` 后再调用它。

## 仓库层：JsonlSessionRepo

之上还有一层 `JsonlSessionRepo`（`jsonl/repo.ts:109`），管"会话文件存在哪、怎么列、怎么建、怎么 fork"：

- `create`（`jsonl/repo.ts:122`）：新建会话，文件名由时间 + id 组成（`sessionFileName`，`:104`）。
- `fork`（`jsonl/repo.ts:142`）：从源会话 fork 出新会话，新会话的 header 记 `parentSessionId`。
- `prepareCreate`（`jsonl/repo.ts:190`）：拼出 header（含 `version: 4`，`:211`）和文件路径。
- `load` 时还会用 `assertJsonSerializable`（在 `session.ts:42`）确保所有元数据都是可 JSON 序列化的，防止脏数据污染日志。

## LaneRecord 到底有什么用？

前面列出九种 LaneRecord，初学者容易困惑"为什么需要它们"。简单说：Entry 记录"对话树上的节点"（发生了什么），LaneRecord 记录"一次操作执行过程中的流水账"（怎么发生的）。举例：

- 你发起一次 run，`OperationStartedRecord`（`types.ts:87`）记下"开始"，`OperationFinishedRecord`（`types.ts:120`）记下"结束"——于是你能知道这次 run 花了多久、是否中途被 `AbortRequestedRecord`（`types.ts:115`）中止。
- 模型每尝试一轮生成，会写一条 `StepAttemptRecord`（`types.ts:129`）。
- 某个工具开始跑，写 `ToolStartedRecord`（`types.ts:150`）；任务入队/取消，写 `QueueEnqueuedRecord`（`types.ts:162`）/ `QueueCancelledRecord`（`types.ts:178`）。
- 写入被推迟时写 `WriteDeferredRecord`（`types.ts:184`）；token 用量写 `UsageRecord`（`types.ts:190`）。

这些信息虽不直接喂给模型当上下文，但对**上层 UI 展示进度条、统计用量、调试"为什么这次 run 这么慢"**极其有用。它们和 Entry 一起，构成了一份"既能重放、又能审计"的完整会话档案。

## fact 变更：给会话贴标签

除了 entry/record/lane，还有一类 `fact` 变更（`jsonl/codec.ts:181`），用来写"会话级别的附注"：

- `name`：给会话起个名字（如"登录改造"），由 `setName` 写入（`jsonl/storage.ts:227-233`）。
- `label`：给某个具体节点贴标签（如把某条消息标为"关键决策"），由 `setLabel` 写入（`jsonl/storage.ts:239-252`）。

它们也是 append-only 的一行 mutation，可持久化、可恢复。这样"会话的元数据"和"会话的内容"走同一套日志机制，没有第二种存储格式需要维护。

## 元数据：JsonlSessionMetadata

每次加载会话，除了重放日志，还会产出一份 `JsonlSessionMetadata`（`jsonl/types.ts:26`），记录：

- `id` / `cwd` / `path`：会话标识、工作目录、磁盘路径。
- `modifiedAt`：文件修改时间（毫秒）。
- `sourceFormat: 3 | 4`：来源格式版本（本章聚焦 v4）。
- 可选的 `parentSessionId` / `legacyParentSessionPath` / `metadata`。

这份元数据由 `metadataFromHeader`（`jsonl/codec.ts:115`）从文件头换算而来，是仓库层 `JsonlSessionRepo` 列会话、排序、打开时依赖的"目录信息"。

## 仓库层怎么列会话、怎么避免重复创建？

`JsonlSessionRepo`（`jsonl/repo.ts:109`）还解决了两个现实问题：

1. **列出会话**：`list`（`jsonl/repo.ts:134`）遍历 cwd 对应的会话目录，读每个 `.jsonl` 文件的第一行 header，解析出元数据并**按修改时间倒序**返回（`jsonl/repo.ts:86`）。只读第一行就能知道"这是什么会话"，不必重放整个文件，很快。
2. **避免并发重复**：`claimCreateDestination`（`jsonl/repo.ts:174`）用一个内存集合记住"正在创建的目的地"，两个并发的创建请求打到同一个 `{cwd, id}` 时，后者会直接报错 `already_exists`，防止写出两份重复会话。`sessionIdExists`（`jsonl/repo.ts:226`）则做持久化的存在性检查。

> **说明**
>
> **为什么文件名带时间戳？** `sessionFileName`（`jsonl/repo.ts:104`）把 `createdAt` 的 ISO 时间里的 `:`/`.` 换成 `-`，拼成 `时间_id.jsonl`。时间戳保证"同 id 不同时间"也不会撞名，配合上面的并发锁，既安全又可读。

## 加载会话的完整流程

当你"打开一个旧会话"，底层发生什么？顺着 `JsonlSessionStorage.load`（`jsonl/storage.ts:69`）看：

1. 读整个文件，按换行拆成物理行（`:70-72`）；空文件或没有 header 直接报错（`:73-74`）。
2. 第一行必须是合法 header，`decodeHeader`（`jsonl/codec.ts:70`）校验 `version: 4`（`:73`）。
3. 从第二行开始，逐行 `parseMutation`（`jsonl/codec.ts:220`）→ `storage.applyMutation`（`jsonl/storage.ts:96`）重放，内存状态逐步重建。
4. 途中若遇到"最后一行是语法错误的半截"，判定 torn-tail 并原子修复（`:84-92`）。
5. 文件不以换行结尾则补换行（`:104-106`）。
6. 返回装好状态的 storage，上层据此重建 UI 与上下文。

整个过程没有任何"从最终状态反推"，纯粹是"重放事件日志"。这保证了**打开旧会话 = 完美复现当时一切**。

## 为什么不用数据库？

有人会问：为什么不直接用 SQLite 这类数据库存会话？Pi 选 JSONL 日志有几个现实理由：

1. **人类可读、易调试**：用任意文本编辑器打开 `.jsonl` 就能看完整历史，排查问题极方便。
2. **append-only 天然安全**：只追加、几乎不随机改写，崩溃面极小（最多丢最后半行，且能 torn-tail 修复）。
3. **可移植、可版本控制**：一个文件就是一个会话，复制/备份/放进 git 都简单。
4. **fork 友好**：新会话文件带 `parentSessionId`，分叉关系清晰，不需要复杂的数据库外键。

代价是"重放开销"和"随机查询不如数据库快"——但会话规模通常在几 MB 内，这个代价完全可以接受。这是一个典型的"为场景选最简单够用的方案"。

> **提示**
>
> **格式会演进**：header 里的 `version: 4` 就是为了兼容将来升级。今天读 v4，将来若有 v5，解码器按版本分派即可，旧文件不废。版本号是"长期可维护"的保险丝。

## 关键类型一览（速查）

| 类型 / 函数 | 作用 | 位置 |
|---|---|---|
| `EntryBase` | 所有 Entry 的共有字段（id/seq/parentId/timestamp） | `types.ts:14` |
| 7 种 Entry 变体 | 消息/模型切换/思考级别/工具集/压缩/分支摘要/自定义 | `types.ts:22-61` |
| `RecordBase` | 所有 LaneRecord 的共有字段 | `types.ts:80` |
| 9 种 LaneRecord 变体 | 操作开始/中止/结束、步骤、工具开始、队列、写延迟、用量 | `types.ts:87-190` |
| `SessionState.applyMutation` | 重放并校验每条变更（seq 连续等） | `state.ts:97` |
| `JsonlV4Header` | 文件头：version=4 + id/cwd/parent | `jsonl/types.ts:47` |
| `decodeHeader` / `decodeMutation` | 解码 header / mutation 行 | `jsonl/codec.ts:70/203` |
| `JsonlSessionStorage.load` | 加载 + torn-tail 修复 + 重放 | `jsonl/storage.ts:69` |
| `publishFileAtomically` | 临时文件 + 原子改名 | `jsonl/storage.ts:33` |
| `JsonlSessionRepo` | 会话的创建/列出/fork/加载 | `jsonl/repo.ts:109` |

把这张表和第 31 章正文对照看，能快速定位"某件事在哪实现"。

## 自查清单

- [ ] 我知道 Pi 用"record 日志（append-only）"而非"只存最终状态"，好处是可恢复、可 fork。
- [ ] 我能说出 Entry 的七种变体（消息/模型切换/思考级别/工具集/压缩/分支摘要/自定义），定义在 `types.ts:22-61`。
- [ ] 我能说出 LaneRecord 的九种变体，描述"一次操作内部的过程"，定义在 `types.ts:87-190`。
- [ ] 我理解 `applyMutation`（`state.ts:97`）校验 seq 连续（`state.ts:104`）和 parentId 链，从而防篡改。
- [ ] 我知道 JSONL = 每行一个 JSON，会话文件第一行是 `version: 4` 的 header（`jsonl/codec.ts:70-73`）。
- [ ] 我理解四种 mutation 行：`entry`/`record`/`lane`/`fact`（`jsonl/codec.ts:131-218`）。
- [ ] 我能想象一份真实会话文件的样子：每行一个 JSON，`seq` 连续、`parentId` 串链。
- [ ] 我明白 torn-tail 修复只丢最后半截（`jsonl/storage.ts:84-92`）。
- [ ] 我明白原子发布用"临时文件 + rename"，避免重写途中崩溃毁掉会话（`jsonl/storage.ts:33-46`）。
- [ ] 我知道所有写入经 `enqueue` 串行化（`jsonl/storage.ts:258`）。
