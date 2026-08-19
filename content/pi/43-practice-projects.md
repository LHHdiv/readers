---
title: "第 43 章 · 三个递进实践项目"
date: 2026-07-01
summary: "前面 42 章把 Pi 的原理拆成了零件：Transformer、上下文窗口、工具调用、agent-loop、压缩、扩展系统……这一章我们把零件拼回成\"能跑的东西\"。"
tags:
  - pi
---
# 第 43 章 · 三个递进实践项目

前面 42 章把 Pi 的原理拆成了零件：Transformer、上下文窗口、工具调用、agent-loop、压缩、扩展系统……这一章我们把零件拼回成"能跑的东西"。

你不需要一次性吃透全部源码。本章给出**三个由浅入深**的动手项目，难度依次递增，但每个都刻意做小、可独立验收：

```
项目 (a) 最小智能体      ← 读 100 行代码 + 跑通，理解 agent-loop 的骨架
   │
   ▼
项目 (b) 给 Pi 写扩展    ← 在真实 Pi 里挂一个自定义工具/命令，理解"插件机制"
   │
   ▼
项目 (c) 用 SDK 跑任务   ← 脱离 CLI，在 Node 脚本里驱动一次完整编码会话
```

> **说明**
>
> 这三个项目不是"完整成品"，而是**规格 + 关键思路 + 验收标准**。第 44、45、46 章会分别把 (c)、(b) 和最终落地做深。你先照着规格自己动手，卡住了再回头看对应章节。

## 项目 (a)：最小智能体（理解循环本身）

### 目标

不依赖任何大模型 API、不安装任何依赖，用一个纯 Node 脚本看清"智能体"到底在循环什么。跑通后你应该能向别人解释：为什么"思考→行动→观察"这个圈转起来，机器就像在"干活"。

### 用到的知识

- agent-loop 的核心结构（见第 25 章 `agent-loop`）
- ReAct 范式：推理（Reason）与行动（Act）交替（见第 8 章 `agent-paradigms`）
- 工具（tool）的本质：一个 `名字 + 描述 + 执行函数`

### 关键思路

`hy-study/labs/mini-agent.mjs` 是现成的最小实现，核心是一个 `for` 循环：

```js
// labs/mini-agent.mjs 第 79-101 行（节选，已在源码中验证）
async function run(userInput) {
  let history = [{ role: "user", content: userInput }];
  for (let turn = 0; turn < 10; turn++) {        // ① 最多转 10 轮，防死循环
    const decision = brain(history);             // ② 思考：下一步做什么
    if (decision.type === "answer") {            //    若已能回答，结束
      console.log("智能体：", decision.content);
      return;
    }
    const tool = tools[decision.name];           // ③ 行动：执行工具
    const result = tool.run(decision.args);
    // ④ 观察：把结果塞回 history，进入下一轮
    history.push({ role: "tool", name: decision.name, content: String(result) });
  }
}
```

它用"规则大脑"（`brain` 函数里一堆 `if`）代替真实大模型，所以离线就能跑。注意 `callRealLLM`（源码第 61-76 行）已经把"换成真实 DeepSeek API"的接入点标了出来——这就是项目 (c) 的前身。

### 验收标准

- [ ] `node labs/mini-agent.mjs "把 3 和 5 加一下"` 输出 `结果是 8`
- [ ] `node labs/mini-agent.mjs "把 hello 倒过来写"` 输出 `olleh`
- [ ] 你能指着 `for` 循环说出：哪一步是"思考"、哪一步是"行动"、哪一步是"观察"
- [ ] 你能把 `brain` 里的一条规则（比如"大写"）改成自己的逻辑并跑通

### 延伸

把 `brain` 换成 `callRealLLM`，填入 `DEEPSEEK_API_KEY`，让这个小智能体真正"会思考"。这一步直接通向项目 (c)。

## 项目 (b)：给 Pi 写一个扩展

### 目标

在**真实的 Pi** 里挂一个你自己的扩展（extension），让内置 LLM 多出一个可调用工具，或让用户多一条 `/命令`。目标不是写一个多厉害的功能，而是跑通 Pi 的插件加载链路。

### 用到的知识

- 扩展系统：扩展是一个 `default function (pi: ExtensionAPI)`（见第 45 章与 `extensions/types.ts`）
- `pi.registerTool(...)` 注册工具、`pi.registerCommand(...)` 注册命令、`pi.on("事件", ...)` 订阅生命周期
- 本地加载方式：`pi -e ./你的目录`，或把目录放进 `~/.pi/agent/extensions/` 自动发现

### 关键思路

Pi 的扩展**就是一个函数**，接收 `ExtensionAPI` 对象。最小可用形态（参考官方 `examples/extensions/with-deps/index.ts`）：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "today",
    label: "Today",
    description: "返回今天的日期，让 LLM 能获取实时时间",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: new Date().toISOString() }], details: {} };
    },
  });
}
```

配套 `package.json` 必须带一个 `pi` 字段告诉 Pi 入口在哪（参考 `with-deps/package.json`）：

```json
{
  "name": "my-pi-extension",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["./index.ts"] }
}
```

### 验收标准

- [ ] 新建目录 `my-ext/`，含 `index.ts` 与 `package.json`（带 `pi.extensions` 字段）
- [ ] `pi -e ./my-ext` 启动后无报错，扩展被加载
- [ ] 在对话里问"今天几号"，LLM 调用了你的 `today` 工具并返回日期
- [ ] （进阶）用 `pi.registerCommand("hi", ...)` 注册一条 `/hi` 命令并能触发

### 延伸

给工具加参数校验（用 `typebox` 的 `Type.String()`）、加 `promptSnippet` 让系统提示里出现工具说明、用 `pi.on("tool_call", ...)` 给危险命令加确认。这些都对应第 45 章。

## 项目 (c)：用 Pi 的 SDK 在 Node 脚本里跑一次编码任务

### 目标

不打开 CLI 界面，写一个 Node 脚本，用 `createAgentSession`（见第 44 章与 `packages/coding-agent/src/core/sdk.ts:169`）程序化地创建会话、发一条消息、拿到结果。这是"把 Pi 当引擎嵌入你自己的程序"的第一步，也是第 46 章桌面端 Agent 的核心。

### 用到的知识

- `createAgentSession()` 一站式创建会话，内部已经封装好 agent-loop（无需你写 `while` 循环）
- `AgentSession.prompt(text)` 发送用户消息并驱动整轮推理（见 `agent-session.ts:1116`）
- `session.subscribe(listener)` 订阅流式事件（文本增量、工具调用、结束）
- 模型通过 `getModel("deepseek", "deepseek-v4-flash")` 之类指定（DeepSeek provider 见第 17 章）

### 关键思路

SDK 帮你把项目 (a) 里手写的 `for` 循环、工具执行、结果回填全部封装好了。你只做三件事：

```
1. createAgentSession({ model, cwd })  → 拿到 { session }
2. session.subscribe(evt => ...)        → 监听流式输出（可选但推荐）
3. await session.prompt("帮我在 src 下建一个 hello.ts")  → 驱动一轮
```

模型选择写成：

```ts
import { getModel } from "@earendil-works/pi-ai";
const model = getModel("deepseek", "deepseek-v4-flash"); // 需已配置 DEEPSEEK_API_KEY
```

### 验收标准

- [ ] 脚本能 `import { createAgentSession } from "@earendil-works/pi-coding-agent"` 并运行
- [ ] 指定 DeepSeek 模型后，脚本向某目录发出一条编码指令
- [ ] 控制台能实时打印助手文本增量与工具调用过程
- [ ] 任务结束后，`src/hello.ts`（或你指定的文件）确实被创建
- [ ] 全程**没有**手写任何 `while`/`for` 循环驱动推理——那是 SDK 的事

### 延伸

把脚本改成"读一个需求文件 → 跑任务 → 把结果写回文件"，就是一个无界面的自动化编码机器人。再套一层 Electron+Vue（第 46 章），就有了桌面端 Agent。

## 三个项目的关系图

```
        ┌─────────────────────────────────────────────┐
        │  (a) 最小智能体：手写 while 循环，懂原理     │
        └───────────────────────┬─────────────────────┘
                                │ 你知道了"循环该长什么样"
                                ▼
        ┌─────────────────────────────────────────────┐
        │  (b) 写扩展：在真 Pi 里挂工具/命令，懂插件   │
        └───────────────────────┬─────────────────────┘
                                │ 你知道了"怎么给 Pi 加能力"
                                ▼
        ┌─────────────────────────────────────────────┐
        │  (c) 用 SDK：让 Pi 当引擎，驱动一次编码任务  │
        └───────────────────────┬─────────────────────┘
                                │ 你知道了"怎么在代码里开车"
                                ▼
        ┌─────────────────────────────────────────────┐
        │  (第46章) 套 Electron+Vue → 你的桌面端 Agent │
        └─────────────────────────────────────────────┘
```

> **提示**
>
> 先跑 (a) 再写 (b)。很多人卡在 (b) 是因为还没建立"agent-loop 是个循环"的直觉，于是看不懂扩展里 `pi.on("tool_call")` 到底在拦截什么。顺序对了，三章一天就能走完。

## 动手锦囊：每步预计卡在哪

为了避免你做到一半怀疑人生，这里提前标出三个项目各自最易卡的点与破法。

### 项目 (a) 的卡点：循环变量作用域

`mini-agent.mjs` 的 `history` 是闭包外的数组，循环里不断 `push`。新手容易把 `history` 写成每次循环新建，导致"观察"进不了下一轮。破法：确认 `history` 在 `for` 外声明、`tool` 结果用 `history.push(...)` 回填（源码第 98 行）。

### 项目 (b) 的卡点：入口字段写错

扩展不生效，90% 是 `package.json` 写成 `"pi": "./index.ts"`（漏了 `extensions` 数组），或 `-e` 指向了 `.ts` 文件。正确形态是 `"pi": { "extensions": ["./index.ts"] }`，且 `-e` 指向目录。卡住时回到第 45 章第一节对照。

### 项目 (c) 的卡点：包没构建

`import { createAgentSession } from "@earendil-works/pi-coding-agent"` 报模块找不到，是因为仓库多包未 build。先按第 14 章把 Pi 构建/链接好，再跑你的脚本。这个坑在第 47 章"构建与运行环境"有专门表格。

### 如果只想做其一

时间紧就做 (a)+(c)：(a) 建立循环直觉，(c) 直接产出"能编码的脚本"。(b) 是插件机制的练习，想做桌面 Agent（第 46 章）时迟早要会，但不阻塞主线。

## 三项目共用的心智模型

不论做哪个项目，记住同一句话：**智能体 = 一个会循环的大脑 + 一双手（工具）+ 一段记忆（上下文）**。

- 项目 (a) 让你亲手写"循环"与"手"，大脑用规则代替
- 项目 (b) 让你给"手"加新能力（工具/命令），大脑仍是 Pi 的 LLM
- 项目 (c) 让你直接开"整车"（SDK），循环、手、记忆 Pi 全包了

三者抽象一致，只是封装层次不同。带着这个模型读后续章节，你会发现第 44 章的 `createAgentSession` 不过是把 (a) 的手写循环"产品化"了。

## 常见问题（动手前先扫一眼）

**Q：项目 (a) 的 `brain` 是"假大脑"，这还有意义吗？**
有。真实 LLM 本质也是"给定历史，输出下一步决策"，只是决策由神经网络而非 `if` 产生。先把控制流看明白，再换大脑，你才不会对着黑盒发懵。

**Q：三个项目必须按顺序做吗？**
强烈建议。但如果你已熟悉 agent-loop 概念，可从 (b) 直接开始。(c) 依赖你对 SDK 的信任——那种信任最好来自先看懂 (a) 的循环。

**Q：我卡在"扩展没加载"怎么办？**
九成是 `package.json` 缺 `pi.extensions` 字段，或 `-e` 指向了文件而非目录。详见第 45、47 章。

**Q：(c) 跑起来报 "no models available" 是代码错吗？**
不是，是没配模型 key。DeepSeek 需要 `DEEPSEEK_API_KEY` 环境变量（见第 17、44 章）。先确认 key 再怀疑代码。

**Q：这些项目做完，离第 46 章的桌面 Agent 还差什么？**
差一层"壳"：把 (c) 的 `console.log` 换成 IPC 推给 Vue 界面。引擎层你已经有了，第 46 章就是把引擎装进 Electron。

## 验收没过怎么办

- (a) 跑不通：先 `node -v` 确认 Node 在；再逐行 `console.log(history)` 看循环是否推进。
- (b) 工具不出现：确认 `package.json` 的 `pi.extensions` 指向 `./index.ts`，且 `pi -e ./目录` 指向目录。
- (c) 报模块找不到：Pi 包未 build，回到第 14 章构建；报无模型则是 key 问题（第 44 章）。

## 自查清单

- [ ] 我跑通了 `mini-agent.mjs`，并能口述 think→act→observe 三步对应哪几行代码
- [ ] 我理解项目 (a) 的"规则大脑"与真实 LLM 的替换关系
- [ ] 我新建了一个含 `pi.extensions` 字段的 `package.json` 扩展目录
- [ ] 我能在 Pi 里加载自己的扩展并看到工具/命令生效
- [ ] 我知道 `createAgentSession` 与 `session.prompt` 分别负责"建会话"和"发消息"
- [ ] 我清楚 (a)(b)(c) 三者的递进关系，不打算跳步
