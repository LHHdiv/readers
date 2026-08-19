---
title: "第 35 章 · 三种模式：交互 / 打印 / RPC"
date: 2026-07-01
summary: "约定：行号来自 `packages/coding-agent/src/modes/` 下三个文件——`interactive/interactive-mode.ts`、`print-mode.ts`、`rpc/rpc-mode.ts`。"
tags:
  - pi
---
# 第 35 章 · 三种模式：交互 / 打印 / RPC

在第 33 章我们看到 `main()` 在末尾根据 `resolveAppMode()` 的结果，把程序分发到不同的“运行模式”；在第 34 章我们看到所有模式共享的 `AgentSession`。本章把三种模式摆在一起对比：它们**输入从哪来、输出到哪去、各自的入口函数是什么**，以及什么时候该用哪一种。

> 约定：行号来自 `packages/coding-agent/src/modes/` 下三个文件——`interactive/interactive-mode.ts`、`print-mode.ts`、`rpc/rpc-mode.ts`。

## 35.1 为什么需要三种模式

同一个 `AgentSession`，可以服务于完全不同的“使用者”：

- **人坐在终端前**：需要漂亮的界面、可滚动的历史、可点的选择器 → 交互模式（TUI）。
- **脚本或管道**：只要把结果打印出来，不要任何界面 → 打印模式（print）。
- **IDE 插件**：用 JSON 行协议和 Pi 通信，UI 由 IDE 自己画 → RPC 模式。

三种模式的核心差异只有两点：**输入怎么来、输出怎么走**。底层都是同一个 `AgentSession`，所以“聪明程度”完全一样，差别只在 I/O 形态。换句话说，不管你用什么模式，背后那个会读文件、会跑命令、会和模型对话的“大脑”是同一套代码。

```text
                  AgentSession（共享内核）
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   交互模式          打印模式            RPC 模式
   TUI 界面          stdout 文本/JSON    stdin/stdout JSON 行
   人 ↔ Pi          脚本 ↔ Pi           IDE ↔ Pi
```

> **提示**
>
> 记住一个比喻：三种模式像是同一台发动机配的三种“变速箱”——手动挡（交互）、自动挡（打印）、遥控挡（RPC）。发动机一样，只是你“踩油门”和“看仪表盘”的方式不同。

## 35.2 交互模式：给人用的 TUI

入口类是 `InteractiveMode`，定义在 `modes/interactive/interactive-mode.ts:388`。它通过 `new InteractiveMode(runtimeHost, options)` 构造（`interactive-mode.ts:531`），再调用 `run()`（`interactive-mode.ts:1012`）启动。

`run()` 的流程很直白：

1. `await this.init()`（`interactive-mode.ts:842`）—— 注册信号处理器、加载变更日志、确保 `fd`/`rg` 工具可用、搭建 TUI 组件树（编辑器、消息区、状态栏、页脚等）、启动 UI。
2. 在后台触发模型目录刷新、版本检查、包更新检查等（`interactive-mode.ts:1015` 起）。
3. 处理初始消息（`initialMessage` / `initialMessages`，`interactive-mode.ts:1073` 起）。
4. **主循环**：`while (true) { const userInput = await this.getUserInput(); await this.session.prompt(userInput); }`（`interactive-mode.ts:1094`–`interactive-mode.ts:1102`）。

注意最后一步：交互模式的“每一轮用户输入”，最终都调用 `this.session.prompt(userInput)`——也就是第 34 章讲的那个 `AgentSession.prompt()`。这说明**交互模式本身不含任何业务逻辑，它只负责把键盘输入变成 `session.prompt()` 的调用，再把 `AgentSession` 冒出来的事件渲染成界面**。

```ts
// packages/coding-agent/src/modes/interactive/interactive-mode.ts:1012（节选）
async run(): Promise<void> {
    await this.init();                       // 搭好 TUI 与组件树
    // ...处理 initialMessage、后台刷新...
    while (true) {
        const userInput = await this.getUserInput();   // 等用户在输入框敲回车
        await this.session.prompt(userInput);          // 交给共享内核
    }
}
```

`getUserInput()` 不是简单地 `readline`——它背后是一个完整的终端 UI 事件循环：你上下滚动看历史、用 Tab 触发自动补全、用方向键在组件间移动焦点，这些都被这个 UI 循环消化，最后只把“一段文本 + 可能的附件”交回给 `run()`。所以交互模式“大”，大在 UI，不“大”在智能。

> **说明**
>
> 交互模式之所以庞大（文件超过 5000 行），不是因为它“聪明”，而是因为它要画一个完整的终端 UI：会话树、模型选择器、技能调用、工具执行动画、压缩/分支状态条…… 这些都是“表现层”，与 `AgentSession` 的业务内核是分开的。

## 35.3 打印模式：给脚本用的一次性输出

入口函数是 `runPrintMode(runtimeHost, options)`，定义在 `modes/print-mode.ts:33`–`print-mode.ts:169`。它的典型场景是：

```bash
pi -p "用一句话解释什么是闭包"
```

`-p`（或 `--print`）让 Pi 不进入 TUI，而是直接把回答打印到 stdout 然后退出。

`runPrintMode` 做这些事：

- 注册 `SIGTERM` / `SIGHUP` 信号处理器，保证被中断时干净退出（`print-mode.ts:33` 起的早期逻辑）。
- 通过 `setRebindSession` / `rebindSession` 支持会话切换（`print-mode.ts:70`–`print-mode.ts:119`）——打印模式下也能中途换会话。
- 订阅 `AgentSession` 的事件（`print-mode.ts` 中段），把流式输出累积成文本或 JSON。
- 根据选项决定输出**纯文本**还是 **JSON 结构**，最后返回退出码 `exitCode`。

与交互模式相比，打印模式没有“主循环 + 编辑器”，它提交一次消息、等 `AgentSession` 处理完、输出、退出。`prompt()` 的调用方式和交互模式一致，只是**没有人在终端里盯着看**。

```ts
// packages/coding-agent/src/modes/print-mode.ts:33（节选签名）
export async function runPrintMode(
    runtimeHost: AgentSessionRuntime,
    options: PrintModeOptions,
): Promise<number> {
    // ...订阅事件、输出文本/JSON、返回退出码...
}
```

打印模式的两种输出形态值得记住：

- **纯文本**（默认）：直接把模型的回答打印出来，方便 `$(pi -p "...")` 这种 shell 嵌入。
- **JSON**：带上更多结构（消息、工具调用、用量等），方便别的程序解析。

> **提示**
>
> 打印模式是“把 Pi 当命令行工具用”的钥匙。比如你想在 git hook 里让 Pi 自动生成提交信息，就可以 `pi -p "根据 diff 写一条 commit message"`，再把 stdout 喂给 `git commit -m`。它让 Pi 能无缝嵌进任何脚本管道。

## 35.4 RPC 模式：给 IDE 用的 JSON 协议

入口函数是 `runRpcMode(runtimeHost)`，定义在 `modes/rpc/rpc-mode.ts:54`–`rpc/rpc-mode.ts:817`。它返回 `Promise<never>`，意思是**进程会一直存活，不会自己退出**（见 `rpc-mode.ts:816` 的注释/结构）——因为它要持续接收 IDE 发来的指令。

RPC 模式通过“JSON 行（JSONL）”协议通信：

- 从 stdin 逐行读入命令（`attachJsonlLineReader` 见 `rpc-mode.ts:806`–`rpc-mode.ts:814`）。
- 每条命令交给 `handleCommand()` 处理（`rpc-mode.ts:386`–`rpc-mode.ts:716`），支持 `prompt`、`steer`、`follow_up`、`abort`、`new_session`、`get_state`、`set_model`、`compact`、`bash`、`switch_session`、`fork`、`get_commands` 等大量指令。
- 把结果以 JSON 行写回 stdout。

RPC 模式有自己的“UI 桩”（`createExtensionUIContext()`，`rpc-mode.ts:136`–`rpc-mode.ts:311`），因为 IDE 那边才有真正的界面；Pi 在 RPC 模式下把 `select`/`confirm` 等 UI 调用转成协议消息交给 IDE 处理。

```ts
// packages/coding-agent/src/modes/rpc/rpc-mode.ts:54（节选签名）
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
    // ...逐行读 stdin、handleCommand、写 stdout，永不主动退出...
}
```

一条典型的 JSONL 往返长这样：

```text
# IDE → Pi（stdin 的一行 JSON）
{"command":"prompt","params":{"text":"给这个函数加注释"}}

# Pi → IDE（stdout 可能多行 JSON，按事件推送）
{"type":"message_start", ...}
{"type":"message_update", ...}
{"type":"message_end", ...}
```

> **提示**
>
> RPC 模式常被称为“无头（headless）模式”：Pi 自己不画任何界面，只通过 JSON 行和外界对话。VS Code、JetBrains 等 IDE 插件大多就是这种模式——它们把 Pi 当成一个“会思考的本地服务”来调用。

## 35.5 三种模式的对比

| 维度 | 交互模式 Interactive | 打印模式 Print | RPC 模式 |
| --- | --- | --- | --- |
| 入口 | `interactive-mode.ts:388` | `print-mode.ts:33` | `rpc-mode.ts:54` |
| 触发方式 | 终端里直接运行 `pi` | `pi -p "..."` | IDE 插件启动 `pi` 子进程 |
| 输入来源 | 键盘 + TUI 选择器 | 命令行参数/管道 | stdin 的 JSON 行 |
| 输出去向 | TUI 界面 | stdout 文本/JSON | stdout 的 JSON 行 |
| 是否有主循环 | 有（`interactive-mode.ts:1094`） | 一次性 | 常驻（`Promise<never>`） |
| 进程存活 | 直到用户退出 | 输出完即退出 | 直到 IDE 断开 |
| 适用对象 | 人 | 脚本/管道 | IDE |
| 典型场景 | 日常对话、探索代码 | 脚本自动化、管道 | 编辑器内联助手 |

## 35.6 它们如何共享同一个内核

无论哪种模式，最后都调用 `AgentSession` 的方法：

```text
交互模式  run() 主循环
   └─ this.session.prompt(userInput)        →  interactive-mode.ts:1097

打印模式  runPrintMode()
   └─ 订阅 session 事件并输出               →  print-mode.ts:33

RPC 模式   handleCommand("prompt"/"steer"...)
   └─ 转调 session.prompt() / session.steer() →  rpc-mode.ts:386
```

也就是说，**三种模式是三套“不同的嘴和耳朵”，但大脑都是同一个 `AgentSession`**。这也解释了为什么切换模式（比如在 IDE 里点一下“在终端打开”）不会丢失上下文——内核没换，只是 I/O 换了。

## 35.7 模式之外的“UI 上下文”

细心的读者会注意到：`AgentSession` 在初始化扩展时，需要传入一个 `ExtensionUIContext`（第 37 章会展开）。三种模式各自提供自己的实现：

- 交互模式：`createExtensionUIContext()`（方法定义在 `interactive-mode.ts:2347`，在 `bindCurrentSessionExtensions` `interactive-mode.ts:1820` 处被调用）。
- RPC 模式：`createExtensionUIContext()`（`rpc-mode.ts:136`）。
- 打印模式：基本用 `noOpUIContext`（无界面，见 `extensions/runner.ts:235`）——因为打印模式没有交互界面，扩展想弹个选择器也弹不出来，只能静默。

这就是为什么某些扩展命令只有在交互模式或 RPC 模式下才好用：它们依赖 `hasUI` 为真。

> **说明**
>
> `hasUI` 这个布尔来自 `ExtensionRunner` 当前持有的 `uiContext` 是不是 `noOpUIContext`（`runner.ts:443` 的 `this.uiContext !== noOpUIContext`）。所以“有没有界面”不是模式名字决定的，而是运行时注入的 UI 上下文决定的——打印模式只是恰好注入了一个“什么都不做”的桩。

## 35.8 常见调用示例

把三种模式落到具体命令上，最容易记住：

```bash
# 交互模式：直接在终端跑，进入 TUI
pi

# 打印模式：一次性问答，结果进 stdout
pi -p "用 TypeScript 写一个防抖函数"
echo "$(pi -p '用一句话总结这段 diff')"   # 嵌进 shell

# RPC 模式：通常不是人直接调，而是 IDE 启动子进程
# 进程常驻，从 stdin 读 {"command":"prompt",...} 这样的 JSON 行
```

记忆口诀：**自己用就交互，写脚本就打印，接 IDE 就 RPC**。

## 35.9 模式之间能“接力”吗

能，而且这正是共享内核的好处。例如：

- 在 RPC 模式（IDE 里）跑了一半，你想“在终端里接着聊”——IDE 可以让你把当前会话在交互模式里打开。因为内核状态（消息历史、工具、系统提示词）都挂在 `AgentSession` 上，换套 I/O 不丢上下文。
- 打印模式也能 `rebindSession` 中途切到另一个会话（见 `print-mode.ts:70` 一带），说明即使“一次性”模式，会话对象也是可换的。

这背后是一条清晰的边界：**会话状态属于 `AgentSession`，不属于任何一个模式**。模式只是“如何使用会话”的壳。

## 35.10 小结

三种模式是 Pi “一份内核、多种界面”设计的最直观体现。记住三句话就够了：

1. **交互模式**——人在终端，TUI 界面，`run()` 里有主循环。
2. **打印模式**——脚本管道，`-p` 一次性输出，`runPrintMode()` 返回退出码。
3. **RPC 模式**——IDE 插件，JSON 行协议，`runRpcMode()` 常驻不退出。

> **说明**
>
> 选择困难症？记住：**自己用就交互，写脚本就打印，接 IDE 就 RPC**。它们底层能力完全一致，差别只在“你打算怎么和 Pi 说话”。

## 35.11 常见误区

讲完三种模式，澄清几个初学者最容易踩的坑：

- **误区一：RPC 模式“不能交互”。** 错。RPC 模式自己不画界面，但它把 `select`/`confirm` 这类交互请求通过 JSON 协议发给 IDE，由 IDE 弹窗。交互的“壳”在 IDE 那边，能力一点没少。
- **误区二：打印模式“功能更弱”。** 错。打印模式走的是同一个 `AgentSession`，读文件、跑命令、调工具样样都行，只是它把结果直接吐到 stdout 后就退出，不像交互模式那样保留一个可滚动、可继续聊的界面。
- **误区三：切换模式会“丢上下文”。** 错。因为状态挂在 `AgentSession` 上，模式只是 I/O 形态。IDE 里“在终端打开”本质就是换套 I/O 接着聊。
- **误区四：三种模式是三份代码。** 半对。I/O 层（TUI / 输出 / JSONL 协议）确实是三份，但“聪明的大脑” `AgentSession` 只有一份，这也是 Pi 能保证“无论哪种用法行为一致”的根本原因。

## 35.12 三种模式速查表

| 模式 | 入口 | 输入 | 输出 | 进程特征 | 核心行号 |
| --- | --- | --- | --- | --- | --- |
| 交互 Interactive | `InteractiveMode` | 键盘/TUI | TUI 界面 | 有主循环，直到退出 | `interactive-mode.ts:388` / `:1012` / `:1094` |
| 打印 Print | `runPrintMode` | 参数/管道 | stdout 文本/JSON | 一次性，输出完即退出 | `print-mode.ts:33` |
| RPC | `runRpcMode` | stdin JSON 行 | stdout JSON 行 | `Promise<never>` 常驻 | `rpc-mode.ts:54` / `:386` / `:806` |

把这张表和第 33 章的“模式分发”对照看，你会发现 `main()` 末尾那几个 `if` 分支，正好对应这里的三个入口。模式层是“外壳”，内核 `AgentSession` 始终没换。

## 35.13 一句话记忆

如果只能记住三句：

1. **交互模式**：人在终端，有主循环，内核 `prompt()` 在 `interactive-mode.ts:1094` 被反复调用。
2. **打印模式**：脚本管道，`-p` 一次性，返回退出码，没有界面。
3. **RPC 模式**：IDE 插件，JSON 行协议，`Promise<never>` 常驻不退出。

无论哪种，背后都是同一个 `AgentSession`——这是理解 Pi 全部用法的支点。

## 自查清单

- [ ] 我能否说出三种模式各自的入口函数与定义行号（`:388` / `:33` / `:54`）？
- [ ] 我能否解释为什么三种模式“能力一致、只差 I/O 形态”？
- [ ] 我能否说明交互模式的主循环在哪里（`interactive-mode.ts:1094`）以及它最终调用什么？
- [ ] 我能否指出打印模式由什么参数触发（`-p` / `--print`），以及它能输出文本还是 JSON？
- [ ] 我能否解释 RPC 模式为何返回 `Promise<never>` 且常驻，并通过什么协议通信？
- [ ] 我能否列出三种模式在“输入来源 / 输出去向 / 进程存活 / 适用对象”上的差异？
- [ ] 我是否理解“UI 上下文”会因模式而异（交互 `:2347` / RPC `:136` 有界面，打印用 `noOpUIContext` `runner.ts:235`）？
- [ ] 我能否举出把 Pi 嵌进脚本管道的打印模式用法（`pi -p "..."`）？
- [ ] 我是否理解“会话状态属于 AgentSession，不属任何模式”，因此模式可接力？
