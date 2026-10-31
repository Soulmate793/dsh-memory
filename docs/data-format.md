# 数据格式

所有文件都在 `dataDir`（默认 `~/.dsh/qq-memory/`）。全部是 UTF-8 纯文本/JSON，可以直接看、直接备份。

---

## memory.json

```json
{
  "version": 1,
  "items": [
    {
      "id": "epi-mvabc123-xyz",
      "kind": "episodic",
      "zone": "episodic",
      "text": "用户说今天很累，想早点睡",
      "tags": ["chat:private:10001", "sender:10001"],
      "importance": 0.55,
      "emotion": 0.2,
      "valence": -0.1,
      "source": { "chat": "private:10001" },
      "createdAt": 1790000000000,
      "lastAccess": 1790000000000,
      "accessCount": 0,
      "baseStrength": 0.55,
      "state": "active",
      "pinned": false,
      "meta": {}
    }
  ],
  "lastConsolidation": 1790000000000,
  "createdAt": 1780000000000
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `id` | 唯一 id（`epi-` / `sem-` 前缀） |
| `kind` | `episodic` 或 `semantic` |
| `zone` | 记忆分区 |
| `text` | 原文（≤4000 字） |
| `tags` | 标签数组（≤20 个） |
| `importance` | 重要度 0~1 |
| `emotion` | 情绪强度 0~1 |
| `valence` | 情绪效价 -1~1 |
| `source` | 来源（如 `{ "chat": "..." }`） |
| `createdAt` / `lastAccess` | 毫秒时间戳 |
| `accessCount` | 被召回次数 |
| `baseStrength` | 基础强度（衰减计算的起点） |
| `state` | `active` / `archived` / `purged` |
| `pinned` | 是否固定（不参与淘汰） |
| `meta` | 扩展字段（合并来源等） |

---

## memory-chain.jsonl

每行一个事件：

```json
{
  "seq": 1,
  "type": "add",
  "id": "epi-mvabc123-xyz",
  "contentHash": "…64 hex…",
  "ts": 1790000000000,
  "prevHash": "",
  "by": "local",
  "hash": "…64 hex…",
  "sig": "…base64…"
}
```

| 字段 | 说明 |
|---|---|
| `seq` | 从 1 开始，严格递增 |
| `type` | `add` / `update` / `archive` / `forget` |
| `id` | 记忆 id |
| `contentHash` | 记忆内容哈希（不含访问/衰减字段） |
| `ts` | 事件时间 |
| `prevHash` | 上一条事件的 `hash` |
| `by` | 写入者标识 |
| `hash` | `sha256(seq|type|id|contentHash|ts|prevHash|by)` |
| `sig` | Ed25519 签名（对 hash 的原始字节） |

`contentHash` 覆盖字段：

```
id | kind | text | importance | emotion | valence | state | zone | tags
```

---

## memory-chain-head.json

每 25 条更新一次的链头快照：

```json
{ "seq": 20001, "hash": "…", "ts": 1790000000000 }
```

实际链尾以 `memory-chain.jsonl` 为准，快照只是加速。

---

## 密钥

- `memory-chain-key.pem`：Ed25519 私钥（PKCS8 PEM）
- `memory-chain-pub.pem`：公钥

> 私钥丢失 = 无法再证明旧链；私钥泄露 = 别人可以伪造新事件。请妥善备份，不要提交到仓库。

---

## memory-vectors.bin / memory-vectors-ids.jsonl（可选）

- `.bin`：float32 行向量，按 ids 文件的行序排列
- `-ids.jsonl`：每行 `{ "id": "...", "row": 0, "at": 0 }`
- `memory-vectors-meta.json`：`{ "model": "...", "dim": 512 }`

检索时向量已 L2 归一化，点积即余弦相似度。

---

## memory-graph.jsonl（可选）

每行一条边：

```json
{ "a": "epi-1", "b": "epi-2", "type": "topic", "w": 0.62, "at": 1790000000000 }
```

`type`：`ref`（巩固引用）/ `person`（同一人）/ `time`（时间相邻）/ `topic`（话题相似）。

---

## 可选状态文件

| 文件 | 内容 |
|---|---|
| `emotion-state.json` | 8 维情绪向量、情绪历史 |
| `personality.json` | 性格阶段、成长值、特质 |
| `profiles.json` | 人物画像 |
| `learning.json` | 学习库 |
| `life-state.json` | 生活线调度状态 |
| `self-profile.json` | 目标/偏好/生活碎片（如果使用生活线脚本） |

这些文件都可以直接删除；删掉只会让对应可选功能重置，不影响核心记忆。
