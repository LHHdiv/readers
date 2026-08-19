---
title: "第 46 章 · 从 0 到 1 构建 DeepSeek 桌面端 Agent（Electron + Vue）"
date: 2026-07-01
summary: "这是全文档的\"终点站\"。前面所有章节都在解释 Pi 的原理，本章把它们收束成一个你**真正能用**的东西：一个桌面应用，长这样——"
tags:
  - pi
---
# 第 46 章 · 从 0 到 1 构建 DeepSeek 桌面端 Agent（Electron + Vue）

这是全文档的"终点站"。前面所有章节都在解释 Pi 的原理，本章把它们收束成一个你**真正能用**的东西：一个桌面应用，长这样——

```
┌──────────────────────────────────────────────┐
│  DeepSeek Agent            [模型: deepseek-v4-flash] │
├──────────────────────────────────────────────┤
│  你：帮我把 src/utils.ts 里的 add 函数加上类型   │
│                                                │
│  助手：好的，我来读取并修改……                  │
│   → 调用工具 read(src/utils.ts)                │
│   → 调用工具 edit(...)                          │
│   已完成 ✅ utils.ts 已更新                     │
└──────────────────────────────────────────────┘
```

它是**桌面软件**（Electron 壳），界面用 **Vue3** 画，大脑是 **Pi 的 `createAgentSession`**，模型走 **DeepSeek**。

> **说明**
>
> 核心心法：**Pi 是引擎，Electron+Vue 是壳**。你不要重新实现 agent-loop、工具执行、上下文压缩——那些 Pi 已经做好了（第 25、28、30 章）。你只负责：把用户的输入送到 Pi，把 Pi 的流式输出画到界面上。重复造轮子是最大的浪费。

## 为什么不用 Python 后端

约束来自你的技术栈：前端 Vue、希望后端也是 JS 系。理由如下：

- **Pi 是 TypeScript 项目**，SDK 入口 `@earendil-works/pi-coding-agent` 是 ESM 包（`packages/coding-agent/src/core/sdk.ts:169` 的 `createAgentSession`）。它必须在 Node 侧跑，没法塞进浏览器。
- **Electron 的主进程（main）就是 Node.js**。所以"让 Pi 在 Node 侧运行"天然契合 Electron 架构，无需额外起一个 Python 服务再跨进程通信。
- 因此分层变成：渲染进程(Vue) → IPC → 主进程(Node，跑 Pi) → DeepSeek API。全部 JS/TS，一套语言打通。

```
┌─────────── Electron 渲染进程 (Vue3) ───────────┐
│  聊天界面 / 输入框 / 消息流                      │
│        │  IPC:  sendMessage("帮我把…")          │
│        │  IPC:  onStream(chunk)  ← 文本增量      │
└────────┬───────────────────────────────────────┘
         │  ipcMain / ipcRenderer (JSON over IPC)
┌────────▼────────── Electron 主进程 (Node.js) ──┐
│  Pi 引擎封装层 (agent-engine.ts)                │
│   const { session } = await createAgentSession()│
│   session.subscribe(evt => 转发给渲染进程)      │
│   await session.prompt(text)                    │
│        │  HTTPS                                 │
│        ▼                                        │
│  DeepSeek API  https://api.deepseek.com         │
└─────────────────────────────────────────────────┘
```

## 项目骨架（目录树）

```
deepseek-agent/
├── package.json              # 主项目，含 electron + vue 依赖
├── electron/
│   ├── main.ts              # 主进程：建窗口 + 起 Pi 引擎 + 接 IPC
│   └── agent-engine.ts      # Pi 封装层（第 44 章那套）
├── src/                      # Vue 前端（渲染进程）
│   ├── main.ts              # Vue 入口
│   ├── App.vue              # 根组件
│   ├── components/
│   │   └── ChatPanel.vue    # 聊天面板，订阅流式事件
│   └── preload.ts           # 安全暴露 IPC 接口给渲染进程
├── vite.config.ts           # Vue 开发服务器配置
└── .env                      # DEEPSEEK_API_KEY=sk-...（不要提交进 git）
```

> **注意**
>
> `.env` 里放 key，务必把它写进 `.gitignore`。Electron 主进程用 `process.env.DEEPSEEK_API_KEY` 读取。绝不要把 key 硬编码进前端代码——前端会被打包进客户端，等于公开密钥。

## 主进程：启动 Pi 运行时

主进程里我们复用第 44 章的"引擎封装层"思路，把它接上 IPC。下面是 `electron/agent-engine.ts` 的关键形态（API 形状与第 44 章核对一致）：

```ts
// electron/agent-engine.ts
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { ipcMain } from "electron";

let session: AgentSession | undefined;

async function ensureSession(): Promise<AgentSession> {
  if (session) return session;
  const model = getModel("deepseek", "deepseek-v4-flash");
  if (!model) throw new Error("DeepSeek 模型不可用，请检查 DEEPSEEK_API_KEY");

  const result = await createAgentSession({
    cwd: process.cwd(),
    model,
    thinkingLevel: "medium",
    tools: ["read", "bash", "edit", "write"],
  });
  session = result.session;

  // 订阅事件，转成 IPC 推给渲染进程
  session.subscribe((evt) => {
    if (evcTypeIsText(evt)) {
      // 把文本增量发给前端
      mainWindow?.webContents.send("agent:stream", extractText(evt.message));
    }
    if (evt.type === "tool_execution_start") {
      mainWindow?.webContents.send("agent:tool", { name: evt.toolName, args: evt.args });
    }
    if (evt.type === "agent_end") {
      mainWindow?.webContents.send("agent:done");
    }
  });
  return session;
}

// 渲染进程发来用户消息 → 驱动一轮
ipcMain.on("user:message", async (_e, text: string) => {
  const s = await ensureSession();
  await s.prompt(text); // SDK 内部跑完整 agent-loop
});

function extractText(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  return (msg?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

function evcTypeIsText(evt: any): boolean {
  return evt.type === "message_update";
}
```

要点：
- `createAgentSession` 只建一次，之后复用同一个 `session`（会话状态会保留，符合第 32 章 session-tree 概念）。
- `session.prompt(text)` 是阻塞到本轮结束的，所以主进程用 `ipcMain.on` 异步接住即可。
- 所有"边想边干"的实时性，靠 `session.subscribe` 把事件 `webContents.send` 给渲染进程实现。

## 主进程：建窗口 + 注入 key

`electron/main.ts` 负责窗口与把环境变量传给 Pi。DeepSeek key 通过 `process.env` 注入（对应 `packages/ai/src/providers/deepseek.ts:11` 的 `envApiKeyAuth(["DEEPSEEK_API_KEY"])`）：

```ts
// electron/main.ts（节选）
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { startAgentEngine } from "./agent-engine.js";

// 启动前确保 key 在环境变量里（也可从 .env 用 dotenv 载入）
if (!process.env.DEEPSEEK_API_KEY) {
  console.warn("⚠️ 未检测到 DEEPSEEK_API_KEY，DeepSeek 调用会失败");
}

let win: BrowserWindow;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "../src/preload.js"),
      contextIsolation: true, // 安全：隔离渲染进程与 Node
      nodeIntegration: false,
    },
  });
  // 开发时加载 Vite 服务器；生产时 loadFile 打包后的 index.html
  win.loadURL("http://localhost:5173");
}

app.whenReady().then(() => {
  createWindow();
  startAgentEngine(win); // 把窗口句柄传进引擎，便于 send 流式事件
});
```

> **提示**
>
> `contextIsolation: true` + `preload` 是 Electron 安全标配。渲染进程（Vue）**不能直接** `require` Pi——Pi 必须在主进程跑。渲染进程只能通过 preload 暴露的 `window.api` 收发 IPC 消息。这就是上面那张分层图的硬性要求。

## preload：安全桥接 IPC

```ts
// src/preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  sendMessage: (text: string) => ipcRenderer.send("user:message", text),
  onStream: (cb: (chunk: string) => void) => ipcRenderer.on("agent:stream", (_e, c) => cb(c)),
  onTool: (cb: (info: any) => void) => ipcRenderer.on("agent:tool", (_e, i) => cb(i)),
  onDone: (cb: () => void) => ipcRenderer.on("agent:done", () => cb()),
});
```

## Vue 组件：订阅流式事件刷新 UI

渲染进程只管"发消息"和"收事件刷新界面"。`ChatPanel.vue` 的关键逻辑：

```ts
// src/components/ChatPanel.vue 的 <script setup lang="ts"> 逻辑（节选）
import { ref } from "vue";

const input = ref("");
const messages = ref<{ role: "user" | "assistant"; text: string }[]>([]);
const toolCalls = ref<string[]>([]);

function send() {
  if (!input.value.trim()) return;
  messages.value.push({ role: "user", text: input.value });
  // 开一个空的助手气泡，后续靠流式事件往里追加
  messages.value.push({ role: "assistant", text: "" });
  const assistant = messages.value[messages.value.length - 1];

  window.api.sendMessage(input.value);
  input.value = "";
}

// 主进程推来的文本增量，追加到最后一个助手气泡
window.api.onStream((chunk) => {
  const last = messages.value[messages.value.length - 1];
  if (last && last.role === "assistant") last.text += chunk;
});

window.api.onTool((info) => {
  toolCalls.value.push(`调用 ${info.name}: ${JSON.stringify(info.args)}`);
});

window.api.onDone(() => {
  // 本轮结束，可在此禁用"生成中"状态
});
```

上面的 `<script setup>` 是组件逻辑。配套的模板（template）用标准 Vue 写法即可，这里用文字描述其结构，避免贴出标签：

```
聊天面板模板结构（Vue 单文件组件 template 部分）
┌─────────────────────────────────────────────┐
│ 一个根容器 .chat                             │
│  ├─ 消息列表：v-for 遍历 messages，        │
│  │     按 role 显示"你"/"助手"前缀，        │
│  │     文本来自 m.text（流式增量累加处）     │
│  ├─ 工具列表：v-for 遍历 toolCalls，        │
│  │     显示"调用 xxx: 参数"                  │
│  └─ 输入框：v-model 绑定 input，            │
│        @keyup.enter 触发 send()             │
└─────────────────────────────────────────────┘
```

要点：模板只负责"显示 `messages` / `toolCalls` 并收集输入"，所有数据流来自 `window.api` 的回调。逻辑与视图严格分离，便于你之后换 UI 框架或加样式。

> **提示**
>
> Vue 单文件组件同时有 `<script setup>` 与 `template` 两块。本约束禁止在正文中出现 HTML 标签，因此模板部分用 ASCII 框图描述，你落地时照此写出标准 Vue 标签即可（根容器 + 两个 `v-for` 列表 + 一个绑定回车的输入框）。

渲染进程**完全不碰 Pi、不碰 key、不碰 DeepSeek**。它只是个"显示器 + 键盘"。这就是"壳"的姿态。

## 把 key 注入的完整路径

```
.env  ──(dotenv 或启动脚本)──▶  process.env.DEEPSEEK_API_KEY
                                       │
                              Electron 主进程 (Node)
                                       │  Pi 启动时读取
                                       ▼
        createAgentSession → ModelRuntime → deepseek provider
                  (packages/ai/src/providers/deepseek.ts:10-11)
                                       │  HTTPS 带 Authorization: Bearer
                                       ▼
                          https://api.deepseek.com
```

启动方式（在 `package.json` 里写好脚本）：

```bash
# 开发模式：一个终端跑 Vite，一个终端跑 Electron
export DEEPSEEK_API_KEY="sk-你的key"   # 或放进 .env 用 dotenv
npm run dev
```

> **说明**
>
> DeepSeek provider 的 `baseUrl` 在源码里硬编码为 `https://api.deepseek.com`（`deepseek.ts:10`），鉴权读环境变量 `DEEPSEEK_API_KEY`（`deepseek.ts:11`）。你不必改 Pi 源码就能用 DeepSeek——只要把 key 放进主进程环境变量即可。想换模型，用 `getModel("deepseek", "deepseek-v4-flash")` 之类的 id（第 17 章讲过 DeepSeek 模型目录）。

## 能不能脱离 Electron，先验证引擎层？

能，而且**强烈建议先做这步**再上 Electron。第 44 章的 `run-once.ts` 其实就是这个桌面 Agent 的"引擎层"原型。把它跑通（确认 Pi+DeepSeek 能正常编码），再套 Vue 壳，排查范围会小很多。

```
先验证：  node run-once.ts          ← 引擎 OK？
   ↓
再套壳：  npm run dev (Electron+Vue) ← 只是把 console.log 换成 IPC.send
```

## 常见功能映射（你要的 vs Pi 给的）

| 桌面 Agent 想要 | Pi 里怎么拿 | 参考 |
|-----------------|------------|------|
| 实时打字机效果 | `session.subscribe` 的 `message_update` | 第 44 章 |
| 显示"正在调用工具" | `tool_execution_start` / `tool_execution_end` | `types.ts` |
| 停止生成 | `ctx.abort()` / `session.abort()` | `types.ts:336` |
| 切换模型 | `pi.setModel` 或重开 `createAgentSession` | `types.ts:1353` |
| 多轮上下文延续 | 复用同一 `session`，不重建 | `agent-session.ts` |
| 会话持久化 | `SessionManager` 自动写 jsonl | 第 31 章 |

> **提示**
>
> "停止生成"按钮在桌面端很关键。Pi 的扩展上下文提供 `ctx.abort()`（`types.ts:336`），你的 Vue 按钮通过 IPC 调主进程的 `session.abort?.()` 即可中断当前流式轮次。先确认 `AgentSession` 暴露了 `abort` 方法（运行时 IDE 类型提示可查），再接线。

## 自查清单

- [ ] 我理解"Pi 是引擎，Electron+Vue 是壳"的分工，不打算重写 agent-loop
- [ ] 我知道 Pi 必须在 Electron 主进程（Node）跑，不能进渲染进程
- [ ] 我能画出 渲染进程 → IPC → 主进程(Pi) → DeepSeek 的分层图
- [ ] 我会用 `createAgentSession` 在主进程建会话并 `session.subscribe` 转发事件
- [ ] 我理解 `DEEPSEEK_API_KEY` 走 `process.env` 注入、不放前端
- [ ] 我知道 preload + contextIsolation 是安全桥接 IPC 的方式
- [ ] 我会先跑通引擎层（第 44 章脚本）再套壳，缩小排查面
- [ ] 我知道"停止生成"对应 `abort()`，实时输出对应 `message_update`
