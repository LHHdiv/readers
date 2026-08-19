---
title: "第 41 章 · 协议 protocol（CBOR / 分帧）与 client/server"
date: 2026-07-01
summary: "**黑话速查**"
tags:
  - pi
---
# 第 41 章 · 协议 protocol（CBOR / 分帧）与 client/server

> **黑话速查**
> - **线协议（Wire Protocol）**：两台程序通过网络或管道交换数据时，约定的"二进制字节长什么样"的规则。
> - **CBOR**：一种紧凑的二进制序列化格式（RFC 8949），比 JSON 更省空间、解析更快。
> - **分帧（Framing）**：把连续的比特流切成一个个完整消息的边界划分方法。
> - **客户端 / 服务器（Client / Server）**：主动发起连接的是 client（比如 IDE），被动等待连接、提供能力的是 server（比如 Pi 运行时）。
> - **RPC（远程过程调用）**：像调用本地函数一样去调用另一台机器上的功能；这里指 IDE 远程驱动 Pi 的会话。
> - **信封（Envelope）**：把真正的请求/响应包起来、附带 id 和元信息的"快递包装"。
> - **握手（Handshake）**：连接建立后双方先对一下协议版本，确认能聊天，再开始正式通信。

## 先建立直觉

第 40 章讲了 Pi 怎么在终端里画界面。但 Pi 不只能自己画——它还能被**别的程序**（IDE、编辑器插件）远程控制：让 Pi 新建一个会话、把用户的问题发过去、再把回答读回来。

这就引出两个问题：

1. 双方怎么把"新建会话""发送提示词"这种结构化命令，变成能在管道/套接字里传输的字节？
2. 连接怎么建立、怎么确保对方"听懂"了自己的协议版本？

Pi 的答案是一套**二进制线协议**：消息用 **CBOR** 编码（而不是 JSON 文本），用 **4 字节长度前缀** 来分帧，client 与 server 通过 **ClientHello / ServerHello 握手** 再进入请求-响应模式。代码分布在 `packages/protocol/`（协议定义）、`packages/client/`（客户端）、`packages/server/`（服务器）。

> **说明**
>
> **为什么不用 JSON + 换行分帧？** JSON 是文本，体积大、解析慢，而且"遇到换行就当一条消息"在二进制数据（比如图片、token 流）里会出错。CBOR 是二进制、更紧凑，配合"先说长度、再发内容"的分帧方式，既能高效传输，又能精确切分消息。

## 协议定义：schemas.ts 的严格契约

协议的第一步是**定义消息长什么样**。Pi 用 TypeBox 写出严格 schema，所有消息都必须符合，且 `additionalProperties: false`（多一个字段都不行），见 `packages/protocol/src/schemas.ts:7` 的 `StrictObject`。

协议版本号是 `PROTOCOL_VERSION = 1`（`packages/protocol/src/schemas.ts:3`）。一些核心类型：

- `ThinkingLevelSchema`：思考深度，`off / minimal / ... / max`（`schemas.ts:26`）
- `SessionPhaseSchema`：会话阶段（`schemas.ts:38`）
- 内容块：`TextContentSchema`、`ThinkingContentSchema`、`ToolCallContentSchema`（`schemas.ts:75`）
- `TranscriptItemSchema` / `TranscriptProgressSchema`：对话记录项与进度（`schemas.ts:193`、`:204`）
- `SessionSnapshotSchema` / `ServerSnapshotSchema`：会话与服务器的状态快照（`schemas.ts:241`、`:260`）
- `CommandSchema`：客户端能下发的命令联合类型——`list / create / attach / detach / prompt / steer / abort / set_model / set_thinking`（`schemas.ts:314`）

最关键的是**信封与消息联合**：

```ts
// packages/protocol/src/schemas.ts:391
RequestEnvelopeSchema   // 客户端请求：带 id + command
ClientMessageSchema     // = ClientHello | RequestEnvelope   (schemas.ts:397)
ServerEventSchema       // 服务器主动推送的事件 (schemas.ts:400)
ServerHelloSchema       // 握手回应 (schemas.ts:412)
ResponseEnvelopeSchema  // 服务器回应：ok: true/false (schemas.ts:422)
EventEnvelopeSchema     // 事件包装 (schemas.ts:436)
ServerMessageSchema     // = ServerHello | ResponseEnvelope | EventEnvelope (schemas.ts:440)
```

> **提示**
>
> **请求带 id、响应也带同一个 id**，这是 RPC 的关键。客户端可以同时发很多请求，之后收到响应时靠 id 把"回答"匹配回"当初那个问题"，不会乱。见 `packages/client/src/client.ts:189` 的 `#request`。

## 编码层：CBOR 与分帧 framing

### CBOR 编码

`packages/protocol/src/cbor/encoder.ts` 里 `CborWriter`（`encoder.ts:12`）把 JS 值写成二进制。它支持 null、boolean、number、string、Uint8Array、array、map，并且**禁止 undefined 和数组空洞**（循环也会检测），见 `encodeValue`（`encoder.ts:119`）。顶层入口是 `encodeCbor`（`encoder.ts:211`）。

为了安全，CBOR 解析有上限：`DEFAULT_MAX_CBOR_BYTE_LENGTH = 16MB`、最大容器长度 1,000,000、最大嵌套深度 64（见 `packages/protocol/src/cbor/options.ts`）。

### 4 字节大端长度前缀分帧

连续字节流怎么切成一条条消息？Pi 在每条消息**最前面**放 4 个字节，表示后面内容的长度（大端序，即高位在前）：

```ts
// packages/protocol/src/framing.ts:1
export const FRAME_HEADER_LENGTH = 4;

// packages/protocol/src/framing.ts:28
export function encodeFrame(payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
	const length = payload.length;
	frame[0] = length >>> 24; // 大端：最高字节
	frame[1] = length >>> 16;
	frame[2] = length >>> 8;
	frame[3] = length;        // 最低字节
	frame.set(payload, FRAME_HEADER_LENGTH);
	return frame;
}
```

接收方用 `FrameDecoder`（`packages/protocol/src/framing.ts:58`）**增量**解析：网络数据是一小段一小段到达的，`push(chunk)`（`framing.ts:73`）不断把字节喂进去，攒够一个完整帧（读前 4 字节知道长度，再等齐内容）就吐出一条消息；连接结束时 `end()`（`framing.ts:146`）做最后校验。单帧最大 `DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024`（`framing.ts:6`）。

### 校验与编解码 codec

`packages/protocol/src/codec.ts` 把"schema 校验"和"CBOR + 分帧"粘合起来：

- `parseClientMessage` / `parseServerMessage`：先 CBOR 解码，再用 TypeBox `Check` 严格校验（`codec.ts:41`、`:48`）。校验失败抛 `ProtocolValidationError`（`codec.ts:18`）。
- `encodeClientMessage` / `encodeServerMessage`：先校验结构，再 `encodeCbor`，最后 `encodeFrame` 打包（`codec.ts:79`、`:84`）。
- `ClientMessageDecoder` / `ServerMessageDecoder`：把底层 `FrameDecoder` 包装成"吐出已校验消息"的流（`codec.ts:129`、`:146`）。
- `isSupportedProtocolVersion`：检查对方版本是否兼容（`codec.ts:170`）。

## 客户端：连接、握手、路由

client 在 `packages/client/src/client.ts`。`PiClient` 类（`client.ts:51`）持有 `#connection`（连接）、`#state`（状态机）、`#pendingRequests`（待回应请求表）、`#requestSequence`（自增请求 id）。

### 建立连接与握手

`static connect`（`client.ts:96`）创建实例；底层 `Connection`（`packages/client/src/connection.ts:40`）的 `connect()`（`connection.ts:66`）打开传输层，并在 `#openTransport`（`connection.ts:119`）里**第一件事就发 ClientHello**：

```ts
// packages/client/src/connection.ts:119
this.#openTransport = async () => {
	// 连接建立后立即发送握手
	this.send(encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION }, ...));
};
```

服务器回 ServerHello 后，client 的 `#handleMessage`（`connection.ts:162`）把握手阶段状态推进到"已连接"，此后才允许正式通信。

### 发送请求与路由回应

业务方法（`listSessions` / `createSession` / `attachSession` / `acquireSession`，见 `client.ts:137`–`:151`）最终都走到私有 `#request`：

```ts
// packages/client/src/client.ts:189
#request(command: Command): Promise<CommandResult> {
	const id = ++this.#requestSequence;
	const frame = encodeClientMessage(
		{ type: "request", id, request: command },
		{ maxFrameLength: this.#maxFrameLength },
	);
	this.#connection.send(frame);
	// 把 Promise 存进 #pendingRequests，等响应按 id 回来再 resolve
}
```

收到服务器消息时，`#handleMessage`（`client.ts:294`）判断：如果是**事件**（EventEnvelope），就更新本地状态 `state.applyEvent`；如果是**响应**（ResponseEnvelope），就按 `id` 找到对应的 pending 请求，按 `ok` 解析结果或 reject 错误。

> **说明**
>
> **会话租约（SessionLease）**：client 不会永远占着一个会话。它用 `#reserveSessionLease` / `#releaseSessionLease`（`client.ts:381`、`:395`）在"需要操作时占用、用完即释放"，这样多个 client 可以共享服务器上的会话而不互相踩踏。

### 传输层：Unix 套接字

本地场景下，client 与 server 通过 Unix 域套接字通信。`packages/client/src/unix.ts` 的 `createUnixTransportFactory`（`unix.ts:13`）造出传输对象，`connectUnixSocket`（`unix.ts:26`）建立连接，`UnixByteTransport`（`unix.ts:68`）的 `send`（`unix.ts:82`）负责真正写字节，并对"待发送字节数"做上限保护，避免积压撑爆内存。注意 Unix 套接字路径有长度上限（linux 107、其他 103 字节），见 `unix.ts:5`。

## 服务器：接受连接、握手、分发

server 在 `packages/server/src/server.ts`。`PiServer`（`server.ts:39`）持有 listeners（监听器）、`LiveSessionManager`（会话管理器）、`ServerSnapshotPublisher`（快照发布器）。

### 启动与接受连接

`start`（`server.ts:85`）遍历每个 listener 调用 `listener.start`（`server.ts:93`）。当 client 连上来，`accept(connection)`（`server.ts:112`）为这条连接建一个 `ConnectionState`，设 `handshakeTimeout`（默认 5 秒，`server.ts:35`）和 `stage: "awaitingHello"`。

数据到达时 `receive`（`server.ts:170`）把字节喂给 `decoder.push`；`dispatchMessage`（`server.ts:185`）是一个**状态机**：`awaitingHello → handshaking → ready`。

### 握手与请求处理

`finishHandshake`（`server.ts:221`）用 `isSupportedProtocolVersion` 校验客户端版本，然后发 `ServerHello` 进入 ready。之后每条请求走 `handleRequest`（`server.ts:252`），它把命令交给 `sessions.executeCommand` 去真正执行。发送与出错分别由 `sendMessage`（`server.ts:293`）和 `failProtocol`（`server.ts:315`）处理。

### 服务器侧的 Unix 监听器

`packages/server/src/transports/unix/listener.ts` 的 `UnixListener`（`listener.ts:37`）在 `start`（`listener.ts:60`）里创建 `net.Server`，绑定一个临时私有套接字路径，再硬链接到用户配置的路径（避免路径长度超限，见 `getOwnedBindPath` `listener.ts:307`）。每来一个 socket，`acceptSocket`（`listener.ts:108`）包成 `UnixByteConnection`（`listener.ts:204`），其 `send`（`listener.ts:225`）对"待发送字节数"做上限保护，`close`（`listener.ts:243`）带优雅关闭超时。它还会探测"是不是已经有同路径的 socket 在跑"，防止重复启动。

## LiveSessionManager：会话的生命周期

真正的会话逻辑在 `packages/server/src/sessions.ts`。`LiveSession` 接口（`sessions.ts:7`）描述一个活会话：id、runtime（运行时）、connections（连接集合）、operationCount、是否 ready、终端、是否正在销毁。

`LiveSessionManager`（`sessions.ts:38`）是整个会话的"大管家"：

- `executeCommand`（`sessions.ts:47`）：按 `command.command` 分派到 `list / create / attach / detach / prompt / steer / abort / set_model / set_thinking` 各个处理函数。
- `acquire`（`sessions.ts:186`）/ `create`（`sessions.ts:209`）/ `attach`（`sessions.ts:300`）/ `requireAttached`（`sessions.ts:309`）：会话的获取、创建、附加、以及"必须先附加才能操作"的校验。
- `runOperation`（`sessions.ts:171`）：执行一次会话操作（比如跑一轮 prompt），期间计入 `operationCount`。
- `handleRuntimeEvent`（`sessions.ts:248`）：把 runtime 内部事件转成协议事件——进度事件变成 `session_progress`，其他变化广播 `session_snapshot`，让所有连接的 client 都能看到最新状态。
- `maybeDispose`（`sessions.ts:324`）：当没有连接、没有进行中的操作、且空闲足够久时，自动销毁会话，释放资源。

> **提示**
>
> **为什么需要 maybeDispose？** 智能体会话很"重"（有模型上下文、工具状态、文件句柄）。如果 client 关了连接就一直留着，服务器迟早被拖垮。Pi 用"没人用且空闲"的判定自动回收，既省资源又不误杀正在用的会话。

## 整体数据流（ASCII）

```
 IDE / 编辑器 (PiClient)
        │  1. connect()
        │  2. 发送 ClientHello {version:1}
        ▼
 ┌──────────────── 传输层（Unix 套接字） ────────────────┐
 │  ClientHello → framing(4字节长度) → CBOR 编码 → 字节流  │
 └───────────────────────────┬──────────────────────────┘
                              ▼
                       PiServer.accept()
                       dispatchMessage 状态机:
                       awaitingHello → handshaking → ready
                              │
                 3. 服务器回 ServerHello
                              │
        ┌─────────────────────┴─────────────────────┐
        │  4. 业务请求 RequestEnvelope{id, command}  │
        ▼                                            ▼
  codec 解码+校验                            LiveSessionManager
  (CBOR→JS, TypeBox Check)                  .executeCommand()
        │                                            │
        │                                   runtime 执行 / 事件
        ▼                                            ▼
  server.handleRequest                          broadcastSnapshot
        │                                            │
        ▼                                            ▼
  ResponseEnvelope{id, ok}  ◄──── 事件 EventEnvelope ◄──┘
        │
        ▼
 client.#handleMessage:
  按 id 匹配 pending → resolve / reject
  事件 → state.applyEvent
```

## 这意味着什么：IDE 远程驱动 Pi

把上面的零件拼起来，你会发现 Pi 的 TUI 只是"一种前端"。真正的能力都暴露在协议层：任何实现了 client 的程序（VS Code 插件、Neovim 插件、CI 脚本）都能通过这套 RPC 协议**远程新建会话、喂提示词、读回答、读进度、改模型、改思考深度**。第 40 章自研的 TUI，和第 41 章这套协议，是同一套渲染/会话内核的两种"门面"。

> **注意**
>
> **协议是硬契约**。因为 schema 用了 `additionalProperties: false`，客户端和服务器必须严格同版本对话；版本不符在握手阶段就会被 `isSupportedProtocolVersion` 拒绝（`server.ts:221`），而不是带着隐患运行。改协议字段要同步升级两端。

## 错误处理：协议出错怎么办

真实网络环境里，客户端可能发了非法消息、握手超时、或中途断线。Pi 在协议层就考虑了这些：

- **握手超时**：服务器在 `accept` 时设了 `handshakeTimeout`（默认 5 秒，`server.ts:35`）。如果客户端连上后迟迟不发 ClientHello，服务器直接放弃这条连接，避免资源被占着不干活。
- **校验失败**：解码阶段 `parseClientMessage` / `parseServerMessage`（`codec.ts:41`、`:48`）用 TypeBox 严格校验，结构不对立刻抛 `ProtocolValidationError`（`codec.ts:18`），不会带着脏数据往下走。
- **主动断连**：`failProtocol`（`server.ts:315`）在发现无法恢复的错误时，发送错误并关闭连接。对应的客户端侧，Unix 传输也有优雅关闭超时（`listener.ts:243`），确保最后的数据能发完、不丢失。
- **版本不兼容**：`isSupportedProtocolVersion`（`server.ts:221`）在握手时把关，版本对不上直接在 `finishHandshake` 阶段拒绝，而不是运行到一半才发现两端字段对不齐。

> **注意**
>
> **不要在协议层"默默容忍"错误**。Pi 的设计哲学是：错误越早暴露越好。握手超时、schema 校验失败都直接断连并报告，而不是把可疑消息吞掉继续跑——后者会制造极其难调试的"偶发诡异行为"。

## 一个命令的往返：以 prompt 为例

把前面所有零件用一条具体命令串起来，理解一次"让 Pi 干活"的完整过程：

```
 client.createSession()  →  RequestEnvelope{id:1, command:{command:"create"}}
        │
        ▼  (unix socket, 分帧 + CBOR)
 server.dispatchMessage → sessions.executeCommand("create")
        │  LiveSessionManager.create() 建立会话，返回 sessionId
        ▼
 ResponseEnvelope{id:1, ok:true, result:{sessionId}}
        │
        ▼  client 按 id:1 匹配 pending → resolve
 client.acquireSession(sessionId)  →  RequestEnvelope{id:2, command:"attach"}
        │  ...
 client.prompt("帮我修这个 bug")  →  RequestEnvelope{id:3, command:{command:"prompt", text}}
        │
        ▼  server 交给 runtime 真正推理
 运行期间：handleRuntimeEvent 持续推 session_progress 事件给所有连接
        │
        ▼
 ResponseEnvelope{id:3, ok:true, result:{...}}  + 若干 EventEnvelope
        │
        ▼
 client 拿到最终回答；telemetry 同时记录每一步（见第 42 章）
```

注意 `prompt` 这种"长任务"不是"发请求→等一个响应"就结束：服务器在跑的过程中会通过 `EventEnvelope` 不断把进度推给客户端（`sessions.ts:248` 的 `handleRuntimeEvent`），客户端一边更新界面一边等最终 `ResponseEnvelope`。这正体现了协议同时支持"请求-响应"和"服务器主动推送"两种模式。

## 自查清单

- [ ] 我能说出为什么 Pi 用 CBOR 而不是 JSON，以及"4 字节大端长度前缀"分帧的作用（`framing.ts:28`）。
- [ ] 我知道 `FrameDecoder` 是增量解析的，能应对网络分段到达（`framing.ts:58`、`:73`）。
- [ ] 我理解 ClientHello / ServerHello 握手的意义，以及 `PROTOCOL_VERSION = 1`（`schemas.ts:3`）。
- [ ] 我知道请求带 id、响应也带同一 id，客户端靠它匹配 pending 请求（`client.ts:189`、`:294`）。
- [ ] 我理解 `PiClient` 的状态机、pending 请求表、会话租约（`client.ts:51`、`:381`）。
- [ ] 我知道服务器 `dispatchMessage` 的状态机 `awaitingHello → handshaking → ready`（`server.ts:185`），以及握手超时默认 5 秒（`server.ts:35`）。
- [ ] 我能说出 `LiveSessionManager` 的获取/创建/附加/自动销毁职责（`sessions.ts:38`、`:186`、`:300`、`:324`）。
- [ ] 我理解这套协议让 IDE/编辑器能"远程驱动" Pi 做 RPC 调用，TUI 只是其中一种前端。
