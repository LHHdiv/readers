---
title: "第 44 章 · 用 SDK 编程式调用 createAgentSession"
date: 2026-07-01
summary: "自己写 `while` 循环 = 懂原理；调 `createAgentSession` = 能交付。前者教你\"引擎怎么转\"，后者给你\"踩下油门的接口\"。"
tags:
  - pi
---
# 第 44 章 · 用 SDK 编程式调用 createAgentSession

第 43 章项目 (a) 里，我们亲手写了一个 `for` 循环来驱动推理。那个循环很直观，但 Production 级别要做到：工具并发执行、超时与重试、上下文溢出自动压缩、权限确认、会话持久化……这些全自己写会累死。

Pi 的做法是：把这些全封装进 `createAgentSession` 这一个函数里。你"开车"，引擎内部的 agent-loop 由它负责。本章讲怎么在代码里"开车"。

## 为什么要用 SDK 而不是 CLI

CLI（命令行界面）是给人用的：它处理键盘输入、渲染花哨的终端界面、管理交互模式。但如果你想做这些事：

- 把 Pi 嵌进自己的后端服务，对外暴露一个 API
- 写一个定时任务，每天自动 review 某个仓库
- 做第 46 章那种桌面端 Agent，UI 自己用 Vue 画
- 在测试里批量跑编码任务

你就不需要 CLI 那层界面，而需要**直接用代码创建并驱动会话**——这就是 `createAgentSession` 的用途。

> **说明**
>
> `createAgentSession` 是"一站式"入口：它内部会建好 `ModelRuntime`（模型与鉴权）、`SettingsManager`（设置）、`SessionManager`（会话持久化）、`Agent`（真正跑循环的核心），最后返回一个 `AgentSession` 供你发消息。源码见 `packages/coding-agent/src/core/sdk.ts:169`。

## 核心选项：CreateAgentSessionOptions

`createAgentSession(options)` 的参数类型定义在 `packages/coding-agent/src/core/sdk.ts:38`，下面挑最常用、且参数名与源码一致的字段说明：

| 选项 | 类型 | 含义 | 源码位置 |
|------|------|------|----------|
| `cwd` | `string` | 项目工作目录，默认 `process.cwd()` | `sdk.ts:40` |
| `model` | `Model<any>` | 指定模型，否则从设置/可用模型里选第一个 | `sdk.ts:48` |
| `thinkingLevel` | `ThinkingLevel` | 思考强度 `off/minimal/low/medium/high/max` | `sdk.ts:50` |
| `tools` | `string[]` | 工具白名单，只启用列出的工具 | `sdk.ts:69` |
| `noTools` | `"all" \| "builtin"` | 禁用全部或仅禁用内置工具 | `sdk.ts:61` |
| `customTools` | `ToolDefinition[]` | 额外注册自定义工具 | `sdk.ts:73` |
| `modelRuntime` | `ModelRuntime` | 自定义鉴权/模型运行时 | `sdk.ts:45` |
| `sessionManager` | `SessionManager` | 自定义会话存储（如内存会话） | `sdk.ts:79` |

默认启用的内置工具是 `read / bash / edit / write`（源码 `sdk.ts:245`：`defaultActiveToolNames`）。如果你只想让智能体"读"和"跑命令"，传 `tools: ["read", "bash"]` 即可。

## 最小可运行示例

下面是一段**基于真实 API 形状**的调用示例。参数名、返回结构均与上面核对的源码一致。注意：运行它需要先构建 Pi 包（见第 14 章 `run-pi`），并在环境变量里配置好模型 key。

```ts
// run-once.ts —— 用 SDK 跑一次编码任务（TypeScript）
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

async function main() {
  // 1) 选模型：DeepSeek provider（见第 17 章与 deepseek.ts）
  const model = getModel("deepseek", "deepseek-v4-flash");
  if (!model) throw new Error("找不到 deepseek 模型，请先配置 DEEPSEEK_API_KEY");

  // 2) 一站式创建会话
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    thinkingLevel: "medium",
    tools: ["read", "bash", "edit", "write"], // 与默认一致，显式写出便于理解
  });

  // 3) 订阅事件（可选但强烈推荐，用于看流式输出）
  session.subscribe((evt) => {
    if (evt.type === "message_update") {
      // evt.message 是当前正在生成的助手消息，可取其文本增量
    }
    if (evt.type === "tool_execution_start") {
      console.log("→ 调用工具:", evt.toolName, JSON.stringify(evt.args));
    }
    if (evt.type === "agent_end") {
      console.log("本轮结束");
    }
  });

  // 4) 发一条消息并驱动整轮推理（内部 agent-loop 由 SDK 负责）
  await session.prompt("在 src 目录下创建一个 hello.ts，导出一个返回 'hi' 的函数");

  console.log("完成");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`prompt` 方法签名在 `packages/coding-agent/src/core/agent-session.ts:1116`，返回 `Promise<void>`，会一直等到这一轮（含工具调用、压缩）全部 settle。

## 事件订阅：看 Pi "边想边干"

`session.subscribe(listener)` 定义在 `agent-session.ts:815`，传入的监听器收到的是 `AgentSessionEvent` 联合类型。最有用的几类事件：

| 事件 `type` | 你会拿到什么 | 典型用途 |
|-------------|--------------|----------|
| `message_update` | 正在生成的助手消息 | 实时把文本推给前端 |
| `tool_execution_start` | 工具名 + 参数 | 显示"正在执行 xxx" |
| `tool_execution_end` | 结果 + 是否报错 | 显示工具输出 |
| `agent_end` | 整轮消息 | 标记本轮完成 |
| `agent_settled` | 无 | 会话完全空闲，可安全退出 |

> **提示**
>
> 订阅事件要"薄"。监听器里只做转发/打印/记录，**不要**在里面做重活或阻塞 await 太久——SDK 的循环还在等这一轮结束。真正的副作用（写文件、发网络）留给工具或你的业务层。

## 与"自己写 while 循环"的对比

这是本章最关键的一节。把两种写法摆在一起：

```
自己写 while 循环（项目 a / mini-agent.mjs）
─────────────────────────────────────────────
for (turn=0; turn<10; turn++) {
  decision = brain(history)        // 你负责"思考"
  result = tool.run(decision.args) // 你负责"行动"
  history.push(result)             // 你负责"观察回填"
}
缺点：工具并发？超时重试？上下文溢出压缩？
     权限确认？会话持久化？全部要自己补。

用 createAgentSession（本章）
─────────────────────────────────────────────
const { session } = await createAgentSession({ model, cwd })
await session.prompt("需求")   // SDK 内部已封装好整套 agent-loop
优点：上述所有 Production 问题 SDK 已经处理。
      你只关心"发什么消息""订阅什么事件"。
```

一句话：**`while` 循环让你"懂原理"，`createAgentSession` 让你"能交付"。** 第 43 章 (a) 不是浪费——它让你读得懂 SDK 内部在干什么（去看 `sdk.ts:294` 的 `new Agent({...})`，那个 `Agent` 才是真正转循环的对象）。

## 模型与鉴权从哪来

`createAgentSession` 默认用 `agentDir/auth.json` 和 `models.json` 解析模型与 key（`sdk.ts:174-176`）。对于 DeepSeek，provider 在 `packages/ai/src/providers/deepseek.ts:10` 定义 `baseUrl: "https://api.deepseek.com"`，鉴权读环境变量 `DEEPSEEK_API_KEY`（`deepseek.ts:11`）。

所以运行前确保：

```bash
export DEEPSEEK_API_KEY="sk-你的key"
# 然后通过 pi 的包构建/链接后运行你的脚本
```

> **注意**
>
> SDK 调用同样受"模型是否可用"约束。若没有任何 provider 配置 key，`createAgentSession` 会因 `findInitialModel` 找不到模型而返回 `modelFallbackMessage`（见 `sdk.ts:217-222`）。出错时先看这个字段，而不是盲目调参。

## 一段更"产品化"的骨架

把上面例子抽成可复用函数，便于第 46 章套壳：

```ts
// agent-engine.ts —— 你的"Pi 引擎封装层"
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getModel, type Model } from "@earendil-works/pi-ai";

export interface RunResult {
  session: AgentSession;
  text: string; // 最终助手完整文本
}

export async function runCodingTask(goal: string, modelId = "deepseek-v4-flash"): Promise<RunResult> {
  const model: Model<any> | undefined = getModel("deepseek", modelId);
  if (!model) throw new Error(`模型 ${modelId} 不可用`);

  const { session } = await createAgentSession({ cwd: process.cwd(), model });
  let text = "";
  session.subscribe((evt) => {
    if (evt.type === "message_update") {
      // 真实场景：这里把增量通过 IPC/WebSocket 推给 UI
      const t = extractText(evt.message);
      if (t) text += t;
    }
  });
  await session.prompt(goal);
  return { session, text };
}

function extractText(msg: any): string {
  // AgentMessage.content 可能是字符串或块数组，按实际情况取文本
  if (typeof msg?.content === "string") return msg.content;
  return (msg?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}
```

## 一句话记住本章

> 自己写 `while` 循环 = 懂原理；调 `createAgentSession` = 能交付。前者教你"引擎怎么转"，后者给你"踩下油门的接口"。

记住这句，你就抓住了第 43→44 章跳跃的本质：不是抛弃循环，而是把循环交给可信的引擎，自己专注在"发什么消息、收什么事件"上。

## 与 CLI 模式的关系

很多人以为"CLI 和 SDK 是两套东西"。其实 CLI 的打印/交互模式底层也是用 `createAgentSession` 建会话、用 `session.subscribe` 收事件，只是在上面叠了一层终端渲染（见 `packages/coding-agent/src/modes/`）。换句话说：

```
CLI 交互模式  = createAgentSession + TUI 渲染层
CLI 打印模式  = createAgentSession + 纯文本输出
RPC 模式      = createAgentSession + 远程事件转发
你写的脚本    = createAgentSession + 你自己的 I/O 层
```

这解释了为什么"先用 CLI 验证模型可用，再写 SDK 脚本"最稳：两者共用同一套引擎，CLI 能跑通，SDK 基本也能跑通，差异只在你的 I/O 代码。

## 提取文本时的坑

助手消息的 `content` 不一定是字符串。它可能是块数组（文本块、思考块、工具调用块混排）。所以订阅 `message_update` 后别直接 `evt.message.content` 当字符串拼——要先判断类型再取 `text` 字段（第 44 章示例里的 `extractText` 已处理）。漏掉这步会导致 UI 出现 `[object Object]`。

> **提示**
>
> 流式场景里，`message_update` 每次推送的是"当前累积的完整消息"还是"增量"取决于具体实现。稳妥做法是：订阅时取消息的纯文本部分，自己做"追加"或"整体替换"。先打一行 `console.log(JSON.stringify(evt.message).slice(0,200))` 看清结构，再决定拼接策略。

## 返回值与错误处理

`createAgentSession` 返回 `CreateAgentSessionResult`（`sdk.ts:88`），结构是：

```ts
interface CreateAgentSessionResult {
  session: AgentSession;          // 你主要用这个
  extensionsResult: LoadExtensionsResult; // 扩展加载结果（含 errors）
  modelFallbackMessage?: string;  // 模型回退提示，非空表示模型有问题
}
```

所以拿到结果后第一件事可以是：

```ts
const { session, modelFallbackMessage, extensionsResult } = await createAgentSession({ model });
if (modelFallbackMessage) console.warn("模型提示:", modelFallbackMessage);
if (extensionsResult.errors.length) console.warn("扩展错误:", extensionsResult.errors);
```

`prompt` 本身在出错时会抛异常（如没有模型、key 失效、压缩进行中提交）。用 `try/catch` 包住，别让进程静默退出。

## 把 SDK 跑在脚本 / CI 里

SDK 调用不依赖终端界面，因此天然适合自动化：

- **定时任务**：cron 每天调一次脚本，让 Pi review 指定目录的改动
- **批量任务**：循环读需求列表，逐个 `session.prompt(goal)`，把结果落库
- **测试夹具**：在单测里用 `SessionManager.inMemory()`（`sdk.ts:165` 示例）建内存会话，避免写磁盘

注意 `prompt` 是异步且会跑完整轮的，批量场景里要么串行 `await`，要么给每个任务独立 `session` 实例以防上下文串台。

## 自查清单

- [ ] 我知道 `createAgentSession` 与"自己写 while 循环"的本质区别（封装 vs 手写）
- [ ] 我能说出 `CreateAgentSessionOptions` 里 `cwd / model / tools / customTools` 的作用
- [ ] 我知道默认内置工具是 `read/bash/edit/write`（`sdk.ts:245`）
- [ ] 我能写出 `session.subscribe(...)` 监听 `message_update` 与 `tool_execution_start`
- [ ] 我知道 `session.prompt(text)` 会驱动整轮推理并返回 `Promise<void>`（`agent-session.ts:1116`）
- [ ] 我理解 DeepSeek 的 key 通过 `DEEPSEEK_API_KEY` 注入（`deepseek.ts:11`）
- [ ] 我看到"找不到模型"错误时，会先检查 `modelFallbackMessage` 而非盲调
