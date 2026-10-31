# 工具手册

插件注册 7 个工具，全部返回 JSON 文本。

---

## memory_remember

写入一条长期记忆。

### 参数

| 名称 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `text` | string | ✅ | - | 内容，≤4000 字 |
| `kind` | `episodic`/`semantic` | - | `episodic` | 经历 / 长期事实 |
| `importance` | number 0~1 | - | 0.5 | 重要度 |
| `emotion` | number 0~1 | - | 0 | 情绪强度 |
| `tags` | string[] | - | [] | 标签 |
| `zone` | 枚举 | - | 自动推断 | 分区 |
| `chat` | string | - | null | 来源会话 |

### 返回

```json
{ "ok": true, "id": "epi-...", "zone": "episodic", "importance": 0.5 }
```

### 示例

```text
memory_remember({
  text: "用户叫 alice，喜欢下雨天，讨厌香菜",
  kind: "semantic",
  importance: 0.75,
  tags: ["profile", "person:alice"],
  zone: "relationship"
})
```

---

## memory_recall

按线索回忆。

### 参数

| 名称 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | ✅ | - | 自然语言线索 |
| `limit` | number 1~50 | - | 8 | 返回条数 |
| `zone` | 枚举 | - | 全部 | 限定分区 |
| `include_vault` | boolean | - | false | 是否读隔离区 |
| `include_archived` | boolean | - | false | 是否含归档 |

### 返回

```json
{
  "ok": true,
  "count": 3,
  "hits": [
    {
      "id": "sem-...",
      "text": "用户喜欢下雨天",
      "score": 0.71,
      "kind": "semantic",
      "zone": "relationship",
      "importance": 0.7,
      "createdAt": 0
    }
  ]
}
```

### 示例

```text
memory_recall({ query: "她喜欢什么天气", limit: 5 })
memory_recall({ query: "我是谁", zone: "self" })
memory_recall({ query: "暗号", zone: "vault", include_vault: true })
```

---

## memory_stats

### 参数

无。

### 返回

```json
{
  "ok": true,
  "dir": "C:\\Users\\me\\.dsh\\qq-memory",
  "stats": {
    "total": 1000,
    "active": 800,
    "archived": 200,
    "byKind": { "episodic": 600, "semantic": 200 },
    "avgStrength": 0.42
  },
  "personality": { "stage": "dragon", "xp": 1200 }
}
```

---

## memory_zones

### 参数

无。

### 返回

```json
{
  "ok": true,
  "zones": { "self": 3, "relationship": 12, "episodic": 600, "semantic": 200, "life": 10, "learning": 0, "vault": 0 },
  "labels": { "self": "自我", "relationship": "关系" }
}
```

---

## memory_forget

软删除一条记忆。

### 参数

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 记忆 id |

### 返回

```json
{ "ok": true, "id": "epi-..." }
```

> 不会物理删除文件；`state` 变为 `purged`，哈希链追加 `forget` 事件。

---

## memory_consolidate

执行一次睡眠巩固。

### 参数

无。

### 返回

```json
{ "ok": true, "merged": 3, "archived": 6, "promoted": 1 }
```

字段名以实际实现为准；建议空闲/低峰时调用。

---

## memory_chain_verify

校验哈希链与记忆文件。

### 参数

无。

### 返回

```json
{
  "ok": true,
  "head": { "seq": 20001, "hash": "..." },
  "chain": { "ok": true, "events": 20001, "errors": [] },
  "memory": { "ok": true, "checked": 20000, "mismatchedCount": 0, "unrecordedCount": 0 }
}
```

`ok=false` 表示链断裂、签名失败、或记忆与链不一致（可能被改过）。
