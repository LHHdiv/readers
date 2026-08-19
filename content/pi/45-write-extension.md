---
title: "第 45 章 · 写一个 Pi 扩展（实战）"
date: 2026-07-01
summary: "第 43 章项目 (b) 给了扩展的\"最小形态\"。本章把它做完整、做可跑，并对照真实示例讲清楚每个零件。读完你能从零写一个会被 Pi 加载的扩展。"
tags:
  - pi
---
# 第 45 章 · 写一个 Pi 扩展（实战）

第 43 章项目 (b) 给了扩展的"最小形态"。本章把它做完整、做可跑，并对照真实示例讲清楚每个零件。读完你能从零写一个会被 Pi 加载的扩展。

## 扩展到底是什么

一句话：**扩展就是一个 `default` 导出的函数，参数是 `ExtensionAPI`**。Pi 启动时扫描扩展目录，对每个扩展调用这个函数，把你注册的工具、命令、事件监听器挂到运行时的 `ExtensionAPI` 上。

类型定义都在 `packages/coding-agent/src/core/extensions/types.ts`。其中你最常用的是：

- `ExtensionAPI`（第 1198 行起）：`on` / `registerTool` / `registerCommand` / `registerProvider` 等
- `ExtensionFactory`（第 1519 行）：`(pi: ExtensionAPI) => void | Promise<void>`
- `ToolDefinition`（第 449 行）：`registerTool` 需要的工具结构
- `ExtensionContext` / `ExtensionCommandContext`：事件与命令处理器里拿到的上下文

## 目录结构与 package.json 的 pi 字段

Pi 通过扩展目录里的 `package.json` 找到入口。约定是 `package.json` 里写一个 `pi.extensions` 数组，指向扩展入口文件。参考官方 `examples/extensions/with-deps/package.json`：

```
my-ext/
├── package.json      ← 必须有 "pi": { "extensions": ["./index.ts"] }
└── index.ts          ← default 导出函数
```

`package.json` 内容（来自 `with-deps/package.json`，已核对）：

```json
{
  "name": "my-pi-extension",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "clean": "echo 'nothing to clean'",
    "build": "echo 'nothing to build'",
    "check": "echo 'nothing to check'"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

> **说明**
>
> `pi.extensions` 指向的入口文件会被 Pi 用 `jiti` 直接加载 TypeScript，**不需要你先 `tsc` 编译**。有第三方依赖时（如官方 `with-deps` 用 `ms` 包），在目录里 `npm install` 即可，jiti 会从扩展自己的 `node_modules` 解析。

## 最小可跑扩展：一个"报时"工具

下面给一个**完整、可复制、可跑**的最小扩展。它注册一个 `today` 工具，让 LLM 能获取实时日期。

```ts
// my-ext/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 注册工具：名字、描述、参数 schema、执行函数
  pi.registerTool({
    name: "today",
    label: "Today",
    description: "返回当前日期与时间（ISO 字符串），让 LLM 能回答与时间相关的问题",
    // 无参数
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const now = new Date().toISOString();
      return {
        content: [{ type: "text", text: now }],
        details: {},
      };
    },
  });

  // 再注册一条命令 /now，直接打印时间
  pi.registerCommand("now", {
    description: "打印当前时间",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`现在：${new Date().toISOString()}`, "info");
    },
  });
}
```

`execute` 必须返回 `{ content, details }`，其中 `content` 是 `TextContent[]` 形式的结果块（`tool_call` 返回结构见 `types.ts` 的 `ToolResultEvent`）。`details` 用来存结构化状态，便于会话 fork 时重建（参考 `examples/extensions/README.md` 的"State persistence via details"段落）。

## 用 typebox 写参数 schema（推荐）

上面手写 `parameters` 对象不够类型安全。官方 `with-deps/index.ts` 用 `typebox` 的 `Type` 来定义参数，更规范：

```ts
// 参考 examples/extensions/with-deps/index.ts:12-31
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "parse_duration",
    label: "Parse Duration",
    description: "把人类可读的时长（如 '2 days'、'1h'、'5m'）解析成毫秒",
    parameters: Type.Object({
      duration: Type.String({ description: "时长字符串，如 '2 days'、'1h'、'5m'" }),
    }),
    execute: async (_toolCallId, params) => {
      // params.duration 已被校验为 string
      return {
        content: [{ type: "text", text: `${params.duration} 已解析` }],
        details: {},
      };
    },
  });
}
```

> **提示**
>
> 字符串枚举参数请优先用 `StringEnum(["list","add"])`（来自 `@earendil-works/pi-ai`），而不是 `Type.Union([Type.Literal(...)])`——后者在部分 provider（如 Google）上兼容性差。详见 `examples/extensions/README.md` "Key Patterns"。

## 事件订阅：在生命周期里插手

`ExtensionAPI.on(event, handler)` 让你监听 Pi 的各种生命周期事件。事件名与处理函数签名在 `types.ts` 第 1203-1244 行逐一列出。几个高频事件：

| 事件 | 触发时机 | 你能做的 |
|------|----------|----------|
| `tool_call` | 工具即将执行 | 改参数或 `block:true` 拦截（权限闸门） |
| `tool_result` | 工具执行完 | 改结果内容 |
| `session_start` | 会话启动/恢复 | 初始化你的状态、读配置 |
| `message_update` | 助手流式生成 | 拿文本增量 |
| `before_agent_start` | 用户提交后、循环前 | 改系统提示 |

官方 `examples/extensions/sandbox/index.ts` 是事件订阅的好范本：它在 `session_start` 里初始化沙箱（`sandbox/index.ts:234`），在 `tool_call` 之前用 `registerTool` 包裹 `bash` 工具（`sandbox/index.ts:214`）实现 OS 级隔离。

### 示例：给危险 bash 命令加确认

```ts
// 灵感来自 examples/extensions/permission-gate.ts 的文档说明
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("危险操作", "确认执行 rm -rf？");
      if (!ok) return { block: true, reason: "用户取消" };
    }
  });
}
```

`tool_call` 的处理器返回 `ToolCallEventResult`（见 `types.ts:1071`），`block:true` 即可阻止执行。

## 注册自定义 Provider（接别家模型）

如果你想接一个 Pi 没内置的模型供应商，用 `pi.registerProvider`。官方 `examples/extensions/custom-provider-anthropic/index.ts:575` 是完整范本：

```ts
// 参考 custom-provider-anthropic/index.ts:575-610
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("custom-anthropic", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "$CUSTOM_ANTHROPIC_API_KEY",          // $ 开头表示读环境变量
    api: "custom-anthropic-api",
    models: [
      {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (Custom)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],
    streamSimple: streamCustomAnthropic,          // 自定义流式实现（可省）
  });
}
```

`registerProvider` 有两种签名：`registerProvider(provider: Provider)` 或 `registerProvider(name, config)`（见 `types.ts:1417`）。`apiKey: "$XXX"` 是环境变量插值语法。DeepSeek 已内置，无需此步；本例仅展示"扩展示例"的边界能力。

## 如何本地加载与运行

扩展有两种加载方式（见 `examples/extensions/README.md` 顶部）：

```bash
# 方式一：命令行 -e 指定目录
pi -e ./my-ext

# 方式二：放进全局扩展目录，自动发现
cp -r my-ext ~/.pi/agent/extensions/
pi          # 启动后自动加载
```

验证是否加载成功：启动时日志的 "Extensions" 列表里会出现 `<inline:my-ext>` 或你的扩展名；输入 `/now` 应能触发命令，问"今天几号"时 LLM 应能调用 `today` 工具。

> **注意**
>
> 扩展路径用 `-e` 时是**相对或绝对路径指向目录**，Pi 会去读该目录的 `package.json` 找 `pi.extensions` 入口。如果你 `-e` 直接指向某个 `.ts` 文件但那个文件没有对应 `package.json`，Pi 可能找不到入口。最稳的做法：永远用"目录 + package.json 的 pi 字段"。

## 一个更完整的扩展示例：带参数的"翻译"工具

把上面点串起来，给一个带参数、带描述、能在真实对话里用的工具：

```ts
// my-ext/index.ts（完整版）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "translate_mock",
    label: "Translate (mock)",
    description: "把文本标记为待翻译，并返回 [译] 前缀（演示用，不接真实翻译 API）",
    promptSnippet: "translate_mock: 把文本做占位翻译",
    parameters: Type.Object({
      text: Type.String({ description: "要翻译的文本" }),
      target: Type.String({ description: "目标语言，如 'en'、'ja'" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      // 真实场景：这里调用翻译 API；演示仅加前缀
      return {
        content: [{ type: "text", text: `[译→${params.target}] ${params.text}` }],
        details: { target: params.target },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("ext", "translate_mock 已就绪");
  });
}
```

`promptSnippet` 会让系统提示的"可用工具"区出现该工具一句话说明（见 `types.ts:456` 注释），提升 LLM 调用概率。

## 调试扩展的实用技巧

扩展出错往往不直观，几条经验：

- **看启动日志的 Extensions 列表**：你的扩展名是否出现？没出现说明入口没被扫到。
- **看 `LoadExtensionsResult.errors`**：加载期异常会进这里（`types.ts:1712`），含路径与错误文本。
- **在工厂函数里先 `console.log`**：确认函数被调用，再逐步加注册逻辑。
- **用 `ctx.ui.notify` 而非 `console`**：交互模式下 `console` 可能被 TUI 覆盖，`notify` 更可靠（参考 `sandbox/index.ts:280`）。
- **工具不调用先看 `promptSnippet`**：LLM 不知道有这工具，往往是因为系统提示里没出现它的一行说明（`types.ts:456`）。

> **提示**
>
> 扩展与核心包不同：扩展是 jiti 直读 `.ts`，改完通常重启 Pi 即生效，无需 build。这是你快速迭代的红利——但也意味着别把扩展当"生产核心逻辑"的藏身处，核心能力应进 Pi 主包。

## 自查清单

- [ ] 我知道扩展 = `default function (pi: ExtensionAPI)`，入口在 `package.json` 的 `pi.extensions`
- [ ] 我新建的扩展目录含 `index.ts` 和带 `pi` 字段的 `package.json`
- [ ] 我会用 `pi.registerTool` 注册一个带回参 `{ content, details }` 的工具
- [ ] 我会用 `typebox` 的 `Type.Object` / `Type.String` 写参数 schema
- [ ] 我用过 `pi.on("tool_call", ...)` 拦截/改参数，知道 `block:true` 能阻止执行
- [ ] 我知道用 `pi -e ./目录` 或 `~/.pi/agent/extensions/` 加载扩展
- [ ] 我理解 `custom-provider-anthropic` 用 `registerProvider` 接外部模型（边界能力，非必做）
