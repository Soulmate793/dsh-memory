// 人类式记忆库统一入口。
import { MemoryStore, openMemory } from './store.mjs';
import { recall } from './recall.mjs';
import { consolidate } from './consolidate.mjs';
import { compressContext } from './compress.mjs';
import { configWith, DEFAULT_CONFIG } from './config.mjs';
import { decayedStrength, reinforce, tauMs } from './decay.mjs';

export { MemoryStore, openMemory, recall, consolidate, compressContext, configWith, DEFAULT_CONFIG, decayedStrength, reinforce, tauMs };

/**
 * 门面类：一个对象满足「记忆 + 回忆 + 巩固 + 压缩」四件事。
 *
 *   const memory = new HumanMemory({ dir: './state' });
 *   memory.remember({ text: 'Alan 喜欢火锅', importance: 0.8, tags: ['person:alan'], emotion: 0.3 });
 *   memory.recall({ query: 'Alan 喜欢什么' });
 *   memory.consolidate();
 *   memory.compressContext({ messages, budgetChars: 3000, query: '...' });
 */
export class HumanMemory {
  constructor({ dir, file, config } = {}) {
    this.store = new MemoryStore({ dir, file, config });
  }

  remember(opts) {
    const item = this.store.add(opts);
    this.maybeAutoConsolidate();
    return item;
  }

  rememberBatch(list) {
    const items = this.store.addBatch(list);
    this.maybeAutoConsolidate();
    return items;
  }

  recall(opts) {
    return recall(this.store, opts);
  }

  consolidate(opts) {
    return consolidate(this.store, opts);
  }

  compressContext(opts) {
    return compressContext(this.store, opts);
  }

  forget(id) {
    return this.store.archive(id);
  }

  stats() {
    return this.store.stats();
  }

  maybeAutoConsolidate() {
    const t = this.store.now;
    const interval = this.store.config.consolidate.autoIntervalMs;
    const last = this.store.state.lastConsolidation || 0;
    const itemCount = this.store.state.items.length;
    // 小记忆库不急着巩固：至少要攒够 20 条，或有明确的历史巩固记录且到期
    const due = itemCount >= 20 ? (last === 0 || t - last >= interval) : false;
    if (due) {
      try {
        consolidate(this.store, { now: t });
      } catch {
        /* 巩固失败不影响写入 */
      }
    }
  }

  close() {
    this.store.close();
  }
}
