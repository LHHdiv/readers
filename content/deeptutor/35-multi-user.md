---
title: "第 35 章 · 多用户 multi_user 与隔离"
date: 2026-08-01
summary: "前面所有章节默认\"只有一个人在用\"。但 DeepTutor 也可以部署成\"多人在线\"的服务：老师建一个站点，几十个学生各自登录。这就带来一个硬问题——**怎么保证 A 同学看不到 B 同学的笔记、用不到 B 同学专属的模型、也碰不到 B 同学的密钥？**"
tags:
  - deeptutor
---
# 第 35 章 · 多用户 multi_user 与隔离

前面所有章节默认"只有一个人在用"。但 DeepTutor 也可以部署成"多人在线"的服务：老师建一个站点，几十个学生各自登录。这就带来一个硬问题——**怎么保证 A 同学看不到 B 同学的笔记、用不到 B 同学专属的模型、也碰不到 B 同学的密钥？**

这一章讲 DeepTutor 的 `multi_user` 模块：它如何识别"你是谁"、如何授权"你能用啥"、以及如何把每个人的资源（知识库、模型、Partner）彻底隔开。

> **说明 · 什么是"多租户隔离"（先直觉后原理）**
>
> 直觉：就像一栋公寓楼，每户人家有自己的门锁和房间，物业（系统）保证你进不了邻居家的门，也用不了邻居的水电套餐。
> 
> 原理：技术上"隔离"分两层。一是**身份（identity）**——确认"你是哪个账号"；二是**授权（grants）**——确认"这个账号被允许用哪些资源"。DeepTutor 用 `ContextVar`（请求级上下文变量）把"当前用户"挂在这次请求上，后续所有读写路径都按这个身份去解析目录和权限，从而做到"谁的请求，就落在谁的地盘"。

## 一、身份：你是谁

身份信息存在 `deeptutor/multi_user/identity.py`。核心是一份用户清单 `users.json`，路径在 `deeptutor/multi_user/identity.py:27`（`USERS_FILE = AUTH_DIR / "users.json"`）。每条记录含 `id`、`hash`（密码哈希，绝不是明文密码）、`role`（admin/user）、`created_at` 等（`deeptutor/multi_user/identity.py:41` 的 `_canonical_record`）。

几个值得记的点：

- 新用户 id 用 `u_<随机>` 生成（`deeptutor/multi_user/identity.py:33` 的 `new_user_id`），不是用用户名当主键，避免重名冲突。
- 注册/保存用户时用一个**写锁** `_USERS_WRITE_LOCK`（`deeptutor/multi_user/identity.py:24`），防止并发注册时两个请求都"没看到 admin"于是都把自己提成 admin（`deeptutor/multi_user/identity.py:172` 的 `save_user` 里有"空库时第一个人是 admin"的逻辑，必须串行）。
- 鉴权没开时（本地单机），当前用户会退化成"本地管理员"（`deeptutor/multi_user/context.py:23` 的 `get_current_user` 拿不到就返回 `local_admin_user`，定义在 `deeptutor/multi_user/paths.py:93`）。

```text
一次请求进来
        │
        ▼
 从 token 解析出用户（auth 中间件）
        │
        ▼
 set_current_user(CurrentUser)   ← 挂到 ContextVar
        │                          （deeptutor/multi_user/context.py:14）
        ▼
 后续所有代码调 get_current_user()
 都知道"这次是谁在操作"
        │
        ▼
 路径解析 / 权限判断 都按这个身份来
```

## 二、请求级上下文：ContextVar

`deeptutor/multi_user/context.py` 是整个隔离的"枢纽"。它用 Python 的 `ContextVar`（`deeptutor/multi_user/context.py:11`）保存"当前用户"。`ContextVar` 的特点是：**每个异步任务各有一份副本**，所以即使服务器同时处理上百个用户的请求，互相也不会串台。

- `set_current_user` / `reset_current_user`（`deeptutor/multi_user/context.py:14` / `:18`）：请求开始时设、结束时清。
- `get_current_user`（`deeptutor/multi_user/context.py:22`）：任何地方都能拿到"现在是谁"。拿不到就当本地管理员——这正是"关掉鉴权就是单机模式"的实现基础。

> **提示 · 为什么用 ContextVar 而不是全局变量**
>
> 普通全局变量在多线程/协程下会被所有人共享，A 请求设了"我是 A"，B 请求一读就变成 A 了——串台。ContextVar 按"执行上下文"隔离，每个请求/任务独立，天然适合"一次请求一个用户"的 Web 场景。这是隔离能成立的技术地基。

## 三、授权：你能用啥

身份解决"你是谁"，授权解决"你能用啥"。授权信息存在每个用户的 **grant 文件** `deeptutor/multi_user/grants.py:13`（`GRANTS_DIR / "{user_id}.json"`）。

`empty_grant`（`deeptutor/multi_user/grants.py:16`）定义了授权文件的默认形状，关键字段：

- `models.llm`：该用户能用哪些 LLM 配置（模型）。
- `knowledge_bases`：能用哪些知识库。
- `skills`：能用哪些技能。
- `partners`：能看到/咨询哪些 Partner。
- `mcp_tools` / `cli_apps`：**默认 deny**（None 表示"没授权就是不能用"），因为这两类能代理宿主机能力，必须管理员显式开（`deeptutor/multi_user/grants.py:40` 附近注释）。
- `exec_enabled`：是否允许执行代码，三态（None 跟随部署策略 / False 拒绝 / True 仅在能真正隔离时生效）。

读取用 `load_grant`（`deeptutor/multi_user/grants.py:90`），它文件不存在就返回空授权。`validate_grant`（`deeptutor/multi_user/grants.py:115`）会拒绝授权里出现 `api_key`/`secret`/`token`/`path` 这类字段——因为授权只该存"逻辑 id"，真实密钥绝不能进授权文件。

后端还提供一个 `router.py`（`deeptutor/multi_user/router.py:23`），挂一堆**管理员专用**的 API：给用户发授权、管理用户、看模型/知识库目录等。这些接口都带 `require_admin` 依赖（在 `deeptutor/api/main.py:361` 的 `_admin` 里统一施加），普通用户调不了。

## 四、路径隔离：你的地盘在哪

隔离的"物理实现"在 `deeptutor/multi_user/paths.py`。核心函数 `scope_for_user`（`deeptutor/multi_user/paths.py:102`）：

- 管理员 → 返回 `admin` 作用域，根目录是整个部署的工作区（`admin_scope`）。
- 普通用户 → 返回 `user` 作用域，根目录是 `USERS_ROOT / {user_id}`（`deeptutor/multi_user/paths.py:106`）。

之后所有"当前路径服务"都由 `get_current_path_service`（`deeptutor/multi_user/paths.py:153`）按当前用户的作用域来给。于是同一行 `get_knowledge_bases_root()` 代码，A 用户落在 `data/users/A/knowledge_bases/`，B 用户落在 `data/users/B/...`——**代码不用改，目录自己分开了**。

密钥更敏感，单独处理：`owner_secrets_dir`（`deeptutor/multi_user/paths.py:211`）把每个用户的密钥存在 `system/private/mcp/{owner}/`，这个目录连沙箱都不挂载（呼应第 31 章），并且每次都重新 `chmod 700` 确保只有本人可读（`deeptutor/multi_user/paths.py:227`）。

```text
用户 A 请求"列出我的知识库"
        │
        ▼
 get_current_user() → A
        │
        ▼
 scope_for_user(A) → root = data/users/A
        │
        ▼
 get_current_path_service() → 指向 A 的目录
        │
        ▼
 读 data/users/A/knowledge_bases/  ← 绝不会碰到 B 的
```

## 五、资源隔离三兄弟

光有身份、授权、路径还不够，得在**每一类资源**的访问点都做检查。模块里专门有三个 `xxx_access.py` 把关：

**1）知识库隔离** `knowledge_access.py`
`resolve_kb`（`deeptutor/multi_user/knowledge_access.py:69`）是知识库的"守门员"。它识别两种前缀：`admin:kb:`（管理员建的）和 `user:kb:`（用户自建）。规则很严：

- 管理员：能看能写所有。
- 普通用户访问 `admin:kb:xxx`：必须在自己的授权 `knowledge_bases` 里、且**只能读不能写**（`deeptutor/multi_user/knowledge_access.py:88` 起，写会直接 403）。
- 普通用户访问自己的 `user:kb:`：正常读写。

`list_visible_knowledge_bases`（`deeptutor/multi_user/knowledge_access.py:171`）返回"当前用户看得到的库"，把管理员库里被授权给他的也带出来、`read_only` 标好。凡是走 RAG 查询还会记一笔审计（`deeptutor/multi_user/knowledge_access.py:223` 的 `resolve_for_rag` 调 `log_usage`）。

**2）模型隔离** `model_access.py`
`redacted_model_access`（`deeptutor/multi_user/model_access.py:59`）是"用户能用哪些模型"的**唯一裁决点**。它合并两个来源：授权里分配给他的 `admin` 模型、以及他自己用 OAuth 登录绑定的 `personal` 模型（`deeptutor/multi_user/model_access.py:96`）。它还专门过滤掉 `owner_bound`（绑定到某个人身份）的配置——这种配置不能通过授权借给别人（`deeptutor/multi_user/model_access.py:69` / `:49` 的 `is_owner_bound`）。用户真正选模型时，`apply_allowed_llm_selection`（`deeptutor/multi_user/model_access.py:145`）会再校验一次"你选的这俩确实在你被允许的范围内"，否则抛 `PermissionError`。

**3）Partner 隔离** `partner_access.py`
Partner 是管理员管的全局资源，普通用户不能建，但管理员可以**分配**某些 Partner 给某些用户。`assigned_partner_ids`（`deeptutor/multi_user/partner_access.py:26`）拿出"分配给我的 Partner 列表"，`assert_partner_allowed`（`deeptutor/multi_user/partner_access.py:37`）在用户想用某个 Partner 时拦一道：不在名单里就 403。`visible_partner_cards`（`deeptutor/multi_user/partner_access.py:71`）只返回"脸面信息"（名字、描述、头像），**绝不**返回通道配置/模型选择/工具配置（`_CARD_FIELDS` 在 `deeptutor/multi_user/partner_access.py:53`）——你只配和 Partner 聊天，不该看到它的"接线图"。

> **注意 · 三处检查必须一致**
>
> 模型这块有个坑：前端选项列表、能力门禁、选择校验，三处都得基于同一个 `redacted_model_access`，否则会出现"界面显示能用、实际一选就报错"或反过来"实际能用、界面却不显示"。作者特意把三处都指向 `redacted_model_access`（`model_access.py:59` 注释），保证它们永远说同一套话。做多用户时，"真相只在一处"是铁律。

## 六、审计：谁动过什么

最后，`audit.py` 提供审计日志。`log_usage`（`deeptutor/multi_user/audit.py:29`）记录普通用户对管理员资源的访问（RAG 查了哪个知识库等），**管理员自己访问自己的不记**（避免日志被淹没，见 `deeptutor/multi_user/audit.py:42`）。`log_admin_action`（`deeptutor/multi_user/audit.py:57`）记录管理员的写操作（改授权、增删用户），自动带上操作者和受影响用户。日志是追加写的 JSONL（`deeptutor/multi_user/audit.py:16` 的 `_audit_file`），且"审计失败绝不能影响主请求"（`deeptutor/multi_user/audit.py:24` 异常直接吞掉）。

```text
资源访问点 (resolve_kb / redacted_model_access / assert_partner_allowed)
        │  判断可不可以
        ├─ 允许  →  干正事 + 顺手 log_usage (审计)
        └─ 拒绝  →  抛 403
                │
                ▼
         管理员改授权 / 用户
                │
                ▼
         log_admin_action (记操作者+目标)
```

## 七、管理员 API：怎么发授权

授权不是用户在界面上随便填的，而是**管理员操作**。后端 `router.py` 提供一组 admin 接口：

- `GET /users`（`deeptutor/multi_user/router.py:226`）：列出所有用户。
- `GET /users/{id}/grants`（`deeptutor/multi_user/router.py:135`）：看某用户的授权。
- `PUT /users/{id}/grants`（`deeptutor/multi_user/router.py:141`）：改某用户的授权——这就是"给这个学生开放某知识库/某模型/某 Partner"的动作。
- `GET /admin/resources`（`deeptutor/multi_user/router.py:118`）：列出管理员可分配的模型/知识库清单，供授权界面下拉选择。
- `POST /admin/skills/install`（`deeptutor/multi_user/router.py:170`）：装一个技能（同样 admin 专属）。

这些接口在 `main.py:363` 挂到 `/api/v1/multi-user` 且带 `_auth` 依赖，但 `router.py` 内部函数还进一步要求 `require_admin`（见 `router.py:11` 的 import）——双重保险，普通用户连"被拒"的机会都没有，直接 403。

## 八、还有两类资源隔离：技能与工具

知识库、模型、Partner 之外，还有两个 `xxx_access.py` 把关：

- **技能隔离** `skill_access.py`：`assigned_skill_ids`（`deeptutor/multi_user/skill_access.py:14`）取出分配给用户的技能；`assert_skill_allowed`（`deeptutor/multi_user/skill_access.py:64`）在用户想用某技能时拦一道。和 Partner 一样，用户只能"用"管理员分配给他的技能，看不到接线细节。
- **工具隔离** `tool_access.py`：这一层最细。`allowed_optional_tools`（`deeptutor/multi_user/tool_access.py:44`）管"可选内置工具"白名单；`allowed_mcp_tools`（`tool_access.py:55`）和 `allowed_cli_apps`（`tool_access.py:72`）管 MCP/CLI 应用——前面说过这两类默认 deny；`exec_override`（`tool_access.py:89`）读出 `exec_enabled` 三态。当"调用者自带白名单"和"用户被授权的白名单"都要考虑时，用 `combine_whitelists`（`tool_access.py:98`）合并——这出现在"子智能体/工具内部再调工具"的场景。

## 九、个人模型：owner_bound 与 personal_models

前面提到模型隔离里有 `owner_bound` 概念（`model_access.py:49`）。这类模型是某人用自己 OAuth 登录绑定的（比如个人的 Codex 额度），**绝不该通过授权借给张三李四**。

`personal_models.py` 管"用户自己登录绑定的模型"：`personal_llm_rows`（`deeptutor/multi_user/personal_models.py:76`）取出当前用户个人的模型行，`merge_personal_llm_profiles`（`personal_models.py:105`）把它并回模型目录。注意 `model_access.py:96` 有个铁律：**只把 personal 模型并给"调用者自己"**——管理员去查别人授权时，绝不会把那个人私人的 OAuth 模型暴露出来。这条边界保护了用户的个人账号隐私。

## 十、Partners 是"合成用户"

隔离里有个微妙角色：Partner 也是"用户"（它有 `user_id`），但它不是真人，没有账号。于是 `paths.py` 里 `_resolve_owner`（`deeptutor/multi_user/paths.py:164`）专门判断：如果当前用户是 Partner（合成 id），它的"主人"就是管理员，所有按 owner 寻址的资产（尤其是 OAuth 凭据）都解析到 admin 树（`paths.py:184`），而按"工作区"寻址的资源（rag、技能、笔记、记忆）才落在 Partner 自己的工作区（`paths.py:188`）。一句话：**Partner 的"身份"归管理员，但它的"笔记本"归它自己**。

## 十一、隔离失败要"安全倒向"

安全系统最怕"判断不了就放行"。DeepTutor 在几处都选择"拿不准就拒绝"：

- 授权文件里出现 `secret`/`token`/`path` 等字段直接 `validate_grant` 报错（`grants.py:115`）——授权只允许存逻辑 id，真密钥绝不进授权。
- MCP 工具、`cli_apps` 在授权里是 `None`（未授权）时，按"拒绝"处理而非"全放行"（`grants.py:40` 附近注释）。
- 审计写入失败直接吞掉异常（`audit.py:24`），保证"记日志"这件事永远不会把正常请求搞崩——日志是辅助，不能反客为主。

```text
用户请求访问资源 X
        │
        ▼
 resolve/find 类检查（kb / model / partner / skill / tool）
        │
        ├─ 在授权名单内  →  放行；若是访问管理员资源则记 log_usage
        └─ 不在 / 未授权  →  抛 403
                │
                ▼
         管理员改授权（router.py:141）
         才能把 X 加进该用户授权
```

## 十二、从身份到落盘的完整链路

把全章串起来，一次"访问自己知识库"的请求走过的隔离链路是：

```text
请求携带 token
   │
   ▼
 auth 中间件 → set_current_user (ContextVar)
   │
   ▼
 业务接口 get_current_user() 拿到身份
   │
   ▼
 scope_for_user() 决定根目录 data/users/{id}
   │
   ▼
 get_current_path_service() 指向该用户目录
   │
   ▼
 knowledge_access.resolve_kb() 检查授权 + 只读/读写
   │
   ▼
 真正读 data/users/{id}/knowledge_bases/<name>/
   │
   ▼
 若访问的是被指派的管理员库 → audit.log_usage 记一笔
```

记住这条链路：身份（你是谁）→ 作用域（你落哪）→ 授权（你能碰啥）→ 审计（你碰了啥）。四步走完，多用户才真正"隔而不漏"。

## 十三、一个授权文件长啥样

`grants.py` 里的 `empty_grant`（`deeptutor/multi_user/grants.py:16`）定义了授权文件的形状。一个学生被"分配了物理知识库、两个模型、一个 Partner"的真实授权大概长这样（示意）：

```json
{
  "version": 2,
  "user_id": "u_a1b2c3",
  "models": { "llm": [{ "profile_id": "openai", "model_ids": ["gpt-4o"] }] },
  "knowledge_bases": [{ "name": "physics" }],
  "skills": [],
  "partners": [{ "partner_id": "p_tutor_01" }],
  "enabled_tools": null,
  "mcp_tools": null,
  "cli_apps": null,
  "exec_enabled": null
}
```

注意几个 `null`：`enabled_tools` / `mcp_tools` / `cli_apps` / `exec_enabled` 都是 `None` 表示"走默认/拒绝"。特别是 `mcp_tools: null` 在普通用户下是**拒绝所有 MCP 工具**，必须管理员显式写名字才放开（`grants.py:40` 附近注释）——因为 MCP 能代理宿主机能力。

## 十四、身份迁移：从旧结构到新结构

`identity.py` 里藏着兼容老版本的迁移：`_migrate_legacy_users`（`deeptutor/multi_user/identity.py:88`）会把旧路径 `data/user/auth_users.json` 的用户迁到新的 `system/auth/users.json`（`identity.py:29`）。`load_users`（`identity.py:124`）在每次加载时先尝试迁移、再规范化记录。还要注意"第一个注册用户自动是 admin"的逻辑（`identity.py:178` 的 `effective_role`）——所以 `save_user` 用写锁串行化，防止并发注册时两个请求都以为"库是空的、我是 admin"（`identity.py:24` 的 `_USERS_WRITE_LOCK`）。

## 十五、头像与安全

用户头像是另一处"别信文件名"的细节：`AVATAR_EXTENSIONS`（`deeptutor/multi_user/identity.py:251`）只接受 `png/jpg/webp`；`save_avatar_file`（`identity.py:268`）用临时文件 + 原子替换（`tmp.replace(target)`），并且重传会清掉旧的其它扩展名文件，避免残留。密钥目录 `owner_secrets_dir`（`deeptutor/multi_user/paths.py:211`）每次都 `chmod 700`，防止变成"谁都能读"——因为那里可能放着用户的 OAuth 刷新令牌（呼应第 31 章凭据隔离）。

## 十六、隔离保证一览表

把全章的隔离点汇总成一张表，方便你对照检查：

| 资源 | 隔离机制 | 越权时行为 |
| --- | --- | --- |
| 用户目录 | `scope_for_user` 按 id 分根（`paths.py:102`） | 根本读不到别人目录 |
| 知识库 | `resolve_kb` 校验授权+只读（`knowledge_access.py:69`） | 403 / 404 |
| 模型 | `redacted_model_access` 唯一裁决（`model_access.py:59`） | 选择被拒 `PermissionError` |
| Partner | `assert_partner_allowed`（`partner_access.py:37`） | 403 |
| 技能 | `assert_skill_allowed`（`skill_access.py:64`） | 403 |
| 工具/MCP/CLI | `tool_access.py` 白名单（`tool_access.py:44` 起） | 默认拒绝 |
| 密钥 | `owner_secrets_dir` 700 + 沙箱不挂载 | 沙箱读不到 |
| 审计 | `log_usage` / `log_admin_action`（`audit.py:29`/`:57`） | 操作留痕 |

> **注意 · 多用户最容易踩的坑**
>
> "管理员能不能看到用户的私有数据？"——设计上管理员用 `admin` 作用域，普通用户用 `data/users/{id}` 作用域，两者目录不同。但**审计日志里管理员自己的操作不记录**（`audit.py:42`），且管理员通过授权把资源"分配"给用户时，用户拿到的管理员知识库是**只读**的（`knowledge_access.py:92`）。记住：隔离不是"完全看不见"，而是"按规则看得见、且可审计"。

## 十七、"失败安全"再强调一遍

多用户系统最危险的不是"拦得太严"，而是"判断不了就放行"。DeepTutor 在几处都刻意"拿不准就拒绝"：

- 授权文件里出现 `secret`/`token`/`path` 字段 → `validate_grant` 直接报错（`grants.py:115`），因为授权只允许存逻辑 id。
- `mcp_tools` / `cli_apps` 在授权里是 `None` 时按"拒绝"处理（`grants.py:40`），绝不默认全放行。
- `scope_for_user` 拿不准用户身份时，退化成"本地管理员"只在**鉴权关闭的本地模式**发生；一旦开了鉴权，每个请求都必须有明确身份，否则 `get_current_user` 抛错而非假装是 admin。
- 审计写入失败直接吞异常（`audit.py:24`）——日志是辅助，绝不能反客为主让正常请求崩掉。

这套"默认拒绝 + 失败不扩散"的哲学，是安全模块和"方便模块"最大的区别。

## 十八、一图总结多用户隔离

```text
           一次请求进入 DeepTutor
                │
                ▼
   ① 身份 identity.py
      token → CurrentUser (ContextVar, context.py:11)
                │
                ▼
   ② 作用域 paths.py
      scope_for_user → data/users/{id} (paths.py:102)
                │
                ▼
   ③ 授权 grants.py
      load_grant → 能用哪些模型/知识库/Partner/工具 (grants.py:90)
                │
                ▼
   ④ 资源访问点 (各 xxx_access.py) 逐项校验
      kb / model / partner / skill / tool
                │
                ▼
   ⑤ 审计 audit.py 记一笔 (谁碰了啥)
                │
                ▼
      真正落到该用户自己的目录 / 资源
```

记住这条五步链：**身份 → 作用域 → 授权 → 校验 → 审计**。少任何一步，"多用户"都会从"隔离"退化成"串台"。

> **说明 · 学完这章你该建立的直觉**
>
> 看到一个 `get_current_user()` 调用，就知道"这里开始按用户分地盘"；看到 `resolve_kb` / `redacted_model_access` / `assert_partner_allowed`，就知道"这里在拦越权"；看到 `log_usage`，就知道"这里在留痕"。这套直觉，是读懂任何多用户系统（不止 DeepTutor）的通用钥匙。

## 十九、常见误区

- 误区：多用户就是"加个登录"。正解：登录只是身份（`identity.py`），还要作用域（`paths.py:102`）、授权（`grants.py`）、资源校验（`xxx_access.py`）、审计（`audit.py`）五步闭环。
- 误区：普通用户能用任意 MCP 工具。正解：`mcp_tools` 在授权里是 `None` 时**默认拒绝**（`grants.py:40`），须管理员显式开。
- 误区：管理员能看用户所有私数据。正解：管理员用 `admin` 作用域、用户用 `data/users/{id}` 作用域，目录天然分开；指派的管理员库对用户**只读**（`knowledge_access.py:92`）。
- 误区：授权文件能存密钥。正解：`validate_grant` 拒绝 `secret`/`token`/`path` 字段（`grants.py:115`），授权只存逻辑 id。
- 误区：本人 OAuth 模型能借给别人。正解：`owner_bound` 配置（`model_access.py:49`）绝不通过授权出借，`personal_models.py` 只并给本人。

## 黑话小词典

| 黑话 | 人话解释 |
| --- | --- |
| 多租户 multi-tenant | 一个系统同时服务多个互相隔离的账号 |
| 身份 identity | 确认"你是哪个账号"（用户名/角色/id） |
| 授权 grant | 确认"这个账号被允许用哪些资源" |
| 作用域 scope | 当前用户落地的目录根（admin 还是 data/users/{id}） |
| ContextVar | 按"每个请求/任务"隔离的变量，互不串台 |
| 隔离 isolation | 让 A 用户看不到、碰不到 B 用户的数据 |
| 审计 audit | 把"谁访问/改了什么"记进日志留痕 |
| owner_bound | 绑定到某个人 OAuth 身份、不能借给别人的模型 |

## 自查清单

- [ ] 我理解"多租户隔离"= 身份 + 授权 + 路径三层（`multi_user/`）
- [ ] 我知道用户清单在 `identity.py:27` 的 `users.json`，密码存哈希不存明文
- [ ] 我明白 `ContextVar` 为什么比全局变量适合"一次请求一个用户"（`context.py:11`）
- [ ] 我能说出 grant 文件存啥：`grants.py:16` 的 `empty_grant` 字段
- [ ] 我知道普通用户的目录根在 `data/users/{id}`，由 `scope_for_user` 决定（`paths.py:102`）
- [ ] 我讲得出知识库"管理员库分配给用户只能读不能写"（`knowledge_access.py:88`）
- [ ] 我理解模型隔离的唯一裁决点是 `redacted_model_access`（`model_access.py:59`）
- [ ] 我知道 Partner 对用户只暴露"脸面"、屏蔽配置（`partner_access.py:53`），且审计日志失败不影响主请求（`audit.py:24`）
