# 架构说明

## 模块

```
lib/index.js          DSH 插件入口（注册 7 个记忆工具）
lib/core/store.mjs    记忆存储、容量淘汰、哈希链钩子
lib/core/recall.mjs   线索依赖召回（关键词 IDF / 语义向量混合）
lib/core/decay.mjs    艾宾浩斯衰减与提取强化
lib/core/consolidate.mjs 睡眠巩固（聚类/合并/去重/升格）
lib/core/chain.mjs    哈希链 + Ed25519 签名 + 对账
lib/core/zones.mjs    记忆分区定义与分类
lib/core/vectors.mjs  向量索引（可选）
lib/core/graph.mjs    联想图（可选）
lib/core/emotion.mjs  8 维情绪状态（可选）
lib/core/personality.mjs 性格阶段成长（可选）
lib/core/profiles.mjs 人物画像聚合（可选）
lib/core/learning.mjs 学习库（可选）
```

## 记忆条目

```json
{
  "id": "epi-...",
  "kind": "episodic | semantic",
  "zone": "self | relationship | episodic | semantic | life | learning | vault",
  "text": "原文",
  "tags": ["profile", "qq:123"],
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

## 召回

1. 候选过滤：state、kind、zone、vault 可见性
2. 特征提取：中文二元组 + 英文词，停用词过滤
3. IDF 加权相关度 → 归一化
4. 与强度/近因/重要度加权求和
5. 命中项做提取强化（strength 回补、lastAccess/accessCount 更新）

语义向量模式：

```
relevance = 0.65 × bge余弦归一化 + 0.35 × 关键词命中率
score     = 0.55 × relevance × 分区权重 + 0.20 × 强度 + 0.15 × 近因 + 0.10 × 重要度
```

## 巩固

- 对活跃情节记忆做 bigram Jaccard 聚类（阈值 0.3）
- 每组 ≥2 条 → 合并成语义记忆（全文合并，最多 3800 字）
- 高重要度 + 被多次提取 → 直接升格
- 合并/去重/归档都会追加哈希链事件

## 哈希链

```
event = { seq, type, id, contentHash, ts, prevHash, by, hash, sig }
hash   = sha256(seq|type|id|contentHash|ts|prevHash|by)
sig    = Ed25519(hash)
```

- 追加时在文件锁内读取链尾，计算 seq/prevHash，再写入
- `verifyChain`: seq 连续、prevHash 衔接、hash 重算一致、签名有效
- `verifyMemory`: 用当前 `memory.json` 逐条重算 contentHash 与链上最后一条比对，发现「被改过」或「未记录」

## 分区

| zone | 衰减系数 | 检索权重 | 注入 |
|---|---|---|---|
| self | 0（不衰减） | 1.15 | 是 |
| relationship | 0.5 | 1.10 | 是 |
| episodic | 1.0 | 1.00 | 是 |
| semantic | 0.6 | 1.05 | 是 |
| life | 1.2 | 1.00 | 是 |
| learning | 0.8 | 0.95 | 是 |
| vault | 0（永久） | 0.60 | **否** |
