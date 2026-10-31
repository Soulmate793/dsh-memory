// 人类式遗忘：艾宾浩斯遗忘曲线 + 提取强化。
//
// R(t) = exp(-t / S)
// S（时间常数）随重要度、情绪强度、被提取次数放大：
//   - 重要的事忘得慢（重要度 bias）
//   - 带情绪的事记得牢（杏仁核效应 emotionBias）
//   - 反复被想起来的事也会变牢（间隔效应 rehearsal）
//
// 记忆强度 = 初始强度 × R(t)。每次被回忆起时：
//   baseStrength 向 1 靠近（rehearsalGain），并重置衰减计时。
import { clamp } from './util.mjs';

export function tauMs(item, decayCfg) {
  const importance = clamp(item.importance ?? 0.5, 0, 1);
  const emotion = clamp(item.emotion ?? 0, 0, 1);
  const rehearsal = 1 + 0.35 * Math.log1p(Math.max(0, item.accessCount | 0));
  const bias = 1 + decayCfg.importanceBias * importance + decayCfg.emotionBias * emotion;
  return decayCfg.baseTauMs * bias * rehearsal;
}

export function decayedStrength(item, now, decayCfg) {
  const last = item.lastAccess ?? item.createdAt ?? now;
  const elapsed = Math.max(0, now - last);
  const base = clamp(item.baseStrength ?? 0.5, 0, 1);
  return base * Math.exp(-elapsed / tauMs(item, decayCfg));
}

/** 回忆即复习：提取会让记忆变强、忘得更慢。 */
export function reinforce(item, now, decayCfg, gain = null) {
  const g = gain ?? decayCfg.rehearsalGain;
  const base = clamp(item.baseStrength ?? 0.5, 0, 1);
  item.baseStrength = clamp(base + g * (1 - base), 0, 1);
  item.accessCount = (item.accessCount | 0) + 1;
  item.lastAccess = now;
  return item;
}

/** 是否会「想不起来」（衰减到阈值以下）。 */
export function isForgotten(item, now, decayCfg) {
  return decayedStrength(item, now, decayCfg) < decayCfg.forgetThreshold;
}

/** 是否已经被彻底遗忘（归档后继续衰减到极低）。 */
export function isPurgeable(item, now, decayCfg) {
  return decayedStrength(item, now, decayCfg) < decayCfg.purgeThreshold;
}
