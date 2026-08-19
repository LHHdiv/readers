---
title: "第 47 章 · 排错手册与性能调优"
date: 2026-07-01
summary: "前面章节教你\"怎么把它搭起来\"。本章教你\"搭起来却跑不通时怎么办\"。Pi 是个多包 Monorepo（agent-core / ai / coding-agent），报错信息有时藏在某一层。我们把高频坑按\"现象→可能原因→排查动作\"列成表格，照着查最快。"
tags:
  - pi
---
# 第 47 章 · 排错手册与性能调优

前面章节教你"怎么把它搭起来"。本章教你"搭起来却跑不通时怎么办"。Pi 是个多包 Monorepo（agent-core / ai / coding-agent），报错信息有时藏在某一层。我们把高频坑按"现象→可能原因→排查动作"列成表格，照着查最快。

## 排错总览图

```
报错/异常
   │
   ├─ 起不来？        → 构建顺序 / Node 版本 / 依赖
   ├─ 模型不响应？    → key / 网络 / stopReason
   ├─ 工具失败？      → 路径 / 权限 / 超时
   ├─ 上下文溢出？    → 压缩是否被触发
   ├─ 流式卡住？      → 事件订阅 / 进程退出
   ├─ 扩展不生效？    → 入口 / pi 字段 / 依赖
   └─ 连不上？        → RPC / CBOR 通道
```

## 一、构建与运行环境

| 现象 | 可能原因 | 排查命令/文件 |
|------|----------|---------------|
| `Cannot find module @earendil-works/pi-coding-agent` | 没构建/没链接包 | `npm run build`（仓库根）；确认 `packages/coding-agent` 已 build |
| 启动报语法/装饰器错误 | Node 版本过低 | `node -v`，对照仓库 `engines` 要求（建议较新 LTS） |
| `import` 报 ESM 错误 | 包未以 ESM 方式解析 | 检查 `package.json` 的 `"type":"module"`，扩展入口同理 |
| 改了源码不生效 | 没重新 build | 改 `packages/*` 后重跑构建；扩展改动通常热加载，主包需重建 |

> **说明**
>
> Pi 是 pnpm/npm workspace 多包结构。改了 `packages/ai` 或 `packages/coding-agent` 源码后，**必须重新构建对应包**，再跑你的脚本或 CLI，否则加载的还是旧 dist。扩展（第 45 章）因为是 jiti 直读 `.ts`，一般不需要编译。

## 二、模型不响应

| 现象 | 可能原因 | 排查命令/文件 |
|------|----------|---------------|
| `modelFallbackMessage` 非空 / "no models available" | 没配置任何 provider key | `createAgentSession` 内部 `findInitialModel` 失败（`sdk.ts:217-222`） |
| 401 / 403 | `DEEPSEEK_API_KEY` 错误或未导出 | `echo $DEEPSEEK_API_KEY`；DeepSeek provider 读 `DEEPSEEK_API_KEY`（`deepseek.ts:11`） |
| 请求一直 pending 无返回 | 网络不通 / 代理 | `curl https://api.deepseek.com` 测连通性 |
| 返回 `stopReason: "length"` | 命中 `maxTokens` 上限 | 调大 `maxTokens` 或让任务拆分更细 |
| 返回 `stopReason: "toolUse"` 后停住 | 工具执行失败导致无法继续 | 看下方"工具执行失败" |
| 流式突然 `stopReason: "error"` | provider 侧 5xx / 限流 | 看 `after_provider_response` 事件状态码（`types.ts:692`） |

> **注意**
>
> "模型不说话"十有八九是 key 问题。先用 `echo $DEEPSEEK_API_KEY` 确认变量在主进程（若用 Electron，见第 46 章）里确实可见，再怀疑代码。DeepSeek 的 baseUrl 在源码写死为 `https://api.deepseek.com`（`deepseek.ts:10`），一般不用改。

## 三、工具执行失败

| 现象 | 可能原因 | 排查命令/文件 |
|------|----------|---------------|
| `read` 报文件不存在 | `cwd` 不对 / 相对路径基准错 | 确认 `createAgentSession({ cwd })`（`sdk.ts:40`）指向预期目录 |
| `bash` 命令没效果 | 工作目录 / 权限 / PATH | 在 `tool_call` 事件里看 `event.input.command` 实际内容 |
| 工具超时 | 命令卡死（如等待输入） | `BashExecutor` 有超时设置；避免在工具里跑交互式命令 |
| `edit` 改不中 | 旧字符串不匹配 | 看工具结果 `isError`（`ToolExecutionEndEvent`，`types.ts:779`） |
| 自定义工具不调用 | `promptSnippet` 缺失 / 描述不清 | 给 `registerTool` 加 `promptSnippet`（`types.ts:456`） |
| 危险命令被拦 | 你的 `tool_call` 拦截返回 `block:true` | 检查扩展里 `pi.on("tool_call")`（`types.ts:1071`） |

## 四、上下文溢出与压缩

| 现象 | 可能原因 | 排查动作 |
|------|----------|----------|
| 长会话后回答质量下降 | 上下文接近窗口上限 | 订阅 `session_before_compact` / `session_compact`（`types.ts:592/605`）确认是否触发 |
| 报 context overflow | 单轮超过窗口 | Pi 会自动触发 overflow 压缩并重试（`sdk.ts` 内 `shouldCompact` 逻辑） |
| 压缩后"失忆" | 摘要未覆盖关键信息 | 用 `ctx.compact({ customInstructions })`（`types.ts:344`）自定义摘要指引 |

> **提示**
>
> 压缩（compaction）是 Pi 的"记忆整理"机制（第 30 章）。它通常在上下文占比超阈值时自动触发，把早期对话总结成摘要、丢弃原文。如果你发现重要上下文被丢，可手动调用 `pi.compact` 或调 `CompactOptions`。排查时先确认 `session_compact` 事件是否真的触发，避免误判为"模型变笨"。

## 五、流式卡住 / 不刷新

| 现象 | 可能原因 | 排查动作 |
|------|----------|----------|
| 控制台没任何输出 | 没订阅事件或订阅错类型 | 确认 `session.subscribe(evt => ...)` 且判断 `evt.type === "message_update"`（第 44 章） |
| 桌面端 UI 不动 | IPC 通道名不匹配 | 主进程 `send("agent:stream")` 与 preload `on("agent:stream")` 名字要一致（第 46 章） |
| 进程跑完就退 | `prompt` 后没等 settle | `await session.prompt(...)` 后再决定退出；或等 `agent_settled` 事件 |
| 只收到首字后再无 | 流被异常中断 | 查 `stopReason: "error"`，看 provider 返回 |

## 六、扩展加载失败

| 现象 | 可能原因 | 排查文件/命令 |
|------|----------|---------------|
| 启动报 "no extensions found" | 入口找不到 | 确认 `package.json` 有 `pi.extensions` 指向正确入口（第 45 章） |
| `pi` 字段被忽略 | `-e` 指向文件而非目录 | `-e ./my-ext`（目录）而非 `-e ./my-ext/index.ts` |
| 报某个 import 找不到 | 扩展缺依赖 | 在扩展目录 `npm install`；jiti 从扩展自身 `node_modules` 解析（`with-deps` 示例） |
| 扩展报错导致启动失败 | 工厂函数抛异常 | 扩展错误会进 `LoadExtensionsResult.errors`（`types.ts:1712`） |
| 类型导入失败 | 包名写错 | 用 `@earendil-works/pi-coding-agent` 而非其他名 |

> **说明**
>
> 扩展加载出错时，Pi 不会整体崩，而是把错误收进 `LoadExtensionsResult.errors`（`types.ts:1712`），并打印路径与错误信息。排查扩展问题第一件事：看启动日志里这个扩展是否出现在 Extensions 列表，以及有没有对应 error 行。

## 七、RPC / CBOR 连接问题

如果你用 RPC 模式（远程驱动 Pi，见 `runRpcMode` / `RpcClient`，`index.ts:350`），可能遇到：

| 现象 | 可能原因 | 排查动作 |
|------|----------|----------|
| 连不上 RPC server | 端口/地址错 | 确认 server 已起、客户端 `RpcClientOptions` 地址对 |
| 事件收不全 | CBOR 编解码不匹配 | 保证两端用同一 Pi 版本（CBOR 序列化依赖类型约定） |
| 交互式 UI 调不出 | RPC 模式 `hasUI` 限制 | 用 `ctx.hasUI` 守卫 UI 调用（`types.ts:313`） |

## 性能调优要点

搭通只是第一步，跑得"快且省"才是产品体验。下面是可操作的调优点：

### 1. 提高 prompt cache 命中率

Pi 内置 prompt cache（第 12 章）。系统提示、工具定义等长段内容会被缓存，命中后输入计费大幅降低、首字延迟下降。调优原则：

- 不要把每轮都在变的动态内容塞进系统提示开头（会破坏缓存锚点）
- 工具 schema 保持稳定，避免每次随机生成参数描述

### 2. 并发工具

Pi 支持工具并发执行（`ToolDefinition.executionMode: "parallel"`，`types.ts:477`）。读多个独立文件时设为 `parallel` 可显著提速；有共享状态（如棋盘、计数器）的工具用 `"sequential"` 防竞态（参考 `examples/extensions/tic-tac-toe.ts`）。

### 3. 截断阈值

工具输出过大会撑爆上下文。Pi 的工具有 `TruncationOptions`（`index.ts:315`）控制截断。长命令输出用 `truncated-tool` 风格（示例 `truncated-tool.ts`）做 50KB/2000 行上限。

### 4. 模型选择

不同任务用不同模型：简单重构用便宜快的 `deepseek-v4-flash`（`deepseek.models.ts` 目录里有 `deepseek-v4-flash` 等），重规划任务再上更强模型。`thinkingLevel` 也按任务调（`sdk.ts:50`），不需深度推理时设 `low`/`off` 省 token。

### 5. 超时与重试

provider 重试设置在 `SettingsManager.getProviderRetrySettings()`（`sdk.ts:303`）。网络不稳时适当调大 `maxRetries` 与 `timeoutMs`，但别设 0（SDK 把 0 当成"立即超时"，见 `sdk.ts:306-307` 注）。

> **提示**
>
> 一个常被忽略的开关：SDK 里 `timeoutMs === 0` 会被当成"无超时"的反面——实际是立刻超时（`sdk.ts:306-307` 特意用 `max int32` 兜底）。所以配置 HTTP 超时时永远用正整数毫秒，别写 0。

## 排错决策树（速查）

```
模型没反应
  ├─ echo $DEEPSEEK_API_KEY 为空？ → 填 key
  ├─ curl api.deepseek.com 不通？ → 网络/代理
  └─ modelFallbackMessage 非空？   → 该 provider 无任何可用模型

工具不执行
  ├─ tool_call 事件里 args 对吗？ → 不对则改 prompt/schema
  ├─ isError=true？               → 看具体错误（路径/权限/超时）
  └─ 根本没调用工具？             → 加 promptSnippet 让 LLM 知道有这工具

UI 不刷新
  ├─ subscribe 订阅到 message_update 了吗？ → 没订阅则加
  └─ Electron IPC 名字主进程/渲染一致吗？   → 对齐 channel 名
```

## 诊断命令速查表

把常用排查命令集中放这里，遇事照抄：

| 目的 | 命令 |
|------|------|
| 看 Node 版本 | `node -v` |
| 看 DeepSeek key 是否导出 | `echo "$DEEPSEEK_API_KEY"` |
| 测 DeepSeek 连通性 | `curl -sI https://api.deepseek.com` |
| 看扩展加载错误 | 启动日志搜 `Extensions` 与 `error` |
| 重建 Pi 包 | 仓库根 `npm run build`（或对应包 build 脚本） |
| 清掉旧会话缓存重来 | 删项目 `.pi/` 或 `~/.pi/agent` 会话文件 |
| 单步看清事件流 | 临时扩展订阅关键事件并打印 `type` |

> **提示**
>
> 连通性用 `curl -sI` 只查响应头，比 `curl` 整页快且不会泄露 body。若返回非 2xx/3xx，先解决网络/代理，再回来继续。

## 九、日志与诊断去哪看

| 你想看 | 去哪看 |
|--------|--------|
| 扩展是否加载 / 有无 error | 启动日志的 Extensions 列表 + `LoadExtensionsResult.errors`（`types.ts:1712`） |
| 每次模型请求的状态码 | `after_provider_response` 事件（`types.ts:692`） |
| 工具实际入参 | `tool_call` 事件（`types.ts:904`）的 `event.input` |
| 上下文占用 | `ctx.getContextUsage()`（`types.ts:342`）或 `session_before_compact` |
| token 用量 / 花费 | `agent_end` 事件的 usage 字段、遥测 |
| 压缩是否触发 | `session_compact` 事件（`types.ts:605`） |

建议在怀疑某层时，先挂一个"全事件打印"的临时扩展：`pi.on("*", (e)=>console.log(e.type))` 思路（实际用具体事件名逐个订阅），一次性看清事件时序，再定位断点。

## 十、最小复现模板

给社区/同事报问题时，附上这个模板能省一半沟通：

```bash
# 1) 环境
node -v
echo "key 已配: $([ -n "$DEEPSEEK_API_KEY" ] && echo yes || echo no)"

# 2) 最小触发
pi -e ./my-ext          # 或你的 SDK 脚本
# 报错贴完整堆栈，别只贴最后一行

# 3) 期望 vs 实际
# 期望：LLM 调用 today 工具并返回日期
# 实际：LLM 直接编了一个日期，没调用工具
```

> **说明**
>
> 好 bug 报告 = 环境 + 最小步骤 + 期望/实际三件套。Pi 是分层架构，缺了任何一项，回答者都得先反问你，白白多一轮往返。

## 八、记住几个"反直觉"的坑

| 坑 | 解释 |
|----|------|
| 超时设 0 = 立刻超时 | SDK 把 `timeoutMs===0` 当成"立即超时"而非"无超时"，用 `max int32` 兜底（`sdk.ts:306-307`） |
| 改了核心包不生效 | 多包 Monorepo 需重新 build 对应包，dist 才是被加载的 |
| `-e` 指向 .ts 文件 | 扩展入口靠 `package.json` 的 `pi.extensions`，应指向目录 |
| 模型不说话先怪网络 | 八成是 key 没导出，先 `echo $DEEPSEEK_API_KEY` |
| 工具"没被调用" | 多半是 LLM 不知道有这工具，补 `promptSnippet` |
| 压缩后像失忆 | 是摘要策略问题，不是模型变笨，调 `compact` 指引 |

## 性能自查清单（速查）

```
□ 系统提示/工具 schema 是否稳定？（影响 prompt cache 命中）
□ 独立读操作是否标了 executionMode:"parallel"？
□ 长输出是否做了截断（TruncationOptions）？
□ thinkingLevel 是否按任务调低以省 token？
□ provider 重试/超时是否为正整数？（非 0）
□ 是否用对了模型：简单任务用 deepseek-v4-flash，重规划再上更强
```

> **注意**
>
> 排错顺序建议"由外到内"：先看环境变量与 key（最常见）→ 再看构建与加载 → 最后才深入 provider/流式细节。多数人卡在第一步就放弃了，其实 key 一填就好。

## 按现象快速索引

| 你看到的 | 直接跳到 |
|----------|----------|
| 模块找不到 / 语法错 | 第一节 构建与运行环境 |
| 模型不响应 / 401 | 第二节 模型不响应 |
| 工具报错 / 不调用 | 第三节 工具执行失败 |
| 长会话变笨 / overflow | 第四节 上下文溢出 |
| UI 不动 / 只首字 | 第五节 流式卡住 |
| 扩展不生效 | 第六节 扩展加载失败 |
| 远程连不上 | 第七节 RPC/CBOR |
| 想跑更快更省 | 性能调优要点 |

## 最后一条总则

排错的本质是"缩小怀疑范围"。Pi 五层架构（基础/架构/核心/落地/保障）里，任何异常都能归到某一层。你的工作不是"猜"，而是用上面表格的排查动作，把"可能是这、可能是那"逐层排除，直到只剩一个可疑点，再动手修。

> **提示**
>
> 把本章当"字典"而非"小说"：平时不用读，出问题时按现象翻对应表格，照"排查动作"一列执行。能定位到层，问题就解决了一大半。

## 自查清单

- [ ] 我改完 `packages/*` 源码后会重新 build 再运行
- [ ] 模型不响应时我先查 `DEEPSEEK_API_KEY` 与 `modelFallbackMessage`
- [ ] 我知道 `stopReason` 的 `length`/`toolUse`/`error` 各代表什么
- [ ] 工具失败时我会看 `tool_execution_end` 的 `isError` 与 `tool_call` 的 `args`
- [ ] 我理解压缩(compaction)由上下文阈值触发，会查 `session_compact` 事件
- [ ] 流式卡住时我核对 `subscribe` 事件类型与 IPC channel 名
- [ ] 扩展不生效时我查 `package.json` 的 `pi.extensions` 与启动日志 errors
- [ ] 我会在合适场景用 `executionMode:"parallel"`、稳定工具 schema、调 `thinkingLevel` 做性能调优
- [ ] 我知道 provider 超时配置不能用 0（`sdk.ts:306-307`）
