---
title: "第 28 章 · 索引版本化与 KB 管理"
date: 2026-08-01
summary: "**黑话解释**：\"embedding 维度\"指向量这串数字的长度（比如 1536 维）。同一个模型，维度必须一致，向量才有可比性。换模型常常连带换维度，这就是最常见的\"错配\"来源。"
tags:
  - deeptutor
---
# 第 28 章 · 索引版本化与 KB 管理

上一章我们讲到：文档被切块、向量化，建成一个"索引"，之后检索就查这个索引。但有个麻烦事没人愿意明说：**索引是会"过期"的**。你换了 embedding 模型、改了切分参数，旧索引查出来的东西就和新模型对不上了。

本章讲 DeepTutor 怎么用"索引版本化"来防止这种错配（mismatch），以及知识库从创建到加文档的完整生命周期。代码核心在 `deeptutor/services/rag/index_versioning.py` 和 `deeptutor/services/rag/embedding_signature.py`，业务侧在 `deeptutor/knowledge/`。

## 先懂直觉：索引为什么会"失效"

打个比方：你把一柜子书按"颜色"分类贴了标签。后来你换了分类规则，改成按"作者姓氏"。旧标签没撕，新书按新规则放——结果有人按旧标签找书，找到的全是错的。

向量索引正是这样：

- 索引里的每个段落，都带着"用某个 embedding 模型算出来的向量"。
- 如果你把 embedding 模型换了（或升级了、改了维度），**同一段文字算出的向量就变了**。
- 旧索引里的向量和新模型"说不同的语言"，检索时自然对不上，严重时整库静默失效。

> **黑话解释**："embedding 维度"指向量这串数字的长度（比如 1536 维）。同一个模型，维度必须一致，向量才有可比性。换模型常常连带换维度，这就是最常见的"错配"来源。

## 解决方案一：给每次索引打"签名"

DeepTutor 的思路是：给当前的 embedding 配置算一个**稳定指纹（signature）**，写进索引的元信息里。检索时，先比对"当前模型的指纹"和"索引自带的指纹"是否一致，不一致就判定索引失效。

这个指纹的数据结构叫 `EmbeddingSignature`，定义在 `deeptutor/services/rag/index_versioning.py:46`。它包含 5 个字段：

- `binding`：用哪个 embedding 绑定（服务商标识）
- `model`：具体模型名
- `dimension`：向量维度
- `base_url`：服务地址
- `api_version`：API 版本

把这几个字段拼成一个规范化字符串，再做一次 SHA-256 哈希，取前 16 位当"签名"。见 `deeptutor/services/rag/index_versioning.py:56` 的 `hash` 方法。

> **提示 · 为什么用哈希而不是直接比字符串？**
>
> 把 5 个字段 `json.dumps(sort_keys=True)` 后再哈希，能保证"字段一样 → 签名一样"，而且签名是个固定长度的短串，方便当文件名、做快速比对。哪怕模型名很长，签名也就 16 个字符。见 `deeptutor/services/rag/index_versioning.py:58`。

真正从"配置对象"算出这个签名的逻辑在 `deeptutor/services/rag/embedding_signature.py:13` 的 `signature_from_config`——它把配置里的 binding / model / dim / base_url / api_version 抠出来，填进 `EmbeddingSignature`。`signature_from_embedding_config`（见 `embedding_signature.py:26`）则更进一步：直接去拿"当前正在用的 embedding 配置"，算出它的签名。

## 解决方案二：版本目录 + 按签名选版本

为了支持"换模型后旧索引留着、新索引另建"，DeepTutor 把每个知识库的索引放进带编号的目录：

```text
data/knowledge_bases/<kb名>/
    raw/                  # 原始文件，原封不动
    version-1/            # 第 1 版索引（LlamaIndex 存储文件直接放这）
        docstore.json
        index_store.json
        default__vector_store.json
        meta.json         # {"version", "signature", "model", ...}
    version-2/            # 第 2 版索引（换模型/参数后新建）
    metadata.json         # 知识库总配置
```

目录布局定义在 `deeptutor/services/rag/index_versioning.py:1` 开头的注释里。注意新写入都走扁平的 `version-N` 目录（前缀 `version-` 见 `index_versioning.py:38`，正则见 `:43`），老式的嵌套目录（`index_versions/<签名>/`）只为兼容旧库保留，见 `index_versioning.py:18` 的说明。

几个关键函数：

- `list_kb_versions`：列出一个知识库的所有索引版本，新的排前面，见 `index_versioning.py:168`。它会同时照顾扁平版、旧嵌套版、根目录旧版三种布局。
- `find_matching_version`：在版本清单里找一个**签名匹配且已就绪**的版本，见 `index_versioning.py:222`。优先返回扁平版。
- `resolve_storage_dir_for_read`：检索时该读哪个目录——用当前签名去匹配，匹配不到就退回最新的就绪版本或旧版，见 `index_versioning.py:280`。
- `resolve_storage_dir_for_write`：写入时用哪个目录——复用匹配签名的扁平版，没有就开下一个编号，见 `index_versioning.py:300`。

下面是"检索前如何选对索引版本"的判定流：

```text
拿到当前 embedding 配置 → 算出 signature
        │
        ▼
在 version-1 / version-2 / ... 里找
   signature 匹配且 ready 的版本？
        │
   ┌────┴────┐
   是          否（无匹配版本）
   │            │
   ▼            ▼
读该版本      标记 needs_reindex=True
（正常检索）   （提示用户"重建索引"）
```

## 重建时为何不覆盖旧版

一个容易踩的坑：如果你在重建索引过程中，先把旧索引覆盖掉了，中途失败，就**两头落空**——新索引没建成，旧的也没了。

DeepTutor 用 `resolve_storage_dir_for_rebuild` 避开这个坑：重建时永远开一个**全新的 `version-N` 目录**，等新的索引完整落盘后，旧版才自然被取代。见 `deeptutor/services/rag/index_versioning.py:315` 的注释——它明确说"保留旧版本便于诊断失败、避免留下过期向量文件"。

## 版本存得"就绪"才算数

光有目录还不够，得确认索引真的建好了。`_is_storage_ready` 判断一个存储目录是否就绪：目录存在、且除了 `meta.json` 之外还有其他文件（见 `index_versioning.py:79`）。`meta.json` 里写着的版本信息由 `write_version_meta` 落盘，见 `index_versioning.py:263`。

## 探针：让各引擎自己说"我好了没"

DeepTutor 不直接去猜某个引擎的索引长什么样，而是通过一个"探针"模块向引擎本身问话。`index_probe.py` 就是这条只读的接缝：它问"这个引擎的索引真的能查吗"，拿回结构化结论，而调用方不必知道各引擎的文件细节。模块说明见 `deeptutor/services/rag/index_probe.py:1`。

- `ProviderIndexProbe`：一次探测的结论（provider / storage_dir / ready / 失败摘要 / 文档数），见 `index_probe.py:27`。
- `inspect_provider_index`：按 provider 分发到各自的探测实现，见 `index_probe.py:38`。
- `inspect_provider_version`：探测某个版本条目是否就绪，见 `index_probe.py:55`。KB 管理器判断 `needs_reindex` 时就用到了它（见 `manager.py:189`）。

## KB 管理器：谁来判定"该重建了"

签名比对和版本选择是底层工具，真正在每次列知识库时做"体检"的，是 `KnowledgeBaseManager`。它有个方法 `_reconcile_embedding_flags`，遍历所有知识库，检查它们的索引跟当前模型还配不配。方法名见 `deeptutor/knowledge/manager.py:142`，逻辑大致是：

- 对每个知识库，用 `find_matching_version` 找匹配当前签名的就绪版本（见 `manager.py:186`）；
- 找到了 → 清除 `needs_reindex` 和 `embedding_mismatch` 两个标记（说明你切回了之前索引过的配置）；
- 找不到、但库里存着不同的 `embedding_model` → 把两个标记都打上，让界面弹出"重建索引"按钮（见 `manager.py:232` 起，最终 `needs_reindex=True` 在 `:235`）；
- 特别地：GraphRAG / LightRAG 这类引擎**不走 embedding 版本**（它们用合成身份标记），所以代码用 `provider_uses_embedding_versions` 提前跳过、不会误判，见 `manager.py:164` 和 `factory.py:64`。

> **黑话解释**：`needs_reindex` 是知识库配置里的一个布尔标记，意思是"当前索引已经跟模型不匹配，需要重建"。`embedding_mismatch` 则更具体，表示"embedding 模型确实变了"。两者会让前端显示提醒。两个标记的判断细节在 `manager.py:209` 起的 `mismatch` 计算里。

管理器类本身定义在 `deeptutor/knowledge/manager.py:244`，构造时确定知识库根目录（见 `:247`）。

## KB 的生命周期：创建 → 加文档

### 创建（initializer）

知识库创建时，会先把引擎（provider）固定下来并写进配置，再建目录、拷原始文件、调引擎处理。核心类在 `deeptutor/knowledge/initializer.py`：

- 构造时就把 `rag_provider` 归一化存好（见 `initializer.py:48`）；
- `_register_to_config` / `set_rag_provider` 把引擎写进中心化配置（见 `initializer.py:50`、`:104`）；
- `create_directory_structure` 建好 `raw/`、`metadata.json` 等骨架，见 `initializer.py:109`；
- `copy_documents` 把源文件复制到 `raw/`，见 `initializer.py:131`；
- `process_documents` 用绑定引擎真正建索引，见 `initializer.py:144`。

### 加文档（add_documents）

之后想往库里继续塞文件，走 `deeptutor/knowledge/add_documents.py`：

- `add_documents` 先校验文件、按**内容哈希**去重（同一份内容不会重复索引），再复制到 `raw/`，见 `add_documents.py:216`（哈希判断在 `:229`）；
- `process_new_documents` 调 `RAGService` 对这批新文件建/增量索引，见 `add_documents.py:258`；
- 成功后把 `needs_reindex` 标记为 False，见 `add_documents.py:317`。

> **说明 · 一个库只绑一个引擎，为什么？**
>
> 因为不同引擎建的索引格式完全不同（向量库、图数据库、外部服务指针……），混用会读坏。所以"知识库创建时选定引擎，之后加文档和检索都走同一个"是硬约束，写死在 `factory.py:21` 的注释里。想换引擎？只能新建一个知识库。这也是为什么索引版本化要按 `provider` 区分——`version_matches_provider`（见 `factory.py:76`）会确保某版本确实属于你指定的引擎，避免 LlamaIndex 的版本被误当成 PageIndex 的。

## 跨引擎的"合成签名"

对于 GraphRAG / LightRAG 这类不走 embedding 版本的引擎，它们的"签名"是合成出来的（就是 `graphrag` / `lightrag` 这几个字）。建索引时，DeepTutor 仍会把 embedding 身份额外盖进 `meta.json`，字段名是 `embedding_signature` / `embedding_model` / `embedding_dim`。见 `deeptutor/services/rag/embedding_signature.py:40` 的 `embedding_meta_fields`。这是因为：即使图引擎主流程不用 embedding 版本，它底层仍可能依赖某个 embedding 模型；不记录的话，错配时会"静默失败"（查不出东西但不报错）。

## 知识库管理器里的"身份"辅助函数

`_reconcile_embedding_flags` 之外，`KnowledgeBaseManager` 还准备了一些小帮手，用来从版本信息反推"这库到底用哪个引擎"：

- `_provider_from_version_entry`：从一个版本条目里读出 provider（未知就退回默认），见 `deeptutor/knowledge/manager.py:76`；
- `_detect_provider_from_versions`：扫一遍所有版本，只要有一个非默认的就认定是该引擎，见 `manager.py:84`；
- `_get_embedding_fingerprint`：取出当前 embedding 配置的 `(model_name, dimension)`，见 `manager.py:117`。

这些函数让管理器在"没显式记录引擎"的旧库上也能推断出正确身份，避免误判版本。

## 知识库的总配置与孤儿清理

管理器类 `KnowledgeBaseManager` 本身在 `deeptutor/knowledge/manager.py:244`，构造时确定知识库根目录（见 `:247`）。它还有一个细节：`_ORPHAN_PRUNE_GRACE_SECONDS = 60`（见 `manager.py:55`）——创建知识库时先写一条"初始化中"的配置，过一会儿才有真实目录；如果列表接口在创建途中就把这条"还没目录"的记录当垃圾删了，就会竞态出错。60 秒宽限期给了创建握手足够时间，又不会让多日的僵尸库赖着不走。

## 初始化时如何写下"引擎"与"签名"

回到创建流程，引擎和签名是**当时**就固化进配置的：

- `initializer.py` 构造时把 `rag_provider` 归一化保存（见 `initializer.py:48`）；
- 把引擎写进中心化配置：`set_rag_provider`（见 `initializer.py:104`）和 `_update_metadata_with_provider`（见 `:89`）；
- 加文档成功后把 `needs_reindex` 清掉（见 `deeptutor/knowledge/add_documents.py:317`）；
- 底层建索引时，`write_version_meta` 会把签名写进 `meta.json`（见 `index_versioning.py:263`），而 `embedding_meta_fields`（见 `embedding_signature.py:40`）额外补 `embedding_signature/model/dim` 字段，供图引擎将来核对。

## 端到端：创建 → 加文档 → 检索的"版本闭环"

把本章所有零件串起来，看一个索引怎么从生到熟、又怎么防止错配：

```text
创建 KB（initializer）
   │  绑定 provider，写进配置
   ▼
加文档（add_documents）
   │  按内容哈希去重 → 复制 raw/ → RAGService 建索引
   ▼
建索引（ingestion / pipeline）
   │  write_version_meta 写入 signature → version-N/meta.json
   ▼
每次列 KB（manager._reconcile_embedding_flags）
   │  用当前签名 find_matching_version？
   ├─ 有 → 清除 needs_reindex（健康）
   └─ 无 → 打 embedding_mismatch + needs_reindex（提示重建）
   ▼
检索（service.search → pipeline.search）
   │  resolve_storage_dir_for_read 选对就绪版本
   ▼
正常返回 / 或提示"请重建索引"
```

> **说明 · 周边支撑模块（一句话带过）**
>
> 除了正文讲到的，索引与 KB 管理还有几块支撑代码：`deeptutor/services/rag/file_routing.py`（按文件类型决定怎么切）、`preflight.py`（建索引前的环境检查）、`linked_kb.py` 与 `kb_paths.py`（已关联/链接知识库的路径与绑定）、`deeptutor/knowledge/manifest.py` 与 `kb_types.py`（知识库清单与类型定义）。它们都服务于"把一份文档安全、可追溯地变成可检索索引"这条主线，本章聚焦的是其中最容易出错的"版本与错配"环节。

## 版本清单怎么列出来

知识库页面要显示"你有哪些索引版本、哪个就绪"，靠 `list_kb_versions`。它遍历三种布局（扁平 `version-N`、旧嵌套 `index_versions/<签名>`、根目录旧版），统一返回，见 `deeptutor/services/rag/index_versioning.py:168`。配套还有几个"查找"辅助：

- `_find_flat_version_by_signature`：在扁平版里按签名找（可要求就绪），见 `index_versioning.py:193`；
- `_latest_ready_flat_version`：找最新的就绪扁平版，见 `index_versioning.py:207`；
- `read_version_meta`：按签名读某个版本的元信息，见 `index_versioning.py:214`。

这些函数共同回答两个问题："有没有跟我当前模型匹配的就绪索引？"和"如果有，它在哪个目录？"——这正是检索和重建决策的依据。

## 写入版本的元信息长什么样

建好索引后，`write_version_meta` 会在存储目录旁写一份 `meta.json`，见 `deeptutor/services/rag/index_versioning.py:263`。它记录的字段（见 `:269` 的 payload）包括：

- `version`：目录名（如 `version-2`）；
- `signature`：当前 embedding 配置的签名哈希；
- `binding / model / dimension / base_url / api_version`：签名的 5 个原始字段，原样存一份，便于人读；
- `layout`：扁平还是旧嵌套；
- `created_at`：建索引的时间。

正是这份 `meta.json` 让"检索前比对签名"成为可能——`resolve_storage_dir_for_read`（见 `:280`）就是先读这份元信息、再决定读哪个目录。

## 探针模块：让各引擎自己说"我好了没"

前面多处提到"就绪（ready）"判断，但不同引擎的索引文件长得完全不同。DeepTutor 不自己去猜，而是通过一个"探针"模块向引擎本身问话。代码在 `deeptutor/services/rag/index_probe.py`，模块定位写在 `:1`：

- `ProviderIndexProbe`：一次探测的结构化结论（provider / 存储目录 / 是否就绪 / 失败摘要 / 文档数），见 `index_probe.py:27`；
- `inspect_provider_index`：按 provider 分发到各自的探测实现，见 `index_probe.py:38`；
- `inspect_provider_version`：探测某个版本条目是否就绪，见 `index_probe.py:55`。

KB 管理器在判断 `needs_reindex` 时调用 `inspect_provider_version`（见 `manager.py:189`），确认"那个签名匹配的版本到底真能查吗"。如果探针说"不就绪"，即使签名对上也不算数。

## 一个具体例子：换模型之后

把"版本化防错配"放在真实流程里看：

```text
初始：用模型 A 建了 math-kb 的索引
   → version-1/meta.json 里 signature = hash(A 的配置)

某天：用户在设置里把 embedding 换成模型 B
   → 当前签名 = hash(B 的配置) ≠ version-1 的签名
   → 列 KB 时 _reconcile_embedding_flags 找不到匹配就绪版
   → 打 embedding_mismatch + needs_reindex
   → 前端弹出"重建索引"按钮

用户点重建：
   → resolve_storage_dir_for_rebuild 开 version-2（不动 version-1）
   → 用模型 B 重新建索引，写 version-2/meta.json(signature=hash(B))
   → 重建成功，version-1 自然被取代
   → 下次列 KB：匹配到 version-2，清除 needs_reindex
```

注意整个过程**不会丢失旧索引**——除非新索引完整建好，旧版一直留着。这正是 `resolve_storage_dir_for_rebuild` 开新目录的设计意图（见 `index_versioning.py:315`）。

## 知识库清单与状态查询

管理器除了"体检"，还提供查询接口给前端列库、看状态：

- `get_kb_entry(name)`：取单个知识库的配置，见 `deeptutor/knowledge/manager.py:491`；
- `get_kb_status(name)`：取单个库的状态（含 `needs_reindex` 等），见 `manager.py:503`；
- `list_knowledge_bases()`：列出所有库名，见 `manager.py:515`。

这些接口返回的字典里就含 `needs_reindex`、`embedding_mismatch`、`index_versions` 等字段（在 `_reconcile_embedding_flags` 里被填充，见 `manager.py:370`、`:235`）。前端据此决定显示"健康""需重建"还是"索引不匹配"。

## 加文档的幂等与去重

往已有知识库加文件时，DeepTutor 做了两道防护，避免重复和混乱：

- **内容去重**：`add_documents` 先算每个文件的内容哈希，已索引过的直接跳过（除非显式允许重复），见 `deeptutor/knowledge/add_documents.py:216`，哈希判断在 `:229`；
- **保留目录结构**：如果用户上传的是带文件夹的结构，`raw/` 里原样保留子目录，不拍平，见 `add_documents.py:234` 的注释；
- **成功后清标记**：建索引成功才把 `needs_reindex` 置 False，见 `add_documents.py:317`。

这保证了"反复上传同一份 PDF"不会在索引里产生一堆重复段落，也不会因为一次失败就让库永远卡在"需重建"。

## 初始化流程再细化

把 `initializer.py` 的创建步骤按时间线排一遍：

```text
1. 归一化 rag_provider（initializer.py:48）
2. 建目录骨架 create_directory_structure（:109）
3. 写引擎进中心化配置 set_rag_provider（:104）
4. 复制源文件到 raw/ copy_documents（:131）
5. 用绑定引擎建索引 process_documents（:144）
6. 建好后回写 provider 元数据 _update_metadata_with_provider（:89）
```

每一步失败都有对应处理：目录建不成、文件拷不上、索引建不出，都会反映到 KB 状态里，前端能显示具体卡在哪。

## 设计哲学

索引版本化想解决的，其实是一个朴素却被很多人忽视的问题：**"索引"不是一次建好就永久有效的，它和"当时用的模型/参数"绑定**。DeepTutor 的做法可以浓缩成三句话：

1. **给配置算签名**：embedding 的 5 个字段 → 哈希签名，写进 `meta.json`。
2. **按签名选版本**：检索前比对当前签名，匹配才用，不匹配就提示重建。
3. **重建不覆盖**：新索引开新目录，旧索引留着，失败可诊断、不丢数据。

这比"换模型后默默用旧索引、查出来一堆错"要稳妥得多，也体现了"用工程手段预防错配"的思路。

> **提示 · 给想深入源码的人的阅读顺序**
>
> `embedding_signature.py`（签名怎么算）→ `index_versioning.py`（版本目录与匹配）→ `index_probe.py`（就绪探测）→ `knowledge/manager.py:_reconcile_embedding_flags`（列库体检）→ `knowledge/initializer.py` + `add_documents.py`（创建与加文档）。顺着"签名→版本→探测→体检→生命周期"这条线，KB 管理就通了。

## 自查清单

- [ ] 我能用自己的话解释"索引为什么会随模型/切分参数变化而失效"。
- [ ] 我知道 EmbeddingSignature 由哪 5 个字段组成（index_versioning.py:46）。
- [ ] 我理解"签名"是怎么算出来的、为什么用哈希（index_versioning.py:56）。
- [ ] 我能说出扁平版 `version-N` 目录的布局，以及 meta.json 里放什么（index_versioning.py:1）。
- [ ] 我理解检索前如何用当前签名去匹配就绪版本、匹配不到就标记 needs_reindex（index_versioning.py:222/280）。
- [ ] 我知道为什么重建索引要新建目录、不覆盖旧版（index_versioning.py:315）。
- [ ] 我能说出 KB 管理器在列库时做"体检"的大致逻辑（manager.py:142）。
- [ ] 我理解索引"就绪（ready）"由什么判定（index_versioning.py:79），以及探针模块做什么（index_probe.py:1）。
- [ ] 我理解"一个知识库只绑一个引擎"的原因，以及 GraphRAG 为何用合成签名（factory.py:21/76）。
