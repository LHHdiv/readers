---
title: "第 24 章 · LLM 服务层"
date: 2026-08-01
summary: "**黑话先定义**"
tags:
  - deeptutor
---
# 第 24 章 · LLM 服务层

前面几章讲了回合、工具、能力，但有个最底层的角色一直没交代：**真正和"大模型厂商"对话的那一层**。DeepTutor 不直接把请求甩给 OpenAI 或 Anthropic，而是包了一整层"LLM 服务层"。它的任务有四块：(1) 把"用哪个厂商、哪个模型"的选择封装好；(2) 统一不同厂商的 SDK 差异；(3) 把内部消息格式转成各厂商要的格式；(4) 做限流和上下文窗口管理，别把请求发爆、别把超出长度的内容塞给模型。本章逐一拆开。

> **黑话先定义**
> - *LLM*：大语言模型，就是"大模型"本身，如 GPT、Claude、Gemini。
> - *provider 厂商*：提供模型服务的公司/服务，如 OpenAI、Anthropic、本地 Ollama。
> - *SDK*：别人写好的"调用工具包"，装了它就能用几行代码调模型，不用手搓 HTTP 请求。
> - *限流 traffic control*：控制"同时最多发几个请求、每分钟最多发几个"，防止打爆自己或厂商。
> - *上下文窗口 context window*：模型一次能"看到"的最大文字量（按 token 算）。
> - *令牌桶 token bucket*：一种限流算法，令牌按固定速率生成、请求前先领一个。

## 一句话直觉

LLM 服务层像个"翻译 + 调度中心"。上面（能力、回合）只说"用默认模型帮我生成一段文字"；这一层负责：查清楚该走哪个厂商的 SDK、把内部消息翻译成厂商要的格式、排队限流别挤爆、盯着上下文窗口别超长——最后把厂商的回复原路送回去。它让上层完全不用关心"底下到底是哪家模型"。

## 工厂入口：complete 与 stream

对上层来说，最常用的两个函数就是 `complete`（一次性拿全部回复）和 `stream`（一个字一个字地流式返回）。它们都在 `deeptutor/services/llm/factory.py`，分别定义在 `deeptutor/services/llm/factory.py:337` 和 `deeptutor/services/llm/factory.py:401`。

两者结构高度一致，以 `stream` 为例（`deeptutor/services/llm/factory.py:401`）流程是：

1. 取走一些特殊参数（图片、额外请求头、推理强度等）。
2. `_resolve_call_config`（`deeptutor/services/llm/factory.py:427`）算出用哪个 `LLMConfig` 和厂商规格。
3. `get_runtime_provider(config)`（`deeptutor/services/llm/factory.py:436`，即 `deeptutor/services/llm/factory.py:366`）拿到真正干活的对象。
4. `_build_messages`（拼消息）、`_apply_inline_image_data`（贴图片）做好请求体。
5. 用令牌桶算好重试间隔 `_build_retry_delays`（`deeptutor/services/llm/factory.py:62`，在 `deeptutor/services/llm/factory.py:447` 调用）。
6. 开一个 `asyncio.Queue` 边收边推，把模型的字一个个 yield 出去（`deeptutor/services/llm/factory.py:452` 起的队列逻辑）。

```text
上层调用 stream(...)
   │
   ├─ _resolve_call_config        决定 config + 厂商   deeptutor/services/llm/factory.py:427
   ├─ get_runtime_provider        拿 provider 对象      deeptutor/services/llm/factory.py:436
   ├─ _build_messages             组装对话消息           deeptutor/services/llm/factory.py:438
   ├─ _sanitize_call_kwargs       清洗厂商特有参数       deeptutor/services/llm/factory.py:448
   └─ provider.chat_stream(...)  真正发请求 + 流式回传
```

`complete` 路径在 `deeptutor/services/llm/factory.py:383` 调 `provider.chat_with_retry(...)`，拿到完整回复后返回 `response.content`（`deeptutor/services/llm/factory.py:398`）。出错时还会用 `map_error` 把厂商错误翻译成统一错误（`deeptutor/services/llm/factory.py:392`）。

> 流式还有一些细节：`STREAM_CONTROL_TOKENS`（`<think>`/`</think>`，`deeptutor/services/llm/factory.py:32`）和 `DEFAULT_STREAM_COALESCE_CHARS`（`deeptutor/services/llm/factory.py:30`）控制"攒多少个字再推一次"，避免每个字都触发一次前端刷新。`_on_reasoning_delta`（`deeptutor/services/llm/factory.py:457`）专门处理"思考过程"的流式片段，会在开头插入 `<think>` 标记。

## Provider 池与工厂

`get_runtime_provider` 是连接"配置"和"具体 SDK 客户端"的枢纽，定义在 `deeptutor/services/llm/provider_factory.py:110`。它有两个关键设计：

**1. 进程内小池子**：provider 对象内部持有 SDK 的 HTTP 连接池，如果每发一个 token 都新建销毁，内存会疯涨、也用不上长连接。所以代码用 `_provider_pool`（`deeptutor/services/llm/provider_factory.py:18`，一个 `OrderedDict`）做缓存，上限 `_PROVIDER_POOL_MAXSIZE = 2`（`deeptutor/services/llm/provider_factory.py:17`）。缓存键 `_provider_cache_key`（`deeptutor/services/llm/provider_factory.py:28`）把"循环 + 厂商 + 模型 + key 指纹 + url + 温度…"全拼进去，确保配置不同就建不同客户端；超容量时把最老的踢掉并异步关闭（`deeptutor/services/llm/provider_factory.py:133`）。

**2. 按后端挑 SDK**：`_build_runtime_provider`（`deeptutor/services/llm/provider_factory.py:45`）根据厂商的 `backend` 字段，导入并构造对应 SDK 客户端：

```text
provider_factory._build_runtime_provider        deeptutor/services/llm/provider_factory.py:45
   │
   ├─ backend == "openai_codex"    -> OpenAICodexProvider   deeptutor/services/llm/provider_factory.py:51
   ├─ backend == "github_copilot"  -> GitHubCopilotProvider deeptutor/services/llm/provider_factory.py:57
   ├─ backend == "azure_openai"    -> AzureOpenAIProvider   deeptutor/services/llm/provider_factory.py:63
   ├─ backend == "anthropic"       -> AnthropicProvider     deeptutor/services/llm/provider_factory.py:72
   └─ 其他（默认）                 -> OpenAICompatProvider  deeptutor/services/llm/provider_factory.py:82
```

> **提示 · 为什么叫 "openai_compat"（OpenAI 兼容）？**
>
> 因为绝大多数厂商的 API 长得和 OpenAI 一模一样，DeepTutor 把"不是上面几种特殊后端"的全部归到 `OpenAICompatProvider`（`deeptutor/services/llm/provider_factory.py:83`）。这也是为什么外部接入新模型通常零成本——只要它兼容 OpenAI 格式即可。

## 厂商规格解析：provider_registry

"该用哪个厂商"不是拍脑袋，而是查一张厂商规格表。`deeptutor/services/provider_registry.py` 提供查询函数：

- `find_by_name(name)`（`deeptutor/services/provider_registry.py:485`）：按名字找厂商规格（含它的 `backend`、`supports_prompt_caching` 等元数据）。
- `find_by_model(model)`（`deeptutor/services/provider_registry.py:495`）：按模型名反查它属于哪个厂商。
- `find_gateway(...)`（`deeptutor/services/provider_registry.py:515`）：判断是否要走"网关"路径（如 OpenAI 的网关转发）。

工厂里的 `_resolve_provider_spec`（`deeptutor/services/llm/factory.py:77`）综合这几路信息决定最终 `backend`：显式 binding 优先，否则按模型名推断，再否则看是不是本地 LLM 服务（`deeptutor/services/llm/factory.py:102` 的 `is_local_llm_server`，如带 `11434` 端口就归 ollama/vllm）。这让"用户只填了个模型名"也能自动选对厂商。

## SDK 适配：基类 + 各家实现 + 两套实现路线

provider 的抽象基类是 `LLMProvider`，在 `deeptutor/services/llm/provider_core/base.py:71`。它定义了 `chat`（一次性，`base.py:225`）、`chat_stream`（流式）、以及带重试的 `chat_with_retry`（`base.py:359`）和 `chat_stream_with_retry`（`base.py:408`）。重试前它会把 `max_tokens`、`temperature`、`reasoning_effort` 统一规整（`base.py:379` 起），再交给 `_call_with_retry` 真正循环重试。

各家差异藏在 `deeptutor/services/llm/provider_core/` 下：

- `openai_compat_provider.py`：兼容 OpenAI 格式的最通用实现（862 行，最大）。
- `anthropic_provider.py`：Anthropic（Claude）专用，处理它独特的消息结构。
- `azure_openai_provider.py` / `openai_codex_provider.py` / `github_copilot_provider.py`：各自云服务的特化版本。

> 另外还有一套"直连 HTTP"的备选实现：`cloud_provider.py`（含 `_openai_complete` 在 `deeptutor/services/llm/cloud_provider.py:281`、`_anthropic_complete` 在 `deeptutor/services/llm/cloud_provider.py:652`）和 `local_provider.py`（含 `complete` 在 `deeptutor/services/llm/local_provider.py:68`、`stream` 在 `deeptutor/services/llm/local_provider.py:151`）。它们用 `requests`/`aiohttp` 直接发请求，是早期/备选路线；现代的 `provider_core/` 系列则是基于各厂商官方 SDK 的封装。两条路线并存，由工厂按配置选择。

## 消息格式转换

不同厂商要的"消息长相"不完全一样（比如系统提示放哪、图片怎么附）。这一层在工厂里集中处理：

- `_build_messages`（`deeptutor/services/llm/factory.py:262`）：把 `prompt` / `system_prompt` / `messages` 拼成统一消息列表。
- `_apply_inline_image_data`（`deeptutor/services/llm/factory.py:289`）：把图片塞进消息体，且会按厂商能力调整——`deeptutor/services/llm/factory.py:388` 用 `supports_vision(capability_binding, model)` 判断该厂商/模型是否支持看图；不支持时 `allow_image_fallback` 会在重试时撤掉图片（`deeptutor/services/llm/factory.py:388` 注释的"Stage-2 图片兜底"）。

这种"内部统一格式 → 各厂商格式"的转换，保证了上层只管产出标准消息，适配差异全压在服务层。

> **说明 · 多模态图片是怎么预处理上的？**
>
> `prepare_multimodal_messages`（`deeptutor/services/llm/multimodal.py:122`）负责把图片数据规整成各厂商认可的"图像内容块"。它和 `_apply_inline_image_data` 配合，让"带图提问"在不同模型间也能正确工作。

## 能力探测：capabilities 模块

不同模型能力不同：有的支持"结构化输出（response_format）"，有的支持"看图（vision）"。`deeptutor/services/llm/capabilities.py` 集中做这类探测：

- `supports_response_format(binding, model)`（`deeptutor/services/llm/capabilities.py:413`）：该模型能否返回 JSON 等结构化格式。
- `supports_vision(binding, model)`（`deeptutor/services/llm/capabilities.py:495`）：该模型是否支持图像输入。
- `supports_vision_url(binding, model)`（`deeptutor/services/llm/capabilities.py:510`）：是否支持直接传图片 URL（而非 base64）。

上游调用（如 `deeptutor/services/llm/factory.py:388`）据此决定是否给模型硬塞图片或结构化要求，避免不支持的模型直接报错。

## Prompt 管理

"发给模型的提示词"也不是散落各处的字符串，而是有集中管理。`deeptutor/services/prompt/` 目录（`__init__.py`、`language.py`、`manager.py`）提供提示词的管理能力：`language.py` 处理多语言、`manager.py` 负责加载与组织提示词模板。能力模块在构造请求时，从这套管理器取对应语言、对应场景的提示词，而不是在代码里硬编码中文/英文文案。这让"换一种语气""加一种语言"变成配置动作，而非改代码。

> **说明 · 为什么提示词要单独管理？**
>
> DeepTutor 面向多语言能力（界面可切语言），且同一能力在不同阶段要说不同的话。把提示词抽成可管理的资源，既避免重复，也方便非程序员（如教研）调整措辞而不碰 Python。

## 限流：TrafficController

模型厂商对"每秒/每分钟请求数"有限制，本地机器也扛不住无限并发。限流器 `TrafficController` 在 `deeptutor/services/llm/traffic_control.py:13`，用两道闸门保护：

1. **并发闸门（信号量）**：`_semaphore = asyncio.Semaphore(max_concurrency)`（`deeptutor/services/llm/traffic_control.py:43`），默认最多 20 个同时进行的请求；拿不到就等，等超过 `acquisition_timeout`（默认 30 秒）就报错（`deeptutor/services/llm/traffic_control.py:88`）。
2. **速率闸门（令牌桶）**：`_wait_for_token`（`deeptutor/services/llm/traffic_control.py:51`）按 `requests_per_minute` 算"每秒补几个令牌"，请求前先领一个令牌；领不到就按需要等待（`deeptutor/services/llm/traffic_control.py:69`）。

它用异步上下文管理器 `__aenter__` / `__aexit__`（`deeptutor/services/llm/traffic_control.py:78` / `:114`）包裹一次调用：进入时领并发槽 + 令牌，退出时释放并发槽。这样"同时最多 N 个、每分钟最多 M 个"两条规则都被强制。

```text
with TrafficController(...) as gate:   进入：抢并发槽 + 领速率令牌
        │                                     deeptutor/services/llm/traffic_control.py:78
        └─ provider.chat_with_retry(...)
                                             退出：释放并发槽
                                                  deeptutor/services/llm/traffic_control.py:114
```

## 上下文窗口：context_window

模型一次能看多长有限度。上下文窗口管理在 `deeptutor/services/llm/context_window.py`，核心是 `resolve_effective_context_window`（`deeptutor/services/llm/context_window.py:53`）：

- 没显式配置时，用 `default_context_window_for_model`（`deeptutor/services/llm/context_window.py:41`）兜底。
- 兜底逻辑先看是不是"大模型家族"：`looks_like_large_context_model`（`deeptutor/services/llm/context_window.py:35`）按名字里有没有 `gpt-4.1`、`claude`、`gemini`、`qwen`、`deepseek` 等标记（`deeptutor/services/llm/context_window.py:10`）判断，是的话给 `LARGE_CONTEXT_MODEL_DEFAULT = 65_536`（`deeptutor/services/llm/context_window.py:9`）。
- 普通模型则返回 `DEFAULT_CONTEXT_WINDOW_FALLBACK = 16_384`（`deeptutor/services/llm/context_window.py:7`）或"输出上限×4"中的较大者。
- 无论怎么算，最终都封顶在 `MAX_EFFECTIVE_CONTEXT_WINDOW = 1_000_000`（`deeptutor/services/llm/context_window.py:8`），防止配置离谱。

这个值会被历史裁剪、提示组装等环节用来"该截取多长"，避免把超长历史塞给模型导致报错或烧钱。

## 错误翻译与 Agentic 客户端

当厂商返回错误时，`map_error`（`deeptutor/services/llm/error_mapping.py:74`）把它翻译成统一的 `LLMError` 体系，让上层用一套错误处理所有厂商。这样"OpenAI 的 429"和"Anthropic 的限速"在上层看起来是同一类问题。

除了服务层的 provider，还有一个面向"智能体内部直接调用"的 OpenAI 兼容客户端构造器，在 `deeptutor/core/agentic/client.py`。`build_openai_client`（`deeptutor/core/agentic/client.py:127`）对外暴露，底层 `_build_openai_client`（`deeptutor/core/agentic/client.py:83`）真正按配置建客户端，同样带进程内池化（`_client_cache_key` 在 `deeptutor/core/agentic/client.py:64`）。它供那些需要"亲手拼 OpenAI 风格调用"的流水线（如某些能力的自主循环）使用，与服务层 provider 是互补的两套通道。

> **提示 · 服务层 provider 和 agentic client 用哪套？**
>
> 简单说：绝大多数"生成一段文字/流式回复"走服务层 `factory.complete/stream` → provider；少数需要精细控制 OpenAI 客户端行为的内部流水线，直接用 `core/agentic/client.py:127` 的 `build_openai_client`。读者理解"有两套、都池化、都封装厂商差异"即可。

## 重试机制：退避与兜底

调用大模型不是百发百中——网络抖动、厂商限流、瞬时 5xx 都会失败。服务层内置重试：`_build_retry_delays`（`deeptutor/services/llm/factory.py:62`）按 `max_retries` 和是否指数退避算出每次等待时长（`deeptutor/services/llm/factory.py:72` 的 `base * 2**attempt`，并封顶 120 秒）。默认值来自全局设置：`DEFAULT_MAX_RETRIES`（`deeptutor/services/llm/factory.py:27`）、`DEFAULT_RETRY_DELAY`（`deeptutor/services/llm/factory.py:28`）、`DEFAULT_EXPONENTIAL_BACKOFF`（`deeptutor/services/llm/factory.py:29`）。重试逻辑在 provider 基类的 `_call_with_retry`（经 `chat_with_retry` 在 `base.py:359` 调用），只在"瞬时可重试"的错误上重试；对"不支持看图"这类结构性问题，则用"Stage-2 图片兜底"（`deeptutor/services/llm/factory.py:388`）改为去掉图片再试一次，而不是无脑重发。

```text
factory.stream -> provider.chat_stream_with_retry
                        │
                        └─ _call_with_retry:
                             失败且可重试？
                               是 -> 等 _build_retry_delays 算出的间隔 -> 再试
                               否 -> 抛错，由 map_error 翻译
```

## 两套实现路线：云服务 vs 本地服务

`provider_core/` 是基于各厂商**官方 SDK** 的现代实现。此外还有一套用 `requests`/`aiohttp` **直连 HTTP** 的备选实现，分两个文件：

- `cloud_provider.py`：面向云端厂商，含 `_openai_complete`（`deeptutor/services/llm/cloud_provider.py:281`）、`_anthropic_complete`（`deeptutor/services/llm/cloud_provider.py:652`）、`_cohere_complete`（`deeptutor/services/llm/cloud_provider.py:815`）等，以及顶层的 `complete`/`stream`（`deeptutor/services/llm/cloud_provider.py:149` / `:220`）。
- `local_provider.py`：面向本地模型服务（如 Ollama/vLLM），`complete` 在 `deeptutor/services/llm/local_provider.py:68`、`stream` 在 `deeptutor/services/llm/local_provider.py:151`、`fetch_models` 在 `deeptutor/services/llm/local_provider.py:321`，它还从负载里抽消息文本（`deeptutor/services/llm/local_provider.py:33` 的 `_extract_message_from_payload`）。

两条路线并存，工厂按配置选其一。现代默认走 `provider_core`（SDK 更稳、特性更全），老路线作为兼容/特殊场景保留。

## 辅助模块的角色

LLM 服务层还有一些"小零件"支撑主流程：

- `reasoning_params.py`：处理"推理强度（reasoning_effort）"这类厂商特有参数，让上层统一设置、底层按厂商格式落位。
- `registry.py` / `provider_registry.py`：前者是更上层的 provider 注册（`registry.py`），后者是厂商规格查询（`deeptutor/services/provider_registry.py:485` 起）。`provider_factory._resolve_provider_spec`（`deeptutor/services/llm/factory.py:77`）综合两者定 `backend`。
- `request_compat.py`：做请求结构的兼容性转换，抹平不同 SDK 版本间的差异。
- `telemetry.py`：埋点统计（调用次数、耗时等），用于观测而非功能。

> **说明 · 为什么有这么多小文件？**
>
> 因为"调模型"看似一行，实际要处理：选厂商、选 SDK、拼消息、限流、重试、错误处理、能力探测、上下文裁剪、遥测。每个关注点拆成独立模块，既好维护，也方便单独测试。这正是"单一职责"的工程实践。

## 本地模型 vs 云模型

识别"这是不是本地模型"决定走哪条路。`factory._resolve_provider_spec`（`deeptutor/services/llm/factory.py:102`）用 `is_local_llm_server(base_url)` 判断：若 base_url 里含 `11434`（Ollama 默认端口），就归 `ollama`/`vllm`（`deeptutor/services/llm/factory.py:103`）；否则看有没有显式 binding 或按模型名反查。本地模型通常走 `openai_compat` 后端（因为 Ollama/vLLM 都兼容 OpenAI 格式），但隔离在用户自己的机器上，无需云端密钥。这保证了"自己跑开源模型"和"用云厂商 API"在代码里是同一套抽象。

## 小结

LLM 服务层是 DeepTutor 与模型厂商之间的"翻译 + 调度中心"。`factory.complete`（`deeptutor/services/llm/factory.py:337`）和 `stream`（`deeptutor/services/llm/factory.py:401`）是上层入口；`get_runtime_provider`（`deeptutor/services/llm/provider_factory.py:110`）用进程内小池（`deeptutor/services/llm/provider_factory.py:17`）复用 SDK 客户端，并按 `backend` 挑具体实现（`deeptutor/services/llm/provider_factory.py:45`）；厂商选择靠 `provider_registry`（`deeptutor/services/provider_registry.py:485`）解析。厂商差异由 `provider_core/` 下的基类（`base.py:71`）与各家类吸收（另有 `cloud_provider.py`/`local_provider.py` 直连 HTTP 备选）；消息格式在工厂内统一转换（`deeptutor/services/llm/factory.py:262` / `:289`）；能力探测在 `deeptutor/services/llm/capabilities.py:495`；限流靠 `TrafficController`（`deeptutor/services/llm/traffic_control.py:13`）的双闸门；上下文窗口靠 `deeptutor/services/llm/context_window.py:53` 的封顶计算；提示词集中在 `services/prompt/` 管理；重试由 `_build_retry_delays`（`deeptutor/services/llm/factory.py:62`）控制；错误由 `deeptutor/services/llm/error_mapping.py:74` 统一翻译。

## 配置怎么来：LLMConfig 与 _resolve_call_config

上层调用 `complete`/`stream` 时通常不关心"具体配置"，但底层必须有个明确的 `LLMConfig`。`_resolve_call_config`（`deeptutor/services/llm/factory.py:153`）就是做这件"把零散参数拼成一份完整配置"的事：它接受 `model`/`api_key`/`base_url`/`api_version`/`binding` 等，结合全局 `get_llm_config()`（`deeptutor/services/llm/factory.py:141`）判断"这些参数是否就是当前活跃配置"（`_matching_current_config`，`deeptutor/services/llm/factory.py:125`）——如果是，就沿用当前配置里那些"只存在于 profile"的设置（如 `extra_headers`、`reasoning_effort`），避免被显式参数覆盖掉。`LLMConfig` 本身是 `config.py` 里的数据类，承载模型名、密钥、base_url、温度、token 上限等一切运行所需。

```text
上层: stream(prompt, model="gpt-4o", api_key=...)
        │
        ▼
_resolve_call_config            deeptutor/services/llm/factory.py:153
   ├─ 参数等于当前活跃配置？ -> 沿用 profile 专属设置
   └─ 否则 -> 用传入参数构造新 LLMConfig
        │
        ▼
get_runtime_provider(config) -> 选 SDK 客户端
```

## stream 的合并与 <think> 处理

流式返回不是"每个字都立刻推"，而是会做**合并**以省开销：`DEFAULT_STREAM_COALESCE_CHARS = 64`（`deeptutor/services/llm/factory.py:30`）和 `DEFAULT_STREAM_COALESCE_SECONDS = 0.04`（`deeptutor/services/llm/factory.py:31`）控制"攒够 64 字或等 0.04 秒再推一次"（`deeptutor/services/llm/factory.py:420` 起用 `_coerce_stream_coalesce_chars`/`_coerce_stream_coalesce_seconds` 规整）。同时，模型常输出 `<think>...</think>` 的"内心独白"，工厂用一个状态机处理：遇到推理片段时，先发一个 `<think>` 标记再发内容（`deeptutor/services/llm/factory.py:457` 的 `_on_reasoning_delta`），让前端能把"思考过程"和"正式回答"区分展示。这些细节都在 `stream` 的队列与 flush 逻辑里（`deeptutor/services/llm/factory.py:452` 起）。

## openai_http_client 与本地 OpenAI 兼容客户端

除了 `provider_core` 的各家 SDK，还有一个更"裸"的 HTTP 客户端 `openai_http_client.py`，它用 `httpx` 直接打 OpenAI 风格接口，供需要精细控制请求的场景。`core/agentic/client.py` 的 `build_openai_client`（`deeptutor/core/agentic/client.py:127`）会按 `LLMClientConfig` 用 `_build_openai_client`（`deeptutor/core/agentic/client.py:83`）构造并池化这类客户端。它和服务层 provider 是"两套通道"：provider 走封装好的 `chat_with_retry`，而 agentic client 让流水线能直接拼 OpenAI 风格的调用（如某些能力的自主循环）。两者都做进程内池化，避免重复建连。

## 厂商能力探测的实际用途

前面提过 `supports_vision`（`deeptutor/services/llm/capabilities.py:495`）等探测函数，它们不只是"炫技"，而是直接改变行为：

- 不支持 vision 的模型，工厂在重试时会撤掉图片（`deeptutor/services/llm/factory.py:388` 的 `allow_image_fallback=False`），避免每次都因图片报错。
- 不支持 `response_format` 的模型（`deeptutor/services/llm/capabilities.py:413`），流水线就不会要求它返回 JSON，而是改用提示词约束。
- 只支持"传图 URL"不支持"直接传 base64"的模型（`deeptutor/services/llm/capabilities.py:510`），`prepare_multimodal_messages`（`deeptutor/services/llm/multimodal.py:122`）会相应调整图片附着方式。

正是这些探测，让"换一个模型"往往无需改任何流水线代码——差异被服务层自动吸收。

> **提示 · 把"差异"压到最底层**
>
> LLM 服务层的核心设计哲学是：**上层只说意图（生成、流式、带图），底层负责把意图翻译成各厂商能接受的格式与参数**。能力、回合、工具都因此与"具体用哪家模型"解耦。这也是为什么 DeepTutor 能轻松接入新模型——只要它兼容 OpenAI 格式，或加一个 `provider_core` 后端即可。

## 自查清单

- [ ] 我知道 `complete`（`deeptutor/services/llm/factory.py:337`）和 `stream`（`deeptutor/services/llm/factory.py:401`）是上层调用模型的两个入口。
- [ ] 我理解 `get_runtime_provider`（`deeptutor/services/llm/provider_factory.py:110`）用进程内小池复用 SDK 客户端，池上限是 2（`deeptutor/services/llm/provider_factory.py:17`）。
- [ ] 我知道"兼容 OpenAI 格式"的厂商默认走 `OpenAICompatProvider`（`deeptutor/services/llm/provider_factory.py:82`）。
- [ ] 我明白 provider 抽象基类 `LLMProvider` 在 `deeptutor/services/llm/provider_core/base.py:71`，重试入口是 `chat_with_retry`（`base.py:359`）。
- [ ] 我知道消息格式转换集中在 `_build_messages`（`deeptutor/services/llm/factory.py:262`）和 `_apply_inline_image_data`（`deeptutor/services/llm/factory.py:289`）。
- [ ] 我理解 `supports_vision`（`deeptutor/services/llm/capabilities.py:495`）决定模型是否支持看图，影响图片兜底逻辑。
- [ ] 我理解 `TrafficController`（`deeptutor/services/llm/traffic_control.py:13`）用"信号量 + 令牌桶"两道闸门做限流。
- [ ] 我知道上下文窗口上限计算在 `deeptutor/services/llm/context_window.py:53`，封顶 1,000,000（`deeptutor/services/llm/context_window.py:8`）。
- [ ] 我能说出提示词集中在 `deeptutor/services/prompt/` 管理，且区分两套实现路线（provider_core vs cloud/local_provider）。
- [ ] 我知道错误会被 `map_error`（`deeptutor/services/llm/error_mapping.py:74`）翻译成统一 `LLMError`。
