---
title: "第 44 章 · 排错手册与性能调优"
date: 2026-08-01
summary: "学写工具和能力的路上，你一定会撞墙：明明代码照抄了，可 agent 不出答案、报一堆红字、或者转圈永远停不下来。这一章把最常见的六个坑逐一拆开，告诉你**去哪看、怎么查、改哪行**。所有代码位置都来自真源码。"
tags:
  - deeptutor
---
# 第 44 章 · 排错手册与性能调优

学写工具和能力的路上，你一定会撞墙：明明代码照抄了，可 agent 不出答案、报一堆红字、或者转圈永远停不下来。这一章把最常见的六个坑逐一拆开，告诉你**去哪看、怎么查、改哪行**。所有代码位置都来自真源码。

## 第一原则：先看日志，别瞎猜

DeepTutor 的日志系统集中在 `deeptutor/logging/`。日志目录由 `get_default_log_dir()`（`deeptutor/logging/config.py:19`）决定——它最终指向 `path_service.get_logs_dir()`（`deeptutor/services/path_service.py:383`）。日志级别由 `get_global_log_level()`（`deeptutor/logging/config.py:48`）读取，配置来自 `data/user/settings/main.yaml` 的 `logging` 段（`load_logging_config` 在 `deeptutor/logging/config.py:25`）。

```bash
# 1) 找到日志目录
python -c "from deeptutor.logging.config import get_default_log_dir; print(get_default_log_dir())"

# 2) 实时跟踪最新日志（macOS / Linux）
tail -f "$(python -c 'from deeptutor.logging.config import get_default_log_dir; print(get_default_log_dir())')"/*.log
```

想看到更多细节，把级别调成 `DEBUG`：编辑 `main.yaml` 的 `logging.level: DEBUG`，或临时设环境变量。**出问题先翻日志，80% 的坑日志里已经写了原因。**

> **提示 · 日志是"现场录像"**
>
> 循环每调一次模型、每分发一次工具、每注入一段记忆，都会在日志留痕。当你觉得"agent 好像没用我的工具"，先去日志搜你的工具名——如果有，说明被调用了；如果没有，说明根本没进注册表（见坑 2 / 坑 6）。

## 常见坑 1：WebSocket 连不上（前端转圈、请求进不来）

**现象**：网页/客户端一直连不上，或发消息后没有任何响应。

**原理**：前端通过 WebSocket 把"开始一轮对话"的请求发给后端，后端入口是 `facade.start_turn`（`deeptutor/app/facade.py:114`），它再交给 `turn_runtime.start_turn`（`deeptutor/services/session/turn_runtime.py:682`）真正起回合。WS 没连上，请求根本到不了这两层。

**排查**：

```bash
# 确认后端确实在监听（默认本地端口）
curl -s http://localhost:8000/healthz || echo "后端没起来"

# 看日志里有没有 serve / uvicorn 启动成功的字样
# 若报端口被占用，换端口或杀掉占用进程
```

- 后端没启动 → 先按项目 README 把 serve 跑起来；
- 端口不对 → 前端配置的后端地址要和 serve 端口一致；
- 跨域被拦 → 检查 serve 的 CORS / 代理设置。

## 常见坑 2：Provider 或 API Key 配错（模型不回复 / 401）

**现象**：日志里出现 401、403、或 "model not found"。

**原理**：`provider_runtime.py` 维护各 LLM 提供商的规格。`LLM_LOCALHOST_PROVIDERS`（`deept/provider_runtime.py:55`，实为 `deeptutor/services/config/provider_runtime.py:55`）列出本地型提供商（ollama、vllm），其余走云端 API Key。配错 Key 或选了不存在的模型，调用直接失败。

**排查清单**：

```text
□ API Key 是否设置（环境变量或 Settings 页面）？
□ provider 名称是否与内置清单一致（openai / gemini / ollama ...）？
□ 本地模型（ollama/vllm）是否真的在跑、端口对不对？
□ 模型名是否拼写正确（如 gpt-4o-mini 不是 gpt-4o）？
```

`EMBEDDING_PROVIDERS`（`deeptutor/services/config/provider_runtime.py:83`）也定义了一组默认 embedding 端点——如果你只配了聊天模型却忘了 embedding，检索类功能会单独报错（见坑 3）。

## 常见坑 3：Embedding 端点不通（检索报错 / 索引建不起来）

**现象**：上传知识库后检索为空，或日志报 embedding 请求 400/404。

**原理**：Embedding 端点要求**精确的路径**。校验逻辑在 `embedding_endpoint_validation_error`（`deeptutor/services/config/embedding_endpoint.py:239`）：比如 OpenAI 系必须结尾是 `/embeddings`，Gemini 必须结尾 `/embeddings` 或 `/models/{model}:batchEmbedContents`。显示与保存用的规范化在 `normalize_embedding_endpoint_for_display`（`deeptutor/services/config/embedding_endpoint.py:185`）。

**排查**：

```bash
# 直接 curl 你的 embedding 端点，看是否返回向量
curl -s https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","model":"text-embedding-3-small"}'
```

- 报 401 → Key 错；
- 报 404 → 路径不对，对照 `EMBEDDING_PROVIDER_DEFAULT_ENDPOINTS`（`embedding_endpoint.py:111`）改；
- 日志里看到 `[REDACTED]` → 这是 `redact_embedding_endpoint_for_display`（`embedding_endpoint.py:20`）在隐藏密钥，属正常，别以为端点坏了。

> **注意 · 结尾少一个 /embeddings 是最常见的 embedding 坑**
>
> 很多同学把 base_url 填成 `https://api.openai.com/v1`，但 embedding 端点要 `https://api.openai.com/v1/embeddings`。校验函数（`embedding_endpoint.py:257`）会直接在界面报错拦截，照着提示补上路径即可。

## 常见坑 4：循环不终止（一直转圈 / 烧 token）

**现象**：agent 跑了几十轮还不 FINISH，或最终被强制结束。

**原理**：标签驱动循环有"迭代预算"。演示版在 `label_loop_demo.py:92` 用 `max_iter` 限制；真源码在 `run_agentic_loop` 里 `max_iter = max(1, max_iterations)`（`deeptutor/core/agentic/loop.py:217`）兜底。如果模型一直输出 `THINK` 不 FINISH，就会耗尽预算被强制收尾。

**排查**：

```text
□ 你的提示词有没有明确要求"最后用 FINISH 收尾"？
□ 模型是不是陷入重复思考（日志里看 THINK 内容是否雷同）？
□ 是否工具调用失败导致它一直重试？（看工具报错）
□ max_iterations 是否设得过小导致正常流程被截断？
```

修复方向：在 system prompt 里强调终止标签；检查工具是否抛异常让循环反复重试；必要时调大 `max_iterations`（通过能力配置传给 `run_agentic_loop`）。

## 常见坑 5：记忆未注入（agent 不记得前文 / 学生画像）

**现象**：agent 像失忆，每次都从头问，或读不到学生的错题库。

**原理**：记忆通过 `UnifiedContext`（`deeptutor/core/capability_protocol.py:16`）在回合开始时注入。能力 `run(context, stream)` 拿到的就是这个 context。如果记忆没出现，通常是：**能力没从 context 取记忆字段**，或**记忆服务/知识库没挂上**。

**排查**：

```text
□ 你的能力 run() 里有没有读 context 的记忆 / 画像字段？
□ 记忆相关的工具（如 read_memory）是否在 ToolRegistry 里可用？
□ 日志里搜 "memory" / "L1" / "L2" 看注入痕迹
□ 是否忘了挂载知识库，导致 context 里本就没有可注入内容？
```

## 常见坑 6：检索为空（RAG 永远回"没找到"）

**现象**：调了 `rag`，但 `ToolResult.content` 是空或"未检索到"。

**原理**：内置 `RAGTool`（`deeptutor/tools/builtin/__init__.py:95`）强制要求 `kb_name` 非空，否则直接抛 `ValueError`。而且它只检索"本回合挂载的知识库"。常见原因：知识库没挂、名字拼错、或切块/索引没建好。

**排查**：

```bash
# 用 kb_files 工具列出已挂载知识库的文件，确认它真的有内容
# 日志里搜你的 kb_name，看是否被解析到（resolve_kb_manifest）
```

- `rag` 报 "requires an explicit kb_name" → 调用时补上 `kb_name`；
- 知识库有文件但检索空 → 回到坑 3 查 embedding 索引是否建好；
- 名字对不上 → `kb_name` 必须与界面挂载时显示的名字完全一致。

> **说明 · 工具名大小写 / 拼写错 = 永远查不到**
>
> `ToolRegistry.get`（`deeptutor/runtime/registry/tool_registry.py:74`）按名字精确匹配，`execute`（`deeptutor/runtime/registry/tool_registry.py:128`）也是。模型偶尔拼错工具名（如 `RAG` 写成 `rag_search`），这时靠 `TOOL_ALIASES` 兼容（`deeptutor/tools/builtin/__init__.py` 里有 `rag_search → rag` 的映射）。自己的工具也可以加别名。

## 性能调优四则

| 方向 | 做法 | 对应代码 |
| --- | --- | --- |
| 减少循环轮数 | 提示词明确要求早 FINISH，避免空转 | loop.py:217 迭代预算 |
| 缩小上下文 | 开启上下文窗口裁剪 `guard_context_window` | loop.py:86 host 钩子 |
| 并行检索 | 多个 rag 调用并行而非串行 | RAGTool 注释提到 in parallel |
| 降日志噪音 | 生产环境把 level 调回 INFO | logging/config.py:48 |

## 排错心法：先按"症状"定位（决策树）

别一报错就全量搜索。先用下面这棵"症状树"把范围缩到一两个坑，再去看对应小节：

```text
agent 完全没反应 / 一直转圈
   ├─ 前端连不上           → 坑 1（WS / serve 没起，facade.py:114）
   └─ 后端起了但卡住       → 坑 4（循环不终止，loop.py:217）

agent 回了话，但内容不对
   ├─ 报 401/403/模型找不到 → 坑 2（Provider/Key，provider_runtime.py:55）
   ├─ 说"没找到/检索为空"   → 坑 6（RAG/kb_name，builtin/__init__.py:95）
   └─ 像失忆、不记得前文     → 坑 5（记忆未注入，capability_protocol.py:16）

agent 建库/上传时报错
   └─ 400/404 类            → 坑 3（embedding 端点，embedding_endpoint.py:239）

性能差 / token 烧得快
   └─ 见下方"性能调优四则"与实例
```

## 读懂一段真实日志（示例）

假设你遇到"检索为空"，日志里可能长这样（示意）：

```text
INFO  tool.dispatch  调用 rag(kb_name='math', query='导数')
DEBUG tool.rag        resolve_kb_manifest('math') -> None
ERROR tool.rag        Knowledge base 'math' is not accessible.
```

读日志三步走：**看级别**（ERROR 才是真错）、**看哪个模块**（这里是 `tool.rag`）、**看关键值**（`'math'` 解析成 `None`，说明名字对不上或没挂载）。对应坑 6：把 `kb_name` 改成界面挂载时显示的真实名字即可。

> **提示 · 把日志级别调到 DEBUG 再复现一次**
>
> 很多"偶发"问题在 INFO 下看不出原因。复现前先 `logging.level: DEBUG`（`logging/config.py:48`），复现完再调回 INFO，避免日志爆炸。

## 配置类问题：main.yaml 关键字段

DeepTutor 的运行时配置大多来自 `data/user/settings/main.yaml`，由 `load_logging_config`（`deeptutor/logging/config.py:25`）等加载。最容易配错的两块：

```text
main.yaml 关键字段
   ├─ logging.level           日志级别（DEBUG/INFO），logging/config.py:48
   ├─ llm.*                   聊天模型 provider / api_key / base_url
   ├─ embedding.*             向量模型 provider / 端点（结尾要 /embeddings）
   └─ knowledge_bases.*       各知识库路径与索引配置
```

改完配置**重启 serve** 才生效（配置是进程启动时读的）。改了半天没反应，先怀疑"忘了重启"。

## 检索类问题深挖（坑 6 延伸）

检索为空不止 `kb_name` 一种原因，按下面顺序查：

1. 知识库挂载了没有？（界面能看到文件列表吗？）
2. 文件真的被切块索引了吗？（空索引 = 永远检索空）
3. embedding 端点通吗？（回到坑 3，curl 验证，见 `embedding_endpoint.py:185` 的规范化）
4. `kb_name` 拼对了吗？（大小写、下划线都要一致，`tool_registry.py:74` 精确匹配）
5. 检索结果被过滤了吗？（看看是不是 score 阈值太严）

## 性能调优实例

"性能调优四则"那张表说方向，这里给两个可操作的例子：

**例子 A：循环空转烧 token。** 日志里看到连续 5+ 次 `THINK` 内容雷同。修法：在 system prompt 加"若已无新信息，请直接 FINISH"，并把 `max_iterations`（`loop.py:217`）从 12 调到 8。

**例子 B：每轮都带全量工具，模型分心。** 把不常用的工具设 `deferred=True`（`tool_protocol.py:232`），或用 `CONFIGURABLE_BUILTIN_TOOL_NAMES`（`builtin/__init__.py:1647`）做上下文闸门，只在挂了知识库时才暴露 `rag`。

```text
调优前后对比（示意）
   调前：每轮 12 工具全暴露 → 模型乱调用、8 轮才 FINISH
   调后：常用 5 工具常驻 + 其余 deferred → 4 轮 FINISH，token 省 40%
```

## 排错清单速查表

| 症状 | 首选排查命令/位置 | 对应坑 |
| --- | --- | --- |
| 连不上 | `curl localhost:8000/healthz` | 坑 1 |
| 401/403 | 核对 provider_runtime.py:55 分类 | 坑 2 |
| embedding 400 | `curl` 端点 + 查 embedding_endpoint.py:239 | 坑 3 |
| 一直转圈 | 日志搜 THINK 次数 + 查 loop.py:217 | 坑 4 |
| 失忆 | 搜 memory / 查 capability_protocol.py:16 | 坑 5 |
| 检索空 | 搜 kb_name + 查 builtin/__init__.py:95 | 坑 6 |

## 日志字段词典

DeepTutor 的日志每行都带结构化字段，读懂它们能秒定位。常见字段含义：

```text
时间    级别    模块.函数        关键信息
12:01   INFO   tool.dispatch    调用 rag(kb_name='math', query='导数')
12:01   DEBUG  tool.rag         resolve_kb_manifest('math') -> 对象
12:02   ERROR  capability.run    KeyError: 'deep_quiz'
```

- **级别（INFO/DEBUG/ERROR）**：先看 ERROR，它才是真问题；
- **模块.函数**：告诉你是工具层、能力层还是循环层出错（对应 `tool_registry.py` / `capability_registry.py` / `loop.py`）；
- **关键信息**：括号里的参数值，往往是"名字对不对、有没有传"的答案。

> **说明 · 给自己的代码也加日志**
>
> 写工具/能力时，用标准 `logging` 打点：`logger = logging.getLogger(__name__)` 然后 `logger.debug("调用 X，参数 %s", kwargs)`。这样你的业务也进统一日志流，排错时一视同仁。

## 环境依赖与启动类问题

有些"报错"其实不是代码错，而是环境没备齐：

- **`ModuleNotFoundError`**：依赖没装全。按项目 README 的 `pip install -e .`（或对应 extras，如数学动画要 `.[math-animator]`）装好。
- **`port already in use`**：上一次 serve 没关干净。换端口或 `lsof -i :8000` 找到进程杀掉再起。
- **Python 版本不对**：DeepTutor 需要较新的 Python（≥3.10，因用了 `X | None` 语法）。`python --version` 确认。
- **数据目录没初始化**：首次运行可能要初始化 `data/`。按 README 跑初始化命令，别手动乱建目录。

## 升级 DeepTutor 后的兼容问题

你基于 v1.5.11 写的工具/能力，升级后可能"突然不work"。排查顺序：

1. 看 `BUILTIN_TOOL_TYPES`（builtin/__init__.py:1562）和 `BUILTIN_CAPABILITY_CLASSES`（builtin_capabilities.py:3）的 key 名是否变了；
2. 看 `BaseTool` / `BaseCapability` 的抽象方法签名是否变了（如 `execute` 的返回类型，`tool_protocol.py:240`）；
3. 看 `run_agentic_loop` 参数（`loop.py:173`）是否增删了必填项；
4. 用 `git diff` 对比你改的文件与上游，冲突点常在这里。

> **提示 · 把你的定制放在独立文件，别改核心**
>
> 凡是"加"在 `my_tools/`、`my_capabilities/` 独立目录里的代码，升级时几乎零冲突；凡是直接改了 `loop.py` / `facade.py` 的，每次升级都要手工合并。这也是为什么全书强调"加而不改"。

## 给运维：一键健康检查脚本思路

生产环境你可以写一个健康检查，把本章坑 1–6 串成自动巡检：

```bash
#!/usr/bin/env bash
# healthcheck.sh —— 串起六个坑的快速自检
echo "[1] 后端存活";    curl -sf localhost:8000/healthz >/dev/null && echo OK || echo FAIL
echo "[2] 配置可读";    python -c "import deeptutor; print('import ok')" 2>/dev/null || echo FAIL
echo "[3] embedding";   curl -sf "$EMBED_URL" -H "Authorization: Bearer $KEY" ... || echo FAIL
echo "[4] 日志目录";     python -c "from deeptutor.logging.config import get_default_log_dir as g; print(g())"
echo "[5] 工具注册";     python -c "from deeptutor.runtime.registry import get_tool_registry as r; print(r().list_tools()[:5])"
echo "[6] 能力注册";     python -c "from deeptutor.runtime.registry import get_capability_registry as r; print(r().list_capabilities())"
```

跑一遍，哪一项 FAIL 就回对应小节查。这比用户投诉了才翻日志主动得多。

## 崩溃恢复：孤儿回合（orphan turns）

服务器重启或进程被强杀时，可能留下"状态还是 running 但其实已经死了"的回合。DeepTutor 在每次新建回合前会清理它们：`_recover_orphan_running_turns_for_session`（`turn_runtime.py:677`）遍历该会话的活动回合，调用 `_fail_orphan_running_turn`（`turn_runtime.py:661`）把它们标记为失败，并写入中断原因 `_INTERRUPTED_TURN_ERROR`（`turn_runtime.py:138`，文案是 "Turn interrupted by server restart. Please retry your message."）。

**排查现象**：用户发现"上一条消息一直转圈，新消息也发不出去"。这往往不是新请求的错，而是旧回合卡在 running 占着位。解决：

```text
□ 看日志是否出现 "Turn interrupted by server restart" → 属正常恢复
□ 看 store 里该会话是否有 status=running 的陈旧 turn
□ 重启 serve 会自动触发 _recover_orphan_running_turns_for_session（turn_runtime.py:677）
□ 仍卡住 → 手动把陈旧 turn 置为 failed（数据库/存储层操作）
```

> **注意 · 别手动杀进程不重启**
>
> 用 `kill -9` 强杀后**必须**让 serve 重新起来一次，它才会在 `start_turn`（turn_runtime.py:828 调用恢复）时清掉孤儿回合。只杀不重启，陈旧 running 回合会一直赖着，表现为"新消息无响应"。

## 负载与并发注意事项

产品化后你会遇到"一个人好用、一百人崩"的问题，提前知道两个雷：

1. **全局注册表是单例**：`get_tool_registry`（`tool_registry.py:147`）和 `get_capability_registry`（`capability_registry.py:108`）进程级共享。不要在请求里反复 `register` 同一工具，会互相覆盖或跳过（见 `load_builtins` 的 `if name in self._tools: continue`，`tool_registry.py:57`）。
2. **循环是异步但串行 per turn**：每个回合内部是单条 `for` 循环（`loop.py:219`），不会自己并发多轮。真正并发发生在 `dispatch_tools` 并行调用多个工具时。高并发靠多进程/多 worker 的 serve，而不是改循环。

## 给贡献者：如何在源码里加日志而不破坏解析

如果你打算向 DeepTutor 提 PR，注意它的日志是结构化的（`deeptutor/logging/`）。加日志时：

- 用 `logger.debug/info/warning/error`，别用 `print`（会被日志系统忽略或乱序）；
- 敏感信息（API Key、token）走 `redact_embedding_endpoint_for_display`（`embedding_endpoint.py:20`）之类脱敏，别原样打印；
- 日志级别默认 INFO（`logging/config.py:48`），调试细节放 DEBUG，避免生产日志爆炸。

## 向上游求助 / 提 Bug 时该带什么

当你自己排不动、要去 GitHub 或社区求助时，带上这些信息能让人秒懂：

```text
求助清单（复制填写）
  1. DeepTutor 版本：v1.5.11
  2. 复现步骤：打开 X → 输入 Y → 出现 Z
  3. 错误现象：粘贴关键日志（目录见 logging/config.py:19）
  4. 配置脱敏：provider 名、embedding 端点（密钥用 *** 遮）
  5. 是否改过核心代码：改了 loop.py / facade.py 的哪几行？
  6. 最小复现：是否用 label_loop_demo.py:83 也能复现？
```

带上第 6 点的"最小复现"尤其重要——如果连最小 demo 都能复现，说明是通用逻辑问题；如果只在你的定制代码里出现，多半是你工具/能力的写法问题（回到坑 2/5/6）。

> **提示 · 先搜 issue 再提问**
>
> 多数坑社区已经踩过。提问前先搜 `embedding_endpoint.py:239` 的报错文案、或 "orphan turn" 之类关键词，常常直接有答案，省下等待时间。

## 排错心态：三不原则

最后送你三条心态，比任何命令都管用：

- **不慌**：红字不等于灾难，90% 是配置或拼写，日志里都写了原因；
- **不猜**：别凭感觉改代码，先用日志/健康检查把"到底哪一步错"定位准；
- **不孤**：卡住就带"最小复现"去社区问，多数问题别人早踩过。

记住：能稳定排错，比一次写对更像一个资深开发者。本章六坑 + 这套心态，足够你撑过绝大多数实战事故。

## 自查清单

- [ ] 我遇到问题时第一反应是翻日志，而不是瞎改代码
- [ ] 我知道日志目录来自 get_default_log_dir（logging/config.py:19）
- [ ] WS 连不上时我会先 curl 后端 healthz 确认服务在跑
- [ ] Provider/Key 出错我会核对 provider_runtime.py:55 的本地/云端分类
- [ ] Embedding 报错我会检查结尾是否为 /embeddings（embedding_endpoint.py:239）
- [ ] 循环不终止时我查 max_iterations 与提示词终止标签（loop.py:217）
- [ ] 检索为空时我确认 kb_name 正确且知识库已挂载（rag 在 builtin/__init__.py:95）
- [ ] 我了解记忆通过 UnifiedContext（capability_protocol.py:16）注入，能力要从它读取
