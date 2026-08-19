---
title: "第 16 章 · 从零跑通 DeepTutor"
date: 2026-08-01
summary: "就算你从没装过 Python，也能照着本章把 DeepTutor v1.5.11 在自己的电脑上跑起来，看到聊天界面，并且学会在\"智能体循环\"里打断点看模型一步步在干什么。"
tags:
  - deeptutor
---
# 第 16 章 · 从零跑通 DeepTutor

> 目标：就算你从没装过 Python，也能照着本章把 DeepTutor v1.5.11 在自己的电脑上跑起来，看到聊天界面，并且学会在"智能体循环"里打断点看模型一步步在干什么。

黑话先定义：**运行环境**就是"让程序能跑起来的一整套依赖"（Python 版本、网络框架、前端工具等）；**源码安装**指直接从 GitHub 克隆代码、用 `pip install -e .` 装成"可编辑"模式，改一行代码立刻生效，最适合学习。

---

## 16.1 先确认你能跑它

DeepTutor 后端是纯 Python。它对 Python 版本卡得很死，太新或太旧都不行。原因写在 `pyproject.toml:18`：

```toml
requires-python = ">=3.11,<3.14"
```

这行意思是"只接受 3.11、3.12、3.13"。注释里解释得更清楚：`3.14` 上某些数值计算库（如 `faiss-cpu`）还没有编译好的轮子，pip 会退回源码编译然后失败。所以**请用 Python 3.11–3.13**。

前端需要 Node.js。README 的"从源码安装"方案要求 `Node.js 22 LTS`（见 `README.md:240`），和官方 CI、Docker 一致。如果你只跑命令行版（不需要网页界面），Node 可以不要，但本教程默认你跑完整 Web 版。

> **提示 · 怎么看自己 Python 版本**
>
> 打开终端，输入：
> ```bash
> python3 --version
> ```
> 如果显示 `Python 3.11.x` / `3.12.x` / `3.13.x` 之一就可以。不是的话，用 `pyenv` 或 `conda` 新建一个 3.11 环境再继续。

---

## 16.2 第一步：拿到源码并建虚拟环境

"虚拟环境"就是一个**隔离的小房间**，把 DeepTutor 需要的包装在这里，不污染你电脑全局的 Python。黑话 `venv` 就是 virtual environment 的缩写。

```bash
git clone https://github.com/HKUDS/DeepTutor.git
cd DeepTutor

# macOS / Linux：建一个隔离环境并激活
python3 -m venv .venv && source .venv/bin/activate

# Windows PowerShell 用这行代替上面的 venv 行：
#   py -3.11 -m venv .venv ; .\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip
```

激活后，终端提示符前面会出现 `(.venv)`，表示你正待在那个隔离房间里。后面所有 `pip` 命令都只影响这个房间。

---

## 16.3 第二步：安装后端 + 前端依赖

两根命令，一根装 Python 包，一根装前端包：

```bash
# 后端 + CLI，可编辑模式（改代码即时生效）
python -m pip install -e .

# 前端：进入 web 目录装 npm 依赖
( cd web && npm ci --legacy-peer-deps )
```

`pip install -e .` 里的 `-e` 是 editable（可编辑）。它不把代码复制进 Python 的 site-packages，而是**做个指向你这个源码目录的软链接**。所以你之后改了 `deeptutor/` 下的 `.py` 文件，不用重装就能生效——这对"边读源码边打断点"至关重要。这个入口在 `pyproject.toml:77` 定义：

```toml
[project.scripts]
deeptutor = "deeptutor_cli.main:main"
```

意思是：装好后系统里多了一个叫 `deeptutor` 的命令，它最终调用 `deeptutor_cli/main.py` 里的 `main()` 函数（`deeptutor_cli/main.py:178`）。

---

## 16.4 第三步：初始化配置 `deeptutor init`

装好依赖后，第一次需要"初始化"工作区。这条命令会问你几个问题，并把答案写进 `data/user/settings/` 下的 JSON 文件。

```bash
deeptutor init
```

它会依次问你（见 `README.md:231`）：

| 问题 | 默认值 | 说明 |
|------|--------|------|
| 后端端口 backend port | `8001` | 后端 API 服务监听的端口 |
| 前端端口 frontend port | `3782` | 你在浏览器打开的网页端口 |
| LLM 提供商 / Base URL / API Key / 模型 | 空 | 你用哪家大模型、它的接口地址和密钥 |
| 可选的 embedding 提供商 | 空 | 想用知识库 / RAG 才需要 |

`init` 命令由 `deeptutor_cli` 的子命令注册器挂上来（见 `deeptutor_cli/main.py:72` 的 `register_init(app)`）。如果你只是想快速试一下，也可以**跳过 init**——不配模型，程序照样能起，只是聊天时它会提示你去 Settings 里补模型。

> **说明 · 配置文件都长什么样**
>
> `data/user/settings/` 下是一堆普通 JSON/YAML（见 `README.md:449` 的表）：
> - `system.json`：前后端端口、CORS、附件上限
> - `model_catalog.json`：你配的模型、密钥、默认模型
> - `interface.json`：界面语言、主题
> - `main.yaml` / `agents.yaml`：运行时与能力默认参数
> 
> 这些文件就是 DeepTutor 的"设置面板"背后的真实存储。你改网页上的设置，本质就是改这些 JSON。

---

## 16.5 第四步：启动 `deeptutor start`

配置就绪，一条命令同时拉起后端和前端：

```bash
# 完整 Web 版（默认生产构建）
deeptutor start

# 想改前端代码看实时热更新，加 --dev
deeptutor start --dev
```

这条 `start` 命令的实现在 `deeptutor_cli/main.py:117`，它只是把活儿转交给真正复杂的启动器：

```python
@app.command()
def start(
    home: Path | None = typer.Option(None, "--home", help="Runtime workspace root."),
    dev: bool = typer.Option(False, "--dev", help="Use the Next.js development server."),
) -> None:
    """Launch backend + frontend together. Source installs default to production."""
    from deeptutor.runtime.launcher import start as start_web
    start_web(home=home, dev=dev)
```

真正的重活在 `deeptutor/runtime/launcher.py` 的 `start()`（`launcher.py:930`）。它做四件大事：

1. 选定工作区目录，写入环境变量 `DEEPTUTOR_HOME`（`launcher.py:934`）。
2. 解析前端该用"打包版""源码生产构建"还是"`--dev` 开发服务器"（`launcher.py:723` 的 `_resolve_frontend`）。
3. 用 `subprocess` **另起一个进程**跑后端 uvicorn（`launcher.py:1051` 的 `backend_cmd` 和 `launcher.py:1110` 的 `_spawn`）。
4. 同样另起一个进程跑前端 Node 服务，并不断探活，直到两个都就绪（`launcher.py:1112` 的 `_wait_for_http`）。

启动成功后，终端会打印前端网址，**默认是 `http://127.0.0.1:3782`**。在浏览器打开它，就能看到 DeepTutor 的聊天界面了。按 `Ctrl+C` 会同时关掉后端和前端（`launcher.py:1097` 的 `cleanup`）。

---

## 16.6 启动链路一图流

把上面四步串起来，你敲的命令到界面出现，中间经过这些环节：

```text
你在终端敲：deeptutor start
        │
        ▼
deeptutor_cli/main.py:117  start()
        │  转交
        ▼
runtime/launcher.py:930  start()
        ├─ 选工作区 + 写 DEEPTUTOR_HOME      (launcher.py:934)
        ├─ 解析前端形态 _resolve_frontend    (launcher.py:723)
        ├─ 解决端口冲突 _resolve_port_conflicts (launcher.py:409)
        │
        ├─ 启动后端子进程 uvicorn             (launcher.py:1051/1110)
        │     监听 http://127.0.0.1:8001
        │
        └─ 启动前端子进程 node server.js      (launcher.py:1132)
              监听 http://127.0.0.1:3782
                    │
                    ▼
            浏览器打开 3782 → 看到聊天界面
```

> **注意 · 常见坑：端口被占**
>
> 如果 `8001` 或 `3782` 已经被别的程序占了，`launcher` 会**交互式**地让你选"换端口"还是"杀掉占用进程"（`launcher.py:326` 的 `_prompt_conflict_choice`）。但在 Docker / CI 这种没有交互终端的环境，它会直接报错退出（`launcher.py:441`）。遇到这种情况，手动换端口：
> ```bash
> deeptutor start --home /path/to/workspace
> # 或在 Settings 里改 system.json 的 backend_port / frontend_port
> ```

---

## 16.7 只用命令行也能跑（不想开网页）

如果你只想在终端里和智能体对话，不需要 Web 界面，用这条：

```bash
deeptutor chat                                  # 交互式对话
deeptutor run chat "解释一下傅里叶变换" --tool rag --kb my-kb
```

`run` 子命令的实现在 `deeptutor_cli/main.py:75`，它接收一个能力名（如 `chat`、`deep_solve`）和一句话，跑完一轮就退出。`chat` 是默认的、也是最重要的能力，后面第 19 章会细讲。

---

## 16.8 关键一步：在"智能体循环"里打断点

光跑起来不够——你想**看清模型每一步在干什么**。DeepTutor 的灵魂是一个"标签驱动循环"，代码在 `deeptutor/core/agentic/loop.py`。第 18 章会完整拆解它，这里先让你把断点打上。

打开 `deeptutor/core/agentic/loop.py`，找到第 173 行附近的循环入口：

```python
async def run_agentic_loop(
    *,
    initial_messages: list[dict[str, Any]],
    protocol: LabelProtocol,
    client: Any,
    model: str | None,
    completion_kwargs: dict[str, Any],
    binding: str | None,
    tool_schemas: list[dict[str, Any]] | None,
    stream: StreamBus,
    source: str,
    stage: str,
    max_iterations: int,
    host: LoopHost,
    usage: UsageTracker | None = None,
    stream_body_live: bool = False,
    eager_sub_trace: bool = False,
    implicit_think_label: str | None = None,
) -> LoopOutcome:
```

在这个函数的 `for iteration in range(max_iter):` 循环体里（约 `loop.py:219`），是最值得打断点的地方。每一个 `iteration` 就是模型"想一次"的一轮。

### 用 VSCode 打断点

1. 用 VSCode 打开整个 `DeepTutor` 文件夹。
2. 确认用的是你刚建的 `.venv` 解释器（`Ctrl+Shift+P` → Python: Select Interpreter → 选 `.venv`）。
3. 打开 `deeptutor/core/agentic/loop.py`，在 `loop.py:219` 左侧点一下，出现红点。
4. 在**调试视图**新建一个配置，用 `deeptutor start` 或直接调试 `deeptutor run chat "你好"`。最简单：终端里用 `python -m debugpy` 不太必要——直接"运行和调试"选 `Python: Module` 填 `deeptutor_cli.main`，参数 `run chat 你好`。
5. 程序跑到那一行会**暂停**，此时你能看：
   - `step.label`：模型这一轮回来的"标签"（如 `THINK` / `TOOL` / `FINISH`）。这正是第 18 章的核心。
   - `step.text`：模型写的正文。
   - `messages`：累积到当前的完整对话历史。

### 用 PyCharm 打断点

1. 打开项目，把 `.venv` 设为 Project Interpreter。
2. 在 `loop.py:219` 行号右边点一下加红点。
3. 建一个 Run/Debug 配置：`Module name = deeptutor_cli.main`，`Parameters = run chat 你好`。
4. 点小虫图标以 Debug 模式运行，命中后在下方的 Variables / Watches 面板加 `step.label`、`step.text`、`messages` 即可。

> **提示 · 第一次调试看什么**
>
> 不要一上来就想搞懂全部。第一次调试，只盯住 `step.label` 这一个变量。你会看到它在一轮轮变化：`THINK`（模型在思考）、`TOOL`（模型要调用工具）、`FINISH`（模型说"我说完了"）。**这个标签就是智能体的"心跳"**，第 18 章会告诉你为什么 DeepTutor 强制模型每次都必须先吐一个标签。

---

## 16.9 本章你实际跑过什么

回顾一下，你刚才完成了：

```text
git clone ─► python -m venv ─► pip install -e .
└─► deeptutor init ─► deeptutor start ─► 浏览器 3782
                                          └─► deeptutor run chat 你好（调试命中 loop.py:219）
```

你已经在"真实可运行"的状态下，和本教程要讲的核心代码面对面了。后面第 17–20 章会顺着"一次用户输入从命令行 / 网页，一路走到标签循环里"的完整链路，把每个环节拆开给你看。

---

## 16.10 只想跑后端？用 `deeptutor serve`

有时你只想把**后端 API** 起起来（比如用别的工具连它、或写自动化脚本），不要前端。命令在 `deeptutor_cli/main.py:133` 定义为 `serve`：

```python
@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", help="Bind address."),
    port: int | None = typer.Option(None, help="Port number."),
    reload: bool = typer.Option(False, help="Enable auto-reload for development."),
) -> None:
    """Start the DeepTutor API server."""
    ...
    uvicorn.run("deeptutor.api.main:app", host=host, port=port or get_backend_port(), ...)
```

它会直接用 `uvicorn` 起 FastAPI 应用（`deeptutor.api.main:app`），默认端口走 `get_backend_port()`（一般就是 `8001`）。注意它是**纯后端**，没有网页——你只能用 `curl` 或脚本调接口，或配合第 20 章的 WebSocket 工具自己写客户端。

> **提示 · start 与 serve 怎么选**
>
> - 想用网页、看聊天界面 → `deeptutor start`（完整链路，第 17 章讲的就是它的内部）。
> - 只想暴露 API / 做集成测试 → `deeptutor serve`（轻量，不含前端子进程）。
> 两者底层都是同一个 FastAPI 应用，区别只在"有没有再拉一个 Node 前端"。

---

## 16.11 用 Docker 一行起（不想装 Python/Node）

如果你连环境都不想配，Docker 一条命令就行（见 `README.md:312`）：

```bash
docker run --rm --name deeptutor \
  -p 127.0.0.1:3782:3782 \
  -v deeptutor-data:/app/data \
  ghcr.io/hkuds/deeptutor:latest
```

文档特别说明（见 `README.md:318`）：**只需要发布 `3782` 这一个端口**——浏览器只跟前端源站说话，Next.js 中间件（`web/proxy.ts`）会在容器内把 `/api/*` 和 `/ws/*` 转发给后端。第一次启动会在 `/app/data/user/settings/` 下生成配置文件，你在网页 Settings 页填模型即可。

---

## 16.12 代码执行沙箱：模型能写代码给你办事

DeepTutor 的内置办公技能（docx / pdf / pptx / xlsx）靠让模型写一小段 Python 脚本，再经 `exec` / `code_execution` 工具跑出来，最后给你一个下载链接（见 `README.md:423`）。这个沙箱**默认开着**（`README.md:426`）：

```text
The subprocess sandbox is controlled by the sandbox_allow_subprocess setting
in data/user/settings/system.json (default true).
```

黑话**沙箱（sandbox）**就是一个"隔离小房间"，模型生成的代码在里面跑，碰不到你系统的其他部分。如果你不信任、或不需要办公技能，可以把 `system.json` 里的 `sandbox_allow_subprocess` 设为 `false`（或导出环境变量 `DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS=0`），代价是办公技能不再能产出文件（见 `README.md:439`）。

> **注意 · 这是真实的安全取舍**
>
> "让 AI 在你电脑上跑它写的代码"本质是信任决策。本地和 Docker 单容器下，沙箱是个受限子进程；docker-compose 下则路由到更严格的 runner 旁路。学习阶段用默认即可，但要知道这个开关在哪。

---

## 16.13 配置文件速查表

`deeptutor init` 之后，`data/user/settings/` 下会有一堆普通 JSON/YAML（完整表见 `README.md:449`）。最常用这几样：

| 文件 | 用途 | 行号参考 |
|------|------|----------|
| `model_catalog.json` | LLM / embedding / 搜索提供商的配置、密钥、默认模型 | `README.md:451` |
| `system.json` | 前后端端口、CORS、附件上限 | `README.md:452` |
| `auth.json` | 可选的登录开关、用户名密码 | `README.md:453` |
| `interface.json` | 界面语言 / 主题 / 侧边栏偏好 | `README.md:455` |
| `main.yaml` | 运行时默认行为、路径注入 | `README.md:456` |
| `agents.yaml` | 各能力 / 工具的温度与 token | `README.md:457` |

> 记住：项目根目录的 `.env` **不是**应用配置文件（`README.md:459`）。最小模型配置直接在网页 Settings → Models 里加一个 LLM profile（Base URL / API Key / 模型名）即可。

## 16.14 一次最小冒烟测试

装好、配好、起好之后，最怕的是"界面出来了但模型不说话"。用一个最小测试快速定位：

1. 打开网页，进 Settings → Models，确认至少有一个 profile 的 Base URL 和 API Key 已填（填错最常见）。
2. 在对话框输入 `你好`，回车。
3. 看网络面板里 WebSocket（`/ws`）有没有持续推送 `content` 事件（`stream.py:21` 的 `CONTENT` 类型）。

> **提示 · 验证可编辑安装的"真身"**
>
> `pip install -e .` 之后，在 Python 里 `import deeptutor; print(deeptutor.__file__)`（`deeptutor_cli/main.py:178` 的 `main` 函数正是通过这个点被控制台命令调用）。打印出的路径应当直接指向你克隆的仓库目录，而不是 `site-packages` 里的副本。如果不是，说明装的不是 editable 版本，改源码不会生效——这是新手最常见的"改了没反应"。

如果模型还是不回，先排除网络（能不能直连 Base URL），再排除 Key（Key 是否过期 / 余额），最后才去读 `turn_runtime.py` 的 `start_turn`（`turn_runtime.py:682`）。顺序从外到内，能省掉大把时间。

---

## 自查清单

- [ ] 我能说出 DeepTutor 支持的 Python 版本范围，并知道它写在 `pyproject.toml:18`
- [ ] 我能解释 `pip install -e .` 里 `-e` 的含义，以及为什么学习源码要用它
- [ ] 我成功执行了 `git clone` + 建 venv + `pip install -e .` + `npm ci`
- [ ] 我能说出 `deeptutor init` 会创建哪些配置文件（至少说出 `system.json` 和 `model_catalog.json`）
- [ ] 我跑起了 `deeptutor start` 并在浏览器打开了 `http://127.0.0.1:3782`
- [ ] 我知道 `deeptutor start` 背后是 `deeptutor_cli/main.py:117` 转交给 `launcher.py:930`
- [ ] 我能在 `deeptutor/core/agentic/loop.py:219` 处下断点，并认识 `step.label` 这个变量
- [ ] 我能在 VSCode 或 PyCharm 里用 Debug 模式命中 `loop.py` 的循环，看到 `step.label` 变化
