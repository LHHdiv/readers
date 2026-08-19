---
title: "第 09 章 · 检索增强 RAG 与向量数据库"
date: 2026-08-01
summary: "讲清\"让 AI 读你的教材/论文/笔记\"这件事的完整机制。从切块、向量化、存库、检索到拼进提示词，每一步都用直觉解释。读完你能理解为什么教育场景离不开 RAG，也能看懂 DeepTutor 支持六种检索引擎背后的取舍。"
tags:
  - deeptutor
---
# 第 09 章 · 检索增强 RAG 与向量数据库

> 目标：讲清"让 AI 读你的教材/论文/笔记"这件事的完整机制。从切块、向量化、存库、检索到拼进提示词，每一步都用直觉解释。读完你能理解为什么教育场景离不开 RAG，也能看懂 DeepTutor 支持六种检索引擎背后的取舍。

---

## 9.1 先搞清楚问题：模型为什么"不知道"

大模型的知识来自训练数据，训练完就固定了。它有三个天生的缺口：

| 缺口 | 例子 |
|------|------|
| **时效性** | 训练截止后发生的事，它一无所知 |
| **私域性** | 你的课件、你导师的论文、你公司的文档，它从没见过 |
| **精确性** | 它可能"大概记得"某个定理，但记不清具体表述和页码 |

对教育场景，第二和第三个缺口是致命的。学生问"我们教材第 3 章讲的那个模型怎么理解"，模型不可能知道你用的是哪本教材。

> **说明 · 为什么不能"把教材直接塞进提示词"**
>
> 最朴素的想法：把整本书粘贴到 system prompt 里。
> 
> 不行，三个原因：
> 1. **装不下**。上下文窗口有上限（常见 12.8 万～100 万 token）。一本 500 页的教材轻松超过。
> 2. **太贵**。每次对话都重发整本书，成本按 token 计费，几轮就破产。
> 3. **效果反而差**。信息越多噪声越大，模型容易"看丢"关键段落——业内叫"lost in the middle"（长文本中段信息被忽略）现象。
> 
> 所以我们需要的是：**每次只挑出最相关的那几段**。这就是 RAG。

---

## 9.2 RAG 是什么：开卷考试的比喻

**RAG = Retrieval-Augmented Generation，检索增强生成。**

拆开看就三个词：先**检索**（Retrieval）→ 用检索结果**增强**（Augmented）提示词 → 再让模型**生成**（Generation）答案。

最贴切的比喻是**开卷考试**：

```text
闭卷考试（纯 LLM）：
   学生凭记忆答题 -> 记错了、记不清、瞎编（幻觉）

开卷考试（RAG）：
   看到题目 -> 翻书找到相关的 3 页 -> 照着书上的内容组织答案
                    ^^^^^^^^^^^^^
                    这一步就是"检索"
```

关键在于：**学生不需要背下整本书，只需要会翻书。** RAG 干的就是给模型装一个"会翻书"的能力。

---

## 9.3 完整流程：五个步骤

RAG 分两个阶段：**离线建库**（做一次）和**在线检索**（每次提问都做）。

```text
========== 离线阶段：建库（文档上传时做一次） ==========

  原始文件（PDF / Word / Markdown / 网页）
        |
        v
  [1] 解析：提取纯文本（去掉排版、图片、页眉页脚）
        |
        v
  [2] 切块（chunking）：切成一段段小片段
        |    "第一章 导论……"  -> chunk 1
        |    "1.1 研究背景……" -> chunk 2
        |    "1.2 研究问题……" -> chunk 3
        v
  [3] 向量化（embedding）：每个 chunk 变成一串数字
        |    chunk 1 -> [0.12, -0.83, 0.44, ... ]  （比如 1536 个数）
        |    chunk 2 -> [0.09, -0.71, 0.51, ... ]
        v
  [4] 入库：向量 + 原文一起存进向量数据库
        |
        v
     索引建好，等着被查

========== 在线阶段：每次提问都做 ==========

  用户问题 "研究问题是什么"
        |
        v
  [5a] 同样向量化 -> [0.11, -0.75, 0.48, ...]
        |
        v
  [5b] 在库里找"数字最接近"的 K 个 chunk
        |    -> chunk 3（相似度 0.91）
        |    -> chunk 2（相似度 0.83）
        |    -> chunk 7（相似度 0.72）
        v
  [5c] 把这 3 段原文拼进提示词
        |
        |    system: 你是助教。以下是相关资料：
        |            【资料1】1.2 研究问题……
        |            【资料2】1.1 研究背景……
        |            【资料3】……
        |            请基于资料回答，资料里没有的不要编。
        |    user:   研究问题是什么
        v
  [5d] 模型生成答案 + 标注引用来源
```

下面逐步拆解最关键的三步。

---

## 9.4 步骤详解：切块（chunking）

### 9.4.1 为什么要切

因为检索的粒度决定了效果。如果整本书是一个块，检索出来还是整本书，等于没检索。如果切得太碎（比如一句一块），又会丢失上下文——"它导致了这个结果"这句话单独拿出来毫无意义。

### 9.4.2 两个核心参数

DeepTutor 默认走 LlamaIndex 引擎，切块参数定义在 `deeptutor/services/rag/pipelines/llamaindex/config.py:89`：

```py
chunk_size = settings.get("chunk_size", 512)
chunk_overlap = settings.get("chunk_overlap", 50)
```

- **chunk_size = 512**：每块大约 512 个 token（中文约 300～400 字）。这是一个业界常用的折中值——够长能保住上下文，够短能保证检索精度。
- **chunk_overlap = 50**：**相邻两块重叠 50 个 token**。

### 9.4.3 为什么需要 overlap

这是新手最容易忽略的参数。看这个例子：

```text
无重叠（overlap=0）：
  chunk 1: "……实验采用双盲设计，共招募 32 名"
  chunk 2: "大学生志愿者，平均年龄 20.3 岁……"

  用户问"被试是多少人"
  -> chunk 1 有"32 名"但没说是什么
  -> chunk 2 有"大学生志愿者"但没说数量
  -> 两块都不完整，检索出哪个都答不好

有重叠（overlap=50）：
  chunk 1: "……实验采用双盲设计，共招募 32 名大学生志愿者，平均年龄"
  chunk 2: "共招募 32 名大学生志愿者，平均年龄 20.3 岁，均为右利手……"
                ^^^^^^^^^^^^^^^^^^ 重叠部分
  -> 无论检索到哪块，信息都完整
```

**重叠是为了防止关键信息被切断在两块交界处。** 代价是存储和计算量增加约 10%，非常值得。

在 `deeptutor/services/rag/pipelines/llamaindex/embedding_adapter.py:148` 可以看到这两个参数被真正应用：

```py
chunk_size, chunk_overlap = chunk_geometry()
Settings.chunk_size = chunk_size
Settings.chunk_overlap = chunk_overlap
```

---

## 9.5 步骤详解：向量化（embedding）

### 9.5.1 直觉：把意思变成坐标

这是整个 RAG 里最"魔法"的一步，但直觉其实很简单。

想象一张地图，每个词/句子在地图上有一个位置。规则是：**意思越接近的，位置越近**。

```text
        （二维简化示意，真实是上千维）

   动物区                          交通工具区
      猫 •                              • 汽车
     狗 •  • 宠物                  卡车 •   • 货车
   兔子 •                              • 自行车


   学术区
   论文 •  • 研究
     实验 •
```

"猫"和"狗"离得近，"猫"和"汽车"离得远。这个"位置"就是**向量（vector）**——一串数字，比如 1536 个小数。

> **说明 · 黑话拆解：embedding（嵌入 / 向量化）**
>
> `embedding` 直译"嵌入"，意思是**把一段文字"嵌入"到一个高维空间里的某个点**。
> 
> - 输入：一段文字（"研究问题是什么"）
> - 输出：一串固定长度的小数（`[0.11, -0.75, 0.48, ...]`，长度可能是 768、1024、1536、3072）
> - 性质：意思相近的文字，输出的数字串也相近
> 
> 它由一个专门的**嵌入模型**（和聊天模型是两种不同的模型）计算。你不需要懂它内部怎么算的，只需要记住这条性质。

### 9.5.2 "相近"怎么量化：余弦相似度

最常用的度量叫**余弦相似度（cosine similarity）**。抛开数学，用直觉说：

```text
   把每个向量想象成从原点出发的一支箭。
   比较两支箭"指向"是否一致：

        方向几乎相同 -> 相似度接近 1.0  （意思很像）
        \  \
         \  \
          \_ \_

        方向垂直     -> 相似度约 0.0    （毫无关系）
        |
        |____

        方向相反     -> 相似度接近 -1.0 （意思相对）
        /
       /
      /______
             \
              \
```

注意它比的是**方向**不是**长度**。所以一句话说得长还是短不影响判断，只看"讲的是不是同一件事"。

实际检索时，就是把用户问题的向量拿去和库里所有 chunk 的向量算相似度，取分数最高的前 K 个（常见 K=3～10）。

### 9.5.3 关键约束：查询和入库必须用同一个模型

这是新手最常踩的坑。

```text
  建库时用 模型A 向量化  ->  向量在 A 的坐标系里
  查询时用 模型B 向量化  ->  向量在 B 的坐标系里

  两个坐标系不通用！算出来的相似度是纯噪声，
  检索结果完全是乱的（但程序不会报错，很难发现）
```

所以换嵌入模型 = **必须重建整个索引**。

DeepTutor 严肃对待这个问题，专门有 `deeptutor/services/rag/embedding_signature.py` 和 `deeptutor/services/rag/index_versioning.py` 两个模块来追踪"这个索引是用哪个嵌入模型建的"。在 `deeptutor/services/rag/factory.py:64` 有一个判断：

```py
def provider_uses_embedding_versions(provider: Optional[str]) -> bool:
```

以及 `factory.py:76`：

```py
def version_matches_provider(entry: dict[str, Any], provider: Optional[str]) -> bool:
```

作用就是检查"库里存的索引版本，跟当前配置的引擎/模型对不对得上"，对不上就提示重建。

嵌入客户端本身在 `deeptutor/services/embedding/client.py:37`：

```py
class EmbeddingClient:
    """Unified embedding client for RAG and retrieval services."""
```

注意它的构造函数里有一段很实在的错误处理（`client.py:44` 起）：如果用户配的 endpoint 不合法，直接抛出带具体说明的异常，而不是等到调用时才神秘失败。

---

## 9.6 步骤详解：向量数据库

### 9.6.1 它解决什么问题

假设你的教材切成了 5 万个 chunk。用户提一个问题，你要和 5 万个向量逐一算相似度——每个向量 1536 维，那就是 7680 万次乘法。一次查询要几秒，不可接受。

**向量数据库**就是专门优化这件事的存储引擎。它用近似最近邻算法（ANN，Approximate Nearest Neighbor）把查询从"逐个比对"变成"跳着找"，几百万条数据也能毫秒级返回。

代价是"近似"——可能漏掉真正的第 1 名，返回第 2 名。但对 RAG 场景完全够用。

### 9.6.2 常见选择

| 类型 | 例子 | 适合 |
|------|------|------|
| 嵌入式（本地文件） | FAISS、Chroma、LanceDB | 个人使用、离线、数据不出本机 |
| 服务型 | Milvus、Qdrant、Weaviate | 团队/生产、数据量大 |
| 云托管 | Pinecone 等 | 不想运维 |
| 传统库扩展 | pgvector（PostgreSQL 插件） | 已有 PG 且量不大 |

DeepTutor 默认走本地路线——教育场景里学生的论文和笔记属于隐私数据，**不出本机**是很重要的产品决策。

---

## 9.7 DeepTutor 的 RAG 架构：一个工厂，六种引擎

### 9.7.1 为什么不是只有一种

因为"检索"这件事没有银弹。不同资料、不同问题类型，最优方案不同。

`deeptutor/services/rag/factory.py:1` 的模块文档把六种引擎列得很清楚：

```text
* ``llamaindex`` (default) — local vector retrieval with hybrid BM25 fusion.
* ``pageindex``           — hosted, vectorless reasoning retrieval (needs an
                            API key configured under Knowledge → RAG settings).
* ``graphrag``            — local knowledge-graph retrieval (microsoft/graphrag);
                            optional dependency, ``pip install 'deeptutor[graphrag]'``.
* ``lightrag``            — graph + vector retrieval (HKUDS/LightRAG, multimodal
                            via RAG-Anything); optional dependency,
                            ``pip install 'deeptutor[rag-lightrag]'``.
* ``lightrag-server``     — retrieval offloaded to an external, standalone
                            LightRAG server the user runs. ...
* ``ima``                 — retrieval offloaded to a Tencent IMA knowledge base
                            the user curates in IMA. ...
```

对应的常量在 `factory.py:31`：

```py
DEFAULT_PROVIDER = "llamaindex"
PAGEINDEX_PROVIDER = "pageindex"
GRAPHRAG_PROVIDER = "graphrag"
LIGHTRAG_PROVIDER = "lightrag"
LIGHTRAG_SERVER_PROVIDER = "lightrag-server"
IMA_PROVIDER = "ima"
```

用人话解释这六种：

| 引擎 | 一句话 | 什么时候选 |
|------|--------|-----------|
| llamaindex | 标准向量检索 + BM25 关键词融合 | 默认，绝大多数情况 |
| pageindex | **不用向量**，靠模型推理式定位 | 结构化长文档（如带目录的教材） |
| graphrag | 先抽实体和关系建成知识图谱再查 | 需要"跨章节综合"的全局性问题 |
| lightrag | 图 + 向量结合，支持多模态 | 图文混排的资料 |
| lightrag-server | 检索外包给你自建的服务器 | 资料量大、多人共用 |
| ima | 检索外包给腾讯 IMA 云知识库 | 已有 IMA 资料 |

> **提示 · 混合检索（hybrid）为什么重要**
>
> 注意默认引擎的描述里有 "hybrid BM25 fusion"。BM25 是一种**传统关键词检索**算法（就是搜索引擎的老本行，按词频匹配）。
> 
> 为什么向量检索还要配关键词检索？因为向量擅长"理解意思"，但**不擅长精确匹配专有名词**。
> 
> - 用户搜 "Transformer"，向量检索可能返回一堆讲"神经网络架构"的段落，但漏掉真正写着 Transformer 的那段。
> - BM25 会精准命中包含 "Transformer" 这个词的段落。
> 
> 两者融合，取长补短。**学术场景里公式名、人名、缩写特别多，混合检索几乎是必需的。**

### 9.7.2 工厂模式：怎么在六种引擎间切换

`factory.py:120` 的 `_build_pipeline` 是核心分发逻辑：

```py
def _build_pipeline(provider: str, kb_base_dir: Optional[str], **kwargs: Any):
    if provider == PAGEINDEX_PROVIDER:
        from .pipelines.pageindex.pipeline import PageIndexPipeline

        if kb_base_dir is not None:
            kwargs.setdefault("kb_base_dir", kb_base_dir)
        return PageIndexPipeline(**kwargs)

    if provider == GRAPHRAG_PROVIDER:
        from .pipelines.graphrag.pipeline import GraphRagPipeline
        ...
```

注意每个分支里的 `from ... import ...` 都写在**函数内部**，而不是文件顶部。这不是马虎，是刻意的**延迟导入（lazy import）**：

- GraphRAG、LightRAG 都是**可选依赖**（要单独 `pip install`）。
- 如果在文件顶部 import，用户没装这些包，整个程序启动就崩了。
- 写在分支里，只有真正选了这个引擎才导入，没装就只影响这一个引擎。

> **说明 · 黑话拆解：工厂模式（factory pattern）**
>
> "工厂"就是一个函数，你告诉它"我要什么型号"，它返回对应的对象，而你不需要知道它内部怎么造的。
> 
> 好处是**调用方代码不用改**。业务层永远写 `get_pipeline(name)`，用户在设置里从 llamaindex 换成 graphrag，业务层一行代码都不用动。这就是"面向接口编程"的实际收益。

### 9.7.3 缓存与兜底

`factory.py:163` 的 `get_pipeline` 是对外入口：

```py
def get_pipeline(
    name: str = DEFAULT_PROVIDER,
    kb_base_dir: Optional[str] = None,
    **kwargs: Any,
):
    """Return a pipeline instance for ``name`` (cached when no custom kwargs)."""
    provider = normalize_provider_name(name)

    if kwargs:
        # Custom kwargs (e.g. an injected client/loader): build a fresh instance
        # and skip the cache so overrides are honoured.
        return _build_pipeline(provider, kb_base_dir, **kwargs)

    cache_key = (kb_base_dir, provider)
    if cache_key not in _PIPELINE_CACHE:
        _PIPELINE_CACHE[cache_key] = _build_pipeline(provider, kb_base_dir)
    return _PIPELINE_CACHE[cache_key]
```

三个设计点：

1. **`normalize_provider_name`**（`factory.py:54`）先把名字规范化。配置文件里可能存着老版本遗留的引擎名，规范化后不认识的一律退回默认值，**不让程序因为一个陌生字符串就崩溃**。
2. **缓存**：管道对象创建有开销（加载模型、打开索引文件），按 `(目录, 引擎)` 缓存复用。
3. **带自定义参数时跳过缓存**：因为缓存的对象是共享的，如果注入了自定义客户端还往缓存里放，会污染其他调用方。

还有一条硬规则，写在 `factory.py:21`：

> A KB is bound to one provider at creation time; later adds and retrieval always go through that same pipeline (enforced upstream in the knowledge router).

**一个知识库创建时绑定一种引擎，之后不能换。** 原因回到 9.5.3——索引格式和向量坐标系都是引擎相关的，中途换引擎等于索引作废。

---

## 9.8 进阶：多查询检索

用户的问题往往不是最好的检索词。比如用户问"这个方法靠谱吗"，直接拿这句话去检索，什么也搜不到。

解法：**先让模型把问题改写成几个更好的检索词，并行去搜，再把结果汇总**。

DeepTutor 的 `deeptutor/services/rag/smart_retriever.py:12` 就干这个：

```py
class SmartRetriever:
    """Generate query variants, retrieve passages, and aggregate them."""
```

核心方法 `retrieve`（`smart_retriever.py:18`）的逻辑：

```py
queries = query_hints if query_hints else await self._generate_queries(context, max_queries)
results = await asyncio.gather(
    *(self._search(query=q, kb_name=kb_name) for q in queries),
    return_exceptions=True,
)
```

三步：

1. 没给检索词提示，就调模型生成 `max_queries`（默认 3）个不同角度的查询（`smart_retriever.py:49`）。
2. `asyncio.gather` **并行**执行所有检索——3 个查询同时跑，总耗时约等于最慢那个。
3. `return_exceptions=True` 让**单个查询失败不影响其他**，失败的在循环里被跳过（`smart_retriever.py:34`）。

最后用 `_aggregate`（`smart_retriever.py:68`）把多段结果交给模型综合成一段摘要。

值得学的是它的**双层兜底**：生成查询失败了，退回用原文前 200 字当查询（`smart_retriever.py:66`）；汇总失败了，退回把段落直接拼起来（`smart_retriever.py:81`）。**任何一层 LLM 调用挂掉，功能都还能降级运行，不会整个崩掉。**

---

## 9.9 教育场景为什么特别需要 RAG

| 需求 | 为什么 RAG 是答案 |
|------|-------------------|
| **教材问答** | 每个学校用的教材版本不同，模型不可能都读过 |
| **论文精读** | 学生刚下载的新论文，模型训练时根本不存在 |
| **可溯源** | 教育场景里"答案对不对"必须能查证。RAG 能给出"出自第几页"，纯生成不能 |
| **减少幻觉** | 有原文摆在提示词里，模型编造的概率大幅下降 |
| **个性化** | 结合学生自己的笔记和错题，给出针对性讲解 |

第三点尤其关键。第 7 章讲的 `ToolResult.sources`（`deeptutor/core/tool_protocol.py:127`）就是为它服务的：

```py
sources: list[dict[str, Any]] = field(default_factory=list)
```

注释说明这些是"Citation rows surfaced through `stream.sources`"——检索到的来源会一路传到前端渲染成引用列表。**学生能点开看原文，这在教育产品里不是加分项，是底线。**

---

## 9.10 RAG 效果不好时的排查顺序

按这个顺序查，能解决 90% 的问题：

```text
   RAG 答得不好
        |
        v
  [1] 先看检索结果本身，而不是改提示词
      把检索到的 chunk 打印出来肉眼看
        |
        +--> 检索到的内容压根不相关?
        |      |
        |      +--> 查嵌入模型是否与建库时一致（9.5.3）
        |      +--> 查是否该用混合检索补关键词匹配
        |      +--> 查用户问法是否需要改写（9.8 多查询）
        |
        +--> 内容相关但不完整、被切断?
        |      |
        |      +--> 调大 chunk_size 或 chunk_overlap
        |
        +--> 检索对了但答案还是错?
               |
               +--> 这才是提示词问题：
                    加一句"只依据资料回答，资料没提到就说不知道"
```

**核心原则：先确认"翻到的是不是对的那几页"，再去调"怎么读这几页"。** 新手总是反着来，一上来就疯狂改提示词，其实检索出来的根本是无关内容。

---

## 9.11 本章要点回顾

- 模型有时效性、私域性、精确性三个缺口，RAG 用"开卷考试"的方式补上。
- 完整流程：解析 → 切块 → 向量化 → 入库 →（提问时）向量化问题 → 相似度检索 → 拼进提示词 → 生成。
- 切块要设 overlap（DeepTutor 默认 `chunk_size=512, chunk_overlap=50`，见 `pipelines/llamaindex/config.py:89`），防止关键信息被切在交界处。
- embedding 把文字映射成高维空间的点，意思近则位置近；用余弦相似度比"方向"而非"长度"。
- **建库和查询必须用同一个嵌入模型**，换模型必须重建索引。DeepTutor 用 `factory.py:64` / `factory.py:76` 做版本校验。
- 向量数据库靠近似最近邻算法把百万级检索压到毫秒级。
- DeepTutor 用工厂模式支持六种引擎（`factory.py:31` 常量、`factory.py:120` 分发、`factory.py:163` 入口），可选依赖用延迟导入避免启动崩溃。
- 一个知识库创建时绑定一种引擎，不可中途更换（`factory.py:21`）。
- `SmartRetriever`（`smart_retriever.py:12`）做多查询并行检索 + 汇总，每层都有降级兜底。
- 教育场景对"可溯源"的要求，让 `ToolResult.sources`（`tool_protocol.py:127`）成为必需而非可选。

---

## 自查清单

- [ ] 我能解释为什么不能把整本教材直接塞进提示词，说出三个理由。
- [ ] 我能用"开卷考试"的比喻向完全不懂的人讲清 RAG 是什么。
- [ ] 我能画出 RAG 的离线建库和在线检索两个阶段的完整流程。
- [ ] 我能解释 `chunk_overlap`（`pipelines/llamaindex/config.py:90`）存在的必要性，并举出一个反例。
- [ ] 我能用"地图上的位置"解释 embedding，并说明余弦相似度比的是什么。
- [ ] 我能说出为什么换嵌入模型必须重建索引，以及不重建会出现什么现象。
- [ ] 我能解释混合检索（向量 + BM25）为什么在学术资料上特别重要。
- [ ] 我能打开 `deeptutor/services/rag/factory.py:120`，说出为什么 import 语句写在函数内部而不是文件顶部。
- [ ] 我能解释 `get_pipeline`（`factory.py:163`）为什么带自定义参数时要跳过缓存。
- [ ] 我能说出 `SmartRetriever`（`smart_retriever.py:12`）的三层机制：生成多查询、并行检索、汇总，以及它的降级策略。
- [ ] 遇到 RAG 效果差时，我知道要先检查检索结果本身，而不是先改提示词。
