---
title: "第 39 章 · 斜杠命令与交互组件（概览）"
date: 2026-07-01
summary: "约定：行号来自 `packages/coding-agent/src/core/slash-commands.ts` 与 `packages/coding-agent/src/modes/interactive/` 下若干文件。"
tags:
  - pi
---
# 第 39 章 · 斜杠命令与交互组件（概览）

前面几章把 Pi 的内核、模式、资源、扩展、技能都讲完了。最后一章回到“人怎么和 Pi 打交道”：**斜杠命令（slash commands）** 与**交互组件（TUI components）**。前者是用户在输入框敲 `/xxx` 触发的动作，后者是交互模式用来画界面的一块块积木。

> 约定：行号来自 `packages/coding-agent/src/core/slash-commands.ts` 与 `packages/coding-agent/src/modes/interactive/` 下若干文件。

## 39.1 斜杠命令是什么

在交互模式输入框里输入以 `/` 开头的指令，就是斜杠命令。它分两类：

- **内置命令**：由 Pi 自己定义，例如 `/model`、`/session`、`/new`、`/compact`。
- **扩展命令**：由扩展通过 `pi.registerCommand` 注册（见第 37 章）。
- **资源型命令**：由技能（`/skill:name`）和提示词模板（`/模板名`）自动生成，它们不算“内置”，但会通过自动补全呈现给用户。

源码里内置命令的清单是 `BUILTIN_SLASH_COMMANDS`，定义在 `core/slash-commands.ts:19`–`slash-commands.ts:42`，共 23 条。每条有 `name`、`description`，部分还有 `argumentHint`（参数提示，如 `/model` 的 `<provider/model>`）。

`SlashCommandInfo` 接口（`slash-commands.ts:6`–`slash-commands.ts:11`）记录了命令的 `name`、`description`、`source`（`extension` / `prompt` / `skill`），这是自动补全与冲突检测统一依赖的数据结构。

> **说明**
>
> 注意：清空对话、退出等动作在 Pi 里多由**快捷键**触发（如 `app.clear`、`app.exit`，见 `interactive-mode.ts:920`–`:922` 的启动提示），并不都以斜杠命令形式存在。所以不要默认“所有操作都有 `/xxx`”——有些是键盘操作。

## 39.2 内置斜杠命令清单

下表直接对应 `BUILTIN_SLASH_COMMANDS`（`slash-commands.ts:19`）：

| 命令 | 作用 |
| --- | --- |
| `/settings` | 打开设置菜单 |
| `/model` | 选择模型（打开选择器 UI），可带 `<provider/model>` 参数 |
| `/scoped-models` | 启用/停用 Ctrl+P 循环切换的模型范围 |
| `/export` | 导出会话（默认 HTML，也可指定 `.html`/`.jsonl` 路径） |
| `/import` | 从 JSONL 文件导入并恢复会话 |
| `/share` | 把会话作为私密 GitHub gist 分享 |
| `/copy` | 复制上一条助手消息到剪贴板 |
| `/name` | 设置会话显示名 |
| `/session` | 显示会话信息与统计 |
| `/changelog` | 显示变更日志 |
| `/hotkeys` | 显示所有快捷键 |
| `/fork` | 从某条历史用户消息创建分支 |
| `/clone` | 在当前位置复制当前会话 |
| `/tree` | 浏览会话树（切换分支） |
| `/trust` | 保存项目信任决定 |
| `/login` | 配置 provider 认证（带 `<provider>` 参数） |
| `/logout` | 移除 provider 认证 |
| `/new` | 开始新会话 |
| `/compact` | 手动压缩会话上下文 |
| `/resume` | 恢复另一个会话 |
| `/reload` | 重新加载快捷键、扩展、技能、提示词、主题、上下文文件 |
| `/quit` | 退出 Pi |

此外，第 38 章讲过的 `/skill:name` 与提示词模板的 `/模板名` 也会作为命令出现——它们分别来自技能和提示词模板，通过自动补全提供给用户（`interactive-mode.ts` 的 `createBaseAutocompleteProvider` `interactive-mode.ts:641` 起）。

## 39.3 命令如何被识别与执行

当用户提交以 `/` 开头的输入，`AgentSession.prompt()` 会先尝试把它当扩展命令（或提示词模板）执行：

```ts
// packages/coding-agent/src/core/agent-session.ts:1116（prompt 入口）
async prompt(text: string, options?: PromptOptions): Promise<void> {
    // ...
    if (expandPromptTemplates && text.startsWith("/")) {        // :1124
        const handled = await this._tryExecuteExtensionCommand(text);  // :1125
        if (handled) { /* 已被扩展/模板消费，直接返回 */ return; }
    }
    // ...否则当作普通用户输入继续
}
```

`_tryExecuteExtensionCommand()`（`agent-session.ts:1278`）解析命令名与参数，向 `ExtensionRunner.getCommand()` 查询，找到就执行其 `handler`。内置命令（`/model`、`/session` 等）则**不在 AgentSession 这里处理**——它们由交互模式在更上层拦截，因为很多内置命令要弹出 TUI 选择器（如下面要讲的 `ModelSelectorComponent`），这只能在交互模式里完成。例如 `interactive-mode.ts:2889` 拦截 `/model`、`interactive-mode.ts:2955` 拦截 `/login`。

`SlashCommandInfo`（`slash-commands.ts:6`）的 `source` 字段帮助交互模式区分：来自 `extension` 的走 runner 派发，来自 `skill`/`prompt` 的走资源展开。

## 39.4 交互组件系统：40+ 块积木

交互模式不是“一个巨大的大界面”，而是由**许多小组件（components）**拼起来的。在 `modes/interactive/components/` 目录下有 40 多个组件文件，例如：

```text
assistant-message.ts   用户/助手消息渲染
tool-execution.ts      工具调用的展开/动画
bash-execution.ts      用户输入的 bash 命令
session-selector.ts    会话选择/恢复界面
tree-selector.ts       会话树浏览界面
model-selector.ts      模型选择界面
footer.ts / status-indicator.ts  状态栏与状态指示
diff.ts / markdown-transform.ts  差异与 markdown 渲染
extension-selector.ts / extension-input.ts  扩展相关 UI
oauth-selector.ts / login-dialog.ts  登录相关 UI
keybinding-hints.ts / theme-selector.ts  快捷键与主题
...（共 40+ 个）
```

每个组件通常实现一个统一的组件契约：有 `render(width/height)` 负责把自己画成一串字符串行，有 `handleInput(key)` 负责响应按键（如 `session-selector.ts:532` 的 `SessionList.handleInput`）。这种“契约化”让交互模式可以像搭积木一样把它们塞进容器。

> **提示**
>
> 这种“积木式”UI 的好处是**高复用、低耦合**：模型选择器 `ModelSelectorComponent` 既能被 `/model` 用，也能被 Ctrl+P 循环时弹出；会话选择器 `SessionSelectorComponent` 既服务 `/resume`，也服务启动时的恢复。一个组件只管“把自己画好、把自己的输入处理好”。

## 39.5 交互模式如何组装组件

`InteractiveMode` 类（`interactive-mode.ts:388`）就是“总装车间”。它在构造函数（`interactive-mode.ts:531`）里创建一堆容器：

```ts
// packages/coding-agent/src/modes/interactive/interactive-mode.ts:551 起
this.headerContainer = new Container();          // logo + 快捷键提示
this.loadedResourcesContainer = new Container(); // [Skills]/[Prompts]...
this.chatContainer = new Container();             // 消息流
this.pendingMessagesContainer = new Container();  // 待发消息
this.statusContainer = new Container();           // 状态条
this.widgetContainerAbove = new Container();
this.widgetContainerBelow = new Container();
this.footerContainer = new Container();           // 页脚统计
```

`init()`（`interactive-mode.ts:842`）把这些容器挂载到 TUI 上（`mountInteractiveTui` `interactive-mode.ts:891`），并按垂直布局（`TuiLayouts.VStack` `interactive-mode.ts:879`）叠放：待发消息 → 状态 → 上方组件 → 编辑器 → 下方组件 → 页脚。

其中几个“重组件”会出现在界面里：

- `SessionSelectorComponent`：会话恢复/选择。
- `TreeSelectorComponent`：会话树浏览（`/tree`）。
- `ModelSelectorComponent`：模型选择（`/model`）。

它们通过交互模式的 `bindCurrentSessionExtensions()`（`interactive-mode.ts:1820`）等逻辑接入扩展的 UI 上下文，从而让扩展也能弹出自己的选择器。

## 39.6 三个典型组件速写

**（1）会话选择器 `SessionSelectorComponent`**（`session-selector.ts:685`）
负责“恢复/切换会话”。内部 `SessionList`（`session-selector.ts:283`）维护扁平化后的会话树（`buildSessionTree` `session-selector.ts:209`、`flattenSessionTree` `session-selector.ts:259`），支持搜索、排序（threaded/recent/fuzzy）、按 scope（当前文件夹/全部）切换（`loadScope` `session-selector.ts:922`、`toggleScope` `session-selector.ts:1003`）、删除（优先进回收站，`deleteSessionFile` `session-selector.ts:645`）、重命名。`handleInput`（`session-selector.ts:532`）把上下键、回车、Tab、删除等键映射到对应动作。

**（2）会话树选择器 `TreeSelectorComponent`**（`tree-selector.ts:1328`）
用于 `/tree` 在会话历史里“跳到任意节点/分支”。核心 `TreeList`（`tree-selector.ts:106`）把会话树扁平化成可滚动列表，画出 `├─`/`└─`/`│` 的 ASCII 树形（`render` `tree-selector.ts:664`），并支持多档过滤（`FilterMode` `tree-selector.ts:95`：default / no-tools / user-only / labeled-only / all）、折叠、标注（label）、搜索。`handleInput`（`tree-selector.ts:996`）非常长，几乎把每个键都接到了具体行为上。

**（3）模型选择器 `ModelSelectorComponent`**（`model-selector.ts:35`）
用于 `/model` 或 Ctrl+P。它先从快照加载模型（`loadModelsFromSnapshot` `model-selector.ts:139`），再在后台刷新模型目录（`refreshModels` `model-selector.ts:162`），支持搜索（`filterModels` `model-selector.ts:244`，内部用 `fuzzyFilter`）、全部/作用域（scoped）切换、回车选定并写入默认设置（`handleSelect` `model-selector.ts:363`）。

```text
   InteractiveMode（总装车间）        interactive-mode.ts:388
        │ 构造时建 Container（:551）
        │ init() 时挂载并布局（:842 / :879 / :891）
        ▼
   ┌──────────────── 组件垂直叠放 ────────────────┐
   │  headerContainer（logo + 快捷键提示）         │
   │  loadedResourcesContainer（[Skills]等）       │
   │  chatContainer（消息流）                      │
   │  pendingMessagesContainer（待发消息）         │
   │  statusContainer（状态条）                    │
   │  editorContainer（输入框，CustomEditor）      │
   │  footerContainer（页脚统计）                  │
   └──────────────────────────────────────────────┘
        其中 /model /tree /resume 会弹出
        ModelSelector / TreeSelector / SessionSelector 组件
```

## 39.7 一条内置命令的完整旅程（以 /model 为例）

把命令系统和组件系统连起来看 `/model` 怎么走：

```text
用户敲 /model 并回车
      │
      ▼
交互模式输入循环捕获，text === "/model"?  →  interactive-mode.ts:2889
      │  拦截，不交给 AgentSession.prompt
      ▼
弹出 ModelSelectorComponent          model-selector.ts:35
      │  用户上下选、回车
      ▼
handleSelect(model) 写入默认设置        model-selector.ts:363
      │
      ▼
回到输入框，等待下一条用户输入
```

可以看到：内置命令是“交互模式自己消化”的，它借组件系统完成 UI，再回头影响会话状态（如默认模型）。这与扩展命令“经 AgentSession 派发到 ExtensionRunner”是两条不同的路径，但最终都服务于用户的意图。

## 39.8 自动补全：命令与组件的桥梁

交互模式的输入框不是“盲打”——它用 `createBaseAutocompleteProvider()`（`interactive-mode.ts:641`）把所有可用命令（内置 + 扩展 + 提示词模板 + 技能）汇总成一个 `CombinedAutocompleteProvider`。这样用户敲 `/` 时就能看到候选，敲 `/model ` 时还能补全 `<provider/model>`（见 `interactive-mode.ts:2889` 一带的处理），敲 `/login ` 时补全 provider（`interactive-mode.ts:2955` 一带）。

> **说明**
>
> 这里能看到一个贯穿全书的主题：**命令、技能、提示词模板、扩展，最终在“自动补全”这一层汇合**。它们来源不同，但都通过各自的“清单”（`BUILTIN_SLASH_COMMANDS`、扩展注册表、资源加载器结果）被收集，呈现给用户同一个顺滑的输入体验。

## 39.9 小结

斜杠命令与交互组件是“人—Pi”界面的两端：

- **斜杠命令**（`slash-commands.ts:19` 的 `BUILTIN_SLASH_COMMANDS`，共 23 条）提供可发现的动作入口；内置命令由交互模式拦截处理，扩展命令经 `AgentSession` 派发到 `ExtensionRunner`。
- **交互组件**（40+ 个 `components/*.ts`）是界面的积木；`InteractiveMode` 把它们摆进容器、按 `VStack` 布局叠放（`interactive-mode.ts:879`），并在需要时弹出选择器（会话/树/模型）。

到这一章，Pi 从“操作系统参数”到“终端界面上的一个 `/model` 弹窗”的完整链路，你都已经走通了。

## 39.10 组件契约：render 与 handleInput

前面说组件“像积木”，那每块积木长什么样？交互模式里的组件普遍遵循一个简单契约：

- **`render(width, height?): string[]`** —— 把自己画成一串字符串行，交给 TUI 框架拼接。例如 `tree-selector.ts:664` 的 `TreeList.render` 就负责画出那棵 `├─`/`└─`/`│` 的 ASCII 树。
- **`handleInput(key): void`** —— 接收按键，更新自己的内部状态，可能触发回调（如 `session-selector.ts:532` 的 `handleInput` 把方向键映射到移动选中项）。
- 实现 `Focusable` 的组件还能“获得键盘焦点”：同一时刻通常只有一个焦点组件在吃按键，其余组件忽略输入。这让“在几十个组件共存的界面里，敲键盘只会作用在编辑器或当前弹窗上”。

一个极简的组件骨架（示意，非源码）：

```text
class MyCounter implements Component, Focusable {
  private n = 0;
  render(): string[] { return [`计数: ${this.n}`]; }   // 画一行
  handleInput(key) { if (key === "up") this.n++; }      // 上键 +1
}
```

正是这种“统一接口 + 焦点管理”，让交互模式能把 40+ 个组件自由组合成复杂界面，而不必为每块单独写一套事件路由。

## 39.11 更多内置命令的使用场景

内置命令不是装饰，而是日常高频动作：

- **`/compact`**：聊太久、上下文快满时手动压缩，把历史会话摘要成更短的一段，腾出空间继续工作（底层即第 34 章的 `AgentSession.compact()`）。
- **`/export`**：把当前会话导出成 HTML（默认）或 JSONL，方便分享或存档；JSONL 还能被 `/import` 再读回来。
- **`/fork` 与 `/clone`**：想“试两条不同思路又不想破坏当前会话”时，`/fork` 从历史某条用户消息分叉、`/clone` 直接复制当前会话，两个都是“无损实验”的工具。
- **`/trust`**：首次在陌生项目里运行 Pi 时，记录你对“是否信任该项目可自动执行命令”的决定，避免每次都弹确认。

这些命令和斜杠命令清单、自动补全、组件系统一起，构成了 Pi “人—机交互”的完整闭环。

## 39.12 组件速查表

把本章点名的组件与关键方法列在这里，方便回查：

| 组件 / 方法 | 文件:行号 | 职责 |
| --- | --- | --- |
| `InteractiveMode` | `interactive-mode.ts:388` | 总装车间，组装所有组件 |
| 容器创建 | `interactive-mode.ts:551` | 建各 `Container` |
| 布局挂载 | `interactive-mode.ts:879` / `:891` | `VStack` 垂直叠放并挂载 |
| 自动补全 | `interactive-mode.ts:641` | 汇总所有命令/技能/模板 |
| `SessionSelectorComponent` | `session-selector.ts:685` | 会话恢复/选择 |
| `buildSessionTree` / `flattenSessionTree` | `session-selector.ts:209` / `:259` | 会话树构建与扁平化 |
| `TreeSelectorComponent` | `tree-selector.ts:1328` | 会话树浏览 |
| `TreeList.render` | `tree-selector.ts:664` | 画 ASCII 树形 |
| `FilterMode` | `tree-selector.ts:95` | 多档过滤枚举 |
| `ModelSelectorComponent` | `model-selector.ts:35` | 模型选择 |
| `loadModelsFromSnapshot` / `refreshModels` | `model-selector.ts:139` / `:162` | 加载/刷新模型 |
| `filterModels` | `model-selector.ts:244` | 模糊搜索过滤 |

## 自查清单

- [ ] 我能否说出斜杠命令分哪几类（内置 vs 扩展 vs 资源型）及其定义位置（`slash-commands.ts:19`，共 23 条）？
- [ ] 我能否列出至少 8 个常用内置斜杠命令及其作用？
- [ ] 我能否解释“清空/退出”多为快捷键而非斜杠命令（`interactive-mode.ts:920`–`:922`）？
- [ ] 我能否说明 `/` 开头的输入如何被派发（`agent-session.ts:1116`、`:1124`、`:1278`）？
- [ ] 我能否指出内置命令为何由交互模式拦截（`/model` 在 `:2889`、`/login` 在 `:2955`）？
- [ ] 我能否指出交互组件目录有 40+ 个组件，并举例 3 个？
- [ ] 我能否描述 `InteractiveMode` 如何把容器组装成布局（`:551`、`:879`、`:891`）？
- [ ] 我能否简述会话选择器、树选择器、模型选择器各自的职责与关键行号？
- [ ] 我是否理解自动补全如何把命令/技能/模板/扩展汇集成统一体验（`interactive-mode.ts:641`）？
- [ ] 我能否复述“以 /model 为例”的内置命令完整旅程？
