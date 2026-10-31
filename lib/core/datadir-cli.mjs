#!/usr/bin/env node
// 共享数据层命令行
//
//   node src/datadir-cli.mjs show     显示当前解析到的共享数据目录与配置
//   node src/datadir-cli.mjs init     生成 ~/.dsh/dsh-memory.json 模板（不覆盖已有）
import fs from 'node:fs';
import { resolveDataDir, readSharedConfig, initSharedConfig, SHARED_CONFIG_FILE, DEFAULT_DATA_DIR } from './datadir.mjs';

const cmd = process.argv[2] || 'show';

if (cmd === 'show') {
  const cfg = readSharedConfig();
  console.log(JSON.stringify({
    dataDir: resolveDataDir(),
    sharedConfig: SHARED_CONFIG_FILE,
    sharedConfigExists: Boolean(cfg),
    bots: cfg?.bots ?? null,
    files: (() => {
      const dir = resolveDataDir();
      const out = {};
      for (const f of ['memory.json', 'profiles.json', 'personality.json']) {
        try { out[f] = fs.statSync(`${dir}/${f}`).size + ' bytes'; } catch { out[f] = '缺失'; }
      }
      return out;
    })(),
  }, null, 2));
  process.exit(0);
}

if (cmd === 'init') {
  const result = initSharedConfig({ dataDir: DEFAULT_DATA_DIR });
  console.log(JSON.stringify({ ...result, dataDir: DEFAULT_DATA_DIR, note: result.created ? '已生成共享配置模板' : '配置已存在，未覆盖' }, null, 2));
  process.exit(0);
}

console.error(`未知命令：${cmd}`);
process.exit(1);
