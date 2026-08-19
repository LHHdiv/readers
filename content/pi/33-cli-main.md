---
title: "第 33 章 · CLI 与主入口 main.ts"
date: 2026-07-01
summary: "约定：本章所有行号都来自 `packages/coding-agent/src/` 下的真实源码。CLI 入口相关文件主要有三个：`cli.ts`、`main.ts`、`cli/args.ts`。"
tags:
  - pi
---
# 第 33 章 · CLI 与主入口 main.ts

在前面几章里，我们已经从“用户敲下 `pi` 这条命令”开始，一路看到了 Pi 的启动链条。本章把镜头聚焦到**最贴近操作系统的那一层**：命令行入口。它会做四件事——**解析参数 → 选择/恢复会话 → 创建运行环境（runtime）→ 分发到运行模式**。理解这一章，你就拿到了 Pi 整个“产品层”（`packages/coding-agent`）运转的总钥匙。

> 约定：本章所有行号都来自 `packages/coding-agent/src/` 下的真实源码。CLI 入口相关文件主要有三个：`cli.ts`、`main.ts`、`cli/args.ts`。

## 33.1 入口在哪：从进程启动到 main()

`pi` 安装后本质上是一个 Node/Bun 可执行脚本。操作系统把用户在命令行输入的参数放进 `process.argv`，其中一个文件负责“把参数交给主逻辑”。

`packages/coding-agent/src/cli.ts` 极短，只有 22 行，全文核心只有两行：

```ts
// packages/coding-agent/src/cli.ts:21
main(process.argv.slice(2));
```

它做的事情就是把 `process.argv` 去掉前两段（Node 路径、脚本路径），把剩下的用户参数切片传给 `main` 函数。`main` 本身从 `./main.ts` 导入（`cli.ts:18` 的 import）。

> **说明**
>
> `process.argv.slice(2)` 是个容易忽视但非常重要的细节：数组第 0 项是 node 可执行文件路径，第 1 项是脚本路径，所以从下标 2 开始才是真正的用户参数（例如 `pi -p "hello"` 中的 `-p` 和 `hello`）。如果你写脚本调用 Pi 的入口，漏掉 slice(2) 就会把脚本路径当成第一个参数，导致解析错乱。

## 33.2 参数解析：cli/args.ts

参数解析由 `parseArgs()` 完成，定义在 `packages/coding-agent/src/cli/args.ts:65`，一直到 `args.ts:226`。它返回一个 `Args` 对象（接口定义在 `args.ts:13`–`args.ts:57`）。

`parseArgs` 逐段扫描参数，做这些事：

- 处理 `--model <provider/model>`：设置本次会话使用的模型。
- 处理 `--print` / `-p`：启用“打印模式”（一次性输出，不进入交互界面）。
- 处理 `--session <id>`：指定要恢复的历史会话。
- 处理 `--thinking <level>`：设置思考档位（off / minimal / low / medium / high）。
- 处理 `@file` 形式的参数：把文件内容内联进初始消息。
- 无法识别的 flag（例如扩展注册的 CLI flag）会被收集进 `unknownFlags` 这个 Map（`args.ts:204`–`args.ts:217`），留给后面的扩展机制去消费。

```ts
// packages/coding-agent/src/cli/args.ts:65（节选签名）
export function parseArgs(args: string[]): Args {
    // ...逐段扫描 argv，填充 Args 对象的各个字段...
}
```

帮助信息由 `printHelp()` 输出，定义在 `args.ts:228`–`args.ts:418`，它会把所有内置参数以及扩展注册的 flag 一起列出来——所以扩展作者注册的 `--my-flag` 也会出现在 `pi --help` 里。

> **提示**
>
> `@file` 是一个很贴心的设计：你可以写 `pi "帮我 review @src/index.ts"`，Pi 会把 `src/index.ts` 的内容读进来，作为上下文附加到你的消息里。这比手动复制粘贴代码进输入框方便得多，也是“让大模型看代码”的常见入口。

## 33.3 会话选择：从 ID 到 SessionManager

解析完参数后，`main()` 需要决定“这次要打开哪个会话”。相关逻辑在 `main.ts` 的函数中：

- `resolveSessionPath()`（`main.ts:259`–`main.ts:285`）：根据 `--session` 参数、默认会话目录等，算出会话文件的最终路径。
- `createSessionManager()`（`main.ts:360`–`main.ts:451`）：构造出 `SessionManager` 实例。这个管理器负责读写会话的 JSONL 文件、维护会话树、保存消息条目等。我们会在第 34 章看到它被塞进 `AgentSession`。

如果没指定 `--session`，Pi 会新建一个会话；如果指定了，就“恢复”那个历史会话——这一步就是所谓的 **会话选择/恢复（session select / restore）**。

## 33.4 运行环境创建：runtime 工厂

参数和会话都就绪后，`main()` 调用一个**创建运行环境的工厂函数**（`main.ts:715`–`main.ts:841`），这是整条链路的核心枢纽。它内部依次：

1. `createAgentSessionServices()`（`main.ts:734` 调用，定义见 `core/agent-session-services.ts:135`）：装配出一组“服务”（`AgentSessionServices`），包括 `cwd`、模型运行时 `ModelRuntime`、设置管理器 `SettingsManager`、资源加载器 `ResourceLoader`、诊断器等。
2. `createAgentSessionFromServices()`（`main.ts:819` 调用，定义见 `core/agent-session-services.ts:202`）：在这些服务之上构造出真正的 `AgentSession`（注意这里来自 `sdk.ts` 的 `createAgentSession`，属于运行时层 `packages/agent`）。
3. 把 `session` + `services` 组合成 `AgentSessionRuntime`：`createAgentSessionRuntime(...)`（`main.ts:843` 调用，定义见 `core/agent-session-runtime.ts:414`）。

> **提示**
>
> 可以把“服务（services）”理解为**食材和厨具**，“会话（session）”理解为**炒好的那盘菜**，“运行环境（runtime）”理解为**端着这盘菜、还能换盘子的服务员**。后面所有模式（交互/打印/RPC）打交道的都是 `AgentSessionRuntime` 这个对象。

## 33.5 模式分发：resolveAppMode 与三条支路

Pi 不是只有一种用法。根据参数和终端环境，`main()` 会算出本次该走哪种模式，这就是 `resolveAppMode()`（`main.ts:118`–`main.ts:129`）。它返回的字符串是 `"rpc"` / `"json"` / `"print"` / `"interactive"` 之一——判断依据是是否带 `--print`、是否有管道输入、以及 stdin/stdout 是不是 TTY 终端。

分发发生在 `main.ts` 的末段（`main.ts:923`–`main.ts:964`）：

- 如果走 RPC 模式：`runRpcMode(runtime)`（`main.ts:923`–`main.ts:925` 调用，定义见 `modes/rpc/rpc-mode.ts:54`）。
- 如果走交互模式：`new InteractiveMode(runtime, {...})` 然后 `.run()`（`main.ts:926`–`main.ts:936` 调用，定义见 `modes/interactive/interactive-mode.ts:388`）。
- 如果走打印模式：`runPrintMode(runtime, {...})`（`main.ts:957`–`main.ts:964` 调用，定义见 `modes/print-mode.ts:33`）。

在真正分发之前，`main()` 还会处理一些“前置动作”：输出版本（`main.ts:621`）、处理 `/export` 之类的导出（`main.ts:626`）、读取管道里的标准输入（`readPipedStdin()`，`main.ts:870`）、准备初始消息（`prepareInitialMessage()`，`main.ts:878`）、初始化主题（`initTheme()`，`main.ts:884`）、打印诊断信息（`main.ts:893`）等。

## 33.6 main() 主流程一览（带行号）

把上面的步骤串起来，`main()`（定义在 `main.ts:569`）的关键步骤如下：

1. `args = parseArgs(args)` —— `main.ts:609`
2. 版本/导出短路判断 —— `main.ts:621`、`:626`
3. `mode = resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY)` —— `main.ts:640`
4. `sessionManager = createSessionManager(...)` —— `main.ts:678`
5. `createRuntime` 工厂：内部 `createAgentSessionServices`（`main.ts:734`）→ `createAgentSessionFromServices`（`main.ts:819`）→ `createAgentSessionRuntime`（`main.ts:843`）
6. 帮助/模型列表等前置分支 —— `main.ts:854`、`:862`
7. 读管道、准备初始消息、初始化主题、诊断 —— `main.ts:870`、`:878`、`:884`、`:893`
8. 模式分发：RPC / Interactive / Print —— `main.ts:923`、`:926`、`:957`

## 33.7 一个具体调用示例：pi -p "你好"

为了把抽象流程落到一个具体例子，我们看 `pi -p "你好"` 这条命令的走向：

```text
argv = ["node", "pi", "-p", "你好"]
  │ slice(2) => ["-p", "你好"]
  ▼
parseArgs(["-p", "你好"])
  → Args.print = true, Args 初始消息 = "你好"
  ▼
resolveAppMode：检测到 --print ⇒ 返回 "print"
  ▼
createSessionManager() 新建一个会话
createRuntime 工厂：装配 services → session → runtime
  ▼
main.ts:957  runPrintMode(runtime, {...})
  → 订阅 session 事件，把 "你好" 作为 prompt 提交
  → AgentSession 跑完，输出文本到 stdout，返回退出码
```

注意这里**完全没有 TUI、没有编辑器、没有主循环**——打印模式只是把 `prompt()` 的结果吐出来。这正是“同一内核、不同界面”的直观体现。

## 33.8 其他早期分支：认证与导出

`main()` 里还有两个值得知道的早退分支，它们在某些参数下会“抢在模式分发之前”执行：

- **认证命令**：`runAuthCommand()`（`main.ts:139`–`main.ts:215`）处理 `/login`、`/logout` 之类的认证流程。当你运行 `pi login anthropic` 这类命令时，程序会走认证逻辑而不是起一个会话。
- **导出命令**：`main.ts:626` 附近处理导出相关参数，把会话导出成 HTML/JSONL 后提前结束。

这些“工具型子命令”让 `pi` 在命令行里既是一个交互 Agent，也是一个会话管理工具。

## 33.9 选项装配：buildSessionOptions / prepareInitialMessage

在真正进入模式前，`main()` 还会把散落的参数收拢成结构化的选项对象：

- `buildSessionOptions()`（`main.ts:453`–`main.ts:549`）把模型、思考档位、作用域模型（`--models`）、初始消息等汇总成 `AgentSession` 能直接消费的 `AgentSessionConfig`。
- `prepareInitialMessage()`（`main.ts:217`–`main.ts:236`）负责把命令行里的初始消息（以及 `@file` 展开后的内容、管道内容）整理成要发给模型的文本与图片。

这两个函数体现了 Pi 的一个好习惯：**先把“用户输入的杂乱参数”归一化成“内部统一的结构”，再交给下层**。下层函数永远拿到干净的对象，不必关心参数到底来自命令行还是管道。

## 33.10 整体流程图（ASCII）

```text
      操作系统 argv
          │
          ▼
   cli.ts:21  main(process.argv.slice(2))
          │
          ▼
   args.ts:65  parseArgs()
      ├─ --model / --print / --session / --thinking / @file
      └─ 未知 flag ──► unknownFlags (留给扩展)
          │
          ▼
   main.ts:259  resolveSessionPath()
   main.ts:360  createSessionManager()      ── 选择/恢复会话
          │
          ▼
   main.ts:715  createRuntime 工厂
      ├─ agent-session-services.ts:135  createAgentSessionServices()   (services)
      ├─ agent-session-services.ts:202  createAgentSessionFromServices() (session)
      └─ agent-session-runtime.ts:414   createAgentSessionRuntime()    (runtime)
          │
          ▼
   main.ts:640  resolveAppMode()  ── 决定模式
          │
     ┌────┼───────────────┐
     ▼    ▼               ▼
  rpc  interactive      print
  rpc-mode.ts   interactive-mode.ts   print-mode.ts
   :54           :388                :33
```

> **说明**
>
> `resolveAppMode` 的返回值里还有 `"json"` 模式，但它在 `main.ts` 里最终会落到与 RPC 相似的 JSON 行协议处理分支。对初学者来说，只要先记住三条最直观的支路：**RPC（给 IDE 用）、交互（给人用 TUI）、打印（一次性输出）**，就足够建立心智模型了。

## 33.11 为什么这一层值得单独讲

很多 AI 编码工具的源码一上来就直接“起 Agent”，让人摸不着头脑。Pi 的清晰之处在于：**CLI 层只负责“把世界准备好”**，它不关心模型怎么思考、工具怎么调用，只负责把参数、会话、运行环境这三样东西组装好，再交给合适的模式去跑。

这种分层让 Pi 可以同时服务于三种截然不同的使用者：

| 使用者 | 模式 | 入口调用 |
| --- | --- | --- |
| IDE 插件开发者 | RPC（JSON 协议） | `rpc-mode.ts:54` |
| 终端里的普通用户 | 交互（TUI 界面） | `interactive-mode.ts:388` |
| 脚本/管道 | 打印（一次性） | `print-mode.ts:33` |

下一章我们会深入 `AgentSession`，看看“运行环境”里那个被所有模式共享的核心对象到底封装了什么。

## 33.12 再谈 `resolveAppMode`：TTY 与管道

§33.5 提到 `resolveAppMode()`（`main.ts:118`–`main.ts:129`）靠“是否带 `--print`、是否有管道输入、stdin/stdout 是不是 TTY”来决定模式。`TTY` 是 “TeleTypewriter” 的缩写，简单理解为“这个输入/输出是不是一块真实的终端屏幕”。

- **stdout 不是 TTY**（比如 `pi "..." | cat` 把输出接给管道）：即使没写 `-p`，Pi 也会倾向于“打印/JSON”这类不需要屏幕的模式，因为结果本来就要被别的程序消费。
- **stdin 不是 TTY**（比如 `echo "hi" | pi`）：说明输入来自管道而非键盘，这时 Pi 通常走一次性处理，而不是等你继续敲。

```text
              stdout 是 TTY？         stdin 是 TTY？        带 --print？
                   │                      │                      │
              ┌────┴────┐            ┌────┴────┐            ┌────┴────┐
              │ 是 / 否 │            │ 是 / 否 │            │ 是 / 否 │
              └────┬────┘            └────┬────┘            └────┬────┘
                   ▼                      ▼                      ▼
              resolveAppMode 综合三者 ⇒ "interactive" / "print" / "rpc" / "json"
```

理解这一点，你就能解释很多“奇怪”现象：为什么把 Pi 的输出重定向到文件后它就不弹界面了，为什么管道喂进去一句话它答完就退出了。

## 33.13 错误与退出：main 如何“体面收场”

`pi` 不是“跑成功就结束”这么简单。在 `main()` 里，Pi 会对顶层异常做统一处理：捕获错误、打印诊断信息（`main.ts:893` 一带的 diagnostics）、设置正确的退出码，并确保 `SIGINT`/`SIGTERM`（Ctrl+C / 被 kill）能干净地中止当前会话而不是留下半截状态。

退出码的含义大致是：

- `0`：正常结束（打印模式正常输出完、交互模式用户主动退出）。
- 非 `0`：异常结束（参数错误、认证失败、运行期崩溃等）。

这也呼应了 §33.3：打印模式 `runPrintMode` 返回的 `Promise<number>` 就是它的退出码，调用方（shell / CI）可以据此判断成败。

## 33.14 本章小结：CLI 层的边界

回头看，CLI 层做了一件很克制的事——**它只负责“把世界准备好”，绝不越界去想模型怎么思考**。参数、会话、运行环境这三样东西组装好之后，CLI 层就“交棒”给模式层了。

这种边界感带来两个好处：

1. **可测试**：`parseArgs`、`resolveSessionPath`、`createRuntime` 都是纯函数/工厂，不依赖屏幕，单元测试很容易写。
2. **可组合**：因为内核是同一个 `AgentSession`，换一种入口（CLI / SDK / IDE 插件）只是换一套“准备世界”的方式，后面完全一致。

下一章我们钻进“准备好的世界”里那个核心对象 `AgentSession`，看看它到底封装了什么。

## 33.15 本章关键函数速查表

把本章出现的核心函数集中列在这里，方便回查：

| 函数 / 对象 | 文件:行号 | 作用 |
| --- | --- | --- |
| `main(process.argv.slice(2))` | `cli.ts:21` | CLI 总入口，剥离脚本路径后调 `main` |
| `parseArgs(args)` | `args.ts:65` | 解析命令行参数，返回 `Args` |
| `printHelp()` | `args.ts:228` | 输出帮助（含扩展注册的 flag） |
| `resolveSessionPath()` | `main.ts:259` | 计算会话文件路径 |
| `createSessionManager()` | `main.ts:360` | 构造会话管理器 |
| `createAgentSessionServices()` | `agent-session-services.ts:135` | 装配服务集合 |
| `createAgentSessionFromServices()` | `agent-session-services.ts:202` | 构造 `AgentSession` |
| `createAgentSessionRuntime()` | `agent-session-runtime.ts:414` | 组装运行环境 |
| `resolveAppMode()` | `main.ts:118` | 决定运行模式 |
| `runRpcMode` / `InteractiveMode` / `runPrintMode` | `rpc-mode.ts:54` / `interactive-mode.ts:388` / `print-mode.ts:33` | 三种模式入口 |

## 自查清单

- [ ] 我能否说出 `cli.ts` 第 21 行做了什么，以及为什么要 `slice(2)`？
- [ ] 我能否指出参数解析发生在哪个文件、哪个函数（`args.ts:65`）？
- [ ] 我能否解释 `@file` 这种参数有什么用，为什么方便？
- [ ] 我能否解释“会话选择/恢复”由哪两个函数负责（`main.ts:259`、`:360`）？
- [ ] 我能否复述 runtime 工厂内部的三步装配（services → session → runtime）及其行号？
- [ ] 我能否列出 Pi 的三种运行模式，并对应到各自的入口函数？
- [ ] 我能否根据 ASCII 图，口述“参数 → 会话 → 运行环境 → 模式”这条主链路？
- [ ] 我是否理解 `runAuthCommand` 等“工具型子命令”为何会在模式分发前提前处理？
- [ ] 我能否说明 `buildSessionOptions` 与 `prepareInitialMessage` 在“参数归一化”中的作用？
