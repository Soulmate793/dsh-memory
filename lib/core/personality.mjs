// 成长式性格模块：性格不是写死的，而是随互动经历慢慢长出来的。
//
// 设计（对照「养成」逻辑）：
//   - 六维性格：活泼 liveliness / 幽默 humor / 毒舌 sharpness / 温柔 warmth / 好奇 curiosity / 依赖 attachment
//   - 习惯：夜猫子 nightOwl
//   - 心情 mood：valence(-1~1) + energy(0~1)，逐次被互动推动、逐 tick 回落
//   - 好感度 relations：每个群友/会话一条，互动 + 亲近
//   - 成长：xp 累计，分阶段「鱼苗 → 小鱼 → 大肥鱼 → 锦鲤 → 龙王」
//   - 沉淀：定期生成「自我认知」写回记忆库 + 成长日记
//
// 性格会「成型」：每个成长 tick 都向 0.5 缓慢回归（性格引力），
// 只有持续的经历才会把它推离基线——这和人的性格养成一样。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, clamp } from './util.mjs';
import { MemoryStore } from './store.mjs';
import { resolveDataDir } from './datadir.mjs';
import { appendEvent, contentHashOf } from './chain.mjs';

const SCHEMA_VERSION = 1;

export const STAGES = [
  { id: 'fry', name: '鱼苗', xp: 0 },
  { id: 'fish', name: '小鱼', xp: 150 },
  { id: 'big', name: '大肥鱼', xp: 500 },
  { id: 'koi', name: '锦鲤', xp: 1500 },
  { id: 'dragon', name: '龙王', xp: 4000 },
];

export const DEFAULT_TRAITS = {
  liveliness: 0.5,
  humor: 0.5,
  sharpness: 0.25,
  warmth: 0.5,
  curiosity: 0.5,
  attachment: 0.5,
  nightOwl: 0.3,
};

const TRAIT_LABELS = {
  liveliness: '活泼',
  humor: '幽默',
  sharpness: '毒舌',
  warmth: '温柔',
  curiosity: '好奇',
  attachment: '黏人',
  nightOwl: '夜猫子',
};

const POSITIVE = ['谢谢', '喜欢', '爱你', '好鱼', '真棒', '厉害', '可爱', '聪明', '好的', '谢谢啦'];
const NEGATIVE = ['讨厌', '滚', '闭嘴', '傻', '菜', '笨', '烦', '垃圾', '无语', '不行'];
const HUMOR = ['哈哈', '笑死', '梗', '搞笑', '乐', '嘻嘻', '233', '😄', '😂'];
const SHARP = ['怼', '嘴硬', '阴阳', '怼回去', '损', '毒舌', '哼'];

export function expandHomeDir(memoryDir) {
  const dir = memoryDir || resolveDataDir();
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

function personalityFile(memoryDir) {
  return path.join(expandHomeDir(memoryDir), 'personality.json');
}

function defaultPersonality(now) {
  return {
    version: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    xp: 0,
    stage: 'fry',
    mood: { valence: 0, energy: 0.5, updatedAt: now },
    traits: { ...DEFAULT_TRAITS },
    relations: {},
    diary: [],
    counters: { messages: 0, lastTickAt: 0 },
  };
}

export function loadPersonality({ memoryDir, now = Date.now() } = {}) {
  const file = personalityFile(memoryDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === SCHEMA_VERSION) {
      return {
        ...defaultPersonality(now),
        ...raw,
        traits: { ...DEFAULT_TRAITS, ...(raw.traits || {}) },
        mood: { ...defaultPersonality(now).mood, ...(raw.mood || {}) },
        relations: raw.relations || {},
        diary: Array.isArray(raw.diary) ? raw.diary : [],
      };
    }
  } catch {
    /* 没文件或损坏 → 用默认 */
  }
  return defaultPersonality(now);
}

export function savePersonality(p, { memoryDir } = {}) {
  const dir = expandHomeDir(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(personalityFile(memoryDir), JSON.stringify(p, null, 2), 'utf8');
  return p;
}

function withLock(memoryDir, fn) {
  const dir = expandHomeDir(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  const lock = acquireLock(path.join(dir, 'personality.lock'), { timeoutMs: 3000 });
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** 当前阶段 → { stage, index, nextXp } */
export function stageOf(p) {
  let index = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (p.xp >= STAGES[i].xp) index = i;
  }
  const cur = STAGES[index];
  const next = STAGES[index + 1] || null;
  return { stage: cur, index, next, nextXp: next ? next.xp : null };
}

function moodText(valence) {
  if (valence > 0.4) return '心情很好';
  if (valence > 0.1) return '心情不错';
  if (valence > -0.1) return '心情平静';
  if (valence > -0.4) return '有点闷';
  return '心情不太好';
}

function traitPhrase(p) {
  const t = p.traits;
  const bits = [];
  if (t.liveliness >= 0.62) bits.push('挺活泼');
  else if (t.liveliness <= 0.38) bits.push('偏安静');
  if (t.humor >= 0.62) bits.push('爱开玩笑');
  if (t.sharpness >= 0.55) bits.push('嘴硬爱怼');
  else if (t.sharpness <= 0.3) bits.push('不毒舌、不怼人');
  if (t.warmth >= 0.62) bits.push('心软');
  if (t.warmth >= 0.75 && t.attachment >= 0.6) bits.push('爱撒娇');
  if (t.curiosity >= 0.62) bits.push('好奇');
  if (t.attachment >= 0.62) bits.push('黏人');
  if (t.nightOwl >= 0.6) bits.push('夜猫子');
  return bits.length ? bits.join('、') : '性格还在成型中';
}

/** 性格 → 一段可直接注入/自述的文字 */
export function personalityPrompt(p) {
  const { stage, nextXp } = stageOf(p);
  const xpText = nextXp ? `${p.xp}/${nextXp}` : `${p.xp}`;
  const top = Object.entries(p.relations)
    .sort((a, b) => (b[1]?.affinity ?? 0) - (a[1]?.affinity ?? 0))[0];
  const bits = [];
  bits.push(`【我的性格】我是「大肥鱼」，现在是「${stage.name}」阶段（成长值 ${xpText}）。`);
  bits.push(`性格倾向：${traitPhrase(p)}。`);
  bits.push(`最近心情：${moodText(p.mood.valence)}。`);
  if (top) bits.push(`最常互动的是 ${top[1]?.name || top[0]}（亲近度 ${(top[1]?.affinity ?? 0).toFixed(2)}）。`);
  bits.push('这些是长期经历长出来的性格，按它去说话，不要刻意报参数。');
  return bits.join('');
}

/** 记录一次互动（群/私聊消息），推动性格成长 */
export function observeInteraction({ memoryDir, sender = '', name = '', chat = '', text = '', isBot = false, ts = Date.now() } = {}) {
  if (isBot) return null;
  return withLock(memoryDir, () => {
    const p = loadPersonality({ memoryDir, now: ts });
    const t = p.traits;
    const lower = String(text || '').toLowerCase();

    // xp：每条消息 +1；提到/at 到机器人 +2
    let xpGain = 1;
    if (/大肥鱼|deepseek|@\S+/.test(text) || /大肥鱼/i.test(lower)) xpGain += 1;
    p.xp += xpGain;
    p.counters.messages = (p.counters.messages || 0) + 1;

    // 心情 & 性格微调
    const hasPositive = POSITIVE.some((w) => text.includes(w));
    const hasNegative = NEGATIVE.some((w) => text.includes(w));
    if (hasPositive) {
      t.warmth = clamp(t.warmth + 0.004, 0, 1);
      p.mood.valence = clamp(p.mood.valence + 0.03, -1, 1);
    }
    if (hasNegative) {
      t.sharpness = clamp(t.sharpness + 0.0004, 0, 1);
      p.mood.valence = clamp(p.mood.valence - 0.04, -1, 1);
    }
    if (HUMOR.some((w) => text.includes(w))) t.humor = clamp(t.humor + 0.004, 0, 1);
    if (SHARP.some((w) => text.includes(w))) t.sharpness = clamp(t.sharpness + 0.003, 0, 1);
    if (/[？?]/.test(text) || text.includes('为什么') || text.includes('怎么')) t.curiosity = clamp(t.curiosity + 0.002, 0, 1);
    if (/[！!]/.test(text) || text.length > 40) t.liveliness = clamp(t.liveliness + 0.002, 0, 1);
    const hour = new Date(ts).getHours();
    if (hour < 6) t.nightOwl = clamp(t.nightOwl + 0.006, 0, 1);

    // 好感度
    if (sender) {
      const rel = p.relations[sender] || { name: name || sender, affinity: 0.2, interactions: 0, lastAt: 0 };
      rel.name = name || rel.name || sender;
      rel.affinity = clamp((rel.affinity ?? 0.2) + (hasPositive ? 0.02 : 0.005), 0, 1);
      rel.interactions = (rel.interactions || 0) + 1;
      rel.lastAt = ts;
      p.relations[sender] = rel;
      // 关系表有界：只留最近互动最多的 200 人
      const keys = Object.keys(p.relations);
      if (keys.length > 200) {
        keys.sort((a, b) => (p.relations[a]?.lastAt ?? 0) - (p.relations[b]?.lastAt ?? 0));
        for (const k of keys.slice(0, keys.length - 200)) delete p.relations[k];
      }
    }

    p.mood.energy = clamp(p.mood.energy + 0.01, 0, 1);
    p.updatedAt = ts;
    // 阶段自动升级
    const { stage } = stageOf(p);
    if (stage.id !== p.stage) {
      p.stage = stage.id;
      p.diary.push({
        at: ts,
        text: `成长：进入「${stage.name}」阶段（成长值 ${p.xp}）`,
      });
      if (p.diary.length > 30) p.diary = p.diary.slice(-30);
    }
    savePersonality(p, { memoryDir });
    return { xp: p.xp, stage: p.stage };
  });
}

/**
 * 成长 tick：性格向基线回归、心情回落、好感度轻微衰减、补成长日记。
 * @returns {{stage:string, xp:number, upgraded:boolean}}
 */
export function growPersonality({ memoryDir, now = Date.now() } = {}) {
  return withLock(memoryDir, () => {
    const p = loadPersonality({ memoryDir, now });
    const before = stageOf(p).stage.id;

    // 性格引力：向 0.5 缓慢回归（性格会成型，只有持续经历才能改变它）
    for (const key of Object.keys(DEFAULT_TRAITS)) {
      const base = key === 'sharpness' ? 0.35 : key === 'attachment' ? 0.4 : key === 'nightOwl' ? 0.3 : 0.5;
      p.traits[key] = clamp(p.traits[key] + (base - p.traits[key]) * 0.004, 0, 1);
    }
    // 心情回落；energy 回落
    p.mood.valence = clamp(p.mood.valence * 0.96, -1, 1);
    p.mood.energy = clamp(p.mood.energy * 0.98, 0, 1);
    // 好感度缓慢衰减（久不互动关系会淡）
    for (const rel of Object.values(p.relations)) {
      rel.affinity = clamp((rel.affinity ?? 0.2) * 0.999, 0, 1);
    }

    // 阶段推进
    const stage = stageOf(p).stage;
    p.stage = stage.id;
    const upgraded = before !== stage.id;
    if (upgraded) {
      p.diary.push({ at: now, text: `成长：进入「${stage.name}」阶段（成长值 ${p.xp}）` });
    }
    // 每 6 小时补一条成长日记
    const lastDiary = p.diary[p.diary.length - 1]?.at ?? 0;
    if (now - lastDiary > 6 * 3600_000) {
      const top = Object.entries(p.relations).sort((a, b) => (b[1]?.affinity ?? 0) - (a[1]?.affinity ?? 0))[0];
      p.diary.push({
        at: now,
        text: `这阵子${traitPhrase(p)}${top ? `，和 ${top[1]?.name || top[0]} 最亲近` : ''}（成长值 ${p.xp}）`,
      });
    }
    if (p.diary.length > 30) p.diary = p.diary.slice(-30);
    p.updatedAt = now;
    p.counters.lastTickAt = now;
    savePersonality(p, { memoryDir });
    return { stage: p.stage, xp: p.xp, upgraded };
  });
}

/** 把「自我认知」写回记忆库（更新同一条，不堆重复） */export function writePersonalityMemory({ memoryDir, now = Date.now() } = {}) {
  const dir = expandHomeDir(memoryDir);
  const p = loadPersonality({ memoryDir, now });
  const { stage } = stageOf(p);
  const text = `[性格] ${personalityPrompt(p)}`;
  const store = new MemoryStore({ dir, now });
  let updated = false;
  store.withLock(() => {
    const existing = store.state.items.find((it) => it.state === 'active' && (it.tags || []).includes('personality'));
    if (existing) {
      existing.text = text;
      existing.lastAccess = now;
      existing.accessCount = (existing.accessCount | 0) + 1;
      existing.importance = 0.7;
      existing.baseStrength = Math.max(existing.baseStrength ?? 0.5, 0.63);
      existing.meta = { ...(existing.meta || {}), kind: 'personality', updatedAt: now, stage: stage.id, xp: p.xp };
      try {
        appendEvent(store.dir, { type: 'update', id: existing.id, contentHash: contentHashOf(existing) });
      } catch {
        /* 链写入失败不影响性格写回 */
      }
      updated = true;
    } else {
      store.add({
        kind: 'semantic',
        text,
        importance: 0.7,
        emotion: 0,
        tags: ['personality', 'self'],
        source: { chat: 'personality' },
        meta: { kind: 'personality', updatedAt: now, stage: stage.id, xp: p.xp },
      });
    }
    store.flush();
  });
  return { updated, text };
}

/** 重置性格（谨慎使用） */
export function resetPersonality({ memoryDir, now = Date.now() } = {}) {
  return savePersonality(defaultPersonality(now), { memoryDir });
}

/**
 * 用记忆库里的历史消息回填性格（首次接入时用一次，之后由记录器实时累积）。
 * 只在性格的互动计数为 0 时执行（幂等，重复调用不会重复回填）。
 * @returns {{seeded:boolean, messages:number}}
 */
export function seedPersonalityFromMemory({ memoryDir, now = Date.now() } = {}) {
  const existing = loadPersonality({ memoryDir, now });
  if ((existing.counters?.messages ?? 0) > 0) return { seeded: false, messages: 0 };
  const dir = expandHomeDir(memoryDir);
  let items = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
    items = (raw.items || []).filter(
      (it) => it.state === 'active' && (it.tags || []).some((t) => t.startsWith('sender:')),
    );
  } catch {
    return { seeded: false, messages: 0 };
  }
  items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const it of items) {
    const sender = (it.tags || []).find((t) => t.startsWith('sender:'))?.slice(7) || '';
    const nameMatch = /^\[([^\]]+)\]\s*/.exec(String(it.text || ''));
    const text = String(it.text || '').replace(/^\[[^\]]+\]\s*/, '');
    const chat = it.source?.chat || '';
    const ts = it.source?.ts ?? it.createdAt ?? now;
    try {
      observeInteraction({ memoryDir, sender, name: nameMatch ? nameMatch[1] : sender, chat, text, ts });
    } catch {
      /* 单条失败不影响整体回填 */
    }
  }
  return { seeded: items.length > 0, messages: items.length };
}

export { TRAIT_LABELS };
