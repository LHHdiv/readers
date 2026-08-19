# 拾阶 STEPWELL · readers

把每一次学习读成一套书。这是一套 **Markdown 驱动** 的个人系列研读库：书目、卷册、章节都是仓库里的文档，构建后变成静态网站，可托管在 GitHub，并由 Netlify 自动发布。

视觉与信息架构来自 `prototype/qwen3-8max2.html`，做成了可维护的 Astro 项目。

## 本地运行

需要 Node 22 或以上。

```bash
cd Project/readers
npm install
npm run dev
```

打开终端里提示的地址。改 `content/` 下的 Markdown 会热更新。

```bash
npm run build    # 输出到 dist/
npm run preview  # 预览生产构建
```

## 怎么放真实文章

一个项目一个文件夹。文章就是普通 Markdown，封面写在同目录的 `_book.md`。

```
content/
  pi/
    _book.md                 # 书名、封面色、分卷
    00-intro-methodology.md
    01-ai-history.md
    ...
  deeptutor/
    _book.md
    00-intro-methodology.md
    ...
  journal/                   # 书房手记
```

文章 frontmatter 最少只要 `title`，有 `summary` 更好：

```md
---
title: 核心循环
summary: 逐行拆 agent-loop。
---

正文从这里开始。
```

序号看文件名开头的数字（`00-`、`25-`），项目名看文件夹。分卷写在 `_book.md` 的 `phases` 里。

已有一整夹讲义时：

```bash
cd Project/readers
node scripts/import-series.mjs --book pi --from ../page-collection/notes/pi
node scripts/import-series.mjs --book deeptutor --from ../page-collection/notes/deeptutor
```

新开一套：新建 `content/<名字>/`，放进 md，再写一篇 `_book.md`（可抄 `content/pi/_book.md`）。`npm run dev` 看效果，`git push` 后 Netlify 会重新构建。

阅读进度记在浏览器 `localStorage`（键名 `readers.v3`），不进仓库。

## GitHub + Netlify

本仓库已写好 `netlify.toml`：构建命令 `npm run build`，发布目录 `dist`，Node 22。

### 1. 建成 GitHub 仓库

本机还没有 `gh` 时，在 GitHub 网页新建空仓库 `readers`，然后：

```bash
cd Project/readers
git init
git add .
git commit -m "Initial commit: 拾阶 STEPWELL readers"
git branch -M main
git remote add origin git@github.com:<你的用户名>/readers.git
git push -u origin main
```

### 2. 接到 Netlify

1. 打开 [Netlify](https://app.netlify.com) ，Add new site → Import an existing project。
2. 选 GitHub，授权后选 `readers`。
3. Build command 填 `npm run build`，Publish directory 填 `dist`（`netlify.toml` 已写，一般会自动读到）。
4. Deploy。之后每次 `git push` 都会重新构建。

当前线上地址是 `https://readers-site.netlify.app`，写在 `astro.config.mjs` 的 `site` 里。若以后改名，两边一起改再推。

## 快捷键

- `⌘/Ctrl K` 或 `/`：检索全书章节
- `←` `→`：阅读页上一讲 / 下一讲
- `T`：明暗主题
- `Esc`：关闭检索

## 结构

```
content/           Markdown 正文
src/pages/         书房 / 书目 / 章节
src/components/    顶栏、封面、页脚、检索
src/styles/        拾阶纸面样式
src/scripts/app.ts 进度、主题、检索、快捷键
prototype/         原始单文件 UI，不参与构建
```

书房、书目、正文三层路由：

- `/`
- `/book/<id>/`
- `/book/pi/00-intro-methodology/`
