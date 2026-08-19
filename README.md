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

## 怎么写内容

| 放什么 | 路径 |
| --- | --- |
| 书目元数据 | `content/books/<id>.md` |
| 章节正文 | `content/chapters/<id>/ch01.md` |
| 书房手记 | `content/journal/*.md` |

新增一套书：

1. 在 `content/books/` 加一篇，写封面色、分类、导语。
2. 在 `content/chapters/<id>/` 按 `ch01.md`、`ch02.md` 往下写。
3. 章节 frontmatter 需要 `book`、`vol`、`volOrder`、`order`、`title`、`summary`。

阅读进度、主题、字号记在浏览器 `localStorage`（键名 `readers.v1`），不进仓库。

批量从目录草稿生成示例正文可以用：

```bash
node scripts/seed.mjs
```

会覆盖现有 `content/` 示例文，自用内容请先备份。

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

站点地址可在 Netlify 改成 `xxx.netlify.app`，或绑自己的域名。改完后把 `astro.config.mjs` 里的 `site` 换成正式地址，再推一次，canonical 和 sitemap 才会正确。

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
- `/book/<id>/ch01/`
