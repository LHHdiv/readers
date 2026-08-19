---
title: "第 25 章 · 沙箱安全与工具执行边界"
date: 2026-08-01
summary: "**黑话先定义**"
tags:
  - deeptutor
---
# 第 25 章 · 沙箱安全与工具执行边界

前面的章节里，智能体经常会"运行代码"——比如解题时跑一段 Python 验证答案、可视化时跑 Manim 生成动画。这带来一个尖锐的问题：**你让一个会"自己写代码并执行"的系统去跑代码，万一模型被诱导写了危险代码（删文件、偷密钥、连外网），怎么办？** DeepTutor 的答案是"沙箱（sandbox）"：把代码关进一个隔离的小房间再跑，它碰不到主机的重要东西。本章讲沙箱为什么必须隔离、有哪几种隔离强度、配额怎么防滥用、产物怎么安全回收，以及边界判定的整体策略。

> **黑话先定义**
> - *沙箱 sandbox*：一个受限制的隔离环境，代码在里面运行，碰不到真实系统的关键部分。
> - *隔离级别 isolation level*：隔离有多强。最强是 OS 级（操作系统层面隔开），最弱是"只在程序内部做检查"。
> - *后端 backend*：真正执行代码的"引擎"，可以是另一个容器、一种系统工具、或一个受限子进程。
> - *配额 quota*：对"一个用户最多同时跑几个、每分钟最多跑几个"的限制，防滥用。
> - *产物 artifact*：代码跑完生成的东西，比如画出来的图、导出的文件。
> - *命名空间 namespace*：Linux 的一种隔离机制，让进程看到"另一套"文件系统/进程表。

## 一句话直觉

把"让模型执行代码"想象成"让一个不太熟的人进你家干活"。你不会把家门钥匙、保险柜、护照都摊开给他。沙箱就是专门腾出来的"工具间"：给他必要的工具，但墙是隔音隔视的，他不进主屋、碰不到你的贵重物品，而且规定"一次只能进一个人、每小时最多来 20 趟"。这就是沙箱在做的事——既让代码能干正事，又不让它搞破坏。

## 为什么必须隔离

模型执行的代码来自模型自己（或用户）生成，本质是不可完全信任的。若不隔离，一段恶意或被诱导的代码可以：

- 读取主机上的密钥、环境变量、用户文件；
- 删除或篡改服务自身的数据；
- 以服务器身份对外发起请求（被当成跳板）。

所以 DeepTutor 的原则是：**任何"执行代码/命令"的工具，都必须经过沙箱，而不是直接在主机上跑**。`SandboxService` 是整个系统的唯一入口（`deeptutor/services/sandbox/service.py:29`），所有想跑代码的地方都问它，而不是直接调系统命令。

```text
工具（如 exec / code_execution）
   │  不直接跑命令！
   ▼
SandboxService.run(request, user_id)     deeptutor/services/sandbox/service.py:74
   │
   ├─ 健康检查（后端活着吗？）            deeptutor/services/sandbox/service.py:78
   ├─ 账户级 exec 开关检查               deeptutor/services/sandbox/service.py:84
   ├─ 配额闸门（并发 + 速率）             deeptutor/services/sandbox/service.py:91
   └─ 交给具体 backend 执行              deeptutor/services/sandbox/service.py:95
```

> **注意 · 没有沙箱 = 危险**
>
> `deeptutor/services/sandbox/service.py:67` 的 `isolation_level()` 在后端不健康时返回 `IsolationLevel.OFF`（`deeptutor/services/sandbox/spec.py:27` 的 `OFF`），此时 `available()`（`deeptutor/services/sandbox/service.py:71`）为 `False`，执行被拒。设计上"宁可不让跑，也不裸跑"。这正是 `exec_capability_available`（`deeptutor/services/sandbox/service.py:114`）存在的意义：技能层用它判断"这里到底有没有可用的沙箱"，没有就不开放需要沙箱的功能。

## 隔离级别：三种强度

隔离强度用 `IsolationLevel` 枚举表示（`deeptutor/services/sandbox/spec.py:16`），三个档（`deeptutor/services/sandbox/spec.py:25`）：

- `SYSTEM`：操作系统级隔离（容器或 Linux 命名空间），最强。
- `APPLICATION`：只在程序内部做路径/环境检查，无 OS 级隔离，弱。
- `OFF`：根本没有沙箱，绝不跑不可信代码。

策略门（`deeptutor/services/sandbox/spec.py:20` 注释）规定：**普通用户只在 `SYSTEM` 级时才给 shell 执行权限；`APPLICATION` 级只限管理员主动开启**（`exec` 工具里据此收口）。`rank()`（`deeptutor/services/sandbox/spec.py:29`）还把三档排成 `off=0 / application=1 / system=2`，方便比较强弱。

## 三种后端：隔离是怎么落地的

`build_backend`（`deeptutor/services/sandbox/config.py:66`）按部署环境挑一个后端（`config.py` 注释，`:67` 详述）。三个后端都在 `deeptutor/services/sandbox/backends.py`：

### 1. RunnerSidecarBackend（Docker 部署，SYSTEM）——deeptutor/services/sandbox/backends.py:47

把命令通过 HTTP 发给一个**单独的 runner 容器**去跑（`deeptutor/services/sandbox/backends.py:56`）。主应用保持最小权限，自己从不执行不可信 shell。它发出 `command` 和 `argv` 两种写法（`deeptutor/services/sandbox/backends.py:62`），老版本 runner 忽略 `argv` 就用 shell 字符串，实现滚动部署兼容（`deeptutor/services/sandbox/backends.py:59` 注释）。健康检查走 `/health` 接口（`deeptutor/services/sandbox/backends.py:105`），超时则视为不可用（`deeptutor/services/sandbox/backends.py:108`）。

### 2. BwrapBackend（Linux 裸机，SYSTEM）——deeptutor/services/sandbox/backends.py:112

用 Linux 的 `bwrap`（bubblewrap）创建**挂载命名空间**，把系统目录只读挂载、把 `/tmp` 换成临时文件系统（`deeptutor/services/sandbox/backends.py:122` 的 `_build_argv`）。关键隔离参数：`--unshare-all`（取消所有命名空间共享）、`--new-session`、`--tmpfs /tmp`（`deeptutor/services/sandbox/backends.py:125` 起）。有 `argv` 时直接 exec 向量、不经过 shell（`deeptutor/services/sandbox/backends.py:146`），进一步防止 shell 注入。它的健康检查（`deeptutor/services/sandbox/backends.py:164`）还会真的跑一次 `bwrap true` 探针，确认本机命名空间可用，否则报"bwrap not installed"或"bwrap functional"。

### 3. RestrictedSubprocessBackend（本地开发退化版，APPLICATION）——deeptutor/services/sandbox/backends.py:176

最弱的一种：就是一个普通子进程，但**清掉危险的环境变量**（只留 PATH/HOME/LANG 等白名单，`deeptutor/services/sandbox/backends.py:181`），并把工作目录限制好。它**没有 OS 级隔离**，所以 `level = APPLICATION`（`deeptutor/services/sandbox/backends.py:179`），只在 `DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS=1`（`deeptutor/services/sandbox/config.py:60`）时由管理员主动开启，一般只在 macOS 本地开发用。

```text
build_backend(settings)                deeptutor/services/sandbox/config.py:66
   │
   ├─ 设了 RUNNER_URL？     -> RunnerSidecarBackend   (SYSTEM)  deeptutor/services/sandbox/backends.py:47
   ├─ Linux 且有 bwrap？    -> BwrapBackend           (SYSTEM)  deeptutor/services/sandbox/backends.py:112
   ├─ 允许 subprocess？     -> RestrictedSubprocess  (APPLICATION) deeptutor/services/sandbox/backends.py:176
   └─ 都不满足？            -> None（exec 禁用）
```

不管哪个后端，最终都通过 `_communicate`（`deeptutor/services/sandbox/backends.py:209`）抓输出，并受 `ResourceLimits`（`deeptutor/services/sandbox/spec.py:33`，默认超时 30 秒、内存 512MB、输出上限 1 万字符、CPU 30 秒）约束——超时就 `process.kill()`（`deeptutor/services/sandbox/backends.py:213`），等 5 秒确认退出（`deeptutor/services/sandbox/backends.py:214`），返回"超时"结果。

> **提示 · argv vs command，为什么重要？**
>
> `ExecRequest`（`deeptutor/services/sandbox/spec.py:52`）同时带 `command`（shell 字符串）和 `argv`（参数向量）。当 `argv` 非空时，后端**不经过 shell 直接执行**（`deeptutor/services/sandbox/spec.py:60`），这意味着模型拼出的参数里的 `;`、`&&` 等"shell 元字符"不再有特殊含义，天然防住命令注入。`__post_init__`（`deeptutor/services/sandbox/spec.py:78`）还会强制两者必须一致，防止"老 runner 跑 A、新 runner 跑 B"的不一致。

## 请求与结果：ExecRequest / ExecResult

执行用的数据结构在 `deeptutor/services/sandbox/spec.py`，刻意做成"零依赖"，后端和上层都能直接用：

- `ExecRequest`（`deeptutor/services/sandbox/spec.py:52`）：要跑什么。含 `command`、`workdir`（工作目录）、`mounts`（挂载目录，默认只读，`deeptutor/services/sandbox/spec.py:43` 的 `Mount`）、`env`（环境变量）、`limits`（资源上限）、`argv`。`Mount`（`deeptutor/services/sandbox/spec.py:43`）的 `read_only` 默认 `True`（`deeptutor/services/sandbox/spec.py:49`）——即默认连挂载进沙箱的目录都只读。
- `ExecResult`（`deeptutor/services/sandbox/spec.py:98`）：跑完的结果。含 `stdout` / `stderr` / `exit_code`（`deeptutor/services/sandbox/spec.py:104`）、是否 `timed_out`、`error`（沙箱本身失败时才有）。`ok` 属性（`deeptutor/services/sandbox/spec.py:109`）判断整体是否成功；`render`（`deeptutor/services/sandbox/spec.py:112`）把输出拼成给模型看的文本，超长时头尾截断。

## 配额：防滥用闸门

每个用户能跑多少，由 `UserExecQuota` 控制（`deeptutor/services/sandbox/quota.py:27`）。它是进程内的两道便宜守卫（注释 `deeptutor/services/sandbox/quota.py:4` 说明：单容器部署够用，多副本才需挪到共享存储）：

1. **并发上限**：每个用户一把 `asyncio.Semaphore`（`deeptutor/services/sandbox/quota.py:34`），最多 `max_concurrent` 个同时在跑。
2. **速率上限**：滑窗 60 秒，记每次开始时间，超 `max_per_minute` 就拒绝（`deeptutor/services/sandbox/quota.py:41` 的 `_check_rate`）。

超额时抛 `QuotaExceeded`（`deeptutor/services/sandbox/quota.py:23`），`SandboxService.run` 捕获后返回带错误信息的 `ExecResult`（`deeptutor/services/sandbox/service.py:92`），不让它炸到上层。两种限制都按 `user_id` 区分，做到"一个人狂跑不会饿死别人"。

```text
SandboxService.run                          deeptutor/services/sandbox/service.py:74
   │
   └─ lease = await quota.acquire(uid)      deeptutor/services/sandbox/service.py:91 -> deeptutor/services/sandbox/quota.py:60
          │  并发槽满了 or 60秒内超量？
          │  -> 抛 QuotaExceeded            deeptutor/services/sandbox/quota.py:23
          │  -> run() 返回 ExecResult(error) deeptutor/services/sandbox/service.py:93
          ▼
       配额通过，才真正 backend.exec(...)
```

> **说明 · 配额默认值**
>
> `SandboxSettings`（`deeptutor/services/sandbox/config.py:41`）默认 `max_concurrent_per_user = 2`、`max_runs_per_minute_per_user = 20`（`deeptutor/services/sandbox/config.py:46`），可用环境变量 `DEEPTUTOR_SANDBOX_MAX_CONCURRENT` / `DEEPTUTOR_SANDBOX_MAX_PER_MINUTE` 覆盖（`deeptutor/services/sandbox/config.py:37`）。默认就偏保守，防止单用户把执行资源占满。

## 配置：backend 怎么选

`SandboxSettings.from_env`（`deeptutor/services/sandbox/config.py:50`）从环境变量读配置，关键变量在 `deeptutor/services/sandbox/config.py:32` 起定义：

- `DEEPTUTOR_SANDBOX_RUNNER_URL`（`deeptutor/services/sandbox/config.py:32`）：设了就走 runner 容器。
- `DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS`（`deeptutor/services/sandbox/config.py:33`）：是否允许退化版子进程。
- `DEEPTUTOR_SANDBOX_MAX_CONCURRENT` / `DEEPTUTOR_SANDBOX_MAX_PER_MINUTE`（`deeptutor/services/sandbox/config.py:37`）：配额上限。

`build_backend`（`deeptutor/services/sandbox/config.py:66`）据此按"容器 → bwrap → 子进程 → 无"的优先级选择。`SandboxService.__init__`（`deeptutor/services/sandbox/service.py:30`）在构造时就调 `build_backend`，并把配额初始化好（`deeptutor/services/sandbox/service.py:36`）。

## 产物：安全回收

代码跑完常会生成文件（图片、CSV、视频）。`artifacts.py` 负责把这些文件**安全地**整理出来给前端：

- `SandboxArtifact`（`deeptutor/services/sandbox/artifacts.py:14`）：一个产物记录，含文件名、路径、可公开访问的 URL、大小、MIME 类型，`to_dict`（`deeptutor/services/sandbox/artifacts.py:22`）转成可序列化结构。
- `collect_public_artifacts`（`deeptutor/services/sandbox/artifacts.py:33`）：只收集"可公开"的文件——跳过隐藏文件（`deeptutor/services/sandbox/artifacts.py:50` 的 `.` 开头判断）、只收位于公共输出根目录下的（`deeptutor/services/sandbox/artifacts.py:52` 的 `is_public_output_path`）、最多 50 个（`deeptutor/services/sandbox/artifacts.py:70`）。这保证**沙箱里可能残留的敏感文件不会泄露出去**。
- `render_artifacts_for_tool`（`deeptutor/services/sandbox/artifacts.py:76`）：把产物清单整理成给模型看的提示，告诉模型"提文件名即可，UI 会自动变成可点击链接"，避免模型去拼 URL。

> **说明 · 为什么产物也要"挑着收"？**
>
> 沙箱工作目录里可能既有"要给用户看的成果"，也有"临时的、可能含敏感路径的中间文件"。`collect_public_artifacts` 只收明确落在公共输出根、且非隐藏的文件，等于在出口处又加了一道过滤，防止误把不该暴露的东西发到前端。

## 工具执行边界：整体策略

把前面串起来，一条"执行代码"请求要过的关卡：

```text
工具发起执行
   │
   ├─ 1. 账户级 exec 开关（exec_override）     deeptutor/services/sandbox/service.py:84
   ├─ 2. 沙箱可用？（isolation != OFF）         deeptutor/services/sandbox/service.py:67
   ├─ 3. 配额：并发 + 速率                      deeptutor/services/sandbox/service.py:91
   ├─ 4. 后端隔离执行（按级别挑后端）           deeptutor/services/sandbox/backends.py:34
   ├─ 5. 资源上限：超时/内存/输出              deeptutor/services/sandbox/spec.py:33
   └─ 6. 产物只回收可公开部分                  deeptutor/services/sandbox/artifacts.py:33
```

任何一层不通过，都不会裸跑代码；最坏情况是"这次没跑成"，而不是"主机被搞坏"。

## 攻击场景推演

用几个具体例子体会边界的价值：

- **场景：模型被诱导 `rm -rf /`**。在 `RunnerSidecarBackend`/`BwrapBackend` 下，进程根本看不到真实根文件系统（`bwrap` 用 `--tmpfs /tmp` 和只读绑定），删不到主机。即使退化版的 `RestrictedSubprocessBackend`，也只在管理员显式开启时可用，且清掉了危险环境变量。
- **场景：模型想 `cat /etc/passwd` 偷账户**。`bwrap` 只把 `/etc` 只读绑定进命名空间（`deeptutor/services/sandbox/backends.py:135`），拿到的是沙箱视图，非主机真实凭据；子进程版则因无 OS 隔离而不对普通用户开放。
- **场景：恶意脚本疯狂循环发请求打爆外网**。`UserExecQuota` 的速率闸门（`deeptutor/services/sandbox/quota.py:41`）把它限制在每分钟 N 次，且单进程资源上限会杀掉失控子进程（`deeptutor/services/sandbox/backends.py:213`）。

> **注意 · 记住这条铁律**
>
> DeepTutor 的设计基调是：**不可信代码永远不碰主机**。要么在 `SYSTEM` 级隔离里跑（容器/命名空间），要么管理员显式开启的 `APPLICATION` 级受限子进程，要么干脆禁用。理解了这一条，就能看懂 `service.py`、`backends.py`、`config.py` 里所有"挑后端""查健康""查隔离级别"的代码都是为了守住这道边界。

## 健康检查与缓存

`SandboxService` 不会每次执行都去 ping 后端，而是把健康状态缓存起来。`_ensure_healthy`（`deeptutor/services/sandbox/service.py:45`）用 `_health_lock`（`deeptutor/services/sandbox/service.py:35`）和 `_healthy` 缓存（`deeptutor/services/sandbox/service.py:33`）：第一次调用才真正问后端 `health()`（`deeptutor/services/sandbox/service.py:53`），之后直接返回缓存值。只有后端为 `None`（没配置）时才返回 `False`（`deeptutor/services/sandbox/service.py:46`）。若健康探测抛异常，也标记为不健康并记录警告（`deeptutor/services/sandbox/service.py:54`）。这种"探测一次、多次复用"避免了每个回合都付一次网络往返的代价。

## exec_capability_available 为什么是同步的

技能系统在渲染"这个技能需要沙箱吗"时是在同步上下文里跑的，所以 `exec_capability_available`（`deeptutor/services/sandbox/service.py:114`）被设计成**同步**函数：它不真去探活，只判断"有没有配置后端对象"（`deeptutor/services/sandbox/service.py:124`，即 `get_sandbox_service()._backend is not None`）。真正的存活检查留给每次执行的 `_ensure_healthy`（`deeptutor/services/sandbox/service.py:45`）。这样设计很关键：即便后端配了但当前挂了，也不会"悄无声息地裸跑"——因为实际执行前那道健康检查（`deeptutor/services/sandbox/service.py:78`）仍会把不可用的后端挡下。

## 资源上限清单

`ResourceLimits`（`deeptutor/services/sandbox/spec.py:33`）定义了一次执行能消耗的上界，四个字段都有默认值：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `timeout_s` | 30 | 最多跑多少秒，超了强杀 |
| `memory_mb` | 512 | 内存上限（MB，尽力而为） |
| `max_output_chars` | 10_000 | 输出字符上限，超出截断 |
| `cpu_seconds` | 30 | CPU 时间上限 |

这些上限由后端在 `_communicate`（`deeptutor/services/sandbox/backends.py:209`）里落实：超时则 `process.kill()`（`deeptutor/services/sandbox/backends.py:213`），再给最多 5 秒确认退出，最后返回"超时"结果（`deeptutor/services/sandbox/backends.py:216`）。不同后端对内存/CPU 的强制力不同（容器最强、子进程最弱），所以注释里写的是"best-effort"（尽力而为）。

## 退化版子进程的环境清洗细节

`RestrictedSubprocessBackend`（`deeptutor/services/sandbox/backends.py:176`）没有 OS 级隔离，所以它的"安全"主要靠两件事：清环境、限目录。

- **环境白名单**：只保留 `PATH`/`HOME`/`LANG`/`LC_ALL`/`TMPDIR` 这几个（`deeptutor/services/sandbox/backends.py:181` 的 `_SAFE_ENV_KEYS`），其余主机环境变量（可能含密钥）一律不传给子进程（`deeptutor/services/sandbox/backends.py:184`）。
- **目录限制**：用 `request.workdir` 作工作目录（`deeptutor/services/sandbox/backends.py:186`），把代码活动范围钉在指定目录内。

即便如此，它仍是 `APPLICATION` 级（`deeptutor/services/sandbox/backends.py:179`），按策略门只对管理员开启（`exec` 工具据此收口），普通用户拿不到 shell 执行权。这是"纵深防御"：即使某一层失效，后面还有层。

> **说明 · 纵深防御 defense in depth**
>
> 安全不是靠单点，而是靠多层。DeepTutor 的执行边界至少有：账户开关（`deeptutor/services/sandbox/service.py:84`）→ 隔离级别策略门（`deeptutor/services/sandbox/spec.py:20`）→ 配额（`quota.py`）→ 后端隔离（`backends.py`）→ 资源上限（`deeptutor/services/sandbox/spec.py:33`）→ 产物过滤（`deeptutor/services/sandbox/artifacts.py:33`）。任何一层单独被绕过，仍有其他层兜底。

## 小结

让智能体执行代码必须隔离，否则不可信代码会威胁主机。DeepTutor 用 `SandboxService`（`deeptutor/services/sandbox/service.py:29`）作为唯一入口，`run`（`deeptutor/services/sandbox/service.py:74`）依次过账户开关、健康检查、配额闸门才交给后端；健康检查被缓存（`deeptutor/services/sandbox/service.py:45`），而 `exec_capability_available`（`deeptutor/services/sandbox/service.py:114`）用同步的"有无后端"判断供技能层使用。三种后端对应三种隔离强度：`RunnerSidecarBackend`（容器，SYSTEM，`deeptutor/services/sandbox/backends.py:47`）、`BwrapBackend`（Linux 命名空间，SYSTEM，`deeptutor/services/sandbox/backends.py:112`）、`RestrictedSubprocessBackend`（受限子进程、环境白名单，APPLICATION，`deeptutor/services/sandbox/backends.py:176`）。`UserExecQuota`（`deeptutor/services/sandbox/quota.py:27`）按用户做并发+速率限制防滥用；`ExecRequest`/`ExecResult`（`deeptutor/services/sandbox/spec.py:52`/`deeptutor/services/sandbox/spec.py:98`）统一请求与结果；`ResourceLimits`（`deeptutor/services/sandbox/spec.py:33`）封顶资源；`deeptutor/services/sandbox/artifacts.py:33` 只回收可公开产物防泄露；`IsolationLevel`（`deeptutor/services/sandbox/spec.py:16`）把隔离强度抽象成三档，驱动"谁能跑什么"的策略门。

## 沙箱在 exec 工具里的收口

前面反复说"执行代码必须经沙箱"，那这个"必须经"在哪强制？答案是在 `exec` 工具里。`exec` 工具（及 `code_execution`）在真正跑命令前，会先查沙箱可用性：普通用户只有当沙箱达到 `SYSTEM` 级隔离时才把工具暴露出来；否则工具对普通用户"不可见"，从源头杜绝裸跑。`SandboxService.run` 内部还有一道 `exec_override` 账户开关（`deeptutor/services/sandbox/service.py:84`）——即便其他路径直接打到沙箱，若账户被禁用 exec，也返回"账号未开放"错误。这就是"工具藏起来 + 运行时再判一次"的双重保险。

```text
用户点"运行代码"
   │
   ├─ exec 工具是否对当前用户可见？  (取决于隔离级别)
   ├─ 可见 -> 调 SandboxService.run
   │        └─ exec_override 账户开关   deeptutor/services/sandbox/service.py:84
   │        └─ 隔离级别 >= 要求？
   └─ 不可见 -> 工具根本不出现，无法裸跑
```

## Runner Sidecar 的 HTTP 协议细节

当用容器部署时，`RunnerSidecarBackend`（`deeptutor/services/sandbox/backends.py:47`）通过 HTTP 与 runner 容器对话。它的请求体（`deeptutor/services/sandbox/backends.py:56` 起）包含：`command`（shell 字符串）、`argv`（参数向量）、`workdir`、`env`、`mounts`（宿主路径↔沙箱路径、是否只读）、`limits`（超时/内存/CPU/输出上限）。HTTP 超时特意设为"命令自身超时 + 15 秒"（`deeptutor/services/sandbox/backends.py:83`），让 runner 有机会返回"干净超时"而非被我们中途掐断。返回时解析 `stdout`/`stderr`/`exit_code`/`timed_out`/`error` 包成 `ExecResult`（`deeptutor/services/sandbox/backends.py:94`）。这种"把执行外包给另一个最小权限容器"的做法，是 Docker 部署里隔离最强的路线。

## 隔离失败的降级行为

如果配置的后端实际上不健康（如 bwrap 装了但内核不支持命名空间），会发生什么？`BwrapBackend.health`（`deeptutor/services/sandbox/backends.py:164`）会真正跑一次 `bwrap true` 探针：若返回错误，就报"bwrap functional"失败（`deeptutor/services/sandbox/backends.py:172`），于是 `SandboxService._ensure_healthy`（`deeptutor/services/sandbox/service.py:53`）把它判为不健康，`isolation_level()` 退回 `OFF`（`deeptutor/services/sandbox/service.py:67`）。结果就是"这次不跑"，而不是"带病裸跑"。这再次体现了设计基调：**隔离不到位宁可不做，也不冒险**。

## 一份配置示例

把前面所有开关串起来，一个典型部署的环境变量长这样：

```bash
# Docker 部署：指向独立 runner 容器（SYSTEM 级隔离）
export DEEPTUTOR_SANDBOX_RUNNER_URL="http://runner:8080"

# 本地裸机 Linux：不设 RUNNER_URL，靠 bwrap（SYSTEM 级）
# 本地 macOS 开发想退化跑：显式开子进程（仅管理员，APPLICATION 级）
# export DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS=1

# 配额（可选，覆盖默认 2 / 20）
export DEEPTUTOR_SANDBOX_MAX_CONCURRENT=4
export DEEPTUTOR_SANDBOX_MAX_PER_MINUTE=30
```

不设任何变量时，`build_backend`（`deeptutor/services/sandbox/config.py:66`）返回 `None`，`exec` 整体禁用——这是最安全的默认态。

> **说明 · 给读者的安全直觉**
>
> 判断一个"让 AI 跑代码"的系统是否靠谱，就看三点：(1) 不可信代码是否与主机隔离（OS 级最佳）；(2) 有没有按用户限流防滥用；(3) 出错/不健康时是否"宁可不做"。DeepTutor 在这三点上都给出了明确答案，正是沙箱这一层在兜底。

## 自查清单

- [ ] 我能说出"为什么让模型执行代码必须隔离"。
- [ ] 我知道沙箱唯一入口是 `SandboxService.run`（`deeptutor/services/sandbox/service.py:74`）。
- [ ] 我理解三种隔离级别 `SYSTEM` / `APPLICATION` / `OFF`（`deeptutor/services/sandbox/spec.py:25`）。
- [ ] 我能说清三种后端：RunnerSidecar（容器）、Bwrap（Linux 命名空间）、RestrictedSubprocess（受限子进程）。
- [ ] 我知道 `BwrapBackend` 用 `--unshare-all` 做 OS 级隔离（`deeptutor/services/sandbox/backends.py:125`）。
- [ ] 我明白 `argv` 非空时后端"不经 shell 直接执行"，可防命令注入（`deeptutor/services/sandbox/spec.py:60`）。
- [ ] 我知道配额 `UserExecQuota`（`deeptutor/services/sandbox/quota.py:27`）用并发信号量 + 60 秒速率窗防滥用。
- [ ] 我理解产物回收只取"可公开"文件，防敏感文件泄露（`deeptutor/services/sandbox/artifacts.py:33`）。
- [ ] 我知道普通用户只在 `SYSTEM` 级才获 shell 执行权限（`deeptutor/services/sandbox/spec.py:20`）。
- [ ] 我能复述一条执行请求要过的 6 道关卡。
