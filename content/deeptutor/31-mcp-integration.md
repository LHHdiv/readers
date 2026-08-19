---
title: "第 31 章 · MCP 集成"
date: 2026-08-01
summary: "你可能会问：DeepTutor 自己已经有一大堆工具了（查资料、写笔记、做可视化……），为什么还要\"接入外部工具\"？答案很简单——世界上还有很多现成的服务本来就很好用，比如 Notion、日历、代码仓库。如果每次要用一个新服务都得让工程师改 DeepTutor 的源码，那就太慢了。"
tags:
  - deeptutor
---
# 第 31 章 · MCP 集成

你可能会问：DeepTutor 自己已经有一大堆工具了（查资料、写笔记、做可视化……），为什么还要"接入外部工具"？答案很简单——世界上还有很多现成的服务本来就很好用，比如 Notion、日历、代码仓库。如果每次要用一个新服务都得让工程师改 DeepTutor 的源码，那就太慢了。

于是就有了 **MCP**（Model Context Protocol，模型上下文协议）。你可以把它理解成"给 AI 智能体用的 USB 接口"：只要一个外部服务支持这个协议，DeepTutor 就能在运行时不改一行自身代码，把对方的工具"插"进来直接用。本章就讲 DeepTutor 是怎么实现这套"即插即用"的。

> **说明 · 什么是 MCP（先直觉后原理）**
>
> 直觉：MCP 是一份"约定"。就像两家公司签合同规定"甲方发什么格式的消息、乙方回什么格式的消息"，AI 和第三方服务之间也约定好：你来问我"你有哪些工具"，我就把工具名单报给你；你让我"调用某个工具并传这些参数"，我就执行并把结果还给你。
> 
> 原理：MCP 是一个在"AI 客户端"和"MCP 服务器"之间跑的标准协议。对方的服务（MCP 服务器）会通过 `list_tools` 告诉我们有哪些工具、每个工具要什么参数；我们这边每次调用 `call_tool` 把参数发过去，对方执行完把结果文本返回来。DeepTutor 这边的代码只认这一套协议，不关心对方内部是查数据库还是调别的 API。

## 一、为什么要有专门的 MCP 连接管理器

多数对话是一次性的：用户说话、AI 回答、结束。但 MCP 服务器不一样——它是一条**长连接**：我们得先和它建立连接、握个手，然后这趟连接在好几个回合里都要用。这带来三个麻烦，DeepTutor 用一个叫 `MCPConnectionManager` 的类统一解决：

- **连接要"活"在固定的任务里**：MCP 用的底层库（anyio）要求"开连接"和"关连接"必须在同一个异步任务里。所以每个服务器都配了一个专门的"连接任务"来负责它从生到死的全生命周期。（见 `deeptutor/services/mcp/manager.py:668` 的 `_run_server`）
- **懒启动、断线重连**：第一次聊天时才真正去连（省资源），连不上的服务器会按"退避"节奏过一会儿再试，而不是当场死掉。（见 `deeptutor/services/mcp/manager.py:260` 的 `ensure_started`）
- **多用户互不干扰**：连接不是按"服务器名字"一个全局键，而是按 `(主人, 服务器名)` 两个键。这样 A 用户和 B 用户即便把服务器起了一样的名字，也绝不会误用对方的连接。（见 `deeptutor/services/mcp/manager.py:60` 的 `SHARED_OWNER` 与 `deeptutor/services/mcp/manager.py:233` 的 `MCPConnectionManager`）

下面这张图把"连接生命周期"画出来，注意它是"一个服务器一条专门任务"：

```text
部署启动 / 第一次聊天
        │
        ▼
 ensure_started()  ── 读 mcp.json 配置
        │
        ▼
 对每台服务器开一个 asyncio 任务 _run_server
        │
        ├─ 打开传输层 (stdio / sse / streamableHttp)
        ├─ session.initialize()  握手
        ├─ session.list_tools()  拿工具清单
        ├─ 包装成 MCPToolAdapter 适配器
        ├─ ready.set_result()    标记"已连上"
        ▼
  等待 conn.shutdown 事件
        │
        ▼
  关闭 AsyncExitStack（真正断开）
```

## 二、工具是怎么被"包装"进智能体循环的

这是全章最关键的一点。MCP 服务器那边的工具，名字、参数格式都和我们内部工具不同。DeepTutor 用一个适配器类 `MCPToolAdapter` 把它们"伪装"成普通内部工具，这样智能体的主循环根本分不清一个工具是自家写的还是外来的。

`MCPToolAdapter` 继承自所有内部工具共同的基类 `BaseTool`（`deeptutor/services/mcp/manager.py:106`）。它做两件事：

1. 把外部工具名重命名成 `mcp_<服务器>_<工具>` 这种不会撞名的格式（`deeptutor/services/mcp/manager.py:101` 的 `wrapped_tool_name`）。
2. 实现 `execute` 方法：当智能体决定调用它时，它内部转去调用 `manager.call_tool(...)` 把活儿派给真正的 MCP 服务器（`deeptutor/services/mcp/manager.py:154`）。

注意一个细节：`deferred = True`（`deeptutor/services/mcp/manager.py:109`）。意思是 MCP 工具默认"迟一点"才发给模型——模型先看到核心工具，等需要了再通过 `load_tools` 渐进式拿到 MCP 工具的说明。这样既省 token，又不会让工具清单长得吓人（见 `deeptutor/services/mcp/session_state.py:28` 的 `load_loaded_tools`，它把"本会话已经加载过哪些工具"记在文件里，下次直接带上）。

实际调用路径如下：

```text
智能体循环想用工具
        │
        ▼
 MCPToolAdapter.execute(kwargs)
        │   （工具适配器，伪装成 BaseTool）
        ▼
 MCPConnectionManager.call_tool(owner, server, tool, args)
        │   （deeptutor/services/mcp/manager.py:421）
        ▼
 _call_watching_connection → _call_once
        │   （deeptutor/services/mcp/manager.py:472 / :535）
        ▼
 conn.session.call_tool(...)  ← 真正发到 MCP 服务器
        │
        ▼
 把返回的文本块拼成字符串，交给智能体
```

> **提示 · 对比：Pi 没有 MCP**
>
> DeepTutor 的"姐妹"项目 Pi 是单机本地版，它的工具都是写死在代码里的，没有这套运行时"插接外部服务"的机制。MCP 是 DeepTutor 这类"部署版"才需要的能力——因为部署版面对的是真实世界里五花八门的服务。理解这个区别，你就懂了 MCP 存在的价值：**把"支持新工具"从"改源码"变成"改配置"**。

## 三、网络防护：防止"内网攻击"（SSRF）

外部服务要连，就带来安全问题。假设有人（或某个被攻击的服务器）故意把地址指到公司内网的一个秘密接口（比如云厂商的元数据服务 `169.254.169.254`，里面可能藏着密钥），我们的应用进程去访问它，就等于把机密送出去了。这种攻击叫 **SSRF**（服务端请求伪造）。

DeepTutor 在 `deeptutor/services/mcp/network.py` 里做了两档防护：

- **部署级服务器**（管理员配的 `mcp.json`）只拦最危险的那几段地址：链路本地 / 云元数据（`169.254.0.0/16`）、`0.0.0.0/8`、IPv6 链路本地（`deeptutor/services/mcp/network.py:31`）。因为管理员自己本来就能碰本机，所以放得宽些。
- **用户自建服务器**（普通用户填的 URL）更严：除了上面那些，还额外禁止回环地址（`127.0.0.0/8`）和所有私有网段（`10/8`、`172.16/12`、`192.168/16` 等），见 `deeptutor/services/mcp/network.py:39`。理由很硬：请求是以"应用进程"的身份发出的，而应用进程手里有所有 API 密钥，绝不能让它按用户给的地址往内网打。

关键：这个检查**不仅在保存配置时做，连接时还会再做一次**（`deeptutor/services/mcp/manager.py:780` 调用 `validate_mcp_url_async`）。因为 DNS 记录可能事后被改，光在保存时查一次不够。

```text
用户提交 MCP 服务器 URL
        │
        ▼
 validate_mcp_url(url, strict=True)   ← 用户自建，最严
        │   解析域名得到 IP 列表
        ▼
 逐个 IP 比对黑名单网段
        │
        ├─ 命中任一禁区  →  拒绝连接，返回错误
        └─ 全部通过      →  才允许建立传输层
```

## 四、凭据隔离：密钥绝不明文进配置

一个远端的 MCP 服务器往往需要 API Key 才能用。问题来了：这个 Key 写在哪？

错误做法：直接写进配置文件。因为配置文件会被读取、被接口返回、被写进日志、甚至（对 stdio 服务器）会出现在进程参数里被 `ps` 命令看到——到处泄露。

DeepTutor 的做法是**"引用"而非"值"**（`deeptutor/services/mcp/secrets.py:37`）：配置里只存 `${secret:<服务器>/<字段>}` 这样的占位符，真正的密钥存在另一个只有特定目录才能读的地方，连接的那一刻才临时替换进去（`deeptutor/services/mcp/secrets.py:96` 的 `resolve_references`）。

几个要点：

- 每个用户的密钥存在 `data/system/.../private/mcp/<服务器>.json`，这个目录所在的 `system` 分支**根本不会被代码沙箱挂载**——也就是说，用户 A 的沙箱里跑的代码读不到用户 B 的密钥（`deeptutor/services/mcp/secrets.py:48` 的 `_secrets_dir` 依赖 `owner_secrets_dir`）。
- 如果 URL 本身就把密钥放在查询参数里（如 `?apiKey=${secret:...}`），有专门的 `resolve_url_references` 处理（`deeptutor/services/mcp/secrets.py:131`），因为普通字符串替换不适合嵌在 URL 里。
- 引用解析只在"连接那一瞬间"存在内存里，绝不写回、不记录（`deeptutor/services/mcp/manager.py:719` 的 `_materialize` 注释明确说了"绝不持久化、不记录、不返回接口"）。

> **注意 · 换密钥别忘了指纹**
>
> 每个连接都有一个"连接指纹"（`deeptutor/services/mcp/manager.py:566` 的 `_signature`）。旧实现只基于"存下来的配置"算指纹，而配置里是 `${secret:...}` 引用，所以你**换了真实密钥，指纹却没变**，系统以为"没改过"就不重连——结果一直用着旧钥匙连不上。`_signature` 现在会把"解析后的真实配置"也加进指纹，修掉了这个洞。记住：审计类问题常藏在这种"引用 vs 值"的细节里。

## 五、会话级工具状态（session_state）

前面提到 MCP 工具是 `deferred`（迟发）。那么一个会话里用户第一次加载了某工具，第二次聊天总不该再让他重新加载一遍吧？

`deeptutor/services/mcp/session_state.py` 就管这件事：它把"本会话已加载的工具名"写进会话工作区里的 `loaded_tools.json`（`deeptutor/services/mcp/session_state.py:20`）。下次同会话开聊，直接从文件读出已加载清单带上（`deeptutor/services/mcp/session_state.py:28` 的 `load_loaded_tools`），省一次交互。这个文件按用户目录解析，天然多用户安全（`deeptutor/services/mcp/session_state.py:23`）。

## 六、管理员配置 vs 用户自建：两套存储

值得强调，MCP 服务器配置其实有**两种来源**，但共用同一个 `MCPServerConfig` 形状（`deeptutor/services/mcp/config.py:31`）：

- **部署级**：`settings/mcp.json`，只有管理员能写，所有账号共用同一批服务器（`deeptutor/services/mcp/config.py:120` 的 `load_mcp_config`）。
- **用户级**：`data/system/user-mcp/{owner}.json`，普通用户给自己配，而且有三条硬规矩（`deeptutor/services/mcp/user_config.py:1`）：
  1. 放 `system` 分支下，沙箱读不到；
  2. **只允许远程 URL，禁止 stdio**（stdio 等于在主机上跑任意命令，绝不能交给普通用户）；
  3. 每个用户最多 8 个服务器（`deeptutor/services/mcp/user_config.py:44` 的 `MAX_SERVERS_PER_OWNER`），防止把进程拖垮。

加载用户配置时还会顺手过滤掉非法项，并返回被拒原因，让界面能解释"为什么这个服务器没连上"（`deeptutor/services/mcp/user_config.py:80` 的 `load_user_mcp_config`）。

## 七、连接失败与断线：对用户友好

真实世界网络会抖。DeepTutor 在 `call_tool` 里做了不少"把错误翻译成人话"的工作：

- 传输层抖动（断管、连接重置）会**重试一次**（`deeptutor/services/mcp/manager.py:442`）。
- 底层库喜欢把真正错误包成 "ExceptionGroup: unhandled errors in a TaskGroup" 这种废话，代码专门把它"拆叶子"还原成真实原因（`deeptutor/services/mcp/manager.py:924` 的 `describe_connect_failure`）。
- 返回给模型的错误信息还会**脱敏 URL**（把密钥参数打成 `***`），既能给模型看，又不会泄露令牌（`deeptutor/services/mcp/manager.py:958` 的 `_redact_urls`）。

```text
调用工具途中连接任务挂了？
        │
        ▼
 _call_watching_connection 同时盯着 "调用" 和 "连接任务"
        │
        ├─ 调用先完成  →  正常返回结果
        └─ 连接先死     →  立刻抛 ConnectionLost，
                           而不是傻等超时，再回 "(连不上了)"
```

## 八、内置服务器：PageIndex 的"热插拔"

除了管理员和用户配置的服务器，DeepTutor 还会在加载时**自动叠加**一个内置服务器：`pageindex`（一个托管的文档检索服务）。逻辑在 `deeptutor/services/mcp/pageindex_server.py:40` 的 `with_builtin_servers`：它把 `pageindex` 条目叠到用户可编辑的 MCP 配置上，但**从不会把内置服务器写进 `mcp.json`**（配置里只留用户自己写的），而且"如果用户自己建了一个同名服务器，用户的优先"（`deeptutor/services/mcp/pageindex_server.py:42`）。

另一个细节：PageIndex 的 `remove_document` 工具被**显式拉黑**（`deeptutor/services/mcp/pageindex_server.py:36` 的 `disabled_tools`），因为让智能体删云端的文档，会悄悄让本地知识库清单里的 `doc_id` 变成孤儿。这种"代理别人的 API 时默认堵掉危险操作"的思路，在多用户隔离里反复出现。

## 九、三种传输层形态

一个 MCP 服务器用哪种"连线方式"，由它的 `type` 决定（`deeptutor/services/mcp/config.py:73` 的 `resolved_type` 会自动推断：有 `command` 就是 `stdio`，URL 以 `/sse` 结尾是 `sse`，否则 `streamableHttp`）。`_open_transport`（`deeptutor/services/mcp/manager.py:739`）按类型打开不同通道：

- **stdio**：在本地启动一个子进程，用它的标准输入/输出当通道。这是最强大的方式（能跑任意程序），所以**只给管理员**，用户自建会直接报错（`deeptutor/services/mcp/manager.py:764`）。
- **sse** / **streamableHttp**：走 HTTP，连接远端服务。用户自建服务器走这两种，且要过更严的地址校验（`deeptutor/services/mcp/manager.py:775`）。

```text
_open_transport(cfg)
        │
        ├─ type == "stdio"  →  本地起子进程（仅管理员）
        ├─ type == "sse"    →  sse_client over httpx
        └─ type == "streamableHttp" → streamable_http_client over httpx
                │
                ▼
        若 auth=="oauth" → 现场 build_auth 拿令牌
                │
                ▼
        返回 (read, write) 给 ClientSession
```

## 十、OAuth：当用户自建服务器要"登录授权"

有些托管服务（Notion、Linear 等）不再接受静态 API Key，而要求走 OAuth 2.1 授权码流程。`deeptutor/services/mcp/oauth.py` 就负责这事。它借用 MCP SDK 的 `OAuthClientProvider` 做发现、注册、授权码+PKCE、刷新（`oauth.py:60` 的 `CLIENT_NAME = "DeepTutor"` 是同意屏幕上显示的客户端名）。

关键设计：**谁可以发起授权**。只有用户"点了连接按钮"这种显式动作才能开授权网页；后台自动重连时没人盯着屏幕，所以一旦 SDK 要求跳转，就直接抛 `AuthorizationRequired`（`oauth.py:64`），服务器的状态被标成 `needs_auth`（`deeptutor/services/mcp/manager.py:657`），界面就显示"去连接"按钮而不是无限重试。`_needs_authorization`（`deeptutor/services/mcp/manager.py:980`）就是用来判断这次失败是"等人授权"还是"真坏了"。

## 十一、测试按钮与冷连接回收

**测试连接**：设置界面有个"Test"按钮，背后是 `probe_server`（`deeptutor/services/mcp/manager.py:884`）。它自己开一条连接、列工具、再关掉，**完全不碰正在跑的管理器**——这样测试一个坏配置不会把线上的连接搞乱。而且它用和真实连接**同样的地址策略、重定向规则、凭据**去测（`manager.py:908` 传了 `owner`），避免"测试能过、真连却更宽松"的假象。

**冷连接回收**：一个进程里可能挂了几百个用户各自的 MCP 连接，不能一直占着。`_evict_cold_scopes`（`deeptutor/services/mcp/manager.py:336`）在"来了一个新连接"时才触发清理：超过空闲时间（900 秒，`manager.py:77`）的、或总量超过上限（64 个，`manager.py:76` 的 `_MAX_OWNER_SCOPES`）的最久未用连接会被断开。注意它是"懒清理"而非后台定时器——因为只在有新连接时才需要腾地方，没理由为此养一个一直跑的定时任务。

## 十二、用户级连接的"叠加注册表"

连接数少时，用户的 MCP 工具直接注册到全局工具表就行。但当多个用户都有各自的 MCP 服务器、且可能重名时，全局"后写覆盖"的字典就会打架——A 的工具可能被 B 的连接覆盖/注销。

所以用户级（非 `_shared`）服务器的适配器**故意不进全局注册表**（`deeptutor/services/mcp/manager.py:867` 的 `_register_adapters` 对非共享 owner 直接 return），而是走"作用域叠加注册表"，让同一回合按 owner 取到自己的工具。这和第 35 章"多用户隔离"是同一思路：名字相同，但各自落在各自的地盘，互不踩踏。

## 十三、连接状态的"小机器"

每个 MCP 服务器在管理器里有一个 `_ServerConnection` 状态对象（`deeptutor/services/mcp/manager.py:214`），它的 `status` 字段会在几种状态间流转（`manager.py:222` 注释给出全部取值）：

- `connecting`：正在连。
- `connected`：连上了，工具可用。
- `error`：连失败，等着按退避节奏重连。
- `needs_auth`：不是坏，是"等用户去授权"（OAuth 场景）。
- `disabled`：已断开。

连接失败时的处理在 `_mark_failed`（`deeptutor/services/mcp/manager.py:660`）：它把状态置为 `error`、记下错误、设定下次重试时间 `retry_at`、并把退避时长翻倍（从 30 秒起到最多 300 秒，`manager.py:69` 的 `_RETRY_BACKOFF_START_S` / `_RETRY_BACKOFF_MAX_S`）。这样一台临时不可达的服务器不会"当场死掉一直报错"，而是过一会儿自己再试。

```text
connecting ──成功──► connected
    │
    └──失败──► error ──(退避到期)──► 再 connect
                    │
          若是"等授权" ──► needs_auth (界面显示"去连接"按钮)
```

## 十四、配置长什么样（给你个直观样本）

一个 `MCPServerConfig`（`deeptutor/services/mcp/config.py:31`）在 `mcp.json` 里大概长这样（这是示意，真实字段以 Pydantic 模型为准）：

```json
{
  "servers": {
    "my-notion": {
      "type": "streamableHttp",
      "url": "https://mcp.notion.com/mcp",
      "headers": { "Authorization": "Bearer ${secret:my-notion/token}" },
      "tool_timeout": 60,
      "enabled_tools": ["*"],
      "disabled_tools": [],
      "enabled": true,
      "auth": "oauth"
    }
  }
}
```

注意两点：① `headers` 里写的是 `${secret:my-notion/token}` 引用，不是真值（呼应第四章凭据隔离）；② `tool_timeout` 默认 30 秒、上限 600（`config.py:48`），防止一个工具调用卡死整轮对话。

## 十五、三种传输：一张对比表

前面提过三种传输，这里做成对照，方便你脑子里有数：

| 传输类型 | 连接方式 | 谁能配 | 典型场景 |
| --- | --- | --- | --- |
| `stdio` | 本地起子进程，用其标准输入/输出 | 仅管理员 | 本机工具、本地数据库 |
| `sse` | 服务端推送事件（HTTP 长连） | 管理员/用户 | 远端 MCP 服务 |
| `streamableHttp` | 流式 HTTP（可重定向） | 管理员/用户 | 现代托管 MCP 服务 |

用户自建服务器只许后两种，且要过最严地址校验——`stdio` 直接被 `user_config` 拒绝（`deeptutor/services/mcp/user_config.py:178` 的 `_assert_self_service_allowed`）。

## 十六、把错误翻译成人话的两处巧思

最后提两个"工程洁癖"细节，体现了 DeepTutor 对开发者体验的重视：

- **拆 ExceptionGroup**（`describe_connect_failure`，`manager.py:924`）：MCP 底层库喜欢把真实错误包成 "ExceptionGroup: unhandled errors in a TaskGroup"。这个函数把叶子错误摊平、去重、最多取前 3 条，让用户看到的是 "401 Unauthorized" 而不是一堆废话。
- **脱敏 URL**（`_redact_urls`，`manager.py:958`）：错误消息里常带完整 URL，而 URL 的查询参数或 userinfo 可能藏着密钥。这个函数把主机名/端口/用户名保留、把查询串打成 `***`，既让人知道"连的是哪"又不泄露凭据。它还会在把错误"作为工具结果"返回给模型时也用——因为模型也能看到这条错误。

> **提示 · 读源码的小窍门**
>
> `manager.py` 里几乎每个 `except` 都特意" unwrap "（拆开）底层异常再转成人话。如果你将来要改 MCP 连接逻辑，照这个风格写：不要让原始 SDK 异常直接冒泡到用户或模型面前。这也是为什么这个文件那么长——大量代码在"把失败讲清楚"。

## 十七、reload 与热更新：改配置不用重启

管理员在界面上增删一个 MCP 服务器后，不需要重启整个 DeepTutor。`reload`（`deeptutor/services/mcp/manager.py:276`）会重新读 `mcp.json`，交给 `_sync_to_config`（`manager.py:600`）做"差异比对"：

- **新加的 / 配置变了的服务** → 新建连接。
- **删掉的 / 禁用 / 指纹变了的服务** → 断开旧连接（`manager.py:609`）。

这套"diff 而非全量重建"的逻辑，意味着改一个服务器不会把其它服务器的连接搞断。用户级服务器也有对应入口 `reload_scope`（`manager.py:317`）——用户保存自己的 MCP 配置后立刻生效，不必等空闲回收或重启。这正是 `_signature` 指纹（`manager.py:566`）存在的意义：没有它，系统就分不清"配置到底变没变"。

## 十八、一图总结 MCP 集成

把全章串起来，MCP 在 DeepTutor 里扮演的角色是"外部能力的即插即用层"：

```text
管理员 mcp.json / 用户 user-mcp/{owner}.json
        │  (config.py / user_config.py 加载)
        ▼
 MCPConnectionManager (每进程一个, manager.py:233)
        │  ensure_started → 每个服务器一条连接任务
        ▼
 _open_transport (stdio/sse/streamableHttp, manager.py:739)
        │  + 严格地址校验 network.py + 凭据引用解析 secrets.py
        ▼
 list_tools → 包装成 MCPToolAdapter (deferred, manager.py:106)
        │  → 注册进全局/作用域工具表
        ▼
 智能体循环调用 adapter.execute → manager.call_tool → 真实服务器
        │
        ▼
 结果回传；状态为 connected/error/needs_auth (manager.py:222)
```

记住一句话：**MCP 让"支持新工具"从"改 DeepTutor 源码"降级为"改一份配置 + 过两道安全校验"**。Pi 没有这层，因为它的世界里没有"外部服务即插即用"的需求。

> **说明 · 学完这章你该建立的直觉**
>
> 看到 `mcp_` 开头的工具名，就知道它是外来的；看到 `needs_auth` 状态，就知道用户在等授权；看到连接数上限，就知道这是多用户部署的性能护栏。这些直觉，会让你在后面读任何"工具调用"日志时都能立刻定位它从哪来。

## 十九、常见误区

- 误区：MCP 工具是 DeepTutor 自己写的。正解：它是**外部服务**提供的，DeepTutor 只是按协议去调，工具逻辑在对方服务器上。
- 误区：配了 `mcp.json` 就得重启。正解：`reload`（`manager.py:276`）能热更新，diff 比对只动变化的服务器。
- 误区：用户自建 MCP 和管理的没区别。正解：用户级**禁止 stdio、只允许远程 URL、每用户最多 8 个**，且凭据走沙箱读不到的目录。
- 误区：连接断了就永远报错。正解：失败的连接会按 30s→300s 退避自动重连（`manager.py:69`），不是当场死掉。
- 误区：MCP 地址校验只在保存时做。正解：连接时还会再查一次 DNS（`manager.py:780`），防地址事后被改。

> **提示 · 这章和后面几章的关系**
>
> MCP 是"给内核加外挂工具"的通道，Partners（第 32 章）是"给内核换入口"的通道，两者都汇入同一个对话引擎。理解了 MCP 的"适配器 + 安全校验"套路，后面看 Partners 的"通道 + 总线"会觉得似曾相识——它们都是"把外部东西安全接进内核"的同一类设计。

## 黑话小词典

| 黑话 | 人话解释 |
| --- | --- |
| MCP | 模型上下文协议，给 AI 接外部工具的"USB 接口" |
| 传输层 transport | 客户端和服务器之间实际"连线"的方式（stdio/sse/streamableHttp） |
| 适配器 adapter | 把外部工具"伪装"成内部工具，让内核一视同仁的包装类 |
| deferred 工具 | 默认晚一点才发给模型、按需渐进披露的工具 |
| SSRF | 服务端请求伪造，攻击者骗服务器去访问内网/机密地址 |
| 连接指纹 signature | 配置的一串"哈希指纹"，用来判断"配置到底改没改" |
| 凭据引用 reference | 配置里只存 `${secret:...}` 占位符，真密钥运行时才替换 |

## 自查清单

- [ ] 我能用"USB 接口"的比喻向别人解释 MCP 是干什么的
- [ ] 我知道 `MCPConnectionManager` 为什么给每个服务器开一条专门的异步任务（`manager.py:668`）
- [ ] 我理解 `MCPToolAdapter` 如何把外部工具伪装成内部 `BaseTool`（`manager.py:106`）
- [ ] 我能说出 MCP 工具是 `deferred` 的，以及 `session_state.py` 怎么避免重复加载
- [ ] 我讲得出 SSRF 是什么，以及用户自建 URL 为什么比管理员配置查得更严（`network.py:39`）
- [ ] 我明白为什么配置里只存 `${secret:...}` 引用而不是真密钥（`secrets.py:37`）
- [ ] 我知道用户自建服务器为什么禁止 stdio、且每用户最多 8 个（`user_config.py:44`）
- [ ] 我能对比说明：Pi 没有 MCP，而 DeepTutor 部署版需要它来"即插即用"
