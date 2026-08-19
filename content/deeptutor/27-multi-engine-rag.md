---
title: "第 27 章 · 多引擎知识库 RAG"
date: 2026-08-01
summary: "**黑话解释**：\"引擎（engine/pipeline）\"在这里指\"一套完整的建索引+检索流程\"。DeepTutor 称之为 `pipeline`（流水线），每个引擎就是一个 pipeline 类。"
tags:
  - deeptutor
---
# 第 27 章 · 多引擎知识库 RAG

"RAG"是这几年的热门词，但它的本质特别朴素：**让智能体在回答前，先去你给的文档里查资料，再基于查到的内容作答**。这样它能说出你文档里才有的内容，而不是凭空编。

本章我们看 DeepTutor 的 RAG 系统：它最大的特点不是"用了 RAG"，而是**同时支持多种检索引擎**，并且能按知识库的配置自动选对的那一个。代码在 `deeptutor/services/rag/`。

## 先懂直觉：为什么需要"多引擎"

不同的资料、不同的场景，适合不同的检索方式：

- 一份教材 PDF，本地就能建向量索引，离线也能查——用 **LlamaIndex**。
- 一个庞大的知识库，你想靠"实体关系图"来追根究底——用 **GraphRAG / LightRAG**。
- 你已经在腾讯 IMA 里整理好了资料，不想再搬一份——直接连 **IMA** 查。

如果一个产品只绑死一种引擎，遇到上述某类场景就抓瞎。DeepTutor 的做法是：**把"引擎"做成可插拔的模块，知识库在创建时选定一个，之后一直用它**。这就是"多引擎"。

> **黑话解释**："引擎（engine/pipeline）"在这里指"一套完整的建索引+检索流程"。DeepTutor 称之为 `pipeline`（流水线），每个引擎就是一个 pipeline 类。

## 引擎总览：factory 里有哪些可选

所有可选引擎都在 `deeptutor/services/rag/factory.py` 里定义。一个知识库在创建时绑定一个 `provider`（提供方）名称，之后所有的加文档、检索都走同一个 pipeline。这个约束在 `factory.py:21` 的注释里说得很清楚。

`factory.py` 里列出的引擎有（见 `deeptutor/services/rag/factory.py:30` 起的一串常量）：

- `llamaindex`（默认）：本地向量检索 + 混合 BM25 融合，开箱即用。
- `pageindex`：云端托管、无向量的"推理式"检索，需要 API key。
- `graphrag`：本地知识图谱检索，来自微软 GraphRAG（可选依赖）。
- `lightrag`：图谱 + 向量检索，来自港大 LightRAG（可选依赖）。
- `lightrag-server`：把检索外包给你自己跑的外部 LightRAG 服务，本地不建索引。
- `ima`：把检索外包给腾讯 IMA 知识库，本地不存副本。

这些引擎的描述清单由 `list_pipelines` 函数返回给前端做"引擎选择器"，见 `deeptutor/services/rag/factory.py:182`。你会看到每个引擎都标了 `configured`（是否可用）和 `requires_api_key`（要不要 key）。

> **提示 · 默认为什么是 LlamaIndex？**
>
> 因为其余几个要么要装额外包、要么要配 API key，只有 LlamaIndex 是"装上就能跑、不需要联网"的本地向量检索。所以代码把 `DEFAULT_PROVIDER = "llamaindex"` 设为兜底，见 `deeptutor/services/rag/factory.py:30`。即使配置里写了个不存在的引擎名，也会被 `normalize_provider_name` 拉回默认，见 `deeptutor/services/rag/factory.py:54`。

## 工厂模式：按名字造一个引擎

"工厂（factory）"是一种代码模式：你给它一个名字，它返回对应的对象，调用方不用知道具体类名。

`factory.py` 的 `get_pipeline` 就是工厂入口，见 `deeptutor/services/rag/factory.py:163`。它的逻辑是：

1. 用 `normalize_provider_name` 把名字归一化（未知→默认）。
2. 如果带自定义参数，就新建一个实例（不走缓存）。
3. 否则按 `(目录, 引擎)` 做缓存，同一个知识库复用同一份实例。

具体"造哪个类"的判断在 `_build_pipeline`，见 `deeptutor/services/rag/factory.py:120`：它根据 `provider` 字符串分别 `import` 对应的 pipeline 类并返回。比如 `llamaindex` 走到最后兜底分支，返回 `LlamaIndexPipeline`，见 `deeptutor/services/rag/factory.py:156`。

RAG 总服务 `RAGService` 把这套选择逻辑包了一层：它**每个知识库单独解析该用哪个引擎**，而不是全局固定一个。见 `deeptutor/services/rag/service.py:57` 的 `_resolve_provider`——它会读知识库的绑定配置（`resolve_bound_provider`），而不是构造函数写死的那个。

## 统一入口：RAGService.search

不管底层是哪个引擎，对外只有一个调用口：`RAGService.search`，定义在 `deeptutor/services/rag/service.py:84`。它做了几件事：

- 按知识库名解析出 `provider`；
- 拿到对应 pipeline，调用它的 `search`；
- 把返回结果统一成 `{answer / content / provider / query}` 形状，见 `deeptutor/services/rag/service.py:112`；
- 在结果里**强制写上真正用到的 provider**，因为服务层才是权威，见 `deeptutor/services/rag/service.py:120`；
- 顺手把这次查询记一笔 L1 痕迹（记忆系统），失败也不影响主流程，见 `deeptutor/services/rag/service.py:151`。

除了检索，`RAGService` 还负责知识库的"初始化"和"加文档"：`initialize` 见 `service.py:68`，`add_documents` 见 `service.py:74`（如果引擎不支持增量加文档，就退化为重新初始化）。

## LlamaIndex 引擎的内部：切块 → 向量化 → 检索

我们以默认引擎 LlamaIndex 为例，看一条文档从"原始文件"变成"可检索"的流水线。相关文件在 `deeptutor/services/rag/pipelines/llamaindex/`。

### 第一步：切块（ingestion，摄入）

长文档不能直接喂给模型，要先切成小段。DeepTutor 用 LlamaIndex 官方的 `IngestionPipeline`，在 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py:20` 的 `build_ingestion_pipeline` 里组装。它只做两件事：

- `SentenceSplitter`：按句子切，带一点重叠（chunk_overlap），避免切断语义。见 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py:30`。
- `Settings.embed_model`：把每段文字变成一串数字（向量）。这个 embed 模型其实是 DeepTutor 自己配置的 embedding 服务，不是本地小模型。见 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py:23` 的注释。

切完之后调用 `documents_to_nodes` 把文档变成"节点（node）"，见 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py:63`。这里有个细节：已经带好向量（比如图片节点）的文档会被跳过、不重复嵌入，见 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py:39` 的 `_has_precomputed_embedding`。

> **黑话解释**："向量（embedding）"就是把一段文字变成一长串数字，语义相近的文字，这串数字也相近。检索时比"数字距离"，就能找到意思最相关的段落。

### 第二步：建索引并落盘

`create_index_from_documents` 把节点建成 `VectorStoreIndex` 并存到磁盘，见 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py:82`。它优先用 FAISS（一种高效的向量检索库），否则退回 LlamaIndex 自带的简易存储——这个"有就用、没有就退"的注释在 `ingestion.py:88`。增量加文档则由 `insert_documents_into_index` 负责，见 `ingestion.py:99`。

### 第三步：检索配置（混合还是纯向量）

检索用纯向量还是"向量+BM25 混合"，由 `RetrievalConfig` 控制。这个配置类在 `deeptutor/services/rag/pipelines/llamaindex/config.py:13`，两个档位常量 `VECTOR_PROFILE`（纯向量）和 `HYBRID_PROFILE`（混合）定义在 `config.py:8` 和 `:9`。**默认就是混合档**，见 `config.py:17`。真正的配置从持久化设置里读，见 `config.py:58` 的 `retrieval_config_from_settings`；切块尺寸（chunk_size / chunk_overlap）的默认值也在这里，见 `config.py:85` 的 `chunk_geometry`。

### 第四步：混合检索（smart_retriever + 融合）

检索时 DeepTutor 不只"比向量"，还结合了 **BM25**（一种经典的关键词匹配算法）。两者融合的组装在 `deeptutor/services/rag/pipelines/llamaindex/retrievers.py:119` 的 `build_retriever`：

- 如果是纯向量模式，直接返回向量检索器；
- 如果是混合模式，则同时建一个 **BM25 检索器**和一个**向量检索器**，再交给 `QueryFusionRetriever` 用"倒数排名融合（RECIPROCAL_RANK）"合成结果，见 `deeptutor/services/rag/pipelines/llamaindex/retrievers.py:142`。

BM25 检索器的构建在 `build_bm25_retriever`，见 `retrievers.py:54`；它会把 BM25 索引也持久化到 `bm25_retriever` 子目录，见 `retrievers.py:23` 的 `BM25_PERSIST_DIRNAME`。

下面的缩进图说明了"混合检索"是怎么把两路结果合在一起的：

```text
用户提问
   │
   ├──────────────▶ 向量检索（语义相似）  ─┐
   │                                       │
   └──────────────▶ BM25 检索（关键词命中）┤
                                           ▼
                               QueryFusionRetriever
                          （倒数排名融合，去重排序）
                                           │
                                           ▼
                                     Top-K 相关段落
                                           │
                                           ▼
                              拼进提示词，交给模型作答
```

> **说明 · 为什么"混合"比单一好？**
>
> 向量检索懂"意思相近"，但可能漏掉"必须精确出现的关键词"（比如专有名词、公式编号）；BM25 正好擅长精确关键词匹配，却不懂同义词。两者融合，相当于"既懂你意思、又不放过关键词"，查得全也更准。代码里 BM25 还做了保护：当知识库太小（节点数少于 top_k）时会自动收紧，避免报错，见 `deeptutor/services/rag/pipelines/llamaindex/retrievers.py:57`。

## SmartRetriever：会"多问几个问题"的检索器

除了引擎内的混合检索，DeepTutor 还有一层更高层的检索助手 `SmartRetriever`，在 `deeptutor/services/rag/smart_retriever.py:12`。它做的事更"聪明"：

1. 拿到上下文后，**自动生成多个不同的检索问句**（而不是只用一个），见 `deeptutor/services/rag/smart_retriever.py:49` 的 `_generate_queries`。
2. 对每个问句并行去知识库检索，见 `deeptutor/services/rag/smart_retriever.py:26` 的 `asyncio.gather`。
3. 把多路结果**汇总成一段精简摘要**，见 `deeptutor/services/rag/smart_retriever.py:68` 的 `_aggregate`。

这一层相当于"让模型先帮你想清楚该查什么、再综合查到的东西"，对复杂问题尤其有帮助。

```text
SmartRetriever 工作流程
   上下文
     │
     ├─ 生成问句1 / 问句2 / 问句3（_generate_queries）
     │
     ├─ 并行检索（asyncio.gather）──▶ 多段 passage
     │
     └─ 汇总成摘要（_aggregate）──▶ 最终 answer
```

## 索引版本与"换引擎"的兼容（预告）

不同引擎对"索引失效"的处理不一样：LlamaIndex 的索引会跟着 embedding 模型版本走，而 GraphRAG / LightRAG 用的是各自合成的身份标记。代码里用 `provider_uses_embedding_versions` 来区分，见 `deeptutor/services/rag/factory.py:64`；判断"某版本是否真的属于某引擎"则用 `version_matches_provider`，见 `factory.py:76`。这部分（索引版本化）我们留到下一章专门讲。

## 切块与检索的"旋钮"从哪来

上一节提到切块尺寸和检索档位，它们不是写死在算法里的，而是从配置读取。集中在 `deeptutor/services/rag/pipelines/llamaindex/config.py`：

- `chunk_geometry()` 返回 `(chunk_size, chunk_overlap)` 的当前配置，默认 512 / 50，见 `config.py:85`；
- `retrieval_config_from_settings()` 从持久化设置读检索档位和倍数，读失败就退回默认，见 `config.py:58`；
- `default_top_k()` 是每次检索默认返回的段落数（默认 5），见 `config.py:77`。

这样用户在前端调"切块大小""是否混合检索"时，不需要改代码，只改设置即可。算法代码只调 `load_memory_settings()` 风格的读取函数。

## 向量索引怎么存

切好、向量化之后的节点，要建成索引并落盘。这在 `deeptutor/services/rag/pipelines/llamaindex/ingestion.py`：

- `create_index_from_documents` 把节点建成 `VectorStoreIndex` 并持久化到 `storage_dir`，见 `ingestion.py:82`；
- 它优先用 FAISS（高效向量库），否则退回 LlamaIndex 自带简易存储——"有就用、没有就退"的注释在 `ingestion.py:88`；
- 后续想往已有索引加文档，用 `insert_documents_into_index`，见 `ingestion.py:99`。

> 为什么强调"落盘"？模型每次回答都要现查索引，索引必须事先建好存在磁盘（或外部服务）里。用户上传 PDF 后那一段"正在建索引"的等待，就是在跑 `create_index_from_documents`。

## 检索结果如何回传与归一化

`RAGService.search` 不只是调一下 pipeline，还做了结果"整形"，保证上层拿到统一形状：

- 把返回统一成 `{answer / content / provider / query}`，缺失字段互相补，见 `deeptutor/services/rag/service.py:112`；
- 强制把真正用到的 `provider` 写回结果——因为"哪个引擎跑了"由服务层权威判定，见 `service.py:120`；
- 每次查询顺手记一笔 L1 痕迹（喂给记忆系统），失败也不影响主流程，见 `service.py:151`。

## 端到端：一次"问知识库"的完整链路

把本章所有零件串起来：

```text
用户问："第三章讲了什么？"
   │
   ▼
RAGService.search(kb_name=...)
   │  _resolve_provider → 该 KB 绑定的引擎
   ▼
get_pipeline(provider) → 对应 pipeline
   │
   ├─ ContextBuilder? 不，是 pipeline.search
   ▼
LlamaIndexPipeline.search
   ├─ 切块参数（config.chunk_geometry）
   ├─ 向量检索 + BM25 检索（retrievers.build_retriever）
   ├─ QueryFusionRetriever 融合（RECIPROCAL_RANK）
   ▼
Top-K 段落 → 拼进提示词 → 模型作答
   │
   ▼
service.py 整形结果 + 记 L1 痕迹 → 返回前端
```

> **说明 · 小结：多引擎带来的好处**
>
> 同一套 `RAGService.search` 接口，背后可以是 LlamaIndex、GraphRAG、LightRAG、IMA、PageIndex 中任意一个。这意味着：(1) 用户能为不同知识库挑最合适的引擎；(2) 后端新增一种引擎，只需在 `factory.py` 注册、实现 `detect/search` 两个方法，上层代码几乎不动；(3) 检索档位、切块大小等都可配置，不写死。这就是"可插拔"的工程价值。

## 检索档位：纯向量 vs 混合

检索用哪种方式，由 `RetrievalConfig` 的 `profile` 字段决定，可选值只有两个：`vector`（纯向量）和 `hybrid`（混合），见 `deeptutor/services/rag/pipelines/llamaindex/config.py:8` 和 `:9`。它们被收进 `SUPPORTED_RETRIEVAL_PROFILES` 集合（见 `:10`）。

默认就是 `hybrid`，见 `config.py:17`——也就是说，开箱即用的 DeepTutor 就是"向量 + BM25 融合"。`RetrievalConfig` 还有个 `candidate_top_k` 方法（见 `:22`），决定给子检索器"多要一些候选"的倍数（默认向量、BM25 各取 2 倍 top_k），再让融合器收敛到最终 top_k。这样融合前有更丰富的候选，融合后质量更高。

## BM25 检索器的细节与持久化

`build_retriever` 在混合模式下会构造一个 BM25 检索器，相关逻辑在 `deeptutor/services/rag/pipelines/llamaindex/retrievers.py`：

- `build_bm25_retriever` 负责构建或加载 BM25 检索器，见 `retrievers.py:54`；
- 它有个保护：当知识库太小（节点数 < top_k）时自动把 top_k 收紧到节点数，避免 BM25 因"要的太多"而崩溃，见 `retrievers.py:57` 的注释；
- BM25 索引可以持久化到 `bm25_retriever` 子目录（常量 `BM25_PERSIST_DIRNAME`，见 `retrievers.py:23`），`persist_bm25_retriever` 负责落盘（见 `:86`），下次直接 `from_persist_dir` 加载，省去重建。

下面是"向量 + BM25 两路候选如何汇聚"的细化图：

```text
query
  │
  ├─ 向量检索器（as_retriever, similarity_top_k = 2×top_k）
  │       候选 A1, A2, A3 ...
  │
  ├─ BM25 检索器（similarity_top_k = 2×top_k）
  │       候选 B1, B2, B3 ...
  │
  ▼
QueryFusionRetriever（MockLLM + RECIPROCAL_RANK）
  把两路按倒数排名融合、去重
  │
  ▼
最终 Top-K（比如 5 段）相关段落
```

> **提示 · 为什么融合用的是 MockLLM？**
>
> `QueryFusionRetriever` 在某些模式下会用 LLM 生成多条"改写问句"再检索，但 DeepTutor 这里把它设成 `MockLLM`（见 `retrievers.py:144`）。原因在 `config.py:63` 的注释里说得很清楚：融合检索本身跑在 MockLLM 上、**不需要真模型**，而"生成改写问句"才需要真 LLM——那是 `SmartRetriever` 那层做的事（见本章第四节）。分工明确，各司其职。

## 周边支撑模块（一句话带过）

除了引擎和融合，RAG 还有几块支撑代码，服务于"把文档安全变成可检索索引"：

- `deeptutor/services/rag/file_routing.py`：按文件类型决定如何切分与加载；
- `deeptutor/services/rag/preflight.py`：建索引前的环境/依赖检查；
- `deeptutor/services/rag/linked_kb.py` 与 `kb_paths.py`：已关联/链接知识库的路径与绑定解析；
- `deeptutor/services/rag/service.py`：统一的检索入口（本章第三节讲过）。

它们都挂在 `factory.get_pipeline` 这条主链上，让"多引擎"不只是口号，而是真有一条清晰、可插拔的代码路径。

## 一个具体例子：混合检索怎么帮到你

假设你问："牛顿-莱布尼茨公式是什么？"

- 纯向量检索可能找回"积分基本定理"那段——因为它语义相近；
- BM25 可能精确命中包含"牛顿-莱布尼茨"这几个字的小节——因为关键词匹配；
- 融合后，你既拿到"意思对"的段落，也不漏掉"名字精确出现"的那段。

如果只用向量，专有名词小节可能被语义相近但名字不同的段落挤掉；如果只用 BM25，又可能漏掉换了个说法的等价讲解。两者融合，才最稳。

## 引擎描述从哪来（给前端选择器用）

前端那个"知识库引擎选择器"要显示每种引擎的名字、说明、是否可用，`list_pipelines` 就是数据源，见 `deeptutor/services/rag/factory.py:182`。它返回一个列表，每项含 `id`（引擎名）、`name`、`description`、`configured`（是否就绪）、`requires_api_key`（要不要 key）等字段，见 `factory.py:217` 起的返回结构。

注意它还会去探测各可选引擎"装没装好"——比如 GraphRAG 要 `pip install 'deeptutor[graphrag]'` 才 `configured=True`（见 `factory.py:194` 的 `is_graphrag_available`），LightRAG 同理（见 `:203`）。装都没装，选择器上就灰掉，避免用户选了却建不成。

## 其他引擎一瞥（为什么需要它们）

前面聚焦 LlamaIndex，但另几种引擎各有不可替代的场景：

- **GraphRAG / LightRAG**：当你的知识库是"实体关系密集"的（比如一整套法律条文、一张知识图谱），纯向量检索答不好"X 和 Y 有什么关系"这类问题。图检索能沿关系跳，更适合"全局性 / 多跳"问答。
- **PageIndex**：你不想在本地建索引、也不想搬文档，直接用云端托管的"推理式"检索，适合轻量、随用随查。
- **IMA / LightRAG Server**：资料已经在别处（腾讯 IMA、你自跑的 LightRAG 服务），DeepTutor 只做"查询代理"，本地零索引。

这就是为什么"多引擎"不是炫技，而是"不同资料、不同场景、该用不同检索"的务实选择（呼应 `factory.py:21` 的约束说明）。

## 检索结果的"来源标注"

`RAGService.search` 返回的结果里，`provider` 字段被强制写成真实跑过的引擎（见 `service.py:120`），而 `content` / `answer` 互相补齐（见 `service.py:112`）。更重要的是：检索到的内容通常会带上"来自哪段、哪个知识库"的来源信息，前端据此渲染"引用来源"卡片。这样用户不只看到答案，还能点开"依据是什么"。

> **说明 · 给想深入源码的人的阅读顺序**
>
> 建议：`factory.py`（引擎注册与选择）→ `service.py`（统一入口 search）→ `pipelines/llamaindex/ingestion.py`（切块+向量化）→ `pipelines/llamaindex/retrievers.py`（混合检索）→ `smart_retriever.py`（多问句+汇总）→ 其他引擎的 `pipelines/<引擎>/pipeline.py`。顺着"建索引→检索→融合"这条线读，RAG 全貌就清楚了。

## 自查清单

- [ ] 我能用自己的话解释 RAG 是"先查资料再作答"，并说出它为什么能避免编造。
- [ ] 我能列出 DeepTutor 支持的至少 4 种 RAG 引擎，并说清各自的适用场景（factory.py:30）。
- [ ] 我理解"工厂模式"：给名字、返对象，调用方不用关心具体类名（factory.py:163）。
- [ ] 我知道 RAGService 为什么是"每个知识库单独解析引擎"，而不是全局固定（service.py:57）。
- [ ] 我能说出切块 → 向量化 → 建索引 → 混合检索这条流水线，并指出 ingestion.py 的对应函数（ingestion.py:82）。
- [ ] 我理解"混合检索"= 向量 + BM25，以及融合用的是什么算法（retrievers.py:142）。
- [ ] 我知道检索档位"纯向量/混合"由 RetrievalConfig 控制、默认混合（config.py:9/17）。
- [ ] 我能解释 SmartRetriever 比普通检索多做了哪两步（多问句 + 汇总）（smart_retriever.py:49/68）。
- [ ] 我知道为什么默认引擎是 LlamaIndex 而不是 GraphRAG（factory.py:30）。
