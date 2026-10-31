// 向量索引：记忆的语义表示（append-only 二进制，避免每次重写大文件）
//
// 文件（默认 ~/.dsh/qq-memory/）：
//   memory-vectors.bin      float32 行向量，按 ids.jsonl 的顺序排列
//   memory-vectors-ids.jsonl 每行 {id, row, at}（追加写，同一 id 以最后一行为准）
//   memory-vectors-meta.json {version, model, dim, updatedAt}
//
// 检索：向量已 L2 归一化 → 点积即余弦相似度。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './datadir.mjs';

export function vectorsPaths(dir) {
  const base = dir || resolveDataDir();
  return {
    file: path.join(base, 'memory-vectors.bin'),
    idsFile: path.join(base, 'memory-vectors-ids.jsonl'),
    metaFile: path.join(base, 'memory-vectors-meta.json'),
  };
}

export function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(vectorsPaths(dir).metaFile, 'utf8'));
  } catch {
    return null;
  }
}

/** 加载索引：返回 {model, dim, ids: [...], rows: Map<id, Float32Array>} */
export function loadIndex(dir) {
  const p = vectorsPaths(dir);
  const meta = readMeta(dir);
  if (!meta || !meta.dim) return null;
  let bin;
  try {
    bin = fs.readFileSync(p.file);
  } catch {
    return null;
  }
  const dim = Number(meta.dim);
  const rowBytes = dim * 4;
  const totalRows = Math.floor(bin.length / rowBytes);
  const rowMap = new Map(); // id -> row index
  try {
    const lines = fs.readFileSync(p.idsFile, 'utf8').split('\n').filter(Boolean);
    lines.forEach((line, i) => {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) rowMap.set(String(rec.id), Number(rec.row));
      } catch {
        /* 坏行跳过 */
      }
    });
  } catch {
    return null;
  }
  const rows = new Map();
  for (const [id, row] of rowMap) {
    if (!Number.isInteger(row) || row < 0 || row >= totalRows) continue;
    const start = row * rowBytes;
    rows.set(id, new Float32Array(bin.buffer, bin.byteOffset + start, dim));
  }
  return { model: meta.model || 'unknown', dim, count: rows.size, rows };
}

/** 追加向量（同一 id 可重复追加，加载时后写的覆盖先写的） */
export function upsertVectors(dir, entries, { model = 'BAAI/bge-small-zh-v1.5', dim = 0 } = {}) {
  const p = vectorsPaths(dir);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  let meta = readMeta(dir);
  if (!meta || !meta.dim) {
    if (!dim) dim = entries[0]?.vector?.length || 0;
    if (!dim) throw new Error('缺少向量维度');
    meta = { version: 1, model, dim, updatedAt: Date.now() };
    fs.writeFileSync(p.metaFile, JSON.stringify(meta, null, 2), 'utf8');
    fs.writeFileSync(p.file, Buffer.alloc(0));
    fs.writeFileSync(p.idsFile, '');
  }
  if (Number(meta.dim) !== Number(dim || entries[0]?.vector?.length)) {
    throw new Error(`向量维度不一致：索引 ${meta.dim}，新向量 ${dim || entries[0]?.vector?.length}`);
  }
  const rowBytes = meta.dim * 4;
  const existingRows = Math.floor((fs.existsSync(p.file) ? fs.statSync(p.file).size : 0) / rowBytes);
  const fd = fs.openSync(p.file, 'a');
  const idLines = [];
  let row = existingRows;
  const capacity = fs.statSync(p.file).size;
  const chunk = Buffer.alloc(entries.length * rowBytes);
  let offset = 0;
  for (const entry of entries) {
    const vec = entry.vector;
    if (!Array.isArray(vec) || vec.length !== meta.dim) continue;
    for (let i = 0; i < meta.dim; i++) {
      chunk.writeFloatLE(Number(vec[i]) || 0, offset + i * 4);
    }
    offset += rowBytes;
    idLines.push(JSON.stringify({ id: String(entry.id), row, at: Date.now() }));
    row++;
  }
  try {
    if (offset > 0) fs.writeSync(fd, chunk, 0, offset);
    if (idLines.length) fs.appendFileSync(p.idsFile, idLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(p.metaFile, JSON.stringify({ ...meta, updatedAt: Date.now() }, null, 2), 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return { appended: idLines.length, startRow: existingRows, capacity };
}

/** 向量检索：返回 [{id, score}]（点积 = 余弦，因为入库时已归一化） */
export function searchVectors(index, queryVector, { topK = 200, allowedIds = null } = {}) {
  if (!index || !Array.isArray(queryVector) || queryVector.length !== index.dim) return [];
  const q = queryVector;
  const scored = [];
  for (const [id, row] of index.rows) {
    if (allowedIds && !allowedIds.has(id)) continue;
    let dot = 0;
    for (let i = 0; i < index.dim; i++) dot += row[i] * q[i];
    scored.push({ id, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}

export function vectorStats(dir) {
  const meta = readMeta(dir);
  if (!meta) return { exists: false };
  const p = vectorsPaths(dir);
  const rowBytes = Number(meta.dim) * 4;
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(p.file).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    exists: true,
    model: meta.model,
    dim: meta.dim,
    rows: Math.floor(sizeBytes / rowBytes),
    sizeBytes,
    updatedAt: meta.updatedAt,
  };
}
