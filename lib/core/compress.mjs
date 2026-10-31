// 上下文压缩：在有限字数预算里拼出「人类式记忆上下文」。
//
// 结构（按优先级）：
//   1. 最近原文（recentRawChars 预算）——刚发生的事记得最清楚
//   2. 历史摘要（summaryChars 预算）——抽取式摘要：从旧消息里挑最「有信息量」的句子
//   3. 相关记忆（maxMemories 预算）——被当前话题唤醒的长期记忆
//
// 摘要不是调模型，而是抽取式：按「与当前话题的重叠度 + 数字/问句/情绪词」打分挑句子，
// 所以零 token 成本、可离线跑。需要更高质量时可把摘要块替换成模型 summary。
import { splitSentences, featuresOf, jaccard, clamp } from './util.mjs';
import { recall } from './recall.mjs';

const EMOTION_WORDS = [
  '哈哈', '笑死', '哭', '难过', '生气', '烦死了', '崩溃', '绝了', '牛', '卧槽', '好耶',
  '开心', '呜呜', '无语', '喜欢', '讨厌', '爱', '恨', '怕', '紧张', '焦虑', '激动',
  '感动', '委屈', '尴尬', '气死', '草', '靠', '6', '666', '破防', '离谱', '爽', '疼',
];

function sentenceSalience(sentence, qFeat, position, totalChunks, isUser) {
  const f = featuresOf(sentence);
  let overlap = 0;
  for (const x of qFeat) if (f.has(x)) overlap++;
  const relevance = qFeat.size ? overlap / Math.sqrt(qFeat.size * Math.max(1, f.size)) : 0;
  const digits = /\d/.test(sentence) ? 0.15 : 0;
  const question = /[？?]/.test(sentence) ? 0.12 : 0;
  const emotion = EMOTION_WORDS.some((w) => sentence.includes(w)) ? 0.15 : 0;
  const lengthPenalty = sentence.length > 80 ? 0.1 : 0;
  const recencyBias = totalChunks > 1 ? 0.15 * (position / (totalChunks - 1)) : 0;
  const userBias = isUser ? 0.06 : 0;
  return relevance + digits + question + emotion + recencyBias + userBias - lengthPenalty;
}

function fmtLine(role, text) {
  return `${role === 'user' ? '用户' : '助手'}: ${String(text).replace(/\s+/g, ' ').trim()}`;
}

/**
 * @param {import('./store.mjs').MemoryStore} store
 * @param {object} opts
 * @param {Array<{role:'user'|'assistant', text:string, ts?:number}>} opts.messages 完整对话历史
 * @param {number} [opts.budgetChars] 输出上下文总预算（字符）
 * @param {string} [opts.query] 当前话题（用于召回记忆与摘要打分）
 * @param {string} [opts.chat] 会话标识（用于给长期记忆打标签）
 */
export function compressContext(store, {
  messages = [],
  budgetChars = null,
  query = '',
  chat = '',
} = {}) {
  const t = store.now;
  const cfg = store.config.compress;
  const budget = Math.max(400, Number(budgetChars) || cfg.budgetChars);
  const all = messages
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text ?? ''), ts: m.ts ?? t }))
    .filter((m) => m.text.trim());
  const inputChars = all.reduce((s, m) => s + m.text.length, 0);

  if (!all.length) {
    return {
      text: '',
      stats: { inputChars: 0, outputChars: 0, ratio: 0, keptRawMessages: 0, summarySentences: 0, memoryCount: 0, budgetChars: budget },
    };
  }

  const lastUser = [...all].reverse().find((m) => m.role === 'user');
  const q = String(query || lastUser?.text || '').slice(0, 200);
  const qFeat = featuresOf(q);

  // —— 1. 长期记忆（被当前话题唤醒）——
  let memoryLines = [];
  try {
    const hits = recall(store, {
      query: q,
      limit: cfg.maxMemories,
      minScore: cfg.minMemScore,
      now: t,
      reinforceResults: true,
    });
    memoryLines = hits.map((h) => `· ${String(h.item.text).replace(/\s+/g, ' ').slice(0, 120)}`);
  } catch {
    memoryLines = [];
  }
  if (chat) memoryLines = memoryLines.filter(Boolean);

  // —— 2. 切出「最近原文」与「较早历史」——
  let rawBudget = cfg.recentRawChars;
  const tail = [];
  let tailChars = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const lineLen = all[i].text.length + 12;
    if (tail.length && tailChars + lineLen > rawBudget) break;
    tail.unshift(all[i]);
    tailChars += lineLen;
  }
  const older = all.slice(0, all.length - tail.length);

  // —— 3. 较早历史 → 抽取式摘要 ——
  const chunkChars = cfg.chunkChars;
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const m of older) {
    if (curLen + m.text.length > chunkChars && cur.length) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(m);
    curLen += m.text.length;
  }
  if (cur.length) chunks.push(cur);

  const picked = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const sents = chunks[ci].flatMap((m) =>
      splitSentences(m.text).map((s) => ({ s, role: m.role })),
    );
    const scored = sents
      .map((x) => ({ ...x, score: sentenceSalience(x.s, qFeat, ci, chunks.length, x.role === 'user') }))
      .sort((a, b) => b.score - a.score);
    let count = 0;
    for (const c of scored) {
      if (count >= cfg.sentencesPerChunk) break;
      if (picked.some((p) => jaccard(featuresOf(p.s), featuresOf(c.s)) > 0.6)) continue;
      picked.push(c);
      count++;
    }
  }
  let summary = picked.map((p) => p.s.replace(/\s+/g, ' ').trim()).join(' ');
  const summaryOriginalChars = summary.length;

  // —— 4. 组装：严格按预算拼（先给「最近原文」预留空间，再摘要，最后记忆）——
  const HEADER = '【压缩上下文 · 记忆注入】';
  let remaining = budget - HEADER.length;

  // 4.1 最近原文（最高优先级）：先按剩余预算裁掉最旧的行
  const tailLineLabel = '最近原文：';
  const tailOverhead = 2 + tailLineLabel.length + 1;
  let tailBody = '';
  {
    const lines = tail.map((m) => fmtLine(m.role, m.text));
    while (lines.length > 1 && tailOverhead + lines.join('\n').length > remaining) lines.shift();
    tailBody = lines.join('\n');
    const room = remaining - tailOverhead;
    if (tailBody && room > 0 && tailBody.length > room) {
      tailBody = '…' + tailBody.slice(Math.max(0, tailBody.length - room + 1));
    }
    if (tailOverhead + tailBody.length > remaining) tailBody = '';
  }
  const tailOut = tailBody;

  // 4.2 历史摘要：吃剩下的预算
  let summaryOut = summary;
  {
    const overhead = 2 + '历史摘要：'.length + 1;
    const room = remaining - (tailOut ? tailOverhead + tailOut.length : 0) - overhead;
    if (summaryOut.length > room) {
      summaryOut = room > 8 ? summaryOut.slice(0, room - 1) + '…' : '';
    }
  }
  remaining = budget - HEADER.length
    - (tailOut ? tailOverhead + tailOut.length : 0)
    - (summaryOut ? 2 + '历史摘要：'.length + 1 + summaryOut.length : 0);

  // 4.3 相关记忆：剩余预算内尽量多放
  const memLineLabel = '记忆片段：';
  const memOverhead = 2 + memLineLabel.length + 1;
  const memOutLines = [];
  let usedMem = 0;
  for (const line of memoryLines) {
    const extra = memOutLines.length ? 1 : 0;
    if (memOverhead + usedMem + extra + line.length > remaining) break;
    memOutLines.push(line);
    usedMem += extra + line.length;
  }

  const sections = [];
  if (memOutLines.length) sections.push(`${memLineLabel}\n${memOutLines.join('\n')}`);
  if (summaryOut) sections.push(`历史摘要：\n${summaryOut}`);
  if (tailOut) sections.push(`${tailLineLabel}\n${tailOut}`);
  const text = [HEADER, ...sections].join('\n\n');

  return {
    text,
    stats: {
      inputChars,
      outputChars: text.length,
      ratio: inputChars ? Math.round((text.length / inputChars) * 1000) / 1000 : 0,
      keptRawMessages: tail.length,
      summarySentences: picked.length,
      summaryOriginalChars,
      summaryChars: summaryOut.length,
      memoryCount: memOutLines.length,
      budgetChars: budget,
    },
  };
}
