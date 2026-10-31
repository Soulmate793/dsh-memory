# 设计说明

## 1. 设计目标

`dsh-memory` 想解决的不是「存不下」，而是「存了但不像人」。

常见做法的问题：

| 做法 | 问题 |
|---|---|
| 全量对话历史 | 上下文一满就丢；越聊越慢越贵 |
| 向量库 | 只会相似检索；没有强弱、没有时间、不会忘 |
| KV 表 | 没有线索依赖，查不到就永远想不起 |
| 摘要 | 丢细节，且摘要本身也会过时 |

目标是把人类记忆的几个关键性质做成机制：

1. 衰减（不用的会忘）
2. 巩固（重复的会变成常识）
3. 提取强化（想起来一次更容易再想起）
4. 线索依赖（相关才想起）
5. 分区（不同性质记忆不同策略，隐私隔离）

## 2. 数据模型

```json
{
  "id": "epi-...",
  "kind": "episodic | semantic",
  "zone": "self | relationship | episodic | semantic | life | learning | vault",
  "text": "原文",
  "tags": ["profile", "person:alice"],
  "importance": 0.5,
  "emotion": 0.2,
  "valence": 0.0,
  "createdAt": 0,
  "lastAccess": 0,
  "accessCount": 0,
  "baseStrength": 0.5,
  "state": "active | archived | purged",
  "pinned": false,
  "source": { "chat": "..." },
  "meta": {}
}
```

- `kind` 是粗粒度（经历 vs 事实）
- `zone` 是策略粒度（决定衰减、权重、隐私）
- `state` 是生命周期（活跃 → 归档 → 遗忘）

## 3. 衰减

```
strength(t) = baseStrength × exp(-age / τ)
τ = baseTau × (0.9 + importance) × (1 + 0.6 × emotion)
```

默认 `baseTau = 10 天`：

| 记忆 | τ |
|---|---|
| 普通（imp 0.5，emo 0） | ≈ 14 天 |
| 重要（imp 0.9） | ≈ 18 天 |
| 强情绪（imp 0.5，emo 1） | ≈ 22 天 |

阈值：`forgetThreshold=0.12` 归档，`purgeThreshold=0.03` 遗忘。

分区系数（`zones.mjs`）：

- `self` / `vault`：0（不衰减）
- `relationship`：0.5
- `semantic`：0.6
- `learning`：0.8
- `episodic`：1.0
- `life`：1.2

## 4. 召回

```
相关度 = IDF 加权特征重叠 / sqrt(查询特征IDF和 × 记忆特征数)
score  = 0.55 × 相关度 × 分区权重
       + 0.20 × 当前强度
       + 0.15 × 近因
       + 0.10 × 重要度
```

特征：中文二元组 + 英文词，去停用词；停用词表与分词在 `util.mjs`。

过滤：

- `state`（默认只活跃）
- `kind`
- `zone`
- `vault`：默认不可见；群聊永远不可见；私聊需 `include_vault=true`

提取强化（默认开启）：

```
baseStrength += 0.22 × (1 - baseStrength)
```

## 5. 睡眠巩固

1. 取活跃情节记忆
2. 两两计算 bigram Jaccard 相似度
3. 相似度 ≥ 0.3 的连成簇
4. 簇大小 ≥ 2 → 合并成语义记忆：
   - 文本全文合并（去重、上限 3800 字）
   - 重要度取最大，标签取并集
   - 原情节记忆归档（保留链事件）
5. 高重要度（≥0.8）且被提取 ≥2 次 → 直接升格为语义记忆

## 6. 哈希链

追加事件时：

1. 获取 `<chain>.lock` 文件锁
2. 在锁内读取链尾（`lastEvent`）
3. 计算 `seq = prev.seq + 1`、`prevHash = prev.hash`
4. 计算 `hash = sha256(...)`、`sig = Ed25519(hash)`
5. 追加一行 JSON，释放锁

> 关键顺序：**先锁后读**。先读后锁会让两个进程拿到同一链尾，产生重复 seq / 断链（实测踩过）。

校验：

- `verifyChain`：seq 连续、prevHash 衔接、hash 重算一致、签名有效
- `verifyMemory`：当前 `memory.json` 每条重算 contentHash，与链上该 id 最后一条事件比对

## 7. 分区

分区是「策略层」，不是「存储层」：所有记忆仍在同一个 `memory.json`，只是字段不同。

为什么分区：

- 人格/身份不能衰减（`self`）
- 对人的称呼和亲密度需要长期稳定（`relationship`）
- 日常碎片过期就过期（`life`）
- 隐私内容不能随便召回（`vault`）

分类规则（`classifyZone`）：

1. 已有合法 `zone` → 保留
2. 标签含 `vault/secret/暗号/password` → vault
3. 标签含 `personality/self` → self
4. 标签含 `profile/qq:` 或文本以 `[画像]` 开头 → relationship
5. 标签含 `learning` → learning
6. 标签含 `life/qzone/说说/voice` → life
7. `kind=semantic` → semantic
8. 其它 → episodic

## 8. 可选：向量与联想图

核心插件只依赖关键词召回。若要「模糊回忆」：

- **向量**：外部 embedding 服务（如 `bge-small-zh`），把 `text` 编码成向量，检索用余弦相似度，再与关键词相关度混合（语义 65% + 关键词 35%）
- **联想图**：按「同一人 / 时间相邻 / 话题相似 / 引用关系」建边；召回时从种子记忆沿边激活扩散 1~2 跳

这两块在 `lib/core/vectors.mjs`、`lib/core/graph.mjs`，不启用不影响插件运行。

## 9. 已知限制

- 关键词召回对长文本、同义改写不如向量模型
- 哈希链只防「单条篡改留痕」，不防整机被接管
- 没有跨设备同步（链路文件可手动同步，但需要合并策略）
- 隔离区目前只是「不召回」，文件仍是明文
