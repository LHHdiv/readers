---
title: "第 39 章 · 协作共写：让 AI 当你的\"写作搭子\""
date: 2026-08-01
summary: "读者画像：你完全不懂编程，但想成为智能体开发者。前面几章的 AI 都是\"老师\"（教你怎么学）。这一章的 AI 是\"搭档\"——你写文章，它帮你改写、扩写、缩写、查资料、做批注。这套能力叫 **Co-Writer（协作共写）**，代码在 `deeptutor/co_writer/`。"
tags:
  - deeptutor
---
# 第 39 章 · 协作共写：让 AI 当你的"写作搭子"

> 读者画像：你完全不懂编程，但想成为智能体开发者。前面几章的 AI 都是"老师"（教你怎么学）。这一章的 AI 是"搭档"——你写文章，它帮你改写、扩写、缩写、查资料、做批注。这套能力叫 **Co-Writer（协作共写）**，代码在 `deeptutor/co_writer/`。

## 39.1 直觉：什么是"协作共写"

普通写作工具（Word、备忘录）只是"你把字写进去"。Co-Writer 不一样：你给它一段文字 + 一句指令（"把这段写得更通俗""扩写这一段""用知识库里的资料润色"），它返回一个改好的版本，并且**全程留痕、可追可查**。

它和"活书引擎"的区别在于：活书是 AI 从零生成教材；Co-Writer 是你先写、AI 在你稿子上加工，人是主笔，AI 是编辑。这叫"人在回路（human-in-the-loop）"。

> **说明 · 三个文件先认一下**
>
> - `edit_agent.py`：共写的核心"编辑智能体"，负责真正改文字。
> - `storage.py`：把你的一篇篇文档存到硬盘。
> - `prompts/`：给 AI 看的"系统提示词"（中/英两版）。

## 39.2 EditAgent：一个会改稿的编辑智能体

`deeptutor/co_writer/edit_agent.py` 里的 `EditAgent` 继承自统一的 `BaseAgent`，所以天生就会调 LLM、记日志、用工具。所谓"统一基类"，可以想象成公司给每位员工发了同一套"办公套装"（怎么开会、怎么写报告、怎么用工具）；新员工（比如 `EditAgent`）只要专心做自己的业务，不用从零搭基础设施。这正是 DeepTutor 能快速长出很多 Agent 的秘密。

```text
edit_agent.py:L94    class EditAgent(BaseAgent):
edit_agent.py:L97    def __init__(self, language="en", enabled_tools=None, ...):
edit_agent.py:L119   self.enabled_tools = enabled_tools or ["rag", "web_search"]
edit_agent.py:L122   async def process(self, text, instruction, action="rewrite", ...):
edit_agent.py:L214   async def gather_context(self, *, source, query, ...):
edit_agent.py:L289   async def auto_mark(self, text):           # AI 自动批注
```

`__init__`（`edit_agent.py:97`）里有个关键点：`self.enabled_tools` 默认是 `["rag", "web_search"]`（`edit_agent.py:119`）——也就是说，这个编辑**默认就能查知识库（RAG）和搜网页**。这让它在改写时能"参考真实资料"，而不是凭空编。

`process`（`edit_agent.py:122`）是主入口，参数是：
- `text`：你要改的原文。
- `instruction`：你的指令（如"缩写到一半长度"）。
- `action`：动作，三选一 `rewrite`（改写）/ `shorten`（缩写）/ `expand`（扩写）。

## 39.3 process 内部：一次改写是怎么发生的

把 `process`（`edit_agent.py:122`）拆开看，它其实走了一条很稳的流程：

```text
1. 生成 operation_id（带时间戳+随机串，便于追溯）   edit_agent.py:L138
2. 若指定了 source，先 gather_context 取参考资料     edit_agent.py:L143
3. 拼系统提示词（说明"你是编辑"+"可用工具"）        edit_agent.py:L154
4. 按 action 选动词（Rewrite/Shorten/Expand）        edit_agent.py:L160
5. 拼用户提示词：指令 + (参考上下文) + 原文          edit_agent.py:L163
6. 调 LLM 流式生成，拼成最终文本                     edit_agent.py:L187
7. 把这次操作写进历史记录                            edit_agent.py:L196
```

注意第 2 步：只有当你明确说"用知识库/网页当参考"时，它才去取资料；取不到也不报错，而是退化成"纯改写"（`edit_agent.py:150` 把 `source` 置空）。这种"能降级、不崩"的写法很值得学。

> **提示 · 给 AI 的提示词怎么拼**
>
> 看 `edit_agent.py:154-182`，系统提示词讲"你是谁、能用啥工具"，用户提示词讲"指令 + 参考资料 + 待改原文"。**把"角色、工具、任务、素材"分块拼装**，比写一大段混杂文字更容易控质量、易调试。你以后写任何 Agent 的 prompt 都可套这个模板。

### 39.3.1 一次改写长什么样（伪代码）

把 `process`（`edit_agent.py:122`）翻译成你能读懂的"剧本"：

```python
async def process(text, instruction, action="rewrite", source=None, kb_name=None):
    operation_id = 生成带时间戳的唯一id          # edit_agent.py:138
    context = ""
    if source:                                   # 用户要参考
        context, _ = await gather_context(       # edit_agent.py:144
            source=source, query=instruction, kb_name=kb_name,
            operation_id=operation_id)
        if not context:
            source = None                        # 取不到就降级

    system = "你是专家编辑，可用工具：{tools}"     # edit_agent.py:154
    verb = {"rewrite": "Rewrite",               # edit_agent.py:160
            "shorten": "Shorten",
            "expand":  "Expand"}[action]
    user = f"{verb} 这段文字：{instruction}\n"     # edit_agent.py:163
    if context:
        user += f"参考资料：{context}\n"           # edit_agent.py:173
    user += f"待改原文：{text}"                    # edit_agent.py:182

    chunks = []
    async for c in self.stream_llm(user, system):  # edit_agent.py:187
        chunks.append(c)
    edited = clean_thinking_tags("".join(chunks))  # edit_agent.py:193

    append_history({... "action": action ...})     # edit_agent.py:196
    return {"edited_text": edited, "operation_id": operation_id}
```

读这段代码你会注意到：`stream_llm` 是**流式**的（`edit_agent.py:187`）——字是一个个蹦出来的，前端能实时显示"正在生成"，而不是转圈半天一次性出结果。这和第 20 章事件流是一脉相承的体验设计。

## 39.4 取参考资料：gather_context 的双通道

`gather_context`（`edit_agent.py:214`）负责"在改写前去查资料"，它支持两个来源：

```text
edit_agent.py:L227   if source == "rag":     # 查本地知识库
edit_agent.py:L236       search_result = await rag_search(query=..., kb_name=..., ...)
edit_agent.py:L260   if "web_search" not in self.enabled_tools:  # 没开网页工具就退
edit_agent.py:L267       search_result = await asyncio.to_thread(web_search, query)
```

- **RAG 通道**（`edit_agent.py:227`）：从你指定的知识库 `kb_name` 里检索相关段落。但若工具没启用、或没给 `kb_name`，它就返回空（`edit_agent.py:228/231`），不硬查。
- **网页通道**（`edit_agent.py:260`）：调用 `web_search`。注意 L267 用了 `asyncio.to_thread`——把同步的网络请求丢到后台线程，**不阻塞事件循环**，这样多个改写请求能并发进行。

无论哪个通道，查到的内容都会通过 `save_tool_call`（`edit_agent.py:241/270`）存成 JSON 文件，文件名带 `operation_id`，方便事后审计"这次改写参考了啥"。

两个通道的对比：

| 维度 | RAG（知识库） | Web（网页） |
| --- | --- | --- |
| 触发条件 | `source="rag"` 且开了 `rag` 工具且给了 `kb_name` | `source="web"` 且开了 `web_search` |
| 调用函数 | `rag_search`（`edit_agent.py:236`） | `web_search`（`edit_agent.py:267`） |
| 执行方式 | 异步检索 | `asyncio.to_thread` 丢后台线程 |
| 取不到时 | 返回空、`source` 置空（`edit_agent.py:150`） | 返回空、降级纯改写 |
| 存证 | `save_tool_call(..., "rag", ...)` | `save_tool_call(..., "web", ...)` |

> **说明 · 两个"防御性"细节**
>
> 1. **工具开关检查**：RAG 没启用或没给 `kb_name`，立刻返回空（`edit_agent.py:228/231`），不傻等报错。
> 2. **异常兜底**：两个通道都包了 `try/except`，失败就 `return "", None`（`edit_agent.py:256/285`），绝不因为"查不到资料"就让整个改写崩掉。这种"外部依赖不可靠，必须兜底"的意识，是你写任何联网/调库功能都要有的。

## 39.5 历史记录：每次操作都留痕

Co-Writer 把每次改写都记进历史，而且做得克制：

```text
edit_agent.py:L44    _HISTORY_MAX_ENTRIES = 200          # 最多存 200 条
edit_agent.py:L45    _HISTORY_TEXT_LIMIT = 20_000        # 单条文本截断到 2 万字
edit_agent.py:L48    def load_history() -> list:
edit_agent.py:L61    def save_history(history):          # 原子写
edit_agent.py:L75    def append_history(record):         # 追加并裁剪
edit_agent.py:L67    def _clip_history_value(value):     # 长文本截断
```

代码注释说得很清楚（`edit_agent.py:41`）：历史只是"调试/审计线索"，不是主存储。所以它会**限制条目数（200）和单条长度（2 万字符）**，防止一个长期工作区把历史文件撑爆。`save_history`（`edit_agent.py:61`）走原子写，避免写到一半崩溃把整个历史文件弄坏。

> **说明 · 留痕不是越多越好**
>
> 历史记录用于"出事时查原因"，但无限增长会拖垮系统。DeepTutor 用"上限 + 截断 + 原子写"三件套平衡了"可追溯"和"不膨胀"。你以后做任何带日志/历史的功能，都该这么管。

## 39.6 auto_mark：AI 自动批注

除了改写，`EditAgent` 还有个 `auto_mark`（`edit_agent.py:289`）：你给它一段文字，它返回"加了标注的版本"（比如用 `<span data-rough-notation="circle">关键词</span>` 标出重点）。虽然章节里我们不展开 HTML 细节，但你要知道它的调用方式和 `process` 同构：

```text
edit_agent.py:L298   operation_id = ...          # 同样带追溯 id
edit_agent.py:L300   system_prompt = self.get_prompt("auto_mark_system", "")
edit_agent.py:L308   async for _c in self.stream_llm(...):  # 同样流式调 LLM
edit_agent.py:L317   append_history({... "action": "automark" ...})  # 同样入历史
```

要点：**无论哪种能力，都复用同一套"取 prompt → 流式生成 → 记历史"骨架**。这是 `BaseAgent` 带来的好处——作者不用为每种功能重写底层。

## 39.7 文档存储：storage.py 把稿子存哪

Co-Writer 的"主存储"是你的文档本身（不是历史）。`deeptutor/co_writer/storage.py` 管这个：

```text
storage.py:L34    class CoWriterDocument(BaseModel):     # 一篇文档的数据结构
storage.py:L44    class CoWriterDocumentSummary(BaseModel):  # 列表用的摘要视图
storage.py:L96    class CoWriterStorage:
storage.py:L144   def list_documents(self) -> list[CoWriterDocumentSummary]:
storage.py:L162   def create_document(self, *, title=None, content="") -> CoWriterDocument:
storage.py:L195   def update_document(self, doc_id, *, title=None, content=None):
storage.py:L230   def _write(self, document):            # 内部：原子写
storage.py:L238   def get_co_writer_storage() -> CoWriterStorage:  # 全局单例
```

存储布局（`storage.py:7` 注释）是：`co-writer/doc_{doc_id}/manifest.json`，每篇文档一个目录、一个清单文件，里面记 `id / title / content / created_at / updated_at`。

几个贴心设计：
- **标题自动推导**：没给标题时，`_derive_title`（`storage.py:70`）从正文第一行（特别是 `#` 标题行）取标题，最多 120 字。
- **预览自动生成**：列表接口返回 `preview`（`storage.py:86`），把正文压成 160 字以内的纯文本预览，避免一次拉整篇。
- **更新同步标题**：你改了正文但没改标题，`update_document`（`storage.py:195`）会自动从新正文重推标题（`storage.py:214`），保持"标题永远是正文第一行的意思"。

> **提示 · "摘要视图"模式**
>
> `CoWriterDocumentSummary`（`storage.py:44`）和 `CoWriterDocument` 分开：列表时只给轻量摘要（不含全文），打开某篇才给全文。这叫**懒加载**，能省带宽、提速。凡是有"列表 + 详情"的界面，都该这么分两层模型。

### 39.7.1 文档的增改查删（CRUD）流程

`CoWriterStorage` 的对外方法构成一套标准的"增删改查"：

```text
create_document  (storage.py:162)   建：生成 doc_id → 写 manifest.json
load_document    (storage.py:185)   查：读 manifest.json → 校验成模型
update_document  (storage.py:195)   改：读旧的 → 覆盖字段 → 写回
delete_document  (storage.py:221)   删：rmtree 整个 doc_{id} 目录
list_documents   (storage.py:144)   列：遍历 doc_* 目录 → 返回摘要，按更新时间排序
```

注意 `create_document`（`storage.py:162`）生成 `doc_id` 时用 `uuid.uuid4().hex[:12]`，还套了个 `while` 循环防碰撞（`storage.py:170`）——虽然 12 位十六进制碰撞概率极低，但作者仍"以防万一"，这就是稳健代码的态度。删除则是直接 `shutil.rmtree` 删整个目录（`storage.py:225`），干脆利落。

所有写操作最终都走 `_write`（`storage.py:230`）→ 原子写（`storage.py:54` 的 `_atomic_write_json`）。所以无论建/改，永远不会出现"写到一半断电，manifest.json 变半截"的情况。

## 39.8 提示词：prompts/ 里的中英模板

Co-Writer 的"人设"和"改写规矩"写在 `deeptutor/co_writer/prompts/` 里，分 `en/`（英文）和 `zh/`（中文）两版，每版有 `edit_agent.yaml`。以英文版为例：

```text
prompts/en/edit_agent.yaml 内部片段:
  system: |                              # 系统提示：你是专家编辑
    You are an expert editor and writing assistant.
    Available reference tools: {available_tools}
  action_template: |                     # 动作模板（改写/缩写/扩写）
    {action_verb} the following text based on the user's instruction.
  context_template: |                    # 参考资料怎么塞进去
    Reference Context ({source_label}): {context}
  user_template: |                       # 待改原文
    Target Text to Edit: {text}
  auto_mark_system: |                    # 自动批注的人设
    You are a professional academic reading annotation assistant...
```

这些模板用 `{占位符}` 填空，运行时由 `edit_agent.py` 用 `.format(...)` 把真实值填进去（`edit_agent.py:158/167/173/182`）。把"提示词"和"代码"分离成 YAML，好处是：**改话术不用动代码、还能中英切换**，非程序员也能调。

> **说明 · 提示词工程的第一课**
>
> 好的提示词不是"一段神咒"，而是**结构化的模板 + 可控的填空**。DeepTutor 用 YAML 把"角色 / 动作 / 上下文 / 原文"拆成独立字段，运行时再拼。这样你既能让产品经理想改话术就改，也能在出错时精确定位"是哪块模板填错了"。把 prompt 当代码一样版本化管理，是专业做法。

## 39.9 协作的定位：人是主笔，AI 是编辑

把 Co-Writer 放回 DeepTutor 全局看它的位置：

```text
DeepTutor 的"教"侧：
   活书引擎（Book Engine）  ── 自动生成教材
   学习引擎（Learning）      ── 自动教+测+评

DeepTutor 的"写"侧：
   Co-Writer（本章）        ── 和人一起写文档/笔记
```

它体现了一种重要产品哲学：**AI 不取代人，而是补人的短板**。你写初稿（创意、判断归你），AI 做缩写/扩写/查资料/批注（体力、检索归它）。这种"分工协作"正是未来智能体产品的主流形态。

## 39.10 给未来智能体开发者的启示

读完这章，你学到的是一个**"AI 辅助创作"的最小可用范式**：

1. **能力分动作**：`rewrite/shorten/expand` 用同一个 `process` + 不同动词，不写三套函数。
2. **参考资料可插拔**：`gather_context` 支持 RAG/网页双通道，且"取不到就降级"。
3. **同步 IO 别阻塞**：网页搜索用 `asyncio.to_thread`（`edit_agent.py:267`）丢后台。
4. **一切留痕可追溯**：操作历史有上限、有截断、原子写。
5. **提示词与代码分离**：YAML 模板 + `.format` 填空，便于非程序员调话术。

这五条，做"AI 写作助手""代码补全搭子""报告生成器"都能直接用。

## 39.11 串起来：从"新建一篇"到"改完存盘"

把全章模块接成一条时间线，看清 Co-Writer 怎么陪你写：

```text
你点"新建文档"
      │
      ▼
CoWriterStorage.create_document       生成 doc_id，写空 manifest   (storage.py:162)
      │
      ▼
你在编辑器里打字（前端实时存 content）
      │
      ▼
你选"用知识库资料扩写这一段"并点运行
      │
      ▼
EditAgent.process(text, instruction, action="expand", source="rag", kb_name=...)  (edit_agent.py:122)
      │
      ├─ gather_context → rag_search 取资料        (edit_agent.py:236)
      ├─ 拼 prompt（system+action+context+text）    (edit_agent.py:154)
      ├─ stream_llm 流式生成 edited_text           (edit_agent.py:187)
      └─ append_history 留痕                        (edit_agent.py:196)
      │
      ▼
你把 edited_text 替换回编辑器
      │
      ▼
CoWriterStorage.update_document        同步标题、原子写回           (storage.py:195)
      │
      ▼
下次打开 → load_document 读回完整稿       (storage.py:185)
```

你会发现整条链路里：**真正"聪明"的只有 `EditAgent.process` 那一次 LLM 调用**，其余全是"存、取、留痕、拼装"。这正是好系统的样子——把"不确定的 AI 部分"缩到最小，把"确定的工程部分"（存储、历史、提示词装配）做扎实，系统才可靠、可维护。

## 39.12 一个能跑的最小调用示例

如果你将来想在自己的脚本里直接调用 Co-Writer（不经由网页），大致是这样：

```python
import asyncio
from deeptutor.co_writer.edit_agent import EditAgent

async def main():
    agent = EditAgent(language="zh", enabled_tools=["rag", "web_search"])
    result = await agent.process(
        text="注意力机制让模型关注输入里重要的部分。",
        instruction="把这段话扩写成一段通俗解释，面向高中生。",
        action="expand",
        source="web",          # 可选：先搜网页资料再扩写
    )
    print(result["edited_text"])
    print("操作编号:", result["operation_id"])

asyncio.run(main())
```

这段示例对应 `edit_agent.py:97` 的构造和 `edit_agent.py:122` 的 `process`。注意 `enabled_tools` 决定它能查哪些资料；`source` 决定本次要不要先取参考。把 API Key / 模型配置交给统一的配置服务（第 24 章 LLM 服务），Co-Writer 自己不用管。

## 自查清单

- [ ] 我能说出 Co-Writer 与"活书引擎"的区别：人是主笔，AI 是编辑。
- [ ] 我知道 `EditAgent` 的三种动作 `rewrite/shorten/expand`（`edit_agent.py:122/160`）。
- [ ] 我理解 `process` 的流程：取参考→拼 prompt→流式生成→记历史（`edit_agent.py:122`）。
- [ ] 我知道参考资料有 RAG 和网页两个通道，且"取不到就降级"（`edit_agent.py:143/150`）。
- [ ] 我明白网页搜索用 `asyncio.to_thread`（`edit_agent.py:267`）避免阻塞事件循环。
- [ ] 我知道历史记录有上限 200 条、截断 2 万字、原子写（`edit_agent.py:44/45/61`）。
- [ ] 我能说出文档存储结构 `doc_{id}/manifest.json`（`storage.py:7/162`）。
- [ ] 我理解"摘要视图"`CoWriterDocumentSummary`（`storage.py:44`）用于列表、省带宽。
- [ ] 我知道提示词写在 `prompts/*.yaml` 里，用 `{占位符}` + `.format` 填空（`edit_agent.py:158`）。
- [ ] 我能解释为什么 Co-Writer 体现"人在回路 / AI 补人短板"的产品哲学。

> **提示 · 回头看这一章的"隐藏主线"**
>
> Co-Writer 表面是"改文字"，底层却示范了一个通用 Agent 脚手架：**统一基类 `BaseAgent` 提供 LLM 调用/日志/工具，子类只写业务**。于是 `EditAgent` 不用关心"怎么流式调模型、怎么取配置"，只关心"改写逻辑"。当你以后写第二个、第三个 Agent（比如审稿 Agent、翻译 Agent），这套脚手架让开发成本越来越低。读懂 `edit_agent.py`，你就摸到了 DeepTutor "Agent 工厂"的脾气。
