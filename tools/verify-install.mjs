/**
 * 安装后验证：确认插件在装进去的那个位置能被加载。
 *
 * Node 解析裸模块名走真实路径，软链或复制方式的差异会让
 * `import '@deepseek-ai/dsh-tools'` 解析失败，而这类失败只在 DSH 启动时暴露。
 *
 * 两条安装路线都支持（脚本自行判断用的是哪条）：
 *   · 标准路线：`dsh plugin --profile <名> add file:<路径>`
 *     包名进 `dsh.profile.bundles`，profile 的 `cordis.patch.yml` 保持空数组，
 *     插入行由包自带的那份 cordis.patch.yml 提供；
 *   · 手动路线：`node tools/install.mjs`
 *     把包复制进 profile 的 node_modules，并往 profile 的 patch 里插一行。
 *
 * 用法：node tools/verify-install.mjs [--profile web]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).name;

const argv = process.argv.slice(2);
const i = argv.indexOf('--profile');
const PROFILE = i >= 0 && argv[i + 1] ? argv[i + 1] : 'web';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const INSTALLED = path.join(PROFILE_DIR, 'node_modules', PKG_NAME);
const PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json');

let failed = 0;
const ok = (c, m) => {
  console.log((c ? '  [通过] ' : '  [失败] ') + m);
  if (!c) failed++;
};

console.log(`\n=== 1. 安装位置 ===`);
ok(fs.existsSync(INSTALLED), `插件目录存在：${INSTALLED}`);
for (const f of ['package.json', 'lib/index.js', 'lib/tool.js', 'lib/engine.js', 'lib/workspace.js', 'lib/session-form.js', 'client/client.js', 'engine/runner.js', 'engine/package.json', 'assets/java/DmBridge.java']) {
  ok(fs.existsSync(path.join(INSTALLED, f)), `有 ${f}`);
}
{
  // engine/package.json 必须是 type: commonjs，否则引擎会被当成 ESM 加载，require 直接报错
  const ep = path.join(INSTALLED, 'engine', 'package.json');
  if (fs.existsSync(ep)) {
    const t = JSON.parse(fs.readFileSync(ep, 'utf8')).type;
    ok(t === 'commonjs', `engine/package.json 声明了 type: commonjs（实际 ${t}）`);
  }
}

console.log('\n=== 1b. 客户端半边的清单与产物 ===');
{
  const pj = JSON.parse(fs.readFileSync(path.join(INSTALLED, 'package.json'), 'utf8'));
  const clientExport = pj.exports && pj.exports['./client'];
  ok(!!clientExport, `exports["./client"] = ${clientExport}`);
  // host 的 client-modules 扫描要求：声明了 dsh.client 就必须能找到那个 bundle，
  // 找不到会启动即失败。
  if (clientExport) {
    const p = path.join(INSTALLED, clientExport.replace(/^\.\//, ''));
    ok(fs.existsSync(p), `导出的 client 产物存在：${clientExport}`);
    const src = fs.readFileSync(p, 'utf8');
    ok(/window\.__ModuleLoader__\.load\(\{/.test(src), 'client 产物是闭包工厂形态');
    const idMatch = /id:\s*'([^']+)'/.exec(src);
    ok(idMatch && idMatch[1] === pj.name, `client 产物的 module id 用包名（${idMatch && idMatch[1]} vs ${pj.name}）`);
  }
  const dc = pj.dsh && pj.dsh.client;
  ok(!!dc && dc.platform === 'web', `dsh.client.platform = ${dc && dc.platform}`);
  ok((pj.files || []).includes('client'), 'files 里包含 client（否则发布时会被漏掉）');
}

console.log('\n=== 2. 从安装位置解析依赖（最容易踩的坑）===');
{
  const r = createRequire(path.join(INSTALLED, 'lib', 'index.js'));
  for (const spec of ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-credentials']) {
    let resolved = '';
    try {
      resolved = r.resolve(spec);
    } catch (e) {
      resolved = '';
    }
    ok(!!resolved, `${spec} 能解析${resolved ? ` -> ${resolved.replace(DSH_HOME, '~/.dsh')}` : '（解析失败）'}`);
  }
}

console.log('\n=== 3. 真的 import 一次（会执行模块顶层的全部 import）===');
try {
  const mod = await import(pathToFileURL(path.join(INSTALLED, 'lib', 'index.js')).href);
  ok(typeof mod.apply === 'function', '导出了 apply');
  ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), `inject = ${JSON.stringify(mod.inject)}`);
  ok(mod.name === 'dm8-inspect', `name = ${mod.name}`);
  ok(!!mod.Config, '导出了 Config');
} catch (e) {
  ok(false, 'import 失败：' + (e && e.message ? e.message : e));
}

console.log('\n=== 4. 用的是哪条安装路线，以及那条路线该满足的条件 ===');
{
  const profilePj = fs.existsSync(PROFILE_PKG) ? JSON.parse(fs.readFileSync(PROFILE_PKG, 'utf8')) : {};
  const bundles = (profilePj.dsh && profilePj.dsh.profile && profilePj.dsh.profile.bundles) || [];
  const inBundles = bundles.includes(PKG_NAME);
  const depSpec = (profilePj.dependencies || {})[PKG_NAME];
  const patchText = fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : '';
  const rowInProfilePatch = patchText.includes(PKG_NAME);

  console.log(`  （profile=${PROFILE}，bundles 里${inBundles ? '有' : '没有'}它，profile 的 patch 里${rowInProfilePatch ? '有' : '没有'}它）`);

  if (inBundles) {
    console.log('  → 标准路线（dsh plugin add file:...）');
    ok(!!depSpec, `profile 的 dependencies 里有它：${depSpec}`);
    ok(!rowInProfilePatch, 'profile 的 cordis.patch.yml **不需要**手插行（插入行来自包自带的 patch）');
    // 包自带的那份 patch 才是这条路线下真正的加载入口
    const own = path.join(INSTALLED, 'cordis.patch.yml');
    ok(fs.existsSync(own), '包自带 cordis.patch.yml');
    if (fs.existsSync(own)) {
      const t = fs.readFileSync(own, 'utf8');
      ok(/- insert:/.test(t), '包自带的 patch 是 insert 列表');
      ok(t.includes(`name: '${PKG_NAME}'`), `insert 的 name 是包名 ${PKG_NAME}`);
      ok(/- id: dm8-inspect/.test(t), 'insert 的 id 是 dm8-inspect');
    }
  } else {
    console.log('  → 手动路线（node tools/install.mjs）');
    ok(rowInProfilePatch, 'profile 的 cordis.patch.yml 里有插入行');
    ok(!depSpec, '（手动路线下 dependencies 里不该有它，走的是直接复制）');
  }

  // 两条路线下 profile 的 patch 都必须是合法 YAML
  try {
    const yamlReq = createRequire(path.join(DSH_HOME, 'profiles', 'node_modules', 'x.js'));
    const yamlPath = yamlReq.resolve('js-yaml');
    const yaml = await import(pathToFileURL(yamlPath).href);
    const doc = (yaml.default || yaml).load(patchText);
    ok(Array.isArray(doc), `profile 的 patch 解析出顶层数组（${Array.isArray(doc) ? doc.length + ' 项' : typeof doc}）`);
    if (!inBundles) {
      const row = Array.isArray(doc) ? doc.find((x) => x && Array.isArray(x.insert)) : null;
      ok(!!row, '数组里有 insert 项');
      if (row) {
        const entry = row.insert.find((e) => e && e.id === 'dm8-inspect');
        ok(!!entry, `insert 项里有 id=dm8-inspect（name=${entry && entry.name}）`);
      }
    } else {
      ok(doc.length === 0, '标准路线下 profile 的 patch 是空的（这是对的，不是缺失）');
    }
  } catch (e) {
    ok(false, '解析 YAML 失败：' + (e && e.message ? e.message : e));
  }
}

console.log('\n=== 5. 手动安装留下的备份（标准路线下可能不存在，正常）===');
{
  const bak = PATCH + '.dm8-inspect.bak';
  console.log(
    fs.existsSync(bak)
      ? `  （提示）存在 ${path.basename(bak)} —— 那是手动路线留下的原始 patch 备份，可留可删`
      : '  （提示）没有备份文件 —— 说明没走过手动路线，或者已经清理过'
  );
}

console.log(failed === 0 ? '\n安装验证通过 ✅' : `\n有 ${failed} 项失败 ❌`);
console.log('\n注意：首次新增插件后需要**新开一个会话**（或刷新页面）才会看到 dm8_inspect 工具。');
process.exit(failed === 0 ? 0 : 1);
