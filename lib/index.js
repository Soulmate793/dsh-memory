// dsh-memory：仿人记忆库插件（Host 半）
//
// 提供 agent 可直接调用的记忆工具：
//   memory_remember      写入一条记忆（可指定 kind / importance / tags / zone）
//   memory_recall        线索依赖回忆（关键词 + IDF 加权；可选语义向量/联想扩散）
//   memory_stats         记忆库统计（数量、强度、类型）
//   memory_zones         分区统计（自我/关系/情节/语义/生活/学习/隔离）
//   memory_forget        遗忘一条记忆（软删除 + 哈希链留痕）
//   memory_consolidate   睡眠巩固（合并同类情节 → 语义记忆）
//   memory_chain_verify  校验哈希链 + 与记忆文件对账
//
// 所有数据都在本地 dataDir（默认 ~/.dsh/qq-memory），插件不上传、不联网。
// 零外部依赖：只需要 Node.js >= 20。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './core/store.mjs';
import { recall } from './core/recall.mjs';
import { ZONES, classifyZone } from './core/zones.mjs';
import { verifyChain, verifyMemory, head } from './core/chain.mjs';
import { loadPersonality } from './core/personality.mjs';
import { loadEmotionState } from './core/emotion.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(here, '..');

export const name = 'dsh-memory';
export const inject = ['tools'];

function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'qq-memory');
}

function resolveConfig(rowConfig) {
  const cfg = rowConfig?.memory ?? rowConfig ?? {};
  const dataDir = String(cfg.dataDir || process.env.MEMORY_DIR || defaultDataDir());
  return {
    dataDir,
    maxItems: Number(cfg.maxItems) || 500000,
    recallLimit: Number(cfg.recallLimit) || 8,
    includeVault: Boolean(cfg.includeVault),
  };
}

function storeOf(cfg) {
  return new MemoryStore({ dir: cfg.dataDir, config: { maxItems: cfg.maxItems } });
}

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' } },
};

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    timeoutMs: 120000,
    output: {
      schema: outputSchema,
      render(_args, value) {
        return textResult(value);
      },
    },
    execute,
  };
}

export function apply(ctx, rowConfig) {
  const cfg = resolveConfig(rowConfig);
  ctx.logger?.info?.('[dsh-memory] 已加载，dataDir=%s', cfg.dataDir);

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(tool(
        'memory_remember',
        '写入一条长期记忆。适合记住：用户偏好、重要事实、约定、关系变化、事件。kind=episodic（具体经历）或 semantic（长期事实）；zone 可选：self/relationship/episodic/semantic/life/learning/vault。',
        {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: '要记住的内容（第一人称/原文均可，最多 4000 字）' },
            kind: { type: 'string', enum: ['episodic', 'semantic'], description: '记忆类型，默认 episodic' },
            importance: { type: 'number', minimum: 0, maximum: 1, description: '重要度 0~1，默认 0.5' },
            emotion: { type: 'number', minimum: 0, maximum: 1, description: '情绪强度 0~1，默认 0' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["profile","qq:123"]' },
            zone: { type: 'string', enum: Object.keys(ZONES), description: '记忆分区，不填自动推断' },
            chat: { type: 'string', description: '来源会话标识（可选）' },
          },
        },
        async ({ text, kind, importance, emotion, tags, zone, chat }) => {
          const store = storeOf(cfg);
          let item;
          store.withLock(() => {
            item = store.add({
              kind: kind === 'semantic' ? 'semantic' : 'episodic',
              text,
              importance,
              emotion,
              tags: tags || [],
              zone: zone || null,
              source: chat ? { chat } : null,
            });
            store.flush();
          });
          return { ok: true, id: item.id, zone: item.zone, importance: item.importance };
        },
      )),

      ctx.tools.register(tool(
        'memory_recall',
        '按线索回忆记忆。query 用自然语言（越像当时的场景越好）；可限定 zone（self/relationship/episodic/semantic/life/learning/vault）或 include_vault=true 才读取隔离区。返回按相关度/强度/近因/重要度加权的记忆列表。',
        {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: '回忆线索（自然语言）' },
            limit: { type: 'number', minimum: 1, maximum: 50, description: '返回条数，默认 8' },
            zone: { type: 'string', enum: Object.keys(ZONES), description: '只在这个分区里回忆' },
            include_vault: { type: 'boolean', description: '是否允许读取隔离区（默认 false）' },
            include_archived: { type: 'boolean', description: '是否包含已归档记忆' },
          },
        },
        async ({ query, limit, zone, include_vault, include_archived }) => {
          const store = storeOf(cfg);
          const zones = zone ? [zone] : null;
          const includeVault = Boolean(include_vault) || zone === 'vault';
          const hits = recall(store, {
            query,
            limit: Number(limit) || cfg.recallLimit,
            zones,
            includeVault,
            includeArchived: Boolean(include_archived),
          });
          return {
            ok: true,
            count: hits.length,
            hits: hits.map((h) => ({
              id: h.item.id,
              text: h.item.text,
              score: h.score,
              kind: h.item.kind,
              zone: h.item.zone || classifyZone(h.item),
              importance: h.item.importance,
              createdAt: h.item.createdAt,
            })),
          };
        },
      )),

      ctx.tools.register(tool(
        'memory_stats',
        '记忆库统计：总数、活跃/归档、类型分布、平均强度、性格阶段。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const store = storeOf(cfg);
          const stats = store.stats();
          let personality = null;
          try {
            personality = loadPersonality({ memoryDir: cfg.dataDir });
          } catch {
            personality = null;
          }
          return {
            ok: true,
            dir: cfg.dataDir,
            stats,
            personality: personality
              ? { stage: personality.stage || null, xp: personality.xp ?? null }
              : null,
          };
        },
      )),

      ctx.tools.register(tool(
        'memory_zones',
        '记忆分区统计：各区有多少条活跃记忆（自我/关系/情节/语义/生活/学习/隔离）。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const store = storeOf(cfg);
          const counts = {};
          for (const item of store.state.items) {
            if (!item || item.state !== 'active') continue;
            const zone = item.zone || classifyZone(item);
            counts[zone] = (counts[zone] || 0) + 1;
          }
          return { ok: true, zones: counts, labels: Object.fromEntries(Object.entries(ZONES).map(([k, v]) => [k, v.label])) };
        },
      )),

      ctx.tools.register(tool(
        'memory_forget',
        '主动遗忘一条记忆（软删除：状态置为 purged，哈希链留痕；不会物理删除文件）。',
        {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', description: '记忆 id' } },
        },
        async ({ id }) => {
          const store = storeOf(cfg);
          let item = null;
          store.withLock(() => {
            item = store.forget(id);
            store.flush();
          });
          return { ok: Boolean(item), id };
        },
      )),

      ctx.tools.register(tool(
        'memory_consolidate',
        '睡眠巩固：把同类情节记忆合并成语义记忆、去重、升级高价值记忆。建议空闲时调用。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const store = storeOf(cfg);
          let result;
          store.withLock(() => {
            result = store.consolidate();
            store.flush();
          });
          return { ok: true, ...result };
        },
      )),

      ctx.tools.register(tool(
        'memory_chain_verify',
        '校验记忆哈希链：seq 连续性、prevHash 衔接、Ed25519 签名、以及与 memory.json 的逐条对账。',
        { type: 'object', additionalProperties: false, properties: {} },
        async () => {
          const store = storeOf(cfg);
          const chain = verifyChain(cfg.dataDir);
          const memory = verifyMemory(cfg.dataDir, store.state.items);
          return {
            ok: Boolean(chain.ok && memory.ok),
            head: head(cfg.dataDir),
            chain: {
              ok: chain.ok,
              events: chain.events,
              errors: chain.errors,
            },
            memory: {
              ok: memory.ok,
              checked: memory.checked,
              mismatchedCount: memory.mismatchedCount,
              unrecordedCount: memory.unrecordedCount,
            },
          };
        },
      )),
    ];
    return () => {
      for (const d of disposers) {
        try {
          d?.();
        } catch {
          /* ignore */
        }
      }
    };
  });
}
