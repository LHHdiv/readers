---
title: "第 32 章 · Partners：IM 伴侣机器人（内置 16 通道）"
date: 2026-08-01
summary: "想过这样一种场景吗：你不用打开 DeepTutor 网页，直接在微信里问它一道题，它就回你一段讲解？这就是 **Partners（伴侣机器人）** 要做的事。"
tags:
  - deeptutor
---
# 第 32 章 · Partners：IM 伴侣机器人（内置 16 通道）

想过这样一种场景吗：你不用打开 DeepTutor 网页，直接在微信里问它一道题，它就回你一段讲解？这就是 **Partners（伴侣机器人）** 要做的事。

Partners 是"挂在你常用聊天软件里的辅导机器人"。它和你平时在网页里用的那个 DeepTutor 其实是**同一个智能体内核**，只是入口换成了微信、Telegram、Discord 这些聊天软件。每个 Partner 可以有自己的性格（SOUL）、模型、记忆和工作区，但背后跑的仍然是同一套 `ChatOrchestrator` 对话循环。本章讲清楚：Partner 是什么、它和前身 TutorBot 的关系、支持哪些通道、以及消息是怎么"进进出出"的。

> **说明 · Partner 不是另一个引擎**
>
> 先直觉：把 Partner 想成"同一个老师，换了个办公室上课"。你微信里问问题，消息被转发进 DeepTutor 的对话内核，内核算完把答案转回微信。
> 
> 原理：仓库里没有"Partner 专用引擎"。`deeptutor/partners/__init__.py:1` 的注释写得很直白——Partner 层只负责"通道（IM 接入）+ 消息总线 + 配置"，而真正的对话能力复用 chat 那套 `ChatOrchestrator` → `AgenticChatPipeline`。所以"在微信里聊天"和"在网页里聊天"走的几乎是同一段代码，区别只在消息从哪来、回哪去。

## 一、前身：TutorBot

Partners 不是凭空出现的。在 2026 年 6 月的 v1.4.3 版本之前，它叫 **TutorBot**（见根目录 `README.md:102` 的发布记录："TutorBot becomes Partners on a production-grade IM pipeline"）。那次升级把原来的玩具级 IM 接入换成了"生产级"的通道管线，支持实时流式输出，并把对话统一到单个智能体循环上。

代码里至今还留着 TutorBot 的痕迹：启动时有一句把旧版 `tutorbot` 记忆目录改名为 `partner` 的迁移（`deeptutor/api/main.py:166` 调用 `migrate_partner_surface_if_needed`）。看到旧名字别奇怪，那就是它的前身。

## 二、支持哪些通道（核实数量）

任务里提到"19 通道"，但源码里**实际内置的通道模块是 16 个**。这不是我拍脑袋，而是按注册机制数出来的：通道不是手写在某个列表里的，而是 `registry.py` 自动扫描 `deeptutor/partners/channels/` 目录发现的（`deeptutor/partners/channels/registry.py:17` 的 `discover_channel_names` 会排除 `base`/`manager`/`registry` 三个非通道文件）。

当前 `deeptutor/partners/channels/` 下逐个文件确认，可插的通道模块有这些（按字母序）：

| 通道模块 | 对应平台 | 通道模块 | 对应平台 |
| --- | --- | --- | --- |
| `telegram` | Telegram | `discord` | Discord |
| `slack` | Slack | `msteams` | Microsoft Teams |
| `whatsapp` | WhatsApp | `matrix` | Matrix |
| `feishu` | 飞书 | `weixin` | 微信 |
| `wecom` | 企业微信 | `dingtalk` | 钉钉 |
| `mattermost` | Mattermost | `zulip` | Zulip |
| `email` | 邮件 | `qq` | QQ |
| `mochat` | MoChat | `napcat` | NapCat（QQ 机器人） |

加上 README 在 v1.4.3 当时记录的"15 通道"，经过几次迭代现在源码里是 **16 个内置通道模块**。另外 `registry.py` 还支持从外部插件（entry_points）加载更多通道（`deeptutor/partners/channels/registry.py:40` 的 `discover_plugins`），所以一个部署实际能用的通道数可以超过内置数量——"19"可能就是把某些插件/别名也算进去得到的数字，但**已核实的内置通道模块是 16 个**。

> **提示 · 为什么用"自动扫描"而不是"写死列表"**
>
> 如果通道名是手写在某个大列表里，每加一个平台就得改核心代码、还可能漏改。改成"扫描目录"后，新增一个通道只需丢一个 `xxx.py` 文件进去、里面写一个继承 `BaseChannel` 的类，`discover_all` 就会自动把它收进来（`deeptutor/partners/channels/registry.py:54`）。这就是"开闭原则"——对扩展开放、对修改关闭。

## 三、消息总线：把"通道"和"大脑"解耦

如果让每个聊天软件都直接去调对话内核，代码会乱成一锅粥。DeepTutor 用一个**消息总线（Message Bus）** 把两边隔开：

- 左边：各个通道收到用户消息，把它打包成 `InboundMessage` 丢进总线的"入站队列"。
- 右边：一个统一的派发循环从"出站队列"取消息，按通道发回给用户。

`InboundMessage` 和 `OutboundMessage` 这两个数据结构定义在 `deeptutor/partners/bus/events.py:8` 和 `deeptutor/partners/bus/events.py:27`。总线本身是 `deeptutor/partners/bus/queue.py:8` 的 `MessageBus`，它只有两个队列：`inbound` 和 `outbound`，外加几个入队/出队的异步方法。

```text
用户在某 IM 里发消息
        │
        ▼
 通道 (telegram/weixin/...)
 解析成 InboundMessage
        │
        ▼
 bus.publish_inbound()  ──►  inbound 队列
        │                         │
        │                  对话内核消费
        │                  (ChatOrchestrator 同一循环)
        │                         │
        │                  算出回复，封装成 OutboundMessage
        ▼                         ▼
                  outbound 队列 ◄── bus.publish_outbound()
        │
        ▼
 ChannelManager 派发循环
 按 msg.channel 找到对应通道
        │
        ▼
 通道.send() 把回复发回用户
```

关键点：通道和内核**互不直接认识**。通道只管"收发"，内核只管"思考"，中间靠总线传话。这样新增一个 IM 平台，内核一行都不用改。

## 四、ChannelManager：通道的"大管家"

`deeptutor/partners/channels/manager.py:31` 的 `ChannelManager` 负责把所有通道管起来：

1. **初始化时扫描并启用通道**（`deeptutor/partners/channels/manager.py:57` 的 `_init_channels`）：它调 `discover_all()` 拿到所有通道类，再对照配置里哪些被 `enabled: true`，只把启用且能正常实例化的通道拉起来；同时还会校验 `allow_from`（白名单），如果某人配成空列表等于"谁都不让发"，会直接报错退出（`deeptutor/partners/channels/manager.py:108`）。
2. **出站派发循环**（`deeptutor/partners/channels/manager.py:187` 的 `_dispatch_outbound`）：这是消息回家的最后一棒。它从 outbound 队列取消息，找到对应通道，调用发送。
3. **流式合并**：AI 回复往往是"一个字一个字蹦出来"的。`_dispatch_outbound` 会把同一 (通道, 聊天) 的连续增量（`_stream_delta`）合并成一段再发，减少对 IM 接口的频繁调用（`deeptutor/partners/channels/manager.py:249` 的 `_coalesce_stream_deltas`）。
4. **去重与重试**：完全相同的回复不会重复发（基于指纹，`deeptutor/partners/channels/manager.py:160`）；发送失败按 1s、2s、4s 指数退避重试（`deeptutor/partners/channels/manager.py:23` / `:296`）。

```text
ChannelManager._dispatch_outbound (无限循环)
        │
        ├─ 取出一条 outbound 消息
        ├─ 找对应通道实例
        ├─ 是流式增量? → 合并相邻增量(同 stream_id)
        ├─ 是重复回复? → 丢弃
        └─ _send_with_retry: 失败就 1s/2s/4s 退避重试
                │
                ▼
           通道.send() / send_delta()
```

## 五、通道里的那些"小工具"

`deeptutor/partners/helpers.py` 是一堆通道共用的小工具函数，挑几个有意思的：

- `detect_image_mime`（`deeptutor/partners/helpers.py:8`）：不看文件后缀，而是看文件开头的"魔数"（比如 PNG 文件头是那串 `\x89PNG`），判断图片真实类型——防止有人改个 `.png` 后缀塞恶意文件。
- `split_message`（`deeptutor/partners/helpers.py:42`）：Discord 等平台单条消息有长度上限（默认 2000 字），这个函数会把长文按换行/空格切分，避免发送失败。
- `convert_markdown_table_to_labeled_rows`（`deeptutor/partners/helpers.py:100`）：把 Markdown 表格转成"**列名**: 值"的纯文本行，因为很多 IM 不渲染表格。

语音也不缺席：`deeptutor/partners/transcription.py:10` 的 `GroqTranscriptionProvider` 用 Groq 的 Whisper 接口把用户发来的语音转成文字（`transcribe` 方法在 `deeptutor/partners/transcription.py:21`），再走正常对话流程。

## 六、另一条防线：通道媒体的 SSRF 防护

和 MCP 类似，IM 通道也会遇到"恶意链接"问题——比如有人发来一个指向内网的图片 URL，应用去下载时可能踩到内部服务。

`deeptutor/partners/network.py` 的 `validate_url_target`（`deeptutor/partners/network.py:59`）比 MCP 那版**更严**：因为它面对的是外部 IM 平台带来的不可信 URL，所以连回环地址和私有网段全部禁止（黑名单见 `deeptutor/partners/network.py:17`，包含 `10/8`、`127/8`、`169.254/16`、`192.168/16` 等）。一句话：通道要下载的任何 URL，都必须落在公网。

> **注意 · 别把 MCP 和 Partners 的 network 搞混**
>
> 两套网络防护都叫"防 SSRF"，但**松紧相反**：MCP 的 `network.py` 对管理员服务器放得宽（允许局域网），因为管理员本来就能碰主机；Partners 的 `network.py` 一律从严，因为链接来自外部、不可信。读源码时注意是 `deeptutor/services/mcp/network.py` 还是 `deeptutor/partners/network.py`，二者策略不同。

## 七、一个 Partner 长什么样

回到开头那句"每个 Partner 有自己的性格和工作区"。根目录 `README.md:510` 给了精确定义：Partner 是"一个有灵魂、有模型策略、有资料库、有记忆、有通道的持久伴侣"，而它的工作区就建在 `data/partners/{id}/workspace/` 下，知识库/技能/笔记会被复制进去，因此同样的 RAG、技能、记忆工具无需特判就能用。它还"读主人的记忆，但只写自己的记忆"——这正是多用户隔离在 Partner 上的体现（详见第 35 章）。

## 八、一个 IM 消息的完整生命周期

把前面几节串起来，一条消息从用户敲键盘到收到回复，全过程是：

```text
① 用户在微信/Telegram 发一句 "帮我讲讲牛顿第二定律"
        │
        ▼
② 对应通道实例收到平台推送，解析成 InboundMessage
   （含 channel / sender_id / chat_id / content）
        │
        ▼
③ bus.publish_inbound() → inbound 队列
        │
        ▼
④ 对话内核消费：ChatOrchestrator 跑同一套循环
   调 LLM、可能调用工具、生成回复片段
        │
        ▼
⑤ 内核把每个片段封装成 OutboundMessage → outbound 队列
        │
        ▼
⑥ ChannelManager._dispatch_outbound 取出消息
   合并流式增量、去重、必要时重试
        │
        ▼
⑦ 按 msg.channel 找到通道实例，调 channel.send() 发回用户
```

注意第 ④ 步：内核**完全不知道**消息来自网页还是微信。它只拿到一段文字、产出一段文字。这正是"通道与内核解耦"带来的好处——内核永远只写一次。

## 九、通道配置的旋钮

每个通道在配置文件里是一段 JSON，`ChannelManager._init_channels`（`deeptutor/partners/channels/manager.py:57`）会把它读进来。两个值得说的开关：

- `allow_from`：白名单，只允许名单里的用户 id 发消息进来。如果配成空列表 `[]`，等于"谁都拒"，代码会直接 `SystemExit` 报错退出（`deeptutor/partners/channels/manager.py:108` 的 `_validate_allow_from`），逼你显式写 `["*"]`（所有人）或具体 id。这样能防止"配错成空"导致机器人对谁都不理。
- `send_progress` / `send_tool_hints`：是否把"思考进度""用了什么工具"这类提示发到 IM。IM 平台和网页不一样，有些不适合刷太多中间状态。`_resolve_bool_override`（`deeptutor/partners/channels/manager.py:90`）负责从配置读这两个开关，并兼容 `sendProgress` 这种驼峰写法（因为有人手写原始 JSON）。

## 十、自动发现的完整链路

再深入一点 `registry.py` 的发现机制（`deeptutor/partners/channels/registry.py`）：

- `discover_channel_names`（`registry.py:17`）用 `pkgutil.iter_modules` 扫描 `channels` 包里所有**非内部**模块（排除 `base`/`manager`/`registry`），返回名字列表——所以加通道=加文件，零改动。
- `load_channel_class`（`registry.py:28`）import 该模块，找出里面第一个 `BaseChannel` 的子类当成通道实现。
- `discover_all`（`registry.py:54`）把"内置扫描"和"外部插件"合并。外部插件通过 Python 的 `entry_points` 注册（`registry.py:40` 的 `discover_plugins`），但**内置优先**——同名时外部插件被忽略并告警（`registry.py:81`），防止外部覆盖核心通道。
- 若某内置通道因缺依赖 import 失败，不会让整个启动崩，而是记进 `errors` 字典、跳过它（`registry.py:73` 的 `discover_all_with_errors`），让"为什么 X 通道没出现"可诊断。

> **提示 · 想加一个新 IM 平台？**
>
> 照着现有 `telegram.py` 写一个 `mychat.py`：继承 `BaseChannel`，实现 `start`/`stop`/`send`/`send_delta`，在配置里把它的 `enabled` 设为 `true`。重启后 `discover_channel_names` 会自动把它收进来，内核完全不用动。这就是"插件式架构"的威力。

## 十一、语音输入：听不懂文字怎么办

不是所有 IM 都只发文字——用户可能发语音。DeepTutor 用 Groq 的 Whisper 接口把语音转文字（`deeptutor/partners/transcription.py:10` 的 `GroqTranscriptionProvider`）。`transcribe`（`deeptutor/partners/transcription.py:21`）读音频文件、用 `whisper-large-v3` 模型、返回文字；若没配 Groq Key 或音频文件缺失，就安稳返回空串而非报错（`deeptutor/partners/transcription.py:31` / `:36`）。转出来的文字再走正常对话流程——对内核来说，和打字没区别。

## 十二、Partners 的"灵魂"在哪

回到 README 的定义（`README.md:510`）：Partner 是"有灵魂、有模型策略、有资料库、有记忆、有通道"的持久伴侣，本质上"是一个有性格、有电话号码的聊天"。它和网页版智能体共享同一套 `ChatOrchestrator`，区别在于每个 Partner 有独立的 `SOUL.md`、模型选择、通道、工具策略、指派知识库。知识库/技能/笔记被复制到 `data/partners/{id}/workspace/`（`README.md:516`），于是同一套 RAG、技能、记忆工具无需特判就能用；但 Partner "读主人的记忆、只写自己的记忆"——这条边界正是多用户隔离在 Partner 上的投影（详见第 35 章）。

```text
管理员配置一个 Partner:
   SOUL.md (性格) + 模型 + 通道(telegram等) + 知识库
        │
        ▼
  工作区建在 data/partners/{id}/workspace/
        │
        ▼
   IM 消息 → 总线 → ChatOrchestrator(同一内核)
        │
        ▼
  回复经通道发回；记忆只写自己那份
```

## 十三、InboundMessage 长啥样

通道收到一条消息后，会构造一个 `InboundMessage`（`deeptutor/partners/bus/events.py:8`）。它长这样（示意）：

```json
{
  "channel": "telegram",
  "sender_id": "123456",
  "chat_id": "777",
  "content": "帮我讲讲牛顿第二定律",
  "timestamp": "2026-08-13T10:00:00",
  "media": [],
  "metadata": {},
  "session_key_override": null
}
```

注意 `session_key` 这个属性（`events.py:21`）：默认是 `"{channel}:{chat_id}"`，意思是"同一个聊天窗口的连续消息算同一段会话"。也允许 `session_key_override` 覆盖——比如thread 里按线程号分会话。这决定了"机器人记得你上一句说了啥"的粒度。

## 十四、通道能力的差异

虽然所有通道都走同一条总线，但不同 IM 平台能力不同，代码要分别适配。几个典型差异：

| 能力 | 有些平台支持 | 处理办法 |
| --- | --- | --- |
| 长消息 | Discord 限 2000 字 | `split_message` 切分（`helpers.py:42`） |
| 流式编辑 | Slack/Telegram 支持"原地改消息" | `send_delta` 增量更新 |
| 富媒体 | 微信/Telegram 能发图 | `detect_image_mime` 校验（`helpers.py:8`） |
| 表格 | 多数 IM 不渲染 Markdown 表 | `convert_markdown_table_to_labeled_rows`（`helpers.py:100`） |

所以"通道抽象"不是"所有平台一模一样"，而是"内核只说普通话，通道负责把普通话翻译成各自平台的方言"。`ChannelManager` 的 `_coalesce_stream_deltas`（`manager.py:249`）就是在处理"内核一顿一顿发增量、通道要合并成一次编辑"的方言差异。

## 十五、旧版 TutorBot 记忆的迁移

前面说的 `migrate_partner_surface_if_needed`（`deeptutor/api/main.py:168`）不是凭空来的。v1 时代 Partner 还叫 TutorBot，记忆目录叫 `tutorbot`。升级到 Partners 后，启动时会把这个旧目录改名成 `partner`，包括脚注引用、L2 文档、快照/追踪目录、L3 元数据的 key（`main.py:166` 注释）。这类"无痛迁移"代码在很多地方都有（比如 `identity.py` 的 `_migrate_legacy_users`，`deeptutor/multi_user/identity.py:88`，把旧 `data/user/auth_users.json` 迁到新 `system/auth/users.json`），保证老用户升级后不丢数据。

## 十六、Partner 工作区内部

一个 Partner 的工作区建在 `data/partners/{id}/workspace/`（`README.md:516`）。里面复制进来的有：知识库、技能、笔记。于是同样的 RAG 检索、技能调用、笔记读写、记忆工具，在 Partner 作用域下"开箱即用"，无需任何特判分支。这也是为什么 README 说 Partner 是"一个有性格和电话号码的聊天"——它复用了网页版的**全部**能力，只是入口和身份换了。

```text
data/partners/{id}/workspace/
   ├─ knowledge_bases/   指派/复制进来的知识库
   ├─ skills/            可用技能
   ├─ notebooks/         笔记
   └─ memory/            自己的记忆（只读主人记忆，只写这里）
```

> **提示 · 一句话记住 Partners 的本质**
>
> "同一个 `ChatOrchestrator`，换了个入口、换了份 `SOUL.md`、落在 `data/partners/{id}/` 自己的地盘。" 其余一切（工具、RAG、记忆、隔离）都和网页版共用同一套代码。理解这一点，Partners 就不再神秘。

## 十七、ChannelManager 的发送重试细节

出站派发里还有一个"指数退避重试"（`_send_with_retry`，`deeptutor/partners/channels/manager.py:296`）：一次发送失败，会按 1s、2s、4s 重试（最多 `send_max_retries` 次，默认 3，`manager.py:301`）。`CancelledError` 会原样重抛以便优雅关闭，其它异常才重试。

还有"重复抑制"（`_should_suppress_outbound`，`manager.py:160`）：同样的回复内容，如果是对**同一条源消息**的回复，只发一次，避免 IM 里刷出两条一模一样的话。注意它**按 `origin_message_id` 限定范围**——不同回合的相同内容仍然会发，否则会误吞正常消息（`manager.py:173`）。

## 十八、一图总结 Partners

把全章串成一张图，Partners 的本质是"通道 + 总线 + 同一个内核"：

```text
        IM 平台们 (Telegram/微信/Discord/...)
             │  (各自通道实例, channels/)
             ▼
        bus.publish_inbound ──► inbound 队列
             │
             ▼
    ChannelManager (channels/manager.py:31)
     启用通道 / 校验白名单 / 派发出站
             │
             ▼
   ChatOrchestrator (与网页版同一个对话内核)
     读 SOUL / 调工具 / 生成回复
             │
             ▼
        bus.publish_outbound ──► outbound 队列
             │
             ▼
    ChannelManager._dispatch_outbound
     合并流式增量 / 去重 / 重试
             │
             ▼
        各通道 send() 回用户
```

一句话：**Partners = 挂在你 IM 里的、有自己性格和工作区的 DeepTutor 分身**。它复用全部能力，只换了入口和身份。前身 TutorBot 在 v1.4.3 升级为现在的 production-grade 管线（`README.md:102`）。

> **说明 · 学完这章你该建立的直觉**
>
> 任何一个 IM 机器人，在 DeepTutor 眼里都只是"一个消息源 + 一个消息汇"。加平台 = 加通道文件；加用户 = 加授权（见第 35 章）；加能力 = 改内核一次、各处复用。这种"分而治之"的架构，是它能撑起十几个通道还不乱的根本原因。

## 十九、常见误区

- 误区：Partners 是另一套智能体引擎。正解：它复用同一个 `ChatOrchestrator`，只是入口和身份不同（`partners/__init__.py:1`）。
- 误区：内置通道是 19 个。正解：当前源码 `channels/` 下自动发现的是 **16 个**内置通道模块，README 在 v1.4.3 记为 15 个；总数还可能因外部插件变化。
- 误区：加通道要改核心代码。正解：`discover_channel_names`（`registry.py:17`）自动扫描，加文件即生效。
- 误区：通道直接调对话内核。正解：中间隔着消息总线（`bus/queue.py:8`），通道只管收发，内核只管思考。
- 误区：流式回复直接一条条发。正解：`_coalesce_stream_deltas`（`manager.py:249`）会合并增量，减少 IM 接口调用。

> **说明 · 通道数量为什么你看到的文档不一致**
>
> README 在 v1.4.3 记为"15 通道"，而当前源码 `channels/` 下自动发现的是 16 个内置模块。差异来自持续的迭代新增（如 `napcat`、`mochat` 较新加入），再加上 `registry.py` 还能加载外部插件。所以"通道数"不是写死的数字，而是"内置 16 + 可插外部插件"的动态集合。读文档时以你手上的源码为准。

> **提示 · 怎么确认你部署里到底有几个通道**
>
> 别数文档，直接数代码：`ls deeptutor/partners/channels/`，排除 `base.py`/`manager.py`/`registry.py`/`__init__.py`，剩下的每个文件就是一个通道模块。当前是 16 个。若你装了外部插件，`discover_plugins`（`registry.py:40`）还会多加载一些——所以"总数"以 `discover_all` 的实际返回为准，这正是"自动发现"优于"写死列表"的体现。

## 黑话小词典

| 黑话 | 人话解释 |
| --- | --- |
| Partner | 挂在你 IM 里的辅导机器人，复用同一内核、有独立性格 |
| TutorBot | Partner 的前身名字，v1.4.3 升级后改名 |
| 通道 channel | 一种 IM 平台接入（Telegram/微信/Discord 等） |
| 消息总线 bus | 把"通道"和"大脑"隔开的异步消息队列 |
| 入站/出站 inbound/outbound | 用户发来的消息 / 发回用户的消息 |
| 流式增量 stream_delta | AI 回复"一个字一个字蹦"的小片段 |
| 白名单 allow_from | 只允许名单里的用户给机器人发消息 |

## 自查清单

- [ ] 我能用一句话说清 Partner 是什么，以及它和网页版 DeepTutor 的关系
- [ ] 我知道 Partners 前身叫 TutorBot，并在 v1.4.3 升级（`README.md:102`）
- [ ] 我核实过：内置通道模块是 16 个，由 `registry.py` 自动扫描发现（`channels/registry.py:17`）
- [ ] 我讲得出"消息总线"为什么要把通道和内核解耦（`bus/queue.py:8`）
- [ ] 我知道 `ChannelManager` 负责启用通道、派发出站消息、合并流式增量（`channels/manager.py:31`）
- [ ] 我理解流式回复为什么要在 `_dispatch_outbound` 里合并（`channels/manager.py:249`）
- [ ] 我知道通道媒体 URL 为何要更严的 SSRF 校验（`partners/network.py:59`）
- [ ] 我能说出 Partner 工作区在 `data/partners/{id}/workspace/` 且"只读主人记忆、只写自己记忆"
