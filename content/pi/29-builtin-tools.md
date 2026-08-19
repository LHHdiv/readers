---
title: "第 29 章 · 七大内置工具逐一拆解"
date: 2026-07-01
summary: "黑话速查：**工具（tool）**是\"模型能调用的动作\"；**schema（模式）**是\"这个动作接收哪些参数、各自什么类型\"的说明书；**cwd** 是\"当前工作目录（current working directory）\"，也就是工具默认在哪一个文件夹里干活。"
tags:
  - pi
---
# 第 29 章 · 七大内置工具逐一拆解

> 黑话速查：**工具（tool）**是"模型能调用的动作"；**schema（模式）**是"这个动作接收哪些参数、各自什么类型"的说明书；**cwd** 是"当前工作目录（current working directory）"，也就是工具默认在哪一个文件夹里干活。

## 先建立直觉：Pi 的"手"有七根手指

模型本身只会"说"（生成文本）。要让它真正操作你的代码仓库，必须给它配工具。Pi 在 `packages/coding-agent/src/core/tools/` 下内置了七个最常用的：

| 工具 | 一句话用途 | 核心文件 |
|---|---|---|
| `read` | 读文件内容（可指定行范围） | `read.ts` |
| `bash` | 跑 shell 命令 | `bash.ts` |
| `edit` | 用"查找→替换"改文件 | `edit.ts` |
| `write` | 整体写入/覆盖文件 | `write.ts` |
| `grep` | 在文件内容里搜关键词 | `grep.ts` |
| `find` | 按文件名/通配符找文件 | `find.ts` |
| `ls` | 列出目录内容 | `ls.ts` |

每个工具都由两个函数造出来：**`createXxxToolDefinition`**（定义名字、说明、参数 schema）和 **`createXxxTool`**（真正实现"怎么干"）。例如 read 工具：`createReadToolDefinition` 在 `packages/coding-agent/src/core/tools/read.ts:212`，`createReadTool` 在 `packages/coding-agent/src/core/tools/read.ts:356`，参数 schema `readSchema` 在 `:21`。

> **说明**
>
> **为什么分 definition 和 tool 两份？** definition 是"对外公布的说明书 + 给模型看的描述"，tool 是"对内的真实执行逻辑"。UI、权限系统只看 definition；真正干活时调用 tool。这样"描述"和"实现"解耦，方便复用和测试。

## 统一的"安全与截断"地基

七个工具都遵守同一套规则，理解这一层，单个工具就很好懂了。

### 1. 截断双限：再大的输出也只回一点点

文件、命令输出可能无限大，但模型的上下文窗口（能装下的文字量）是有限的。所以所有工具输出都要"截断"。关键常量在 `packages/coding-agent/src/core/tools/truncate.ts`：

```ts
// packages/coding-agent/src/core/tools/truncate.ts:11-13
export const DEFAULT_MAX_LINES = 2000;       // 默认最多 2000 行
export const DEFAULT_MAX_BYTES = 50 * 1024;   // 默认最多 50 KB
export const GREP_MAX_LINE_LENGTH = 500;      // 单条匹配行最多 500 字符
```

三种截断函数：

- `truncateHead`（`:78`）：保留**头部**，丢掉后面。适合"日志开头最重要"的场景。
- `truncateTail`（`:168`）：保留**尾部**，丢掉前面。适合"最新输出最重要"的场景。
- `truncateLine`（`:268`）：只截断**某一行过长**的情况（比如 grep 命中一行超长文本）。

### 2. 路径防逃逸：不让工具跑出你的项目

工具收到的"文件路径"必须限制在 cwd 之内，不能 `../` 一路逃到系统目录。read 工具用 `resolveReadPathAsync`（`packages/coding-agent/src/core/tools/read.ts:245`）把相对路径解析成绝对路径并校验边界。

### 3. macOS 路径容错

macOS 有一些"隐形坑"：文件名可能是 NFD 变体（带分解声调的 Unicode）、AM/PM 前后夹着窄不换行空格、聪明的引号（curly quote）等。路径解析会尝试这些变体，见 `packages/coding-agent/src/core/tools/path-utils.ts`：

- `tryMacOSScreenshotPath`（`:7`）：处理 AM/PM 空格。
- `tryNFDVariant`（`:11`）：尝试 NFD 规范化。
- `tryCurlyQuoteVariant`（`:16`）：把弯引号换回直引号。
- 同步版 `resolveReadPath`（`:52`）、异步版 `resolveReadPathAsync`（`:86`）。

> **提示**
>
> **为什么这么麻烦？** 一个截图名叫 `Screenshot 10:30 AM.png`（注意 AM 前的窄空格），正常人复制粘贴的路径和磁盘上真实路径字节不完全一样，直接 `open` 会失败。这些容错让 Pi 在 macOS 上"看起来对"的路径也能打开，体验顺滑很多。

### 4. 文件变更队列：同文件串行、不同文件并行

edit 和 write 都调用 `withFileMutationQueue`（`packages/coding-agent/src/core/tools/file-mutation-queue.ts:32`）。它保证：**同一个文件**的多次写入被排队，一次只让一个操作改它；**不同文件**之间则可以同时改，互不干扰。这样避免"两个工具同时写一个文件，内容互相覆盖"的竞态。

- edit 使用处：`packages/coding-agent/src/core/tools/edit.ts:318`
- write 使用处：`packages/coding-agent/src/core/tools/write.ts:210`

## 逐个看：七根手指怎么动

### read —— 读文件

- 定义 `createReadToolDefinition`（`read.ts:212`），执行 `createReadTool`（`read.ts:356`），schema `readSchema`（`:21`）。
- 关键逻辑：解析路径（`resolveReadPathAsync`，`:245`）→ 读取 → 若用户给了 `limit` 就用用户的，否则交给 `truncateHead` 决定保留多少（`:295`）。
- 安全边界：路径必须落在 cwd 内；超长内容自动截断。
- 典型输入：`{ "path": "src/app.ts", "offset": 1, "limit": 100 }` —— 只读第 1~100 行。

### bash —— 跑命令

- 定义 `createBashToolDefinition`（`bash.ts:325`），执行 `createBashTool`（`bash.ts:502`），schema `bashSchema`（`:41`）。
- 超时由 `resolveTimeoutMs`（`bash.ts:28`）计算；真正开进程的是 `createLocalBashOperations`（`:88`），它会 `spawn` 一个 shell。
- 输出通过 `OutputAccumulator`（`bash.ts:347`，类定义在 `output-accumulator.ts`）边跑边收集；内容太多时不是塞进内存，而是**落盘到临时文件**，避免撑爆上下文。

```ts
// packages/coding-agent/src/core/tools/bash.ts:28（节选意图）
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  // 把用户给的超时换算成毫秒，给 spawn 的进程用
}
```

> **注意**
>
> **bash 是七工具里最"危险"的一个**：它能删除文件、访问网络、改系统设置。它本身不替你做安全决策——真正的拦截面在上一章讲的 `beforeToolCall` 钩子里（第 28 章）。理解这一点：工具负责"能跑"，安全由流水线把关。

### edit —— 局部改

- 定义 `createEditToolDefinition`（`edit.ts:301`），执行 `createEditTool`（`edit.ts:441`），schema `editSchema`（`:45`）。
- 参数兼容老格式和 JSON 字符串，由 `prepareEditArguments`（`edit.ts:105`）归一化。
- 在文件变更队列内（`edit.ts:318`）做"查找→替换"：`applyEditsToNormalizedContent`（`edit.ts:349`）算出新内容，再用 `generateDiffString`/ `generateUnifiedPatch`（`edit.ts:356-357`）生成给人类/界面看的差异。
- 安全边界：同样受 cwd 限制，且同一文件串行写入。
- 典型输入：`{ "path": "a.ts", "edits": [{ "oldText": "foo", "newText": "bar" }] }`。

### write —— 整体写

- 定义 `createWriteToolDefinition`（`write.ts:190`），执行 `createWriteTool`（`write.ts:272`），schema `writeSchema`（`:15`）。
- 在队列内（`write.ts:210`）写入；如果父目录不存在，会自动 `mkdir` 建出来（`write.ts:221`）。
- 用途：新建文件、或整篇覆盖。和 edit 的区别是——edit 是"补丁式"改局部，write 是"整篇替换"。
- 典型输入：`{ "path": "new.ts", "content": "console.log(1)" }`。

### grep —— 搜内容

- 定义 `createGrepToolDefinition`（`grep.ts:131`），执行 `createGrepTool`（`grep.ts:388`），schema `grepSchema`（`:24`）。
- 底层调用 **ripgrep**（命令 `rg`），通过 `ensureTool("rg", true)`（`grep.ts:177`）确保工具存在。
- 默认最多 100 条匹配（`DEFAULT_LIMIT = 100`，`grep.ts:44`）；超长匹配行用 `truncateLine` 截断（`:267`、`:329`）；整体再用 `truncateHead` 兜底（`:340`）。
- 会尊重 `.gitignore`，不会翻遍 `node_modules`。
- 典型输入：`{ "pattern": "TODO", "path": "src", "include": "*.ts" }`。

### find —— 找文件

- 定义 `createFindToolDefinition`（`find.ts:126`），执行 `createFindTool`（`find.ts:378`），schema `findSchema`（`:29`）。
- 底层调用 **fd**（比系统 `find` 更快），`ensureTool("fd", true)`（`find.ts:225`）。
- 默认最多 1000 个结果（`DEFAULT_LIMIT = 1000`，`find.ts:44`）；结果用 `relativizeFindResultPath`（`find.ts:17`）转成相对路径，再用 `truncateHead` 兜底（`:200`）。
- 典型输入：`{ "pattern": "*.test.ts", "path": "src" }`。

### ls —— 列目录

- 定义 `createLsToolDefinition`（`ls.ts:103`），执行 `createLsTool`（`ls.ts:228`），schema `lsSchema`（`:14`）。
- 默认最多 500 条（`DEFAULT_LIMIT = 500`，`ls.ts:26`）。
- 结果**按字母排序**（`ls.ts:155`，用 `localeCompare` 做本地化排序，含点文件），目录名加 `/` 后缀，整体 `truncateHead` 兜底（`:187`）。
- 典型输入：`{ "path": "src" }`。

## 汇总表：七个工具一览

| 工具 | 底层引擎 | 默认上限 | 截断方式 | 特殊安全/边界 |
|---|---|---|---|---|
| read | 文件读取 | 2000 行 / 50KB | truncateHead | cwd 边界 + macOS 容错 |
| bash | shell spawn | 50KB（落盘） | OutputAccumulator | 最危险，靠钩子把关 |
| edit | 文本替换 | 2000 行 / 50KB | truncateHead | 同文件串行队列 |
| write | 文件写入 | 2000 行 / 50KB | truncateHead | 自动建父目录 + 串行队列 |
| grep | ripgrep (rg) | 100 条 / 50KB | truncateLine + truncateHead | 尊重 .gitignore |
| find | fd | 1000 个 / 50KB | truncateHead | 相对路径 + 尊重 .gitignore |
| ls | 目录列举 | 500 条 / 50KB | truncateHead | 字母排序、含点文件 |

## 设计上的共同点

把这七个工具摆在一起，能看出 Pi 的几个统一约定：

1. **参数必有 schema**：每个工具都用 `Type.Object({...})` 声明参数结构（如 `readSchema` 在 `read.ts:21`），模型据此填参，代码据此校验。
2. **输出必有上限**：没有一个工具会无脑把全部内容返回，全部走 `truncate*` 系列函数兜底。
3. **路径必有边界**：凡涉及文件路径，都限制在 cwd 内，并做 macOS 容错。
4. **写文件必有队列**：edit/write 都用 `withFileMutationQueue` 防止同文件并发写坏。
5. **底层优先用专业工具**：grep 用 rg、find 用 fd，而不是自己造轮子，更快更稳。

> **说明**
>
> **模型怎么知道用哪个工具？** 每个工具的 definition 里都有一段"人话描述"（比如 grep 的 description 在 `grep.ts:136` 写明了"搜文件内容、尊重 .gitignore、输出截断到 100 条"）。这段描述会被放进给模型的系统提示里，模型据此判断"该调谁、怎么填参"。所以写得清楚的工具描述，直接决定模型用得对不对。

## 什么时候用哪个工具（选择指南）

模型面对一个任务时，怎么决定调谁？下面是经验法则，也对应每个工具的"设计初心"：

- 想**看文件内容** → `read`（知道文件名、想读全文或某几行）。
- 想**改文件里某几处** → `edit`（知道要替换的旧文本）。
- 想**新建文件**或**整篇覆盖** → `write`。
- 想**在内容里搜关键词** → `grep`（不知道在哪，但知道搜什么）。
- 想**按名字找文件** → `find`（不知道全路径，但知道文件名模式）。
- 想**看目录里有什么** → `ls`。
- 想**跑任意命令**（编译、测试、git、安装依赖）→ `bash`。

> **提示**
>
> **read 还是 grep？** 如果你已经知道文件、只想看它写了什么，用 `read`；如果你不知道关键词在哪个文件，用 `grep` 先全网搜。模型常犯的错误是"用 grep 去读一个已经知道路径的文件"，既慢又浪费上下文。好工具描述（如 `grep.ts:136`）会提示"Respects .gitignore、输出截断到 100 条"，帮助模型选对。

## 输出累加器：bash 的大输出如何不撑爆内存

`bash` 最特殊的工程细节是 `OutputAccumulator`（`bash.ts:347`）。命令可能输出几 MB 日志，如果全塞进内存再一次性返回，既占内存又可能超出模型上下文。它的做法是：

1. 边跑边把输出**追加写进一个临时文件**（前缀 `pi-bash`）。
2. 同时统计已经收集了多少字符/行。
3. 一旦超过阈值，就停止往回传更多内容，只在最终结果里说明"已截断、完整输出在临时文件 `xxx`"。
4. 把"截后的摘要 + 临时文件路径"作为工具结果返回给模型。

这样即使命令疯狂刷屏，Pi 也不会被撑爆——大输出进了磁盘，模型只拿到够用的那一段。

## ensureTool：底层引擎不存在怎么办？

`grep` 和 `find` 不自己实现搜索算法，而是调用系统里现成的 `rg`（ripgrep）和 `fd`。`ensureTool("rg", true)`（`grep.ts:177`）、`ensureTool("fd", true)`（`find.ts:225`）在调用前先确认这俩程序装了没。没装的话会报错或尝试安装，而不是静默失败。这种"依赖外部专业工具、先确认存在"的模式，让 Pi 的搜索又快又准，不必重写一套正则引擎。

## 各工具关键参数速查

| 工具 | 关键参数 | 说明 |
|---|---|---|
| read | `path`, `offset`, `limit` | 路径、起始行、读取行数（默认截断到 2000 行） |
| bash | `command`, `timeout`, `description` | 命令串、超时、给模型看的目的说明 |
| edit | `path`, `edits:[{oldText,newText}]` | 文件路径 + 多组查找替换 |
| write | `path`, `content` | 文件路径 + 整篇内容 |
| grep | `pattern`, `path`, `include` | 正则、搜索目录、文件类型过滤 |
| find | `pattern`, `path` | 文件名通配、搜索目录 |
| ls | `path`, `ignore`, `depth` | 目录、忽略项、递归深度 |

这些参数都声明在各自的 schema 里（如 `readSchema` 在 `read.ts:21`、`bashSchema` 在 `bash.ts:41`），模型据此填参，代码据此校验——参数不合法会被 `validateToolArguments`（第 28 章讲过）挡下。

## 工具出错与安全红线

- **路径越界**：任何涉及路径的工具都限制在 cwd 内。模型若试图用 `../` 逃出项目，解析阶段就报错，不会真去碰系统文件。
- **危险命令**：`bash` 本身不判断命令善恶，危险与否由第 28 章的 `beforeToolCall` 钩子把关。这意味着"安不安全"是**可配置、可插拔**的——不同宿主（CLI / IDE）可以有不同严格度的策略。
- **超大输入**：`write`/`edit` 写入超大内容时同样走截断与队列，避免把对话上下文一次性灌爆。

> **注意**
>
> **不要把工具当黑盒乱用**：每个工具都有上限（行数、字节、条数）。让模型"一次性 read 一个 10 万行的文件"会得到截断后的前 2000 行；让它"grep 整个仓库"最多返回 100 条。理解这些上限，才能正确引导模型"分而治之"地探索代码库。

## 工具描述里写了什么（以 grep 为例）

模型不是天生知道工具怎么用，它靠"工具的 description"学习。看 `grep` 的描述（`grep.ts:136`）：

```text
Search file contents for a pattern. Returns matching lines with file paths
and line numbers. Respects .gitignore. Output is truncated to 100 matches
or 50KB (whichever is hit first). Long lines are truncated to 500 chars.
```

这段话同时告诉模型四件事：① 工具干什么；② 输出带文件名和行号；③ 尊重 `.gitignore`（不会翻 `node_modules`）；④ 有上限（100 条 / 50KB / 单行 500 字符）。模型据此既会"正确调用"，也会"预期到结果可能被截断"。**写清楚的工具描述 = 模型少犯错**。

## 截断在实践中的表现

理解截断常量（`truncate.ts:11-13`）能避免误用：

- 让 `read` 读一个 5 万行的日志文件，你只会拿回前 **2000 行**（约 50KB 先到也截）。想看后面，要靠 `offset` 翻页。
- 让 `grep` 在全仓库搜一个常见词，最多回 **100 条**匹配；某条匹配行本身超长时，单行截到 **500 字符**。
- 让 `find` 搜通配符，最多回 **1000 个**文件路径。
- 让 `ls` 列目录，最多回 **500 条**条目。

这些上限不是 bug，而是"保护模型上下文不被淹没"的设计。正确用法是"分而治之"：缩小搜索范围、指定目录、用更精确的 pattern，而不是一次捞全部。

## 一句话记忆卡

- `read`：看已知文件的内容。
- `bash`：跑任意命令，最灵活也最危险。
- `edit`：在文件里做"查找→替换"的局部手术。
- `write`：整体新建或覆盖文件。
- `grep`：在内容里搜"什么"（用 rg）。
- `find`：按名字找"哪个文件"（用 fd）。
- `ls`：看目录里有什么。

记住这七句，就能判断模型"该用哪个工具"，也更容易发现模型"用错了工具"。

## 自查清单

- [ ] 我能说出七个内置工具的英文名和各自用途。
- [ ] 我知道每个工具都有 `createXxxToolDefinition`（说明书）和 `createXxxTool`（实现）两份。
- [ ] 我记住截断三常量：`DEFAULT_MAX_LINES=2000`、`DEFAULT_MAX_BYTES=50KB`、`GREP_MAX_LINE_LENGTH=500`（都在 `truncate.ts:11-13`）。
- [ ] 我理解 read/bash/edit/write 都做 cwd 边界校验，防止路径逃逸。
- [ ] 我知道 macOS 容错处理的是 NFD 变体、AM/PM 窄空格、卷曲引号（`path-utils.ts:7-16`）。
- [ ] 我理解 `withFileMutationQueue` 让"同文件串行、不同文件并行"（`:32`）。
- [ ] 我能区分 edit（局部补丁）与 write（整篇覆盖）。
- [ ] 我知道 grep 用 rg、find 用 fd，且都尊重 `.gitignore`。
- [ ] 我明白 bash 最危险，安全决策不在工具内，而在 `beforeToolCall` 钩子（回顾第 28 章）。
- [ ] 我理解每个工具的 description 会进系统提示，直接影响模型用得对不对。
