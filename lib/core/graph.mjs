// 联想图：记忆之间的"联想边"（仿人记忆的关联性）
//
// 边类型：
//   ref   —— 巩固/合并/去重产生的引用关系（最强）
//   person —— 同一个人说的话，按时间相邻连接
//   time  —— 同一会话里时间相邻的消息
//   topic —— 内容相似（bigram Jaccard）
//
// 文件：memory-graph.jsonl，每行 {a,b,type,w,at}（a<b 无序）
//
// 召回时：先拿到种子记忆 → 沿边"激活扩散"1~2 跳（每跳衰减）→ 联想到相关记忆。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './datadir.mjs';
import { featuresOf, jaccard } from './util.mjs';

export function graphPaths(dir) {
  const base = dir || resolveDataDir();
  return { file: path.join(base, 'memory-graph.jsonl') };
}

const MAX_DEGREE = { ref: 1000, person: 6, time: 4, topic: 6 };

function pairKey(a, b, type) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${type}\u0001${x}\u0001${y}`;
}

export function readEdges(dir) {
  try {
    return fs
      .readFileSync(graphPaths(dir).file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 从记忆条目构建边（一次性全量） */
export function isSummaryNode(item) {
  return /^\[(画像|性格|自我认知)\]/.test(String(item?.text || ''));
}

export function buildEdges(items, { now = Date.now() } = {}) {
  const edges = [];
  const seen = new Set();
  const degree = new Map(); // id -> {person,time,topic}
  const bump = (id, type) => {
    const d = degree.get(id) || { person: 0, time: 0, topic: 0 };
    d[type] = (d[type] || 0) + 1;
    degree.set(id, d);
    return d[type];
  };
  const add = (a, b, type, w) => {
    if (!a || !b || a === b) return;
    const key = pairKey(a, b, type);
    if (seen.has(key)) return;
    if (type !== 'ref') {
      if (bump(a, type) > (MAX_DEGREE[type] || 6)) return;
      if (bump(b, type) > (MAX_DEGREE[type] || 6)) return;
    }
    seen.add(key);
    edges.push({ a: a < b ? a : b, b: a < b ? b : a, type, w: Math.round(w * 1000) / 1000, at: now });
  };

  // 分组：会话 / 人
  const byChat = new Map();
  const bySender = new Map();
  const feats = new Map();
  for (const it of items) {
    if (!it?.id) continue;
    if (isSummaryNode(it)) continue;
    const chat = it.source?.chat || (it.tags || []).find((t) => t.startsWith('chat:')) || 'global';
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(it);
    const sender = (it.tags || []).find((t) => t.startsWith('sender:'));
    if (sender) {
      if (!bySender.has(sender)) bySender.set(sender, []);
      bySender.get(sender).push(it);
    }
    feats.set(String(it.id), featuresOf(`${it.text} ${(it.tags || []).join(' ')}`));
    // 引用边
    for (const refId of [...(it.meta?.mergedFrom || []), it.meta?.consolidatedInto, it.meta?.dedupedInto]) {
      if (refId && refId !== it.id) add(String(it.id), String(refId), 'ref', 1.0);
    }
  }

  // 时间边（同会话连续消息，间隔 <= 10 分钟）
  for (const list of byChat.values()) {
    const sorted = [...list].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = Math.max(0, (cur.createdAt ?? 0) - (prev.createdAt ?? 0));
      if (gap <= 10 * 60 * 1000) add(prev.id, cur.id, 'time', Math.max(0.2, 1 - gap / (10 * 60 * 1000)));
    }
  }

  // 人边（同一个人连续发言，间隔 <= 2 小时）
  for (const list of bySender.values()) {
    const sorted = [...list].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = Math.max(0, (cur.createdAt ?? 0) - (prev.createdAt ?? 0));
      if (gap <= 2 * 60 * 60 * 1000) add(prev.id, cur.id, 'person', 0.7);
    }
  }

  // 话题边：倒排索引（只取"中等频率"的特征，避免停用词把所有东西连起来）
  const inv = new Map();
  for (const [id, f] of feats) {
    for (const x of f) {
      if (!inv.has(x)) inv.set(x, []);
      inv.get(x).push(id);
    }
  }
  for (const [id, f] of feats) {
    const candidates = new Map(); // otherId -> shared count
    for (const x of f) {
      const bucket = inv.get(x);
      if (!bucket || bucket.length < 2 || bucket.length > 200) continue;
      for (const other of bucket) if (other !== id) candidates.set(other, (candidates.get(other) || 0) + 1);
    }
    const scored = [...candidates.entries()]
      .map(([other, shared]) => ({ other, j: jaccard(f, feats.get(other) || new Set()) }))
      .filter((x) => x.j >= 0.5)
      .sort((a, b) => b.j - a.j)
      .slice(0, MAX_DEGREE.topic);
    for (const { other, j } of scored) add(id, other, 'topic', j);
  }

  return edges;
}

export function writeGraph(dir, edges) {
  const p = graphPaths(dir);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, edges.map((e) => JSON.stringify(e)).join('\n') + (edges.length ? '\n' : ''), 'utf8');
  return { file: p.file, edges: edges.length, sizeBytes: fs.statSync(p.file).size };
}

export function appendEdges(dir, newEdges) {
  if (!newEdges.length) return 0;
  const p = graphPaths(dir);
  fs.appendFileSync(p.file, newEdges.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return newEdges.length;
}

/** 加载邻接表：Map<id, [{id,type,w}]> */
export function loadGraph(dir) {
  const edges = readEdges(dir);
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push({ id: e.b, type: e.type, w: e.w ?? 1 });
    adj.get(e.b).push({ id: e.a, type: e.type, w: e.w ?? 1 });
  }
  return adj;
}

/** 激活扩散：种子记忆沿边扩散 hops 跳，返回 id -> 激活值 */
export function spread(adj, seeds, { hops = 2, decay = 0.5, maxPerNode = 6 } = {}) {
  const activation = new Map();
  let frontier = [];
  for (const s of seeds) {
    if (!s?.id) continue;
    activation.set(String(s.id), Math.max(activation.get(String(s.id)) || 0, Number(s.score) || 1));
    frontier.push(String(s.id));
  }
  let currentDecay = 1;
  for (let hop = 0; hop < hops; hop++) {
    currentDecay *= decay;
    const next = [];
    for (const id of frontier) {
      const neighbors = (adj.get(id) || []).slice(0, maxPerNode);
      for (const nb of neighbors) {
        const add = (activation.get(id) || 0) * currentDecay * (nb.w ?? 1);
        if (add <= 0.01) continue;
        const prev = activation.get(nb.id) || 0;
        if (add > prev) activation.set(nb.id, add);
        next.push(nb.id);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return activation;
}

/** 新记忆增量连边：同会话最近几条 + 同一人最近几条 + 相似话题 */
export function linkNewItem(dir, item, recentItems = [], { now = Date.now() } = {}) {
  if (!item?.id) return [];
  if (isSummaryNode(item)) return [];
  recentItems = (recentItems || []).filter((it) => it && !isSummaryNode(it));
  const edges = [];
  const chat = item.source?.chat || (item.tags || []).find((t) => t.startsWith('chat:')) || '';
  const sender = (item.tags || []).find((t) => t.startsWith('sender:')) || '';
  const f = featuresOf(`${item.text} ${(item.tags || []).join(' ')}`);
  const sameChat = recentItems
    .filter((it) => it.id !== item.id && (it.source?.chat || (it.tags || []).find((t) => t.startsWith('chat:'))) === chat)
    .slice(-6);
  const sameSender = recentItems.filter((it) => it.id !== item.id && (it.tags || []).includes(sender)).slice(-4);
  for (const other of sameChat) edges.push({ a: item.id, b: other.id, type: 'time', w: 0.6, at: now });
  for (const other of sameSender) edges.push({ a: item.id, b: other.id, type: 'person', w: 0.7, at: now });
  for (const other of recentItems.slice(-30)) {
    if (other.id === item.id) continue;
    const j = jaccard(f, featuresOf(`${other.text} ${(other.tags || []).join(' ')}`));
    if (j >= 0.5) edges.push({ a: item.id, b: other.id, type: 'topic', w: j, at: now });
  }
  return edges;
}

export function graphStats(dir) {
  const edges = readEdges(dir);
  const byType = {};
  for (const e of edges) byType[e.type] = (byType[e.type] | 0) + 1;
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(graphPaths(dir).file).size;
  } catch {
    sizeBytes = 0;
  }
  return { edges: edges.length, byType, sizeBytes };
}
