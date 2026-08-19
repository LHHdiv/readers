---
title: "第 27 章 · harness 基础设施（ExecutionEnv、文件/Shell、工具上下文）"
date: 2026-07-01
summary: "前面几章讲了模型怎么循环、怎么认证明、怎么校验参数。但有一个最朴素的问题一直没回答：**工具真正\"干活\"时，读文件、跑 bash 这些能力从哪来？** 答案就是 `harness`（意为\"马具/承载框架\"）。它是 Pi agent 的\"手脚\"——一套与具体 app 解耦的执行环境基础设施。本章讲清楚 harnes…"
tags:
  - pi
---
# 第 27 章 · harness 基础设施（ExecutionEnv、文件/Shell、工具上下文）

> 前面几章讲了模型怎么循环、怎么认证明、怎么校验参数。但有一个最朴素的问题一直没回答：**工具真正"干活"时，读文件、跑 bash 这些能力从哪来？** 答案就是 `harness`（意为"马具/承载框架"）。它是 Pi agent 的"手脚"——一套与具体 app 解耦的执行环境基础设施。本章讲清楚 harness 是什么、`ExecutionEnv` 接口长什么样、Node 版怎么用子进程跑命令、以及工具上下文契约。

## 1. 先建立直觉：harness 是 agent 的"身体"

模型在云端，它只能"说话"（输出文本和工具调用名+参数）。真正**落地执行**——读磁盘、跑 shell、改文件——必须有个"身体"在本地或某台机器上代劳。这个身体就是 harness：

```text
模型（云端，只输出 JSON 工具调用）
        │  "请读 /a/b.txt"
        ▼
Agent 核心循环（第 25 章）
        │  prepareToolCall → validate → execute
        ▼
harness 工具（bash / read / write / edit）
        │  调用 ExecutionEnv
        ▼
ExecutionEnv（文件系统 + Shell 的具体实现，如 NodeExecutionEnv）
        │  node:fs / node:child_process
        ▼
真实操作系统：磁盘、进程
```

> **提示 · 黑话速查**
>
> - **harness**：承载 agent 执行能力的骨架，含文件系统、Shell、基础工具。
> - **ExecutionEnv**：harness 的核心接口，同时是"文件系统 + Shell"。
> - **FileSystem / Shell**：`ExecutionEnv` 拆开来的两个能力面。
> - **Result<T, E>**：不抛异常、用 `{ok:true,value}` / `{ok:false,error}` 表示成败的容器（`types.ts:6-22`）。

## 2. 为什么用 `Result` 而不是抛异常？

harness 里几乎所有文件/命令操作都返回 `Result` 而非 `throw`：

```ts
// packages/agent/src/harness/types.ts:6-22
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> { return { ok: true, value }; }
export function err<TValue, TError>(error: TError): Result<TValue, TError> { return { ok: false, error }; }
```

好处：**文件系统失败（文件不存在、权限不足）是常态而非异常**，用 `Result` 让调用方必须显式处理 `ok` 分支，避免"未捕获异常把整个 agent 打断"。错误还被归一成跨后端的稳定码（`FileErrorCode`，`types.ts:132-140`，如 `not_found`/`permission_denied`），这样上层逻辑不用关心是 Node 还是浏览器、是 Linux 还是 Windows。

## 3. ExecutionEnv：文件 + Shell 的统一接口

`ExecutionEnv` 极简——它就是 `FileSystem` 和 `Shell` 的交集：

```ts
// packages/agent/src/harness/types.ts:315
export interface ExecutionEnv extends FileSystem, Shell {}
```

### 3.1 FileSystem 能力面（`types.ts:231-283`）

关键方法（全部返回 `Result`，永不 throw）：

- `cwd`：当前工作目录。
- `readTextFile` / `readBinaryFile` / `readTextLines`（支持 `maxLines` 增量读）。
- `writeFile` / `appendFile` / `renameFile`。
- `fileInfo` / `listDir` / `canonicalPath` / `exists`。
- `createDir` / `remove` / `createTempDir` / `createTempFile`。
- `cleanup()`：释放资源。

契约强调（`types.ts:222-230`）：路径可以是相对 `cwd` 的，返回的 `path` 是"带地址的命名空间路径"但不自动解符号链接；**所有操作永不抛**，失败一律编码进 `Result`。

### 3.2 Shell 能力面（`types.ts:304-312`）

```ts
// packages/ai/.../harness/types.ts:304-312
export interface Shell {
  exec(command, options?): Promise<Result<{ stdout; stderr; exitCode }, ExecutionError>>;
  cleanup(): Promise<void>;
}
```

`ShellExecOptions`（`types.ts:286-301`）支持 `cwd` / `env` / `inheritEnv` / `timeout`（秒）/ `abortSignal` / `onStdout` / `onStderr` 回调。也就是说：跑命令能超时、能中止、能实时拿到输出碎片。

## 4. NodeExecutionEnv：用子进程跑 bash

`packages/agent/src/harness/env/nodejs.ts` 是 `ExecutionEnv` 的 Node 实现。核心在 `exec`（`nodejs.ts:367-500`）。

### 4.1 子进程 + 进程树杀死

```ts
// packages/agent/src/harness/env/nodejs.ts:418-428
child = spawn(
  shellConfig.value.shell,
  commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
  { cwd, detached: process.platform !== "win32", env: getShellEnv(...), stdio: [...], windowsHide: true },
);
if (child.pid) this.activeChildPids.add(child.pid);
```

命令通过 `spawn` 启动一个 bash 子进程。关键点 `detached`（非 Windows 下），使子进程拥有独立进程组，便于整组杀掉。

```ts
// packages/agent/src/harness/env/nodejs.ts:253-276
function killProcessTree(pid: number): void {
  ...
  try { process.kill(-pid, "SIGKILL"); }   // 杀整个进程组
  catch { try { process.kill(pid, "SIGKILL"); } catch { /* 已死 */ } }
}
```

`killProcessTree` 用 `process.kill(-pid)` 一次性杀掉整个进程**树**——因为 bash 命令可能又 fork 出子进程（比如 `sleep 100 &`），只杀 bash 会留下孤儿进程继续跑。`cleanup()`（`nodejs.ts:691-695`）在结束时遍历 `activeChildPids` 全部清掉。

### 4.2 超时与中止

```ts
// packages/agent/src/harness/env/nodejs.ts:440-448
timeoutId = timeoutMs !== undefined
  ? setTimeout(() => { timedOut = true; if (child?.pid) killProcessTree(child.pid); }, timeoutMs)
  : undefined;
```

超时到点就杀进程树，返回 `ExecutionError("timeout", ...)`（`nodejs.ts:487-489`）。中止则通过 `abortSignal` 监听（`nodejs.ts:450-456`）：信号一触发，`onAbort` 立刻 `killProcessTree`。这保证"用户点停止"能真正切断底层命令，而非只在模型层掐断。

### 4.3 跨平台 shell 探测

`getShellConfig`（`nodejs.ts:196-238`）很务实：Windows 上找 Git Bash，找不到再 `where bash`；Linux/macOS 优先 `/bin/bash`；都没有就退化到 `sh -c`。`getShellEnv`（`nodejs.ts:240-251`）则决定环境变量的继承策略（`inheritEnv` 默认 true，合并 process.env）。

### 4.4 文件操作与"永不抛"

以 `readTextFile` 为例（`nodejs.ts:502-511`）：

```ts
async readTextFile(path, abortSignal?) {
  const resolved = resolvePath(this.cwd, path);
  const aborted = abortResult<string>(abortSignal, resolved);
  if (aborted) return aborted;
  try { return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal })); }
  catch (error) { return err(toFileError(error, resolved)); }   // 失败 → err，不抛
}
```

任何底层 `node:fs` 异常都被 `toFileError`（`nodejs.ts:97-121`）映射成稳定的 `FileError` 码（ENOENT→`not_found`、EACCES→`permission_denied` 等）。这就是 `Result` 契约在 Node 端的落地。

## 5. 工具与"工具上下文"契约

harness 自带四个基础工具工厂：`createBashTool` / `createReadTool` / `createWriteTool` / `createEditTool`。它们的签名统一为 `AgentHarnessTool`：

```ts
// packages/agent/src/harness/types.ts:81-94
export type AgentHarnessTool<TContext, TParameters, TDetails> =
  Omit<AgentTool<TParameters, TDetails>, "execute"> & {
    execute(toolCallId, params, signal, onUpdate, context: TContext): Promise<AgentToolResult<TDetails>>;
  };
```

和普通 `AgentTool` 不同，harness 工具的 `execute` **多了一个 `context` 参数**——这就是"工具上下文契约"：工具不直接依赖全局，而是从 `context.env`（`ExecutionEnv`）拿文件/Shell 能力（`types.ts:97-99` 的 `AgentHarnessToolContextSource` 说明 context 可以是静态值或每轮快照函数）。

### 5.1 bash 工具（`bash.ts:51-161`）

```ts
// packages/agent/src/harness/tools/bash.ts:11-14
const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});
```

`execute`（`bash.ts:59-159`）先 `validateTimeout`，再把命令交给 `executeShellWithCapture`（实时捕获 stdout 并支持 `onUpdate` 增量推送）。输出会被截断到 `DEFAULT_MAX_LINES` 行或 `DEFAULT_MAX_BYTES`（`bash.ts:57` 描述），超长部分存到临时文件并附上路径。退出码非零会抛错（`bash.ts:152-154`），让模型知道命令失败了。

### 5.2 read / write / edit 工具

- `createReadTool`（`read.ts:45-144`）：支持文本（带 `offset`/`limit` 分页、超长截断）和图片（编码为 `image` 块回传）。
- `createWriteTool`（`write.ts:15-39`）：写文件，自动建父目录，且套了 `withFileMutationQueue`（防并发写同一文件）。
- `createEditTool`（`edit.ts:77-127`）：用"精确文本替换"做编辑（`edits[]` 每个 `oldText` 必须唯一、不重叠），并在内部用 diff 生成回显（`edit.ts:115-122`）。它还带 `prepareArguments`（`edit.ts:48-64`）把老式 `{oldText,newText}` 兼容转成 `edits[]`。

## 6. 为什么 harness 有一套工具，coding-agent 又有一套

你会发现 Pi 里存在**两套工具**：harness 里的 `bash/read/write/edit`（基础版），以及 coding-agent 包里面向 CLI 的"增强版"。原因有三：

1. **解耦与复用**：harness 的 `createXxxTool` 是**自包含**的——只依赖 `ExecutionEnv` 接口，不依赖任何具体 app。任何把 Pi 嵌进自己产品的开发者，都能直接拿到这套能跑 bash、读写文件的基础工具，而不必重写。它是"通用身体"。
2. **可替换的执行后端**：因为工具只认 `ExecutionEnv` 接口，底层可以是 `NodeExecutionEnv`（本地）也可以是浏览器/远程沙箱实现。harness 把"能力"和"实现"分开。
3. **增强版叠加应用语义**：coding-agent 是 Pi 自带的 CLI 应用，它在 harness 基础工具之上叠加了**应用专属**行为——比如权限确认 UI、把 `edit` 的 diff 直接做成 PR、限定可访问的仓库根目录、增加更多工具（grep、glob、task 管理等）。增强版不直接碰 `node:fs`，而是复用 harness 的 `ExecutionEnv` 与基础工具，再包一层策略。

简言之：**harness 是"人人可用的标准手脚"，coding-agent 是"为这个具体 app 调校过的专业手脚"**。基础版保证"能用"，增强版保证"用得安全、用得贴合场景"。

> **说明 · 工具上下文契约的意义**
>
> 所有 harness 工具都通过 `context.env` 拿能力，而非全局变量或 `require('fs')`。这让工具**可测试**（注入假 `ExecutionEnv`）、**可替换后端**（本地/远程）、**可组合**（增强版在基础版外再包一层）。这是 harness 设计里最值得借鉴的一点。

## 7. 全景串联

```text
Agent（第 26 章）
   │  runAgentLoop → 双层 while（第 25 章）
   │     prepareToolCall → validateToolArguments（第 23 章）
   ▼
executeToolCall → harness 工具.execute(id, params, signal, onUpdate, context)
   │  context.env 是 ExecutionEnv
   ▼
NodeExecutionEnv（env/nodejs.ts）
   ├─ 文件: readTextFile/writeFile/...  →  node:fs，返回 Result
   └─ Shell: exec(command)              →  spawn bash，进程树杀死 / 超时 / 中止
```

## 自查清单

- [ ] 我能说出 harness 在 Pi 架构里的角色（agent 的"身体"/执行骨架）。
- [ ] 我知道 `ExecutionEnv = FileSystem + Shell`（`types.ts:315`）。
- [ ] 我理解 harness 为什么用 `Result` 而非抛异常（`types.ts:6`，跨后端稳定错误码）。
- [ ] 我能在源码定位 `NodeExecutionEnv.exec`（`nodejs.ts:367`）、`killProcessTree`（`nodejs.ts:253`）、超时逻辑（`nodejs.ts:440`）。
- [ ] 我知道 harness 工具 `execute` 多出的 `context` 参数就是"工具上下文契约"（`types.ts:81-94`）。
- [ ] 我能解释为什么有两套工具（harness 基础版可复用 vs coding-agent 增强版叠加应用语义）。
- [ ] 我理解 harness 工具只依赖 `ExecutionEnv` 接口、不依赖具体 app 的价值。
