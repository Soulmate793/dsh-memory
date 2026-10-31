#!/usr/bin/env node
// 用户画像库命令行
//
//   node src/profiles-cli.mjs build                立即从记忆库重建画像
//   node src/profiles-cli.mjs list [--limit 20]    列出用户（按消息数）
//   node src/profiles-cli.mjs show <QQ号|昵称>      查看某人完整画像
import { buildProfiles, getProfile, listProfiles, syncProfilesToMemory } from './profiles.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

function value(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

if (cmd === 'help' || cmd === '--help') {
  console.log(
    [
      '用户画像库命令：',
      '  build                 立即从记忆库重建画像',
      '  sync                  立即把画像写回记忆库（语义记忆）',
      '  list [--limit 20]     列出用户（按消息数）',
      '  show <QQ号|昵称>       查看某人完整画像',
    ].join('\n'),
  );
  process.exit(0);
}

if (cmd === 'build') {
  const result = buildProfiles();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (cmd === 'sync') {
  const result = syncProfilesToMemory();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (cmd === 'list') {
  console.log(JSON.stringify(listProfiles({ limit: parseInt(value('limit', '20'), 10) }), null, 2));
  process.exit(0);
}

if (cmd === 'show') {
  const query = args[1];
  if (!query) {
    console.error('缺少查询参数：node src/profiles-cli.mjs show <QQ号|昵称>');
    process.exit(1);
  }
  const profile = getProfile(query);
  if (!profile) {
    console.error(`没有找到「${query}」的画像（可能还没积累足够消息）`);
    process.exit(1);
  }
  console.log(JSON.stringify(profile, null, 2));
  process.exit(0);
}

console.error(`未知命令：${cmd}`);
process.exit(1);
