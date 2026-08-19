---
title: "第 45 章 · 术语总表与进阶路线"
date: 2026-08-01
summary: "走到这一章，你已经把 DeepTutor 从\"外壳\"拆到\"发动机\"，还亲手写过工具和能力。最后一章做两件事：把全教程出现过的黑话**一次性收齐**，再给你一张**与 Pi 的对比表**和**继续深入的路线图**。遇到忘了的词，回来查这张表就够了。"
tags:
  - deeptutor
---
# 第 45 章 · 术语总表与进阶路线

走到这一章，你已经把 DeepTutor 从"外壳"拆到"发动机"，还亲手写过工具和能力。最后一章做两件事：把全教程出现过的黑话**一次性收齐**，再给你一张**与 Pi 的对比表**和**继续深入的路线图**。遇到忘了的词，回来查这张表就够了。

## 术语总表（≥40 条）

下表"真源码位置"列标了本章引用的文件:行；没标的表示是通用概念。

| 术语 | 一句话定义 | 真源码位置 |
| --- | --- | --- |
| Agent（智能体） | 能感知、推理、调用工具来完成目标的 AI 程序 | 全书主线 |
| LLM（大语言模型） | 用海量文本训练出的、能生成自然语言的基础模型 | facade.py:114 |
| Transformer | 现代 LLM 的底层的注意力网络架构 | 通用概念 |
| token | 模型读写的最小单位（词/字/符号的切片） | 通用概念 |
| context window（上下文窗口） | 模型一次能"看到"的 token 总量上限 | loop.py:86 裁剪钩子 |
| function calling | 模型按约定格式请求调用某个函数（工具） | tool_protocol.py:63 |
| ReAct | "推理+行动"交替的 agent 范式，边想边调工具 | 通用概念 |
| RAG（检索增强生成） | 先检索资料再让模型基于资料回答 | builtin/__init__.py:95 |
| MCP（模型上下文协议） | 给外部工具/服务接进模型的开放协议 | tool_registry.py 别名 |
| streaming（流式） | 答案一个字一个字实时推给前端 | stream_bus（capability_protocol.py:17） |
| label-driven loop（标签驱动循环） | 模型每行先自报标签，程序按标签路由 | loop.py:173 |
| L1/L2/L3 memory | 短/中/长三层记忆（对话/会话/长期画像） | capability_protocol.py:16 |
| Capability（能力） | 多阶段深度模式剧本（如 deep_solve） | capability_protocol.py:33 |
| Provider（提供商） | 提供模型或 embedding 的服务方（openai 等） | provider_runtime.py:55 |
| event stream（事件流） | 后端向前端持续推送的状态/正文流 | facade.stream_turn |
| BookEngine | DeepTutor 的教材/知识书引擎 | 通用概念 |
| mastery（掌握度） | 学生对知识点的掌握程度追踪 | builtin_capabilities.py:10 |
| Partner（伙伴） | 可定制人格的陪伴式智能体配置 | 通用概念 |
| sandbox（沙箱） | 隔离运行代码/命令的安全环境 | 通用概念 |
| Tool（工具） | 智能体在对话中途调用的单步函数 | tool_protocol.py:206 |
| ToolDefinition | 给模型看的工具"身份证"（名/说明/参数） | tool_protocol.py:48 |
| ToolResult | 工具执行后返回给模型的"回话" | tool_protocol.py:122 |
| BaseTool | 所有工具继承的抽象基类 | tool_protocol.py:206 |
| ToolParameter | 工具单个输入参数的 schema | tool_protocol.py:16 |
| CapabilityManifest | 能力的静态元数据"简历" | capability_protocol.py:20 |
| BaseCapability | 所有能力继承的抽象基类 | capability_protocol.py:33 |
| run_agentic_loop | 标签驱动循环的发动机函数 | loop.py:173 |
| LabelProtocol | 声明某能力允许哪些标签的词汇表 | loop.py:39 |
| LoopHost | 能力接进循环时实现的回调集合 | loop.py:79 |
| LoopOutcome | 循环跑完交出的结果（含最终答案） | loop.py:67 |
| ToolRegistry | 全局工具注册表（发现/调用工具） | tool_registry.py:147 |
| CapabilityRegistry | 全局能力注册表 | capability_registry.py:108 |
| Orchestrator（编排器） | 把各层串起来驱动一轮对话的总指挥 | facade.py:114 |
| WebSocket | 前后端双向实时通信协议 | turn_runtime.py:682 |
| Knowledge Base（知识库） | 你挂载的教材/题库等检索语料 | builtin/__init__.py:95 |
| embedding（嵌入） | 把文字转成向量的数值表示 | embedding_endpoint.py:185 |
| vector（向量） | embedding 产出的高维数组，用于相似度匹配 | 通用概念 |
| chunk（切块） | 长文档被切成的小段，便于检索 | 通用概念 |
| prompt（提示词） | 写给模型的指令文字 | 通用概念 |
| system prompt | 设定模型角色/规则的系统级提示 | 通用概念 |
| temperature | 控制输出随机性的参数（低=稳，高=活） | provider_runtime.py |
| token budget | 单次/单轮允许的 token 上限预算 | loop.py:217 |
| subagent（子智能体） | 被主能力派去干专项任务的小 agent | builtin_capabilities.py |
| Notebook（笔记） | 学生可写的随堂笔记区 | tool builtin |
| Skill（技能） | 可复用的一段专项能力/脚本 | tool builtin |
| deferred tool（延迟工具） | 按需才加载 schema 的渐进披露工具 | tool_protocol.py:232 |
| CLI alias（命令行别名） | 能力/工具的命令行简称 | capability_protocol.py:28 |
| ask_user（问用户） | 工具让 agent 暂停等待用户回答 | tool_protocol.py:138 |

> **说明 · 怎么用这张表**
>
> 把"术语"当索引。比如你忘了 `LoopHost` 是干嘛的，直接搜到它在 `loop.py:79`，回去翻第 42 章——你会发现它就是"把能力专属逻辑接进通用循环"的那组回调。

## 与 Pi 的完整对比表

Pi 是 Inflection 公司推出的对话式 AI 伴侣（2023–2024），以温暖、共情、无任务执行为特点；DeepTutor 是开源的教育智能体引擎。两者代表"消费级聊天伴侣"与"可定制教育智能体平台"两种取向。

| 维度 | Pi（Inflection） | DeepTutor |
| --- | --- | --- |
| 定位 | 共情聊天伴侣 | 开源教育/辅导智能体引擎 |
| 是否开源 | 否（公司已转向 API 服务） | 是（本地可跑、可改） |
| 架构透明 | 闭源，不可见 | 全栈可见（core/runtime/agents） |
| 工具调用 | 有限、未开放 | 完整 Tool 层 + 注册表 |
| 深度能力 | 无多阶段模式 | Capability 多阶段剧本（loop.py:173） |
| 知识库 | 靠预训练知识 | 可挂载私有教材/题库（RAG） |
| 记忆 | 隐式、不可控 | L1/L2/L3 显式分层（context.py） |
| 多模态 | 语音为主 | 文本为主，可扩展图像/视频工具 |
| 语言 | 以英文共情见长 | 多语言，含中文教学优化 |
| 部署 | 官方托管 | 本地/自托管（serve + WS） |
| 可定制性 | 低（固定产品） | 高（写工具/能力/伙伴皆可） |
| 适合谁 | 想聊天的普通用户 | 想造辅导产品的开发者 |

> **提示 · 选 Pi 还是 DeepTutor**
>
> 如果你是**用户**，想要一个会倾听的聊天对象，Pi 式产品更合适；如果你是**开发者**，想做一个"能讲题、能查你教材、能记住学生错题库"的系统，DeepTutor 这类开源引擎才是起点。本章教你的，正是把它变成"你的 Pi"的方法。

## 后续进阶阅读路线

按"由浅入深"三步走，别一上来啃论文：

**第一步：把官方文档读薄（1–2 周）**

- OpenAI Function Calling 文档：理解 `tool_protocol.py:63` 生成的 schema 实际长啥样；
- Google Gemini / Anthropic 工具调用文档：理解为什么 `ToolParameter.items` 对 Gemini 是必填（见 `tool_protocol.py:21` 注释）；
- DeepTutor 源码路径速查：`deeptutor/core/`（协议层）→ `deeptutor/runtime/`（注册表/引导）→ `deeptutor/agents/`（各能力实现）→ `deeptutor/services/`（配置/记忆/知识库）。

**第二步：读三篇奠基论文（边读边对照代码）**

- *Attention Is All You Need*（2017）：Transformer 源头，对应术语表里"Transformer / token"；
- *ReAct: Synergizing Reasoning and Acting*（2022）：对应"label-driven loop"的思想原型，回看 `label_loop_demo.py:83` 会有"原来如此"感；
- *Retrieval-Augmented Generation for Knowledge-Intensive NLP*（2020）：对应 RAG，回看 `builtin/__init__.py:95` 的 `RAGTool`。

**第三步：动手改造（持续）**

- 改一个内置能力，加一个你自己的阶段；
- 写一个对接你公司内部 API 的工具，注册进 `tool_registry.py:147`；
- 把 `label_loop_demo.py` 扩成你自己的最小产品原型。

> **注意 · 别陷进"收藏即学会"**
>
> 论文和文档看过不算会。每读一篇，回去在 DeepTutor 源码里找一个对应实现，改一行跑一下——这才是真懂。进阶路线的终点不是"读完"，而是"改得动"。

## 全教程回顾（一张图收尾）

```text
你已走过的学习路径
   ┌──────────────────────────────────────────┐
   │ 第 1–10 章  概念地基：Agent / LLM / 循环   │
   ├──────────────────────────────────────────┤
   │ 第 11–30 章 引擎内部：loop / 标签 / 记忆    │  loop.py:173
   ├──────────────────────────────────────────┤
   │ 第 31–40 章 接口与运行：facade / WS / 配置  │  facade.py:114
   ├──────────────────────────────────────────┤
   │ 第 41–42 章 动手：写工具 / 写能力           │  tool_protocol.py:206
   │                                           │  capability_protocol.py:33
   ├──────────────────────────────────────────┤
   │ 第 43–45 章 落地：自建 / 排错 / 术语总表    │  你已抵达终点 🏁
   └──────────────────────────────────────────┘
```

恭喜走完 45 章。你不再是"完全不懂编程"的读者，而是一个**能用开源引擎造出自己辅导智能体**的开发者了。

## 概念关系地图（术语怎么连起来）

单看术语表是散的，下面这张图把它们串成一条链，帮你建立"全局心智模型"：

```text
用户消息
   │
   ▼
Orchestrator（facade.py:114 入口）
   │  按 capability 名字找到剧本
   ▼
Capability（capability_protocol.py:33）
   │  run() 里驱动
   ▼
run_agentic_loop（loop.py:173）── 标签驱动发动机
   │  每轮调 LLM，看 LabelProtocol（loop.py:39）
   ├─ THINK → 留存
   ├─ TOOL  → 经 LoopHost（loop.py:79）分发
   │              │
   │              ▼
   │         ToolRegistry（tool_registry.py:147）
   │              │  get/execute（:74 / :128）
   │              ▼
   │         BaseTool（tool_protocol.py:206）→ ToolResult（:122）
   └─ FINISH → LoopOutcome（loop.py:67）收尾
   │
   ▼
结果经 StreamBus 推回前端（WebSocket）
记忆来自 UnifiedContext（capability_protocol.py:16）
知识来自 Knowledge Base + RAG（builtin/__init__.py:95）
```

读完这张图，你应该能指着任意两个术语说出"谁调谁"。比如 `ToolResult` 是 `BaseTool.execute` 的返回值，被循环塞回对话——这就是第 41 章工具能"被循环发现与调用"的闭环。

## 常见误解澄清

新手最容易踩的几个认知坑，先在这里扶正：

- **误解：工具 = 函数。** 准确说：工具 = 函数 + 给模型的描述（`ToolDefinition`）+ 标准返回（`ToolResult`）。缺了后两者，模型看不见也不会用。
- **误解：能力 = 更聪明的工具。** 准确说：工具是单步，能力是多阶段剧本，内部靠 `run_agentic_loop` 反复调用工具。
- **误解：记忆是模型自带的。** 准确说：LLM 本身无记忆，记忆是 DeepTutor 通过 `UnifiedContext` 在每轮开始注入的。
- **误解：RAG 一定比不用强。** 准确说：RAG 依赖检索质量，检索空或索引错时反而拖累答案。先确保坑 6 解决。
- **误解：循环会自己"想通"。** 准确说：循环只是机械地"看标签路由"，能否终止全靠提示词引导模型输出 FINISH（`loop.py:217` 只是兜底）。

> **说明 · 概念澄清是排错的前提**
>
> 第 44 章六个坑，本质大多是对这些概念的误会。比如"agent 不记得"往往不是 bug，而是你没从 `context` 读记忆字段。把这张表背熟，排错速度翻倍。

## 核心源码路径导航（带行号）

把"去哪看"也收进总表，方便你回 source 深挖：

| 你想看什么 | 去哪个文件:行 |
| --- | --- |
| 工具三大件定义 | tool_protocol.py:16 / :48 / :122 / :206 |
| 工具注册与调用 | tool_registry.py:36 / :74 / :128 / :147 |
| 能力基类与清单 | capability_protocol.py:20 / :33 |
| 循环发动机 | loop.py:39 / :67 / :79 / :173 / :217 |
| 能力登记字典 | builtin_capabilities.py:3 |
| 能力注册表 | capability_registry.py:39 / :45 / :49 / :108 |
| 回合入口 | facade.py:114 / turn_runtime.py:682 |
| Embedding 校验 | embedding_endpoint.py:185 / :239 |
| Provider 规格 | provider_runtime.py:55 / :83 |
| 日志目录/级别 | logging/config.py:19 / :25 / :48 |
| 最小循环演示 | label_loop_demo.py:34 / :83 / :92 |

## 你该从哪里继续：分角色路线

不同目标，进阶重点不同：

- **想做产品**：深读 `deeptutor/agents/`（各能力实现）+ 第 41/42 章，照第 43 章路线 A 落地。
- **想做研究**：读 ReAct / RAG 论文（见上），对照 `loop.py:173` 与 `builtin/__init__.py:95` 做实验。
- **想做平台/集成**：研究 `deeptutor/runtime/registry/`（注册表隔离）+ MCP 集成章节，把外部工具接进来。
- **纯兴趣**：把 `label_loop_demo.py:83` 改成你自己的玩具 agent，享受"造物"的快乐。

## 30 天挑战任务

给想"真正学会"的人一份 30 天练手清单（每天 30–60 分钟）：

```text
第 1–7 天   重读第 41–42 章，照抄并跑通一个天气工具 + 一个 quiz 能力
第 8–14 天  给工具加 sources/metadata（tool_protocol.py:149）；写第二个业务工具
第 15–21 天 挂载一个真实知识库，让能力用 rag 引用它（builtin/__init__.py:95）
第 22–28 天 读 ReAct 论文，对照 label_loop_demo.py:83 改一版自己的循环
第 29–30 天 写一份"我的 DeepTutor 改造笔记"，公开分享
```

## 术语缩写对照表

教程里大量缩写，集中对照一次，省得来回猜：

| 缩写 | 全称 | 中文 | 首次出现的章节主题 |
| --- | --- | --- | --- |
| LLM | Large Language Model | 大语言模型 | 概念地基 |
| RAG | Retrieval-Augmented Generation | 检索增强生成 | 知识库 |
| MCP | Model Context Protocol | 模型上下文协议 | 工具集成 |
| ReAct | Reasoning + Acting | 推理+行动 | 循环范式 |
| WS | WebSocket | 双向实时通信 | 运行接口 |
| KB | Knowledge Base | 知识库 | 检索 |
| API | Application Programming Interface | 应用编程接口 | Provider |
| SDK | Software Development Kit | 软件开发工具包 | 运行接口 |
| CLI | Command Line Interface | 命令行界面 | 能力别名 |
| L1/L2/L3 | Layer 1/2/3 Memory | 一/二/三层记忆 | 记忆系统 |

## 概念深度索引：按主题分组

术语表是平铺的，这里按"主题"重新分组，方便你针对薄弱点复习：

- **模型与推理**：LLM、Transformer、token、context window、temperature、function calling
- **循环与协议**：label-driven loop、LabelProtocol(loop.py:39)、LoopHost(loop.py:79)、LoopOutcome(loop.py:67)、run_agentic_loop(loop.py:173)
- **工具层**：Tool、ToolDefinition(tool_protocol.py:48)、ToolResult(:122)、BaseTool(:206)、ToolRegistry(tool_registry.py:147)、deferred tool
- **能力层**：Capability、CapabilityManifest(capability_protocol.py:20)、BaseCapability(:33)、CapabilityRegistry(capability_registry.py:108)、builtin_capabilities.py:3
- **知识与记忆**：Knowledge Base、RAG(builtin/__init__.py:95)、embedding(embedding_endpoint.py:185)、chunk、L1/L2/L3 memory(capability_protocol.py:16)
- **运行与接口**：Orchestrator、facade.start_turn(facade.py:114)、turn_runtime.start_turn(turn_runtime.py:682)、WebSocket、event stream、StreamBus(capability_protocol.py:17)
- **产品化概念**：Provider(provider_runtime.py:55)、Partner、BookEngine、mastery(builtin_capabilities.py:10)、sandbox、subagent、Notebook、Skill

> **提示 · 用"主题"而不是"字母"复习**
>
> 按主题分组复习，比背字典高效得多。比如你卡在"记忆没注入"，就该集中看"知识与记忆"那一组，而不是翻整张表。

## 给教学者：如何用地图讲给小白

如果你要把 DeepTutor 讲给另一个"完全不懂编程"的人，建议顺序：

1. 先讲 **Agent = 会调用工具的 AI**（不用提代码）；
2. 再讲 **循环 = 它和自己对话直到想清楚**（对应 `label_loop_demo.py:83`）；
3. 然后讲 **工具 = 它的手**、**能力 = 它的剧本**；
4. 最后才打开源码，指给他看 `tool_protocol.py:206` 和 `capability_protocol.py:33`。

先建立直觉，再给代码——这正是全书一直用的教法，也是你未来带人的最好方式。

## 一句话串联核心概念（故事版）

把所有术语编进一个"agent 的一天"故事，记忆会更牢：

```text
清晨，Orchestrator（facade.py:114）收到用户一条消息，
按名字从 CapabilityRegistry（capability_registry.py:108）取出今天的剧本 Capability（:33）。
剧本 run() 里，run_agentic_loop（loop.py:173）这个发动机开始转：
   模型先 THINK 想，要查资料就 TOOL，
   LoopHost（loop.py:79）把请求转给 ToolRegistry（tool_registry.py:147），
   找到 BaseTool（tool_protocol.py:206）跑出 ToolResult（:122）；
   需要教材时 RAG（builtin/__init__.py:95）去 Knowledge Base 取，
   需要记性时从 UnifiedContext（capability_protocol.py:16）读 L1/L2/L3 记忆。
直到 FINISH，LoopOutcome（loop.py:67）收尾，
答案经 StreamBus 顺着 WebSocket 推回前端。
——这就是一个开源教育智能体的完整一生。
```

## 面试 / 分享准备清单

如果你要拿 DeepTutor 去面试或做技术分享，这份清单能帮你快速自检掌握度：

- [ ] 能白板画出"标签驱动循环"的流程图（THINK/TOOL/FINISH 路由）
- [ ] 能解释 Tool 与 Capability 的职责边界与注册方式
- [ ] 能说清记忆三层（L1/L2/L3）各自存什么、何时注入
- [ ] 能对比 RAG 与微调（fine-tuning）的取舍
- [ ] 能讲出 DeepTutor 与 Pi 的核心差异（见上表）
- [ ] 能现场指源码：工具定义在 tool_protocol.py:206，能力在 capability_protocol.py:33

> **说明 · 教程到此结束，但学习没有终点**
>
> 45 章是这本书的终点，却是你作为智能体开发者的起点。DeepTutor 的源码会持续演进，但"工具 + 能力 + 循环 + 记忆 + 知识库"这套骨架是稳定的。守住骨架，你就能读懂任意新版本。

## 版本说明

本教程所有行号引用基于 **DeepTutor v1.5.11**。源码是活的文件，行号可能随版本微调；若你打开时发现行号对不上，以"类名/函数名 + 文件名"为准去搜即可——比如 `BaseTool` 一定在 `tool_protocol.py`，`run_agentic_loop` 一定在 `loop.py`。符号比行号更稳。

## 自查清单

- [ ] 我能不查表说出 Agent / LLM / RAG / Capability / Tool 分别是什么
- [ ] 我理解 label-driven loop、L1/L2/L3 memory、LoopHost 这些 DeepTutor 特有概念
- [ ] 我能说清 Pi 与 DeepTutor 在开源/可定制/知识库上的核心差异
- [ ] 我知道进阶第一步是读官方文档而非直接啃论文
- [ ] 我能说出三篇奠基论文各自对应教程里哪个概念
- [ ] 我记住了核心源码路径：core → runtime → agents → services
- [ ] 我认同"改一行跑一下"才是真学会，而非收藏资料
- [ ] 我能指给朋友看：工具定义在 tool_protocol.py:206，能力在 capability_protocol.py:33
