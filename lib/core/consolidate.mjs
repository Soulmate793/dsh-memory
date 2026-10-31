// 睡眠巩固（类比人类睡眠中的记忆巩固）：
//   1. 把同一会话里相似的情节记忆（episodic）聚类
//   2. 同类记忆合并成一条语义记忆（semantic）——「提炼成常识」
//   3. 更重要、被反复提取过的情节直接升格为语义记忆
//   4. 语义记忆之间再做一次去重合并
//   5. 衰减 + 遗忘（低于阈值的归档/清除）
import { featuresOf, jaccard, uid, clamp } from './util.mjs';
import { appendEvent, contentHashOf } from './chain.mjs';

/** 巩固时的哈希链事件（失败不影响巩固本身） */
function chainEvent(store, type, item) {
  if (!store?.dir || !item?.id) return;
  try {
    appendEvent(store.dir, { type, id: item.id, contentHash: contentHashOf(item) });
  } catch {
    /* 链写入失败不阻断巩固 */
  }
}

// 合并后的语义记忆保留「原话」：去重拼接、最多 3800 字（store 单条上限 4000）
const MAX_MERGED_TEXT = 3800;

function clampText(text) {
  return String(text || '').trim().slice(0, MAX_MERGED_TEXT);
}

function uniqueJoin(texts) {
  const seen = new Set();
  const out = [];
  for (const raw of texts) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const key = s.replace(/\s+/g, ' ').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join('；');
}

function chatOf(item) {
  return item.source?.chat || (item.tags || []).find((tag) => tag.startsWith('chat:')) || 'global';
}

export function consolidate(store, { now = null } = {}) {
  const t = now ?? store.now;
  const cfg = store.config.consolidate;
  const items = store.state.items;
  const report = {
    at: t,
    scanned: 0,
    clusters: 0,
    mergedEpisodic: 0,
    mergedIntoExisting: 0,
    promoted: 0,
    dedupedSemantic: 0,
    archived: 0,
    purged: 0,
  };

  const active = items.filter((it) => it.state === 'active');
  report.scanned = active.length;

  // —— 1. 情节记忆按会话聚类 ——
  const episodicByChat = new Map();
  for (const it of active) {
    if (it.kind !== 'episodic') continue;
    const chat = chatOf(it);
    if (!episodicByChat.has(chat)) episodicByChat.set(chat, []);
    episodicByChat.get(chat).push(it);
  }

  const semanticByChat = new Map();
  for (const it of active) {
    if (it.kind !== 'semantic') continue;
    const chat = chatOf(it);
    if (!semanticByChat.has(chat)) semanticByChat.set(chat, []);
    semanticByChat.get(chat).push(it);
  }

  for (const [chat, list] of episodicByChat) {
    // 贪心聚类：与已有簇内任一成员相似度 ≥ 阈值就归入该簇
    const clusters = [];
    for (const it of list) {
      const feats = featuresOf(it.text);
      let best = null;
      let bestSim = 0;
      for (const c of clusters) {
        for (const member of c.items) {
          const sim = jaccard(feats, featuresOf(member.text));
          if (sim > bestSim) {
            bestSim = sim;
            best = c;
          }
        }
      }
      if (best && bestSim >= cfg.similarityThreshold) {
        best.items.push(it);
      } else {
        clusters.push({ items: [it] });
      }
    }

    for (const c of clusters) {
      if (c.items.length < cfg.minCluster) continue;
      report.clusters++;

      const rep = [...c.items].sort(
        (a, b) => (b.importance + b.emotion) - (a.importance + a.emotion) || b.accessCount - a.accessCount,
      )[0];
      // 合并时保留原话：按时间顺序拼接各条原文（去重），而不是只留代表句的摘要。
      const joined = clampText(uniqueJoin(c.items.map((x) => x.text)));
      const merged = {
        id: uid('sem'),
        kind: 'semantic',
        text: joined || rep.text,
        tags: [...new Set(c.items.flatMap((x) => x.tags || []))].slice(0, 20),
        importance: Math.max(...c.items.map((x) => x.importance ?? 0)),
        emotion: Math.max(...c.items.map((x) => x.emotion ?? 0)),
        valence: rep.valence ?? 0,
        source: rep.source || null,
        createdAt: t,
        lastAccess: t,
        accessCount: c.items.reduce((s, x) => s + (x.accessCount | 0), 0),
        baseStrength: Math.max(...c.items.map((x) => x.baseStrength ?? 0.5)),
        state: 'active',
        pinned: false,
        meta: { mergedFrom: c.items.map((x) => x.id), count: c.items.length, chat },
      };

      // 已存在相似语义记忆 → 并进去，而不是新造一条（原话也追加进去，不丢细节）
      const existing = (semanticByChat.get(chat) || []).find(
        (x) => jaccard(featuresOf(x.text), featuresOf(merged.text)) >= cfg.similarityThreshold,
      );
      if (existing) {
        existing.text = clampText(uniqueJoin([existing.text, ...c.items.map((x) => x.text)]));
        existing.accessCount = (existing.accessCount | 0) + merged.accessCount;
        existing.importance = Math.max(existing.importance, merged.importance);
        existing.emotion = Math.max(existing.emotion ?? 0, merged.emotion);
        existing.lastAccess = t;
        existing.baseStrength = clamp(
          (existing.baseStrength ?? 0.5) + 0.1 * (merged.baseStrength - (existing.baseStrength ?? 0.5)),
          0.01,
          1,
        );
        existing.meta = {
          ...(existing.meta || {}),
          mergedFrom: [...(existing.meta?.mergedFrom || []), ...merged.meta.mergedFrom],
        };
        report.mergedIntoExisting += c.items.length;
        chainEvent(store, 'update', existing);
      } else {
        items.push(merged);
        (semanticByChat.get(chat) || semanticByChat.set(chat, []).get(chat)).push(merged);
        report.mergedEpisodic += c.items.length;
        chainEvent(store, 'add', merged);
      }

      const target = existing || merged;
      for (const it of c.items) {
        it.state = 'archived';
        it.meta = { ...(it.meta || {}), consolidatedInto: target.id, consolidatedAt: t };
        report.archived++;
        chainEvent(store, 'archive', it);
      }
    }
  }

  // —— 2. 重要 + 反复提取的情节记忆 → 直接升格 ——
  for (const it of items) {
    if (it.state !== 'active' || it.kind !== 'episodic') continue;
    if ((it.importance ?? 0) >= cfg.promoteThreshold && (it.accessCount | 0) >= cfg.promoteMinAccess) {
      it.kind = 'semantic';
      it.meta = { ...(it.meta || {}), promotedAt: t };
      report.promoted++;
      chainEvent(store, 'update', it);
    }
  }

  // —— 3. 语义记忆去重 ——
  const allSem = items.filter((it) => it.state === 'active' && it.kind === 'semantic');
  for (let i = 0; i < allSem.length; i++) {
    for (let j = i + 1; j < allSem.length; j++) {
      const a = allSem[i];
      const b = allSem[j];
      if (a.state !== 'active' || b.state !== 'active') continue;
      if (chatOf(a) !== chatOf(b)) continue;
      if (jaccard(featuresOf(a.text), featuresOf(b.text)) < cfg.similarityThreshold) continue;
      const [keep, drop] = (a.importance + a.accessCount * 0.01) >= (b.importance + b.accessCount * 0.01) ? [a, b] : [b, a];
      // 去重也不丢原话：把被合并的那条文本并进来
      keep.text = clampText(uniqueJoin([keep.text, drop.text]));
      keep.accessCount = (keep.accessCount | 0) + (drop.accessCount | 0);
      keep.importance = Math.max(keep.importance, drop.importance);
      keep.emotion = Math.max(keep.emotion ?? 0, drop.emotion ?? 0);
      keep.lastAccess = Math.max(keep.lastAccess ?? 0, drop.lastAccess ?? 0);
      keep.baseStrength = clamp(Math.max(keep.baseStrength ?? 0.5, drop.baseStrength ?? 0.5), 0.01, 1);
      keep.meta = { ...(keep.meta || {}), mergedFrom: [...(keep.meta?.mergedFrom || []), ...(drop.meta?.mergedFrom || []), drop.id] };
      drop.state = 'archived';
      drop.meta = { ...(drop.meta || {}), dedupedInto: keep.id, dedupedAt: t };
      report.archived++;
      report.dedupedSemantic++;
      chainEvent(store, 'update', keep);
      chainEvent(store, 'archive', drop);
    }
  }

  // —— 4. 衰减 + 遗忘 ——
  const maintained = store.maintain(t, { flush: false });
  report.archived += maintained.archived;
  report.purged += maintained.purged;
  // maintain 已计入 archived 的二次统计，这里做个减法避免重复计数
  store.state.lastConsolidation = t;
  store.dirty = true;
  store.flush();
  report.activeAfter = items.filter((it) => it.state === 'active').length;
  return report;
}
