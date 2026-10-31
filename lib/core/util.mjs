import fs from 'node:fs';
import path from 'node:path';

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function uid(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 文本 → 特征集合。
 * 中文按 二元组（bigram）切（「喜欢火锅」→ {喜欢, 欢火, 火锅}），
 * 英文/数字按整词切。用于相似度与线索检索，不依赖分词器。
 */
export function featuresOf(text = '') {
  const s = String(text || '').toLowerCase();
  const feats = new Set();
  const runs = s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9_]+/g) || [];
  for (const run of runs) {
    if (CJK_RE.test(run)) {
      if (run.length === 1) {
        feats.add(run);
      } else {
        for (let i = 0; i + 1 < run.length; i++) feats.add(run.slice(i, i + 2));
      }
    } else if (run.length > 1) {
      feats.add(run);
    }
  }
  return feats;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 中文按句切分：。！？!?；; 换行 都是句界。 */
export function splitSentences(text = '') {
  return String(text || '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function round(x, digits = 4) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * 跨进程互斥文件锁（基于 O_EXCL 独占创建）。
 *
 * 为什么需要：DSH 会为**每个会话**各起一个 memory MCP 进程，多个进程共用同一个
 * memory.json。没有锁时「读旧快照 → 写回」会互相覆盖，表现为记忆凭空消失。
 * 锁文件超过 10 秒未释放视为僵尸锁（进程崩溃残留），直接清掉。
 */
export function acquireLock(lockPath, { timeoutMs = 5000, retryMs = 40, staleMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      return {
        release() {
          try { fs.closeSync(fd); } catch {}
          try { fs.unlinkSync(lockPath); } catch {}
        },
        // 长驻进程持锁时定期 touch，避免被别的进程判定为僵尸锁
        touch() {
          try {
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
          } catch { /* 锁已不在，忽略 */ }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // 僵尸锁清理
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* 锁已被别人释放，重试 */ }
      const until = Date.now() + retryMs;
      while (Date.now() < until) { /* 小自旋等待 */ }
    }
  }
  throw new Error(`memory store is locked (timeout ${timeoutMs}ms): ${lockPath}`);
}

/** 粗略字符预算 → 估算 token（中文 1 字 ≈ 1 token，英文约 0.3 token/字符）。 */
export function estimateTokens(chars) {
  return Math.ceil(chars * 1.05);
}
