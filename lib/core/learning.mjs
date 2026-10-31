// 自动学习模块：把「提问 → 查资料 → 学到的知识」沉淀下来，下次同类问题直接可用。
//
// 数据结构（~/.dsh/qq-memory/learning.json）：
// {
//   version: 1,
//   entries: [{
//     id, question, summary, sources: [{title,url}], tags: [],
//     learnedAt, updatedAt, confidence: 0-1, hits: 0
//   }]
// }
//
// 能力：
//   - lookup(query)：按关键词/字二元组相关度 + 新鲜度打分，返回已学过的知识
//   - record({question,summary,sources,...})：写入，相似问题去重更新（重复问到 → 置信度+命中数+）
//   - stats()：统计
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataDir } from './datadir.mjs';

const MAX_ENTRIES = 3000;

function learningFile(memoryDir) {
  const dir = memoryDir || resolveDataDir();
  return path.join(dir, 'learning.json');
}

function load(memoryDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(learningFile(memoryDir), 'utf8'));
    if (raw && raw.version === 1) {
      return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries : [] };
    }
  } catch {
    /* 没有文件 → 空库 */
  }
  return { version: 1, entries: [] };
}

function save(state, memoryDir) {
  const file = learningFile(memoryDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** 中文友好的分词：英文/数字按单词，中文按 2-gram（单字也保留） */
export function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  const words = s.match(/[a-z0-9]+/g) || [];
  for (const w of words) {
    if (w.length >= 2) out.add(w);
  }
  const zh = s.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const chunk of zh.split(/\s+/)) {
    if (!chunk) continue;
    for (let i = 0; i < chunk.length; i++) {
      out.add(chunk[i]);
      if (i + 1 < chunk.length) out.add(chunk.slice(i, i + 2));
    }
  }
  return out;
}

function overlapScore(queryTokens, textTokens) {
  let hit = 0;
  for (const t of queryTokens) {
    if (textTokens.has(t)) hit += 1;
  }
  return hit;
}

function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size);
}

function ageDecay(ts, now) {
  const days = Math.max(0, (now - (ts || now)) / 86400_000);
  // 30 天半衰期：学到的知识随时间缓慢降权，但不是删除
  return Math.pow(0.5, days / 30);
}

/** 查询已学过的知识 */
export function lookup({ query, limit = 5, memoryDir, now = Date.now() } = {}) {
  const state = load(memoryDir);
  const q = String(query || '').trim();
  if (!q) return [];
  const qt = tokens(q);
  const scored = [];
  for (const e of state.entries) {
    const hay = `${e.question} ${e.summary} ${(e.tags || []).join(' ')}`;
    const st = tokens(hay);
    const score = overlapScore(qt, st) * (0.6 + 0.4 * (e.confidence ?? 0.6)) * ageDecay(e.updatedAt || e.learnedAt, now);
    if (score > 0) scored.push({ entry: e, score: Math.round(score * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 5))).map((s) => ({
    id: s.entry.id,
    question: s.entry.question,
    summary: s.entry.summary,
    sources: s.entry.sources || [],
    tags: s.entry.tags || [],
    confidence: s.entry.confidence ?? 0.6,
    hits: s.entry.hits || 0,
    learnedAt: s.entry.learnedAt,
    updatedAt: s.entry.updatedAt,
    score: s.score,
  }));
}

/** 记录一条学到的知识（相似问题去重更新） */
export function record({ question, summary, sources = [], tags = [], confidence = 0.6, memoryDir, now = Date.now() } = {}) {
  const q = String(question || '').trim();
  const text = String(summary || '').trim();
  if (!q || !text) throw new Error('learning_record 需要 question 和 summary');
  const state = load(memoryDir);
  // 去重：问题相似度 > 0.75 视为同一问题
  let best = null;
  let bestSim = 0;
  for (const e of state.entries) {
    const sim = similarity(q, e.question);
    if (sim > bestSim) {
      bestSim = sim;
      best = e;
    }
  }
  const cleanSources = (Array.isArray(sources) ? sources : [])
    .map((s) => (typeof s === 'string' ? { title: '', url: s } : { title: String(s?.title || ''), url: String(s?.url || '') }))
    .filter((s) => s.url || s.title)
    .slice(0, 8);
  const cleanTags = (Array.isArray(tags) ? tags : []).map(String).filter(Boolean).slice(0, 10);

  if (best && bestSim >= 0.75) {
    best.summary = text.length > best.summary.length ? text : best.summary;
    const merged = new Map();
    for (const s of [...(best.sources || []), ...cleanSources]) {
      const key = s.url || s.title;
      if (key) merged.set(key, s);
    }
    best.sources = [...merged.values()].slice(0, 8);
    best.tags = [...new Set([...(best.tags || []), ...cleanTags])].slice(0, 10);
    best.hits = (best.hits || 0) + 1;
    best.confidence = Math.min(1, Math.max(best.confidence || 0.6, Number(confidence) || 0.6) + 0.05);
    best.updatedAt = now;
    save(state, memoryDir);
    return { action: 'updated', entry: best };
  }

  const entry = {
    id: crypto.randomUUID(),
    question: q.slice(0, 300),
    summary: text.slice(0, 2000),
    sources: cleanSources,
    tags: cleanTags,
    learnedAt: now,
    updatedAt: now,
    confidence: Math.max(0.1, Math.min(1, Number(confidence) || 0.6)),
    hits: 1,
  };
  state.entries.push(entry);
  // 有界：超出上限时删掉最旧/最低分的
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.sort((a, b) => (b.confidence || 0.6) - (a.confidence || 0.6) || (b.updatedAt || 0) - (a.updatedAt || 0));
    state.entries = state.entries.slice(0, MAX_ENTRIES);
  }
  save(state, memoryDir);
  return { action: 'created', entry };
}

export function stats({ memoryDir, now = Date.now() } = {}) {
  const state = load(memoryDir);
  const entries = state.entries;
  const tags = new Map();
  for (const e of entries) {
    for (const t of e.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  }
  return {
    total: entries.length,
    avgConfidence: entries.length
      ? Math.round((entries.reduce((s, e) => s + (e.confidence || 0.6), 0) / entries.length) * 100) / 100
      : 0,
    totalHits: entries.reduce((s, e) => s + (e.hits || 0), 0),
    topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count })),
    recent: [...entries].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5).map((e) => ({
      question: e.question,
      updatedAt: e.updatedAt,
      hits: e.hits,
    })),
    now,
  };
}

export { learningFile };
