---
title: "第 38 章 · 技能系统 skills"
date: 2026-07-01
summary: "约定：行号来自两处——`packages/coding-agent/src/core/skills.ts`（产品层，接入资源加载器）与 `packages/agent/src/harness/skills.ts`（运行时层 harness，提供加载原语与调用格式化）。"
tags:
  - pi
---
# 第 38 章 · 技能系统 skills

“技能（skills）”是 Pi 里一种特殊的资源：它把**一段针对某类任务的详细指令**写成一个 `SKILL.md` 文件，让大模型在合适的时候“按说明书办事”。本章讲清楚：技能文件长什么样、Pi 怎么发现并校验它们、它们最终如何变成系统提示词里的 `<available_skills>`，以及——为什么叫它“技能”而不是“插件”。

> 约定：行号来自两处——`packages/coding-agent/src/core/skills.ts`（产品层，接入资源加载器）与 `packages/agent/src/harness/skills.ts`（运行时层 harness，提供加载原语与调用格式化）。

## 38.1 什么是技能，它解决什么问题

一句话：**技能 = 一个带 frontmatter 的 Markdown 文件，内容是“遇到某类任务时该怎么做的说明书”**。

与传统插件不同，技能**默认不注册成工具**，而是作为“可选说明书”列在系统提示词里。模型读到 `<available_skills>` 后，遇到匹配的任务，会用 `read` 工具把对应 `SKILL.md` 读进来，按里面的步骤执行。换句话说，技能是“**给模型的提示，不是给程序的代码**”。

这正好契合第 36 章讲的：系统提示词里会有一段 `<available_skills>`，它就是从技能文件自动生成的。

为什么不直接把所有流程写进系统提示词？因为技能可能很多、很大，全塞进去会**撑爆上下文窗口**且让模型分心。Pi 的做法是“只放目录 + 路径”，模型需要时现读——这就是技能存在的根本理由。

> **提示**
>
> 把技能想象成“菜谱卡片盒”：卡片盒上只写菜名和一句话简介（`<available_skills>`），厨师（模型）想做某道菜了，才把对应的卡片抽出来照着做。这样卡片盒永远很薄，但能装的菜谱可以无限多。

## 38.2 一个最小技能文件

一个合法的 `SKILL.md` 长这样（yaml frontmatter + 正文）：

```markdown
---
name: pdf-extractor
description: 从 PDF 中提取结构化表格并转为 CSV。当用户提到“提取 PDF 表格”“解析 pdf”时使用。
---

# PDF 表格提取

1. 用 `bash` 调用 `pdftotext` 把 PDF 转成文本。
2. 用 `read` 检查输出，定位表格区域。
3. 用 `edit` 写一个小的提取脚本，输出 CSV。
4. 把结果交回用户。

引用相对路径时，以本文件所在目录为基准。
```

要点：

- `name`：技能名，必须小写字母/数字/连字符（`core/skills.ts:92` 的 `validateName` 有严格规则）。
- `description`：**最关键的字段**，模型靠它判断“这个技能适不适用”。缺失会直接加载失败（`core/skills.ts:120` 的 `if (!description)` 检查）。
- 正文：写给模型的步骤说明。

`validateName`（`core/skills.ts:92`）的规则很严：只允许 `a-z0-9-`，不能头尾连字符、不能双连字符；超过 `MAX_NAME_LENGTH = 64`（`core/skills.ts:11`）只给警告。`validateDescription`（`core/skills.ts:117`）要求 description 非空且不超 `MAX_DESCRIPTION_LENGTH = 1024`（`core/skills.ts:14`）。

> **提示**
>
> 写技能时，把力气花在 `description` 上。模型是先读 description 决定“要不要调用这个技能”，**description 写不清，技能再好也没人用**。Pi 对 name/description 有长度与字符限制，违反只给警告但仍可能加载。

## 38.3 发现规则：怎么找到技能

技能加载由 `loadSkillsFromDir()` 启动（`core/skills.ts:168`），真正的递归逻辑在 `loadSkillsFromDirInternal()`（`core/skills.ts:173`–`core/skills.ts:275`）。发现规则如下：

1. 若某目录直接包含 `SKILL.md`，就把它当成**一个技能根**，且**不再往里递归**（避免把一个技能的子目录误当新技能）。
2. 否则，扫描该目录下的 `.md` 文件，把每个当作独立技能。
3. 对子目录继续递归查找 `SKILL.md`。
4. 跳过以 `.` 开头的隐藏目录与 `node_modules`（`core/skills.ts:224`、`:229`）。
5. 支持 `.gitignore` 等忽略规则（`IGNORE_FILE_NAMES`，`core/skills.ts:16` + `addIgnoreRules`）。

```ts
// packages/coding-agent/src/core/skills.ts:173（节选签名）
function loadSkillsFromDirInternal(
    dir: string, source: string, includeRootFiles: boolean,
    ignoreMatcher?: IgnoreMatcher, rootDir?: string,
): LoadSkillsResult {
    // 先找 SKILL.md（命中即停下递归），否则扫 .md，再递归子目录
}
```

一个目录结构例子：

```text
.skills/
├─ pdf-extractor/
│   └─ SKILL.md          ← 命中，作为 1 个技能，不再递归 pdf-extractor 内部
├─ git-helper.md         ← 根目录下的 .md，作为 1 个独立技能
└─ db/
    └─ SKILL.md          ← 递归命中，作为 1 个技能
```

运行时层也有一套等价的实现：`packages/agent/src/harness/skills.ts` 的 `loadSkills()`（`harness/skills.ts:49`）与 `loadSkillsFromDirInternal()`（`harness/skills.ts:103`）。区别在于它不依赖 Node 的 `fs`，而是通过传入的 `ExecutionEnv`（文件信息/列举/读文本）来操作——这让同一套技能逻辑既能跑在本地文件系统，也能跑在别的执行环境里。

## 38.4 Frontmatter 校验

每个 `SKILL.md` 都要过校验，逻辑在 `loadSkillFromFile()`（`core/skills.ts:277`–`core/skills.ts:325`）：

- 解析 frontmatter（`parseFrontmatter`，`core/skills.ts:285`）。
- 校验 `description`（`validateDescription`，`core/skills.ts:117`）——必填、不超长。
- 取 `name`（frontmatter 里没有就用父目录名，`core/skills.ts:296`）。
- 校验 `name`（`validateName`，`core/skills.ts:92`）——只允许 `a-z0-9-`，不能头尾连字符、不能双连字符。
- 若 `description` 完全缺失，则**直接不加载**（`core/skills.ts:120`）；其余情况即使有警告也照常加载。
- 读取 `disable-model-invocation`（`core/skills.ts:316`）：设为 `true` 的技能**不会**进入 `<available_skills>`，只能被用户显式用 `/skill:name` 调用。

校验问题会被收集进 `diagnostics`（警告级别），最终可能显示成启动时的 “Skill conflicts” 提示（见第 36 章 `ResourceLoader` 冲突检测、第 39 章启动资源列表）。

## 38.5 汇总加载：多来源去重

`loadSkills()`（`core/skills.ts:387`–`core/skills.ts:487`）负责从所有配置位置汇总技能，内部用 `addSkills()`（`core/skills.ts:399`）合并结果：

- 用户级：`~/.pi/skills`（对应 `agentDir/skills`，`core/skills.ts:431`）
- 项目级：`<cwd>/.pi/skills`（`core/skills.ts:432`）
- 显式路径：`skillPaths` 参数指定的文件或目录（`core/skills.ts:466` 起）

重复的同名技能会被去重，并记录“碰撞（collision）”诊断——保留先者（winner），跳过后者（loser），这正是第 36 章 `detectExtensionConflicts` 会报告的内容之一。

```text
加载顺序（后者遇到同名则跳过）：
1. 用户级 ~/.pi/skills
2. 项目级 <cwd>/.pi/skills
3. 显式 skillPaths
```

## 38.6 变成系统提示词：formatSkillsForPrompt

加载完成后，技能要被写进系统提示词。这个转换由 `formatSkillsForPrompt()` 完成（`core/skills.ts:335`–`core/skills.ts:361`），它输出符合 Agent Skills 标准的 XML 片段，并过滤掉 `disableModelInvocation` 的技能（`core/skills.ts:336`）：

```text
<available_skills>
  <skill>
    <name>pdf-extractor</name>
    <description>从 PDF 中提取结构化表格并转为 CSV...</description>
    <location>/abs/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

生成的文本被 `buildSystemPrompt` 拼进系统提示词（第 36 章 `system-prompt.ts:156` 调用 `formatSkillsForPrompt`）。

> **说明**
>
> 为什么用 `read` 工具“现读”而不是直接把技能全文塞进提示词？因为技能可能很多很大，全塞进去会浪费上下文。Pi 的做法是：**只在提示词里放“目录 + 路径”，模型需要时再用 read 把具体内容读进来**。这就是 `<location>` 字段的意义——它是模型去取说明书的地址。

## 38.7 实际调用：用户触发与模型触发

当用户在交互模式输入 `/skill:name args`，`AgentSession._expandSkillCommand()`（`agent-session.ts:1309`–`agent-session.ts:1333`）会把命令展开成一段 `<skill>` 块，内容就是 `SKILL.md` 正文（去掉 frontmatter），并带上 `location`。这段块被当作用户输入发给模型。

运行时层 `harness/skills.ts` 提供了 `formatSkillInvocation()`（`harness/skills.ts:38`–`harness/skills.ts:41`），用于把技能对象和额外指令拼成同样的 `<skill name="..." location="...">...</skill>` 调用格式——这是“程序侧触发技能”的标准写法。

```text
   技能文件 SKILL.md (磁盘)
        │  loadSkillsFromDirInternal  core/skills.ts:173
        ▼
   汇总 + 校验              core/skills.ts:387
        │
        ▼
   formatSkillsForPrompt    core/skills.ts:335
        │
        ▼
   <available_skills> 进入系统提示词
        │
   ┌────┴─────────────────────────────┐
   ▼                                   ▼
 模型判断匹配 → read 读 SKILL.md      用户输入 /skill:name
   │                                   │
   ▼                                   ▼
 按说明书执行步骤                _expandSkillCommand 展开成 <skill> 块
```

## 38.8 两层实现的分工

| 文件 | 角色 | 关键函数 |
| --- | --- | --- |
| `core/skills.ts`（产品层） | 接入 `ResourceLoader`，产出 `<available_skills>` | `loadSkills` `:387`、`formatSkillsForPrompt` `:335` |
| `harness/skills.ts`（运行时层） | 与执行环境无关的加载原语、调用格式化 | `loadSkills` `:49`、`formatSkillInvocation` `:38` |

产品层那套会读取真实的文件系统、产出的技能最终出现在用户的系统提示词里；运行时层那套更“抽象”，通过 `ExecutionEnv` 适配不同环境，并提供 `formatSkillInvocation` 这种给程序调用用的格式化工具。两者发现规则、校验规则几乎一致（运行时层的 `validateName` 还要求 name 必须匹配父目录名），保证“同一份 SKILL.md，在两层表现一致”。

## 38.9 小结

技能是 Pi “用 Markdown 给模型写说明书”的机制。它：

1. 以 `SKILL.md`（frontmatter + 正文）的形式存在；
2. 被递归发现、严格校验 name/description（`core/skills.ts:92`、`:117`）；
3. 多来源加载并去重（`core/skills.ts:387`）；
4. 由 `formatSkillsForPrompt`（`core/skills.ts:335`）变成 `<available_skills>` 进入系统提示词；
5. 由模型用 `read` 现读、或用户用 `/skill:name` 显式调用。

> **提示**
>
> 技能 vs 扩展，一句话区分：**扩展给“程序”加能力（registerTool/registerCommand），技能给“模型”加说明书（写进系统提示词让模型读）**。想让模型“学会一套固定流程”，用技能；想让 Pi“多一个可被调用的功能”，用扩展。

## 38.10 写技能的最佳实践

既然技能是“写给模型的说明书”，写法就很重要。几条来自源码约定的经验：

- **`description` 写明“何时使用”**：模型先读 description 判断是否调用。与其写“PDF 工具”，不如写“当用户提到‘提取 PDF 表格’‘解析 pdf’时使用”——后者给出了触发场景，模型更容易在对的时机想起它。
- **正文给“步骤”而非“结论”**：技能正文应该是一串可执行动作（用 `bash` 调什么、用 `read` 看哪里、用 `edit` 改什么），而不是一段泛泛的解释。模型照着走比让它“自己发挥”更稳。
- **引用相对路径以技能目录为基准**：技能正文里提到的脚本/示例，用相对路径，Pi 会以 `SKILL.md` 所在目录解析。
- **大段代码别塞进正文**：正文里放不下的大段模板/脚本，放到技能目录下的独立文件，让模型用 `read` 去读。这既保持 `<available_skills>` 轻量，也符合“只放目录、模型现读”的设计。
- **按需技能用 `disable-model-invocation`**：那些“只在你显式点名时才该用”的技能，设 `disable-model-invocation: true`（`core/skills.ts:316`），让它退出自动候选、只响应 `/skill:name`，避免干扰模型的自动判断。

## 38.11 两层校验的细微差异

第 38.8 节说两层实现“发现/校验规则几乎一致”，但的确有细微取舍：

- **产品层 `core/skills.ts`**：更注重“能加载就加载”。name 缺失时直接取父目录名（`core/skills.ts:296`），只有 description 真正缺失才放弃加载。
- **运行时层 `harness/skills.ts`**：因为要适配任意 `ExecutionEnv`，对目录结构的判定更严格——它的 `validateName` 要求技能名**必须匹配其父目录名**（`harness/skills.ts` 的 `validateName`），这是为了让“技能目录 → 技能名”的映射在任何执行环境下都唯一确定。

这种“严格度不同、目标一致”的安排，保证了同一份 `SKILL.md` 在本地 Pi 和别的运行环境里表现可预期：要么都能用，要么都给出明确的诊断信息，而不是在一个环境能加载、另一个环境悄然失效。

## 38.12 关键函数速查表

把本章出现的技能系统函数集中列在这里，方便回查：

| 函数 / 常量 | 文件:行号 | 作用 |
| --- | --- | --- |
| `MAX_NAME_LENGTH` / `MAX_DESCRIPTION_LENGTH` | `core/skills.ts:11` / `:14` | 名称/描述长度上限 |
| `IGNORE_FILE_NAMES` | `core/skills.ts:16` | 忽略规则文件名（`.gitignore` 等） |
| `validateName` | `core/skills.ts:92` | 校验技能名（仅 `a-z0-9-`） |
| `validateDescription` | `core/skills.ts:117` | 校验描述（必填、不超长） |
| `loadSkillsFromDir` | `core/skills.ts:168` | 从目录启动技能加载 |
| `loadSkillsFromDirInternal` | `core/skills.ts:173` | 递归发现（命中 SKILL.md 即停） |
| `loadSkillFromFile` | `core/skills.ts:277` | 单文件解析与校验 |
| `formatSkillsForPrompt` | `core/skills.ts:335` | 生成 `<available_skills>` |
| `loadSkills` | `core/skills.ts:387` | 多来源汇总与去重 |
| `loadSkills`（运行时层） | `harness/skills.ts:49` | 环境无关的加载原语 |
| `formatSkillInvocation` | `harness/skills.ts:38` | 程序侧调用格式 |

## 38.13 常见问答

- **Q：技能一定要用 TypeScript 写吗？** 不需要。技能就是 Markdown 文件（`SKILL.md`），和编程语言无关。Pi 用 `read` 把正文读给模型看，模型按步骤调用工具去完成任务。
- **Q：一个目录里能放多个技能吗？** 可以，但要看目录结构：如果目录根直接有 `SKILL.md`，那它就代表“一个技能”，内部子目录不再当新技能；否则根下的每个 `.md` 各自算一个技能，子目录继续递归。
- **Q：disable-model-invocation 和普通的有什么区别？** 普通技能进 `<available_skills>`，模型可自动决定调用；设为 `true` 的只响应你显式的 `/skill:name`，不进自动候选，适合“危险”或“很专门”的技能。
- **Q：改了技能要重启 Pi 吗？** 不用，输入 `/reload` 即可让 `ResourceLoader` 重新扫描并加载新技能（见第 36 章）。

## 38.14 技能与提示词模板的关系

技能（`SKILL.md`）和提示词模板（第 36 章的 `/模板名`）常被混淆，区别其实清晰：

- **技能**：写给“模型”的长篇说明书，进 `<available_skills>`，由模型**自动决定**何时用 `read` 读进来。
- **提示词模板**：用户主动敲 `/名字 参数` 触发的**参数化片段**，由 `expandPromptTemplate`（`prompt-templates.ts:269`）把 `$1`/`$@` 等替换掉后，作为普通用户输入发出。

一个在“模型侧”被按需取用，一个在“用户输入侧”被显式调用——两者都是“把知识外置成 Markdown”，但触发时机和主动权完全不同。很多团队会同时用：提示词模板处理“我常用、但每次参数不同”的固定句式，技能处理“模型该自己想到去用”的专业流程。

> **提示**
>
> 判断该用哪个的简单标准：如果你希望“用户每次主动敲命令触发”，用提示词模板；如果你希望“模型在合适的任务里自动想起”，用技能。两者不互斥，常常配合使用。

## 自查清单

- [ ] 我能否说出“技能”与“插件/扩展”的本质区别？
- [ ] 我能否写出一个最小 `SKILL.md`（含 name / description / 正文）？
- [ ] 我能否解释技能的递归发现规则（命中 SKILL.md 即停递归，`core/skills.ts:173`）？
- [ ] 我能否说明 name / description 的校验规则与失败后果（`core/skills.ts:92`、`:117`、`:120`）？
- [ ] 我能否解释 `disable-model-invocation` 的作用（`core/skills.ts:316`）？
- [ ] 我能否解释 `formatSkillsForPrompt` 如何生成 `<available_skills>` 并过滤不可见技能（`core/skills.ts:335`、`:336`）？
- [ ] 我是否理解“只放目录、模型现读”的上下文节约设计？
- [ ] 我能否区分产品层与运行时层两套技能实现的分工（`core/skills.ts` vs `harness/skills.ts`）？
- [ ] 我能否说明 `/skill:name` 是如何被展开成 `<skill>` 块的（`agent-session.ts:1309`）？
