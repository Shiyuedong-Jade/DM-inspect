/**
 * 真机验证：用 lib/tool.js 的 execute 连一次真实达梦库（jdbc 驱动）。
 *
 * 覆盖插件包里的引擎、复制过去的工作目录、java 桥接与真实 SQL。
 *
 * 用法（口令只从环境变量取，不落盘、不进代码）：
 *   $env:DM8_TEST_HOST='10.127.11.40'; $env:DM8_TEST_DB_PW='...'
 *   node tools/live.mjs
 *
 * 可选环境变量：
 *   DM8_TEST_DB_PORT  默认 5236
 *   DM8_TEST_DB_USER  默认 SYSDBA
 *   DM8_TEST_TARGETS  集群用，逗号分隔的 host:port（给了就忽略 DM8_TEST_HOST）
 *   DM8_TEST_SSH_USER / DM8_TEST_SSH_PW   配了就做 OS 级检查
 *   DM8_DEV_HOME      工作目录，默认 <包目录>/.dev-home
 *   DM8_SEED_DRIVER   默认 1：工作目录里没有 jar 时，从 ../dm8-inspect/drivers/ 复制一个过来
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDm8Tool } from '../lib/tool.js';
import { loadEngine } from '../lib/engine.js';
import { prepareHome } from '../lib/workspace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const host = process.env.DM8_TEST_HOST || '';
const port = parseInt(process.env.DM8_TEST_DB_PORT || '5236', 10);
const user = process.env.DM8_TEST_DB_USER || 'SYSDBA';
const pw = process.env.DM8_TEST_DB_PW || '';
const sshUser = process.env.DM8_TEST_SSH_USER || '';
const sshPw = process.env.DM8_TEST_SSH_PW || '';
const targetSpec = process.env.DM8_TEST_TARGETS || '';
const home = path.resolve(process.env.DM8_DEV_HOME || path.join(PKG, '.dev-home'));

const targets = targetSpec
  ? targetSpec.split(',').map((s) => {
      const [h, p] = s.trim().split(':');
      return { host: h, port: parseInt(p || '5236', 10), user };
    })
  : host
    ? [{ host, port, user }]
    : [];

if (!targets.length || !pw) {
  console.error('缺少环境变量：至少要给 DM8_TEST_HOST（或 DM8_TEST_TARGETS）与 DM8_TEST_DB_PW。');
  process.exit(64);
}

// 工作目录里没有 jar 时，从工程里的 ../dm8-inspect/drivers/ 复制一个过来。
// 生产使用由用户自行把 DmJdbcDriver18.jar 放进 drivers/。
const prep0 = prepareHome(home);
if (!prep0.jars.length && process.env.DM8_SEED_DRIVER !== '0') {
  const srcDir = path.resolve(PKG, '..', 'dm8-inspect', 'drivers');
  const jar = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).find((f) => /\.jar$/i.test(f)) : null;
  if (jar) {
    fs.copyFileSync(path.join(srcDir, jar), path.join(prep0.driverDir, jar));
    console.log(`[开发便利] 已从 ${srcDir} 复制驱动 ${jar} 到工作目录。生产使用请自行放置。`);
  }
}

const cfg = {
  home,
  driver: 'jdbc',
  credentialRef: 'DM8_INSPECT_PASSWORD',
  sshCredentialRef: 'DM8_INSPECT_SSH_PASSWORD',
  outDir: path.join(PKG, '.dev-reports'),
  queryTimeoutMs: 30000,
  connectTimeoutMs: 20000,
  slowSqlMs: 1000,
  tsWarnPct: 80,
  tsCritPct: 90,
  topN: 10,
  clusterConcurrency: 3,
};

const spec = makeDm8Tool({
  defineTool: (s) => s,
  getConfig: () => cfg,
  loadEngine,
  prepareHome,
  // 真机验证里口令直接来自环境变量，走「显式口令」这条分支
  resolveSecret: async (ref) => (ref === 'DM8_INSPECT_SSH_PASSWORD' ? sshPw || null : null),
  log: (m) => console.log('  · ' + m),
});

console.log(`目标：${targets.map((t) => `${t.host}:${t.port}`).join('、')}　账号：${user}`);
console.log(`工作目录：${home}`);
console.log(`报告目录：${cfg.outDir}\n`);

const t0 = Date.now();
const v = await spec.execute(
  {
    targets,
    driver: 'jdbc',
    password: pw,
    sshUser: sshUser || undefined,
    sshPassword: sshPw || undefined,
  },
  { signal: new AbortController().signal }
);

const text = spec.output.render({}, v).map((b) => b.text).join('\n');
console.log(text);
console.log(`\n（端到端耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);

if (!v.ok) {
  console.error('\n巡检未完成，按约定不生成报告。');
  process.exit(2);
}
// 有节点没取到数据时报告结论不完整，按不通过处理。
const missing = v.nodes.filter((n) => n.summary.total === 0).length;
if (missing) {
  console.error(`\n有 ${missing} 个节点没取到数据，本次不作数。`);
  process.exit(2);
}
console.log('\n真机验证通过 ✅');
