// 记忆存储：JSON 文件持久化（原子写），零外部依赖。
// 数据结构：
// {
//   version: 1,
//   items: [item...],
//   lastConsolidation: <ts>,
//   createdAt: <ts>,
// }
//
// item = {
//   id, kind: 'episodic' | 'semantic',
//   text, tags: [], importance: 0..1, emotion: 0..1, valence: -1..1,
//   source: { chat, messageId, ts } | null,
//   createdAt, lastAccess, accessCount,
//   baseStrength: 0..1,       // 未衰减的初始强度（回忆会强化它）
//   state: 'active' | 'archived' | 'purged',
//   pinned: bool,             // 钉住的记忆永不遗忘
//   meta: {},
// }
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteJson, readJson, clamp, uid, acquireLock } from './util.mjs';
import { configWith, deepMerge } from './config.mjs';
import { decayedStrength } from './decay.mjs';
import { resolveDataDir } from './datadir.mjs';
import { appendEvent, contentHashOf } from './chain.mjs';
import { classifyZone } from './zones.mjs';

const SCHEMA_VERSION = 1;

export class MemoryStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]  状态目录，默认共享数据目录（MEMORY_DIR > ~/.dsh/dsh-memory.json > ~/.dsh/qq-memory）
   * @param {string} [opts.file] 状态文件（优先于 dir）
   * @param {object} [opts.config] 覆盖默认配置
   * @param {number|null} [opts.now] 测试用的假时钟（毫秒时间戳）
   */
  constructor({ dir, file, config, now = null } = {}) {
    this.dir = dir || resolveDataDir();
    this.file = file || path.join(this.dir, 'memory.json');
    this.config = configWith(config || {});
    this._now = now;
    const raw = readJson(this.file, null);
    this.state = raw && typeof raw === 'object' && raw.version === SCHEMA_VERSION
      ? raw
      : { version: SCHEMA_VERSION, items: [], lastConsolidation: 0, createdAt: this.now };
    if (!Array.isArray(this.state.items)) this.state.items = [];
    this.dirty = false;
  }

  get now() {
    return this._now ?? Date.now();
  }

  /** 测试用：设置假时钟。 */
  setNow(fnOrNumber) {
    this._now = typeof fnOrNumber === 'function' ? fnOrNumber() : fnOrNumber;
    return this;
  }

  /** 记忆一条内容。 */
  add({
    kind = 'episodic',
    text,
    tags = [],
    importance = 0.5,
    emotion = 0,
    valence = 0,
    source = null,
    baseStrength = null,
    pinned = false,
    meta = null,
    zone = null,
  } = {}) {
    if (!text || !String(text).trim()) throw new Error('memory text is required');
    const imp = clamp(Number(importance) || 0, 0, 1);
    const emo = clamp(Number(emotion) || 0, 0, 1);
    const initial = baseStrength == null
      ? clamp(0.35 + 0.45 * imp + 0.3 * emo, 0.15, 1)
      : clamp(Number(baseStrength), 0.01, 1);
    const now = this.now;
    const item = {
      id: uid(kind === 'semantic' ? 'sem' : 'epi'),
      kind: kind === 'semantic' ? 'semantic' : 'episodic',
      text: String(text).trim().slice(0, 4000),
      tags: Array.isArray(tags) ? tags.filter(Boolean).slice(0, 20) : [],
      zone: classifyZone({ kind, tags, zone }),
      importance: imp,
      emotion: emo,
      valence: clamp(Number(valence) || 0, -1, 1),
      source: source || null,
      createdAt: now,
      lastAccess: now,
      accessCount: 0,
      baseStrength: initial,
      state: 'active',
      pinned: Boolean(pinned),
      meta: meta || {},
    };
    this.state.items.push(item);
    this.enforceCapacity();
    this.dirty = true;
    this.chainEvent('add', item);
    return item;
  }

  /** 写哈希链事件（失败不影响记忆写入本身；锁竞争时重试，最终失败会记账） */
  chainEvent(type, item) {
    if (!item || !item.id) return;
    const hash = contentHashOf(item);
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        appendEvent(this.dir, { type, id: item.id, contentHash: hash });
        return;
      } catch (error) {
        lastError = error;
        const until = Date.now() + 150 * (attempt + 1);
        while (Date.now() < until) { /* 短暂退避 */ }
      }
    }
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), type, id: item.id, error: String(lastError?.message || lastError) });
      fs.appendFileSync(path.join(this.dir, 'chain-errors.log'), line + '\n', 'utf8');
    } catch {
      /* 记账失败也不影响记忆功能 */
    }
  }

  addBatch(list = []) {
    return list.map((entry) => this.add(entry));
  }

  getById(id) {
    return this.state.items.find((it) => it.id === id) || null;
  }

  /** 容量满时：淘汰「当前强度最弱」的非 pinned 记忆（模拟有限记忆容量）。 */
  enforceCapacity() {
    const max = this.config.maxItems;
    while (this.state.items.length > max) {
      let weakest = null;
      let weakestStrength = Infinity;
      for (const it of this.state.items) {
        if (it.pinned) continue;
        const s = decayedStrength(it, this.now, this.config.decay);
        if (s < weakestStrength) {
          weakestStrength = s;
          weakest = it;
        }
      }
      if (!weakest) break;
      this.state.items = this.state.items.filter((it) => it !== weakest);
      this.chainEvent('forget', weakest);
      this.dirty = true;
    }
  }

  touch(id) {
    const it = this.getById(id);
    if (!it) return null;
    it.lastAccess = this.now;
    this.dirty = true;
    return it;
  }

  archive(id) {
    const it = this.getById(id);
    if (!it) return null;
    it.state = 'archived';
    it.meta = { ...(it.meta || {}), archivedAt: this.now };
    this.dirty = true;
    this.chainEvent('archive', it);
    return it;
  }

  remove(id) {
    const removed = this.state.items.filter((it) => it.id === id);
    const before = this.state.items.length;
    this.state.items = this.state.items.filter((it) => it.id !== id);
    this.dirty = this.state.items.length !== before;
    for (const it of removed) this.chainEvent('forget', it);
    return before - this.state.items.length;
  }

  /**
   * 衰减维护：把衰减到阈值以下的记忆归档 / 彻底清掉。
   * @returns {{archived:number, purged:number}}
   */
  maintain(now = this.now, { flush = true } = {}) {
    const cfg = this.config.decay;
    let archived = 0;
    let purged = 0;
    const archivedItems = [];
    const purgedItems = [];
    for (const it of this.state.items) {
      if (it.pinned) continue;
      const s = decayedStrength(it, now, cfg);
      if (it.state === 'active' && s < cfg.forgetThreshold) {
        it.state = 'archived';
        it.meta = { ...(it.meta || {}), archivedAt: now, archivedStrength: Math.round(s * 1000) / 1000 };
        archived++;
        archivedItems.push(it);
      } else if (it.state === 'archived' && s < cfg.purgeThreshold) {
        it.state = 'purged';
        purged++;
        purgedItems.push(it);
      }
    }
    if (purged) this.state.items = this.state.items.filter((it) => it.state !== 'purged');
    for (const it of archivedItems) this.chainEvent('archive', it);
    for (const it of purgedItems) this.chainEvent('forget', it);
    if (archived || purged) this.dirty = true;
    if (flush && this.dirty) this.flush();
    return { archived, purged };
  }

  stats(now = this.now) {
    const items = this.state.items;
    const active = items.filter((it) => it.state === 'active');
    const archived = items.filter((it) => it.state === 'archived');
    const byKind = {};
    for (const it of active) byKind[it.kind] = (byKind[it.kind] | 0) + 1;
    const byChat = {};
    for (const it of active) {
      const chat = it.source?.chat || 'global';
      byChat[chat] = (byChat[chat] | 0) + 1;
    }
    const avgStrength = active.length
      ? active.reduce((s, it) => s + decayedStrength(it, now, this.config.decay), 0) / active.length
      : 0;
    return {
      total: items.length,
      active: active.length,
      archived: archived.length,
      pinned: active.filter((it) => it.pinned).length,
      byKind,
      byChat,
      avgStrength: Math.round(avgStrength * 1000) / 1000,
      lastConsolidation: this.state.lastConsolidation,
      capacity: this.config.maxItems,
    };
  }

  flush() {
    atomicWriteJson(this.file, this.state);
    this.dirty = false;
    return this;
  }

  /** 从磁盘重新载入状态（多进程共用同一个记忆文件时，写前必须先重载）。 */
  reload() {
    const raw = readJson(this.file, null);
    if (raw && typeof raw === 'object' && raw.version === SCHEMA_VERSION) {
      this.state = raw;
      if (!Array.isArray(this.state.items)) this.state.items = [];
      this.dirty = false;
    }
    return this;
  }

  /**
   * 跨进程「读-改-写」临界区：加锁 → 重载 → 执行 → 落盘 → 解锁。
   * MCP server 的每个工具调用都走这里，避免多个会话的 MCP 进程互相覆盖记忆。
   */
  withLock(fn) {
    const release = acquireLock(`${this.file}.lock`);
    try {
      this.reload();
      const result = fn();
      if (this.dirty) this.flush();
      return result;
    } finally {
      release.release();
    }
  }

  close() {
    if (this.dirty) this.flush();
    return this;
  }
}

export function openMemory(opts = {}) {
  return new MemoryStore(opts);
}
