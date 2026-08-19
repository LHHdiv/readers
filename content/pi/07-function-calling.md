---
title: "第 07 章 · 函数调用与工具调用（Function Calling）原理"
date: 2026-07-01
summary: "JSON Schema 是一种用 JSON 描述\"数据应该长什么样\"的标准。比如声明一个参数 `city` 是字符串、必填，模型就知道生成 JSON 时要带上它。"
tags:
  - pi
---
# 第 07 章 · 函数调用与工具调用（Function Calling）原理

## 7.1 一句话直觉

你问大模型："北京今天多少度？"它**不知道**实时天气，因为它训练时没把这些数据塞进脑子。但它可以"写一张便条"给你（宿主程序）："请帮我调用 `get_weather(city="北京")`"。你这个程序真的去查了天气，把结果写回便条，再交给模型。模型看完结果，才用自然语言回答你。

这张"便条"就是**工具调用（Tool Call / Function Calling）**。关键认知：**模型从不亲自执行任何函数**，它只是在文本里"提议"要调用哪个函数、传什么参数；真正动手的是你写的代码。

> **提示 · 为什么模型不能直接调用函数**
>
> 大模型本质是"接收一串 token、吐出一串 token"的文本生成器。它没有操作系统权限、不能发网络请求、不能读你的硬盘。所谓"调用函数"，其实是模型生成了一段**结构化文本**，宿主程序解析这段文本后替它执行——这是"借宿主之手"，不是"模型自己动手"。

## 7.2 为什么需要工具调用

没有工具调用时，模型的能力被封死在三件事里：

- **训练数据截止**：它不知道今天的新闻、你的私人文件、数据库里的实时记录。
- **无法行动**：它不能改文件、跑命令、发请求，只能"说"。
- **纯文本输入输出**：遇到需要计算、查询、操作外部系统的任务就抓瞎。

工具调用把模型从"只会聊天的脑子"升级成"能动手的助手"。模型负责**决策**（该不该调、调哪个、传什么参），宿主负责**执行**（真正跑函数），再把结果喂回去让模型**总结**。这恰好是下一章"智能体"的核心循环。

## 7.3 工具声明：用 JSON Schema 描述"有哪些锤子"

在让模型调用工具前，你得先告诉它：**我手边有哪些工具，每个工具长什么样**。这个"说明书"就是工具声明，通常用 **JSON Schema** 写——它描述参数名、类型、是否必填、含义。

> JSON Schema 是一种用 JSON 描述"数据应该长什么样"的标准。比如声明一个参数 `city` 是字符串、必填，模型就知道生成 JSON 时要带上它。

在 Pi 的真源码里，一个工具是这样定义的（`packages/ai/src/types.ts:502`）：

```ts
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;                       // 工具名，如 "get_weather"
  description: string;                // 一句话说明"干嘛用"，模型靠它选工具
  parameters: TParameters;            // JSON Schema，描述参数结构
  constrainedSampling?: false | ConstrainedSamplingConfig; // 可选：约束采样
}
```

`description` 极其重要：模型是**读文字描述来决定用不用这个工具**的。描述写得含糊，模型就可能用错或不用。

## 7.4 模型输出 tool_call：它"写便条"

当模型决定调用工具时，它不再只输出普通文本，而是输出一个结构化的"工具调用"块。Pi 用 `ToolCall` 类型表示（`packages/ai/src/types.ts:360`）：

```ts
export interface ToolCall {
  type: "toolCall";
  id: string;                 // 这次调用的唯一编号，回填结果时要对上
  name: string;               // 工具名，对应 Context.tools 里的某个 name
  arguments: Record<string, any>; // 参数，已经解析成对象
  thoughtSignature?: string; // Google 系专用，复用思考上下文的签名
  namespace?: string;        // OpenAI Responses 里动态加载工具的命名空间
}
```

注意 `arguments` 是 `Record<string, any>`——也就是说 Pi 在内部已经把模型吐出的 JSON 字符串**解析成对象**了。模型原始输出其实是一段 JSON 文本（如下面的请求/响应示例），是宿主或 SDK 负责解析。

## 7.5 宿主执行并回填：把结果"贴回便条"

模型给出 `tool_call` 后，一轮生成就结束了（`stopReason` 会变成 `"toolUse"`）。这时**轮到你的程序上场**：

1. 用 `toolCall.name` 找到本地对应的函数实现；
2. 用 `toolCall.arguments` 调用它，拿到真实返回值；
3. 构造一条"工具结果"消息，塞回对话历史；
4. 再次把完整对话发给模型，让它基于结果继续。

Pi 用 `ToolResultMessage` 表示这一步的回填（`packages/ai/src/types.ts:437`）：

```ts
export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;         // 必须和上面 ToolCall.id 对上，否则模型分不清谁的结果
  toolName: string;           // 工具名
  content: (TextContent | ImageContent)[]; // 结果内容，支持文字和图片
  details?: TDetails;         // 可选的结构化细节
  isError: boolean;           // 工具执行是否报错（报错也要如实回填！）
  timestamp: number;
}
```

> **说明 · toolCallId 为什么必须配对**
>
> 一次回复里模型可能连发好几个工具调用（并行查多个天气）。`toolCallId` 就是"哪个结果对应哪个调用"的胶水。回填时若对不上号，模型会把 A 的结果当成 B 的，推理直接乱套。Pi 在 `openai-completions.ts:1189` 把 `ToolCall.id` 原样写进 OpenAI 请求的 `tool_calls[].id`，下游回填也靠它。

## 7.6 一个 OpenAI 兼容的请求/响应示例

下面是"最小可懂"的 OpenAI Chat Completions 风格例子。请求里用 `tools` 声明工具，模型在响应里用 `tool_calls` 提议调用。

请求（告诉模型有这么个工具）：

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "北京今天多少度？" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前气温",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名，如 北京" }
          },
          "required": ["city"]
        }
      }
    }
  ],
  "stream": true
}
```

响应（模型提议调用，注意 `finish_reason: "tool_calls"`）：

```json
{
  "choices": [
    {
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\": \"北京\"}"
            }
          }
        ]
      }
    }
  ]
}
```

宿主执行 `get_weather("北京")` 得到 `"23°C"`，回填后再发一轮：

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "北京今天多少度？" },
    { "role": "assistant", "content": null,
      "tool_calls": [
        { "id": "call_abc123", "type": "function",
          "function": { "name": "get_weather", "arguments": "{\"city\": \"北京\"}" } }
      ] },
    { "role": "tool", "tool_call_id": "call_abc123", "content": "23°C" },
    { "role": "user", "content": "请基于工具结果回答。" }
  ]
}
```

模型最终输出：`北京今天 23 度，挺舒服的。`

## 7.7 与智能体循环的关系

单个工具调用只是"一问一答"。**智能体的魔法在于把它包成一个循环**：

```text
用户提问
   │
   ▼
模型思考 → 输出 tool_call ──┐
   ▲                        │
   │                        ▼
   │                  宿主执行工具
   │                        │
   │                        ▼
   └──── 回填 ToolResultMessage ┘
（没结束就继续循环，结束了才给用户最终答案）
```

Pi 的 `Context` 类型（`packages/ai/src/types.ts:509`）把 `systemPrompt`、`messages`、`tools` 捆在一起，就是这个循环的"全局黑板"。每次循环：把历史 + 工具声明发给模型 → 收到 `AssistantMessage`（可能含 `ToolCall`）→ 执行 → 追加 `ToolResultMessage` → 再发。直到模型不再产出 `toolUse`，而是正常 `stop`。

> **注意 · 工具调用不是"越多越好"**
>
> 工具越多，模型选错、传错参的概率越高，prompt 也越长（还更贵，见第 12 章）。Pi 的做法是"按需给工具"——只在当前会话真正需要时才把工具声明塞进 `Context.tools`。这是工程里很实在的取舍。

## 7.8 并行调用与顺序调用

模型一次回复里，**可以连发多个 `tool_call`**（比如同时查北京和上海的天气）。这时 `stopReason` 仍是 `"toolUse"`，但 `AssistantMessage.content` 里会有多个 `ToolCall` 块。宿主应把这几个调用**都执行、都回填**，再统一发回模型。

```text
模型一次输出：
  toolCall#1: get_weather("北京")
  toolCall#2: get_weather("上海")
        │
        ▼
宿主并行执行两个函数（或顺序也行）
        │
        ▼
回填两条 ToolResultMessage（各自 toolCallId 对上）
        │
        ▼
整段历史再发给模型 → 模型综合两地结果作答
```

> **说明 · 并行不是必须**
>
> 是否真并行取决于你的宿主实现。逻辑上互不相干的工具可以并发省时间；有依赖的（先用 A 的结果当 B 的参数）必须顺序。Pi 只负责把 `tool_call` 块都放进 `content`，怎么跑由你的 agent 运行时（`packages/agent`）决定。

## 7.9 工具执行出错时怎么回填

工具**一定会**失败：文件不存在、命令非零退出、网络超时。关键原则：**失败也要如实回填**，不能吞掉。做法是在 `ToolResultMessage` 里设 `isError: true`，并把错误信息写进 `content`。模型看到错误，通常会自己换思路（换参数、换工具）重试——这正是智能体"自愈"的来源。

```text
模型: read_file("src/foo.ts")
宿主: 文件不存在 → ToolResultMessage { isError:true, content:"ENOENT: no such file" }
模型: 那我先列目录 → list_dir(".")   ← 看到错误后自动调整
```

> **注意 · 别把错误藏起来**
>
> 如果工具报错时你返回空结果或假装成功，模型会基于谎言继续推理，错误被放大且极难排查。诚实回填 `isError` + 真实报错文本，是 agent 可靠性的底线。

## 7.10 严格模式与参数约束（进阶）

很多供应商支持 `strict` 模式：要求模型输出的 `arguments` **必须完全符合 JSON Schema**（多字段、类型错都不行）。Pi 在 `Tool` 上用 `constrainedSampling` 字段表达这个意图（`types.ts:492`），并在 `openai-completions.ts:1361` 通过 `resolveJsonSchemaStrictSampling` 决定要不要给请求加 `strict: true`。开启后模型更"守规矩"，但兼容性因供应商而异——Pi 用 `compat.supportsStrictMode` 自动判断是否发送该字段（`openai-completions.ts:1524`）。

## 7.11 给模型写"好懂的工具说明书"

工具声明是写给模型看的"说明书"，写得好坏直接决定模型用不用得对。几条实打实的经验：

- **name 用动词开头的小写蛇形**：如 `get_weather`、`create_file`、`run_tests`，别用模糊名 `process` / `handle`。
- **description 写清"何时用 + 返回什么"**：模型靠它判断是否调用。差描述："查询"；好描述："当用户问某地实时天气时调用，返回摄氏温度字符串"。
- **参数描述写清单位与格式**：如 `lat` 标注"纬度，范围 -90~90"，避免模型瞎填。
- **少即是多**：只声明当前任务真用得上的工具。工具越多，模型越容易选错、prompt 越长越贵（呼应第 12 章）。

```text
好工具长这样（直觉版）：
  name: search_code
  description: 在代码库里按关键词搜索函数/符号定义，返回文件路径与行号。
               当用户问"某功能在哪实现"或"谁调用了 X"时使用。
  parameters:
    query: string  // 要搜的关键词或正则
    top_k: number  // 最多返回几条，默认 10
```

> **提示 · 工具描述 ≈ 给用户看的帮助文档**
>
> 想象你第一次用命令行工具，`--help` 写得好你才会用。模型没用过你的工具，全靠 `description` 这行"帮助"决定动作。把描述当产品文档写，agent 的准确率会肉眼可见地提升。

## 7.12 本章关键点回顾

- 模型"调用函数"是假象：它只生成结构化文本，宿主才真执行。
- 工具用 JSON Schema 声明，`description` 决定模型会不会用。
- `ToolCall`（`types.ts:360`）是模型提议，`ToolResultMessage`（`types.ts:437`）是宿主回填，`id`/`toolCallId` 必须配对。
- 工具调用 + 回填 + 再生成 = 智能体循环的最小单元。

## 自查清单

- [ ] 我能用自己的话解释：模型为什么不能直接执行函数？
- [ ] 我能说出"工具声明"用什么格式写，以及 `description` 的作用。
- [ ] 我能默写出 tool_call 的三要素：id、name、arguments。
- [ ] 我能解释 ToolResultMessage 的 `toolCallId` 为什么必须和 ToolCall 的 `id` 对上。
- [ ] 我能画出"模型输出 tool_call → 宿主执行 → 回填 → 再生成"的循环图。
- [ ] 我读得懂第 7.6 节的 OpenAI 请求/响应 JSON 示例。
- [ ] 我知道 Pi 里 `ToolCall` / `ToolResultMessage` 分别定义在哪个文件哪一行。
