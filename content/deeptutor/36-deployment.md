---
title: "第 36 章 · 把 DeepTutor 装进容器：镜像、编排与端口发现"
date: 2026-08-01
summary: "读者画像：你完全不懂编程，但想成为智能体开发者。本章带你\"看懂\"DeepTutor 是怎么被打包成一个可以一键运行的软件包的。我们不讲怎么写代码，只讲它\"为什么这么装、装了什么\"。"
tags:
  - deeptutor
---
# 第 36 章 · 把 DeepTutor 装进容器：镜像、编排与端口发现

> 读者画像：你完全不懂编程，但想成为智能体开发者。本章带你"看懂"DeepTutor 是怎么被打包成一个可以一键运行的软件包的。我们不讲怎么写代码，只讲它"为什么这么装、装了什么"。

## 36.1 先建立直觉：什么是"容器化"

你手机里的 App 换一台手机就装不上，因为缺了配套的系统和库。**容器（container）** 相当于一个"带操作系统的快递箱"：把 DeepTutor 的程序、它依赖的 Python、前端网页、数据库，全部塞进同一个箱子里。别人拿到箱子，在任何装了 Docker（搬运工）的电脑上都能原样跑起来，不用自己配环境。

DeepTutor 的源码仓库里，负责这个"打包说明书"的文件叫 `Dockerfile`，负责"一次启动多个箱子并让它们联网"的文件叫 `docker-compose.yml`。我们先看这两个文件，再看它怎么自动避开"端口被占用"的麻烦。

> **说明 · 三个关键词先记住**
>
> - **镜像（image）**：打包好的"箱子模板"，文件是 `Dockerfile`。
> - **容器（container）**：镜像跑起来后的"活实例"，由 `docker-compose.yml` 管理。
> - **编排（orchestration）**：同时启动并连接多个容器（后端、前端、数据库、沙箱）的过程。

## 36.2 Dockerfile：一个"分阶段"的打包流水线

DeepTutor 的 `Dockerfile` 不是一步到位，而是**多阶段构建（multi-stage build）**——先用一个阶段专门编译前端网页，再用另一个阶段组装最终运行环境，最后把不需要的编译工具丢掉，让成品更小更安全。

它的阶段划分在文件开头就能看到：

```text
L23   FROM --platform=$BUILDPLATFORM node:22-slim AS frontend-builder
L59   FROM node:22-slim AS node-runtime
L64   FROM python:3.11-slim AS python-base
L104  FROM python:3.11-slim AS production
L444  FROM production AS development
```

逐段用大白话说：

- `frontend-builder`（L23）：用 Node.js 22 把网页界面（Next.js）编译成静态文件。
- `node-runtime`（L59）：只保留运行网页所需的轻量 Node 环境。
- `python-base`（L64）：Python 3.11 的精简基础系统（DeepTutor 后端用 Python 写）。注意它要求 `requires-python = ">=3.11,<3.14"`（`pyproject.toml:18`），所以这里锁死 3.11。
- `production`（L104）：正式发布用的成品镜像，把前端产物和 Python 后端合并。
- `development`（L444）：在 `production` 基础上改成"挂载源码、热更新"，方便开发者改完代码立刻看效果。

### 36.2.1 为什么用"非 root 用户"

容器里默认是 root（超级管理员），一旦被攻破危害很大。DeepTutor 在镜像里专门建了一个普通用户 `deeptutor`（UID 1000）：

```text
L198  RUN groupadd --system --gid 1000 deeptutor \
L199      && useradd --system --uid 1000 --gid 1000 --no-create-home \
L200         --shell /usr/sbin/nologin deeptutor \
```

代码注释里解释得很直白：supervisord（进程管家，见 L211 的 `[supervisord]` 配置段）作为 1 号进程可能是 root，但它启动的每个子进程（后端、前端）都会"降权"成 `deeptutor` 这个普通用户。UID 1000 还刻意与宿主机用户对齐，方便文件权限互通。

> **提示 · 安全小知识**
>
> "最小权限原则"：能当普通用户就绝不做 root。这是容器安全的第 1 课，你以后写任何服务都要记得。

### 36.2.2 入口脚本与对外端口

镜像启动时先跑一个 `entrypoint.sh` 脚本（在 L318–L412 之间用 `cat >` 写进镜像，L439 设为 `ENTRYPOINT`）：

```text
L318  RUN cat > /app/entrypoint.sh <<'EOF'
L412  RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh
L431  EXPOSE 8001 3782
L439  ENTRYPOINT ["/app/entrypoint.sh"]
```

`entrypoint.sh` 的作用是：把存放在 `data/user/settings/system.json` 里的配置（比如 API 地址）重新导出成环境变量，再交给 supervisord 拉起后端和前端。

`EXPOSE 8001 3782`（L431）声明了容器对外暴露的两个端口：
- `8001`：后端 API（智能体大脑）。
- `3782`：前端网页（你浏览器里看到的界面）。

最终镜像里由 supervisord 同时托管这两个进程，注释在 `Dockerfile:211` 附近说明了 supervisord 配置被拆成"守护进程级"和"程序级"两份文件，让 production/development 共用一份守护配置。

### 36.2.3 把各阶段串成一条流水线

为了让你"看见"整个过程，把多阶段构建画成一条流水线：

```text
[源码 + 依赖清单]
       │
       ▼
┌─────────────────────┐
│ frontend-builder     │  node:22-slim  编译网页
│ (L23)                │  产出静态 HTML/JS
└─────────┬───────────┘
          │ 拷贝产物
          ▼
┌─────────────────────┐   ┌─────────────────────┐
│ python-base (L64)    │   │ node-runtime (L59)   │
│ Python 3.11 基础     │   │ 仅运行网页的 Node    │
└─────────┬───────────┘   └─────────┬───────────┘
          │ 合并                     │
          ▼                         ▼
┌─────────────────────────────────────────────┐
│ production (L104)  正式成品镜像               │
│  ├─ 非 root 用户 deeptutor (L198)            │
│  ├─ entrypoint.sh 重导配置 (L318/L439)        │
│  └─ EXPOSE 8001 3782 (L431)                  │
└──────────────────────┬──────────────────────┘
                       │ 在其上叠加
                       ▼
┌─────────────────────────────────────────────┐
│ development (L444)  开发镜像                  │
│  源码只读挂载 + 热更新                        │
└─────────────────────────────────────────────┘
```

一句话：**production 是"发货版"，development 是"调试版"，它们共用同一套 Python/Node 底座**，只是最后一步不同。这就是多阶段构建省空间又灵活的关键。

## 36.3 docker-compose：一次启动"全家桶"

单个容器只跑一个服务。DeepTutor 至少要四个角色一起工作：

```text
pocketbase      （轻量数据库，存用户/书籍/进度）
deeptutor       （我们的主程序镜像，build target=production）
sandbox-runner  （代码沙箱，隔离执行用户提交的代码）
```

compose 文件把它们编排到一起。看主文件 `docker-compose.yml`：

```text
L21   services:
L27   pocketbase:                                   # 数据库
L28     image: ghcr.io/muchobien/pocketbase:latest
L54   deeptutor:                                    # 主程序
L55     build:
L58       target: production                        # 用 Dokerfile 的 production 阶段
L83       - DEEPTUTOR_SANDBOX_RUNNER_URL=http://sandbox-runner:8900
L112  sandbox-runner:                               # 沙箱
L150     - no-new-privileges:true                   # 禁止提权
L157     read_only: true                            # 根文件系统只读
```

注意 L83：compose 通过环境变量 `DEEPTUTOR_SANDBOX_RUNNER_URL` 告诉主程序"沙箱在哪"。容器之间用服务名（如 `sandbox-runner`）当域名互相访问，这就是编排的价值——你不用记 IP。

沙箱容器（`sandbox-runner`）被额外加固：`read_only: true`（L157，根文件系统只读，只能写临时内存盘 tmpfs）和 `no-new-privileges:true`（L150，即使程序被攻破也拿不到更高权限）。这和第 25 章讲的安全沙箱是一脉相承的。

### 36.3.1 开发版与镜像版两种玩法

同一个 `deeptutor` 服务，compose 提供了不同"变体"：

| 文件 | 镜像来源 | 用途 | 关键差异 |
| --- | --- | --- | --- |
| `docker-compose.yml` | 本地 `build` | 默认，含数据库+沙箱 | `target: production` |
| `docker-compose.dev.yml` | 本地 `build` | 开发调试 | `target: development`，源码只读挂载 |
| `docker-compose.ghcr.yml` | 远程拉取 | 不想自己编译 | `image: ghcr.io/hkuds/deeptutor:latest` |

开发版把源码挂进去，改完立刻生效：

```text
docker-compose.dev.yml:L19     target: development
docker-compose.dev.yml:L23     - ./deeptutor:/app/deeptutor:ro      # 只读挂载源码
```

镜像版直接用别人编译好的成品，省去构建时间：

```text
docker-compose.ghcr.yml:L41    image: ghcr.io/hkuds/deeptutor:latest
docker-compose.ghcr.yml:L57    - ./data:/app/data                   # 持久化数据
```

> **注意 · 数据要"挂出来"**
>
> 容器本身是临时的，删了就没了。所有重要数据（书籍、进度、数据库）都必须通过 `./data:/app/data` 这样的"数据卷挂载"写到宿主机硬盘上，否则一重启全丢失。

## 36.4 端口发现：不和别的程序"撞车"

你电脑上可能已经跑了别的服务占了 8001 端口。DeepTutor 没有写死端口，而是用一个"启动器" `deeptutor/runtime/launcher.py` 在运行时智能选端口。

它的逻辑是一套"探测—建议—解决冲突"的流程：

```text
launcher.py:L302   _suggest_free_port(preferred, taken)   # 找一个没被占的端口
launcher.py:L309   _prompt_port(label, default, taken)     # 交互式让用户手填
launcher.py:L409   _resolve_port_conflicts(...)            # 统一解决冲突
launcher.py:L441   raise SystemExit(...)                  # 非交互环境直接报错退出
```

程序启动时的主干在 `launcher.py:930` 附近的 `start(home, dev)`：它先分别给"后端端口""前端端口"做解析，再一次性调用 `_resolve_port_conflicts` 把冲突摆平。

核心思路画成一张图：

```text
启动 DeepTutor
      │
      ▼
读取"期望端口"（如 8001 / 3782）
      │
      ▼
_probe: 这个端口现在有没有人用？
      │
  ┌───┴───────────────┐
  │ 没人用            │ 有人用（冲突）
  ▼                  ▼
  直接用         _suggest_free_port 找一个空端口
                    │
                    ▼
            交互终端？── 是 ──> _prompt_port 让用户手填
                    │
                   否（如服务器后台）
                    ▼
            _resolve_port_conflicts 抛 SystemExit 退出（L441）
```

`_resolve_port_conflicts` 在"非交互环境"（比如你用 `nohup` 后台启动、没有真人敲键盘）下，若仍无法解决冲突会直接 `raise SystemExit`（`launcher.py:441`），而不是卡住等你输入——这是为了避免服务悄悄挂死。

> **提示 · 一句话记住**
>
> 端口不是"写死"的，而是"探测出来的"。这叫**端口发现（port discovery）**，是部署一个会"撞车"的服务时的标准做法。

## 36.5 依赖分组：只装你需要的那一块

DeepTutor 既能当"纯命令行工具"，也能当"带网页的服务器"。它用 `pyproject.toml` 里的**可选依赖分组（optional-dependencies）**来裁剪体积：

```text
pyproject.toml:L18     requires-python = ">=3.11,<3.14"
pyproject.toml:L80     [project.optional-dependencies]
pyproject.toml:L84     cli = [ ... ]                       # 命令行专属依赖
pyproject.toml:L113    server = [ ... deeptutor[cli] ... ] # 服务器（含 cli）
pyproject.toml:L240    all = [ ... ]                       # 全家桶
```

含义：
- `cli`（L84）：只装命令行要用的库，体积最小。
- `server`（L113）：装服务器所需的库，并且**自带** `deeptutor[cli]`（L113 那行写了 `deeptutor[cli]`），所以装了 server 一定有 cli。
- `all`（L240）：把 graphrag、matrix、math-animator、dev 等全部装上。
- 还有更细的：`graphrag`（L210）、`rag-lightrag`（L220）、`dev`（L223）等，按需取用。

你安装时这样选：

```bash
pip install -e ".[cli]"         # 只要命令行
pip install -e ".[server]"      # 要网页服务器
pip install -e ".[all]"         # 全都来
```

对应到容器里，production 镜像走的是 `server`（带网页），而独立的 `deeptutor-cli` 小包装走的是 `cli`（无网页、无服务器依赖）。

## 36.6 进阶：只读根文件系统与 rootless Podman

如果你追求极致安全，`CONTAINERIZATION.md` 提供了"硬核路径"：用 **Podman** 以**无 root（rootless）**方式运行，并把容器根文件系统设为**只读**。

```text
CONTAINERIZATION.md:L4    推荐 docker run 路径，以及加固的 rootless-Podman 只读根fs 路径
CONTAINERIZATION.md:L24   "docker run" —— 简单路径，rootful，可写根fs
CONTAINERIZATION.md:L29   "podman compose" —— 加固路径，rootless（userns keep-id），只读根fs
CONTAINERIZATION.md:L62   docker run --rm --name deeptutor ...
CONTAINERIZATION.md:L250  ## Podman / rootless / read-only rootfs
CONTAINERIZATION.md:L270  read_only: true 作用于每个服务，唯一可写的是 tmpfs 挂载
```

普通 `docker run`（L24/L62）是 rootful、可写根文件系统的"省心版"；而 `podman compose`（L29/L260）是 rootless、只读根文件系统的"硬核版"——即使容器被攻破，攻击者也改不了系统文件，只能动那一点点内存临时盘。

> **说明 · 三种运行方式怎么选**
>
> 1. **`docker run`**：最快上手，适合本地试玩。
> 2. **`docker compose`**：带数据库和沙箱，适合长期自用。
> 3. **`podman compose`（只读）**：最安全，适合公网或多人环境。

## 36.7 端口是怎么被"探测"出来的

`_resolve_port_conflicts` 不是凭空猜的，它底下有几把"探针"：

```text
launcher.py:L215   _port_accepts_connection(host, port)   # 这个端口现在能连吗？
launcher.py:L223   _port_listeners(port)                  # 谁在监听这个端口？
launcher.py:L341   _persist_ports(ports)                  # 把最终定下的端口存起来
```

流程是：先用 `_port_listeners` 看有没有进程占着端口；若占着，就换 `_suggest_free_port`（`launcher.py:302`）在一段候选区间里找一个空闲的；最终用 `_persist_ports`（`launcher.py:341`）把"后端端口 + 前端端口"记到配置文件里，下次启动直接复用，避免天天变端口让人找不到。

> **提示 · 工程直觉**
>
> "先探测、再决策、最后持久化"是一个很稳的模式。你以后写任何会监听网络的服务，都应该复用这套思路，而不是硬编码 `port = 8001`。

## 36.8 依赖分组到底装了什么（对照表）

为了让你有体感，把常用分组对照列出来：

| 分组 | 何时用 | 典型包含 | 来源 |
| --- | --- | --- | --- |
| `cli` | 只用命令行 | 终端交互、基础 LLM 调用 | `pyproject.toml:84` |
| `server` | 要网页+API | 含 `cli` + Web 框架 + 数据库驱动 | `pyproject.toml:113` |
| `graphrag` | 要 GraphRAG 检索 | `graphrag` 库 | `pyproject.toml:210` |
| `rag-lightrag` | 要 LightRAG 检索 | `raganything` 库 | `pyproject.toml:220` |
| `dev` | 要跑测试/lint | 测试与格式化工具 | `pyproject.toml:223` |
| `all` | 全功能 | 上述几乎全部 | `pyproject.toml:240` |

注意 `server` 在定义里直接写了 `deeptutor[cli]`（`pyproject.toml:113`），这就是"装 server 必然带 cli"的语法来源——方括号引用了同文件里的另一个分组。

## 36.9 动手演练：用 Docker 把 DeepTutor 跑起来

光看不练记不牢。下面是一段"从零到能打开网页"的最小命令流（用默认 compose，含数据库+沙箱）：

```bash
# 1) 进入源码目录
cd DeepTutor

# 2) 一键启动全家桶（后台运行）
docker compose up -d

# 3) 看日志，确认后端/前端都起来了
docker compose logs -f deeptutor

# 4) 浏览器打开 http://localhost:3782 即可使用
#    后端 API 在 http://localhost:8001
```

如果你不想自己编译镜像，改用现成镜像版：

```bash
# 用 ghcr 预编译镜像，而不是本地 build
docker compose -f docker-compose.ghcr.yml up -d
```

若启动失败提示"端口被占用"，回到 36.4 看 `launcher.py` 的端口发现逻辑——它会自动换端口，或者你在非交互环境看到 `SystemExit`（`launcher.py:441`）退出，就需要手动改配置里的端口再启动。

> **注意 · 安装前先确认**
>
> - 已安装 Docker（或 Podman）且服务在运行。
> - 8001 / 3782 两个端口没被别的程序占用（或允许自动切换）。
> - `./data` 目录所在磁盘有足够空间存放书籍与数据库。

## 36.10 这一章你其实学会了什么

回顾一下，你从一个完全不懂编程的人，现在能说出：DeepTutor 是怎么被"装箱"的（Dockerfile 多阶段）、怎么"一起启动"的（compose 全家桶）、怎么"不撞端口"的（launcher 端口发现）、怎么"按需瘦身"的（pyproject 依赖分组），以及怎么"更安全地跑"（rootless + 只读根fs）。

这套思路不只属于 DeepTutor，而是**几乎每个现代 AI 服务的标准部署范式**。你把这个范式吃透，以后部署任何开源智能体都通用。

## 自查清单

- [ ] 我能用一句话解释"容器""镜像""编排"分别是什么。
- [ ] 我知道 Dockerfile 为什么要用"多阶段构建"（前端编译、后端运行分开）。
- [ ] 我能说出 DeepTutor 暴露的两个端口（8001 后端 / 3782 前端）及其来源 `Dockerfile:431`。
- [ ] 我理解为什么要用非 root 用户 `deeptutor`（UID 1000，`Dockerfile:198`）。
- [ ] 我能列出 compose 里至少三个服务：pocketbase、deeptutor、sandbox-runner。
- [ ] 我知道端口发现由 `launcher.py` 的 `_resolve_port_conflicts`（`launcher.py:409`）负责。
- [ ] 我能区分 `cli` / `server` / `all` 三个依赖分组的用途（`pyproject.toml:84/113/240`）。
- [ ] 我明白"数据卷挂载"（`- ./data:/app/data`）为什么不能省，否则数据会丢。
- [ ] 我知道 rootless + 只读根文件系统比普通 `docker run` 更安全（`CONTAINERIZATION.md:270`）。
