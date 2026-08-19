---
title: "第 07 章 · 函数调用与工具调用（Function Calling）"
date: 2026-08-01
summary: "讲清智能体从\"只会说话\"变成\"能动手\"的那一步到底发生了什么。你会看到一个真实的 `ToolDefinition` 长什么样、它怎么变成 JSON 发给模型、模型怎么回一个 `tool_calls`、程序怎么执行、结果又怎么塞回去。读完你能自己写出第一个工具。"
tags:
  - deeptutor
---
# 第 07 章 · 函数调用与工具调用（Function Calling）

> 目标：讲清智能体从"只会说话"变成"能动手"的那一步到底发生了什么。你会看到一个真实的 `ToolDefinition` 长什么样、它怎么变成 JSON 发给模型、模型怎么回一个 `tool_calls`、程序怎么执行、结果又怎么塞回去。读完你能自己写出第一个工具。

---

## 7.1 一个残酷的事实：模型不能执行任何东西

先破除一个巨大的误解。

很多人以为"AI 帮我查了天气"意味着模型自己上网了。**不是的。** 大模型是一个纯粹的文字预测器，它被关在一个盒子里，只能干一件事：**读一段文字，写一段文字**。它不能上网、不能读你硬盘、不能运行代码、不能发邮件。

那 ChatGPT 怎么会查天气？答案是：

```text
用户： 北京今天天气怎么样？
   |
   v
模型： （它不能上网，但它可以"说"出一句结构化的话）
       "我想调用 get_weather 这个函数，参数是 {city: '北京'}"
   |
   v
你的程序： 读懂这句话 -> 真的去调天气 API -> 拿到 "晴，12度"
   |
   v
你的程序： 把 "晴，12度" 当作一条新消息，塞回给模型
   |
   v
模型： "北京今天晴，气温 12 度，适合出门。"
```

**关键洞察：模型输出的不是动作，是"动作请求"。真正干活的永远是你的程序。**

这就是 Function Calling（函数调用），也叫 Tool Calling（工具调用）。它是整个智能体领域最重要的一个机制——没有它，AI 只是个聊天机器人；有了它，AI 才成为"能改变世界状态"的智能体。

> **说明 · 黑话拆解：Function Calling / Tool Calling / Tool Use**
>
> 这三个词在 99% 的语境下是同一件事，只是不同厂商叫法不同：
> - OpenAI 早期叫 `function calling`，现在 API 字段叫 `tools` / `tool_calls`。
> - Anthropic 叫 `tool use`。
> - 中文社区统称"工具调用"。
> 你可以完全把它们当同义词。本章统一用"工具调用"。

---

## 7.2 三个必须理解的角色

要让工具调用跑起来，需要三方配合：

| 角色 | 是谁 | 干什么 |
|------|------|--------|
| **工具的说明书** | 一段 JSON Schema | 告诉模型"有个工具叫 X，它能干 Y，需要参数 Z" |
| **模型** | LLM | 决定"这一轮要不要用工具、用哪个、参数填什么" |
| **调度器（dispatcher）** | 你的程序 | 真正执行、拿结果、把结果塞回对话 |

模型只碰第一项和第二项，**永远碰不到第三项**。这是安全的根基：你可以在调度器里加权限检查、参数白名单、沙箱隔离，模型无法绕过。

---

## 7.3 说明书怎么写：JSON Schema

模型看不懂 Python 函数签名，它只看得懂文字。所以我们要把函数描述成一段 JSON。这段 JSON 的格式叫 **JSON Schema**（一种描述"数据长什么样"的标准格式）。

一个最小的工具说明书：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "查询某个城市当前的天气。",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {
          "type": "string",
          "description": "城市名，例如 '北京'"
        }
      },
      "required": ["city"]
    }
  }
}
```

逐字段解释：

- `name`：函数名。模型会原样把这个名字回给你，必须是合法标识符（字母数字下划线）。
- `description`：**最重要的字段**。模型完全靠这句话判断"我现在该不该用它"。写得含糊，模型就乱用或不用。
- `parameters`：参数结构。`type: "object"` 表示参数是一个对象（键值对集合）。
- `properties`：每个参数的名字、类型、说明。
- `required`：哪些参数必填。没列进来的就是可选。

> **注意 · description 是提示词，不是注释**
>
> 新手常把 `description` 写成 `"获取天气"` 四个字就完事。但这一行是**模型唯一的决策依据**。好的写法要包含：能干什么、什么时候用、什么时候别用。
> 比如："查询某城市当前天气。仅当用户明确问及天气、气温、是否下雨时使用；不要用它查询历史天气或天气预报。"

---

## 7.4 DeepTutor 是怎么做的：三个核心类

手写 JSON 又长又容易出错，所以成熟项目都会做一层封装：**用 Python 对象描述工具，自动生成 JSON**。DeepTutor 的封装在 `deeptutor/core/tool_protocol.py`，一共三个关键类。

### 7.4.1 ToolDefinition：工具的元数据

看 `deeptutor/core/tool_protocol.py:48`：

```py
@dataclass
class ToolDefinition:
    """
    Metadata that describes a tool to the LLM (OpenAI function-calling format).
    ...
    """

    name: str
    description: str
    parameters: list[ToolParameter] = field(default_factory=list)
    raw_parameters: dict[str, Any] | None = None
```

四个字段，前两个就是上面 JSON 里的 `name` 和 `description`。

`parameters` 是一个 `ToolParameter` 列表。`ToolParameter` 定义在 `tool_protocol.py:17`：

```py
@dataclass
class ToolParameter:
    name: str
    type: str  # "string" | "integer" | "boolean" | "number" | "array" | "object"
    description: str = ""
    required: bool = True
    default: Any = None
    enum: list[str] | None = None
    items: dict[str, Any] | None = None
```

第四个字段 `raw_parameters` 是个逃生舱：当上游给的 schema 是任意复杂的 JSON Schema（比如从 MCP 服务器拿来的，见第 10 章），硬转成 `ToolParameter` 列表会丢信息，就直接原样透传。源码注释说得很清楚（`tool_protocol.py:52`）：

> `raw_parameters` carries a complete JSON-Schema object verbatim and takes precedence over `parameters`

### 7.4.2 看一个真实的 ToolDefinition

这是 DeepTutor 里真实存在的读文件工具，`deeptutor/tools/file_tools.py:45`：

```py
def get_definition(self) -> ToolDefinition:
    return ToolDefinition(
        name="read_file",
        description="Read a text file from this turn's workspace with line pagination.",
        parameters=[
            ToolParameter(name="path", type="string", description="Path inside the workspace."),
            ToolParameter(
                name="offset",
                type="integer",
                description="1-indexed line number to start from.",
                required=False,
            ),
            ToolParameter(
                name="limit",
                type="integer",
                description="Maximum lines to return.",
                required=False,
            ),
        ],
    )
```

读一遍你就懂了：一个必填参数 `path`，两个可选参数 `offset` / `limit`（用来分页读大文件，避免一次塞爆上下文）。

再看一个带默认值和检索语义的，`deeptutor/tools/builtin/__init__.py:96`：

```py
def get_definition(self) -> ToolDefinition:
    return ToolDefinition(
        name="rag",
        description=(
            "Retrieve relevant passages from one of the knowledge bases the "
            "user attached to this turn. Call once per knowledge base you "
            "want to consult; the system runs them in parallel."
        ),
        parameters=[
            ToolParameter(name="query", type="string", description="Search query."),
            ...
        ],
    )
```

注意这个 `description` 有三句话：**是什么**、**怎么用**（每个知识库调一次）、**副作用提示**（系统会并行跑）。这就是把 description 当提示词写的范例。

### 7.4.3 to_openai_schema：从 Python 对象到 JSON

`tool_protocol.py:63` 的 `to_openai_schema` 方法负责把上面的对象翻译成模型能吃的 JSON：

```py
def to_openai_schema(self) -> dict[str, Any]:
    """Build an OpenAI-compatible function tool schema."""
    if self.raw_parameters is not None:
        schema = dict(self.raw_parameters)
        schema.setdefault("type", "object")
        schema.setdefault("properties", {})
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": schema,
            },
        }
    properties = {}
    required = []
    for p in self.parameters:
        properties[p.name] = p.to_schema()
        if p.required:
            required.append(p.name)
    return {
        "type": "function",
        "function": {
            "name": self.name,
            "description": self.description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }
```

逻辑很直白：有 `raw_parameters` 就原样用；否则遍历 `parameters` 列表，逐个转成 JSON Schema 属性，同时把 `required=True` 的挑出来放进 `required` 数组。

单个参数怎么转？看 `tool_protocol.py:37` 的 `to_schema`：

```py
def to_schema(self) -> dict[str, Any]:
    """Convert to JSON Schema property dict."""
    schema: dict[str, Any] = {"type": self.type, "description": self.description}
    if self.enum:
        schema["enum"] = self.enum
    if self.type == "array":
        schema["items"] = self.items if self.items is not None else {"type": "string"}
    return schema
```

> **提示 · 一个真实的跨厂商兼容细节，值得抄走**
>
> 注意最后那个 `if self.type == "array"` 分支。源码在 `tool_protocol.py:21` 的注释里解释了原因：
> 
> > `items`: Inner JSON Schema for `type="array"` parameters. **Required by strict providers (Gemini, Anthropic)** even though OpenAI silently tolerates its absence — leaving it out causes a 400 on Gemini.
> 
> 翻译：数组类型必须说明"数组里装的是什么"。OpenAI 不写也放过，Gemini 不写直接报 400 错误。所以这里做了兜底——没写就默认按字符串数组处理。
> 
> **这就是真实项目和玩具项目的差距**：同一份 schema 要发给多个厂商，每家的严格程度不同，你必须取最严的那个标准。

### 7.4.4 BaseTool：所有工具的父类

`tool_protocol.py:206`：

```py
class BaseTool(ABC):
    """
    Abstract base for all tools.

    Subclasses must implement ``get_definition`` and ``execute``.
    ...
    """

    deferred: bool = False

    @abstractmethod
    def get_definition(self) -> ToolDefinition:
        """Return the tool's metadata & parameter schema."""
        ...

    @abstractmethod
    async def execute(self, **kwargs: Any) -> ToolResult:
        """Run the tool with the given keyword arguments."""
        ...
```

一个工具 = **两个方法**：

- `get_definition()` → 我是谁、我要什么参数（给模型看）
- `execute(**kwargs)` → 真正干活（模型碰不到）

源码里还自带了一个最小示例（`tool_protocol.py:218`）：

```py
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

**这就是写一个工具的全部工作量。** 真的，就这么多。

### 7.4.5 deferred：一个省 token 的高级技巧

`BaseTool` 有个类属性 `deferred: bool = False`，源码注释（`tool_protocol.py:212`）解释：

> `deferred` marks a tool for progressive disclosure: its schema is NOT included in the initial per-turn tool list. Instead, the system prompt carries a one-line entry per deferred tool and the model loads full schemas on demand via the `load_tools` tool.

问题背景：如果你有 100 个工具，把 100 份完整 schema 全塞进每次请求，可能就是几万 token，又贵又让模型眼花。

解法叫**渐进披露（progressive disclosure）**：默认只在提示词里给每个工具一行简介，模型觉得"我可能需要这个"，再调 `load_tools` 把完整 schema 拉进来。类似"先给目录，用到哪章再翻哪章"。

---

## 7.5 ToolResult：结果怎么回灌

工具跑完了，结果不能随便返回一个字符串了事。DeepTutor 用 `ToolResult` 统一封装，`tool_protocol.py:122`：

```py
@dataclass
class ToolResult:
    """Standardised return value from a tool execution.
    ...
    """

    content: str = ""
    sources: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    success: bool = True
    terminate_turn: bool = False
    pause_for_user: dict[str, Any] | None = None
```

六个字段，各有分工：

| 字段 | 给谁看 | 作用 |
|------|--------|------|
| `content` | **模型** | 会被塞进 `role=tool` 消息体，模型下一轮读到的就是它 |
| `sources` | **用户界面** | 引用来源，前端渲染成"参考资料"列表 |
| `metadata` | **程序/UI** | 结构化附加信息，比如给前端的渲染提示 |
| `success` | 程序 | 标记失败路径 |
| `terminate_turn` | 循环 | 直接结束本轮 |
| `pause_for_user` | 循环 | 暂停，等用户回答后原地继续 |

### 7.5.1 失败也要给模型看

`success` 字段的注释（`tool_protocol.py:131`）有个反直觉的设计：

> `success`: `False` marks an explicit failure path; the LLM is **still allowed to read** `content` (often an error message).

**工具失败时，不要把错误吞掉，要把错误信息交给模型。** 因为模型看到"Error: file not found: notes.md"之后，可能会自己改用 `list_files` 先看看有哪些文件——这就是智能体的自我纠错能力。你把错误藏起来，它就只能瞎猜。

看 `file_tools.py:71` 的实际写法：

```py
if not fp.exists():
    return ToolResult(content=f"Error: file not found: {path}", success=False)
```

错误信息写得很具体，模型一看就知道怎么补救。

### 7.5.2 pause_for_user：让智能体学会"举手提问"

这是 DeepTutor 一个很有教育场景特色的设计。注释在 `tool_protocol.py:138`：

> When set, the chat loop **pauses** after this tool call, emits a `pending_user_input` event with this payload, awaits the user's reply via the runtime's reply queue, then resumes the same loop iteration with the reply substituted into the tool message body.

普通做法是：AI 想问问题 → 结束这一轮 → 用户回答 → 开新一轮。问题是**上下文和思路断了**。

DeepTutor 的做法是：AI 调 `ask_user` 工具 → 循环**原地暂停** → 用户的回答被当作这个工具的返回值填进去 → 同一轮继续跑。就像人在思考中途抬头问一句，得到答案后接着想，思路不断。

---

## 7.6 完整链路：一次工具调用的全过程

```text
[1] 组装请求
    registry.build_openai_schemas([...])
      -> 每个工具 .get_definition().to_openai_schema()
         tool_protocol.py:63
      -> tools: [ {...}, {...} ]  一起发给模型

[2] 模型决策
    模型读 system + 历史 + tools 列表
    它不执行，只输出一条 assistant 消息，里面带 tool_calls:
      { "id": "call_abc123",
        "function": { "name": "read_file",
                      "arguments": "{\"path\":\"notes.md\"}" } }
    注意 arguments 是一个"字符串形式的 JSON"，要先解析

[3] 调度执行
    dispatch_tool_calls(...)          tool_dispatch.py:78
      -> _prepare_tool_args 解析参数、注入运行时上下文
      -> 去重（模型偶尔会重复请求同一个工具）
      -> 并行执行，上限 MAX_PARALLEL_TOOL_CALLS
      -> 每个工具跑自己的 execute() -> ToolResult

[4] 结果回灌                         tool_dispatch.py:638
    tool_messages.append({
        "role": "tool",
        "tool_call_id": tool_call_id,   <-- 必须和 [2] 的 id 对上
        "name": tool_name,
        "content": result_text,          <-- 就是 ToolResult.content
    })

[5] 下一轮
    messages = [... , assistant(tool_calls), tool(结果), ...]
    再次发给模型 -> 模型基于结果继续，或给出最终答案
```

### 7.6.1 tool_call_id 为什么必须配对

第 4 步那个 `tool_call_id` 是整套机制里最容易出 bug 的地方。规则是：**模型发出的每一个 tool_call，都必须有且仅有一条 role=tool 消息与之对应**。少一条，OpenAI 直接报 400。

所以并行调用 3 个工具，就必须回 3 条 `role=tool` 消息，哪怕其中一个失败了也要回（内容写错误信息）。

DeepTutor 处理了一个真实的边界情况——模型有时会在一条消息里**重复请求同一个工具**。看 `tool_dispatch.py:118` 的注释：

> The first occurrence runs as normal; later duplicates short-circuit to a stub `role=tool` result so OpenAI's tool-call/tool-message pairing stays intact for the next API call.

即：重复的不真跑（省钱、避免副作用重复执行），但**仍然回一条占位结果**，保证配对完整。这种细节不踩过坑是想不到的。

### 7.6.2 并行执行的限流

`tool_dispatch.py:100` 附近：

```py
if len(tool_calls) > MAX_PARALLEL_TOOL_CALLS:
    if too_many_tool_calls_message:
        await stream.progress(...)
    tool_calls = tool_calls[:MAX_PARALLEL_TOOL_CALLS]
```

模型偶尔会一口气要调 20 个工具。不设上限的话，20 个并发请求可能打爆下游服务或把钱烧光。所以**截断 + 提示**，让模型下一轮再要剩下的。

> **提示 · 写工具时的五条实战准则**
>
> 1. **description 写给模型看，不是给同事看**。要写清"什么时候用"和"什么时候别用"。
> 2. **参数越少越好**。每多一个参数，模型填错的概率就上升。能有合理默认值就设默认值。
> 3. **错误信息要可操作**。`"Error"` 没用，`"Error: file not found: notes.md"` 才能让模型自我纠错。
> 4. **返回内容要控制长度**。工具返回 10 万字会直接撑爆上下文。看 `file_tools.py:43` 的 `_MAX_CHARS = 128_000` 和分页提示"use offset=N to continue"——**给模型留继续读的钥匙**，而不是硬截断。
> 5. **副作用要幂等或可确认**。删除、发送、支付这类操作，要么设计成可重试无害，要么先用 `ask_user` 确认。

---

## 7.7 常见误区澄清

| 误区 | 真相 |
|------|------|
| "模型自己执行了函数" | 模型只输出请求，执行的永远是你的程序 |
| "工具越多智能体越强" | 工具多会让模型选择困难、schema 撑爆上下文，所以才有 `deferred` 渐进披露 |
| "工具返回错误就该重试" | 应该先把错误交给模型，让它决定改参数、换工具还是告诉用户 |
| "参数模型肯定填对" | 模型会填错、填空、编造枚举值。调度器必须做校验 |
| "一次只能调一个工具" | 现代模型支持一条消息里并行发多个 tool_calls |

---

## 7.8 本章要点回顾

- 模型不能执行任何东西，它只能输出"我想调用 X，参数是 Y"这样的结构化请求。执行永远由程序完成——这是安全边界的根基。
- 工具说明书用 JSON Schema 描述，`description` 字段是模型唯一的决策依据，要当提示词精心写。
- DeepTutor 的三个核心类：`ToolDefinition`（`tool_protocol.py:48`）描述元数据，`ToolResult`（`tool_protocol.py:122`）封装结果，`BaseTool`（`tool_protocol.py:206`）是所有工具的父类，只需实现 `get_definition` 和 `execute` 两个方法。
- `to_openai_schema`（`tool_protocol.py:63`）负责对象到 JSON 的翻译，其中 array 的 `items` 兜底（`tool_protocol.py:42`）是为了兼容 Gemini/Anthropic 的严格校验。
- `ToolResult.success=False` 时，错误信息仍会交给模型，这是智能体自我纠错的前提。
- `pause_for_user`（`tool_protocol.py:138`）让智能体能在同一轮中途向用户提问再继续，不打断思路。
- 回灌时 `tool_call_id` 必须严格配对（`tool_dispatch.py:638`），重复调用也要回占位结果（`tool_dispatch.py:118`）。
- 并行调用要限流（`tool_dispatch.py:100` 附近的 `MAX_PARALLEL_TOOL_CALLS`）。

---

## 自查清单

- [ ] 我能用一句话说清"模型调用工具"这件事里，模型实际做的是什么、没做的是什么。
- [ ] 我能手写一份最简单的工具 JSON Schema，包含 `name` / `description` / `parameters` / `required`。
- [ ] 我能说出 `ToolDefinition`（`tool_protocol.py:48`）的四个字段各自的用途，以及 `raw_parameters` 为什么存在。
- [ ] 我能打开 `deeptutor/tools/file_tools.py:45`，看懂 `read_file` 工具的三个参数为什么这样设计。
- [ ] 我能解释 `to_openai_schema`（`tool_protocol.py:63`）里为什么要给 array 类型补 `items`。
- [ ] 我能说出 `ToolResult`（`tool_protocol.py:122`）中 `content` 和 `sources` 分别是给谁看的。
- [ ] 我能解释为什么工具失败时也要把错误信息交给模型，而不是静默处理。
- [ ] 我能说清 `tool_call_id` 配对规则，以及不配对会发生什么。
- [ ] 我能解释 `deferred`（`tool_protocol.py:212`）的渐进披露解决了什么问题。
- [ ] 我能照着 `BaseTool`（`tool_protocol.py:218`）的示例，写出一个自己的工具类骨架。
