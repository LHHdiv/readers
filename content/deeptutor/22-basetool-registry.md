---
title: "第 22 章 · BaseTool 抽象与工具注册表"
date: 2026-08-01
summary: "**黑话先定义**"
tags:
  - deeptutor
---
# 第 22 章 · BaseTool 抽象与工具注册表

智能体能"上网搜、读文件、跑代码"，靠的不是把每个能力写死在模型里，而是一套**工具（tool）机制**：把一个个能力包装成"函数"，告诉大模型"你可以调用这些函数"，模型想用时就发一个调用请求，运行时去真正执行它。本章讲这套机制最底层的三件套 `ToolDefinition` / `ToolResult` / `BaseTool`，再讲工具如何被收编进中央**注册表（registry）**，顺带看清"渐进式披露"和"作用域注册表"这两个进阶设计。最后用一个真实工具 `ReasonTool` 示范"写一个工具要填哪几处"。

> **黑话先定义**
> - *工具 tool*：给大模型调用的一个"函数"，比如"网页搜索"。它有名字、说明、参数格式。
> - *注册表 registry*：一个中央花名册，记下"系统里现在有哪些工具可用"，供查找和调用。
> - *schema 模式*：描述"这个函数要什么参数、参数是什么类型"的说明书。大模型靠它才知道怎么填参。
> - *OpenAI function-calling*：一种通用约定，把工具描述成模型能读懂的格式，几乎所有厂商都兼容。
> - *渐进式披露 deferred*：工具先不把完整说明塞给模型，等模型需要时再加载，省上下文。

## 一句话直觉

把工具想成"公司里的办事窗口"。每个窗口有一块**牌子（ToolDefinition）**：写着窗口叫什么、能办什么、要交什么材料。办事的人（大模型）看牌子决定去哪个窗口。窗口后面真正干活的是**办事员（BaseTool 的实现）**，他收下材料、办完事、给你一张**回执（ToolResult）**。而**前台登记簿（ToolRegistry）**把所有窗口的牌子汇总，谁要找窗口、谁要列清单，都问它。

## 三件套之一：ToolDefinition（牌子）

`ToolDefinition` 定义在 `deeptutor/core/tool_protocol.py:48`。它是一份纯数据的"工具身份证"，包含：

- `name`：工具名，比如 `"reason"`。
- `description`：一句话说明它能干嘛，模型主要看这个决定要不要用。
- `parameters`：参数列表，每一项是个 `ToolParameter`（`deeptutor/core/tool_protocol.py:17`），描述一个参数的名字、类型、是否必填、枚举值等。
- `raw_parameters`：可选的"原生 JSON Schema 整块"，给那些上游已经是任意 JSON 模式的工具（如 MCP 适配器）直接透传用。

`ToolParameter`（`deeptutor/core/tool_protocol.py:17`）本身也有讲究：除了 `name` / `type` / `description`，还有 `required`（是否必填，默认 `True`）、`default`（默认值）、`enum`（枚举可选值）、`items`（数组元素 schema）。它的 `to_schema`（`deeptutor/core/tool_protocol.py:37`）在参数类型是 `array` 时会自动补上 `items`——否则 Gemini、Anthropic 这类严格厂商会直接报 400 错。`deeptutor/core/tool_protocol.py:22` 的注释专门提醒：OpenAI 能容忍缺 `items`，但严格厂商不行，所以这里统一兜底成 `{"type": "string"}`。

它最重要的本领是把自己变成大模型能读的 JSON，方法叫 `to_openai_schema`（`deeptutor/core/tool_protocol.py:63`）。它产出的就是下面这种结构（节选自源码逻辑）：

```json
{
  "type": "function",
  "function": {
    "name": "reason",
    "description": "Perform deep reasoning on a complex sub-problem...",
    "parameters": {
      "type": "object",
      "properties": { "query": {"type": "string", "description": "..."} },
      "required": ["query"]
    }
  }
}
```

如果设了 `raw_parameters`，`to_openai_schema` 会直接透传它（`deeptutor/core/tool_protocol.py:65`），只在缺 `type`/`properties` 时补默认值，绝不重新编码成 `ToolParameter` 行——因为那样会丢信息。

> **说明 · 为什么需要 raw_parameters？**
>
> 像 MCP（模型上下文协议）适配器这类工具，上游给的就是一段任意 JSON Schema，硬拆成 `ToolParameter` 行会丢细节。`raw_parameters` 让它们"原样带着走"，保证 schema 不丢精度。

## 三件套之二：ToolResult（回执）

工具跑完，不能随便返回个字符串，而是返回一个标准化**回执** `ToolResult`（`deeptutor/core/tool_protocol.py:122`）。它身上带着：

- `content`：返回给模型的文字内容（就是模型看到的"工具回复"）。
- `sources`：引用来源，比如检索到了哪些资料，用于界面展示引用。
- `metadata`：自由格式附加信息，有时给前端塞结构化提示（如 `ask_user` 的选项）。
- `success`：是否成功；`False` 表示走的是明确失败路径，但模型仍能读 `content` 里的错误信息。
- `terminate_turn`：为 `True` 时让智能体循环立刻停下，把工具输出当最终成品。
- `pause_for_user`：为 `True` 时让循环暂停、等用户回复再继续（用于 `ask_user`）。

`__str__`（`deeptutor/core/tool_protocol.py:155`）让它直接当字符串用，所以代码里经常把它当文本拼进上下文。

## 三件套之三：BaseTool（办事员）

`BaseTool` 是所有工具的抽象基类，定义在 `deeptutor/core/tool_protocol.py:206`。它规定了每个工具必须实现两件事：

1. `get_definition()`（`deeptutor/core/tool_protocol.py:234`，抽象方法）：返回上面的"牌子" `ToolDefinition`。
2. `execute(**kwargs)`（`deeptutor/core/tool_protocol.py:240`，抽象方法）：真正干活，接收模型填的参数，返回 `ToolResult`。

源码里给了一个最小模板（`deeptutor/core/tool_protocol.py:220`）：

```python
class MyTool(BaseTool):
    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="my_tool",
            description="Does something useful.",
            parameters=[ToolParameter(name="query", type="string")],
        )

    async def execute(self, **kwargs) -> ToolResult:
        return ToolResult(content="result")
```

还有一个类属性 `deferred`（`deeptutor/core/tool_protocol.py:232`）：标记"渐进式披露"工具——它的完整 schema 不进初始工具清单，只在系统提示里留一行提示，模型需要时再通过 `load_tools` 把完整说明加载进来。这样初始上下文不会被几十个工具的说明撑爆。

另外，`BaseTool` 还有两个可选扩展：`get_prompt_hints`（`deeptutor/core/tool_protocol.py:244`）返回 `ToolPromptHints`（`deeptutor/core/tool_protocol.py:109`）给模型看的软提示；`name` 属性（`deeptutor/core/tool_protocol.py:251`）直接从定义里取名字。还有两个"只读视图"协议：`ToolEventSink`（`deeptutor/core/tool_protocol.py:159`）是工具向运行时流式汇报进度的回调；`ToolLookup`（`deeptutor/core/tool_protocol.py:170`）是注册表的只读面，故意不含 `register`/`unregister`，防止"视图"越权改全局注册表。

> **提示 · 工具还有"使用提示"吗？**
>
> 有。`ToolPromptHints`（`deeptutor/core/tool_protocol.py:109`）里是"什么时候用、怎么填、别名是什么"等给模型看的软提示，含 `short_description`/`when_to_use`/`input_format`/`guideline`/`note`/`phase` 以及 `aliases`（见 `ToolAlias` 在 `deeptutor/core/tool_protocol.py:98`）。大部分工具直接把 `description` 当默认提示（`deeptutor/core/tool_protocol.py:247`）。

## 注册表：ToolRegistry

光有工具类不够，系统得有个地方集中收编它们，这就是 `ToolRegistry`（`deeptutor/runtime/registry/tool_registry.py:21`）。它内部用一个字典 `self._tools` 存名字到工具实例的映射（`deeptutor/runtime/registry/tool_registry.py:34`）。核心能力：

| 方法 | 位置 | 作用 |
| --- | --- | --- |
| `register(tool)` | deeptutor/runtime/registry/tool_registry.py:36 | 把一个工具实例收编进字典 |
| `load_builtins()` | deeptutor/runtime/registry/tool_registry.py:49 | 实例化并注册所有内置工具类型 |
| `get(name)` | deeptutor/runtime/registry/tool_registry.py:74 | 按名字查工具（先解析别名） |
| `get_enabled(names)` | deeptutor/runtime/registry/tool_registry.py:81 | 取出指定名字的工具实例列表 |
| `build_openai_schemas(names)` | deeptutor/runtime/registry/tool_registry.py:124 | 批量生成大模型能读的工具 schema |
| `execute(name, **kwargs)` | deeptutor/runtime/registry/tool_registry.py:128 | 解析别名、找到工具、执行它 |

`register` 极其简单（`deeptutor/runtime/registry/tool_registry.py:36`）：取工具名，塞进字典。`load_builtins`（`deeptutor/runtime/registry/tool_registry.py:49`）则遍历一个"内置工具类型清单" `BUILTIN_TOOL_TYPES`，逐个 `tool_type()` 实例化后注册；实例化失败的会被跳过并记录警告（`deeptutor/runtime/registry/tool_registry.py:54`）。

全局只有一个注册表，靠 `get_tool_registry`（`deeptutor/runtime/registry/tool_registry.py:147`）懒加载：第一次调用时建好并 `load_builtins()`，之后都复用同一个。这保证了"系统里有哪些工具"是全进程统一的真相源。

> **别名机制**：`execute` 和 `get` 都会先走 `_resolve_request`（`deeptutor/runtime/registry/tool_registry.py:61`），它会查 `TOOL_ALIASES` 把别名映射到真名。比如用户（或模型）写 `run_code`，其实指向 `code_execution`（`deeptutor/runtime/registry/tool_registry.py:1669`）。

## 内置工具清单从哪来

`BUILTIN_TOOL_TYPES` 在 `deeptutor/tools/builtin/__init__.py:1562` 定义，是一个把各个工具类排成一列的大元组。从这里能看出系统默认带哪些工具（仅列几个代表性类的位置）：

- 思考类：`BrainstormTool`（`deeptutor/tools/builtin/__init__.py:43`）、`ReasonTool`（`deeptutor/tools/builtin/__init__.py:450`）、`RAGTool`（`deeptutor/tools/builtin/__init__.py:95`）、`WebSearchTool`（`deeptutor/tools/builtin/__init__.py:234`）
- 执行类：`CodeExecutionTool`（`deeptutor/tools/builtin/__init__.py:274`）、`ExecTool`、`WebFetchTool`（`deeptutor/tools/builtin/__init__.py:876`）、`GithubTool`（`deeptutor/tools/builtin/__init__.py:1116`）
- 记忆/笔记类：`ReadMemoryTool`（`deeptutor/tools/builtin/__init__.py:741`）、`WriteMemoryTool`（`deeptutor/tools/builtin/__init__.py:771`）、`ListNotebookTool`（`deeptutor/tools/builtin/__init__.py:940`）、`WriteNoteTool`（`deeptutor/tools/builtin/__init__.py:990`）
- 多模态类：`ImagegenTool`、`VideogenTool`、`GeoGebraAnalysisTool`（`deeptutor/tools/builtin/__init__.py:568`）
- 交互类：`AskUserTool`（`deeptutor/tools/builtin/__init__.py:1179`）、`CronTool`（`deeptutor/tools/builtin/__init__.py:1465`）、`LoadToolsTool`（`deeptutor/tools/builtin/__init__.py:1407`）、`ReadSourceTool`（`deeptutor/tools/builtin/__init__.py:677`）、`ReadSkillTool`（`deeptutor/tools/builtin/__init__.py:1323`）
- 以及来自 mastery / solve / obsidian / subagent 等能力模块的工具（`deeptutor/tools/builtin/__init__.py:1593` 起用 `*` 展开汇入）

其中有的是"用户可在设置里开关"的（`USER_TOGGLEABLE_TOOL_NAMES`，`deeptutor/tools/builtin/__init__.py:1627`），有的是"聊天循环按上下文条件自动挂载"的（`CONFIGURABLE_BUILTIN_TOOL_NAMES`，`deeptutor/tools/builtin/__init__.py:1647`）。

## 进阶：渐进式披露与 load_tools

太多工具一次性塞给模型，既贵又容易让模型挑花眼。于是有了 `deferred`（渐进式披露）：被标记的工具不进初始清单。相关逻辑在 `deeptutor/runtime/registry/deferred_tools.py`：

- `render_deferred_tools_manifest`（`deeptutor/runtime/registry/deferred_tools.py:55`）把 deferred 工具渲染成"系统提示里的一行提示"，让模型知道"还有这些工具可调"。
- `DeferredToolLoader`（`deeptutor/runtime/registry/deferred_tools.py:111`）负责在模型真要用时，通过 `load_tools` 工具把完整 schema 绑定进去（`deeptutor/runtime/registry/deferred_tools.py:143` 的 `bind_live_schemas`），并持久化（`deeptutor/runtime/registry/deferred_tools.py:189` 的 `_persist`）。
- `LoadToolsTool`（`deeptutor/tools/builtin/__init__.py:1407`）就是那个让模型"现在加载这几个工具的完整说明"的开关。

```text
初始：模型只看一行行提示（deferred 工具）
   │  模型决定："我要用 geogebra_analysis"
   ▼
调用 load_tools(["geogebra_analysis"])     deeptutor/tools/builtin/__init__.py:1407
   │
   └─ DeferredToolLoader 把完整 schema 注入    deeptutor/runtime/registry/deferred_tools.py:143
```

## 进阶：作用域注册表 ScopedToolRegistry

有些场景（如多用户、外部 provider）需要"在全局注册表之上叠加一层只属于某个用户的工具视图"。`ScopedToolRegistry`（`deeptutor/runtime/registry/scoped_registry.py:40`）就是这个"视图"：它实现和 `ToolRegistry` 一样的只读接口（`deeptutor/runtime/registry/scoped_registry.py:76` 的 `get`、`deeptutor/runtime/registry/scoped_registry.py:93` 的 `get_definitions`、`deeptutor/runtime/registry/scoped_registry.py:104` 的 `build_openai_schemas`），但底层叠加了用户专属工具。因为 `ToolLookup` 协议（`deeptutor/core/tool_protocol.py:170`）故意排除 `register`，所以视图不能假装自己能增删全局工具——这是类型层面的安全护栏。

## 实例：写一个真实工具要填哪几处

以 `ReasonTool` 为例，它定义在 `deeptutor/tools/builtin/__init__.py:450`。这个工具的作用是"用一次专门的模型调用，对复杂子问题做深度推理"。写它只填了**两个地方**：

第一处，`get_definition`（牌子），在 `deeptutor/tools/builtin/__init__.py:451`：

```python
def get_definition(self) -> ToolDefinition:
    return ToolDefinition(
        name="reason",
        description=(
            "Perform deep reasoning on a complex sub-problem using a dedicated LLM call. "
            "Use when the current context is insufficient for a confident answer."
        ),
        parameters=[
            ToolParameter(name="query", type="string",
                          description="The sub-problem to reason about."),
            ToolParameter(name="context", type="string",
                          description="Supporting context for reasoning.",
                          required=False),
        ],
    )
```

第二处，`execute`（办事），在 `deeptutor/tools/builtin/__init__.py:473`：

```python
async def execute(self, **kwargs) -> ToolResult:
    from deeptutor.tools.reason import reason
    result = await reason(
        query=kwargs.get("query", ""),
        context=kwargs.get("context", ""),
        api_key=kwargs.get("api_key"),
        ...
    )
    return ToolResult(content=result.get("answer", ""), metadata=result)
```

注意它自己不实现推理逻辑，而是**委托**给 `deeptutor/tools/reason.py:42` 的 `reason()` 函数。这是 DeepTutor 的常见写法：工具类只负责"描述 + 调用"，重活放在独立的函数/模块里，便于复用和测试。

```text
模型想用 reason
   │
   ├─ registry.execute("reason", query=...)     deeptutor/runtime/registry/tool_registry.py:128
   ├─ _resolve_request 找真名                   deeptutor/runtime/registry/tool_registry.py:61
   ├─ ReasonTool.execute(...)                   deeptutor/tools/builtin/__init__.py:473
   ├─ 委托 reason() 真干活                       tools/reason.py:42
   └─ 包成 ToolResult 返回模型                   deeptutor/core/tool_protocol.py:122
```

> **说明 · 工具名放到类里还是独立文件？**
>
> `reason` 的逻辑在 `deeptutor/tools/reason.py`，但 `ReasonTool` 类本身在 `builtin/__init__.py`。很多工具类是"轻壳"，真正逻辑在别处；也有工具把逻辑直接写在 `execute` 里。两种都可以，壳的好处是"描述与调用"和"实现"分离。

## 工具是怎么"挂"到一次对话上的

工具写好了、注册了，不代表每次对话都全员上阵。DeepTutor 在聊天循环里按"上下文条件"挑工具：用户挂了知识库才挂 `rag`/`kb_files`，开了沙箱才挂 `code_execution`，有记忆/笔记才挂 `read_memory`/`write_note`（`deeptutor/tools/builtin/__init__.py:1647` 的 `CONFIGURABLE_BUILTIN_TOOL_NAMES` 就是这批"按条件自动挂载"的工具清单）。还有一批是用户在设置页手动开关的（`deeptutor/tools/builtin/__init__.py:1627` 的 `USER_TOGGLEABLE_TOOL_NAMES`，如 `brainstorm`、`reason`、`web_search`、`paper_search`）。能力专属工具（mastery/solve/obsidian/subagent）则由能力激活时强制挂上（`deeptutor/tools/builtin/__init__.py:1593` 起）。这套"全局注册、按场景挑选"的设计，让工具库可以很大，而单次对话只露出相关的少数几个。

## ToolResult.pause_for_user 与 ask_user

`ToolResult` 里有个特殊字段 `pause_for_user`（`deeptutor/core/tool_protocol.py:153`）。当 `ask_user` 这类工具设了它，聊天循环不会结束回合，而是**暂停**、发出一个 `pending_user_input` 事件，把问题推给用户；等用户在前端回复，运行时把回答塞进回复队列（`deeptutor/services/session/turn_runtime.py:1229`），循环从队列取出、把回答替回工具消息体，再继续同一轮迭代。这让"问用户"像是回合内的一个逗号，而非另开一场对话。`AskUserTool` 本身在 `deeptutor/tools/builtin/__init__.py:1179`，是这套机制的直接使用者。

## 外部工具的溯源：provider_identity

当工具来自外部（如 MCP 服务器、CLI 应用）时，模型和前端需要知道"这到底是哪个来源的工具"。`provider_identity`（`deeptutor/core/tool_protocol.py:256`）就是干这个的：它从工具对象上读 `provider_kind`（`"mcp"`/`"cli"`）和 `provider_id`（具体服务器/应用名），对内置工具则返回 `("", "")`。它特意提醒（`deeptutor/core/tool_protocol.py:266`）：不要靠解析 `mcp_<server>_<tool>` 这种拼接名来反推来源，因为服务器名里可能也含下划线——所以专门用结构化字段来携带，UI 才能正确显示"正在运行哪个 MCP 服务器"。

## 小结

工具机制是智能体能"动手"的基础。三件套分工明确：`ToolDefinition`（`deeptutor/core/tool_protocol.py:48`）是给模型看的牌子，`ToolResult`（`deeptutor/core/tool_protocol.py:122`）是给模型看的回执，`BaseTool`（`deeptutor/core/tool_protocol.py:206`）是办事员基类，子类只需填 `get_definition` 和 `execute` 两处。`ToolRegistry`（`deeptutor/runtime/registry/tool_registry.py:21`）把所有工具收编成中央花名册，`get_tool_registry`（`deeptutor/runtime/registry/tool_registry.py:147`）提供全局唯一实例。内置工具清单在 `deeptutor/tools/builtin/__init__.py:1562`，新工具只要加进 `BUILTIN_TOOL_TYPES` 就被自动注册。进阶的 `deferred` 渐进式披露（`deeptutor/core/tool_protocol.py:232`）和 `ScopedToolRegistry`（`deeptutor/runtime/registry/scoped_registry.py:40`）分别解决"工具太多"和"多用户视图"问题。`provider_identity`（`deeptutor/core/tool_protocol.py:256`）则为外部工具提供可靠溯源。

## ToolResult 的失败语义

工具执行"失败"有两种截然不同的含义，都靠 `ToolResult` 表达（`deeptutor/core/tool_protocol.py:122`）：

- `success=False`：工具**正常跑完但结果是失败**（比如检索没找到、代码报了错）。此时 `content` 里通常带着错误信息，**模型仍能读它并决定下一步**（比如换个问法再搜）。这叫"优雅失败"，是智能体循环自我纠错的基础。
- `error` 字段（在 `ExecResult`，`deeptutor/services/sandbox/spec.py:106`）：不是工具逻辑失败，而是**沙箱/执行环境本身出问题**（比如沙箱挂了）。这种错误由外层捕获，不会进模型上下文当普通回复。

区分这两层很重要：前者让智能体"从错误中学习"，后者是"基础设施不可用"的系统级信号。

## ToolEventSink 与流式进度

有些工具跑得久（如下载大文件、训练模型），想边跑边汇报进度。这时用 `ToolEventSink`（`deeptutor/core/tool_protocol.py:159`）——一个异步回调协议，工具可以调用它 `event_type, message, metadata` 往上层发进度。`BaseTool` 虽没强制要求，但支持它的工具会在 `execute` 里接收这个 sink 并调用，让前端显示"正在下载 30%…"这类进度。这是"长工具"体验的关键，和回合运行时的事件流是同一套思路（见第 21 章）。

## 几个真实内置工具速写

除了 `ReasonTool`（`deeptutor/tools/builtin/__init__.py:450`），再列几个代表性的，帮你看清"工具长什么样"：

- `RAGTool`（`deeptutor/tools/builtin/__init__.py:95`）：检索增强生成，从知识库找相关资料。`get_definition` 描述"根据 query 检索"，`execute` 委托底层检索并返回带引用的内容（引用经 `_rag_sources` 整理，`__init__.py` 附近）。
- `CodeExecutionTool`（`deeptutor/tools/builtin/__init__.py:274`）：在沙箱里跑一段代码（见第 25 章），`execute` 把代码交给沙箱、把 stdout/stderr 包成 `ToolResult`。
- `WebSearchTool`（`deeptutor/tools/builtin/__init__.py:234`）：联网搜索，`execute` 调搜索服务、返回结果摘要。
- `ReadSkillTool`（`deeptutor/tools/builtin/__init__.py:1323`）：按需读取某个技能的完整内容，配合聊天能力的"轻量清单"路线（`agents/chat/capability.py:1453`）。

它们的共同点：**定义（牌子）与执行（办事）分离，重活委托给独立函数/模块**。这正是 `ReasonTool` 示范的写法。

## ExecTool 与 CodeExecutionTool 的区别

两个都"执行代码"，容易混。`CodeExecutionTool`（`deeptutor/tools/builtin/__init__.py:274`）是聊天场景面向"解题/验证"的代码执行，通常挂载在解题能力里；`ExecTool`（从 `deeptutor.tools.exec_tool` 导入，`deeptutor/tools/builtin/__init__.py:15`）是更通用的"执行命令"工具，受沙箱策略门更严格约束（普通用户需 `SYSTEM` 级隔离才可用，见第 25 章）。简单记：`code_execution` 是"跑段代码算答案"，`exec` 是"跑条命令做操作"，后者权限边界更高。

> **说明 · 读工具源码的建议路径**
>
> 先看 `BUILTIN_TOOL_TYPES`（`deeptutor/tools/builtin/__init__.py:1562`）挑一个感兴趣的类，跳到它的 `get_definition` 看"它能干啥、要什么参数"，再看 `execute` 看"它委托给哪个函数"，最后顺藤摸到那个函数。三步就能把一个工具读透。

## 自查清单

- [ ] 我能说清 `ToolDefinition` / `ToolResult` / `BaseTool` 各自扮演什么角色。
- [ ] 我知道 `ToolDefinition.to_openai_schema`（`deeptutor/core/tool_protocol.py:63`）产出的是模型能读的 JSON 工具说明。
- [ ] 我理解 `BaseTool` 的两个抽象方法 `get_definition`（`deeptutor/core/tool_protocol.py:234`）和 `execute`（`deeptutor/core/tool_protocol.py:240`）必须实现。
- [ ] 我知道工具清单 `BUILTIN_TOOL_TYPES` 在 `deeptutor/tools/builtin/__init__.py:1562`，新工具加进去就被自动注册。
- [ ] 我明白 `ToolRegistry.register`（`deeptutor/runtime/registry/tool_registry.py:36`）只是把工具塞进名字字典。
- [ ] 我能解释 `get_tool_registry`（`deeptutor/runtime/registry/tool_registry.py:147`）为什么是"全局唯一、懒加载"。
- [ ] 我理解别名机制：`run_code` 实际指向 `code_execution`（`deeptutor/runtime/registry/tool_registry.py:1669`）。
- [ ] 我知道 `deferred`（`deeptutor/core/tool_protocol.py:232`）是"渐进式披露"，配合 `LoadToolsTool`（`deeptutor/tools/builtin/__init__.py:1407`）按需加载。
- [ ] 我理解 `ScopedToolRegistry`（`deeptutor/runtime/registry/scoped_registry.py:40`）是叠加在全局之上的只读视图。
- [ ] 我能照着 `ReasonTool`（`deeptutor/tools/builtin/__init__.py:450`）说出"写一个工具要填哪两处"。
