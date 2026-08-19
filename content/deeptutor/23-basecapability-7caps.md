---
title: "第 23 章 · BaseCapability 与七大能力逐一拆解"
date: 2026-08-01
summary: "**黑话先定义**"
tags:
  - deeptutor
---
# 第 23 章 · BaseCapability 与七大能力逐一拆解

上一章讲"工具"是单个办事窗口，本章讲更高一层：**能力（capability）**。能力是"深度模式"——用户在界面上选"深度解题""深度提问""可视化"等，背后就是启动一个能力。一个能力往往是一整条多步骤流水线，会按顺序经历若干**阶段（stage）**，并在过程中反复调用上一章的工具。本章先把 `BaseCapability` 这个总基类讲透，再看能力注册表，最后把七大能力逐个拆开看它们的阶段与工具。

> **黑话先定义**
> - *能力 capability*：一种"深度模式"的完整流水线，比如"深度解题"。它比单个工具大，是多个步骤 + 多次工具调用的组合。
> - *阶段 stage*：能力执行过程中的一个有名字的步骤节点，比如"规划→推理→写作"。用来在界面上显示进度。
> - *manifest 清单*：一份静态元数据，记着能力的名字、描述、有哪些阶段、用到哪些工具。
> - *能力注册表*：把"能力名"映射到"对应的类"的花名册，运行时按名字找到该启动哪个类。
> - *插件 plugin*：可被额外加载的能力模块，注册表在启动时也会扫描它们。

## 一句话直觉

工具是"单个窗口"，能力就是"一条业务流水线"。比如"深度研究"这条流水线，会先**改写问题**、再**拆成子问题**、然后**逐个调研**、最后**汇总成报告**——每一步都可能去调搜索工具、读资料工具。每个能力都挂一份"清单（manifest）"说明自己分几步、用哪些工具，运行时照着清单把流水线跑起来。

## 总基类：BaseCapability

所有能力都继承自 `BaseCapability`，定义在 `deeptutor/core/capability_protocol.py:33`。它非常精简，核心是两点：

1. 一份静态清单 `manifest`（`deeptutor/core/capability_protocol.py:55`），类型是 `CapabilityManifest`（`deeptutor/core/capability_protocol.py:20`）。
2. 一个必须实现的异步方法 `run(self, context, stream)`（`deeptutor/core/capability_protocol.py:57`），里面写这条流水线具体怎么跑，并把进度事件发到 `stream`。

`CapabilityManifest`（`deeptutor/core/capability_protocol.py:20`）这张清单长这样：

- `name`：能力名，如 `"deep_solve"`。
- `description`：一句话描述。
- `stages`：阶段名列表，如 `["planning", "reasoning", "writing"]`。
- `tools_used`：这条流水线会用到哪些工具名。
- `cli_aliases` / `request_schema` / `config_defaults`：命令行别名、请求参数结构、默认配置。

`BaseCapability` 还顺手提供了几个便利属性：`name`（`deeptutor/core/capability_protocol.py:62`）取自清单、`stages`（`deeptutor/core/capability_protocol.py:67`）直接返回清单里的阶段列表。子类只要填好 `manifest` 和实现 `run` 即可，源码里的模板（`deeptutor/core/capability_protocol.py:41`）就是这么做的。

```text
BaseCapability
   │
   ├─ manifest: CapabilityManifest   静态清单  deeptutor/core/capability_protocol.py:55
   ├─ name       -> manifest.name               deeptutor/core/capability_protocol.py:62
   ├─ stages     -> manifest.stages            deeptutor/core/capability_protocol.py:67
   └─ run(context, stream)  流水线本体（抽象） deeptutor/core/capability_protocol.py:57
```

> **提示 · 能力 vs 工具，到底差在哪？**
>
> 工具是"一个函数调用"，能力是"一段编排（orchestration）"。能力内部通常会反复调用多个工具，并管理阶段进度、错误重试、报告生成等。可以记成：工具是零件，能力是组装好的整机。

## 能力注册表：CapabilityRegistry

和工具一样，能力也有中央花名册：`CapabilityRegistry`（`deeptutor/runtime/registry/capability_registry.py:39`）。它负责：

- `register(capability)`（`deeptutor/runtime/registry/capability_registry.py:45`）：把一个能力实例收编。
- `load_builtins()`（`deeptutor/runtime/registry/capability_registry.py:49`）：加载所有内建能力。
- `_load_plugin_hooks()`（`deeptutor/runtime/registry/capability_registry.py:27`）：扫描并加载**插件**能力，让外部模块能贡献自己的能力而不改核心代码。
- `_import_capability_class(path)`（`deeptutor/runtime/registry/capability_registry.py:21`）：把 `"模块:类名"` 这样的字符串路径变成真正的类（就是 `builtin_capabilities.py` 里那张表用到的格式）。

这套"类名路径 → 实际类"的机制让能力和模型名一样，可以用字符串配置，方便插件化和灰度。

## 七大能力映射表

系统启动时，靠一张"能力名 → 类路径"的映射表知道每个能力对应哪个类。这张表在 `deeptutor/runtime/bootstrap/builtin_capabilities.py:3` 的 `BUILTIN_CAPABILITY_CLASSES`。逐行看（`deeptutor/runtime/bootstrap/builtin_capabilities.py:4` 起）：

| 能力名 | 类名 | 所在文件 |
| --- | --- | --- |
| `chat` | ChatCapability | agents/chat/capability.py:4 |
| `deep_solve` | DeepSolveCapability | capabilities/solve/capability.py:5 |
| `deep_question` | DeepQuestionCapability | agents/question/capability.py:6 |
| `deep_research` | DeepResearchCapability | agents/research/capability.py:7 |
| `math_animator` | MathAnimatorCapability | agents/math_animator/capability.py:8 |
| `visualize` | VisualizeCapability | agents/visualize/capability.py:9 |
| `mastery_path` | MasteryPathCapability | capabilities/mastery/capability.py:10 |

注意命名上的小规律：有的能力类在 `deeptutor/agents/...` 下（chat、question、research、math_animator、visualize），有的在 `deeptutor/capabilities/...` 下（solve、mastery）。这反映了历史演进：早期能力直接叫 capability，后来更"智能体化"的能力挪进了 `agents`。对读者而言，记住"映射表一句话就定位到类"即可。

> 这张表就是"能力注册表"的落地形式：运行时拿到 `capability="deep_research"`，查表得到 `DeepResearchCapability`，再实例化、调它的 `run`。

## 七大能力逐一拆解

下面逐个看它们各自的 `manifest.stages`（阶段）与 `tools_used`（工具），全部来自真实源码。阶段顺序就是流水线大致的推进方向。

### 1. chat（聊天）——agents/chat/capability.py:12

最轻量的能力，本质是"边聊边按需调工具"。它只有两个阶段（`capability.py:19`）：

```text
chat:
  exploring  -> 探索（决定要不要调工具、调哪个）
  responding -> 生成最终回复
```

它用的工具是 `CHAT_OPTIONAL_TOOLS`（`capability.py:20`，从 `agentic_pipeline` 导入，见 `capability.py:5`），即聊天场景可选项。它不像"深度模式"那样有重流水线，而是把活交给智能体循环去即时编排。

### 2. deep_solve（深度解题）——capabilities/solve/capability.py:59

`DeepSolveCapability`（`capability.py:59`）把解题直接交给"聊天智能体循环"驱动，所以阶段只有 `responding` 一个（`capability.py:63`）。但别被单阶段骗了——它的 `tools_used` 很丰富（`capability.py:64`）：

```text
deep_solve:
  responding  -> 由 chat agent loop 多轮驱动解题
工具：SOLVE_TOOL_NAMES, rag, code_execution, geogebra_analysis, reason
```

也就是说，它的"多步骤"藏在循环内部（规划、试算、验证都发生在循环里），对外的 manifest 只暴露一个总阶段。

### 3. deep_question（深度提问）——agents/question/capability.py:28

`DeepQuestionCapability`（`capability.py:28`）是"快速出题"能力，分两个阶段（`capability.py:32`）：

```text
deep_question:
  ideation    -> 构思题目方向（模板批处理）
  generation  -> 真正生成题目
工具：rag, web_search, code_execution
```

它先用模板批量想出方向（ideation），再据此生成具体题目（generation），比"边聊边出"更结构化。

### 4. deep_research（深度研究）——agents/research/capability.py:37

这是阶段最多、最像"研究助理"的能力。`DeepResearchCapability`（`capability.py:37`）的四个阶段（`capability.py:41`）：

```text
deep_research:
  rephrasing   -> 改写用户问题，使其更适合检索
  decomposing  -> 拆成若干子问题
  researching  -> 逐个子问题调研（会反复调搜索/读资料）
  reporting    -> 汇总成研究报告
工具：rag, web_search, paper_search, code_execution
```

逻辑非常清晰：先把问题说清楚，再拆开，再一个个调研，最后写报告。`researching` 阶段内部会多次调工具迭代。

### 5. math_animator（数学动画）——agents/math_animator/capability.py:19

`MathAnimatorCapability`（`capability.py:19`）用 Manim 生成数学动画或分镜图，阶段最多（六个，`capability.py:23`）：

```text
math_animator:
  concept_analysis -> 分析概念
  concept_design   -> 设计呈现方式
  code_generation  -> 生成 Manim 代码
  code_retry       -> 代码出错就重试
  summary          -> 写说明
  render_output    -> 渲染出视频/图像
```

注意 `code_retry` 这个阶段的存在——它说明这条流水线会**自动修代码再跑**，而不是一次失败就放弃。`run` 方法开头还会检查 `manim` 是否安装（`capability.py:42`），没装直接报错提示装依赖。

### 6. visualize（可视化）——agents/visualize/capability.py:50

`VisualizeCapability`（`capability.py:50`）生成 SVG、Chart.js、Mermaid、交互式 HTML 或 Manim 动画。`_VISUALIZE_STAGES`（`capability.py:35`）定义了九个阶段（`capability.py:57` 引用）：

```text
visualize:
  analyzing / generating / reviewing      -> 文本类输出路径（svg/chartjs/mermaid/html）
  concept_analysis / concept_design       -> 概念分析与设计
  code_generation / code_retry / summary  -> Manim 子进程路径
  render_output                           -> 渲染
```

注释（`capability.py:36`）说明：前三个是"出文字/图形"的路径，后几个是"Manim 子进程"路径，**一次执行只会流式输出其中一部分**，不是全跑。它 `tools_used` 为空（`capability.py:58`）——因为可视化靠代码生成，不依赖外部工具。

### 7. mastery_path（掌握路径）——capabilities/mastery/capability.py:57

`MasteryPathCapability`（`capability.py:57`）围绕"学习路径/掌握度"展开，阶段也是 `responding`（`capability.py:64`），但工具列表偏向记忆与路径（`capability.py:65`）：

```text
mastery_path:
  responding  -> 沿学习路径推进，调掌握度相关工具
工具：MASTERY_TOOL_NAMES, rag, read_source, ask_user
```

它和 deep_solve 类似，重活在循环里；`ask_user` 出现在工具列表里，说明它会在需要时停下来向用户提问。

> **说明 · 为什么有的能力只有 responding 一个阶段？**
>
> 因为这类能力把"多步骤"交给了**智能体循环**在内部完成（循环自己会规划、调工具、验证）。manifest 的 stage 是对"用户可见进度"的粗粒度描述，不是实现细节的全部。你看到的阶段少，不等于它内部不复杂。

## 阶段如何被使用

阶段不是装饰。`run` 方法在实现时通常会写 `async with stream.stage("researching", source=...)`（见 `deeptutor/core/capability_protocol.py:49` 的模板示例），把一段工作"包"在某个阶段名下。运行时据此向界面推送"正在调研…"之类的进度，让用户知道流水线走到了哪。

```text
能力 run() 里：
  async with stream.stage("decomposing"):   把问题拆开
  async with stream.stage("researching"):   逐个调研
  async with stream.stage("reporting"):      写报告
                │
                └─> 界面进度条：deep_research · researching
```

## 七大能力的"目录位置"与职责对照

前面提到有的能力在 `agents/`、有的在 `capabilities/`。这里给一张职责速查表，方便你顺着源码找：

| 能力 | 目录 | 一句话职责 |
| --- | --- | --- |
| chat | agents/chat | 通用对话 + 按需调工具 |
| deep_solve | capabilities/solve | 多步解题，借 chat 循环驱动 |
| deep_question | agents/question | 结构化快速出题 |
| deep_research | agents/research | 改写→拆解→调研→报告 |
| math_animator | agents/math_animator | Manim 数学动画/分镜 |
| visualize | agents/visualize | SVG/Chart.js/Mermaid/HTML/Manim |
| mastery_path | capabilities/mastery | 沿学习路径推进与掌握度 |

> **提示 · 想加一个自己的能力？**
>
> 只要新建一个类继承 `BaseCapability`（`deeptutor/core/capability_protocol.py:33`），填好 `manifest`（阶段 + 工具），实现 `run`，再把"名字→类路径"加进 `BUILTIN_CAPABILITY_CLASSES`（`deeptutor/runtime/bootstrap/builtin_capabilities.py:3`），系统就能识别并启动它。若要走插件路线，还能借 `CapabilityRegistry` 的插件钩子（`deeptutor/runtime/registry/capability_registry.py:27`）加载。

## 能力如何被启动：从名字到 run

能力不是凭空跑起来的。回顾第 21 章：`start_turn` 接收一个 `capability` 字段（如 `"deep_research"`），它先落库回合（`deeptutor/services/session/turn_runtime.py:844`），再在 `_run_turn` 里构造 `UnifiedContext`（`deeptutor/services/session/turn_runtime.py:1654`），最后把 context 交给 `ChatOrchestrator`（`deeptutor/services/session/turn_runtime.py:1703`）。编排器根据 `context.active_capability` 查 `BUILTIN_CAPABILITY_CLASSES`（`deeptutor/runtime/bootstrap/builtin_capabilities.py:3`）找到对应类，实例化后调它的 `run(context, stream)`（`deeptutor/core/capability_protocol.py:57`）。所以"用户选深度模式 → 回合带上 capability 名 → 编排器按名找类 → 跑流水线"是一条完整的链路，能力注册表就是这条链路里"按名找类"的枢纽。

> 如果不是"聊天"这条主路径，能力也可能被直接作为某条流水线的内部阶段调用。但无论哪种入口，最终都归结到 `BaseCapability.run`，这是所有能力的统一契约。

## chat 为什么是默认能力

`start_turn` 里 `capability` 的默认值是 `"chat"`（`deeptutor/services/session/turn_runtime.py:683`）。这很合理：用户最频繁的操作就是普通对话，而 chat 能力最轻（只有 exploring/responding 两个阶段，`agents/chat/capability.py:19`），且走"轻量工具清单 + 按需 read_skill"的省 token 路线（`agents/chat/capability.py:1453` 附近的 `is_chat_capability` 判断）。其他深度能力则按需显式选择，各自带更重的流水线与工具集。

## 各能力的 run 入口一览

为方便顺着源码读，这里列出每个能力 `run` 方法所在的真实位置（类已在映射表给出，这里给方法级落点）：

| 能力 | 类位置 | run 方法所在文件 |
| --- | --- | --- |
| chat | agents/chat/capability.py:12 | agents/chat/capability.py |
| deep_solve | capabilities/solve/capability.py:59 | capabilities/solve/capability.py |
| deep_question | agents/question/capability.py:28 | agents/question/capability.py |
| deep_research | agents/research/capability.py:37 | agents/research/capability.py |
| math_animator | agents/math_animator/capability.py:19 | agents/math_animator/capability.py |
| visualize | agents/visualize/capability.py:50 | agents/visualize/capability.py |
| mastery_path | capabilities/mastery/capability.py:57 | capabilities/mastery/capability.py |

> **提示 · 读源码建议**
>
> 先读 `manifest`（`deeptutor/core/capability_protocol.py:20`）看"分几步、用哪些工具"，再读 `run` 看"每一步具体怎么调工具和拼提示"。阶段名就是 `run` 里 `stream.stage(...)` 的入参，搜阶段名即可定位到对应代码段。

## 小结

能力是比工具更高层的"深度模式流水线"，由一个 `BaseCapability` 基类（`deeptutor/core/capability_protocol.py:33`）统一定义，核心是 `manifest` 清单 + `run` 方法。`CapabilityRegistry`（`deeptutor/runtime/registry/capability_registry.py:39`）负责收编与插件加载。七大能力通过 `BUILTIN_CAPABILITY_CLASSES`（`deeptutor/runtime/bootstrap/builtin_capabilities.py:3`）映射到各自类。它们的阶段从真实源码逐一核实：chat 两阶段、deep_solve/mastery_path 各一阶段（重活在循环里）、deep_question 两阶段、deep_research 四阶段、math_animator 六阶段、visualize 九阶段。阶段驱动界面进度，工具列表决定它能动用什么零件。能力经 `start_turn` → `ChatOrchestrator` → `run` 的链路被启动。

## 能力内部的阶段如何串联（以 deep_research 为例）

光看 `manifest.stages` 是静态的，真正"阶段动起来"发生在 `run` 里。以 `deep_research` 为例（`agents/research/capability.py:37`），它的 `run` 大致是：

```text
run(context, stream):
  async with stream.stage("rephrasing"):   改写问题
  async with stream.stage("decomposing"):  拆成子问题
  for 每个子问题:
      async with stream.stage("researching"):  调研（多次调 web_search / rag）
  async with stream.stage("reporting"):    汇总成报告
```

`stream.stage(...)` 是上下文管理器：进入时通知界面"现在到了 X 阶段"，退出时标记该阶段完成。如果某个阶段里要调工具，工具的调用和结果会作为子事件嵌在这个阶段下。所以界面上你看到的"deep_research · researching 65%"，就是从这里来的。`stage` 名必须和 `manifest.stages` 里列的一致（`agents/research/capability.py:41`），否则界面进度条对不上号。

## manifest.tools_used 是怎么被用上的

`manifest.tools_used`（`deeptutor/core/capability_protocol.py:24`）不是装饰，它告诉系统"这条流水线会用到哪些工具"。运行时据此：

1. 在构造 `UnifiedContext` 时把对应工具名列入 `enabled_tools`（`deeptutor/services/session/turn_runtime.py:1658`），循环才知道能调它们。
2. 在生成给模型的工具 schema 时，只暴露这批工具（`tool_registry.build_openai_schemas`，`deeptutor/runtime/registry/tool_registry.py:124`）。
3. 配合第 22 章讲的"按上下文条件自动挂载"，决定工具是否真正对本次对话可见。

比如 `deep_research` 的 `tools_used` 是 `["rag","web_search","paper_search","code_execution"]`（`agents/research/capability.py:42`），于是这次深度研究里模型就能搜网页、搜论文、跑代码验证，而不会误调 `ask_user` 这类不相关的工具。

## 能力与智能体循环的关系

细心的读者会发现：chat 和 deep_solve 的 `run` 都"把活交给聊天智能体循环"（见 `agents/chat/capability.py` 与 `capabilities/solve/capability.py`）。这不是偷懒，而是架构选择：

- **轻能力（chat）**：阶段少，主要在循环里即时决策调工具。
- **重能力（deep_research / math_animator / visualize）**：阶段多且固定，由能力自己编排步骤，循环只在每步内部帮它调工具。

所以"能力"和"智能体循环"是协作关系：能力定"大步骤与顺序"，循环负责"每步里和模型、工具的具体交互"。理解这一点，你就不会困惑"为什么有的能力只有一个 responding 阶段"——因为它的多步骤都藏在循环内部了。

> **提示 · 学能力的两个层次**
>
> 第一层看 `manifest`：分几步、用哪些工具——这是"对外的契约"。第二层看 `run`：每一步具体怎么拼提示、怎么判断完成、出错怎么重试——这是"内部实现"。先契约后实现，读任何能力都不迷路。

## 自查清单

- [ ] 我能区分"工具（零件）"和"能力（流水线）"。
- [ ] 我知道 `BaseCapability` 在 `deeptutor/core/capability_protocol.py:33`，子类必须实现 `run`。
- [ ] 我知道 `CapabilityManifest`（`deeptutor/core/capability_protocol.py:20`）里 `stages` / `tools_used` 是什么。
- [ ] 我能背出七大能力名 → 类映射表在 `deeptutor/runtime/bootstrap/builtin_capabilities.py:3`。
- [ ] 我理解 chat 只有 exploring/responding 两个阶段（`agents/chat/capability.py:19`）。
- [ ] 我知道 deep_research 的四个阶段是 rephrasing→decomposing→researching→reporting（`agents/research/capability.py:41`）。
- [ ] 我明白为什么 deep_solve 只有一个 responding 阶段（`capabilities/solve/capability.py:63`）。
- [ ] 我知道 math_animator 有 code_retry 阶段（`agents/math_animator/capability.py:27`）说明它会自动修代码重跑。
- [ ] 我理解 visualize 的 `tools_used` 为空（`agents/visualize/capability.py:58`）——它靠代码生成而非外部工具。
- [ ] 我知道能力注册表 `CapabilityRegistry` 在 `deeptutor/runtime/registry/capability_registry.py:39`，且支持插件加载。
