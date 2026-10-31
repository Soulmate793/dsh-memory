// 记忆分区：把记忆分成「自我 / 关系 / 情节 / 语义 / 生活 / 学习 / 隔离」七个区。
//
// 分区的意义：
//   · 不同区有不同的衰减速度、检索权重和注入策略
//   · 隔离区（vault）默认不参与召回，群聊里完全不注入
//   · 控制台/星图可以按区分色、按区筛选
export const ZONES = {
  self: {
    label: '自我',
    decayMultiplier: 0,     // 不衰减：人格/身份/价值观
    weight: 1.15,
    inject: true,
    privacy: 'public',
  },
  relationship: {
    label: '关系',
    decayMultiplier: 0.5,   // 慢衰减：对人的称呼/亲密度/边界
    weight: 1.1,
    inject: true,
    privacy: 'sensitive',
  },
  episodic: {
    label: '情节',
    decayMultiplier: 1,     // 正常衰减：具体对话/事件
    weight: 1,
    inject: true,
    privacy: 'public',
  },
  semantic: {
    label: '语义',
    decayMultiplier: 0.6,   // 慢衰减：巩固后的长期事实
    weight: 1.05,
    inject: true,
    privacy: 'public',
  },
  life: {
    label: '生活',
    decayMultiplier: 1.2,   // 稍快：日常碎片，过去就过去了
    weight: 1,
    inject: true,
    privacy: 'public',
  },
  learning: {
    label: '学习',
    decayMultiplier: 0.8,   // 不用会淡：学到的知识/梗
    weight: 0.95,
    inject: true,
    privacy: 'public',
  },
  vault: {
    label: '隔离',
    decayMultiplier: 0,     // 永久保存，但不主动想起
    weight: 0.6,
    inject: false,
    privacy: 'secret',
  },
};

export const ZONE_IDS = Object.keys(ZONES);

export function isValidZone(zone) {
  return typeof zone === 'string' && Object.prototype.hasOwnProperty.call(ZONES, zone);
}

/** 根据已有字段推断这段记忆属于哪个区（迁移和新增都用同一套规则） */
export function classifyZone(item = {}) {
  if (isValidZone(item.zone)) return item.zone;
  const tags = (item.tags || []).map((t) => String(t).toLowerCase());
  const has = (prefix) => tags.some((t) => t === prefix || t.startsWith(prefix));
  if (has('vault') || has('secret') || has('暗号') || has('password')) return 'vault';
  if (has('personality') || has('self')) return 'self';
  // 关系区只放「对人的画像/档案」，普通聊天里带的 person: 标签不算
  if (has('profile') || has('qq:') || /^\[画像\]/.test(String(item.text || ''))) return 'relationship';
  if (has('learning')) return 'learning';
  if (has('life') || has('qzone') || has('说说') || has('voice')) return 'life';
  if (item.kind === 'semantic') return 'semantic';
  return 'episodic';
}

export function zoneWeight(zone) {
  return ZONES[zone]?.weight ?? 1;
}

export function isVault(zone) {
  return zone === 'vault';
}

/** 当前场景能不能看到这个区（群聊里看不到隔离区） */
export function zoneVisible(zone, { scope = 'private', explicit = false } = {}) {
  if (!isVault(zone)) return true;
  if (scope === 'group') return false;
  return explicit;
}
