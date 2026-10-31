// 线索依赖检索（人类式回忆）：
//   score = 0.55 × 相关度 + 0.20 × 强度 + 0.15 × 近因 + 0.10 × 重要度
// 相关度用 IDF 加权的特征重叠（越少见的词越能当线索）。
// 命中后自动「提取强化」——回忆本身会让记忆变牢。
import { featuresOf, clamp } from './util.mjs';
import { decayedStrength, reinforce } from './decay.mjs';
import { DAY } from './config.mjs';
import { classifyZone, zoneWeight, isVault } from './zones.mjs';

export function recall(store, {
  query = '',
  limit = null,
  kinds = null,
  zones = null,
  includeVault = false,
  includeArchived = false,
  minScore = null,
  now = null,
  reinforceResults = true,
} = {}) {
  const t = now ?? store.now;
  const cfg = store.config;
  const rcfg = cfg.recall;
  const lim = limit ?? rcfg.defaultLimit;
  const min = minScore ?? rcfg.minScore;
  const weights = rcfg.weights;

  const candidates = store.state.items.filter((it) => {
    if (!includeArchived && it.state !== 'active') return false;
    if (kinds && !kinds.includes(it.kind)) return false;
    const zone = classifyZone(it);
    if (isVault(zone) && !includeVault) return false;
    if (zones && !zones.includes(zone)) return false;
    return true;
  });
  if (!candidates.length) return [];

  const qFeat = featuresOf(String(query || ''));
  const N = candidates.length;

  // 文档频率 → IDF
  const feats = candidates.map((it) => featuresOf(`${it.text} ${(it.tags || []).join(' ')}`));
  const df = new Map();
  for (const f of feats) for (const x of f) df.set(x, (df.get(x) | 0) + 1);
  const idf = (x) => Math.log(1 + N / (1 + (df.get(x) | 0)));
  let qIdfSum = 0;
  for (const x of qFeat) qIdfSum += idf(x);

  const results = [];
  candidates.forEach((item, i) => {
    const f = feats[i];
    let relRaw = 0;
    for (const x of qFeat) if (f.has(x)) relRaw += idf(x);
    const relevance = qIdfSum > 0 && f.size > 0
      ? relRaw / Math.sqrt(qIdfSum * f.size)
      : 0;
    const strength = decayedStrength(item, t, cfg.decay);
    const age = Math.max(0, t - (item.createdAt ?? t));
    const recency = Math.exp(-age / (30 * DAY));
    const importance = clamp(item.importance ?? 0.5, 0, 1);
    const zone = classifyZone(item);
    const score = weights.relevance * relevance * zoneWeight(zone)
      + weights.strength * strength
      + weights.recency * recency
      + weights.importance * importance;
    // 线索必须真的命中：没有任何词重合时不会被「想起」（否则等于乱翻记忆）
    const matched = qFeat.size === 0 || relevance > 0;
    if (matched && score >= min) {
      results.push({
        item: { ...item, zone: classifyZone(item) },
        score: Math.round(score * 10000) / 10000,
        parts: {
          relevance: Math.round(relevance * 1000) / 1000,
          strength: Math.round(strength * 1000) / 1000,
          recency: Math.round(recency * 1000) / 1000,
          importance,
        },
      });
    }
  });

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, lim);

  // 提取强化：被想起来的记忆会变强（只在有效线索命中时发生）
  if (reinforceResults && qFeat.size > 0) {
    for (const r of top) reinforce(r.item, t, cfg.decay);
    if (top.length) store.dirty = true;
  }
  return top;
}

/**
 * 向量语义召回（仿人的"模糊回忆"）：用 embedding 相似度替代关键词相关度，
 * 其余打分（强度/近因/重要度）与关键词召回一致。
 *
 * score = 0.55×语义相似 + 0.20×强度 + 0.15×近因 + 0.10×重要度
 *
 * @param {object} store MemoryStore
 * @param {object} opts
 * @param {number[]} opts.queryVector 已归一化的查询向量
 * @param {object} opts.index loadIndex() 的返回值
 */
export function recallWithVectors(store, {
  queryVector,
  query = '',
  zones = null,
  includeVault = false,
  index,
  limit = 8,
  includeArchived = false,
  reinforceResults = true,
  topK = 300,
  now = null,
} = {}) {
  if (!index || !Array.isArray(queryVector) || queryVector.length !== index.dim) return [];
  const t = now ?? store.now;
  const cfg = store.config;
  const weights = cfg.recall.weights;
  const candidates = store.state.items.filter(
    (it) => (includeArchived || it.state === 'active')
      && index.rows.has(String(it.id))
      && (!isVault(classifyZone(it)) || includeVault)
      && (!zones || zones.includes(classifyZone(it))),
  );
  if (!candidates.length) return [];

  const qFeat = featuresOf(String(query || ''));
  const scored = [];
  for (const item of candidates) {
    const row = index.rows.get(String(item.id));
    let semantic = 0;
    for (let i = 0; i < index.dim; i++) semantic += row[i] * queryVector[i];
    // 关键词命中率（0~1）：和语义互补，避免语义把高权重记忆全捞出来
    let kwHits = 0;
    if (qFeat.size > 0) {
      const feats = featuresOf(`${item.text} ${(item.tags || []).join(' ')}`);
      for (const x of qFeat) if (feats.has(x)) kwHits += 1;
      kwHits /= qFeat.size;
    }
    scored.push({ item, semantic, kwHits });
  }
  scored.sort((a, b) => b.semantic - a.semantic);
  const shortlist = scored.slice(0, Math.max(limit, Math.min(500, topK)));

  const results = [];
  for (const { item, semantic, kwHits } of shortlist) {
    // bge 余弦通常在 0.3~0.8 之间：先归一化，再和关键词命中率混合（语义为主、关键词兜底）
    const semNorm = clamp((semantic - 0.30) / 0.55, 0, 1);
    const relevance = clamp(0.65 * semNorm + 0.35 * kwHits, 0, 1) * zoneWeight(classifyZone(item));
    if (relevance <= 0.05 && (qFeat.size === 0 || kwHits === 0)) continue;
    const strength = decayedStrength(item, t, cfg.decay);
    const age = Math.max(0, t - (item.createdAt ?? t));
    const recency = Math.exp(-age / (30 * DAY));
    const importance = clamp(item.importance ?? 0.5, 0, 1);
    const score = weights.relevance * relevance
      + weights.strength * strength
      + weights.recency * recency
      + weights.importance * importance;
    results.push({
      item: { ...item, zone: classifyZone(item) },
      score: Math.round(score * 10000) / 10000,
      parts: {
        relevance: Math.round(relevance * 1000) / 1000,
        strength: Math.round(strength * 1000) / 1000,
        recency: Math.round(recency * 1000) / 1000,
        importance,
      },
    });
  }
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, Math.max(1, limit));
  if (reinforceResults && top.length) {
    for (const r of top) reinforce(r.item, t, cfg.decay);
    store.dirty = true;
  }
  return top;
}
