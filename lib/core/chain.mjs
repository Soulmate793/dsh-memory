// 记忆哈希链：给记忆库加"防篡改 + 可追溯"的审计层（区块链的合理用法）
//
// 设计要点：
//   - 链上只存「事件 + 哈希」，不存原文和向量（原文/向量仍在 memory.json / 向量索引）
//   - 每条事件：seq、type(add/update/archive/forget)、id、contentHash、ts、prevHash、by、hash、sig
//   - hash = sha256(seq|type|id|contentHash|ts|prevHash|by)
//   - sig  = Ed25519(hash)，每个实例一对密钥（memory-chain-key.pem / .pub.pem）
//   - 校验：链完整性（seq 递增、prevHash 衔接、hash 重算一致）+ 每条签名 + 与 memory.json 对账
//
// 文件（默认 ~/.dsh/qq-memory/）：
//   memory-chain.jsonl      哈希链（一行一个事件）
//   memory-chain-key.pem    私钥（务必备份）
//   memory-chain-pub.pem    公钥
//   memory-chain-head.json  链头快照（可选，方便快速查看）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataDir } from './datadir.mjs';
import { acquireLock } from './util.mjs';

export function chainPaths(dir) {
  const base = dir || resolveDataDir();
  return {
    file: path.join(base, 'memory-chain.jsonl'),
    keyFile: path.join(base, 'memory-chain-key.pem'),
    pubFile: path.join(base, 'memory-chain-pub.pem'),
    headFile: path.join(base, 'memory-chain-head.json'),
  };
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 记忆内容的规范化哈希：只看"内容性"字段，不看衰减/访问次数 */
export function contentHashOf(item) {
  const tuple = [
    String(item.id || ''),
    String(item.kind || ''),
    String(item.text || ''),
    Number(item.importance ?? 0).toFixed(4),
    Number(item.emotion ?? 0).toFixed(4),
    Number(item.valence ?? 0).toFixed(4),
    String(item.state || ''),
    String(item.zone || ''),
    (item.tags || []).join('|'),
  ];
  return sha256Hex(tuple.join('\u0001'));
}

function eventHashOf(ev) {
  return sha256Hex([ev.seq, ev.type, ev.id, ev.contentHash, ev.ts, ev.prevHash, ev.by].join('|'));
}

/** 确保密钥存在；返回 { privateKey, publicKey } */
const keyCache = new Map(); // dir -> { privateKey, publicKey }

export function ensureKeys(dir) {
  const base = dir || resolveDataDir();
  const cachedKeys = keyCache.get(base);
  if (cachedKeys) return cachedKeys;
  const p = chainPaths(base);
  fs.mkdirSync(path.dirname(p.keyFile), { recursive: true });
  if (fs.existsSync(p.keyFile) && fs.existsSync(p.pubFile)) {
    const keys = {
      privateKey: crypto.createPrivateKey(fs.readFileSync(p.keyFile)),
      publicKey: crypto.createPublicKey(fs.readFileSync(p.pubFile)),
    };
    keyCache.set(base, keys);
    return keys;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(p.keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(p.pubFile, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');
  const keys = { privateKey, publicKey };
  keyCache.set(base, keys);
  return keys;
}

export function readEvents(dir) {
  const p = chainPaths(dir);
  try {
    const text = fs.readFileSync(p.file, 'utf8');
    const lines = text.split('\n');
    // 只可能是最后一行写到一半：忽略它，避免并发读误报
    if (lines.length && lines[lines.length - 1] && !lines[lines.length - 1].trim().endsWith('}')) lines.pop();
    return lines
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { parseError: true, raw: line };
        }
      });
  } catch {
    return [];
  }
}

// 读链尾的缓存：append 时不必每次解析整个文件（否则建链是 O(n²)）
const lastCache = new Map(); // dir -> { size, mtimeMs, ev }

function lastEvent(dir) {
  const base = dir || resolveDataDir();
  const p = chainPaths(base);
  let stat;
  try {
    stat = fs.statSync(p.file);
  } catch {
    return null;
  }
  const cached = lastCache.get(base);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.ev;
  let ev = null;
  try {
    const readSize = Math.min(stat.size, 16 * 1024);
    const fd = fs.openSync(p.file, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        ev = JSON.parse(lines[i]);
        break;
      } catch {
        /* 可能是半行，往前找 */
      }
    }
  } catch {
    ev = null;
  }
  lastCache.set(base, { size: stat.size, mtimeMs: stat.mtimeMs, ev });
  return ev;
}

/** 追加一条事件（自动补 seq/prevHash/签名），返回事件对象 */
export function appendEvent(dir, { type, id, contentHash, by = 'local' }) {
  const base = dir || resolveDataDir();
  const { privateKey } = ensureKeys(base);
  const p = chainPaths(base);
  // 关键：先在锁内读链尾再算 seq/prevHash。
  // 以前是先读后锁：两个进程同时读到同一链尾，各自追加 → seq 重复/断链（已发生过一次）。
  const release = acquireLock(`${p.file}.lock`, { timeoutMs: 5000 });
  try {
    lastCache.delete(base);
    const prev = lastEvent(base);
    const ev = {
      seq: prev ? (Number(prev.seq) || 0) + 1 : 1,
      type: String(type),
      id: String(id),
      contentHash: String(contentHash),
      ts: Date.now(),
      prevHash: prev ? String(prev.hash || '') : '',
      by: String(by || 'local'),
    };
    ev.hash = eventHashOf(ev);
    ev.sig = crypto.sign(null, Buffer.from(ev.hash, 'hex'), privateKey).toString('base64');
    fs.appendFileSync(p.file, JSON.stringify(ev) + '\n', 'utf8');
    // head 快照降频写入（每 25 条一次；head() 会实时读链尾）
    if (ev.seq % 25 === 0) {
      try {
        fs.writeFileSync(p.headFile, JSON.stringify({ seq: ev.seq, hash: ev.hash, ts: ev.ts }, null, 2), 'utf8');
      } catch {
        /* head 快照失败不影响链 */
      }
    }
    return ev;
  } finally {
    release.release();
  }
}

/** 校验链本身：seq 连续、prevHash 衔接、hash 重算一致、签名有效 */
export function verifyChain(dir) {
  const events = readEvents(dir);
  const p = chainPaths(dir);
  const errors = [];
  if (!events.length) return { ok: false, events: 0, headHash: '', errors: ['链为空'] };
  let publicKey = null;
  try {
    publicKey = crypto.createPublicKey(fs.readFileSync(p.pubFile));
  } catch {
    errors.push('公钥缺失或不可读');
  }
  let prevHash = '';
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.parseError) {
      errors.push(`第 ${i + 1} 行无法解析`);
      break;
    }
    if (ev.seq !== i + 1) errors.push(`seq 不连续：期望 ${i + 1}，实际 ${ev.seq}`);
    if (String(ev.prevHash || '') !== prevHash) errors.push(`第 ${ev.seq} 条 prevHash 不衔接`);
    const expectHash = eventHashOf(ev);
    if (expectHash !== ev.hash) errors.push(`第 ${ev.seq} 条 hash 不匹配（内容被改过）`);
    if (publicKey && ev.sig) {
      try {
        const ok = crypto.verify(null, Buffer.from(ev.hash, 'hex'), publicKey, Buffer.from(ev.sig, 'base64'));
        if (!ok) errors.push(`第 ${ev.seq} 条签名无效`);
      } catch {
        errors.push(`第 ${ev.seq} 条签名校验异常`);
      }
    } else if (publicKey) {
      errors.push(`第 ${ev.seq} 条缺少签名`);
    }
    prevHash = ev.hash;
    if (errors.length > 20) break;
  }
  return {
    ok: errors.length === 0,
    events: events.length,
    headHash: prevHash,
    errors: errors.slice(0, 20),
  };
}

/** 与 memory.json 对账：每条记忆的当前内容哈希是否等于链上记录的最新哈希 */
export function verifyMemory(dir, items) {
  const events = readEvents(dir);
  const latest = new Map(); // id -> {contentHash, seq, type}
  for (const ev of events) {
    if (ev.parseError) continue;
    latest.set(String(ev.id), { contentHash: ev.contentHash, seq: ev.seq, type: ev.type });
  }
  const mismatches = [];
  const unrecorded = [];
  let checked = 0;
  for (const item of items || []) {
    const id = String(item.id || '');
    if (!id) continue;
    checked++;
    const rec = latest.get(id);
    if (!rec) {
      unrecorded.push(id);
      continue;
    }
    if (rec.contentHash !== contentHashOf(item)) mismatches.push({ id, seq: rec.seq, type: rec.type });
  }
  return {
    ok: mismatches.length === 0 && unrecorded.length === 0,
    checked,
    mismatches: mismatches.slice(0, 50),
    unrecorded: unrecorded.slice(0, 50),
    mismatchedCount: mismatches.length,
    unrecordedCount: unrecorded.length,
  };
}

/** 首次建链：从当前 memory.json 的全部条目生成 add 事件（按 createdAt 排序） */
export function bootstrap(dir, items, { by = 'bootstrap' } = {}) {
  const p = chainPaths(dir);
  if (fs.existsSync(p.file) && readEvents(dir).length > 0) {
    return { skipped: true, reason: '链已存在', events: readEvents(dir).length };
  }
  const base = dir || resolveDataDir();
  const { privateKey } = ensureKeys(base);
  // 快速建链：先在内存里串好 hash + 签名，最后一次写入（避免逐条 stat/read 的开销）
  const events = [];
  let prevHash = '';
  const push = (type, id, contentHash) => {
    const ev = {
      seq: events.length + 1,
      type,
      id,
      contentHash,
      ts: Date.now(),
      prevHash,
      by,
    };
    ev.hash = eventHashOf(ev);
    ev.sig = crypto.sign(null, Buffer.from(ev.hash, 'hex'), privateKey).toString('base64');
    prevHash = ev.hash;
    events.push(ev);
    return ev;
  };
  const genesis = push('genesis', 'genesis', sha256Hex('dsh-memory-chain-v1'));
  const sorted = [...(items || [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const item of sorted) push('add', item.id, contentHashOf(item));
  fs.writeFileSync(p.file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  try {
    fs.writeFileSync(p.headFile, JSON.stringify({ seq: genesis.seq, hash: genesis.hash, ts: genesis.ts }, null, 2), 'utf8');
  } catch {
    /* head 快照失败不影响链 */
  }
  const headEv = events[events.length - 1];
  try {
    fs.writeFileSync(p.headFile, JSON.stringify({ seq: headEv.seq, hash: headEv.hash, ts: headEv.ts }, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
  return { skipped: false, genesis: genesis.hash, events: events.length };
}

export function head(dir) {
  const ev = lastEvent(dir);
  const p = chainPaths(dir);
  let size = 0;
  try {
    size = fs.statSync(p.file).size;
  } catch {
    size = 0;
  }
  return ev ? { seq: ev.seq, hash: ev.hash, ts: ev.ts, sizeBytes: size } : null;
}

/** 对账修复：把与当前 memory.json 不一致的记忆补成 add/update 事件 */
export function reconcileMemory(dir, items) {
  const events = readEvents(dir);
  const latest = new Map();
  for (const ev of events) latest.set(String(ev.id), ev);
  let added = 0;
  let updated = 0;
  for (const item of items || []) {
    if (!item?.id) continue;
    const hash = contentHashOf(item);
    const rec = latest.get(String(item.id));
    if (!rec) {
      appendEvent(dir, { type: 'add', id: item.id, contentHash: hash });
      added++;
    } else if (rec.contentHash !== hash) {
      appendEvent(dir, { type: 'update', id: item.id, contentHash: hash });
      updated++;
    }
  }
  return { added, updated };
}