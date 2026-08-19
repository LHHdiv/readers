---
title: "第 40 章 · 动手实践一：用 SDK 跑一个单回合"
date: 2026-08-01
summary: "**动手跑通第一次**。基于 Python SDK（`deeptutor/app/facade.py` 的 `DeepTutorApp`）写一个最小程序：初始化应用 → 构造请求 → 发起一个回合 → 读取事件流。读完这章，你会\"亲手按下发动机的点火开关\"，对前面所有抽象有一个落地的体感。"
tags:
  - deeptutor
---
# 第 40 章 · 动手实践一：用 SDK 跑一个单回合

> 目标：**动手跑通第一次**。基于 Python SDK（`deeptutor/app/facade.py` 的 `DeepTutorApp`）写一个最小程序：初始化应用 → 构造请求 → 发起一个回合 → 读取事件流。读完这章，你会"亲手按下发动机的点火开关"，对前面所有抽象有一个落地的体感。

黑话先定义：**SDK（Software Development Kit）** 是"别人封装好、给你程序里直接调用的代码库"；**回合（turn）** 是"你发一条消息到模型完整回应完毕"这个完整过程；**事件流（event stream）** 是回合进行中后端持续推给消费者的进度事件。

---

## 40.1 准备工作：环境与配置

### 40.1.1 环境要求

- Python 3.11+（项目要求，见 README 安装段）。
- 已安装 DeepTutor（开发态建议 `pip install -e .`，第 16 章有完整步骤）。
- 已配置 LLM provider（`deeptutor init` 会引导填 API key、选模型、选端口）。

### 40.1.2 一个重要的认知

SDK 只是**程序化的第三扇门**（第 14 章的三扇门）。它和 CLI、WebSocket 共用同一个内核——你在这里学到的一切（回合、事件流、能力路由）在网页端一模一样。

## 40.2 最小可运行程序（真实接口版）

下面这个程序直接基于 `deeptutor/app/facade.py` 的真实接口（`TurnRequest` 字段来自 `facade.py:15-29`，`DeepTutorApp` 来自 `facade.py:56`）：

```python
import asyncio

from deeptutor.app.facade import DeepTutorApp, TurnRequest


async def main() -> None:
    # 1. 初始化应用（内部装配：runtime / 会话存储 / 能力注册表）
    app = DeepTutorApp()                       # facade.py:56

    # 2. 构造一个回合请求
    request = TurnRequest(
        content="用一句话解释什么是智能体？",     # 必填：用户消息
        capability="chat",                      # 选哪个能力（默认 chat）
        language="zh",                          # 偏好语言
        # knowledge_bases=["my-kb"],            # 需要知识库时解开注释
        # tools=["web_search"],                 # 需要特定工具时解开注释
    )                                           # facade.py:15

    # 3. 发起回合：返回 (session 信息, turn 信息)
    session, turn = await app.start_turn(request)   # facade.py:114

    turn_id = turn["id"]
    print(f"会话: {session['id']}")
    print(f"回合: {turn_id}")

    # 4. 读取事件流（生成器：一个事件一个事件地拿）
    async for event in app.stream_turn(turn_id):   # facade.py:136
        etype = event.get("type", "?")
        if etype in ("text_delta", "token_delta"):
            print(event.get("text", ""), end="", flush=True)
        elif etype in ("label", "status"):
            print(f"\n[{event.get('label') or event.get('status')}]", flush=True)
        elif etype == "error":
            print(f"\n[错误] {event.get('error')}")
        # 其他事件类型按需处理（第 20 章详解）

    print("\n=== 回合结束 ===")


if __name__ == "__main__":
    asyncio.run(main())
```

> **注意 · 请按你的环境微调**
>
> - 事件字段名（`text_delta` / `label` / `status`）以你本机运行的版本为准；打印 `event` 全文看一遍是最快的确认方式（第一行临时改成 `print(event)`）。
> - 如果回合卡住没事件，先确认 provider 配置（`deeptutor init`）和模型名正确。
> - `session["id"]` 等 key 若和你版本不一致，先 `print(session, turn)` 看实际返回。

## 40.3 逐段讲解这段程序

### 40.3.1 `TurnRequest` 是什么

它是"给内核的一次指令单"（`facade.py:15-29`）。字段就是你要对内核说的几件事：

| 字段 | 含义 | 必填？ |
|------|------|--------|
| `content` | 用户消息 | 必填 |
| `capability` | 走哪个能力（chat / deep_solve / ...） | 默认 chat |
| `session_id` | 复用哪个会话（空=新建） | 选填 |
| `tools` | 本回合挂哪些工具（空=按上下文自动挂） | 选填 |
| `knowledge_bases` | 挂哪些知识库 | 选填 |
| `language` | 偏好语言 | 默认 en |
| `config` | 附加配置（模型、温度等） | 选填 |
| `skills` / `attachments` / `notebook_references` / `history_references` | 进阶挂载 | 选填 |

新手阶段你只需要 `content` + `capability`，其他按需加。

### 40.3.2 `start_turn` 干了什么

`DeepTutorApp.start_turn`（`facade.py:114`）内部做三件事：

1. **解析能力名**：`resolve_capability`（`facade.py:65`）把 "chat" 解析成真实能力，不认识的名字直接报错并列出可用能力。
2. **交给内核**：调用 `self.runtime.start_turn(...)`（`facade.py:120`）——这一步就是第 17 章 `turn_runtime.py:682` 的入口，**三扇门都汇到这里**。
3. **存偏好**：把 `language`、`notebook_references` 等写进会话（`facade.py:126`）。

它返回 `(session, turn)`：`session` 是"这次对话的档案"，`turn` 是"这一回合的凭证"，拿 `turn["id"]` 才能订阅事件流。

### 40.3.3 `stream_turn` 是什么

`stream_turn(turn_id, after_seq=0)`（`facade.py:136`）是一个**异步生成器**：内核每产生一个事件，它就吐一个。`after_seq=0` 表示"从头开始读"；如果断线了想续读，传上次看到的事件序号（这正是"可恢复"设计的体现，第 21 章）。

### 40.3.4 事件流里有什么

回合进行中，内核会不断发事件：模型吐字（增量）、标签变化（THINK/TOOL/FINISH）、工具执行进度、错误……你只需要**按类型挑感兴趣的渲染**。所有事件类型在第 20 章有完整清单。

```text
一次 chat 回合的典型事件时间线（示意）:

  label: THINK     → "思考中..."
  text_delta: "智"  → 拼接
  text_delta: "能体" → 拼接
  tool: "rag"      → 检索中（如果挂了知识库）
  label: FINISH    → 收尾
  error: null      → 无错误
```

## 40.4 进阶：两步走（先问能力，再发请求）

如果想"先看看这个环境支持什么，再决定怎么调用"，可以查能力契约：

```python
from deeptutor.app.facade import DeepTutorApp

app = DeepTutorApp()
contracts = app.get_capability_contracts()   # facade.py:77
for c in contracts:
    print(c["name"], "→", c.get("summary", ""))
    print("  available:", c["availability"]["available"])
    if not c["availability"]["available"]:
        print("  install_hint:", c["availability"]["install_hint"])
```

输出里你能看到七个能力的名字、简介、是否可用（比如 `math_animator` 会提示要不要装 `manim`，逻辑在 `facade.py:98-112`）。这在写脚本时很有用：**先探测，再调用，避免瞎猜能力名**。

## 40.5 常见问题速查

| 现象 | 原因 | 处理 |
|------|------|------|
| `Unknown capability` | 能力名写错 | `get_capability_contracts()` 列出真实名字 |
| 事件流为空 / 卡住 | provider 配置缺失 | 重跑 `deeptutor init`，确认 API key 与模型 |
| `math_animator` 不可用 | 没装 manim | `pip install -e ".[math-animator]"` |
| 想连续对话 | 每次新建 session 会失忆 | 第二次请求带上 `session_id=上一回合的 session["id"]` |

> **提示 · 一句话记住本章**
>
> SDK 用法就三步：**`DeepTutorApp()` 初始化 → `start_turn(TurnRequest(...))` 发回合 → `stream_turn(turn_id)` 收事件**。它和网页端共用同一个 `turn_runtime.start_turn`，学会这一份，三扇门都通了。

## 40.6 关联阅读

- 第 16 章：完整跑通环境（`deeptutor init` / `start`）。
- 第 17 章：`start_turn` 内部发生了什么（启动链路）。
- 第 20 章：事件流有哪些类型、怎么消费。
- 第 41 章：进阶实践二——写一个自定义工具。
- 第 42 章：进阶实践三——写一个自定义能力。

## 自查清单

- [ ] 我能说出 SDK 用法的三步（初始化 → start_turn → stream_turn）。
- [ ] 我知道 `TurnRequest` 至少哪两个字段最常用（content / capability）。
- [ ] 我知道 `start_turn` 返回什么（(session, turn)），以及 `turn["id"]` 的用途。
- [ ] 我知道 `DeepTutorApp` 定义在 `facade.py:56`，`start_turn` 在 `facade.py:114`。
- [ ] 我知道 `stream_turn` 的 `after_seq` 参数是干什么的（断点续读）。
- [ ] 我能在本机跑通最小程序并看到事件输出。
- [ ] 我知道能力名报错时怎么排查（`get_capability_contracts()`）。
- [ ] 我知道连续对话要复用 `session_id`。
