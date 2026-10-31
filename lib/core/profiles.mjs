// QQ 用户人物画像库：从记忆库（dsh-memory 的 episodic 记忆）聚合出每个 QQ 用户的画像。
//
// 画像内容（全部由本地统计推导，不调用模型，零 token 成本）：
//   - 身份：QQ 号、常见昵称、首次/最近出现、消息数、活跃会话
//   - 活跃时段：按小时分布取 top 时段
//   - 话题偏好：高频词（中文二元组 + 英文词），去停用词
//   - 语气特征：平均消息长度、问句率、感叹率、情绪词密度、表情/图片使用
//   - 重要语录：该用户高重要性记忆里摘 3 条
//   - 常出没的群：按消息数排序的会话列表
//
// 画像带「置信度」：消息数太少时明确标注「样本不足」，避免 AI 拿假画像当真。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { featuresOf, acquireLock } from './util.mjs';
import { MemoryStore } from './store.mjs';
import { resolveDataDir } from './datadir.mjs';
import { appendEvent, contentHashOf } from './chain.mjs';

const SCHEMA_VERSION = 1;

const STOP_WORDS = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '这个', '那个', '什么', '怎么',
  '可以', '没有', '不是', '还是', '但是', '因为', '所以', '现在', '今天', '昨天', '明天', '一个',
  '感觉', '哈哈', '哈哈', '真的', '就是', '然后', '如果', '已经', '这样', '那样', '自己', '知道',
  '东西', '时候', '出来', '过来', '一下', '有点', '还有', '一起', '看看', '知道', '觉得', '可能',
  '应该', '不会', '不要', '需要', '看到', '听到', '说话', '一点', '几个', '这种', '那种', '如何',
  '为什么', '哪里', '是谁', '好吧', '行吧', '嗯', '哦', '啊', '呀', '吧', '呢', '了', '在', '有',
  '是', '的', '和', '就', '都', '也', '要', '会', '去', '来', '说', '看', '想', '给', '对',
]);

const EMOTION_WORDS = ['哈哈', '笑死', '哭', '难过', '生气', '烦', '崩溃', '绝了', '牛', '卧槽', '好耶',
  '开心', '呜呜', '无语', '喜欢', '讨厌', '爱', '恨', '怕', '紧张', '焦虑', '激动', '感动', '委屈',
  '尴尬', '气死', '破防', '离谱', '爽', '疼', '笑'];

const POSITIVE_WORDS = ['开心', '好耶', '喜欢', '爱', '笑', '牛', '绝了', '爽', '哈哈'];
const NEGATIVE_WORDS = ['难过', '生气', '烦', '崩溃', '哭', '讨厌', '恨', '怕', '焦虑', '委屈', '尴尬',
  '气死', '烦死', '破防', '难受', '操', '草', '无语'];

// 虚词/代词/语气字符：中文二元组里只要含这些字，基本就是「那你」「这是」这类碎片，不是话题词。
const FUNCTION_CHARS = new Set(
  '的了是在有我你他她它们吗呢吧啊呀哦嗯就都也要会去来说看想给对这那什么怎为可以没不很非常个一上下中大小多少点些样里外前后怎么谁哪'.split(''),
);

function expandHome(p, home) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export function profilesDir(memoryDir) {
  return expandHome(memoryDir || resolveDataDir(), os.homedir());
}

function loadMemoryItems(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
    return (data.items || []).filter((it) => it.state === 'active');
  } catch {
    return [];
  }
}

function stripName(text) {
  return String(text || '').replace(/^\[[^\]]+\]\s*/, '');
}

function nameFromText(text) {
  const m = /^\[([^\]]+)\]\s*/.exec(String(text || ''));
  return m ? m[1] : '';
}

/** 中文二元组 + 英文词 → 词频（去掉停用词、纯数字、单字、以及含虚词的碎片） */
function topicCounts(texts) {
  const counts = new Map();
  for (const text of texts) {
    const feats = featuresOf(text);
    for (const f of feats) {
      if (f.length < 2) continue;
      if (/^\d+$/.test(f)) continue;
      if (STOP_WORDS.has(f)) continue;
      // 「那你」「这是」「是你」这类含虚词字符的碎片不是话题词
      let hasFunctionChar = false;
      for (const ch of f) {
        if (FUNCTION_CHARS.has(ch)) { hasFunctionChar = true; break; }
      }
      if (hasFunctionChar) continue;
      counts.set(f, (counts.get(f) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word, count]) => ({ word, count }));
}

function topHours(items) {
  const byHour = new Array(24).fill(0);
  for (const it of items) {
    const ts = it.source?.ts ?? it.createdAt ?? 0;
    if (!ts) continue;
    const h = new Date(ts).getHours();
    byHour[h]++;
  }
  const total = byHour.reduce((a, b) => a + b, 0) || 1;
  const ranked = byHour.map((c, h) => ({ h, c })).sort((a, b) => b.c - a.c);
  const kept = ranked.filter((x) => x.c > 0).slice(0, 3).map((x) => ({
    hour: x.h,
    share: Math.round((x.c / total) * 100),
  }));
  return { ranked: kept, byHour };
}

function buildUser(qq, items) {
  const texts = items.map((it) => stripName(it.text)).filter(Boolean);
  const names = new Map();
  const chats = new Map();
  let emotionHits = 0;
  let positive = 0;
  let negative = 0;
  let questions = 0;
  let exclaims = 0;
  let images = 0;
  let totalChars = 0;
  let firstSeen = Infinity;
  let lastSeen = 0;

  for (const it of items) {
    const name = nameFromText(it.text);
    if (name) names.set(name, (names.get(name) || 0) + 1);
    const chat = it.source?.chat || (it.tags || []).find((t) => t.startsWith('chat:')) || 'unknown';
    chats.set(chat, (chats.get(chat) || 0) + 1);
    const text = stripName(it.text);
    totalChars += text.length;
    if (/[？?]/.test(text)) questions++;
    if (/[！!]/.test(text)) exclaims++;
    if (/\[图片\]|\[表情\]/.test(text)) images++;
    for (const w of EMOTION_WORDS) if (text.includes(w)) { emotionHits++; break; }
    if (POSITIVE_WORDS.some((w) => text.includes(w))) positive++;
    if (NEGATIVE_WORDS.some((w) => text.includes(w))) negative++;
    const ts = it.source?.ts ?? it.createdAt ?? 0;
    if (ts) { firstSeen = Math.min(firstSeen, ts); lastSeen = Math.max(lastSeen, ts); }
  }

  const msgCount = items.length;
  const topNames = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  const displayName = topNames[0] || qq;
  const { ranked, byHour } = topHours(items);

  const avgLen = msgCount ? Math.round(totalChars / msgCount) : 0;
  const questionRate = msgCount ? Math.round((questions / msgCount) * 100) : 0;
  const exclaimRate = msgCount ? Math.round((exclaims / msgCount) * 100) : 0;
  const imageRate = msgCount ? Math.round((images / msgCount) * 100) : 0;
  const emotionRate = msgCount ? Math.round((emotionHits / msgCount) * 100) : 0;

  let tone = '中性';
  if (positive > negative * 1.5 && positive >= 2) tone = '偏积极/爱开玩笑';
  else if (negative > positive * 1.5 && negative >= 2) tone = '偏吐槽/情绪化';
  else if (questionRate >= 30) tone = '爱提问/好奇';

  const topicWords = topicCounts(texts).map((t) => t.word);
  const quotes = items
    .slice()
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .slice(0, 3)
    .map((it) => ({ text: stripName(it.text).slice(0, 80), importance: it.importance ?? 0 }));

  const chatList = [...chats.entries()].sort((a, b) => b[1] - a[1]).map(([chat, count]) => ({ chat, count }));

  // 置信度：样本量决定画像可信度
  const confidence = msgCount >= 30 ? 'high' : msgCount >= 8 ? 'medium' : 'low';
  const confidenceNote = msgCount >= 30 ? '样本充足' : msgCount >= 8 ? '样本一般' : '样本不足，画像仅供参考';

  const summaryParts = [];
  summaryParts.push(`${displayName}（${qq}）共 ${msgCount} 条消息，活跃于 ${chatList.length} 个会话`);
  if (ranked.length) summaryParts.push(`常活跃时段约 ${ranked.map((r) => `${r.hour}点`).join('/')}`);
  if (topicWords.length) summaryParts.push(`话题偏好：${topicWords.slice(0, 4).join('、')}`);
  summaryParts.push(`语气：${tone}`);
  if (avgLen) summaryParts.push(`平均 ${avgLen} 字/条`);

  return {
    qq,
    displayName,
    names: topNames,
    messageCount: msgCount,
    firstSeenAt: firstSeen === Infinity ? null : firstSeen,
    lastSeenAt: lastSeen || null,
    chats: chatList,
    activeHours: ranked,
    hourly: byHour,
    topics: topicWords,
    tone,
    stats: {
      avgLength: avgLen,
      questionRate,
      exclaimRate,
      imageRate,
      emotionRate,
    },
    quotes,
    confidence,
    confidenceNote,
    summary: summaryParts.join('；') + '。',
    updatedAt: Date.now(),
  };
}

/**
 * 从记忆库重建全部用户画像，写入 profiles.json。
 * @returns {{builtAt:number, users:number, totalMessages:number, path:string}}
 */
export function buildProfiles({ memoryDir, now = Date.now() } = {}) {
  const dir = profilesDir(memoryDir);
  const items = loadMemoryItems(dir);
  const byUser = new Map();
  for (const it of items) {
    const tag = (it.tags || []).find((t) => t.startsWith('sender:'));
    if (!tag) continue;
    const qq = tag.slice('sender:'.length);
    if (!qq) continue;
    if (!byUser.has(qq)) byUser.set(qq, []);
    byUser.get(qq).push(it);
  }
  const users = {};
  for (const [qq, list] of byUser) {
    users[qq] = buildUser(qq, list);
  }
  const out = {
    version: SCHEMA_VERSION,
    builtAt: now,
    totalMessages: items.filter((it) => (it.tags || []).some((t) => t.startsWith('sender:'))).length,
    users: Object.values(users).sort((a, b) => b.messageCount - a.messageCount),
  };
  fs.mkdirSync(dir, { recursive: true });
  // 多机器人/多进程共用同一个 profiles.json：写入加锁，避免互相覆盖
  const lock = acquireLock(path.join(dir, 'profiles.json.lock'), { timeoutMs: 5000 });
  try {
    fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(out, null, 2), 'utf8');
  } finally {
    lock.release();
  }
  return { builtAt: now, users: out.users.length, totalMessages: out.totalMessages, path: path.join(dir, 'profiles.json') };
}

export function loadProfiles({ memoryDir } = {}) {
  const dir = profilesDir(memoryDir);
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
  } catch {
    return { version: SCHEMA_VERSION, builtAt: 0, users: [], totalMessages: 0 };
  }
}

/** 按 QQ 号 / 昵称 / 精确名字查画像 */
export function getProfile(query, { memoryDir } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const data = loadProfiles({ memoryDir });
  const users = data.users || [];
  let hit = users.find((u) => String(u.qq) === q);
  if (!hit) hit = users.find((u) => (u.names || []).includes(q) || u.displayName === q);
  if (!hit) hit = users.find((u) => (u.names || []).some((n) => n.includes(q) || q.includes(n)));
  return hit || null;
}

export function listProfiles({ memoryDir, limit = 20 } = {}) {
  const data = loadProfiles({ memoryDir });
  return {
    builtAt: data.builtAt,
    totalUsers: (data.users || []).length,
    users: (data.users || []).slice(0, limit).map((u) => ({
      qq: u.qq,
      name: u.displayName,
      messages: u.messageCount,
      tone: u.tone,
      topics: (u.topics || []).slice(0, 4),
      confidence: u.confidence,
    })),
  };
}

/** 把画像浓缩成一句可被回忆命中的记忆文本 */
export function profileMemoryText(u) {
  const bits = [`[画像] ${u.displayName}（${u.qq}）`];
  bits.push(`${u.messageCount} 条消息`);
  if (u.activeHours?.length) bits.push(`活跃于 ${u.activeHours.map((h) => `${h.hour} 点`).join('/')}`);
  if (u.topics?.length) bits.push(`话题偏好：${u.topics.slice(0, 3).join('、')}`);
  if (u.tone) bits.push(`语气：${u.tone}`);
  bits.push(`置信度：${u.confidence}`);
  if (u.quotes?.length) bits.push(`代表语录：「${u.quotes[0].text}」`);
  return bits.join('；') + '。';
}

/**
 * 定时把人物画像写回记忆库（语义记忆）：
 *   - 已存在同一 QQ 的画像记忆 → 原地更新文本/重要度/访问时间（不会堆重复条目）
 *   - 不存在 → 新增一条语义记忆
 * 这样 AI 用 memory_recall 搜「李卿」也能想起这个人是谁，而不必记得调 profile_get。
 *
 * @returns {{added:number, updated:number, total:number}}
 */
export function syncProfilesToMemory({ memoryDir, now = Date.now() } = {}) {
  const data = loadProfiles({ memoryDir });
  const users = data.users || [];
  if (!users.length) return { added: 0, updated: 0, total: 0 };

  const store = new MemoryStore({ dir: profilesDir(memoryDir), now });
  let added = 0;
  let updated = 0;
  store.withLock(() => {
    for (const u of users) {
      const tags = ['profile', `qq:${u.qq}`, `person:${u.displayName}`];
      const importance = u.confidence === 'high' ? 0.75 : u.confidence === 'medium' ? 0.6 : 0.45;
      const text = profileMemoryText(u);
      const existing = store.state.items.find(
        (it) => it.state === 'active'
          && (it.tags || []).includes('profile')
          && (it.tags || []).includes(`qq:${u.qq}`),
      );
      if (existing) {
        existing.text = text;
        existing.importance = Math.max(existing.importance ?? 0, importance);
        existing.lastAccess = now;
        existing.accessCount = (existing.accessCount | 0) + 1;
        existing.baseStrength = Math.max(existing.baseStrength ?? 0.5, importance * 0.9);
        existing.meta = { ...(existing.meta || {}), kind: 'person-profile', updatedAt: now, confidence: u.confidence };
        try {
          appendEvent(store.dir, { type: 'update', id: existing.id, contentHash: contentHashOf(existing) });
        } catch {
          /* 链写入失败不影响画像同步 */
        }
        updated++;
      } else {
        store.add({
          kind: 'semantic',
          text,
          importance,
          emotion: 0,
          tags,
          source: { chat: 'profile' },
          meta: { kind: 'person-profile', updatedAt: now, confidence: u.confidence },
        });
        added++;
      }
    }
    store.flush();
  });
  return { added, updated, total: users.length };
}
