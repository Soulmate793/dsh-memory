// dsh-memory 默认配置。所有阈值都集中在这里，便于按「记忆手感」调参。
export const DAY = 86400000;
export const HOUR = 3600000;
export const MINUTE = 60000;

export const DEFAULT_CONFIG = {
  // 记忆库容量上限（超过后按当前强度从最弱开始淘汰）
  maxItems: 20000,

  // 感觉记忆 / 工作记忆：最近消息的环形缓冲，过期即丢
  working: { capacity: 40, ttlMs: 2 * HOUR },

  // 艾宾浩斯遗忘曲线参数
  decay: {
    baseTauMs: 10 * DAY,       // 基础遗忘时间常数：普通记忆约 10 天衰减到 1/e
    importanceBias: 0.9,       // 重要度对 τ 的放大系数
    emotionBias: 0.6,          // 情绪强度对 τ 的放大系数（情绪记忆更持久）
    rehearsalGain: 0.22,       // 每次被回忆时的强度提升（提取强化）
    forgetThreshold: 0.12,     // 衰减强度低于此值 → 归档（不再主动想起）
    purgeThreshold: 0.03,      // 归档后继续衰减低于此值 → 彻底遗忘
  },

  // 记忆分区：各区检索权重与是否参与普通召回
  zones: {
    enabled: true,
    weights: { self: 1.15, relationship: 1.1, episodic: 1.0, semantic: 1.05, life: 1.0, learning: 0.95, vault: 0.6 },
    // 隔离区默认不参与召回（群聊完全不注入）；需要时用 memory_recall(include_vault=true)
    excludeByDefault: ['vault'],
  },

  // 回忆（线索依赖检索）打分权重
  recall: {
    weights: {
      relevance: 0.55,         // 与线索的关键词相关度（IDF 加权）
      strength: 0.20,          // 当前记忆强度（衰减后）
      recency: 0.15,           // 近因效应
      importance: 0.10,        // 重要度
    },
    defaultLimit: 8,
    minScore: 0.05,
  },

  // 睡眠巩固
  consolidate: {
    similarityThreshold: 0.3,  // 两段记忆的 bigram Jaccard 相似度超过此值视为同类
    minCluster: 2,             // 同类情节至少几条才会合并成语义记忆
    promoteThreshold: 0.8,     // 重要度高于此值 + 被反复提取 → 直接升为语义记忆
    promoteMinAccess: 2,
    autoIntervalMs: 6 * HOUR,  // 后台自动巩固间隔
  },

  // 上下文压缩
  compress: {
    budgetChars: 3000,         // 压缩后上下文总预算（字符数，中文约 1 字符 ≈ 1 token）
    recentRawChars: 1200,      // 最近原文保留预算
    summaryChars: 1200,        // 历史摘要预算
    chunkChars: 800,           // 把旧消息切块做抽取式摘要的块大小
    sentencesPerChunk: 2,      // 每块最多挑几句
    maxMemories: 6,            // 注入的相关记忆条数上限
    minMemScore: 0.06,
  },
};

export function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function configWith(over) {
  return deepMerge(DEFAULT_CONFIG, over || {});
}
