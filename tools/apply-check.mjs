/**
 * 用假 ctx 调用插件的 `apply()`，验证注册流程。
 *
 * 覆盖 `apply()` 里的 Config 默认值解析、settings 注册、凭据服务读取、
 * 工作目录预检、工具注册；其中任何一步抛异常，cordis 会回滚整个 entry。
 *
 * 按 harness 的两种调用方式各跑一次：
 *   a) 配置项全给（像 cordis.patch.yml 里写了 config:）
 *   b) 配置项全不给（像只写 id 和 name，全靠 Config 的 default）
 *
 * 用法：node tools/apply-check.mjs [--installed]
 *   --installed  用装进 profile 的那一份，而不是源码目录下的那份
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const USE_INSTALLED = process.argv.includes('--installed');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const FROM = USE_INSTALLED
  ? path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-plugin-dm8-inspect', 'lib', 'index.js')
  : path.join(PKG, 'lib', 'index.js');

let failed = 0;
const ok = (c, m) => {
  console.log((c ? '  [通过] ' : '  [失败] ') + m);
  if (!c) failed++;
};

console.log(`\n被测模块：${FROM}`);
if (!fs.existsSync(FROM)) {
  console.error('找不到该文件。');
  process.exit(1);
}
const mod = await import(pathToFileURL(FROM).href);

/**
 * 造一个最小的 cordis ctx：只提供 apply 真正会碰的那几个入口。
 * @param {object} rec - 收集调用记录的容器
 */
function fakeCtx(rec) {
  const settings = {
    register: (ns, schema, opts) => {
      rec.settingsRegister = { ns, opts };
      // 真实实现返回一个 scope：get() 给解析后的快照。这里返回 base 本身，
      // 对应「用户什么都没改」的情形。
      return { get: () => (opts && opts.base) || {}, watch: () => () => {} };
    },
  };
  const ctx = {
    logger: {
      info: (m) => rec.logs.push(['info', String(m)]),
      warn: (m) => rec.logs.push(['warn', String(m)]),
    },
    settings,
    // cordis 把注入的服务挂成 ctx 的属性（ctx.tools / ctx.connection / …），
    // 插件里读的也是属性（`connCtx.connection`），这里照此模拟。
    ...(rec.connection !== undefined ? { connection: rec.connection } : {}),
    ...(rec.credentials !== undefined ? { credentials: rec.credentials } : {}),
    // 这里返回真的 settings 服务对象（上面 get('settings') 要能判真）；
    // 写成 rec.settings 而 rec 上没有该字段的话，插件会以为服务不存在而跳过注册。
    get: (name) =>
      name === 'settings'
        ? settings
        : name === 'credentials'
          ? rec.credentials
          : name === 'connection'
            ? rec.connection
            : undefined,
    /**
     * cordis 的 inject(deps, cb)：等依赖服务可用后回调。
     * 这里只记录挂起的注入（附上回调），由测试决定什么时候让服务出现。
     */
    inject: (deps, cb) => {
      const list = Array.isArray(deps) ? deps : [deps];
      const rec2 = { deps: list, cb };
      rec2.includes = (name) => list.includes(name);
      rec2.toString = () => list.join(',');
      // 调用方不一定预先建了 pendingInjections
      if (!rec.pendingInjections) rec.pendingInjections = [];
      rec.pendingInjections.push(rec2);
      // 若调用方已经准备好了该服务，就按 cordis 的行为立刻回调
      if (list.every((d) => rec[d] !== undefined)) cb(fakeCtx(rec));
      return () => {};
    },
    tools: {
      register: (def) => {
        rec.tools.push(def);
        return () => {};
      },
    },
  };
  return ctx;
}

async function run(label, config) {
  console.log(`\n=== ${label} ===`);
  const rec = { logs: [], tools: [], settingsRegister: null, credentials: null };
  let threw = null;
  try {
    mod.apply(fakeCtx(rec), config);
  } catch (e) {
    threw = e;
  }
  ok(!threw, threw ? `apply 抛异常：${threw.message}\n${threw.stack}` : 'apply 没有抛异常');
  ok(rec.tools.length === 1, `注册了 ${rec.tools.length} 个工具`);
  if (rec.tools.length) {
    const t = rec.tools[0];
    ok(t.name === 'dm8_inspect', `工具名 = ${t.name}`);
    ok(typeof t.execute === 'function' && typeof t.output.render === 'function', '工具有 execute 与 output.render');
  }
  ok(!!rec.settingsRegister, `注册了 settings 命名空间：${rec.settingsRegister && rec.settingsRegister.ns}`);
  if (rec.settingsRegister) {
    ok(rec.settingsRegister.opts.applies === 'live', `applies = ${rec.settingsRegister.opts.applies}`);
  }
  const warned = rec.logs.filter(([lvl]) => lvl === 'warn');
  const infoed = rec.logs.filter(([lvl]) => lvl === 'info');
  ok(infoed.length > 0, `打了 ${infoed.length} 条 info 日志`);
  if (warned.length) console.log('  （日志里的警告）' + warned.map(([, m]) => m).join(' / '));
  return rec;
}

// a) 配置全给：工作目录指到临时目录，保证可写，验证正常路径的日志
const tmpHome = path.join(os.tmpdir(), 'dm8-inspect-apply-check');
fs.rmSync(tmpHome, { recursive: true, force: true });
const recA = await run('a) 配置项齐全（临时工作目录）', {
  home: tmpHome,
  driver: 'jdbc',
  credentialRef: 'DM8_INSPECT_PASSWORD',
  sshCredentialRef: 'DM8_INSPECT_SSH_PASSWORD',
  outDir: '',
  queryTimeoutMs: 30000,
  connectTimeoutMs: 20000,
  slowSqlMs: 1000,
  tsWarnPct: 80,
  tsCritPct: 90,
  topN: 10,
  clusterConcurrency: 3,
});
ok(fs.existsSync(path.join(tmpHome, 'drivers')), '工作目录被建出来了（apply 里的预检真的执行了）');
ok(fs.existsSync(path.join(tmpHome, 'java', 'DmBridge.java')), '桥接源码被复制过去了');
ok(
  recA.logs.some(([, m]) => /已注册工具 dm8_inspect/.test(m)),
  '日志里写明了注册的工具名'
);
ok(
  recA.logs.some(([, m]) => /未放 jar/.test(m)),
  '缺驱动 jar 时在加载阶段就提示了（而不是等模型调用才发现）'
);

// b) 配置全不给：完全依赖 Config 的 default，对应插进 patch 时只写 id 和 name 的写法
const recB = await run('b) 配置项一个都不给（走 Config 默认值）', {});
ok(
  recB.logs.some(([, m]) => m.includes('.dsh') || m.includes('dm8-inspect')),
  '默认工作目录按 DSH_HOME 解析出来了'
);
if (recB.tools.length) {
  const props = Object.keys((recB.tools[0].parameters && recB.tools[0].parameters.properties) || {});
  ok(props.length >= 10, `参数 schema 正常展开（${props.length} 个参数）`);
}

// c) 凭据服务可用时会被读到（软取，不注入）
console.log('\n=== c) 凭据服务存在时不炸 ===');
{
  const rec = { logs: [], tools: [], settingsRegister: null, credentials: { resolve: async () => ({ value: 'x', source: 'test' }) } };
  let threw = null;
  try {
    mod.apply(fakeCtx(rec), { home: tmpHome });
  } catch (e) {
    threw = e;
  }
  ok(!threw, threw ? 'apply 抛异常：' + threw.message : 'apply 正常（凭据服务只是 ctx.get 软取，不阻塞加载）');
}

// d) 界面口令路由：按真实的服务出现顺序测试
//
// connection 由 web bundle 插入、比 tools 晚，apply 跑的那一刻它还不存在，
// 用 ctx.get 取一次拿不到，路由也就不会注册。这里的顺序是：
// apply 时没有 connection → 回调先挂起 → 服务出现后才注册。
console.log('\n=== d) 界面口令路由：connection 晚于 apply 出现 ===');
{
  const routes = [];
  const rec = {
    logs: [],
    tools: [],
    settingsRegister: null,
    // 不给 rec.connection，对应 connection 尚未出现的启动阶段
    pendingInjections: [],
    connection: undefined,
  };
  const ctx = fakeCtx(rec);
  let threw = null;
  try {
    mod.apply(ctx, { home: tmpHome });
  } catch (e) {
    threw = e;
  }
  ok(!threw, threw ? 'apply 抛异常：' + threw.message : 'apply 正常（connection 还没出现也不该抛）');
  ok(routes.length === 0, '此时还没有路由（服务没出现，回调不该跑）');
  ok(
    rec.pendingInjections.some((d) => d.includes('connection')),
    `用 ctx.inject 声明了对 connection 的依赖：${JSON.stringify(rec.pendingInjections)}`
  );

  // 服务出现：手工触发挂起的注入回调，对应 cordis 在服务就绪时的行为
  const fire = rec.pendingInjections.find((d) => d.includes('connection'));
  rec.connection = { fetch: { register: (r) => routes.push(r) } };
  try {
    fire.cb(fakeCtx(rec));
  } catch (e) {
    threw = e;
  }
  ok(!threw, threw ? '注入回调抛异常：' + threw.message : '服务出现后回调正常执行');
  ok(routes.length === 1, `服务出现后注册了 ${routes.length} 条路由`);
  const r = routes[0] || {};
  ok(r.path === '/api/dm8-inspect.secret', `路径 = ${r.path}`);
  ok(
    Array.isArray(r.methods) && ['GET', 'POST', 'DELETE'].every((m) => r.methods.includes(m)),
    `方法 = ${JSON.stringify(r.methods)}`
  );
  ok(r.requestBody === 'buffered', `requestBody = ${r.requestBody}`);
  ok(typeof r.fetch === 'function', '带 fetch 处理器');
  ok(
    rec.logs.some(([, m]) => /卡片路由已注册/.test(m)),
    '日志里说明了路由已注册且在内存里'
  );

  // 调用一次 GET，验证处理器可用
  const res = await r.fetch(new Request('http://127.0.0.1:3080/api/dm8-inspect.secret?session=s1'));
  const body = await res.json();
  ok(res.status === 200 && body.ok === true, '处理器可调用并返回合法响应');
  ok(body.configured && body.configured.password === false, '新会话初始为「未设置」');

  // connection 存在但形状不对时警告而不是抛异常
  const rec2 = { logs: [], tools: [], settingsRegister: null, pendingInjections: [], connection: { fetch: {} } };
  const ctx2 = fakeCtx(rec2);
  mod.apply(ctx2, { home: tmpHome });
  const fire2 = rec2.pendingInjections.find((d) => d.includes('connection'));
  let threw2 = null;
  try {
    fire2.cb(fakeCtx(rec2));
  } catch (e) {
    threw2 = e;
  }
  ok(!threw2, 'connection 形状不对时不抛异常');
  ok(
    rec2.logs.some(([, m]) => /没有 fetch\.register/.test(m)),
    '并对「服务存在但形状不对」给出明确警告'
  );
}

console.log(failed === 0 ? '\napply 检查通过 ✅' : `\n有 ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
