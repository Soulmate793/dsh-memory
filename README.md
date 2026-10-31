# dsh-memory · 仿人记忆库（DeepSeek Harness 插件）

给 agent 一套「像人一样」的长期记忆：会遗忘、会巩固、会被线索唤起、会分区隔离，而且**全部数据只留在本地**。

零外部依赖，只需要 Node.js >= 20。

---

## 特性

| 能力 | 说明 |
|---|---|
| **艾宾浩斯遗忘** | 每条记忆有强度，按指数曲线衰减；重要/带情绪的记忆衰减更慢 |
| **提取强化** | 被回忆一次就变牢一点（rehearsal），符合人类记忆的「用进废退」 |
| **睡眠巩固** | 把同类情节记忆合并、去重、升格为长期语义记忆 |
| **线索依赖回忆** | 不是 SQL 精确匹配，而是按 IDF 加权的特征重叠 + 强度/近因/重要度综合打分 |
| **记忆分区** | 自我 / 关系 / 情节 / 语义 / 生活 / 学习 / 隔离七个区，各自有不同的衰减、权重和隐私策略 |
| **哈希链审计** | 每次写入/更新/遗忘都追加一条带 Ed25519 签名的哈希链事件，可校验记忆有没有被改过 |
| **工作记忆** | 最近消息的环形缓冲，超时自动丢弃（不污染长期记忆） |
| **性格与情绪（可选）** | 内置性格阶段成长、8 维情绪状态；不配置也能单独使用记忆功能 |

数据完全本地：插件不联网、不上传、不包含任何用户数据。

## 安装

作为 DSH bundle 安装（推荐）：

```bash
# 在本地 clone 后，用 DSH 的 plugin_manager 安装这个目录：
#   plugin_manager(action: "install_bundle", target: "<绝对路径>/dsh-memory-plugin")
```

或手动把本仓库放进 profile 的 bundle 列表，并在 `cordis.patch.yml` 中启用 `memory` 行（见 `cordis.patch.yml`）。

安装后 agent 会获得 7 个记忆工具（见下）。

## 配置

`cordis.patch.yml` 里的 `memory` 行：

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        memory:
          dataDir: ''        # 留空 = ~/.dsh/qq-memory
          maxItems: 20000    # 容量上限，超出按强度淘汰
          recallLimit: 8     # 默认召回条数
          includeVault: false # 默认不读取隔离区
```

也可以用环境变量 `MEMORY_DIR` 覆盖数据目录。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_remember` | 写入一条记忆（kind / importance / emotion / tags / zone） |
| `memory_recall` | 按线索回忆；可限定 zone、`include_vault=true` 读隔离区 |
| `memory_stats` | 记忆库统计（数量、类型、平均强度、性格阶段） |
| `memory_zones` | 分区统计（活跃记忆数） |
| `memory_forget` | 主动遗忘（软删除 + 链上留痕） |
| `memory_consolidate` | 睡眠巩固（合并/去重/升格） |
| `memory_chain_verify` | 校验哈希链完整性 + 与记忆文件对账 |

示例：

```text
memory_remember({ text: "用户喜欢下雨天，讨厌香菜", kind: "semantic", importance: 0.7, tags: ["preference"], zone: "relationship" })
memory_recall({ query: "他喜欢什么天气", limit: 5 })
memory_recall({ query: "密码", zone: "vault", include_vault: true })
```

## 数据布局

全部在 `dataDir`（默认 `~/.dsh/qq-memory/`）：

```
memory.json               记忆数据（items 数组）
memory-chain.jsonl        哈希链事件（追加写）
memory-chain-key.pem      Ed25519 私钥（备份！丢了无法证明历史）
memory-chain-pub.pem      公钥
memory-chain-head.json    链头快照（每 25 条更新一次）
emotion-state.json        情绪状态（可选模块）
personality.json          性格阶段与成长值（可选模块）
profiles.json             人物画像（可选模块）
learning.json             学习库（可选模块）
```

> 备份：至少备份 `memory.json` 和 `memory-chain-key.pem`。

## 记忆模型

### 类型与分区

- `kind`: `episodic`（具体经历/对话）· `semantic`（长期事实/结论）
- `zone`:
  - `self` 自我：人格、身份、价值观、目标
  - `relationship` 关系：对人的画像、称呼、亲密度
  - `episodic` 情节：具体事件
  - `semantic` 语义：巩固后的长期知识
  - `life` 生活：日常碎片、说说、语音记录
  - `learning` 学习：学到的知识/梗
  - `vault` 隔离：密码、暗号、隐私（默认不召回，群聊永不注入）

### 召回打分

```
score = 0.55 × 相关度（IDF 特征重叠 × 分区权重）
      + 0.20 × 当前强度（衰减后）
      + 0.15 × 近因
      + 0.10 × 重要度
```

命中后自动做提取强化（默认 0.22 的强度回补）。

### 遗忘

```
强度(t) = baseStrength × exp(-age / τ)
τ = 10天 × (0.9 + importance) × (1 + 0.6 × emotion)
```

低于 `0.12` 归档，低于 `0.03` 彻底遗忘（可配置）。

### 哈希链

每条事件包含 `seq / type / id / contentHash / ts / prevHash / hash / sig`。

- `contentHash` 覆盖：id、kind、text、importance、emotion、valence、state、zone、tags
- `hash = sha256(...)`，`sig = Ed25519(hash)`
- 并发写入时在**锁内**读链尾再追加，避免多进程断链

## 可选：语义向量 / 联想图

核心插件只依赖关键词召回。如果本地跑一个 embedding 服务（如 `bge-small-zh`），可以使用配套脚本建立向量索引与联想图，实现「模糊回忆」：

- 向量索引：`memory-vectors.bin` + `memory-vectors-ids.jsonl`，检索按余弦相似度
- 联想图：`memory-graph.jsonl`，按人/时间/话题/引用建边，召回时激活扩散

这部分不是插件运行必需的，可按需启用（见 `docs/architecture.md`）。

## 隐私

- 数据只保存在本地目录，插件不含任何网络请求
- `vault` 区默认不参与召回；群聊场景应完全排除
- 仓库本身不包含任何记忆数据、用户信息或密钥

## 开发

```bash
node --check lib/index.js
node demo.mjs        # 核心库演示（如果使用了完整仓库）
node --test tests/*
```

## License

MIT
