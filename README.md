# dsh-memory · 仿人记忆库（DeepSeek Harness 插件）

> 让 agent 拥有「像人一样」的长期记忆：会遗忘、会巩固、会被线索唤起、会分区隔离——而且所有数据只留在你自己的机器上。

零外部依赖 · 纯本地 · MIT

---

## 目录

- [为什么做这个](#为什么做这个)
- [核心特性](#核心特性)
- [安装](#安装)
- [配置](#配置)
- [工具手册](#工具手册)
- [数据存在哪](#数据存在哪)
- [工作原理](#工作原理)
- [使用示例](#使用示例)
- [隐私与安全](#隐私与安全)
- [常见问题](#常见问题)
- [目录结构](#目录结构)
- [路线图](#路线图)
- [License](#license)

---

## 为什么做这个

大多数 agent 的「记忆」是：

- 一个向量数据库（只能相似检索，不会遗忘、不会巩固）
- 或者一段不断增长的对话历史（上下文一满就全丢）
- 或者一个 key-value 表（没有强弱、没有时间感）

人类记忆不是这样工作的。人脑会：

1. **遗忘**：不常用的记忆逐渐变淡
2. **巩固**：重复出现的事情从「经历」变成「常识」
3. **提取强化**：想起来一次，下次更容易想起来
4. **线索依赖**：看到相关的东西才想起，而不是精确查询
5. **分区**：有些事是「我是谁」，有些是「关于某个人」，有些是「不能说的」

`dsh-memory` 把这五件事做成了可运行的代码。

## 核心特性

| 特性 | 说明 |
|---|---|
| **艾宾浩斯遗忘** | 每条记忆有强度，按指数曲线衰减；重要、带情绪的记忆衰减更慢 |
| **提取强化** | 被回忆一次，强度回补一点（用进废退） |
| **睡眠巩固** | 把同类情节记忆合并、去重，升格为长期语义记忆 |
| **线索依赖召回** | IDF 加权特征重叠 + 强度/近因/重要度综合打分，不是精确匹配 |
| **记忆分区** | 自我 / 关系 / 情节 / 语义 / 生活 / 学习 / 隔离，七个区各有衰减与隐私策略 |
| **哈希链审计** | 每次写入/更新/遗忘追加一条 Ed25519 签名事件，可校验记忆是否被篡改 |
| **工作记忆** | 最近消息的环形缓冲，过期自动丢弃，不污染长期记忆 |
| **可选模块** | 情绪状态、性格成长、人物画像、学习库、语义向量、联想图 |

## 安装

### 方式一：作为 DSH bundle 安装（推荐）

```text
plugin_manager(action: "install_bundle", target: "<绝对路径>/dsh-memory-plugin")
```

安装后重启 DSH，agent 会获得 7 个记忆工具。

### 方式二：手动放进 profile

1. 把仓库目录加入 profile 的 bundle 列表
2. 在 `cordis.patch.yml` 中启用 `memory` 行（见仓库自带的 patch）
3. 重启 DSH

### 环境要求

- Node.js >= 20
- 无第三方 npm 依赖

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        memory:
          dataDir: ''          # 留空 = ~/.dsh/qq-memory
          maxItems: 20000      # 容量上限，超出按强度淘汰
          recallLimit: 8       # 默认召回条数
          includeVault: false  # 默认不读取隔离区
```

环境变量 `MEMORY_DIR` 可覆盖 `dataDir`。

## 工具手册

### `memory_remember`

写入一条长期记忆。

| 参数 | 类型 | 说明 |
|---|---|---|
| `text` | string | 必填，要记住的内容（≤4000 字） |
| `kind` | `episodic` / `semantic` | 具体经历 / 长期事实，默认 episodic |
| `importance` | 0~1 | 重要度，默认 0.5 |
| `emotion` | 0~1 | 情绪强度，默认 0 |
| `tags` | string[] | 标签，如 `["profile","person:alice"]` |
| `zone` | 枚举 | 分区，不填自动推断 |
| `chat` | string | 来源会话标识（可选） |

### `memory_recall`

按线索回忆。

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 必填，自然语言线索 |
| `limit` | 1~50 | 返回条数，默认 8 |
| `zone` | 枚举 | 只在这个分区回忆 |
| `include_vault` | boolean | 是否允许读隔离区，默认 false |
| `include_archived` | boolean | 是否包含已归档 |

返回每条记忆的 `id / text / score / kind / zone / importance / createdAt`。

### `memory_stats`

记忆库统计：总数、活跃/归档、类型分布、平均强度、性格阶段（若启用）。

### `memory_zones`

分区统计：每个区有多少条活跃记忆 + 分区中文名。

### `memory_forget`

软删除一条记忆（`state=purged`，哈希链留痕，不物理删文件）。

### `memory_consolidate`

睡眠巩固：聚类合并同类情节、去重、把高价值记忆升格为语义记忆。建议空闲时调用。

### `memory_chain_verify`

校验哈希链：seq 连续性、prevHash 衔接、Ed25519 签名，以及与 `memory.json` 的逐条对账。

## 数据存在哪

全部在 `dataDir`（默认 `~/.dsh/qq-memory/`）：

```
memory.json                记忆数据
memory-chain.jsonl         哈希链事件（追加写）
memory-chain-key.pem       Ed25519 私钥（务必备份）
memory-chain-pub.pem       公钥
memory-chain-head.json     链头快照
emotion-state.json         情绪状态（可选）
personality.json           性格阶段/成长值（可选）
profiles.json              人物画像（可选）
learning.json              学习库（可选）
memory-vectors.bin         向量索引（可选）
memory-vectors-ids.jsonl   向量↔记忆映射（可选）
memory-graph.jsonl         联想图（可选）
```

插件只会读写这个目录，不访问网络、不写系统其它位置。

## 工作原理

### 1. 衰减

```
strength(t) = baseStrength × exp(-age / τ)
τ = 10天 × (0.9 + importance) × (1 + 0.6 × emotion)
```

- 普通记忆约 10 天衰减到 1/e
- 重要/情绪记忆的 τ 更长，所以留得更久
- `strength < 0.12` 归档，`< 0.03` 彻底遗忘（可配置）

### 2. 提取强化

每次被召回：

```
baseStrength += 0.22 × (1 - baseStrength)
lastAccess = now
accessCount += 1
```

### 3. 线索依赖召回

```
相关度 = IDF 加权特征重叠 / sqrt(查询IDF和 × 记忆特征数)
score  = 0.55 × 相关度 × 分区权重
       + 0.20 × 当前强度
       + 0.15 × 近因
       + 0.10 × 重要度
```

线索必须真的命中（没有任何词重合时不会被想起）。

### 4. 睡眠巩固

- 对活跃情节记忆做 bigram Jaccard 聚类（阈值 0.3）
- 每组 ≥2 条 → 合并成语义记忆（全文合并，上限 3800 字）
- 高重要度 + 被多次提取 → 直接升格
- 合并/去重/归档都追加哈希链事件

### 5. 哈希链

```
event = { seq, type, id, contentHash, ts, prevHash, by, hash, sig }
hash   = sha256(seq|type|id|contentHash|ts|prevHash|by)
sig    = Ed25519(hash)
```

- 并发写入时在**文件锁内**读取链尾再追加，避免多进程断链
- `verifyChain` 校验 seq 连续、prevHash 衔接、hash 重算、签名
- `verifyMemory` 用当前记忆逐条重算 contentHash，发现「被改过」或「未记录」

### 6. 分区

| 区 | 用途 | 衰减 | 权重 | 默认注入 |
|---|---|---|---|---|
| `self` | 人格、身份、价值观、目标 | 不衰减 | 1.15 | 是 |
| `relationship` | 对人的画像、称呼、亲密度 | 0.5× | 1.10 | 是 |
| `episodic` | 具体对话、事件 | 1× | 1.00 | 是 |
| `semantic` | 巩固后的长期知识 | 0.6× | 1.05 | 是 |
| `life` | 日常碎片、说说、语音 | 1.2× | 1.00 | 是 |
| `learning` | 学到的知识、梗 | 0.8× | 0.95 | 是 |
| `vault` | 密码、暗号、隐私 | 不衰减 | 0.60 | **否** |

## 使用示例

```text
# 记住一个偏好
memory_remember({
  text: "她喜欢下雨天，讨厌香菜",
  kind: "semantic",
  importance: 0.7,
  tags: ["preference"],
  zone: "relationship"
})

# 按场景回忆
memory_recall({ query: "她喜欢什么天气", limit: 5 })

# 只在自我区回忆
memory_recall({ query: "我是谁", zone: "self" })

# 读取隔离区（需显式允许）
memory_recall({ query: "暗号", zone: "vault", include_vault: true })

# 空闲时巩固
memory_consolidate()

# 审计
memory_chain_verify()
```

## 隐私与安全

- **纯本地**：插件没有任何网络请求，不上传、不遥测
- **隔离区**：`vault` 默认不参与召回；群聊场景应完全排除
- **仓库干净**：本仓库不包含任何记忆数据、用户信息或密钥
- **密钥**：`memory-chain-key.pem` 是证明历史的关键，丢失后无法验证旧链，请备份

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 设计目标、数据模型、衰减/召回/巩固/链/分区的算法与决策 |
| [docs/tools.md](docs/tools.md) | 7 个工具的完整参数、返回与示例 |
| [docs/data-format.md](docs/data-format.md) | memory.json、哈希链、向量/图等文件的字段说明 |
| [docs/architecture.md](docs/architecture.md) | 模块划分与架构速览 |
| [docs/faq.md](docs/faq.md) | 安装、数据、召回、链、隐私、性能的常见问题 |

## 常见问题

**Q：记忆会不会无限增长？**
A：有 `maxItems` 上限（默认 2 万），超出按当前强度从最弱开始淘汰。

**Q：重启 DSH 会丢记忆吗？**
A：不会，全部持久化在 `dataDir`。

**Q：怎么调遗忘速度？**
A：改 `lib/core/config.mjs` 里的 `decay.baseTauMs`、`importanceBias`、`emotionBias`，或在配置里覆盖。

**Q：能在多个 agent/会话间共享记忆吗？**
A：同一台机器、同一个 `dataDir` 即可共享；多进程同时写有文件锁保护。

**Q：哈希链能防谁？**
A：防「本地记忆被悄悄改动而不留痕」。它不是公链，不能防整机被接管，但能保证任何单条记忆的修改都会断链。

**Q：支持中文吗？**
A：召回特征用中文二元组 + 英文词，中文效果是主要设计目标。

## 目录结构

```
dsh-memory/
├─ package.json
├─ cordis.patch.yml
├─ lib/
│  ├─ index.js          插件入口（7 个工具）
│  └─ core/             记忆核心模块
├─ locale/              中英文显示名与描述
├─ docs/
│  ├─ architecture.md   架构与算法细节
│  └─ ...
├─ icon.svg
├─ README.md
└─ LICENSE
```

## 路线图

- [ ] 隔离区加密存储（目前只是不召回）
- [ ] 可视化的「记忆星图」独立页面
- [ ] 多设备同步（哈希链合并）
- [ ] 可插拔的 embedding / rerank

## License

MIT
