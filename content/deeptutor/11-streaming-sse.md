---
title: "第 11 章 · 流式输出、SSE 与增量解析"
date: 2026-08-01
summary: "搞清楚\"为什么 ChatGPT 式的答案是一个字一个字蹦出来的\"。读完这章，你会明白流式（streaming）是什么、SSE 和 WebSocket 各是什么角色、以及 DeepTutor 在流式接收 token 的同时怎么\"一边收一边判断模型要干什么\"（标签探测）。"
tags:
  - deeptutor
---
# 第 11 章 · 流式输出、SSE 与增量解析

> 目标：搞清楚"为什么 ChatGPT 式的答案是一个字一个字蹦出来的"。读完这章，你会明白流式（streaming）是什么、SSE 和 WebSocket 各是什么角色、以及 DeepTutor 在流式接收 token 的同时怎么"一边收一边判断模型要干什么"（标签探测）。

黑话先定义：**流式输出（streaming）** 是"不等到模型把整段话生成完，而是生成一点就发一点"；**SSE（Server-Sent Events）** 是一种"服务器单向、持续推事件给浏览器"的 HTTP 技术；**增量解析（incremental parsing）** 是"收到半个 token 时就开始分析，而不是等齐了再分析"。

---

## 11.1 为什么需要流式？

### 11.1.1 不流式会怎样

如果不用流式，一次对话的体验是：

```text
用户点"发送"
    │
    ▼
  模型闷头生成 30 秒（屏幕上只有一个转圈）
    │
    ▼
  30 秒后"啪"一下整段答案出现
```

30 秒的空白等待，用户会以为卡死了。而流式输出：

```text
用户点"发送"
    │
    ▼
  模型生成第一个字 → 立刻发到屏幕
    │
    ▼
  第二个字 → 立刻发到屏幕   （用户感觉"它在打字"，体验接近真人）
    │
    ▼
  ……直到最后一个字
```

体验差距巨大。所以**几乎所有大模型 API 都支持流式**，几乎所有智能体产品都默认开流式。

### 11.1.2 一个比喻

不流式像**快递整箱发货**（攒齐才动）；流式像**水管送水**（水龙头一开就出水，一边出一边补）。用户要的是"先看到水"，而不是"等水缸满"。

## 11.2 SSE 与 WebSocket：两种"推送"技术

### 11.2.1 SSE：服务器单向喊话

SSE 是建立在普通 HTTP 之上的推送技术：客户端先发一个普通请求，服务器不关闭连接，而是**持续吐出一行一行的事件**。浏览器原生支持 `EventSource`，非常适合"模型生成 → 推给前端渲染"这种单向场景。

```text
浏览器 ──GET /events──► 服务器
浏览器 ◄── data: 你好   ──
浏览器 ◄── data: 世     ──    ← 服务器持续推，连接不断开
浏览器 ◄── data: 界     ──
浏览器 ◄── data: [DONE] ──    ← 结束标记
```

### 11.2.2 WebSocket：双向对讲机

WebSocket 是**双向**的：前端可以随时发消息，后端也可以随时推事件。DeepTutor 的前后端主链路用的是 WebSocket（`/api/v1/ws`，第 33 章细讲），因为智能体场景不只是"模型单向输出"，还有"前端随时发新指令、后端推各种进度事件（思考中/调工具/检索到 N 条）"的双向需求。

```text
WebSocket 双向通道
┌─────────┐                     ┌─────────┐
│  前端    │ ◄── 事件: 工具执行中 ── │  后端    │
│ (web)   │ ── 事件: 用户新消息 ──► │ (ws路由) │
└─────────┘                     └─────────┘
```

> **说明 · DeepTutor 的取舍**
>
> 消息总线 `StreamBus`（`deeptutor/core/stream_bus.py`）负责把"后端产生的所有事件"扇出（fan-out）给订阅者，其中一路就是 WebSocket 连接——它把总线事件翻译成推给前端的帧。SSE 和 WebSocket 都只是"传输管道"，真正的内容是**事件信封**（第 20 章）。

## 11.3 增量解析：一边收一边判断

### 11.3.1 难题：LABEL 还没收全怎么办

第 18 章会讲，DeepTutor 要求模型第一行先写一个 `LABEL`（如 `THINK`/`TOOL`/`FINISH`）。但流式收到的是一点一点的：

```text
第 1 个 chunk:  "TH"
第 2 个 chunk:  "INK"
第 3 个 chunk:  " 让我想想这个积分怎么算..."
```

如果程序等到"收到完整一整轮"再判断标签，就失去了流式的意义。所以要**增量解析**：边收边拼，拼出一点就判断一点。

### 11.3.2 DeepTutor 的标签探测机制

真实实现里有个专门文件 `deeptutor/core/agentic/labeled_step.py`。它定义了 `LabeledStepResult`（`labeled_step.py:96`）：

```python
class LabeledStepResult:
    # :96  一轮"带标签步骤"的结果
    ...
    label: str   # :99  这一轮模型的标签（如 THINK），协议失败时为 LABEL_UNKNOWN
    ...
```

核心入口是 `run_labeled_step`（`labeled_step.py:104`）——它一边流式接收模型 chunk，一边做标签探测：

```python
async def run_labeled_step(
    # :104  流式跑一轮：接收 chunk → 探测 LABEL → 累积正文
    ...
    if len(label_buf) > LABEL_PROBE_MAX_CHARS:
        # :363  探测缓冲区超过了最大字符数还没匹配到标签
        label = LABEL_UNKNOWN   # :367  判定协议失败，交给上层修复（18.5）
```

这里的 `LABEL_PROBE_MAX_CHARS`（定义在 `deeptutor/core/agentic/labels.py:18`，值为 64）意思是：**模型开头最多给 64 个字符的机会去写标签**，超过还没写出来，就判定"这轮协议违规"，走修复分支。

```text
流式标签探测示意（labeled_step.py 内部）:

  收到 chunk "TH"
      │  拼进 label_buf = "TH"
      ▼
  收到 chunk "INK"
      │  拼进 label_buf = "THINK"
      ▼
  classify_label("THINK")   →  命中！label = "THINK"
      │
      ▼
  后续 chunk 全部当作"正文"累积，直到这一轮结束
```

> **提示 · 为什么 64 字符就判违规**
>
> 标签最长也就几个词（THINK/TOOL/FINISH）。如果模型开头 64 个字符都在"自由发挥"，说明它没遵守协议——与其等它跑偏几百字再纠正，不如尽早打断、喂纠错提示让它重来。这是"**快速失败（fail fast）**"思想的体现。

## 11.4 事件怎么从后端到前端（全景图）

把本章和前面串起来，一条完整链路是：

```text
① AgentLoop 调用模型（流式）  loop.py:173
        │
        ▼
② run_labeled_step 接收 chunk   labeled_step.py:104
        │  一边收一边探测 LABEL、累积正文
        ▼
③ 产生事件（如 token 增量、工具执行进度）
        │
        ▼
④ StreamBus.emit(event)          stream_bus.py:40
        │  扇出给所有订阅者
        ▼
⑤ WebSocket 路由收到事件，推给前端   unified_ws.py:80 subscribe_turn
        │
        ▼
⑥ 前端把增量拼到气泡上，用户看到"打字效果"
```

第 ③–⑤ 步的细节分别在第 20 章（事件流）和第 33 章（API/WS）展开。本章你只需要建立直觉：**模型流式吐字 → 程序增量解析 → 事件总线扇出 → WS 推屏**。

## 11.5 关于"流式输出时前端在干嘛"

前端拿到的是**一堆增量事件**，不是整段答案。它要做三件事：

1. **拼接**：把 `delta` 文本追加到当前气泡的末尾。
2. **状态区分**：根据事件类型显示不同 UI（思考中 / 工具卡片 / 最终答案）。
3. **滚动**：内容变长时自动滚到底部，保证用户始终看到最新。

这些属于前端渲染（第 34 章简述），这里不深抠。

> **注意 · 新手常见误区**
>
> "流式 = 前端自己打字动画"——错。流式是**后端真的分片返回**，前端只是把收到的片拼起来；如果前端自己放动画而内容是一次性到的，那只是"假流式"，用户快速滚动时体验会露馅。

## 11.6 关联阅读

- 第 18 章：标签驱动循环——`run_labeled_step` 是循环的每一圈。
- 第 20 章：`StreamEvent` 信封与 `StreamBus` 扇出机制。
- 第 33 章：WebSocket 路由如何把总线事件推给前端。

## 自查清单

- [ ] 我能解释"为什么不用流式会体验很差"。
- [ ] 我能说清 SSE（单向）与 WebSocket（双向）的区别。
- [ ] 我知道 DeepTutor 前后端主链路用的是 WebSocket，事件内容由 StreamBus 提供。
- [ ] 我知道 `run_labeled_step`（labeled_step.py:104）在流式接收的同时做标签探测。
- [ ] 我知道 `LabeledStepResult.label` 字段（:99）和 `LABEL_UNKNOWN` 的含义。
- [ ] 我能说出 `LABEL_PROBE_MAX_CHARS = 64`（labels.py:18）的作用和设计意图（快速失败）。
- [ ] 我能画出"模型流式吐字 → 增量解析 → 总线扇出 → WS 推屏"的链路。
