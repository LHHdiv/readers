---
title: "第 40 章 · TUI 框架与差分渲染"
date: 2026-07-01
summary: "**黑话速查**"
tags:
  - pi
---
# 第 40 章 · TUI 框架与差分渲染

> **黑话速查**
> - **TUI（Terminal UI）**：终端用户界面，指在字符终端里画图、接收按键的程序，区别于浏览器里的 GUI。
> - **组件（Component）**：屏幕上一段可独立渲染、可接收输入的 UI 单元，比如一个编辑器、一段 Markdown。
> - **差分渲染（Differential Rendering）**：只重绘"发生变化"的终端行，而不是把整屏擦掉重新画。
> - **帧缓冲（Frame Buffer）**：程序在内存里先算好"这一帧应该长什么样"的字符数组，再和上一帧比较。
> - **Kitty 键盘协议**：一种让终端能精确上报"哪个键、哪种修饰符、按下/松开"的现代键盘编码方案。
> - **LaTeX**：一种数学公式排版语言，Pi 在终端里把它渲染成近似的 Unicode 字符。

## 先建立直觉

想象你在和一个 AI 智能体聊天。屏幕上方是它刚生成的回答，下方是你可以输入问题的编辑框，最底下还有一个小状态栏显示"正在思考…"。这些区域每时每刻都在变：回答在流式吐字、光标在闪烁、状态栏在更新。

如果每一次变化都把整个终端清屏重画，会有两个毛病：

1. **闪屏**：整屏重画时先变黑再变亮，肉眼能感觉到 flicker（闪烁）。
2. **慢**：一个屏幕可能有几百行，但某一刻其实只有一两行变了，重画全部纯属浪费。

Pi 的做法像"改作文"而不是"重写作文"：它先在内存里算出这一帧完整的样子（帧缓冲），再和上一帧逐行对比，只把**真正不同的那些行**写到终端上。这就是本章要讲的**差分渲染**。

而支撑这一切的，是 Pi 自己写的一套终端 UI 框架，代码都在 `packages/tui/` 里。

> **说明**
>
> Pi 为什么不用现成的终端 UI 库（比如 ink、blessed）？因为它的需求很特殊：要在同一个屏幕里同时容纳流式 Markdown、可交互编辑器、LaTeX 公式、图片占位，还要在键盘事件上支持精确到"按下/重复/松开"的 Kitty 协议。现成库要么不够灵活，要么对差分渲染的控制粒度不够细，所以 Pi 自研了这套框架。

## 为什么 Pi 要自研终端 UI

先回答一个根本问题：智能体的"脸"为什么要自己画？

- **实时性要求高**：AI 回答是逐字流出来的，屏幕必须跟着流畅滚动，不能卡顿。
- **内容形态杂**：同一屏里既有富文本（Markdown），又有可编辑输入框，还有公式和图片。
- **键盘交互细**：智能体需要区分"用户按住 Ctrl 再按 C 是要中断，还是粘贴"，普通终端库分辨不了这么细。
- **可远程驱动**：Pi 的 TUI 并不只给人用，它还能被 IDE、编辑器通过协议远程控制（见第 41 章）。自研框架让这套渲染逻辑可以被复用和测试。

所以 Pi 把 UI 抽象成"组件树 + 帧缓冲 + 差分输出"三层，下面逐一拆解。

## 组件模型：Component 接口与 TuiBase

### Component 接口

任何能在屏幕上显示的东西，都实现 `Component` 接口。它最核心的三个方法是 `render`、`handleInput` 和 `invalidate`，定义在 `packages/tui/src/tui.ts:23`：

```ts
// packages/tui/src/tui.ts:23
export interface Component {
	render(width: number): string[];
	handleInput?(data: string, key: Key): void;
	invalidate(): void;
	wantsKeyRelease?(): boolean;
}
```

- `render(width)`：给定当前终端宽度，返回这一帧该组件要画的若干行（字符串数组）。
- `handleInput(data, key)`：用户按键时调用，`key` 是已经被解析过的结构化按键（见后文键盘解析）。
- `invalidate()`：组件告诉框架"我的内容变了，请安排一次重绘"。
- `wantsKeyRelease?()`：少数组件（比如编辑器）想收到"按键松开"事件，才返回 `true`。

### Container 与 TuiBase（组合模式）

单个组件太小，屏幕是很多组件拼起来的。Pi 用**组合模式**：`Container` 本身也是一个 `Component`，但它内部持有子组件数组，渲染时把子组件一行一行拼起来，见 `packages/tui/src/tui.ts:211`：

```ts
// packages/tui/src/tui.ts:211
export class Container implements Component {
	#children: Component[] = [];
	render(width: number): string[] {
		// 依次渲染每个子组件，把它们的行拼接成一大块
	}
}
```

最顶层的应用界面 `TuiMainScreen` 继承自抽象类 `TuiBase`，而 `TuiBase` 又继承自 `Container`，见 `packages/tui/src/tui.ts:331`：

```ts
// packages/tui/src/tui.ts:331
export abstract class TuiBase extends Container implements TUI {
	// 调度渲染、处理终端输入、维护帧缓冲
}
```

这样，无论一个组件多复杂（编辑器、Markdown、状态栏），对框架来说它都是"一个能 render 的方块"，可以像搭积木一样组合。

> **提示**
>
> **组合模式的妙处**：父组件不需要知道子组件内部怎么画，只要子组件遵守 `render(width)` 约定，就能被任意嵌套。这让 Pi 的界面可以像 HTML 的 `<div>` 嵌套一样自由组合，但运行在纯终端里。

## 差分渲染：只重绘变化的地方

这是本章的重点。`TuiMainScreen` 在 `packages/tui/src/tui-main-screen.ts:57` 实现，真正的重绘逻辑在 `doRender()`（`packages/tui/src/tui-main-screen.ts:180`）。它先把整屏算成 `newLines` 数组，再和 `previousLines` 比较。

### 三种重绘策略

Pi 不是"永远只改一行"，而是按情况选择三种策略之一：

**策略一：全屏重绘（fullRender）**

当结构发生根本性变化时，局部修补反而麻烦，于是直接整屏重画。触发条件包括：

- 首帧（之前没有内容）：`packages/tui/src/tui-main-screen.ts:263`
- 终端**宽度**变了（换行位置全乱）：`packages/tui/src/tui-main-screen.ts:270`
- 终端**高度**变了（非 Termux 环境）：`packages/tui/src/tui-main-screen.ts:279`
- 内容缩水且开启 clearOnShrink：`packages/tui/src/tui-main-screen.ts:288`
- 变化区域超出了当前可视区（只能全屏对齐）：`packages/tui/src/tui-main-screen.ts:382`

全屏重绘会先输出 `\x1b[?2026h`（开始"同步输出"，让终端一次性刷新不闪烁），再画全部内容，见 `packages/tui/src/tui-main-screen.ts:210`。

**策略二：追加模式（append）**

当只是**在末尾新增了若干行**（比如流式吐字），不需要重画上面已有的内容。Pi 会把光标移到旧内容末尾，向下滚动并只写新行，见 `packages/tui/src/tui-main-screen.ts:321` 的 `appendStart` 判断。

**策略三：局部增量重绘（differential）**

最常用也最精妙。Pi 逐行比较新旧帧，找出**第一行变化**和**最后一行变化**的位置：

```ts
// packages/tui/src/tui-main-screen.ts:294
let firstChanged = -1;
let lastChanged = -1;
for (let i = 0; i < maxLines; i++) {
	const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
	const newLine = i < newLines.length ? newLines[i] : "";
	if (oldLine !== newLine) {
		if (firstChanged === -1) firstChanged = i;
		lastChanged = i;
	}
}
```

然后把光标移动到 `firstChanged` 那一行，只重画从 `firstChanged` 到 `lastChanged` 之间的行（每行先 `\x1b[2K` 清掉再写新内容）：

```ts
// packages/tui/src/tui-main-screen.ts:388
let buffer = "\x1b[?2026h"; // 开始同步输出
// ...移动光标到 firstChanged...
// packages/tui/src/tui-main-screen.ts:420
for (let i = firstChanged; i <= renderEnd; i++) {
	if (i > firstChanged) buffer += "\r\n";
	buffer += "\x1b[2K"; // 清当前行
	buffer += line;       // 写新内容
}
```

注释里写得很直白：只重绘变更行能"减少单行变化（比如转圈动画 spinner）时的闪烁"，见 `packages/tui/src/tui-main-screen.ts:417`。

### 状态到差分渲染的流程图

```
       组件状态变化 (invalidate)
                  │
                  ▼
       调度器安排一次重绘
       (requestRender / scheduleRender)
                  │
                  ▼
       TuiMainScreen.doRender()
       算出 newLines（完整帧缓冲）
                  │
                  ▼
   逐行比较 newLines vs previousLines
                  │
      ┌───────────┼───────────────────────┐
      │           │                       │
   无变化      有结构变化               有局部变化
 （只移动     （宽度/高度/首帧/         （找 first/last
   光标）       超视区）                   changed）
      │           │                       │
      │     全屏重绘 fullRender      局部增量重绘
      │     （清屏重画全部）          （只写 changed 行）
      ▼           ▼                       ▼
   └───────────► 写入终端 ◄──────────────┘
                  │
                  ▼
       更新 previousLines = newLines
```

> **说明**
>
> **为什么"同步输出" `\x1b[?2026h` 很重要？** 没有它时，终端会一边收到字符一边立即显示，局部重绘的中间态（比如光标移动过程）会闪一下。用同步输出把一批字符包起来，终端会等整批收齐再一次性刷新，肉眼看到的就是"瞬间变化、没有撕裂感"。

### 渲染调度：别让每次按键都重画

频繁的内容变化（比如打字）如果每下都立刻重画，会卡。Pi 用节流：常量 `MIN_RENDER_INTERVAL_MS = 16`（约 60 帧/秒），见 `packages/tui/src/tui.ts:343`。普通更新走 `scheduleRender`（排队、节流），而键盘输入为了"零延迟跟手"走 `requestImmediateRender`，见 `packages/tui/src/tui.ts:772` 与 `:900`。

## 键盘解析：legacy 与 Kitty 双协议

终端把按键编码成一串转义字符（escape sequence）发给程序。老式终端（legacy）编码能力弱，分不清"Ctrl+C"和"Alt+C"；现代 Kitty 协议则能精确表达。Pi 两者都支持，见 `packages/tui/src/keys.ts:4` 顶部注释。

核心思路：

- 程序先尝试按 **Kitty 协议**解析（CSI u 格式）。Kitty 用 `flags` 位表示修饰符：`MODIFIERS = {shift:1, alt:2, ctrl:4, super:8}`，见 `packages/tui/src/keys.ts:292`。
- 解析函数 `parseKittySequence` 用正则匹配 `\x1b[<code>:<flags>u` 形式，见 `packages/tui/src/keys.ts:587`，正则本身在 `:598`。
- 如果不符合 Kitty 格式，再退回 **legacy 序列表** `LEGACY_KEY_SEQUENCES`（`packages/tui/src/keys.ts:368`）查表。

Kitty 协议还有一个独门能力：上报"按键的生命周期"。`KeyEventType = "press" | "repeat" | "release"`（`packages/tui/src/keys.ts:505`）。普通终端只知道"按了一下"，Kitty 能说清是"刚按下""长按重复"还是"松开了"。Pi 用 `isKeyRelease`（`packages/tui/src/keys.ts:527`）和 `isKeyRepeat`（`packages/tui/src/keys.ts:557`）识别它们。

在框架层，`handleTerminalInput` 默认**过滤掉"松开"事件**，除非当前聚焦组件主动声明 `wantsKeyRelease()`，见 `packages/tui/src/tui.ts:894`：

```ts
// packages/tui/src/tui.ts:894
if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease()) return;
```

这就是为什么编辑器（`Editor`）能感知"按住 Shift 再松开"，而普通文本组件不会收到多余事件。

> **提示**
>
> **Kitty 协议的 flag 2 = 重复事件**。当判断 `flags` 里包含重复位时，Pi 区分出"用户长按没松手、系统自动连发"，这对于实现"按住方向上键连续移动光标"这类体验很关键。

## Markdown 与 LaTeX 渲染

智能体的回答是 Markdown 文本，但终端只会显示字符。Pi 用 `Markdown` 组件（`packages/tui/src/components/markdown.ts:236`）把 Markdown 在内存里先渲染成纯文本行。

性能上它做了**缓存**：如果文本和宽度都没变，直接返回上次算好的行，不重复解析：

```ts
// packages/tui/src/components/markdown.ts:246
#cachedText: string | undefined;
#cachedWidth: number | undefined;
#cachedLines: string[] | undefined;

// packages/tui/src/components/markdown.ts:279
if (this.#cachedText === text && this.#cachedWidth === width) {
	return this.#cachedLines!; // 命中缓存，直接返回
}
```

遇到数学公式时，Markdown 组件调用 `renderLatex` 把 LaTeX 转成终端能显示的 Unicode 近似字符（比如把 `\sum` 渲染成 `∑`）。导入见 `packages/tui/src/components/markdown.ts:2`，实际转换函数在 `packages/tui/src/latex.ts:1362` 的 `renderLatex(source, options)`。

编辑器 `Editor` 则是另一类组件：它持有 `lines`、`cursorLine`、`cursorCol` 等状态（`packages/tui/src/components/editor.ts:271`），`render(width)` 只输出**可见区域**的行并广播光标位置（`CURSOR_MARKER`），`handleInput` 负责分发各种按键行为（跳转到某行、撤销、自动补全等），见 `packages/tui/src/components/editor.ts:603`。

> **注意**
>
> **自定义组件必须自己截断行宽**。差分渲染要求每一行宽度都不超过终端宽度，否则 Pi 会直接报错并写崩溃日志（见 `packages/tui/src/tui-main-screen.ts:447`）。组件应该用 `visibleWidth()` 测量、`truncateToWidth()` 截断，别把超长行直接丢给框架。

## 光标与标记：差分渲染之外的细节

差分渲染解决"画什么"，但还有"光标停在哪"。Pi 用一个特殊标记 `CURSOR_MARKER = "\x1b_pi:c\x07"`（`packages/tui/src/tui.ts:79`）来处理光标：组件在 `render` 时，把"光标应该出现的位置"放上这个标记；框架渲染完整个缓冲区后，再把标记替换成真正的终端光标移动指令。

编辑器就靠它把光标精确落在用户正在输入的那一列，见 `packages/tui/src/components/editor.ts:482`：

```ts
// packages/tui/src/components/editor.ts:482
render(width: number): string[] {
	// 只输出可见行，并在光标列插入 CURSOR_MARKER
	const lines = this.#visibleLines(width);
	lines[this.#cursorScreenRow] = insertMarker(lines[this.#cursorScreenRow], this.#cursorCol);
	return lines;
}
```

这样即便走"局部增量重绘"，光标也能被定位到变更区域内的某一列，而不是跳回屏幕左上角。全屏重绘与局部重绘在这点上行为一致，用户感觉不到区别。

## 一次按键如何走到屏幕：完整链路

把前面几节串成一条链路，你就看清整个 TUI 的输入输出闭环：

```
 用户按键
    │  (终端发来转义序列)
    ▼
 handleTerminalInput            packages/tui/src/tui.ts:826
    │  过滤 key release（除非组件 opt-in）
    │  解析为结构化 Key           packages/tui/src/keys.ts
    ▼
 聚焦组件.handleInput(key)      packages/tui/src/components/editor.ts:603
    │  修改内部状态（光标/文本）
    │  调用 invalidate()
    ▼
 requestImmediateRender()       packages/tui/src/tui.ts:900
    │  （键盘走零延迟通道，不走 16ms 节流）
    ▼
 doRender() 重新算 newLines     packages/tui/src/tui-main-screen.ts:180
    │  逐行 diff → 局部增量重绘
    ▼
 终端显示更新 + 光标定位
```

> **提示**
>
> **为什么键盘输入要绕过节流？** 打字时每一帧延迟都会被用户感知成"卡顿、跟手差"。所以 `requestImmediateRender` 让按键响应直接插队重绘（`tui.ts:900`），而普通内容更新（如后台状态变化）才走 `scheduleRender` 的 16ms 节流（`tui.ts:772`）。两类更新走不同通道，兼顾跟手与省 CPU。

## 自查清单

- [ ] 我能用一句话解释"差分渲染"为什么比整屏重绘更流畅。
- [ ] 我知道 `Component` 接口的三个核心方法（`render` / `handleInput` / `invalidate`）分别在 `packages/tui/src/tui.ts:23`。
- [ ] 我理解 `Container` 与 `TuiBase` 的组合关系（`tui.ts:211` 与 `:331`）。
- [ ] 我能说出差分渲染的三种策略：全屏重绘、追加模式、局部增量重绘，以及各自触发条件。
- [ ] 我知道"同步输出" `\x1b[?2026h` 的作用是避免闪烁（`tui-main-screen.ts:210`）。
- [ ] 我理解 Pi 为什么同时支持 legacy 和 Kitty 键盘协议（`keys.ts:4`），以及 Kitty 能区分"按下/重复/松开"（`keys.ts:505`）。
- [ ] 我知道默认会过滤"按键松开"事件，除非组件声明 `wantsKeyRelease()`（`tui.ts:894`）。
- [ ] 我理解 Markdown 组件用缓存避免重复解析（`markdown.ts:279`），并用 `renderLatex` 渲染公式（`latex.ts:1362`）。
