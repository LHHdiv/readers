---
title: "第 28 章 · 工具执行流水线（prepare → execute → finalize、hooks）"
date: 2026-07-01
summary: "黑话速查：所谓\"工具（tool）\"，就是让 AI 不只是动嘴、还能动手的能力——读文件、跑命令、改代码都算工具。本章要讲清楚：模型一旦决定调用工具，Pi 在背后分几步把它真正跑完。"
tags:
  - pi
---
# 第 28 章 · 工具执行流水线（prepare → execute → finalize、hooks）

> 黑话速查：所谓"工具（tool）"，就是让 AI 不只是动嘴、还能动手的能力——读文件、跑命令、改代码都算工具。本章要讲清楚：模型一旦决定调用工具，Pi 在背后分几步把它真正跑完。

## 先打个比方：点外卖的三步

你（用户）在 App 上下单，后厨接单、做菜、打包，最后骑手把餐送到你手上。Pi 调用一个工具的过程，和这几乎一模一样：

1. **备料（prepare）**：先确认这个工具叫什么、参数对不对、能不能做（比如被安全规则拦下了），这一步相当于"接单 + 检查库存"。
2. **执行（execute）**：真的去跑——读文件就真的打开文件，跑命令就真的开一个进程。相当于"开火炒菜"。
3. **收尾（finalize）**：把结果整理成模型能看懂的格式、记一笔账、决定要不要就此停下。相当于"装盒 + 贴标签 + 决定是否继续营业"。

为什么要把一步拆成三步？因为中间每一处都可以"插队"：安全检查可以拦下危险操作，日志可以记录一切，外层代码还能在收尾时改写结果。这种"在固定节点留口子"的设计，在工程里叫 **hook（钩子）**。

## 流水线在代码里的位置

整条流水线都在 `packages/agent/src/agent-loop.ts` 这一个文件里。它负责"一个回合（turn）里，把模型想调用的所有工具依次跑完"。入口函数是 `executeToolCalls`，位于 `packages/agent/src/agent-loop.ts:411`。

`executeToolCalls` 本身只做一件事：决定这一批工具调用是**顺序**跑还是**并行**跑。

```ts
// packages/agent/src/agent-loop.ts:411
async function executeToolCalls(
  currentContext, assistantMessage, config, signal, emit,
) {
  // 由配置 toolExecution 或单个工具的 executionMode 决定
  if (/* 需要顺序 */) {
    return executeToolCallsSequential(...)
  }
  return executeToolCallsParallel(...)
}
```

- 顺序执行：`packages/agent/src/agent-loop.ts:433` 的 `executeToolCallsSequential`
- 并行执行：`packages/agent/src/agent-loop.ts:489` 的 `executeToolCallsParallel`

在顺序版里你会看到经典三段式：`prepareToolCall`（`:452`）→ `executePreparedToolCall`（`:461`）→ `finalizeExecutedToolCall`（`:462`）。并行版结构相同，只是用 `Promise` 同时发起多个（`:507`/`:523`/`:524`）。

> **说明**
>
> **顺序 vs 并行**：读文件、改文件这类"会互相影响"的操作默认顺序跑，避免 A 工具改了文件、B 工具读到的却是旧内容。而多个互相独立的查询（比如同时 grep 三个关键词）可以并行，省时间。具体由 `config.toolExecution` 或工具自带的 `executionMode` 决定（`packages/agent/src/agent-loop.ts:423-425`）。

## 第一步：prepare（准备 + 安检）

`prepareToolCall` 在 `packages/agent/src/agent-loop.ts:600`。它干三件事：

1. 按名字找到对应的工具对象：`currentContext.tools?.find(...)`（约 `packages/agent/src/agent-loop.ts:607`）。
2. 校验参数是否合法：`validateToolArguments`（约 `packages/agent/src/agent-loop.ts:618`）。
3. **调用 `beforeToolCall` 钩子**（约 `packages/agent/src/agent-loop.ts:619-647`）——这是最重要的"安检口"。

`beforeToolCall` 的返回值能决定两件事：

- `block`：为真就**拦下**这次调用，工具根本不会执行（约 `packages/agent/src/agent-loop.ts:636`）。比如安全规则发现命令要删除系统目录，就可以在这里挡掉。
- `terminate`：为真就**终止整个回合**，模型不再继续（约 `packages/agent/src/agent-loop.ts:638`）。

在调用钩子之前，流水线还会用 `prepareToolCallArguments`（`packages/agent/src/agent-loop.ts:586`）把模型给的"工具调用参数"整理成工具期望的格式。这一步把模型吐出的原始 JSON 归一化，后面 `tool.execute` 拿到的就是干净、可信任的输入。

```text
模型说："我要跑 rm -rf /"
        │
        ▼
prepareToolCall
        │
        ├─ 找到工具：bash
        ├─ 校验参数：OK
        ├─ prepareToolCallArguments 归一化 (586)
        └─ beforeToolCall 钩子 (619)
                  │
                  ├─ block=true  → 工具不跑，返回"被拦截"
                  └─ block=false → 进入下一步 execute
```

## 第二步：execute（真正执行）

`executePreparedToolCall` 在 `packages/agent/src/agent-loop.ts:670`。到这一步，工具已经通过了安检，这里就一句话管总：`prepared.tool.execute(...)`，真正去干活。执行过程中还有一个 `onUpdate` 回调（约 `packages/agent/src/agent-loop.ts:683`），用来把"进度"实时推给前端——比如 bash 工具跑得久，你能看到它一点点吐出输出。

对调用方（上层 agent 循环）而言，这一步是"黑盒"：它只关心"给我结果"。具体怎么读、怎么跑，全在第 29 章那些工具内部实现里。这种"流水线不管细节、只管调度"的分工，正是让整个系统好维护的关键。

## 第三步：finalize（收尾 + 复盘）

`finalizeExecutedToolCall` 在 `packages/agent/src/agent-loop.ts:713`。这里会调用第二个钩子 **`afterToolCall`**（约 `packages/agent/src/agent-loop.ts:724-751`）。和 `before` 相反，它在"工具已经跑完"之后生效，可以：

- 覆盖返回给模型的 `content`（内容）
- 覆盖 `details`（给界面看的详情）
- 覆盖 `usage`（token 消耗）
- 标记 `isError`（是否出错）
- 设置 `terminate`（是否就此结束回合）

```ts
// packages/agent/src/agent-loop.ts:724（节选意图）
if (config.afterToolCall) {
  const afterResult = await config.afterToolCall(/* 原始结果 */);
  // afterResult 可改写 content / details / usage / terminate / isError
}
```

> **提示**
>
> **两个钩子各管一段**：`beforeToolCall` 是"动手前的闸门"，能拦能停；`afterToolCall` 是"收尾后的滤镜"，能改结果、能叫停。它们一起构成 Pi 的**扩展点（extension point）**——上层应用（比如 IDE 插件）不用改 Pi 内核，就能加权限确认、审计日志、结果脱敏等能力。

## 一批工具之间：什么时候收手？

模型一次回合可能要调好几个工具。流水线需要知道"这一批跑完没有，或是否该提前停"。相关逻辑：

- `shouldTerminateToolBatch`（`packages/agent/src/agent-loop.ts:582`）：某个结果要求终止时，整批提前结束。
- `failToolCallsFromTruncatedMessage`（`packages/agent/src/agent-loop.ts:381`）：如果上下文被截断、工具调用信息不全，就把这些调用标成失败，避免模型拿到残缺数据。
- `createToolResultMessage`（`packages/agent/src/agent-loop.ts:777`）：把一个工具的执行结果包装成一条"工具消息"，回填进对话，供模型下一轮参考。

注意 `createToolResultMessage` 这一步的微妙之处：模型在**这一轮**说"我要调用工具"，工具结果并不在模型当时的输出里。流水线跑完工具后，必须**补一条 tool 消息**放进上下文，模型下一轮读到的才是"我调了工具、结果是这样"。这就是"回填（backfill）"——对话状态由流水线闭合。

## 与 agent 循环的关系

工具流水线不是孤立的，它被包在更大的 agent 循环里：模型生成回复 → 若含工具调用 → 进 `executeToolCalls` 跑完 → 工具结果回填 → 模型再生成 → 直到不再调用工具或到达终止条件。在 `agent-loop.ts:214` 附近，你能看到主循环根据"是否需要调用工具"决定走哪条分支，工具流水线只是其中"需要调用"时的那一段。

> **说明**
>
> **一次会话里流水线跑很多次**：不要把"工具流水线"想成"只跑一次"。模型往往要"调用→看结果→再调用"来回好几轮，每一轮只要产生工具调用，就会完整走一遍 prepare→execute→finalize。流水线是被反复调用的"内循环"。

## 一张总图：从模型开口到结果回填

```text
┌─────────────────────────────────────────────────────────────┐
│                   agent 主循环（反复进行）                    │
│                                                             │
│   模型输出 assistantMessage（含若干 tool_calls）            │
│        │                                                    │
│        ▼                                                    │
│   executeToolCalls (411)                                    │
│        │  决定 sequential / parallel                        │
│        ▼                                                    │
│   for 每个 tool_call:                                       │
│        │                                                    │
│        ├─① prepareToolCall (600)                           │
│        │     ├─ 找工具 find (607)                          │
│        │     ├─ 校验参数 validate (618)                    │
│        │     ├─ 归一化参数 (586)                           │
│        │     └─ beforeToolCall 钩子 (619)                  │
│        │            ├─ block → 跳过执行                    │
│        │            └─ terminate → 结束回合                │
│        │                                                    │
│        ├─② executePreparedToolCall (670)                  │
│        │     └─ tool.execute(...) 真正干活                 │
│        │            └─ onUpdate 进度回调 (683)             │
│        │                                                    │
│        └─③ finalizeExecutedToolCall (713)                 │
│              └─ afterToolCall 钩子 (724)                   │
│                     └─ 改写内容/终止回合                   │
│                                                             │
│   汇总 → createToolResultMessage (777) 回填 tool 消息      │
│        │                                                    │
│        ▼                                                    │
│   模型下一轮读取结果，继续（可能再次进入流水线）            │
└─────────────────────────────────────────────────────────────┘
```

## 为什么这样设计？

把"准备—执行—终化"拆开，最大的好处是**责任清晰 + 可插拔**：

- 执行逻辑（怎么读文件、怎么开进程）只关心"把事做成"，不被安检、日志、统计污染。
- 安检和改写集中在 `before`/`after` 两个钩子里，想加规则改一处即可。
- 顺序/并行策略外置，未来要加"排队""限速"也只是换个调度函数。

这正是"关注点分离（separation of concerns）"——每个零件只做一件事，整个系统才容易维护、容易扩展。

## 顺序执行的内部节奏（读代码片段）

`executeToolCallsSequential`（`packages/agent/src/agent-loop.ts:433`）的核心是一个循环：每轮先把工具"准备"好，只有准备成功（没被 `block`）才执行、终化，然后才进入下一个。它的骨架大致是：

```ts
// packages/agent/src/agent-loop.ts:433（节选意图）
async function executeToolCallsSequential(...) {
  for (const toolCall of toolCalls) {
    const preparation = await prepareToolCall(...);   // ① 准备 + 安检
    if (preparation === undefined) continue;          // 被 block，跳过
    const executed = await executePreparedToolCall(preparation, signal, emit); // ② 执行
    const finalized = await finalizeExecutedToolCall(...);                    // ③ 终化
    results.push(finalized);
    if (shouldTerminateToolBatch(finalized)) break;   // 要求终止，整批收手
  }
  return results;
}
```

注意 `shouldTerminateToolBatch`（`packages/agent/src/agent-loop.ts:582`）在每轮之后检查：若某结果要求终止，后续工具调用就**不再发起**，直接收尾。这就是"批量提前结束"的实现点。

相对的，`executeToolCallsParallel`（`packages/agent/src/agent-loop.ts:489`）会先用 `Promise.all` 把多个 `prepare→execute→finalize` 一起发起，再统一收尾。它适合彼此独立的查询，但同样遵守 `beforeToolCall` 的 `block`/`terminate` 语义。

## 错误处理：工具炸了怎么办？

工具执行可能抛异常（文件不存在、命令非零退出、超时等）。流水线不会让异常"穿堂而过"毁掉整个 agent 循环，而是：

1. 异常在 `executePreparedToolCall`（`packages/agent/src/agent-loop.ts:670`）附近被捕获。
2. 在 `finalizeExecutedToolCall`（`packages/agent/src/agent-loop.ts:713`）里，这个结果被标记为 `isError: true`，并把错误信息整理成"工具返回内容"。
3. `createToolResultMessage`（`packages/agent/src/agent-loop.ts:777`）把它作为一条 tool 消息回填。

于是模型看到的是"我调用的工具报错了，原因是 X"，而不是"程序崩了"。模型可以据此自我纠正——比如换个文件路径、改用别的命令。这正是 agent 能"边试边改"的关键。

> **提示**
>
> **把错误当成一种正常的工具结果**：这是 agent 设计的常见心得。异常不该终止对话，而该变成模型能读到的反馈。Pi 在流水线里把"成功"和"失败"统一成"工具结果"两种状态，模型一视同仁地消化。

## 中途取消：signal 贯穿全程

流水线的每个执行函数都带着一个 `signal`（AbortSignal）。上层（比如用户在 UI 点了"停止"）触发取消时，`signal` 进入 `aborted` 状态，`bash` 这类会开进程的工具会监听它并杀掉子进程。这样"停止"不是粗暴杀进程，而是让流水线干净地收尾、把已产生的部分结果回填。

## 与下一章的衔接

本章讲的是"流水线怎么跑单个工具"。下一章（第 29 章）会拆开七个**具体工具**的实现——它们各自怎么读文件、怎么开 shell、怎么截断输出、怎么防止路径逃逸。理解了本章的 prepare/execute/finalize 框架，再看那些工具，你会清楚每个工具的 `execute` 内部在干什么，以及 `beforeToolCall` 这个安检口为什么是它们共同的安全闸门。

## 常见疑问

- **工具报错会怎样？** 执行阶段抛出的异常会被捕获，最终在 `finalize` 里标记为 `isError`，并以"错误内容"的形式回填给模型，模型可以据此自我纠正（比如换个命令）。
- **能不能中途取消？** 流水线的 `signal` 参数贯穿全程，上层（比如用户点了停止）发取消信号，执行中的工具会收到并中止。
- **钩子能改参数吗？** `beforeToolCall` 主要做"放行/拦截/终止"决策；真正改写执行输入的能力更多在 `afterToolCall` 的"改写结果"上。
- **顺序和并行的选择由谁定？** 由 `config.toolExecution` 或单个工具自带的 `executionMode` 决定（约 `packages/agent/src/agent-loop.ts:423-425`）。
- **一批工具之间能互相看到结果吗？** 顺序模式下，后一个工具能看到前一个的终化结果；并行模式下它们基本同时发起，互相看不到，适合独立查询。

## 一个完整案例：读文件工具调用的旅程

把前面的抽象串成一个具体例子。假设模型决定读 `src/app.ts` 的前 50 行，从"模型开口"到"结果回填"全程是：

1. 模型输出一条 assistant 消息，其中 `tool_calls` 含：`{ name: "read", arguments: { path: "src/app.ts", limit: 50 } }`。
2. 主循环发现含工具调用，进入 `executeToolCalls`（`agent-loop.ts:411`）。
3. 顺序模式：调 `prepareToolCall`（`agent-loop.ts:600`）→ 找到 `read` 工具（`agent-loop.ts:607`）→ 校验参数 → `beforeToolCall` 钩子放行。
4. `executePreparedToolCall`（`agent-loop.ts:670`）→ `read` 工具的 `execute` 真正打开文件、读前 50 行。
5. `finalizeExecutedToolCall`（`agent-loop.ts:713`）→ `afterToolCall` 钩子（若有）通过，结果标记成功。
6. `createToolResultMessage`（`agent-loop.ts:777`）把"文件内容"包成一条 tool 消息。
7. 这条 tool 消息回填进上下文，模型下一轮读到内容，继续推理。

可以看到：模型从没"直接碰文件"，它只产生了"我想读这个文件"的意图；真正的文件操作被流水线包在 prepare/execute/finalize 里，并受 hooks 监管。这种"意图与执行分离"正是 agent 可管控、可观测的基础。

> **提示**
>
> **记住这条主线**：模型产生意图 → 流水线准备（含安检）→ 工具执行 → 流水线终化（含改写）→ 结果回填 → 模型继续。五步循环，直到不再需要工具。本章的每一段代码，都在为这条主线服务。

## 钩子的典型用途清单

`beforeToolCall` / `afterToolCall` 这两个扩展点，在真实产品里常用来做这些事：

- **权限确认**：第一次调 `bash` 写文件时，弹窗问用户"允许吗？"——在 `beforeToolCall` 里拦截并等待授权。
- **安全红线**：识别到命令含 `rm -rf`、访问 `~/.ssh` 等，直接 `block`（回顾 `block` 语义在 `agent-loop.ts:636`）。
- **审计日志**：在 `afterToolCall` 里把"谁、什么时候、调了什么、结果如何"写进日志系统。
- **结果脱敏**：在 `afterToolCall` 里把工具返回里的密钥、token 抹掉再还给模型。
- **用量统计**：在 `afterToolCall` 里累加 token 消耗，用于计费或限流。

这些都是"不侵入工具本身"的外挂能力——工具只管干活，策略由宿主在钩子里注入。这正是"扩展点"的价值：**内核稳定，外层灵活**。

## 自查清单

- [ ] 我能否用"点外卖三步"解释 prepare / execute / finalize 各自在干什么？
- [ ] 我知道 `executeToolCalls` 在 `packages/agent/src/agent-loop.ts:411`，它只负责决定顺序还是并行。
- [ ] 我能说出 `beforeToolCall` 和 `afterToolCall` 的差别：`before` 在前能拦能停，`after` 在后能改写能停。
- [ ] 我理解 `block` 是"拦下这一次工具调用"，`terminate` 是"结束整个回合"。
- [ ] 我知道参数会先经 `prepareToolCallArguments` 归一化（`:586`）再交给工具。
- [ ] 我明白工具结果最终由 `createToolResultMessage`（`:777`）包装成消息**回填**进对话，供模型下一轮使用。
- [ ] 我知道流水线是被 agent 主循环反复调用的"内循环"，不是只跑一次。
- [ ] 我明白为什么要把三步拆开：责任清晰、钩子可插拔、调度策略可替换。
