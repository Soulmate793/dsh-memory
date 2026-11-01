// 关系台账：给每个聊过的人维护一份长期档案（不是聊天记录，是"关于这个人"的摘要）
//
// 数据来源：记忆库里 tags 含 profile / qq:<id> / person:<name> / sender:<id> 的活跃记忆。
// 输出：relationships.json
//   { updatedAt, people: { "<qq>": { name, profile, notes: [...], lastSeenAt } } }
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './datadir.mjs';

function loadItems(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

/** 从画像文本里取昵称： [画像] alan（2311464997）；… */
function nameOfProfile(text) {
  const m = /^\[画像\]\s*([^（(]+)/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

export function buildLedger({ memoryDir } = {}) {
  const dir = memoryDir || resolveDataDir();
  const items = loadItems(dir).filter((it) => it && it.state === 'active');
  const byPerson = new Map();

  const ensure = (qq, name = '') => {
    if (!byPerson.has(qq)) byPerson.set(qq, { name: name || '', profile: '', notes: [], lastSeenAt: 0 });
    const p = byPerson.get(qq);
    if (name && !p.name) p.name = name;
    return p;
  };

  for (const it of items) {
    const tags = it.tags || [];
    const qqTag = tags.find((t) => t.startsWith('qq:')) || tags.find((t) => t.startsWith('sender:'));
    const nameTag = tags.find((t) => t.startsWith('person:'));
    const qq = qqTag ? qqTag.split(':')[1] : '';
    if (!qq) continue;
    const name = nameTag ? nameTag.split(':')[1] : '';
    const p = ensure(qq, name);
    p.lastSeenAt = Math.max(p.lastSeenAt, it.createdAt || 0);
    if (tags.includes('profile') && it.text) {
      p.profile = String(it.text).replace(/^\[画像\]\s*/, '').slice(0, 320);
      if (!p.name) p.name = nameOfProfile(it.text);
    } else if (it.zone === 'relationship' || tags.includes('person') || tags.includes('preference') || (Number(it.importance) || 0) >= 0.55) {
      const text = String(it.text || '').replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').slice(0, 140);
      if (text && p.notes.length < 12 && !p.notes.includes(text)) p.notes.push(text);
    }
  }

  // 按最近互动排序，只保留备注里真正有内容的
  const people = {};
  for (const [qq, p] of [...byPerson.entries()].sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)) {
    if (!p.profile && !p.notes.length) continue;
    people[qq] = {
      name: p.name || qq,
      profile: p.profile,
      notes: p.notes.slice(0, 8),
      lastSeenAt: p.lastSeenAt,
    };
  }

  const out = { updatedAt: Date.now(), people };
  try {
    fs.writeFileSync(path.join(dir, 'relationships.json'), JSON.stringify(out, null, 2), 'utf8');
  } catch {
    /* 写不进去不影响运行时 */
  }
  return { ok: true, people: Object.keys(people).length, file: path.join(dir, 'relationships.json') };
}
