---
title: "第 14 章 · 从零跑通 Pi：构建链、pi-test.sh、断点调试"
date: 2026-07-01
summary: "若某次构建中途失败，通常是某包没编完。重新跑同一命令即可，`tsgo` 会增量编译。不要手动去改构建顺序。"
tags:
  - pi
---
# 第 14 章 · 从零跑通 Pi：构建链、pi-test.sh、断点调试

上一章我们看清楚了 Pi 由 11 个包拼成。本章的主角是：**怎么把你手里的源码真正跑起来**。很多初学者卡在"装好了却跑不起来"，本章把每一步拆开，并给出可直接复制的命令块。所有行号都来自真实源文件。

## 直觉：为什么不能直接 `node pi`

`pi` 的入口源码是 TypeScript（`packages/coding-agent/src/cli.ts`），Node 不能直接跑 TS。所以"跑 Pi"其实是三步：**装依赖 → 编译成 JS → 用 tsx 直接跑 TS 源码**（开发模式），或跑编译产物（发布模式）。

开发模式下 Pi 用一个叫 `tsx` 的工具（`package.json` 里列为 devDependency）实时把 TS 转成 JS 再执行，省去每次手动编译。仓库根目录的 `pi-test.sh` 就是干这个的。

## 第 0 步：确认 Node 版本

Pi 明确要求 Node **≥ 22.19.0**。根 `package.json` 的 `engines` 字段写死了这条下限（`package.json:64`）：

```json
"engines": {
  "node": ">=22.19.0"
}
```

先确认你的版本：

```bash
node --version
```

如果低于 22.19（例如 20.x），请用 `nvm` / `fnm` 之类工具升级，否则后续编译或运行会报错。

> **注意 · Node 版本是头号坑**
>
> AGENTS.md 与 README 都反复强调 Node ≥ 22.19。低于此版本时，`tsgo`（TypeScript 原生编译）、`undici` 等依赖可能直接崩溃或给出莫名其妙的错误。先 `node --version` 再往下走，能省掉大半排错时间。

## 第 1 步：安装依赖（注意 --ignore-scripts）

官方推荐的源码运行流程（README.md:65-72）是：

```bash
npm install --ignore-scripts
npm run build
./pi-test.sh
```

**重点解释 `--ignore-scripts`**：npm 安装依赖时，某些包会在安装阶段自动跑脚本（比如下载二进制、编译原生模块）。Pi 出于供应链安全考虑（`README.md` 第 87-99 行有详述），要求**跳过这些生命周期脚本**，改由统一的构建流程来处理。所以你一定要写全：

```bash
npm install --ignore-scripts
```

如果你漏了 `--ignore-scripts`，少数带原生构建步骤的包可能尝试联网编译，在无网或受限环境下会失败。

> **说明 · 什么是 ignore-scripts，为什么它安全**
>
> `--ignore-scripts` 告诉 npm："只把包的文件下载下来，不要执行它们自带的 install/prebuild 等脚本。"这能防止恶意或被污染的包在你看不见时执行任意代码。Pi 的 AGENTS.md（第 46 行）也规定：本地用 `npm install --ignore-scripts` 水合依赖，CI 用 `npm ci --ignore-scripts`。

## 第 2 步：构建（build 还是 build:offline）

装完后要编译所有包。根 `package.json` 提供两个脚本：

- `build`（`package.json:16`）：先刷新模型数据（需要网络），再编译全部包。
- `build:offline`（`package.json:17`）：用**已有的**模型数据编译，**不联网**。

```bash
# 有网络时（会顺带更新模型目录）
npm run build

# 或者：无网络 / 想更快时
npm run build:offline
```

两个脚本的 `cd` 顺序完全一致，只是 `ai` 那一步从 `npm run build` 换成 `npm run build:offline`。构建顺序就是第 13 章画的：tui → telemetry → ai → agent → session-backends/sqlite-node → protocol → client → server → coding-agent。

> 若某次构建中途失败，通常是某包没编完。重新跑同一命令即可，`tsgo` 会增量编译。不要手动去改构建顺序。

## 构建产物在哪、怎么确认成功

`npm run build` 做完后，每个包的 TypeScript 源码会被编译进各自的 `dist/` 目录。例如：

- `packages/ai/dist/` ← 编译后的 `pi-ai`
- `packages/agent/dist/` ← 编译后的 `pi-agent-core`
- `packages/coding-agent/dist/cli.js` ← 发布模式真正执行的入口（`pi` 命令指向它）

开发模式（`pi-test.sh`）**不依赖这些 `dist/`**，它直接用 `tsx` 跑 `src/cli.ts`；但 `npm run build` 仍然必须跑，因为上层包通过 `import "@earendil-works/pi-ai"` 引用的是**已发布的 `dist/`**（或 node_modules 里的工作区软链），而不是 `src/`。也就是说：谁被别人依赖，谁就得先编出 `dist/`。这正是第 13 章"构建顺序"的根本原因。

确认构建成功的最简单办法：

```bash
# 看 coding-agent 入口是否生成
ls -l packages/coding-agent/dist/cli.js

# 看 ai 是否生成
ls -l packages/ai/dist/index.js
```

若文件存在且命令无报错，说明整条 `tui→…→coding-agent` 链已编完，可以进入下一步。

> **说明 · tsx 与 dist 的关系**
>
> `tsx` 是"运行时 TS 转译器"：它让 Node 能直接执行 `.ts` 源码，跳过预编译，适合开发期快速迭代。`dist/` 是"预编译产物"：适合发布给别人用、或让被依赖包以纯 JS 形态被引用。二者不冲突——Pi 开发用 `tsx`，发布用 `dist`。

## 第 3 步：用 pi-test.sh 启动

`pi-test.sh` 是开发期启动 Pi 的快捷脚本，位置在仓库根 `pi-test.sh`。它的核心逻辑只有一行（`pi-test.sh:57`）：

```bash
"$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
```

意思是：用仓库里的 `tsx` 直接运行 `cli.ts`，并把你传给脚本的参数原样转给 `cli.ts`。脚本开头的 `set -euo pipefail`（`pi-test.sh:2`）让它在出错时立即停下，便于发现问题。

从任意目录启动（脚本会自动定位仓库根）：

```bash
# 进入仓库根
cd /Users/lijunkai/Project/pi

# 交互模式（进入 TUI）
./pi-test.sh

# 单次问答（print 模式）
./pi-test.sh "用一句话解释什么是 monorepo"

# 指定模型
./pi-test.sh --model anthropic/claude "hello"
```

`pi-test.sh` 还支持一个特殊参数 `--no-env`（`pi-test.sh:10-55`）：它会 `unset` 掉所有已知的 API key 环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等），让你**在无密钥环境下诊断**是否走的是离线/本地逻辑。运行时它只打印一句 `Running without API keys...`（`pi-test.sh:54`）。

```bash
# 不带任何密钥启动，验证无密钥路径
./pi-test.sh --no-env "hi"
```

## 第 4 步：用 tmux 跑 TUI 并捕获输出

交互式 TUI 需要真实终端。AGENTS.md（第 97-108 行）给出了用 `tmux` 在受控终端里启动并截屏的标准做法。tmux 是一个"终端复用器"，能在后台开一个虚拟终端会话，方便脚本化操作与抓屏。

```bash
# 开一个 80x24 的 tmux 会话，名字叫 pi-test
tmux new-session -d -s pi-test -x 80 -y 24

# 在会话里运行 pi（开发模式）
tmux send-keys -t pi-test "./pi-test.sh" Enter

# 等 3 秒让界面起来，然后抓取当前屏幕内容
sleep 3 && tmux capture-pane -t pi-test -p

# 发一条提示词
tmux send-keys -t pi-test "your prompt here" Enter

# 发送特殊键（Esc；Ctrl+o 写作 C-o）
tmux send-keys -t pi-test Escape

# 用完关掉会话
tmux kill-session -t pi-test
```

把上面流程整理成一张"启动—交互—退出"图：

```
你的 shell
   │  tmux new-session -d -s pi-test
   ▼
tmux 后台虚拟终端 ──send-keys──► ./pi-test.sh ──► cli.ts ──► TUI 界面
   │                                  ▲
   └── capture-pane 把屏幕文字抓回你的 shell 查看
```

> **提示 · tmux 的价值**
>
> 为什么不直接在终端里跑 `./pi-test.sh`？因为 TUI 会"霸占"你的终端、且很难用脚本自动截图。`tmux` 把 Pi 关在一个可脚本控制的虚拟终端里，你既能肉眼看、也能 `capture-pane` 把文字内容捞出来分析，非常适合调试和写自动化测试。

## 第 5 步：加断点调试

当 Pi 行为不对劲，最实用的是**在源码里打断点单步看**。有两种常用方式。

### 方式 A：VS Code 图形化调试（推荐新手）

1. 在 VS Code 里打开 `packages/coding-agent/src/` 下任意 `.ts` 文件，点行号左侧加红点（断点）。
2. 创建一个调试配置（`.vscode/launch.json`），类型选 `node`，`program` 指向 `cli.ts`，`runtimeArgs` 用 `tsx`：

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug pi (tsx)",
  "runtimeArgs": ["--import", "tsx"],
  "program": "${workspaceFolder}/packages/coding-agent/src/cli.ts",
  "args": ["用一句话解释 monorepo"],
  "console": "integratedTerminal"
}
```

3. 按 `F5` 启动，程序会在断点处停下，你可看变量、单步、进函数。

### 方式 B：用 --inspect 命令行调试

不想开 VS Code，可以用 Node 自带的 `--inspect` 暴露调试端口，再用 Chrome DevTools（`chrome://inspect`）连接：

```bash
# 让 tsx 以调试模式运行 cli.ts，端口 9229
node --inspect=9229 ./node_modules/.bin/tsx \
  packages/coding-agent/src/cli.ts "hello"
```

然后在 Chrome 地址栏打开 `chrome://inspect`，点对应 target 即可断点调试。想停在第一行就加 `--inspect-brk`。

> **说明 · 断点打在哪最值**
>
> 建议先打在启动链路的关键节点：`cli.ts:21`（main 入口）、`main.ts:609`（参数解析完）、`main.ts:843`（runtime 建好）、`main.ts:927`（进入交互模式）。这些点能让你看到"从敲命令到进界面"每一步的变量状态，详见第 15 章。

## 常见坑汇总

| 现象 | 原因 | 解决 |
|------|------|------|
| `node --version` 低于 22.19 | Node 太旧 | 升级 Node 到 ≥ 22.19.0 |
| 安装时报原生模块编译失败 | 漏了 `--ignore-scripts` | 重跑 `npm install --ignore-scripts` |
| `npm run build` 卡在联网刷新模型 | 无外网 | 改用 `npm run build:offline` |
| 运行时报找不到模块 | 没构建或构建中断 | 重跑 `npm run build`，确认无报错 |
| TUI 乱码/无法交互 | 直接在非 TTY 里跑 | 用 `tmux` 或真实终端启动 |
| 一启动就崩溃、无堆栈 | 个别包 install 脚本被跳过 | 这是预期的；走统一 `npm run build` 即可 |

> **注意 · 构建顺序别手动调**
>
> 如果 `npm run build` 报"某个包找不到它依赖的包"，先确认你**完整跑完**了整条 `tui→…→coding-agent` 顺序。Pi 的构建脚本已写死顺序，不要自己改 `cd` 顺序——单向依赖决定了顺序不可逆。

## 一份可复制的完整流程

把以上步骤串成一条可直接粘贴的脚本（开发模式）：

```bash
# 0. 版本检查
node --version   # 需 >= 22.19.0

# 1. 安装（跳过生命周期脚本）
npm install --ignore-scripts

# 2. 构建（无网用 build:offline）
npm run build

# 3. 开发模式启动（交互 TUI）
./pi-test.sh

# 3'. 或单次问答
./pi-test.sh "用一句话解释什么是 monorepo"

# 4. 用 tmux 跑可捕获的 TUI
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux kill-session -t pi-test
```

## 自查清单

- [ ] 我知道 Pi 要求 Node ≥ 22.19.0，并会用 `node --version` 检查
- [ ] 我理解 `--ignore-scripts` 的作用与为什么 Pi 要求它
- [ ] 我能区分 `npm run build` 与 `npm run build:offline`（是否联网刷新模型）
- [ ] 我知道 `pi-test.sh` 本质是用 `tsx` 跑 `cli.ts`（`pi-test.sh:57`）
- [ ] 我会用 `./pi-test.sh --no-env` 在无密钥环境诊断
- [ ] 我会用 tmux 开会话、发送按键、capture-pane 抓屏、kill-session 退出
- [ ] 我会在 VS Code 或 `--inspect` 下给 `cli.ts`/`main.ts` 打断点
- [ ] 我能对照"常见坑"表排查安装/构建/运行三类问题
