---
title: "第 22 章 · 认证体系 auth（API key / OAuth / 解析优先级）"
date: 2026-07-01
summary: "当你让 Pi 去调用某个大模型时，它必须证明\"我是合法的用户\"。这件事在代码里就是 **auth（authentication，认证）**。本章讲清楚 Pi 的认证系统分三层：抽象层定义\"凭证长什么样\"、解析层决定\"到底用哪一份凭证\"、交互层负责\"没有凭证时怎么让用户登录\"。"
tags:
  - pi
---
# 第 22 章 · 认证体系 auth（API key / OAuth / 解析优先级）

> 当你让 Pi 去调用某个大模型时，它必须证明"我是合法的用户"。这件事在代码里就是 **auth（authentication，认证）**。本章讲清楚 Pi 的认证系统分三层：抽象层定义"凭证长什么样"、解析层决定"到底用哪一份凭证"、交互层负责"没有凭证时怎么让用户登录"。

## 1. 先建立直觉：为什么认证这么麻烦

你可能会想：不就是传一个 API key 吗？为什么 Pi 要写一整个 `packages/ai/src/auth/` 目录，还分 api-key、OAuth、设备码、PKCE……这么多种？

因为现实世界很乱：

- 有的厂商（比如很多 OpenAI 兼容服务）只要一个 `API key` 字符串。
- 有的厂商（比如 Anthropic 的 Claude Pro/Max、OpenAI Codex、GitHub Copilot）不用 key，而是走 **OAuth 登录**，拿到会过期的 `access token`，还要定时刷新。
- 凭证可以来自三个地方：你代码里临时塞的、**持久化存储里存的**、或者**环境变量**里配的。
- 同一个用户可能既存了 OAuth 凭证，又设了环境变量，到底听谁的？

Pi 把这些差异都收口到一套类型与函数里，让上层调用方（比如 `Models.getAuth()`）永远只拿到一个统一的 `AuthResult`。

> **提示 · 黑话速查**
>
> - **API key**：一串静态密钥，长期有效，泄露即危险。
> - **OAuth**：授权框架，用户登录后拿到短期 `access token` + 长期 `refresh token`，过期用 refresh 换新。
> - **PKCE**：OAuth 的一种安全增强，不需要客户端密钥也能防中间人。
> - **RFC 8628 设备码**：给没有浏览器的设备（或远程 SSH 会话）用的 OAuth 流程，用户在另一台设备上输码。

## 2. 抽象层：凭证与认证方法的类型

抽象层全部定义在 `packages/ai/src/auth/types.ts`。它不关心具体怎么登录，只规定"形状"。

### 2.1 一份凭证长什么样（`Credential`）

Pi 的存储里，每个 provider 最多存一份凭证，用类型标签区分：

```ts
// packages/ai/src/auth/types.ts:37
export type Credential = ApiKeyCredential | OAuthCredential;
```

- **ApiKeyCredential**（`types.ts:17-21`）：`{ type: "api_key", key?, env? }`。`env` 放厂商专属配置，比如 Cloudflare 的账户 id。
- **OAuthCredential**（`types.ts:32-34`）：`{ type: "oauth", refresh, access, expires, ... }`。`expires` 是毫秒时间戳，`access` 是短期令牌。

### 2.2 凭证的"保险柜"（`CredentialStore`）

```ts
// packages/ai/src/auth/types.ts:65-94
export interface CredentialStore {
  read(providerId, options?): Promise<Credential | undefined>;
  list(options?): Promise<readonly CredentialInfo[]>;
  modify(providerId, fn, options?): Promise<Credential | undefined>;
  delete(providerId, options?): Promise<void>;
}
```

关键约束在注释里写得很清楚（`types.ts:78-90`）：**`modify` 是唯一的写入口，并且是串行的"读取-修改-写入"**。为什么这么设计？因为 OAuth 刷新时，两个并发请求不能各自去刷一遍同一个 token，否则会互相作废。`Models.getAuth()` 正是把 OAuth 刷新放进 `modify` 的锁里，保证"全局只刷新一次"（见第 4 节）。

### 2.3 两种认证方法：`ApiKeyAuth` 与 `OAuthAuth`

这是"方法"而非"凭证"——它描述"这个 provider 支持怎么认证"。

```ts
// packages/ai/src/auth/types.ts:170-199
export interface ApiKeyAuth {
  name: string;
  login?(interaction): Promise<ApiKeyCredential>;   // 可选的手动登录
  check?(): Promise<AuthCheck | undefined>;          // 可选的可用性检查
  resolve(input): Promise<AuthResult | undefined>;   // 真正去取凭证
}

// packages/ai/src/auth/types.ts:206-230
export interface OAuthAuth {
  name: string;
  isSubscription?: boolean;
  login(interaction): Promise<OAuthCredential>;
  refresh(credential, signal): Promise<OAuthCredential>;  // 用 refresh token 换新
  toAuth(credential): Promise<ModelAuth>;                  // 凭据 → 请求头
}
```

> **说明 · 为什么 OAuth 把 `refresh` 和 `toAuth` 拆开？**
>
> 因为刷新和"从凭证推出请求头"是两个时机不同的动作。`Models` 负责"加锁后调用 `refresh`"，刷新完拿到新凭证后才调 `toAuth` 推出真正要放进 HTTP 请求里的头。这样锁的范围最小，且 `toAuth` 是纯函数、可重复调用（`types.ts:201-205` 注释）。

## 3. 解析层：三级优先级

核心函数是 `resolveProviderAuth`，定义在 `packages/ai/src/auth/resolve.ts:50-61`，它包裹了一个带 `AbortSignal` 的异步实现 `resolveProviderAuthWithSignal`（`resolve.ts:63-110`）。

优先级**从高到低**是：

1. **显式 override**（代码里硬塞的 apiKey）
2. **存储凭证**（持久化存储里读出来的，OAuth 会自动刷新）
3. **环境变量兜底**（最常被忽略的 ambient 配置）

### 3.1 第一级：override

```ts
// packages/ai/src/auth/resolve.ts:73-85
if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
  return resolveApiKey(
    requestAuthContext,
    provider.auth.apiKey,
    provider.id,
    { type: "api_key", key: overrides.apiKey, env: overrides.env },
    signal,
  );
}
```

如果你在调用时直接传了 `apiKey`（比如测试、临时切换），它就直接胜出，连存储都不看。

### 3.2 第二级：存储凭证 + OAuth 刷新

```ts
// packages/ai/src/auth/resolve.ts:87-104
const stored = await readCredential(credentials, provider.id, signal);
if (stored) {
  if (stored.type === "oauth" && provider.auth.oauth) {
    return resolveStoredOAuth(credentials, provider.id, provider.auth.oauth, stored, signal, overrides?.minOAuthValidityMs);
  }
  if (stored.type === "api_key" && provider.auth.apiKey) {
    const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
    return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
  }
  return undefined;   // 类型不匹配（如存了 OAuth 但厂商只支持 key）→ 失败，不退化到 env
}
```

注意一个**重要安全规则**（注释见 `resolve.ts:44-49`）：一旦从存储读到了凭证，就**不会再回退到环境变量**。比如你存了某个 key，但那个 key 已经失效，Pi 不会"悄悄"改用环境变量里的另一个 key 重试——它直接报错。这避免了"看起来配了却用了错误身份"的隐患。

如果存储里是 OAuth 凭证，会进入 `resolveStoredOAuth`（`resolve.ts:127-179`），里面是一套"双检锁"：剩余有效期不足 5 分钟（`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`，`resolve.ts:119`）时才在锁内刷新一次，写回存储。

### 3.3 第三级：环境变量兜底

```ts
// packages/ai/src/auth/resolve.ts:106-109
// Ambient (env vars, AWS profiles, ADC files).
return provider.auth.apiKey
  ? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
  : undefined;
```

只有当存储里**什么都没有**时，才去问 ambient 源（env 变量、AWS profile、`~/.aws/credentials` 这种 ADC 文件）。`resolveApiKey` 里最终会调用各厂商自己的 `resolve`，比如 `envApiKeyAuth`（`helpers.ts:9-31`）就是标准的"先读存储 key，再依次试 env 变量"实现。

### 3.4 认证决策树

```text
resolveProviderAuth(provider, store, ctx, overrides)
  │
  ├─ overrides.apiKey 存在?
  │     └─ 是 → 直接返回（第一级，override 胜出）★ 不看存储
  │
  ├─ store.read(provider.id) 读到凭证?
  │     ├─ 是 OAuth 且 provider 支持 oauth
  │     │     └─ resolveStoredOAuth: 剩余<5min? → 加锁刷新一次并写回 → toAuth → 返回
  │     ├─ 是 api_key 且 provider 支持 apiKey
  │     │     └─ resolveApiKey(用存储的 key) → 返回
  │     └─ 类型不匹配 → return undefined（★ 不再退化到 env）
  │
  └─ 存储为空 → 走 ambient
        └─ provider.auth.apiKey 存在?
              ├─ 是 → resolveApiKey(从 env/ADC 取) → 返回
              └─ 否 → return undefined（此 provider 未配置）
```

## 4. 交互层：两条登录路线

当没有凭证、需要用户登录时，OAuth 有两条路线，都由具体的 `*OAuth` 实现选择：

### 4.1 路线 A：PKCE 本地回环（localhost callback）

适合**本机有浏览器**的场景。流程是：

1. 生成本地回调服务器（监听 `127.0.0.1:PORT`）。
2. 用 PKCE 生成 `verifier` 和 `challenge`（`pkce.ts:21-34`，基于 Web Crypto 的 SHA-256）。
3. 打开浏览器让用户授权，`auth_url` 事件通知前端（`types.ts:139-140` 的 `AuthEvent`）。
4. 授权后浏览器跳回本地回调端口，服务器拿到 `code`，换 token。

Anthropic 就是经典例子（`anthropic.ts`）：

```ts
// packages/ai/src/auth/oauth/anthropic.ts:32
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// packages/ai/src/auth/oauth/anthropic.ts:35
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
// packages/ai/src/auth/oauth/anthropic.ts:157
server.listen(CALLBACK_PORT, CALLBACK_HOST, () => { ... });
// packages/ai/src/auth/oauth/anthropic.ts:235
const { verifier, challenge } = await generatePKCE();
```

GitHub Copilot 与 OpenAI Codex 也支持 PKCE 回环（`openai-codex.ts:30` 的 `REDIRECT_URI = "http://localhost:1455/auth/callback"`，`:370` 监听 1455 端口）。

### 4.2 路线 B：RFC 8628 设备码轮询

适合**没有浏览器**的环境，比如远程 SSH 机器、WSL、容器。流程是：

1. 向授权服务器要一个 `device_code` 和 `user_code`。
2. 把 `user_code` + 验证网址告诉用户（`types.ts:140-146` 的 `device_code` 事件）。
3. 用户在**另一台设备**的浏览器里输码授权。
4. 本机按 `interval` 周期轮询授权服务器，直到 `complete`。

轮询逻辑在 `device-code.ts:46-98` 的 `pollOAuthDeviceCodeFlow`。它严格遵守 RFC 8628：

```ts
// packages/ai/src/auth/oauth/device-code.ts:6-9
// RFC 8628 section 3.2: 没给 interval 就用 5 秒
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: slow_down 时轮询间隔 +5 秒
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;
```

GitHub Copilot（`github-copilot.ts:209` 调 `pollOAuthDeviceCodeFlow`）、OpenAI Codex（`openai-codex.ts:236`）都走设备码。Codex 甚至两种都提供，由用户选（`openai-codex.ts:37` 的 `OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD`）。

> **注意 · 为什么两套机制而不是一套？**
>
> 因为运行 Pi 的环境不可控。你可能在 Mac 上本机跑（用 PKCE 回环最顺），也可能在远程服务器上（`ssh` 进去后根本没有本地浏览器，只能用设备码）。抽象层屏蔽了差异，上层只要调 `login(interaction)`，具体走哪条路由各厂商 OAuth 实现决定。

## 5. 一个具体的"标准 api-key 登录"示例

最常见的 `envApiKeyAuth`（`helpers.ts:9-31`）展示了"交互 + 解析"如何配合：

```ts
// packages/ai/src/auth/helpers.ts:9-31
export function envApiKeyAuth(name, envVars) {
  return {
    name,
    login: async (interaction) => {
      const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
      return { type: "api_key", key };
    },
    resolve: async ({ ctx, credential, signal }) => {
      if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
      for (const envVar of envVars) {
        const value = await ctx.env(envVar);
        if (value) return { auth: { apiKey: value }, source: envVar };
      }
      return undefined;
    },
  };
}
```

登录时 `login` 弹出一个"输入密钥"的提示；之后每次请求 `resolve` 时，优先用存储的 key，没有再去试环境变量。

## 6. 回到整体：auth 与上一章的衔接

第 21 章讲了 `EventStream` 的事件流；本章的 `AuthInteraction`（`types.ts:156-161`）里的 `notify(event)` 正是把 `auth_url`、`device_code` 这些 `AuthEvent` 推给 UI 层显示。也就是说：**认证不是阻塞的黑盒，而是一连串带事件的交互**——这正是 Pi 把"模型调用"和"用户交互"统一成事件流的设计哲学（也见第 25/26 章的 agent 事件总线）。

## 自查清单

- [ ] 我能说出 Pi 认证的三层（抽象 / 解析 / 交互）分别解决什么问题。
- [ ] 我能复述 `resolveProviderAuth` 的三级优先级，并解释"存了凭证为何不再回退 env"。
- [ ] 我知道 `CredentialStore.modify` 为什么必须串行。
- [ ] 我能区分 PKCE 回环与 RFC 8628 设备码各自的适用场景。
- [ ] 我能在源码里指出 `resolve.ts:73`、`resolve.ts:87`、`resolve.ts:106` 三处优先级分支。
- [ ] 我理解 `OAuthAuth` 把 `refresh` 与 `toAuth` 拆开的原因。
