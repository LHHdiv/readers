---
title: "第 41 章 · 动手实践二：写一个自定义工具"
date: 2026-08-01
summary: "前面几章我们把 DeepTutor 的\"大脑循环\"拆开看过了。这一章不再只是看，而是要**亲手写一个能跑的工具（Tool）**。读完你就能给智能体接上任何你自己想要的能力——查数据库、调内部 API、算一道题、发一条消息，全都行。"
tags:
  - deeptutor
---
# 第 41 章 · 动手实践二：写一个自定义工具

前面几章我们把 DeepTutor 的"大脑循环"拆开看过了。这一章不再只是看，而是要**亲手写一个能跑的工具（Tool）**。读完你就能给智能体接上任何你自己想要的能力——查数据库、调内部 API、算一道题、发一条消息，全都行。

本章所有引用都来自真源码 `deeptutor/core/tool_protocol.py` 与 `deeptutor/runtime/registry/tool_registry.py`，你可以边读边去翻原文件对照。

## 工具到底是什么（先直觉，后原理）

**直觉**：工具就是智能体会用的"手"。它自己只会"想"和"说"，但如果你问它"今天北京几度"，它脑子里没有实时天气，就必须伸出一只叫 `get_weather` 的手去查。工具 = 一段被智能体在对话中途调用的函数。

**原理**：在 DeepTutor 里，工具不是随便一个函数，而是必须遵守一套"契约"的类。契约规定了三件事：

1. 你这只手叫什么、能干嘛、要什么参数（**给模型看的描述**）；
2. 真正被调用时执行什么代码（**给程序跑的逻辑**）；
3. 执行完返回什么（**喂回模型的答案**）。

模型看到的是第 1 份"说明书"，程序跑的是第 2 份"代码"，最后把第 3 份"结果"放回对话，模型再基于结果继续说。整个过程对你完全透明。

> **提示 · 为什么不用普通函数**
>
> 你可以写 `def get_weather(): ...`，但模型不会自动知道它的存在。工具类把"描述"和"代码"绑在一起，注册表（registry）再把描述翻译成模型能懂的 OpenAI function-calling 格式。少了任何一环，模型就"看不见"你的手。

## 真源码里的三个零件

打开 `deeptutor/core/tool_protocol.py`，整套工具契约由三个数据类 + 一个基类组成。

### 零件一：ToolParameter —— 单个参数

定义在 `deeptutor/core/tool_protocol.py:16`。它描述工具的一个输入项：

```python
@dataclass
class ToolParameter:
    name: str
    type: str          # "string" | "integer" | "boolean" | "number" | "array" | "object"
    description: str = ""
    required: bool = True
    default: Any = None
    enum: list[str] | None = None
    items: dict[str, Any] | None = None
```

注意 `type` 只能取那 6 个值之一，这是给模型（和 OpenAI/Gemini/Anthropic 等提供商）看的 JSON Schema 类型。当 `type="array"` 时，务必填 `items`，否则 Gemini 会直接报 400（源码注释里专门写了这个坑，见 `deeptutor/core/tool_protocol.py:21`）。`to_schema()` 方法在 `deeptutor/core/tool_protocol.py:37` 把它转成真正的 JSON Schema 片段。

### 零件二：ToolDefinition —— 工具的"身份证"

定义在 `deeptutor/core/tool_protocol.py:48`。它把名字、说明、参数列表打包：

```python
@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: list[ToolParameter] = field(default_factory=list)
    raw_parameters: dict[str, Any] | None = None
```

`to_openai_schema()`（在 `deeptutor/core/tool_protocol.py:63`）是重点：它把这份定义变成模型 API 认识的格式，形如 `{"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}`。注册表在生成"本回合可用工具清单"时，就是批量调用这个方法的（见 `deeptutor/runtime/registry/tool_registry.py:124` 的 `build_openai_schemas`）。

### 零件三：ToolResult —— 工具的"回话"

定义在 `deeptutor/core/tool_protocol.py:122`。工具跑完后必须返回它：

```python
@dataclass
class ToolResult:
    content: str = ""                       # 返回给模型的文字答案
    sources: list[dict[str, Any]] = ...      # 引用/出处，用于界面展示
    metadata: dict[str, Any] = ...           # 自由载荷，比如选项卡片
    success: bool = True                     # False 表示失败路径
    terminate_turn: bool = False             # 是否直接结束这一轮
    pause_for_user: dict[str, Any] | None = None  # 是否暂停等用户回答
```

最常用的是 `content`：它就是会被塞进 `role=tool` 消息、交给模型继续读的文字。

### 基类：BaseTool —— 把三者缝起来

定义在 `deeptutor/core/tool_protocol.py:206`。所有工具都继承它，必须实现两个抽象方法：

- `get_definition()`（`deeptutor/core/tool_protocol.py:235`）：返回上面的 `ToolDefinition`；
- `execute(**kwargs)`（`deeptutor/core/tool_protocol.py:240`）：真正跑逻辑，返回 `ToolResult`。

源码 `deeptutor/core/tool_protocol.py:218` 给了一段最小示例，和我们下面要写的几乎一样。

## 工具是怎么被"发现"和"调用"的

理解这条链路，你才知道自己的工具装进去后会经历什么：

```text
用户发消息
   │
   ▼
能力 / 聊天循环想调用某个工具
   │  名字字符串，如 "get_weather"
   ▼
ToolRegistry.get(name)           工具注册表.查找
   │  deeptutor/runtime/registry/tool_registry.py:74
   ▼
匹配到你的 BaseTool 实例
   │
   ▼
ToolRegistry.execute(name, **kwargs)   工具注册表.执行
   │  deeptutor/runtime/registry/tool_registry.py:128
   ▼
你的 tool.execute(**kwargs)
   │
   ▼
返回 ToolResult
   │
   ▼
content 被塞回对话，模型继续推理
```

关键点：循环只认**名字字符串**。它去注册表 `get()`（`deeptutor/runtime/registry/tool_registry.py:74`）查这个名字对应的实例，再用 `execute()`（`deeptutor/runtime/registry/tool_registry.py:128`）调用。所以"注册"的本质，就是让某个名字能查到你的实例。

## 模板：从零写一个"查天气工具"

下面是一份**可直接照抄**的 Python 模板。我们写一个最简单的天气查询工具（用假数据，重点在结构）：

```python
# my_tools/weather_tool.py
from deeptutor.core.tool_protocol import (
    BaseTool, ToolDefinition, ToolParameter, ToolResult,
)

_FAKE_WEATHER = {
    "beijing": "晴，12°C，西北风 3 级",
    "shanghai": "多云，18°C，东南风 2 级",
}

class WeatherTool(BaseTool):
    # 1) 给模型看的"说明书"
    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="get_weather",
            description="查询某个城市的当前天气。当用户问到实时天气时调用。",
            parameters=[
                ToolParameter(
                    name="city",
                    type="string",
                    description="城市名，例如 beijing / shanghai",
                ),
            ],
        )

    # 2) 真正跑的代码
    async def execute(self, **kwargs) -> ToolResult:
        city = str(kwargs.get("city", "")).strip().lower()
        if not city:
            return ToolResult(
                content="缺少参数 city。",
                success=False,
            )
        weather = _FAKE_WEATHER.get(city)
        if weather is None:
            return ToolResult(
                content=f"暂无 {city} 的天气数据。",
                success=False,
            )
        return ToolResult(
            content=f"{city} 当前天气：{weather}",
            success=True,
        )
```

注意三点：`execute` 是 `async` 异步函数（DeepTutor 全程异步，见 `deeptutor/core/tool_protocol.py:240` 的签名）；参数从 `**kwargs` 里按名字取；无论成功失败都返回 `ToolResult`，让模型自己判断下一步。

> **说明 · 工具名即入口**
>
> 模型挑工具靠的是 `ToolDefinition.name`。这个名字要短、全小写带下划线（如 `get_weather`），别用中文或空格，否则注册表和函数调用都对不上。

## 模板：把它注册进全局注册表

写好了类，还要让它"被看见"。两种做法：

**做法 A：运行时手动注册**（适合插件 / 临时试用）

```python
from deeptutor.runtime.registry import get_tool_registry
from my_tools.weather_tool import WeatherTool

registry = get_tool_registry()          # 全局单例，deeptutor/runtime/registry/tool_registry.py:147
registry.register(WeatherTool())        # register 在 deeptutor/runtime/registry/tool_registry.py:36
```

`get_tool_registry()`（`deeptutor/runtime/registry/tool_registry.py:147`）是进程级单例，第一次调用会自动 `load_builtins()` 把内置工具也都装好。`register()`（`deeptutor/runtime/registry/tool_registry.py:36`）就是把你的实例按 `name` 存进内部字典。

**做法 B：声明进内置清单**（适合长期固定集成）

打开 `deeptutor/tools/builtin/__init__.py`，把你的类加进 `BUILTIN_TOOL_TYPES`（`:1562` 处那个元组），并确保 `__all__` 导出它。`load_builtins()`（`deeptutor/runtime/registry/tool_registry.py:49`）会遍历这个元组、逐个实例化并注册。内置的 `RagTool` 就是这样挂上去的（定义见 `deeptutor/tools/builtin/__init__.py:95`）。

```text
BUILTIN_TOOL_TYPES（deeptutor/tools/builtin/__init__.py:1562）
   │  遍历每个工具类
   ▼
tool_type() 实例化
   │
   ▼
registry.register(tool)         tool_registry.py:36
   │
   ▼
聊天循环从此能"看见"它
```

## 真实范例：DeepTutor 的 RAGTool 长什么样

内置的 `RAGTool`（`deeptutor/tools/builtin/__init__.py:95`）是理解工具结构的绝佳参考。它做了三件值得你模仿的事：

1. `get_definition()` 用 `ToolParameter` 声明 `query` 和 `kb_name` 两个参数；
2. `execute()` 先校验参数非空（空就抛 `ValueError`），再调真实检索函数 `rag_search`；
3. 把检索结果包进 `ToolResult(content=..., sources=...)`，让界面能显示引用来源。

对比你刚写的 `WeatherTool`，结构完全一样——区别只在"真逻辑"换了内容。这就是工具层的优雅之处：**框架只管契约，业务逻辑全交给你**。

> **注意 · 别忘了参数校验**
>
> 模型偶尔会传错参数（比如 `kb_name` 留空）。像 `RAGTool` 那样在 `execute` 开头显式校验并返回 `success=False` 的 `ToolResult`，比直接抛异常更友好——模型读到 `content` 里的错误说明，会自己换个正确参数重试。

## ToolResult 的进阶字段：sources / metadata / pause_for_user

第 41 章开头只用了 `content` 和 `success`。`ToolResult`（`deeptutor/core/tool_protocol.py:122`）还有三个在真实产品里极常用的字段，提前认识它们，你写的工具会更"产品级"：

- `sources`（`deeptutor/core/tool_protocol.py:149`）：引用出处列表。比如 `rag` 检索到某段教材，应当把 `{title, source, page}` 塞进 `sources`，前端就能显示"这句话出自哪一页"。内置 `RAGTool` 就是靠 `_rag_sources` 把出处规范化的。
- `metadata`（`deeptutor/core/tool_protocol.py:150`）：自由载荷。聊天管线会用它传递结构化 UI 提示，例如 `ask_user.options` 用来渲染选项卡片。你的工具也可以放任意 JSON 进去，供前端或后续阶段读取。
- `pause_for_user`（`deeptutor/core/tool_protocol.py:153`）：当设置了这个字典，循环会在工具调用后**暂停**，发出 `pending_user_input` 事件，等用户回复再续上同一轮。这是 `ask_user` 工具（`deeptutor/tools/builtin/__init__.py:1179`）实现"反问用户"的机制。普通工具一般不用，但知道它存在能帮你理解为什么有的工具会让对话"卡住等你"。

```python
# 进阶版：带引用来源的天气工具返回
return ToolResult(
    content=f"{city} 当前天气：{weather}",
    sources=[{"type": "weather_api", "city": city, "updated": "2026-08-13"}],
    metadata={"temp_c": 12, "wind": "西北风3级"},
    success=True,
)
```

## 工具是怎么被聊天循环"自动挂载"的

你注册好工具后，聊天循环并非把所有工具一次性全塞给模型——那样会超出上下文、也扰乱模型。DeepTutor 用两份名单管理"哪些工具对用户可见"：

- `USER_TOGGLEABLE_TOOL_NAMES`（`deeptutor/tools/builtin/__init__.py:1627`）：用户在设置页可手动开关的工具（如 `brainstorm`、`web_search`、`reason`）。
- `CONFIGURABLE_BUILTIN_TOOL_NAMES`（`deeptutor/tools/builtin/__init__.py:1647`）：聊天循环按"上下文闸门"自动挂载的工具（比如挂了知识库才给 `rag`，开了沙箱才给 `code_execution`）。

而 `TOOL_ALIASES`（`deeptutor/tools/builtin/__init__.py:1665`）则是一层"名字兼容"：模型可能叫 `rag_search`，注册表里存的是 `rag`，别名把它映射到同一个实例（见 `tool_registry.py:61` 的 `_resolve_request`）。你自己的工具也可以加别名，避免模型拼错名字时查不到。

```text
模型想调 "rag_search"
        │
        ▼
ToolRegistry._resolve_request   tool_registry.py:61
        │  查 TOOL_ALIASES (builtin/__init__.py:1665)
        ▼
映射到真实实例 "rag"
        │
        ▼
tool.execute(**kwargs)          tool_registry.py:128
```

## 别名与渐进披露（deferred tools）

除了别名，还有一类"延迟工具"：它们的 schema 不进初始工具清单，系统提示里只放一行简介，模型需要时再通过 `load_tools` 工具按需加载完整 schema。开关就是 `BaseTool.deferred`（`deeptutor/core/tool_protocol.py:232`）这个布尔类属性；注册表用 `deferred_tools()`（`deeptutor/runtime/registry/tool_registry.py:45`）收集它们。`load_tools` 工具本身定义在 `deeptutor/tools/builtin/__init__.py:1407`。

```python
class MyHeavyTool(BaseTool):
    deferred: bool = True   # 不在开局暴露，按需加载
    def get_definition(self) -> ToolDefinition: ...
    async def execute(self, **kwargs) -> ToolResult: ...
```

> **提示 · 什么时候用 deferred**
>
> 当你的工具 schema 很长（很多参数），或者很少被用到时，设 `deferred=True` 能省下每轮对话的 token 与注意力。普通小工具没必要，直接常驻更省事。

## 本地小测试：不依赖前端验证你的工具

写完后不必每次都开前端。用一段最小异步脚本就能验证：

```python
import asyncio
from deeptutor.runtime.registry import get_tool_registry
from my_tools.weather_tool import WeatherTool

async def main():
    registry = get_tool_registry()
    registry.register(WeatherTool())
    # 1) 看模型会看到的 schema
    schemas = registry.build_openai_schemas(["get_weather"])  # tool_registry.py:124
    print(schemas)
    # 2) 直接调一次，验证逻辑
    result = await registry.execute("get_weather", city="beijing")  # tool_registry.py:128
    print(result.content, result.success)

asyncio.run(main())
```

`build_openai_schemas`（`deeptutor/runtime/registry/tool_registry.py:124`）帮你确认"模型看到的说明书"是否正确；`execute`（`tool_registry.py:128`）直接跑逻辑。两个都过了，再接前端就不慌。

## 工具与能力的关系（先铺垫第 42 章）

工具是"单步动作"，能力（Capability）是"多步剧本"。一个能力（比如"深度解题"）内部会循环调用多个工具。你今天写的工具，明天就能被某个能力编排进它的剧本里。两者通过同一套注册表对接：工具进 `ToolRegistry`，能力进 `CapabilityRegistry`。

## 常见错误与修复（照抄避坑）

写第一个工具时，这几个错误最高发，提前知道能省一下午：

1. **忘记 `async`**：`execute` 必须是 `async def`（见 `deeptutor/core/tool_protocol.py:240`）。写成普通 `def`，注册表调用时会报"协程对象无法返回 ToolResult"。
2. **返回了字符串而非 ToolResult**：循环只认 `ToolResult`（`tool_protocol.py:122`）。直接 `return "ok"` 会被当成异常。
3. **`name` 与别处冲突**：名字重复时 `load_builtins`（`tool_registry.py:49`）会跳过你的实例。换一个唯一名字。
4. **参数 `type` 写了 "str"**：只能用那 6 个标准值（`tool_protocol.py:16`），写 `"str"` 模型端会报错。
5. **`array` 参数漏了 `items`**：Gemini 严格校验（`tool_protocol.py:21` 注释），漏了直接 400。

```python
# 错误示范（别这样）
def execute(self, city):          # 错：不是 async
    return "天气晴"                # 错：返回字符串不是 ToolResult

# 正确示范
async def execute(self, **kwargs) -> ToolResult:
    city = kwargs.get("city", "")
    return ToolResult(content=f"{city} 天气晴", success=True)
```

> **注意 · 注册后没生效？先确认"是否真的注册了"**
>
> 最常见的新手困惑："我明明写了工具，为什么模型不用？"按顺序查：(1) 类是否继承 BaseTool 且实现了两个方法；(2) 是否调用了 `register`（tool_registry.py:36）或加进了 `BUILTIN_TOOL_TYPES`（builtin/__init__.py:1562）；(3) 名字是否唯一；(4) 能力是否把该工具放进 `tools_used` / 是否挂到了本回合。日志搜工具名能一次定位。

## 自查清单

- [ ] 我能用一句话说清"工具 = 智能体会调用的函数 + 给模型的描述"
- [ ] 我知道 ToolDefinition / ToolResult / BaseTool 分别定义在 tool_protocol.py 的哪一行
- [ ] 我写的工具继承了 BaseTool 并实现了 get_definition 与 execute
- [ ] 我的 execute 是 async 函数，且无论从 kwargs 取参数还是返回都用了 ToolResult
- [ ] 我把工具注册进了 ToolRegistry（手动 register 或加进 BUILTIN_TOOL_TYPES）
- [ ] 我理解循环靠"名字字符串"去注册表 get/execute，所以名字必须唯一且规范
- [ ] 我的工具在参数缺失时会返回 success=False 的 ToolResult，而不是直接崩溃
- [ ] 我对照过内置 RAGTool（builtin/__init__.py:95）的结构来校验自己的写法
