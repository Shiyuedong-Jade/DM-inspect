/**
 * 收录符合性自检：对照 awesome-dsh-plugin 的 contributing.md，
 * 把能在仓库里自动核的要求固化下来。
 *
 * 文档（https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md）
 * 对插件仓库的硬要求，逐条对应到下面：
 *
 *   1. `package.json` 声明 `dsh.bundle`（含 patch 路径），且该文件存在
 *   2. `cordis.patch.yml` 里有与包名一致的 insert 行
 *   3. 官方 `@deepseek-ai/*` 声明在 peerDependencies，不放 dependencies
 *   4. 每个 peer 范围匹配已安装的 harness 版本（用真 semver 计算）
 *   5. 有真实可用的代码（不是占位/纯 README）
 *   6. 描述里的数字（85 个巡检项）等于代码里的实际数量
 *   7. `dsh.client` 声明与 `exports["./client"]` 成对出现
 *   8. LICENSE 文件存在
 *
 * 无法在此自动核的（人工/平台侧）：仓库创建满 1 天、GitHub topic、
 * 是否与已有条目重复、活跃维护。
 *
 * 用法：node tools/package-check.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

let failed = 0;
const ok = (c, m) => {
  console.log((c ? '  [通过] ' : '  [失败] ') + m);
  if (!c) failed++;
};
const info = (m) => console.log('  （提示）' + m);

const pj = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));

console.log('\n=== 1. dsh.bundle：能不能被 dsh plugin add 装上 ===');
{
  const bundle = pj.dsh && pj.dsh.bundle;
  ok(!!bundle && typeof bundle.patch === 'string', `声明了 dsh.bundle.patch = ${bundle && bundle.patch}`);
  if (bundle && bundle.patch) {
    const p = path.join(PKG, bundle.patch);
    ok(fs.existsSync(p), `patch 文件存在：${bundle.patch}`);
    const src = fs.readFileSync(p, 'utf8');
    ok(/- insert:/.test(src), 'patch 是 insert 列表');
    ok(src.includes(`name: '${pj.name}'`), `insert 的 name 是包名 ${pj.name}`);
    ok(src.includes('- id: dm8-inspect'), 'insert 的 id 是 dm8-inspect');
  }
}

console.log('\n=== 2. 官方 @deepseek-ai/* 必须在 peerDependencies ===');
{
  const deps = pj.dependencies || {};
  const inDeps = Object.keys(deps).filter((k) => k.startsWith('@deepseek-ai/'));
  ok(inDeps.length === 0, 'dependencies 里没有 @deepseek-ai/*（有的话就不该带）' + (inDeps.length ? '：' + inDeps.join('、') : ''));
  const peers = pj.peerDependencies || {};
  ok(Object.keys(peers).length > 0, `peerDependencies：${Object.keys(peers).join('、')}`);
}

console.log('\n=== 3. peer 范围要真的匹配得上已安装的 harness ===');
console.log('    （文档那条预发布陷阱是真的，但它给的示例范围本身是错的 —— 这里用真 semver 算）');
{
  // semver 从 DSH 的共享 node_modules 里取；取不到就跳过这一节并说明
  let semver = null;
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    path.join(dshHome, 'profiles', 'node_modules', 'semver'),
    path.join(dshHome, 'profiles', 'web', 'node_modules', 'semver'),
    path.join(PKG, 'node_modules', 'semver'),
  ];
  let semverDir = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json'))) {
      semverDir = c;
      break;
    }
  }
  if (semverDir) {
    const req = createRequire(path.join(semverDir, 'x.js'));
    semver = req('semver');
  }
  if (!semver) {
    info('找不到 semver，跳过范围匹配这一节（这不是通过，是没验到）');
  } else {
    const root = path.dirname(semverDir); // => <dshHome>/profiles/node_modules
    for (const [name, range] of Object.entries(pj.peerDependencies || {})) {
      const pkgJson = path.join(root, ...name.split('/'), 'package.json');
      let ver = null;
      try {
        ver = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
      } catch (_) {
        /* 没装就当未知 */
      }
      if (!ver) {
        info(`${name}: 本机没装，跳过`);
        continue;
      }
      const hit = semver.satisfies(ver, range);
      ok(hit, `${name}：装的 ${ver} 落在 ${JSON.stringify(range)} 里`);
      if (!hit) {
        info('  ↑ 这个范围匹配不上已安装的版本，用户 npm install 时会 ERESOLVE。');
        info('    注意：节点 semver 只在「范围里某个比较符与该版本 major.minor.patch 完全相同、且自身带预发布标签」时才放行预发布版本。');
        info('    `*` 与 `>=0.1.0-rc.1 <0.2.0-0` 都**不**放行 0.1.5-rc.2；必须把比较符写在同一个元组上，例如 `^0.1.5-rc.2`。');
      }
    }
  }
}

console.log('\n=== 4. dsh.client 与 exports["./client"] 成对 ===');
{
  const hasClientDecl = !!(pj.dsh && pj.dsh.client);
  const clientExport = pj.exports && pj.exports['./client'];
  ok(
    hasClientDecl === !!clientExport,
    `声明与导出一致（dsh.client=${hasClientDecl}，exports["./client"]=${clientExport || '无'}）`
  );
  if (hasClientDecl) {
    ok(pj.dsh.client.platform === 'web', `dsh.client.platform = ${pj.dsh.client.platform}`);
    const p = path.join(PKG, String(clientExport).replace(/^\.\//, ''));
    ok(fs.existsSync(p), `客户端产物存在：${clientExport}`);
    // 声明了却找不到 bundle，会让 harness 启动即失败
    ok(/window\.__ModuleLoader__\.load\(\{/.test(fs.readFileSync(p, 'utf8')), '产物是闭包工厂形态');
    const dir = String(clientExport).replace(/^\.\//, '').split('/')[0];
    ok((pj.files || []).includes(dir), `files 覆盖了客户端产物目录（${dir}）`);
  }
}

console.log('\n=== 5. 真实可用的代码 ===');
{
  for (const f of ['lib/index.js', 'lib/tool.js', 'engine/runner.js', 'assets/java/DmBridge.java']) {
    const p = path.join(PKG, f);
    const exists = fs.existsSync(p);
    ok(exists && fs.statSync(p).size > 500, `${f} 存在且不是占位（${exists ? fs.statSync(p).size + ' 字节' : '缺失'}）`);
  }
}

console.log('\n=== 6. 描述必须属实：文档里的数字 == 代码里的实际数量 ===');
{
  // 逐个声明核对数字：总数归总数、子集归子集，
  // 避免把「dw.* 那 5 个」这类子集声明当成总数。
  const req = createRequire(path.join(PKG, 'package.json'));
  const readme = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8');

  let actual = 0;
  try {
    const checks = req('./engine/checks.js');
    actual = Array.isArray(checks) ? checks.length : 0;
  } catch (e) {
    info('加载 engine/checks.js 失败：' + (e && e.message));
  }
  ok(actual > 0, `引擎里实际有 ${actual} 个巡检项`);

  // 声明一：README 开头的总数
  const intro = /(\d+)\s*项只读巡检/.exec(readme);
  ok(!!intro, 'README 开头的总数声明可识别');
  ok(!!intro && Number(intro[1]) === actual, `README 说共 ${intro && intro[1]} 项，代码里 ${actual} 项`);

  // 声明二：package.json 的 description
  const desc = /(\d+)\s*项只读巡检/.exec(pj.description || '');
  ok(!!desc, 'package.json description 里声明了总数');
  ok(!!desc && Number(desc[1]) === actual, `description 说 ${desc && desc[1]} 项，代码里 ${actual} 项`);

  // 声明三：README 里对子集的声明（「dw.* 那 5 个巡检项」）
  try {
    const extra = req('./engine/checks-extra.js');
    const dw = (Array.isArray(extra) ? extra : []).filter((c) => c && c.group === '数据守护集群').length;
    const claim = /dw\.\*`?\s*那\s*(\d+)\s*个巡检项/.exec(readme);
    ok(!!claim, 'README 里能找到数据守护子集的声明');
    ok(!!claim && Number(claim[1]) === dw, `README 说数据守护有 ${claim && claim[1]} 项，代码里 ${dw} 项`);
  } catch (e) {
    info('加载 engine/checks-extra.js 失败：' + (e && e.message));
  }

  // 工具名也要与文档一致
  const toolSrc = fs.readFileSync(path.join(PKG, 'lib', 'tool.js'), 'utf8');
  const toolName = (/TOOL_NAME = '([^']+)'/.exec(toolSrc) || [])[1];
  ok(!!toolName && readme.includes(toolName), `README 提到了工具名 ${toolName}`);
}

console.log('\n=== 7. LICENSE ===');
{
  ok(!!pj.license, `package.json 里写了 license = ${pj.license}`);
  const lic = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => path.join(PKG, f)).find((p) => fs.existsSync(p));
  ok(!!lic, lic ? `存在 ${path.basename(lic)}` : '缺少 LICENSE 文件（npm 包与收录都会看这个）');
}

console.log('\n=== 8. repository：收录条目与 npm 关联都要用 ===');
{
  const repo = pj.repository;
  const url = typeof repo === 'string' ? repo : (repo && repo.url) || '';
  ok(!!url, `声明了 repository${url ? '：' + url : '（缺：收录条目与 npm 包关联都要它）'}`);
  ok(/github\.com/i.test(url), '指向 GitHub');
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(url);
  if (m) {
    info(`owner/repo = ${m[1]}/${m[2]}`);
    info(`  条目文件应叫 data/plugins/${m[1]}__${m[2]}.yml`);
    info(`  条目 url  = https://github.com/${m[1]}/${m[2]}`);
    info(`  条目 name = ${m[1]}/${m[2]}`);
  }
  if (pj.private === true) {
    info('private: true —— 不影响「从 GitHub 安装」，但**会挡住 npm 发布**（发 npm 是可选的）');
  }
}

console.log('\n=== 9. 文档里核不了、要人工/平台侧做的 ===');
console.log('  · 仓库创建满 1 天（CI 按 GitHub 仓库年龄自动查）');
console.log('  · 仓库添加 dsh-plugin topic');
console.log('  · 提 PR：data/plugins/<owner>__<repo>.yml（一个文件就是全部投稿），一个 PR 最多 3 条');
console.log('  · 描述只用功能陈述、不带营销词；描述里的每个数字/API 名都要能在代码里找到');

console.log(failed === 0 ? '\n收录符合性自检通过 ✅' : `\n有 ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
