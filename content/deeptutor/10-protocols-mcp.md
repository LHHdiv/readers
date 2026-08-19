---
title: "第 10 章 · 协议与生态：MCP、Tool Use、多智能体"
date: 2026-08-01
summary: "讲清 MCP（Model Context Protocol）到底是什么、它和第 7 章的函数调用是什么关系、为什么它被称为\"智能体界的 USB-C\"。再讲多智能体协作的几种模式。最后用真源码说明 DeepTutor 对 MCP 的支持深度——这恰恰是很多编码智能体缺失的一环。"
tags:
  - deeptutor
---
# 第 10 章 · 协议与生态：MCP、Tool Use、多智能体

> 目标：讲清 MCP（Model Context Protocol）到底是什么、它和第 7 章的函数调用是什么关系、为什么它被称为"智能体界的 USB-C"。再讲多智能体协作的几种模式。最后用真源码说明 DeepTutor 对 MCP 的支持深度——这恰恰是很多编码智能体缺失的一环。

---

## 10.1 先看一个真实的痛点

第 7 章我们学会了写工具：继承 `BaseTool`，实现 `get_definition` 和 `execute`，搞定。

现在假设你要给智能体接入这些能力：

```text
  读取 GitHub 仓库      -> 写一个 GitHub 工具
  查询 PostgreSQL       -> 写一个数据库工具
  操作 Notion 文档      -> 写一个 Notion 工具
  控制浏览器            -> 写一个浏览器工具
  搜索 Slack 消息       -> 写一个 Slack 工具
```

五个工具，五套认证逻辑，五套错误处理，五份 schema。而且——

**你的同事在另一个项目里，正在写一模一样的五个工具。** 全世界成千上万的开发者，都在重复造这些轮子。

更糟的是：如果你从 LangChain 换到自研框架，这五个工具全部要重写，因为每个框架的工具接口都不一样。

```text
   N 个智能体框架  x  M 个外部服务  =  N x M 份适配代码

        Agent A ----> GitHub 适配器 A
        Agent A ----> Notion 适配器 A
        Agent B ----> GitHub 适配器 B   <- 和上面功能完全一样，白写
        Agent B ----> Notion 适配器 B
        ...
```

这个问题在计算机历史上出现过无数次。解法永远是同一个：**定一个标准协议，把 N×M 变成 N+M。**

---

## 10.2 MCP 是什么

**MCP = Model Context Protocol（模型上下文协议）**，由 Anthropic 在 2024 年 11 月开源发布（[modelcontextprotocol.io](https://modelcontextprotocol.io)）。

一句话定义：**一个标准协议，规定"提供工具的服务"和"使用工具的智能体"之间怎么对话。**

### 10.2.1 USB-C 的比喻

MCP 官方自己用的比喻就是 USB-C，非常贴切：

```text
   没有 USB-C 的年代：
     每个手机一种充电口，换手机就得换全套线

   有了 USB-C：
     任何设备 <--统一接口--> 任何充电器/显示器/硬盘

   ----------------------------------------

   没有 MCP：
     每个智能体框架一套工具接口，换框架就得重写全部工具

   有了 MCP：
     任何智能体 <--MCP--> 任何工具服务
```

于是 N×M 变成了 N+M：

```text
        Agent A ----+
        Agent B ----+---- MCP 协议 ----+---- GitHub MCP Server
        Agent C ----+                  +---- Notion MCP Server
                                       +---- Postgres MCP Server
                                       +---- 你自己写的 MCP Server

   每个 Server 只写一次，所有 Agent 都能用。
   每个 Agent 只实现一次 MCP 客户端，所有 Server 都能连。
```

### 10.2.2 三个角色

| 角色 | 是谁 | 干什么 |
|------|------|--------|
| **MCP Host** | 智能体应用（DeepTutor、Claude Desktop 等） | 决定连哪些服务器、把工具给模型用 |
| **MCP Client** | Host 内部的连接层 | 按协议和 Server 通信 |
| **MCP Server** | 提供能力的独立程序 | 声明自己有哪些工具/资源，接受调用 |

关键点：**MCP Server 是独立进程或独立服务，和你的智能体解耦。** 它可以是别人写的、用任何语言写的，你只要按协议连上就能用。

> **说明 · 黑话拆解：什么叫"协议"（protocol）**
>
> 协议就是**双方约定好的说话规矩**。比如 HTTP 协议规定"请求要写成 `GET /path HTTP/1.1` 这样"，于是全世界的浏览器和服务器都能互通。
> 
> MCP 规定的是：怎么握手、怎么问"你有哪些工具"、怎么调用、结果怎么返回、进度怎么上报。只要两边都守这个规矩，就能协作——**哪怕它们是完全陌生的两个团队写的。**

### 10.2.3 MCP 提供的三类东西

MCP 不只是工具，它定义了三种"上下文资源"：

| 类型 | 含义 | 例子 |
|------|------|------|
| **Tools（工具）** | 可执行的动作 | 创建 issue、执行 SQL、发消息 |
| **Resources（资源）** | 可读取的数据 | 文件内容、数据库表结构 |
| **Prompts（提示词模板）** | 预置的提示词 | "代码审查"模板、"总结会议纪要"模板 |

实践中 Tools 用得最多，本章主要讲它。

---

## 10.3 MCP 和 Function Calling 的关系

这是最多人搞混的一点。**它们不是竞争关系，是上下游关系。**

```text
   +----------------------------------------------------+
   |  模型层：Function Calling                           |
   |  模型输出 tool_calls，说"我要调 X，参数 Y"           |
   |  （第 7 章讲的内容，OpenAI/Anthropic 的 API 规范）   |
   +------------------------+---------------------------+
                            |
                   程序读到 tool_calls
                            |
                            v
   +----------------------------------------------------+
   |  调度层：你的程序决定怎么执行                        |
   |    - 内置工具 -> 直接调本地函数                      |
   |    - MCP 工具 -> 走 MCP 协议发给外部 Server          |
   +------------------------+---------------------------+
                            |
                            v
   +----------------------------------------------------+
   |  能力层：MCP 协议                                    |
   |  规定 Host 和 Server 之间怎么发现工具、怎么调用      |
   +----------------------------------------------------+
```

用一句话记住：

> **Function Calling 解决"模型怎么表达想调工具"，MCP 解决"工具从哪来"。**

模型完全不知道 MCP 的存在。在它眼里，MCP 工具和内置工具长得一模一样——都是一份 JSON schema。转换工作发生在调度层。

---

## 10.4 DeepTutor 怎么接 MCP

### 10.4.1 适配器：把 MCP 工具伪装成普通工具

DeepTutor 的做法非常干净：写一个适配器类，让 MCP 工具**继承 `BaseTool`**，这样后面所有代码都不用改。

看 `deeptutor/services/mcp/manager.py:106`：

```py
class MCPToolAdapter(BaseTool):
    """One MCP server tool exposed as a chat tool (deferred by default)."""

    deferred = True
    #: Provider kind read by the deferred-tool manifest and the trace layer.
    provider_kind = "mcp"
```

它的 `get_definition`（`manager.py:147`）：

```py
def get_definition(self) -> ToolDefinition:
    return ToolDefinition(
        name=self._wrapped_name,
        description=f"[{self._server_name}] {self._description}",
        raw_parameters=self._input_schema,
    )
```

**这里能把第 7 章的伏笔全部接上：**

1. 返回的就是第 7 章讲的 `ToolDefinition`（`deeptutor/core/tool_protocol.py:48`）。
2. 用的是 `raw_parameters` 而不是 `parameters` 列表——因为 MCP Server 给的是任意 JSON Schema，硬转成 `ToolParameter` 会丢信息。这正是 `tool_protocol.py:52` 注释里说的场景，**它就是为 MCP 准备的**。
3. `description` 前面加了 `[服务器名]` 前缀，让模型知道这个工具来自哪。

工具名的处理在 `manager.py:101`：

```py
def wrapped_tool_name(server: str, tool: str) -> str:
    """``mcp_<server>_<tool>`` with non-identifier characters sanitised."""
    return f"mcp_{_NAME_SANITIZE_RE.sub('_', server)}_{_NAME_SANITIZE_RE.sub('_', tool)}"
```

为什么要重命名？两个原因：**防重名**（两个 Server 都有叫 `search` 的工具就撞了）和**合法化**（MCP 工具名可能带连字符、点号，而函数名只允许字母数字下划线）。

### 10.4.2 执行：转发出去

`manager.py:154` 的 `execute`：

```py
async def execute(self, **kwargs: Any) -> ToolResult:
    event_sink = kwargs.pop("event_sink", None)
    text = await self._manager.call_tool(
        self._owner,
        self._server_name,
        self._original_name,
        kwargs,
        timeout=self._tool_timeout,
        on_progress=_progress_reporter(event_sink, self._server_name) if event_sink else None,
    )
    return ToolResult(
        content=text,
        metadata={"mcp_server": self._server_name, "mcp_tool": self._original_name},
    )
```

注意 `on_progress` 那一行，源码注释（`manager.py:155`）解释了它的价值：

> MCP servers report progress as notifications during a long call, and that is the only thing a reader has to look at while a five-minute render or crawl is running.

**MCP 支持长任务的进度上报。** 一个抓取网站的工具跑五分钟，用户不该盯着空白屏幕。DeepTutor 把这些进度通知接进了自己的事件流，显示在界面上。这是很多简易 MCP 客户端会直接丢掉的细节。

### 10.4.3 为什么默认 deferred

注意 `MCPToolAdapter` 的 `deferred = True`。回忆第 7 章 `tool_protocol.py:212` 讲的渐进披露。

原因很实际：一个 MCP Server 可能暴露几十个工具。用户连了 5 个 Server，就是上百个工具的 schema，全塞进每次请求会撑爆上下文。所以 MCP 工具默认只在提示词里占一行简介，模型需要时再用 `load_tools` 拉完整 schema。

模块文档 `manager.py:24` 说得很明确：

> Tool adapters are flagged `deferred` — their schemas reach the model via the `load_tools` progressive-disclosure flow, not the initial tool list — and are synced into the global `ToolRegistry` so the regular dispatch path executes them.

最后半句是精髓：**同步进全局注册表，走普通分发路径执行**。也就是说，MCP 工具在执行环节和内置工具走完全相同的代码。没有分叉，没有特例。

---

## 10.5 连接管理：最难的部分

把 MCP 讲成"连上就能用"是不负责任的。真正难的是连接的**生命周期管理**。

### 10.5.1 一个真实的技术约束

`manager.py:9` 的模块文档描述了一个棘手问题：

> DeepTutor's chat runs as per-turn tasks inside one event loop, while MCP sessions must be opened and closed inside the same task (the SDK's anyio cancel scopes are task-bound). Each server therefore gets a dedicated *connection task* that owns its `AsyncExitStack` end-to-end.

用大白话讲：

- DeepTutor 的每轮对话是一个独立的异步任务，聊完就结束。
- 但 MCP 的会话**必须在打开它的那个任务里关闭**（底层库的限制）。
- 如果在"第 3 轮对话"这个任务里打开连接，第 3 轮结束时任务没了，连接就成了孤儿。

解法（`manager.py:14`）：

```text
    connect → enter transports/session in the task → publish adapters →
    wait on a shutdown event → exit the stack in the same task
```

**给每个 Server 一个专属的长期任务**，它只负责：建连接 → 把工具适配器发布出去 → 一直挂着等关闭信号 → 收到信号后在自己这个任务里干净地关闭。

对话任务只是"借用"这些适配器，不拥有连接。

### 10.5.2 懒启动与增量重载

`manager.py:19` 还提到两个优化：

> `ensure_started()` is lazy (first turn pays the connect cost, capped by a per-server timeout) and cheap afterwards. `reload()` diffs the persisted config against live connections and only restarts servers whose configuration actually changed.

- **懒启动**：程序启动时不连任何 Server，第一次真用到才连。避免用户配了 8 个 Server 但今天一个都不用，却要等 30 秒启动。
- **超时上限**：`manager.py:53` 定义了 `_CONNECT_TIMEOUT_S = 15`，一个 Server 连不上不能拖死全局。
- **增量重载**：改配置时只重启变了的 Server，没动的连接保持不断。

### 10.5.3 容错：连接会断

`manager.py:421` 的 `call_tool` 是容错的集大成者：

```py
async def call_tool(
    self,
    owner: str,
    server_name: str,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    timeout: int,
    on_progress: "ProgressCallback | None" = None,
) -> str:
    """Invoke a tool on a connected server; one retry on transient errors."""
    conn = self._connections.get((owner, server_name))
    if conn is None or conn.session is None or conn.status != "connected":
        return f"(MCP server {server_name!r} is not connected)"
```

往下是一长串 `except`，覆盖：连接丢失、瞬时传输错误（重试一次）、超时、被取消、其他异常。每一种都**返回一段人话说明**，而不是抛异常。

```py
except asyncio.TimeoutError:
    return f"(MCP tool call timed out after {timeout}s)"
```

为什么返回字符串而不是抛异常？回忆第 7 章 9.5.1 的原则：**这段文字会作为 `ToolResult.content` 进入模型的视野**。模型看到"MCP 服务器没连上"，就能改用别的工具或者告诉用户；抛异常则整轮对话直接崩掉。

> **提示 · 判断一个 MCP 实现是否成熟的四个指标**
>
> 1. **连接生命周期正确**：不会在对话结束时泄漏连接或崩溃。
> 2. **失败降级为文本**：一个 Server 挂了，只影响它自己的工具，不影响整轮对话。
> 3. **进度可见**：长任务有进度反馈，不是黑屏等待。
> 4. **多工具不撑爆上下文**：有渐进披露之类的机制。
> 
> DeepTutor 四条都有：分别对应 `manager.py:14`（专属连接任务）、`manager.py:421`（异常转文本）、`manager.py:174`（进度转发）、`manager.py:109`（`deferred = True`）。

---

## 10.6 安全：用户能配 MCP 意味着什么

这是 DeepTutor 里我认为最值得学的一段代码，因为它体现了"开放能力"必然带来的安全代价。

### 10.6.1 攻击场景

假设你允许用户自己填一个 MCP Server 的 URL。用户填了：

```text
http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

这是云服务商的**元数据服务地址**。你的服务器进程去请求它，就能拿到云账号的临时凭证——然后返回给攻击者。这类攻击叫 **SSRF（服务端请求伪造）**。

`deeptutor/services/mcp/network.py:1` 的模块文档把这个威胁模型讲得极其清楚：

> **Self-service servers** (a user's own, `strict=True`) additionally lose loopback and private ranges. The request is made by the *app process*, which holds every provider API key and shares a network with PocketBase and the sandbox runner; a URL a user supplies must not be able to aim it inward.

翻译：发请求的是**应用进程本身**，它手里握着所有厂商的 API key，还和数据库、沙箱在同一个内网。用户给的 URL 绝不能指向内部。

### 10.6.2 两档信任级别

`network.py:5` 定义了两种姿态：

| 来源 | 策略 | 理由 |
|------|------|------|
| 管理员的 `mcp.json` | 宽松，只拦链路本地和云元数据段 | 自建部署本来就会在 localhost 跑 Server，且管理员本来就有主机权限 |
| 用户自助配置（`strict=True`） | 额外禁掉回环和内网段 | 用户是不可信输入 |

黑名单在 `network.py:31`：

```py
_BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local / cloud metadata
    ipaddress.ip_network("fe80::/10"),  # link-local v6
]
```

### 10.6.3 两个精妙的防御细节

**细节一：连接时重新校验，而不只在保存时**

`network.py:21`：

> Validation is deliberately re-run at connect time, not only when a server is saved: a check that happens once at save time is defeated by a DNS record that changes afterwards.

攻击手法叫 **DNS rebinding**：保存时 `evil.com` 解析到一个正常公网 IP，通过校验；等到真正连接时，DNS 记录已经改成了 `169.254.169.254`。所以校验必须在**建立套接字之前的最后一刻**再做一次。

代码里对应 `manager.py:775`：

```py
if self_service:
    # Re-validated here, not only where the server was saved: DNS can
    # change between the two, and this is the last point before a socket.
    from deeptutor.services.mcp.network import validate_mcp_url_async

    ok, error = await validate_mcp_url_async(cfg.url, strict=True)
    if not ok:
        raise ValueError(error)
```

**细节二：用户配置的 Server 禁止重定向**

紧接着一行（`manager.py:783`）：

```py
follow_redirects = not self_service
```

理由写在 `manager.py:753` 的注释里：

> an approved public URL that 302s to 169.254.169.254 or to an internal service would otherwise walk straight past a save-time-only check.

即：一个通过了审核的公网 URL，返回 302 跳转到内网地址，就绕过了所有前置检查。所以用户配的 Server 直接不许跟随重定向。

**细节三：stdio 传输仅限管理员**

`manager.py:764`：

```py
if transport == "stdio":
    if self_service:
        raise ValueError("stdio MCP servers are administrator-only")
```

`stdio` 类型的 MCP Server 是**在本机启动一个子进程**。如果允许用户配，等于允许任意用户在你的服务器上执行任意命令。必须禁止。

> **注意 · 给准智能体开发者的告诫**
>
> "让 AI 能连接任何工具"听起来很酷，但每开放一分能力，就多一分攻击面。MCP 的能力边界 = 你的智能体的能力边界，也 = 攻击者拿到你的智能体后的能力边界。
> 
> 三条底线：
> 1. **用户输入的 URL 一律不可信**，且要在最后一刻校验。
> 2. **能启动本地进程的能力，绝不开放给非管理员。**
> 3. **失败要降级，不要把内部错误细节原样吐给模型/用户**（`manager.py:958` 有个 `_redact_urls` 就是干脱敏的）。

---

## 10.7 多智能体：让 AI 调用 AI

### 10.7.1 为什么需要多个智能体

单个智能体的三个瓶颈：

1. **提示词打架**：又要它当严谨的数学老师，又要它当活泼的写作伙伴，规则冲突，两边都做不好。
2. **上下文污染**：为了解一道题读了 50 页资料，这些内容占着窗口，影响后续对话质量。
3. **能力不匹配**：写代码最好用编码专精模型，讲课最好用对话专精模型，一个模型难以全能。

解法：**拆成多个各司其职的智能体**。

### 10.7.2 三种协作模式

```text
【模式一】主从（Supervisor / Sub-agent）—— 最常用

        主智能体（面对用户）
              |
      "这块我不擅长，外包"
              |
        +-----+-----+
        |           |
     子智能体A   子智能体B
     （编码）    （检索）
        |           |
        +-----+-----+
              |
        结果汇总回主智能体
              |
          回答用户

   特点：主智能体保持对话主线，子智能体的中间过程
        不污染主上下文，只回传结论。


【模式二】流水线（Pipeline）

   智能体1 --> 智能体2 --> 智能体3 --> 输出
   (提纲)     (初稿)      (润色)

   特点：顺序固定，每步职责单一，易调试。
        缺点是不灵活，中间发现问题很难回头。


【模式三】辩论 / 评审（Debate）

   智能体A 给出方案
        |
        v
   智能体B 挑毛病（换个角色、换个模型）
        |
        v
   智能体A 修订
        |
        v
     收敛后输出

   特点：质量高（本质是第 8 章 Reflection 的多模型版），
        但成本翻倍甚至更多。
```

### 10.7.3 主从模式的核心价值：上下文隔离

这一点值得单独强调。

```text
   不隔离（主智能体自己干所有事）：
     主上下文 = 用户问题
              + 50 页检索资料
              + 20 次工具调用记录
              + 3 次失败重试
              + ...
     -> 窗口被塞满，后续对话质量断崖下跌

   隔离（外包给子智能体）：
     子上下文 = 50 页资料 + 20 次调用（用完即弃）
     主上下文 = 用户问题 + 子智能体回传的一段结论
     -> 主线清爽，能撑很多轮
```

**子智能体本质上是一个"上下文防火墙"。** 这是它最大的工程价值，甚至超过"能力分工"。

### 10.7.4 DeepTutor 的做法

DeepTutor 把子智能体做成了一个**能力（capability）**，见 `deeptutor/capabilities/subagent/capability.py:1` 的模块文档：

```text
Subagent loop capability — consult the user's live local agent as a delegate.
```

以及 `capability.py:32`：

```py
class SubagentCapability(KnowledgeCapability):
    """Turn-scoped integration for a connected local subagent."""
```

注意 "Turn-scoped"（**回合作用域**）——子智能体的接入是按对话回合管理的，一轮结束就清理。

它支持的委托对象在 `deeptutor/services/subagent/` 目录下，从文件名就能看出来：`claude_code.py`、`codex.py`、`gemini.py`、`kimi.py`、`opencode_family.py`、`partner.py`。也就是说，**DeepTutor 可以把任务外包给你本机已经装好的编码智能体**。

还有一个很实际的设计，`capability.py:148`：

```py
def _resolve_budget(context: UnifiedContext) -> int:
    """Consult budget for this turn: a per-turn override from the chat composer
    ...
    """
```

**每轮对话给子智能体一个预算上限。** 不设预算的多智能体系统很容易失控——子智能体自己又调子智能体，无限递归烧钱。

---

## 10.8 生态现状与选型建议

### 10.8.1 MCP 支持情况的现实

MCP 发布时间不长，各家支持程度差异很大。一个值得注意的现象是：**很多主打编码的智能体产品，对 MCP 的支持要么缺失、要么很浅**（只支持 stdio、不支持进度、不做安全校验、工具一多就撑爆上下文）。

DeepTutor 作为教育智能体，反而把 MCP 做得比较完整：

| 能力 | DeepTutor 的实现位置 |
|------|---------------------|
| stdio + SSE + streamable HTTP 三种传输 | `manager.py:749` 的 import 列表 |
| OAuth 认证 | `manager.py:785` 附近 + `services/mcp/oauth.py` |
| SSRF 防护与双档信任 | `services/mcp/network.py:1` |
| 长任务进度上报 | `manager.py:174` 的 `_progress_reporter` |
| 渐进披露防上下文爆炸 | `manager.py:109` 的 `deferred = True` |
| 多租户隔离 | `manager.py:57` 的 `SHARED_OWNER` 与 `(owner, server_name)` 键 |

最后一条也值得一提。`manager.py:56` 的注释：

> Connections are keyed by `(owner, server_name)` so a future per-user server cannot collide with — or be routed into — another tenant's live session.

连接用"（归属者，服务器名）"做键，保证 A 用户的 Server 永远不会被路由到 B 用户的会话里。**这是做多用户产品必须提前想到的事**，事后补极其痛苦。

### 10.8.2 什么时候该用 MCP

| 场景 | 建议 |
|------|------|
| 工具逻辑简单、只在本项目用 | 直接写内置工具，别引入 MCP 的复杂度 |
| 要接入已有的成熟 MCP Server | 用 MCP，别重复造轮子 |
| 工具要给多个项目/团队共用 | 写成 MCP Server |
| 工具需要独立进程隔离（比如可能崩溃） | 用 MCP，进程隔离是免费赠品 |
| 需要让用户自己扩展能力 | 用 MCP，但**必须做好 10.6 节的安全防护** |

### 10.8.3 什么时候该用多智能体

先说反面：**不要一上来就上多智能体。** 它带来的复杂度（状态同步、错误传播、调试困难、成本翻倍）经常超过收益。

判断标准：

- 单智能体的提示词已经超过 200 行且规则互相打架 → 考虑拆分。
- 某类任务会产生大量中间过程污染主上下文 → 考虑外包给子智能体。
- 质量要求极高且预算充足 → 考虑加评审智能体。
- 除此之外 → **老老实实用单智能体 + 好工具**。

---

## 10.9 本章要点回顾

- MCP 解决的是 N×M 适配爆炸问题，标准化后变成 N+M。类比 USB-C。
- MCP 和 Function Calling 是上下游关系：**Function Calling 管"模型怎么表达调用意图"，MCP 管"工具从哪来"**。模型完全感知不到 MCP 的存在。
- DeepTutor 用 `MCPToolAdapter`（`manager.py:106`）让 MCP 工具继承 `BaseTool`，通过 `raw_parameters`（`tool_protocol.py:61`）原样透传上游 schema，执行时走和内置工具完全相同的分发路径。
- 工具名要加 `mcp_<server>_<tool>` 前缀（`manager.py:101`）防重名、防非法字符。
- MCP 工具默认 `deferred = True`（`manager.py:109`），避免几十上百个 schema 撑爆上下文。
- 连接生命周期是最难的部分：每个 Server 一个专属长期任务（`manager.py:14`）、懒启动 + 15 秒超时（`manager.py:53`）、增量重载。
- 所有异常降级成人话文本返回（`manager.py:421` 起），交给模型自行判断，而不是让整轮对话崩掉。
- 用户可配 MCP = 巨大的 SSRF 攻击面。三道防线：双档信任策略（`network.py:5`）、连接时重新校验防 DNS rebinding（`network.py:21`、`manager.py:775`）、禁止重定向与禁止 stdio（`manager.py:764`、`manager.py:783`）。
- 多智能体三种模式：主从、流水线、辩论。主从最常用，核心价值是**上下文隔离**。
- DeepTutor 的 `SubagentCapability`（`capabilities/subagent/capability.py:32`）是回合作用域的，且有预算上限（`capability.py:148`）防失控。

---

## 自查清单

- [ ] 我能解释 N×M 适配问题，以及协议标准化为什么能把它降成 N+M。
- [ ] 我能用一句话说清 MCP 和 Function Calling 的分工，并说明模型是否知道 MCP 的存在。
- [ ] 我能说出 MCP 的三个角色（Host / Client / Server）和三类资源（Tools / Resources / Prompts）。
- [ ] 我能打开 `deeptutor/services/mcp/manager.py:147`，说明它为什么用 `raw_parameters` 而不是 `parameters`。
- [ ] 我能解释 `wrapped_tool_name`（`manager.py:101`）为什么要给工具名加前缀。
- [ ] 我能说出 MCP 工具为什么默认 `deferred = True`（`manager.py:109`）。
- [ ] 我能解释为什么每个 MCP Server 需要一个专属的长期任务（`manager.py:9` 的生命周期说明）。
- [ ] 我能说出 `call_tool`（`manager.py:421`）为什么把所有异常转成字符串返回，而不是往上抛。
- [ ] 我能描述 SSRF 攻击场景，并说出 DeepTutor 的三道防线分别防的是什么。
- [ ] 我能解释什么是 DNS rebinding，以及为什么校验必须在建立连接前重新做一次（`network.py:21`）。
- [ ] 我能画出多智能体的主从模式图，并说明"上下文隔离"为什么是它的核心价值。
- [ ] 我能判断一个具体需求该用内置工具、MCP 还是多智能体，并说出理由。
