---
title: "第 36 章 · 系统提示词构建与资源加载"
date: 2026-07-01
summary: "约定：行号来自 `packages/coding-agent/src/core/` 下三个文件——`system-prompt.ts`、`resource-loader.ts`、`prompt-templates.ts`。"
tags:
  - pi
---
# 第 36 章 · 系统提示词构建与资源加载

前面几章我们多次看到 `AgentSession` 会“构建系统提示词”“加载资源”。本章深入这两件事：`buildSystemPrompt()` 怎么把一堆素材拼成那段喂给大模型的系统提示词，以及 `ResourceLoader` 这个“资源加载中枢”如何从扩展、技能、提示词模板、主题、上下文文件里把所有素材汇总起来。

> 约定：行号来自 `packages/coding-agent/src/core/` 下三个文件——`system-prompt.ts`、`resource-loader.ts`、`prompt-templates.ts`。

## 36.1 系统提示词是什么

“系统提示词（system prompt）”是每次请求大模型时，排在最前面、用来给模型定规则的一段话。它决定模型“是什么身份、有什么工具、该遵守什么准则”。在 Pi 里，它由 `buildSystemPrompt()` 构建，定义在 `system-prompt.ts:28`–`system-prompt.ts:162`，选项接口 `BuildSystemPromptOptions` 在 `system-prompt.ts:8`–`system-prompt.ts:25`。

一个典型的 Pi 系统提示词会包含这些部分：

- 身份声明：“你是一个在 pi 内部工作的专家级编码助手……”（`system-prompt.ts:121` 附近的默认文案）。
- 可用工具列表（read / bash / edit / write 等）。
- 操作准则（guidelines）。
- 文档路径指引。
- `<project_context>` 项目上下文（由资源加载器提供，见 `system-prompt.ts:55`–`system-prompt.ts:60`、`:145`–`:152`）。
- `<available_skills>` 可用技能（由 `formatSkillsForPrompt` 生成，`system-prompt.ts:156` 调用）。
- 末尾附上当前工作目录 `cwd`（`system-prompt.ts:159`）。

拼好之后，真实系统提示词的骨架大致像这样：

```text
You are an expert coding assistant operating inside pi, a coding agent harness. ...

Available tools:
- read: ...
- bash: ...
...

Guidelines:
- Be concise in your responses
...

<project_context>
  <project_instructions path="/repo/AGENTS.md">本项目用 TypeScript...</project_instructions>
</project_context>

<available_skills>
  <skill><name>pdf-extractor</name>...</skill>
</available_skills>

Current working directory: /Users/me/project
```

> **提示**
>
> 系统提示词不是“给人类看的”，而是“给模型看的说明书”。它的质量直接影响模型表现。Pi 把它的组装做成**可观察、可定制**的流程，正是为了让你能用 AGENTS.md、SYSTEM.md、技能去“教”模型适配你的项目。

## 36.2 组装逻辑：buildSystemPrompt

`buildSystemPrompt(options)` 是一个纯函数：给它一组选项，它返回一段完整字符串。关键输入来自 `BuildSystemPromptOptions`（`system-prompt.ts:8`）：

- `cwd`：当前工作目录（`system-prompt.ts:20`）。
- `skills`：加载到的技能列表。
- `contextFiles`：项目上下文文件（AGENTS.md 等）。
- `customPrompt`：用户自定义的系统提示词（如 `SYSTEM.md`）。
- `appendSystemPrompt`：追加的提示词片段。
- `selectedTools` / `toolSnippets` / `promptGuidelines`：当前启用的工具及其说明。

```ts
// packages/coding-agent/src/core/system-prompt.ts:28（节选签名）
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    // ...拼接身份 + 工具 + 准则 + 项目上下文 + 技能 + cwd...
}
```

它的拼接顺序是固定的（对照源码 `system-prompt.ts:121`–`:159`）：

1. 写身份（`You are an expert coding assistant...`，`:121`）。
2. 列工具（`Available tools:`）。
3. 写准则（`Guidelines:`）。
4. 追加文档路径指引。
5. 若 `contextFiles` 非空，包进 `<project_context>`（`:145`–`:152`）。
6. 若 `hasRead` 且有技能，追加 `<available_skills>`（`:155`–`:156`）。
7. 最后补 `Current working directory: <cwd>`（`:159`）。

注意 `buildSystemPrompt` 是**无状态的**：它不知道“这次是哪个会话”，只负责“把素材拼好”。真正的素材收集发生在 `AgentSession._rebuildSystemPrompt()`（`agent-session.ts:1023`–`agent-session.ts:1057`），它从 `_resourceLoader` 取技能、上下文文件，再调用 `buildSystemPrompt` 拼装，并把结果缓存到 `_baseSystemPrompt`。

> **提示**
>
> 为什么要把“构建”和“素材收集”分开？因为系统提示词在每次切换工具、切换模型、加载扩展后都可能变化。Pi 把“拼装规则”做成纯函数 `buildSystemPrompt`，把“去哪取素材”交给 `AgentSession` + `ResourceLoader`，这样两边都能独立测试与复用。

## 36.3 资源加载中枢：ResourceLoader

光有拼装规则不够——那些技能、上下文文件、提示词模板、主题、扩展**从哪来**？答案是 `ResourceLoader`，接口定义在 `resource-loader.ts:39`–`resource-loader.ts:51`，具体实现 `DefaultResourceLoader` 在 `resource-loader.ts:195`–`resource-loader.ts:1096`。

你可以把它理解成 Pi 的**“素材快递站”**：启动时（以及 `/reload`、会话切换时）它会去一堆地方扫描，把找到的资源汇总成结构化的结果，供 `buildSystemPrompt` 和界面取用。`ResourceLoader` 提供的方法（接口见 `resource-loader.ts:40`–`:45`）：

| 方法 | 返回内容 |
| --- | --- |
| `getExtensions()` | 已加载的扩展 |
| `getSkills()` | 已加载的技能（`resource-loader.ts:41`） |
| `getPrompts()` | 提示词模板（`resource-loader.ts:42`） |
| `getThemes()` | 主题（`resource-loader.ts:43`） |
| `getAgentsFiles()` | 项目上下文文件（AGENTS.md / CLAUDE.md）（`resource-loader.ts:44`） |
| `getSystemPrompt()` | 用户自定义系统提示词（`resource-loader.ts:45`） |

这些方法都是“即时读取缓存结果”的轻量调用：真正的重活（扫描磁盘、解析）发生在 `reload()` 里，方法只是把已经汇总好的结果返回给调用方。

## 36.4 上下文文件：项目里的 AGENTS.md

`ResourceLoader` 会沿目录向上查找 `AGENTS.md` / `CLAUDE.md` 这类上下文文件，由 `loadProjectContextFiles()` 完成（`resource-loader.ts:118`–`resource-loader.ts:156`）。找到后，这些文件内容会被放进 `<project_context>`，最终塞进系统提示词（`system-prompt.ts:55` 起）。

这就是为什么你在项目根目录放一个 `AGENTS.md` 写“本项目用 TypeScript、禁止 any”，Pi 就会“懂”这个项目——它把文件内容原样喂给了模型。

```ts
// packages/coding-agent/src/core/resource-loader.ts:118（节选签名）
export function loadProjectContextFiles(options: {
    startDir: string;
    additionalDirs?: string[];
}): { agentsFiles: Array<{ path: string; content: string }> } {
    // 从 startDir 向上逐层查找 AGENTS.md / CLAUDE.md
}
```

一个具体例子：

```text
# 你的项目根目录 AGENTS.md
本项目是 Node 库，使用 TypeScript 严格模式。
提交信息遵循 Conventional Commits。
测试用 vitest。
```

```text
# Pi 构建出的系统提示词片段
<project_context>
  <project_instructions path="/repo/AGENTS.md">
  本项目是 Node 库，使用 TypeScript 严格模式。...
  </project_instructions>
</project_context>
```

## 36.5 主题与自定义提示词：其它 getter

`ResourceLoader` 不只是管“文本素材”，它还是主题的源头：

- `getThemes()`（`resource-loader.ts:43` / `:315`）返回所有可用主题，供 `/theme` 切换界面用。
- `getSystemPrompt()`（`resource-loader.ts:45` / `:323`）返回用户自定义的 `SYSTEM.md` 内容（下文 §36.7）。

此外，`extendResources()`（`resource-loader.ts:49` / `:339`）允许在运行中追加新的资源路径——这是扩展或 SDK 在“已经加载过一次”之后，还能把额外资源塞进汇总结果的通道。

## 36.6 重载：reload()

当调用 `/reload`、或会话切换时，`ResourceLoader.reload()`（`resource-loader.ts:387`–`resource-loader.ts:546`）会重新扫描所有资源：**扩展、技能、提示词、主题、上下文文件**都会被重新解析。它内部调用 `extendResources()`（`resource-loader.ts:339`–`resource-loader.ts:377`）把新扫描结果合并进去。

这也是为什么改了 `AGENTS.md`、加了新技能后，不用重启 Pi——`/reload` 一下，`reload()` 就重新把素材汇总好。

```text
用户按 /reload
      │
      ▼
ResourceLoader.reload()        resource-loader.ts:387
  ├─ 重新加载扩展（扩展的注册逻辑可能重跑）
  ├─ 重新扫描技能目录
  ├─ 重新解析提示词模板
  ├─ 重新读取主题
  └─ 重新向上查找 AGENTS.md
      │
      ▼
AgentSession 重建系统提示词（_rebuildSystemPrompt）
```

> **说明**
>
> `reload()` 非常“重”：它会重新加载扩展（可能重新执行扩展的注册逻辑）、重新解析所有技能与提示词。开发扩展时频繁 `/reload` 是常态，但生产环境一般只在确实改动资源后才做。

## 36.7 自定义系统提示词：SYSTEM.md

除了拼装默认内容，Pi 还支持用户用 `SYSTEM.md` 完全覆盖/自定义系统提示词。`discoverSystemPromptFile()`（`resource-loader.ts:1022`–`resource-loader.ts:1034`）会去查找这个文件。找到后，其内容与 `getSystemPrompt()`（`resource-loader.ts:323`）对接，在 `buildSystemPrompt` 里通过 `customPrompt` 选项注入。

> 注意区分：`AGENTS.md` 是“项目指令”，被包进 `<project_context>`；`SYSTEM.md` 是“系统提示词改写/追加”，优先级更高，直接替换或补充模型身份段。两者都是“用文件教模型”，但作用层级不同。

## 36.8 扩展冲突检测

因为资源可能来自多个地方（用户级、项目级、npm 包、git），同名资源会冲突。`detectExtensionConflicts()`（`resource-loader.ts:1059`–`resource-loader.ts:1095`）负责在加载时检测并报告冲突，让“赢家”生效、“输家”被跳过但给出提示。这也是第 39 章会看到的“Skill conflicts / Extension issues”启动提示的来源之一。

## 36.9 提示词模板：bash 风格参数解析

除了技能，Pi 还支持“提示词模板（prompt templates）”——一种可以带参数的 `/命令`。相关逻辑在 `prompt-templates.ts`。

核心是两段解析：

- `parseCommandArgs()`（`prompt-templates.ts:24`–`prompt-templates.ts:55`）：以 **bash 风格**解析参数，支持引号包裹、转义。例如 `"hello world"` 会被当成一个参数。
- `substituteArgs()`（`prompt-templates.ts:70`–`prompt-templates.ts:102`）：做变量替换，支持 `$1`、`$@`、`${N:-默认值}`、`${@:N:L}` 等 bash 习惯写法。

```ts
// packages/coding-agent/src/core/prompt-templates.ts:70（节选签名）
export function substituteArgs(content: string, args: string[]): string {
    // 支持 $1 / $@ / ${N:-default} / ${@:N:L}
}
```

一个具体替换例子：

```text
模板内容：  "给文件 $1 写单元测试，重点覆盖 ${2:-边界条件}"
用户输入：  /ut src/foo.ts 异常分支
替换结果：  "给文件 src/foo.ts 写单元测试，重点覆盖 异常分支"
```

加载模板由 `loadPromptTemplates()` 完成（`prompt-templates.ts:194`–`prompt-templates.ts:263`），实际展开由 `expandPromptTemplate()`（`prompt-templates.ts:269`–`prompt-templates.ts:285`）在用户输入 `/name args` 时触发——这正好在第 34 章 `prompt()` 的“展开提示词模板”那一步（`agent-session.ts:1163`）被调用。

## 36.10 整体数据流（ASCII）

```text
   磁盘上的各种资源
   ├─ AGENTS.md / CLAUDE.md   (项目上下文)
   ├─ *.md 技能 (SKILL.md)
   ├─ 提示词模板 (/命令)
   ├─ 主题 (theme)
   ├─ SYSTEM.md (自定义系统提示词)
   └─ 扩展 (extensions)
            │
            ▼
   ResourceLoader.reload()         resource-loader.ts:387
   (扫描 + 汇总 + 冲突检测)
            │  getSkills / getAgentsFiles / getPrompts / getThemes / getSystemPrompt
            ▼
   AgentSession._rebuildSystemPrompt()   agent-session.ts:1023
   从 resourceLoader 取出 skills / contextFiles / prompts
            │
            ▼
   buildSystemPrompt(options)       system-prompt.ts:28
   拼成最终 system prompt 字符串（身份→工具→准则→project_context→skills→cwd）
            │
            ▼
   缓存进 _baseSystemPrompt，随 prompt() 一起喂给模型
```

## 36.11 小结

系统提示词不是写死的一段话，而是由 `ResourceLoader` 从一堆文件里“现采现拼”出来的。`buildSystemPrompt` 负责拼装规则，`ResourceLoader` 负责素材汇总，提示词模板则给 `/命令` 提供 bash 风格的参数能力。三者协作，让 Pi 既能“开箱即用”，又能被项目级配置深度定制。

> **提示**
>
> 想快速验证你改的资源有没有生效？在交互模式输入 `/session` 或看启动时的“[Context] / [Skills] / [Prompts] / [Extensions]”列表（由 `interactive-mode.ts` 的 `showLoadedResources` 渲染）——它们都直接来自 `ResourceLoader` 的汇总结果。

## 自查清单

- [ ] 我能否解释“系统提示词”是什么、由谁构建（`system-prompt.ts:28`）？
- [ ] 我能否说出 `BuildSystemPromptOptions` 的主要字段（`system-prompt.ts:8`）？
- [ ] 我能否按源码顺序复述 `buildSystemPrompt` 的拼接步骤（`:121`→`:145`→`:156`→`:159`）？
- [ ] 我能否说明 `ResourceLoader` 的“素材快递站”定位及其 6 个 getter（`resource-loader.ts:39`）？
- [ ] 我能否指出 AGENTS.md 如何变成 `<project_context>`（`resource-loader.ts:118`、`:145`）？
- [ ] 我能否区分 `AGENTS.md`（项目指令）与 `SYSTEM.md`（系统提示词改写）？
- [ ] 我能否解释 `/reload` 为何能重新加载资源（`reload()` 在 `resource-loader.ts:387`）？
- [ ] 我能否说明 SYSTEM.md 如何自定义系统提示词（`discoverSystemPromptFile` 在 `resource-loader.ts:1022`）？
- [ ] 我是否理解提示词模板的 bash 风格参数解析（`parseCommandArgs` `prompt-templates.ts:24`、`substituteArgs` `:70`）并举一例？
- [ ] 我能否画出从“磁盘资源”到“系统提示词”的整体数据流？
