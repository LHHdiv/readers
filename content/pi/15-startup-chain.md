---
title: "第 15 章 · 启动链路全解析：main → runtime → session"
date: 2026-07-01
summary: "`configureHttpDispatcher()`（`cli.ts:19`）为什么这么早？因为 Pi 用 `undici` 发 HTTP 请求，全局 dispatcher 必须在任何厂商 SDK 真正联网前设好代理/超时。`main.ts:590` 还会再设一次，等设置文件加载完后再应用最终配置。"
tags:
  - pi
---
# 第 15 章 · 启动链路全解析：main → runtime → session

第 13 章讲了 Pi 由哪些包组成，第 14 章讲了怎么把它跑起来。本章我们把"敲下 `pi`"到"会话建立"之间发生的事，**按时间顺序一刀一刀剖开**，每一步都标注真实的 `file:line`。读完后你会发现，所谓"启动"其实是一条清晰的流水线，没有魔法。

## 直觉：启动就是一条装配线

把 Pi 的启动想象成一条汽车装配线：

- **参数解析** = 收订单（你要什么车：交互式？单次问答？指定模型？）
- **选/建会话** = 找车架（复用旧会话文件，还是开个新的）
- **建 runtime** = 组装底盘（把模型接口、设置、扩展、资源加载器拼好）
- **建 AgentSession** = 装好引擎（真正能对话的会话对象）
- **进入模式** = 出厂交付（交互界面 / 打印模式 / RPC 服务模式）

下面我们沿着源码，看这五个工位分别在哪里、谁调用谁。

## 入口：从 cli.ts 到 main.ts

开发模式（`./pi-test.sh`）最终跑的是 `packages/coding-agent/src/cli.ts`。它极短，只有 21 行，核心做三件事：

1. 设置进程标题与几个环境变量（`cli.ts:12-14`）
2. 在厂商 SDK 发请求之前，先配置全局 HTTP 调度器（`cli.ts:19`，`configureHttpDispatcher()`）
3. 把命令行参数切片后交给 `main`（`cli.ts:21`）

```ts
// packages/coding-agent/src/cli.ts:21
main(process.argv.slice(2));
```

`process.argv.slice(2)` 去掉 Node 路径和脚本路径，剩下的就是你传给 `pi` 的参数（如 `"hello"`、`--model xxx`）。

> `configureHttpDispatcher()`（`cli.ts:19`）为什么这么早？因为 Pi 用 `undici` 发 HTTP 请求，全局 dispatcher 必须在任何厂商 SDK 真正联网前设好代理/超时。`main.ts:590` 还会再设一次，等设置文件加载完后再应用最终配置。

## 第一工位：参数解析（parseArgs）

`main` 函数在 `packages/coding-agent/src/main.ts:569` 定义：

```ts
// packages/coding-agent/src/main.ts:569
export async function main(args: string[], options?: MainOptions) {
```

进函数后很快来到参数解析（`main.ts:609`）：

```ts
// packages/coding-agent/src/main.ts:609
const parsed = parseArgs(args);
```

`parseArgs` 来自 `./cli/args.ts`，它把字符串参数解析成结构化对象 `Args`（包含 `mode`、`print`、`model`、`sessionId`、`help` 等字段）。解析出的诊断信息会在 `main.ts:610-618` 打印，遇到错误项直接 `process.exit(1)`。

随后在 `main.ts:640` 决定**应用模式（appMode）**：

```ts
// packages/coding-agent/src/main.ts:640
let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
```

`resolveAppMode`（`main.ts:118-129`）的逻辑很直白：显式 `--mode rpc/json` 优先；有 `--print` 或非 TTY 则走 `print`；否则默认 `interactive`（交互 TUI）。这一步决定了流水线最后"交付"哪种形态。

## 第二工位：选 / 建会话（createSessionManager）

会话（session）是"一次对话的历史记录"，持久化在磁盘上（见第 13 章的 `session-backends`）。`main.ts:678` 创建会话管理器：

```ts
// packages/coding-agent/src/main.ts:678
let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
```

`createSessionManager` 定义在 `main.ts:360`，它内部根据你的参数决定"复用哪个旧会话"还是"开新会话"。例如 `--resume` 时调用交互式选择（`main.ts:419`）：

```ts
// packages/coding-agent/src/main.ts:419
const selectedPath = await selectSession(
  (onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
  (onProgress) => SessionManager.listAll(sessionDir, onProgress),
  settingsManager,
);
```

其他分支还有 `--continue`（继续最近会话，`main.ts:435`）、`--session-id`（按 ID 打开或新建，`main.ts:439` 起），默认则 `SessionManager.create(...)`（`main.ts:450`）开全新会话。无论如何，最终都得到一个 `SessionManager` 对象，它知道会话存在哪、当前 cwd 是什么。

> **提示 · 为什么"选会话"要在"建 runtime"之前**
>
> `runtime` 里要加载**项目级**的设置、扩展、模型。而 `--resume`/`--session` 可能指向**另一个项目**的会话，cwd 不同，项目级配置就不同。所以必须先定好"这次会话属于哪个目录"（第二工位），再去构造依赖 cwd 的 runtime（第三工位）。`main.ts:668-677` 的注释正是这个意思。

## 第三工位：构建 runtime（createAgentSessionRuntime）

拿到 `sessionManager` 后，`main.ts:843` 调用 `createAgentSessionRuntime`：

```ts
// packages/coding-agent/src/main.ts:843
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: sessionManager.getCwd(),
  agentDir,
  sessionManager,
});
```

`createAgentSessionRuntime` 本身在 `packages/coding-agent/src/core/agent-session-runtime.ts:414`：

```ts
// packages/coding-agent/src/core/agent-session-runtime.ts:414
export async function createAgentSessionRuntime(
  createRuntime: CreateAgentSessionRuntimeFactory,
  options: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: SessionStartEvent },
): Promise<AgentSessionRuntime> {
  assertSessionCwdExists(options.sessionManager, options.cwd);
  const result = await createRuntime(options);
  return new AgentSessionRuntime(result.session, result.services, createRuntime, result.diagnostics, result.modelFallbackMessage);
}
```

注意它收到一个工厂函数 `createRuntime` 并回调它（`agent-session-runtime.ts:424`）。这个工厂是在 `main.ts:715` 定义的匿名函数 `CreateAgentSessionRuntimeFactory`，它才是真正"装配底盘"的地方。工厂内部依次做两件事：

### 工厂内第 1 步：建服务（createAgentSessionServices）

```ts
// packages/coding-agent/src/main.ts:734
const services = await createAgentSessionServices({
  cwd, agentDir, settingsManager: runtimeSettingsManager,
  modelRuntimeSignal: AbortSignal.timeout(15_000),
  extensionFlagValues: parsed.unknownFlags,
  resourceLoaderReloadOptions: { ... },
  resourceLoaderOptions: { ... },
});
```

`createAgentSessionServices` 定义在 `packages/coding-agent/src/core/agent-session-services.ts:135`，它负责产出一组"服务"（`AgentSessionServices`，结构见 `agent-session-services.ts:73`）：

- `modelRuntime`：大模型运行时（加载密钥、注册扩展提供的厂商），`agent-session-services.ts:140-146`
- `settingsManager`：设置管理器
- `resourceLoader`：资源加载器（扩展、技能、主题、提示模板），`agent-session-services.ts:148-154`
- `diagnostics`：收集到的告警/错误

### 工厂内第 2 步：建会话对象（createAgentSessionFromServices）

```ts
// packages/coding-agent/src/main.ts:819
const created = await createAgentSessionFromServices({
  services, sessionManager, sessionStartEvent,
  model: sessionOptions.model, thinkingLevel: sessionOptions.thinkingLevel,
  scopedModels: sessionOptions.scopedModels, tools: sessionOptions.tools,
  excludeTools: sessionOptions.excludeTools, noTools: sessionOptions.noTools,
  customTools: sessionOptions.customTools,
});
```

`createAgentSessionFromServices`（`agent-session-services.ts:202`）只是薄薄一层转发，它调用 SDK 里的真正构造函数 `createAgentSession`：

```ts
// packages/coding-agent/src/core/agent-session-services.ts:205
return createAgentSession({
  cwd: options.services.cwd,
  agentDir: options.services.agentDir,
  modelRuntime: options.services.modelRuntime,
  settingsManager: options.services.settingsManager,
  resourceLoader: options.services.resourceLoader,
  sessionManager: options.sessionManager,
  model: options.model, thinkingLevel: options.thinkingLevel,
  /* ... */
});
```

`createAgentSession` 定义在 `packages/coding-agent/src/core/sdk.ts:169`，是真正把"引擎"（能对话的 `AgentSession`）造出来的地方。至此，会话对象 `session` 已经可用。

## 第四工位：解包 runtime，进入模式

工厂返回后，`createAgentSessionRuntime` 把 `session` + `services` 包进 `AgentSessionRuntime` 对象（`agent-session-runtime.ts:425-431`）。回到 `main.ts:843` 拿到 `runtime`，`main.ts:849` 解构出 `session`：

```ts
// packages/coding-agent/src/main.ts:849
const { services, session, modelFallbackMessage } = runtime;
```

之后 `main` 会做收尾（应用代理设置、打印帮助、列模型、读管道输入、准备初始消息等），最后**按 appMode 进入对应模式**（`main.ts:923-959`）：

```ts
// packages/coding-agent/src/main.ts:925
if (appMode === "rpc") {
  printTimings();
  await runRpcMode(runtime);
} else if (appMode === "interactive") {
  const interactiveMode = new InteractiveMode(runtime, { /* ... */ });
  // ...
  await interactiveMode.run();
} else {
  // print / json 模式
  const exitCode = await runPrintMode(runtime, { /* ... */ });
}
```

- `--mode rpc` → `runRpcMode`（`main.ts:925`）：以 JSON-RPC 服务模式运行，供其他进程驱动。
- 默认交互 → `new InteractiveMode(runtime, ...)` 并 `run()`（`main.ts:927`）：真正的 TUI 界面，你在这里和 Pi 对话。
- 非 TTY / `--print` → `runPrintMode`（`main.ts:959`）：一次性问答后退出。

> **说明 · runtime 与 session 的区别**
>
> `AgentSessionRuntime`（`agent-session-runtime.ts:74`）是"外壳"——装着 session、services、扩展工厂、诊断信息，负责在 reload/切换会话时重建。而 `session`（`AgentSession`，由 sdk.ts:169 造出）是"内核"——代表一次具体对话、能真正发消息给模型。简单说：**runtime 管"怎么把会话跑起来"，session 管"这次对话本身"**。

## 启动时序 ASCII 图

把上面五个工位按时间从上到下连起来：

```
时间 ↓
[0] shell ──▶ ./pi-test.sh ──tsx──▶ cli.ts:21 main(argv.slice(2))
                                          │
[1]                                        ▼
                                  main.ts:569  main()
                                          │
[2]                                        ▼ 参数解析
                                  main.ts:609  parseArgs(args)
                                          │
[3]                                        ▼ 定模式
                                  main.ts:640  resolveAppMode()
                                          │
[4]                                        ▼ 选/建会话
                                  main.ts:678  createSessionManager()
                                     (内部 selectSession @ main.ts:419)
                                          │
[5]                                        ▼ 建 runtime
                                  main.ts:843  createAgentSessionRuntime()
                                          │ 回调工厂 main.ts:715
                                          ├─▶ main.ts:734  createAgentSessionServices()
                                          │       (agent-session-services.ts:135)
                                          ├─▶ main.ts:819  createAgentSessionFromServices()
                                          │       (agent-session-services.ts:202)
                                          │            └─▶ sdk.ts:169  createAgentSession()
                                          ▼
                                  agent-session-runtime.ts:425  new AgentSessionRuntime()
                                          │
[6]                                        ▼ 进入模式
                                  main.ts:925  runRpcMode(runtime)        ── RPC 模式
                                  main.ts:927  new InteractiveMode().run() ── 交互 TUI
                                  main.ts:959  runPrintMode(runtime)       ── 打印/JSON
```

调用层次（谁在谁内部被调用）也可压缩成：

```
main()                          main.ts:569
 ├─ parseArgs()                 main.ts:609
 ├─ resolveAppMode()            main.ts:640
 ├─ createSessionManager()      main.ts:678  → selectSession()  main.ts:419
 └─ createAgentSessionRuntime() main.ts:843
      └─ createRuntime 工厂      main.ts:715
           ├─ createAgentSessionServices()   main.ts:734  (agent-session-services.ts:135)
           └─ createAgentSessionFromServices() main.ts:819 (agent-session-services.ts:202)
                └─ createAgentSession()        sdk.ts:169
      → new AgentSessionRuntime()  agent-session-runtime.ts:425
 └─ 按 appMode 进入模式          main.ts:923-959
```

## 给调试者的实用落点

如果你要定位"启动到哪步出问题"，按这个顺序打日志/断点最快：

| 想看什么 | 断点/日志位置 |
|----------|---------------|
| 参数解析结果 | `main.ts:609` 之后的 `parsed` |
| 最终模式 | `main.ts:640` 的 `appMode` |
| 选了/建了哪个会话 | `main.ts:678` 的 `sessionManager`；`main.ts:419` 的 `selectedPath` |
| runtime 装配的输入 | `main.ts:734` 的 `services` |
| 真正造出的会话 | `sdk.ts:169` 的返回值、`main.ts:849` 的 `session` |
| 走到哪种模式 | `main.ts:923` / `927` / `959` |

> **注意 · 别在 createRuntime 工厂外直接 new AgentSession**
>
> `createAgentSession` 被故意包在 `createAgentSessionServices` → `createAgentSessionFromServices` → `createAgentSessionRuntime` 这一串里，目的是保证"先有服务、后有会话、最后才进模式"的顺序。直接在外面手写 `createAgentSession` 容易漏掉扩展注册、模型刷新、信任提示等步骤，导致行为不一致。

## 自查清单

- [ ] 我知道 cli.ts 只有 21 行，核心是 `cli.ts:21` 调 `main(process.argv.slice(2))`
- [ ] 我能说出启动五个工位：参数解析 → 选/建会话 → 建 runtime → 建 session → 进模式
- [ ] 我知道参数解析在 `main.ts:609`，模式判定在 `main.ts:640`
- [ ] 我知道会话选择在 `main.ts:678`，`--resume` 的选择逻辑在 `main.ts:419`
- [ ] 我知道 `createAgentSessionRuntime` 在 `main.ts:843` 与 `agent-session-runtime.ts:414`
- [ ] 我理解 `createRuntime` 工厂（main.ts:715）内部依次调 `createAgentSessionServices`（:734）和 `createAgentSessionFromServices`（:819）
- [ ] 我知道真正造出会话的是 `core/sdk.ts:169` 的 `createAgentSession`
- [ ] 我能区分 `AgentSessionRuntime`（外壳）与 `AgentSession`（内核）
- [ ] 我知道三种模式入口：rpc @925、interactive @927、print @959
