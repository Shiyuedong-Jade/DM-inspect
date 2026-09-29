/**
 * 把本插件装进一个 DSH profile。幂等，可以反复运行。
 *
 * 做两件事：
 *   1. 把插件包复制到 <profile>/node_modules/dsh-plugin-dm8-inspect
 *   2. 往 <profile>/cordis.patch.yml 里插一行（已存在就跳过），首次会备份原文件
 *
 * 复制而非软链：Node 解析裸模块名时用真实路径，软链会让
 * `import '@deepseek-ai/dsh-tools'` 从源目录往上找，找不到 profile 的共享
 * node_modules；复制成真实目录后，父级查找正好落到 DSH 维护的共享 node_modules 上。
 *
 * 用法：
 *   node tools/install.mjs                 # 装进 web profile
 *   node tools/install.mjs --profile web
 *   node tools/install.mjs --dry-run       # 只看会做什么，不落盘
 *   node tools/install.mjs --uninstall     # 移除插件目录与那一行
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const PKG_NAME = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).name;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DRY = has('--dry-run');
const UNINSTALL = has('--uninstall');
const PROFILE = argVal('--profile', 'web');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const TARGET = path.join(PROFILE_DIR, 'node_modules', PKG_NAME);
const PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml');
const BACKUP = PATCH + '.dm8-inspect.bak';

/**
 * 安装时跳过的开发/运行产物。
 *
 * 含运行时会产生的报告目录 dm8-inspect-reports：默认 outDir 是 `<cwd>/dm8-inspect-reports`，
 * 在包目录里跑冒烟测试时 cwd 就是包目录，该目录会出现在包根下。
 */
const SKIP = new Set([
  '.dev-home',
  '.dev-reports',
  'dm8-inspect-reports',
  'tools',
  '.git',
  '.gitignore',
  'node_modules',
]);

const say = (m) => console.log(m);
const die = (m) => {
  console.error('❌ ' + m);
  process.exit(1);
};

if (!fs.existsSync(PROFILE_DIR)) {
  die(`找不到 profile 目录：${PROFILE_DIR}\n（用 --profile <名称> 指定别的 profile；profile 不存在时先跑一次 dsh --profile <名称> 让它初始化。）`);
}

const BLOCK = [
  '- insert:',
  `    - id: dm8-inspect`,
  `      name: '${PKG_NAME}'`,
].join('\n');

/** 从 patch 文本里判断插件行是否已在。 */
function alreadyPatched(text) {
  return text.split(/\r?\n/).some((l) => l.includes(PKG_NAME));
}

/** 把插入块并入 patch 文本：有 `[]` 占位就替换它，否则追加。 */
function withBlock(text) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === '[]');
  if (i >= 0) {
    lines[i] = [
      '# 达梦 DM8 数据库巡检插件（本地包；本文件是 patchReload: live 的，保存即生效，不用重启 dsh web）',
      '# 想调参数就在下面这一行加 config:，可选项见该包 README 第五节。',
      BLOCK,
    ].join('\n');
  } else {
    lines.push('', '# 达梦 DM8 数据库巡检插件', BLOCK);
  }
  return lines.join('\n');
}

/** 把插入块从 patch 文本里摘掉（只摘本脚本加的那几行）。 */
function withoutBlock(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '- insert:' && (lines[i + 1] || '').includes('id: dm8-inspect')) {
      i += 2; // 跳过 id 行与 name 行
      continue;
    }
    if (lines[i].includes('# 达梦 DM8 数据库巡检插件')) continue;
    if (lines[i].includes('# 想调参数就在下面这一行加 config:')) continue;
    out.push(lines[i]);
  }
  const txt = out.join('\n');
  // 摘空了就放回空数组占位，保持文件是合法 YAML
  return /^\s*$/m.test(txt.replace(/^#.*$/gm, '')) && !/^\s*-\s/m.test(txt) ? txt.replace(/\n+$/, '') + '\n[]\n' : txt;
}

/** 递归复制（跳过 SKIP）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// ------------------------------------------------------------------ 卸载
if (UNINSTALL) {
  say(`卸载 ${PKG_NAME}　profile=${PROFILE}`);
  if (DRY) {
    say(`  [dry-run] 会删除 ${TARGET}`);
    say(`  [dry-run] 会从 ${PATCH} 摘掉插入行`);
    process.exit(0);
  }
  if (fs.existsSync(TARGET)) {
    fs.rmSync(TARGET, { recursive: true, force: true });
    say(`  已删除 ${TARGET}`);
  } else {
    say(`  （目录本来就不存在：${TARGET}）`);
  }
  if (fs.existsSync(PATCH)) {
    const cur = fs.readFileSync(PATCH, 'utf8');
    if (alreadyPatched(cur)) {
      fs.writeFileSync(PATCH, withoutBlock(cur), 'utf8');
      say(`  已从 ${PATCH} 摘掉插入行`);
    } else {
      say('  （patch 文件里本来就没有这一行）');
    }
  }
  say('\n记得重开一个会话或刷新页面；已加载的插件会随 patch 重载被丢掉。');
  process.exit(0);
}

// ------------------------------------------------------------------ 安装
say(`安装 ${PKG_NAME}`);
say(`  源目录：  ${PKG}`);
say(`  profile： ${PROFILE_DIR}`);

// 1) 复制包
if (DRY) {
  say(`  [dry-run] 会复制到 ${TARGET}`);
} else {
  // 先复制到同级的临时目录，成功后再原子换名：中途失败不会破坏正在被 harness 引用的旧副本。
  const NM = path.join(PROFILE_DIR, 'node_modules');
  const TMP = path.join(NM, `.${PKG_NAME}.tmp-${process.pid}-${Date.now()}`);
  try {
    copyDir(PKG, TMP);
    if (!fs.existsSync(path.join(TMP, 'lib', 'index.js'))) throw new Error('复制结果里没有 lib/index.js');
    if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
    fs.renameSync(TMP, TARGET);
    say(`  已复制到 ${TARGET}（顶层 ${fs.readdirSync(TARGET).length} 项）`);
  } catch (e) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录清不掉不影响结论 */
    }
    die(
      `写入失败：${e && e.message ? e.message : e}\n` +
        `（旧副本${fs.existsSync(TARGET) ? '仍然完好、未被破坏' : '不存在'}。\n` +
        ` 写 ~/.dsh 需要更宽的权限：本脚本要在具备该目录写权限的终端里运行，\n` +
        ` 或在 DSH 会话里用沙箱升级重跑一次同样的命令。）`
    );
  }
}
if (!fs.existsSync(path.join(PKG, 'lib', 'index.js'))) die('源包里没有 lib/index.js，包不完整。');

// 2) 插一行
const orig = fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : '';
if (alreadyPatched(orig)) {
  say(`  patch 里已有插入行，跳过：${PATCH}`);
} else {
  const next = withBlock(orig);
  if (DRY) {
    say(`  [dry-run] 会在 ${PATCH} 写入：\n${next.split(/\r?\n/).map((l) => '      ' + l).join('\n')}`);
  } else {
    if (orig && !fs.existsSync(BACKUP)) {
      fs.writeFileSync(BACKUP, orig, 'utf8');
      say(`  已备份原文件：${BACKUP}`);
    }
    fs.writeFileSync(PATCH, next, 'utf8');
    say(`  已写入插入行：${PATCH}`);
  }
}

say('\n接下来：');
say('  1) 把达梦 JDBC 驱动 jar 放到 %USERPROFILE%\\.dsh\\dm8-inspect\\drivers\\');
say('  2) 把口令放进凭据库（或启动 dsh 前设 DM8_INSPECT_PASSWORD 环境变量）');
say('  3) web profile 是 patchReload: live，保存即生效；**新开一个会话**让工具出现在工具表里');
say('  4) 想改插件代码：改完重跑本脚本（幂等复制），再新开会话');
say('  5) 卸载：node tools/install.mjs --uninstall');
