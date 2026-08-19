---
title: "第 43 章 · 从 0 到 1 构建自己的辅导智能体"
date: 2026-08-01
summary: "前 42 章我们一直在\"拆解\"DeepTutor。现在反过来——你要**用学到的东西，造一个属于自己的辅导智能体**。这一章是全书的\"落地章\"，给你两条清晰路线、一份可填空的蓝图，以及三周做出最小可用版本（MVP）的节奏。"
tags:
  - deeptutor
---
# 第 43 章 · 从 0 到 1 构建自己的辅导智能体

前 42 章我们一直在"拆解"DeepTutor。现在反过来——你要**用学到的东西，造一个属于自己的辅导智能体**。这一章是全书的"落地章"，给你两条清晰路线、一份可填空的蓝图，以及三周做出最小可用版本（MVP）的节奏。

所有引用都指向真实代码：路线 A 用 `deeptutor/app/facade.py`、`deeptutor/runtime/...`；路线 B 用随项目附带的演示 `deeptutor-learning/labs/one-turn/label_loop_demo.py`。

## 两条路线怎么选（先直觉，后对比）

**直觉**：路线 A 像"买一辆整车，自己只改内饰和货箱"——DeepTutor 已经把引擎（循环）、底盘（WebSocket/SDK）、仪表盘（前端事件）都造好了，你只写业务（工具 + 能力 + 知识库）。路线 B 像"从发动机开始攒一辆卡丁车"——你只保留最核心的"标签驱动循环"灵魂，其余全用最小代码自己写，方便彻底理解或嵌入到你自己的系统。

**对比表**：

| 维度 | 路线 A：DeepTutor 作引擎 + 你的壳 | 路线 B：独立最小辅导 agent |
| --- | --- | --- |
| 你写多少代码 | 少（只写工具/能力/KB） | 多（循环、分发、接口都自己写） |
| 复用 DeepTutor | Orchestrator / Loop / WS / SDK 全用 | 只借用"标签驱动循环"思想 |
| 上线速度 | 快（几天） | 慢（几周，但理解最深） |
| 可控性 | 受框架约束 | 完全自由 |
| 适合谁 | 想快速做出产品的开发者 | 想彻底搞懂原理 / 嵌入自有系统的人 |
| 真实代码参照 | facade.py:114 / turn_runtime.py:682 | label_loop_demo.py:83 |

## 路线 A：DeepTutor 作引擎 + 你的壳

这条路线的核心心法一句话：**你只写"业务三件套"——工具、能力、知识库，其余全部复用 DeepTutor 的运行时。**

```text
你的"壳"（你写的少量代码）
   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐
   │  自定义工具   │  │ 自定义能力    │  │  你的知识库   │
   │ (第41章)     │  │ (第42章)      │  │ (教材/题库)   │
   └──────┬──────┘  └──────┬───────┘  └──────┬───────┘
          │ 注册             │ 登记             │ 挂载
          ▼                 ▼                 ▼
════════════════ DeepTutor 引擎（你几乎不改）════════════════
   ToolRegistry ── CapabilityRegistry ── BookEngine / RAG
          │                 │                    │
          └────────┬────────┘                    │
                   ▼                             │
            Orchestrator（编排）                  │
                   │                             │
                   ▼                             │
            run_agentic_loop（标签驱动循环）──────┘
                   │
                   ▼
            WebSocket / SDK 事件流 → 前端
```

**你复用的部分（不用碰）**：

- `facade.start_turn`（`deeptutor/app/facade.py:114`）：一次对话回合的入口，解析能力名、建会话。
- `turn_runtime.start_turn`（`deeptutor/services/session/turn_runtime.py:682`）：回合运行时，负责校验配置、接记忆、起循环。
- `run_agentic_loop`（`deeptutor/core/agentic/loop.py:173`）：标签驱动循环发动机。
- 全局注册表：`get_tool_registry`（`deeptutor/runtime/registry/tool_registry.py:147`）与 `get_capability_registry`（`deeptutor/runtime/registry/capability_registry.py:108`）。
- 前端事件流（StreamBus）、知识库检索（BookEngine / RAG）、记忆注入。

**你要写的部分（照第 41/42 章）**：

1. 写业务工具，注册进 `ToolRegistry`（第 41 章）；
2. 写业务能力，登记进 `BUILTIN_CAPABILITY_CLASSES`（`deeptutor/runtime/bootstrap/builtin_capabilities.py:3`）；
3. 准备你的教材/题库，挂成知识库（能力里用 `rag` 工具检索）。

> **提示 · 路线 A 的最小改动原则**
>
> 永远优先"加"而不是"改"。新功能写成新工具/新能力，挂载进现成注册表，而不是去改 `loop.py` 或 `facade.py`。这样 DeepTutor 一升级，你几乎零冲突地跟上。

## 路线 B：独立最小辅导 agent

如果你想要"从发动机开始理解"，项目已经附赠了一个**零依赖、能直接跑**的演示：`deeptutor-learning/labs/one-turn/label_loop_demo.py`。它把一个真实辅导循环压缩成 130 行纯 Python，`run_agentic_loop`（演示版在 `label_loop_demo.py:83`）展示了三件事：循环、协议违规修复、工具分发。

```text
路线 B 的最小结构（参考 label_loop_demo.py）
   ┌──────────────────────────────────────┐
   │  LabelProtocol  (label_loop_demo.py:34) │  标签词汇
   ├──────────────────────────────────────┤
   │  run_agentic_loop (label_loop_demo.py:83)│  循环发动机
   │     ├─ 调 fake_llm → 解析标签           │
   │     ├─ FINISH → 退出并返回答案          │
   │     ├─ THINK  → 留存继续               │
   │     └─ TOOL   → 解析参数、执行、回填    │
   ├──────────────────────────────────────┤
   │  tools: rag_search / 你的函数          │  业务工具=普通函数
   └──────────────────────────────────────┘
```

**照抄思路**：把演示里的 `fake_llm` 换成真 LLM 客户端（如 `openai` SDK），把 `rag_search` 换成你的业务逻辑（查题、查教材、算分），一个最小辅导 agent 就成型了。

```python
# 路线 B 骨架（思路来自 label_loop_demo.py:83，需 pip install openai）
from openai import OpenAI

client = OpenAI()  # 用你的 API key 环境变量

def real_llm(messages):
    # 真实调用：要求模型第一行自报标签 THINK/TOOL/FINISH
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
    )
    return resp.choices[0].message.content

# 循环本体、LabelProtocol、parse_labeled 直接复用 label_loop_demo.py 的结构，
# 仅把 fake_llm 换成 real_llm，把 rag_search 换成你的业务函数即可。
```

> **说明 · 路线 B 的价值不在"产品"在"顿悟"**
>
> 跑通 `label_loop_demo.py` 后你会真正明白：所谓"智能体"，内核不过是一个 `for` 循环 + "看标签路由" + "工具回填"。这层理解，会让你之后读 DeepTutor 真源码时不再发怵。

## 填空式蓝图模板

无论走哪条路线，先用这份蓝图把"做什么"想清楚。复制它，填空：

```json
{
  "agent_name": "我的辅导智能体",
  "target_user": "初中生 / 高中生 / 程序员备考者 ...",
  "subject": "数学 / 编程 / 英语 ...",
  "route": "A 或 B",
  "tools": [
    {"name": "查教材", "does": "从我的知识库检索章节", "input": "query"},
    {"name": "判题", "does": "比对标准答案给反馈", "input": "student_answer"}
  ],
  "capabilities": [
    {"name": "deep_practice", "stages": ["诊断", "出题", "讲解"], "tools": ["查教材", "判题"]}
  ],
  "knowledge_base": {
    "source": "教材 PDF / 题库 csv / 网页",
    "ingest": "挂成 DeepTutor KB（路线A）或自己切块（路线B）"
  },
  "memory": "要不要记住学生的错题库？L1/L2/L3 哪几层？",
  "ui": "复用 DeepTutor 前端（路线A）或自己写一个聊天框（路线B）"
}
```

填完这份蓝图，你就知道该写几个工具、几个能力、知识库从哪来——不会在动手时迷路。

## 三周 MVP 节奏

把"从 0 到 1"拆成三周，每周都有可验证产出：

```text
第 1 周 · 跑通骨架
   ├─ 路线A：装好 DeepTutor，写 1 个工具并注册，前端能看到它被调用
   └─ 路线B：跑通 label_loop_demo.py:83，换成真 LLM 出一次答案
   验收：用户问一个问题，agent 能回一句像样的答案

第 2 周 · 接上知识与工具
   ├─ 路线A：挂一个知识库，让能力用 rag 检索；写一个判题工具
   └─ 路线B：加 rag_search 真逻辑（切块+向量检索或简单关键词）
   验收：agent 的回答开始"引用"你的教材内容

第 3 周 · 多阶段 + 记忆
   ├─ 路线A：写第一个能力，含 2~3 个阶段，登记进 builtin_capabilities.py:3
   └─ 路线B：把单循环扩成"诊断→出题→讲解"多阶段
   验收：agent 能走完一个完整辅导流程，并记住学生常错点
```

> **注意 · 别在第一周追求完美**
>
> MVP 的关键是"先有一个能跑的丑东西"。第一周哪怕 agent 只会机械回一句，只要循环通了，后面每周都是在它上面"长肉"。很多人卡在开头想把架构想完美，结果一行代码没写。

## 路线 A 落地清单：具体改哪些文件

把"复用引擎"说得更具体，你实际要碰的文件就这几个：

```text
你要新建/修改的文件（路线 A）
   ├─ my_tools/weather_tool.py        写工具（第41章）
   ├─ my_capabilities/quiz_cap.py     写能力（第42章）
   ├─ deeptutor/tools/builtin/__init__.py   把工具加进 BUILTIN_TOOL_TYPES（:1562）
   ├─ deeptutor/runtime/bootstrap/builtin_capabilities.py  登记能力（:3）
   └─ data/knowledge_bases/<你的库>/           放教材/题库
你完全不碰的文件
   ├─ deeptutor/core/agentic/loop.py          循环发动机
   ├─ deeptutor/app/facade.py                 回合入口（facade.py:114）
   └─ deeptutor/services/session/turn_runtime.py  运行时（turn_runtime.py:682）
```

记住"加而不改"原则：新功能写成新工具/新能力挂进去，别去改 `loop.py` 或 `facade.py`。这样 DeepTutor 升级时你几乎零冲突。

## 知识库怎么准备（RAG 的前提）

路线 A 里让 agent "引用教材"靠 RAG（`deeptutor/tools/builtin/__init__.py:95` 的 `RAGTool`）。它检索的是"本回合挂载的知识库"，所以你要先准备好语料：

1. 把教材/题库整理成文件（PDF、Markdown、txt 均可）；
2. 在 DeepTutor 里建一个知识库，把文件放进去（目录形如 `data/knowledge_bases/<库名>/`）；
3. embedding 端点必须正确（坑 3 那一章讲过，结尾要 `/embeddings`，见 `embedding_endpoint.py:239`）；
4. 用户发起对话时"挂载"这个库，能力里用 `rag` 工具、带正确的 `kb_name` 去检索。

如果检索为空，先回到第 44 章坑 6 排查：十有八九是 `kb_name` 拼错或索引没建好。

## 记忆怎么接进去

DeepTutor 的记忆是分层的（L1 对话 / L2 会话 / L3 长期画像），通过 `UnifiedContext`（`deeptutor/core/capability_protocol.py:16`）在回合开始注入。路线 A 默认就接好了——你只要在能力 `run()` 里从 `context` 读取对应字段，就能让 agent "记得"学生之前的错题库。想自定义记忆行为（比如只记某种题型），就写一个 `write_memory` / `read_memory` 风格的工具，复用内置工具的模式。

## 前端怎么连（WebSocket 速览）

路线 A 的前端通过 WebSocket 把"开始一轮"的请求发给后端。后端入口是 `facade.start_turn`（`deeptutor/app/facade.py:114`），它把请求转给 `turn_runtime.start_turn`（`deeptutor/services/session/turn_runtime.py:682`）起回合，循环产生的事件再通过 `stream` 原路推回前端。你**基本不用写这部分**——除非你要完全自定义前端，那时只消照着"建立 WS 连接 → 发 start_turn → 监听事件流"三步走即可。

## 三周计划逐日细化

前面给了三周节奏，这里把每周拆成可执行的日目标：

```text
第 1 周（跑通骨架）
  周一  装好 DeepTutor，能起 serve、前端能连
  周二  照第41章写 1 个工具并注册进 ToolRegistry
  周三  前端对话里验证该工具被调用
  周四  路线B同学：跑通 label_loop_demo.py:83，换真 LLM
  周五  写下你的"填空式蓝图"（本章模板）

第 2 周（接知识+工具）
  周一  准备一个知识库并挂载
  周二  让能力用 rag 检索（验证能引用教材）
    周三  写一个业务工具（如判题）
  周四  路线B：给 demo 加 rag_search 真逻辑
  周五  验收：回答开始带引用

第 3 周（多阶段+记忆）
  周一  照第42章写第一个能力，含 2~3 阶段
  周二  登记进 builtin_capabilities.py:3
  周三  接记忆：让 agent 记住学生常错点
  周四  端到端走完一次完整辅导流程
  周五  压测/调优（见第44章性能四则）
```

## 决策小流程图：我该选哪条路线

```text
你想快速做出可用产品？
   │
   ├─ 是 ─► 路线 A（DeepTutor 作引擎 + 你的壳）
   │           只写工具/能力/知识库，复用 facade/turn_runtime/loop
   │
   └─ 否 ─► 你想彻底搞懂原理 / 嵌入自有系统？
                 │
                 ├─ 是 ─► 路线 B（独立最小 agent，参考 label_loop_demo.py:83）
                 │
                 └─ 都想 ─► 先 B 学原理，再 A 做产品（推荐组合）
```

## 两条路线如何衔接

其实路线 A 和 B 不是非此即彼：你可以先用路线 B 的 `label_loop_demo.py` 把循环原理吃透，再用路线 A 把产品化（WebSocket、记忆、前端）交给 DeepTutor。很多资深开发者就是"B 学原理、A 做产品"的组合打法。

## 路线 A 完整配置示例

把前面零散的配置汇总成一个"启动配置"，你照着填就能跑：

```json
{
  "engine": "deeptutor",
  "reuse": ["facade.start_turn (facade.py:114)", "turn_runtime.start_turn (turn_runtime.py:682)", "run_agentic_loop (loop.py:173)"],
  "my_tools": ["my_tools.weather_tool:WeatherTool"],
  "my_capabilities": {"deep_quiz": "my_capabilities.quiz_capability:DeepQuizCapability"},
  "knowledge_bases": [{"name": "math_book", "path": "data/knowledge_bases/math_book/"}],
  "embedding": {"provider": "openai", "endpoint": "https://api.openai.com/v1/embeddings"},
  "llm": {"provider": "openai", "model": "gpt-4o-mini"}
}
```

这份配置和本章"填空式蓝图"是同一件事的两面：蓝图想清楚"做什么"，这份配置落到"怎么接"。对应关系一目了然——`my_tools` 进 `BUILTIN_TOOL_TYPES`（builtin/__init__.py:1562），`my_capabilities` 进 `BUILTIN_CAPABILITY_CLASSES`（builtin_capabilities.py:3）。

## 如何验收路线 A 真的跑通

不要"感觉能跑"，用这份验收单逐项打勾：

```text
□ 前端能连上 serve（curl healthz 通过）
□ 发一条消息，agent 正常回复（facade.py:114 链路通）
□ 调用你的工具时，日志出现工具名（tool_registry.py:128 被执行）
□ 挂载知识库后，rag 能返回带 sources 的内容（builtin/__init__.py:95）
□ 选择你的能力（deep_quiz），走完多阶段并出结果（capability_registry.py:108）
□ 第二轮对话能引用第一轮的记忆（capability_protocol.py:16）
```

六条全过，说明"引擎 + 你的壳"已经是一个完整产品雏形。剩下的只是打磨体验。

> **提示 · 验收不过，从第一条往下查**
>
> 验收是链式的：前端连不上，后面全白搭；工具没日志，先确认注册。永远从最靠前的失败项修起，不要跳着修。

## 新手最常问的 5 个问题（FAQ）

把社群里最高频的疑问提前答掉，省你踩坑：

1. **"我可以直接改 loop.py 加功能吗？"** 不推荐。循环是通用发动机，改它会让所有能力受影响，且升级冲突。新功能优先写成工具/能力挂进去（见第 41/42 章与 `builtin_capabilities.py:3`）。
2. **"路线 A 要不要自己写前端？"** 不用。DeepTutor 自带前端，通过 WebSocket 连你的 serve（`facade.py:114` 是入口）。只有要完全定制 UI 才另写。
3. **"我的工具模型老是不调用怎么办？"** 检查 `description` 是否写清"何时用"，名字是否规范，是否被 `CONFIGURABLE_BUILTIN_TOOL_NAMES` 闸门挡住（builtin/__init__.py:1647）。
4. **"路线 B 的 demo 能直接当产品吗？"** 不能，它故意极简（无记忆、无检索、无并发）。它是"原理教具"，产品化请走路线 A。
5. **"知识库要多少文档才够？"** 先小后大。一个几十页的精选教材，比一 truck 杂乱 PDF 效果更好——RAG 质量是检索质量的因果（坑 6）。

## 一个"反例"：别这样起步

```text
❌ 错误起步方式
   第 1 天就想搭"多模态 + 多智能体协作 + 自适应评测"的宏大系统
   → 卡在架构设计，一行代码没写，两周后放弃

✅ 正确起步方式
   第 1 天：跑通 label_loop_demo.py:83，看到循环出答案
   第 2 天：写一个 weather 工具注册进 ToolRegistry
   第 3 天：把工具接进一个最小能力
   → 三天就有了一个"能动的丑东西"，后续只是长肉
```

> **注意 · 完美主义是 MVP 的头号杀手**
>
> 这一章反复强调"先有丑东西"。原因很现实：一个能跑的简陋版，你能在上面迭代；一个永远在设计中的完美架构，你永远没有反馈。动手 > 设计。

## 收尾：你现在已经能造什么

回顾这一章，你已经掌握了两种"从 0 到 1"的打法。哪怕只走通路线 B 的 `label_loop_demo.py:83`，你也已经拥有了一个**能思考、能调工具、能收尾**的最小智能体内核。把它接上你的教材、你的判题逻辑、你的学生画像，就是一个专属辅导 agent 的雏形。路线 A 则是把这个雏形"装上工业级引擎"——同样的脑子，更强的身体。

> **提示 · 把这一章当"启动手册"收藏**
>
> 将来你真要动手时，不用重读 43 章全文。直接跳到"填空式蓝图模板"填一遍，再照"三周 MVP 节奏"排期，最后用"验收清单"逐条打勾即可。

## 自查清单

- [ ] 我能用对比表说明路线 A 与路线 B 的区别与取舍
- [ ] 我理解路线 A"只写业务三件套，其余复用引擎"的心法
- [ ] 我知道路线 A 复用了 facade.start_turn（facade.py:114）与 turn_runtime.start_turn（turn_runtime.py:682）
- [ ] 我读过 label_loop_demo.py:83 的 run_agentic_loop，理解循环/修复/分发三件事
- [ ] 我用填空式蓝图模板写下了自己 agent 的工具/能力/知识库规划
- [ ] 我给自己排了三周 MVP 节奏，且第 1 周目标只是"跑通一个丑东西"
- [ ] 我明白路线 B 的价值在于"顿悟原理"，而非直接做产品
