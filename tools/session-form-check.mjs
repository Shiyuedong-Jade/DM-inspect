/**
 * 「卡片里填的巡检设置」这条链路的离线自检。
 *
 * 覆盖：
 *   1. 进程内暂存：按会话隔离、合并写入、清空；
 *   2. 状态查询只回口令的布尔值，非秘密字段才回传内容；
 *   3. 路由处理器（纯 Request → Response）行为，含未知字段拒绝；
 *   4. 这条链路不碰磁盘；
 *   5. 工具侧的取值优先级：调用参数 > 卡片 > 凭据库，且 targets 能只靠卡片提供；
 *   6. 目标解析：一个 → 单实例、两个及以上 → 集群；
 *   7. 卡片字段表与 host 字段表不漂移（client/client.js 与 lib/session-form.js）；
 *   8. client 产物符合 DSH 闭包工厂契约，且不做本地留存（console/localStorage/cookie/URL）。
 *
 * 用法：node tools/session-form-check.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FORM_FIELDS,
  SECRET_NAMES,
  FIELD_NAMES,
  SECRET_ROUTE,
  setSessionForm,
  getSessionForm,
  getFormField,
  clearSessionForm,
  sessionFormStatus,
  sessionFormCount,
  resetSessionForms,
  parseTargets,
  handleFormRequest,
} from '../lib/session-form.js';
import { makeDm8Tool } from '../lib/tool.js';
import { loadEngine } from '../lib/engine.js';
import { prepareHome } from '../lib/workspace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

let failed = 0;
const ok = (c, m) => {
  console.log((c ? '  [通过] ' : '  [失败] ') + m);
  if (!c) failed++;
};

const S1 = 'session-aaaa-1111';
const S2 = 'session-bbbb-2222';

console.log('\n=== 1. 进程内暂存：按会话隔离 ===');
resetSessionForms();
ok(sessionFormCount() === 0, '初始为空');
setSessionForm(S1, { targets: '10.0.0.1:5236', password: 'pw-A' });
setSessionForm(S2, { targets: '10.0.0.2:5236', password: 'pw-B', sshPassword: 'ssh-B', sshUser: 'root' });
ok(getFormField(S1, 'password') === 'pw-A', '会话 1 取到自己的口令');
ok(getFormField(S2, 'password') === 'pw-B', '会话 2 取到自己的口令');
ok(getFormField(S1, 'password') !== getFormField(S2, 'password'), '两个会话互不串（不同库要用不同值）');
ok(getFormField(S1, 'sshPassword') === null, '会话 1 没设 SSH 口令就是 null，不会拿会话 2 的');
ok(getFormField(S1, 'targets') === '10.0.0.1:5236', '非秘密字段同样按会话隔离');
ok(sessionFormCount() === 2, `两个会话各一条记录（实际 ${sessionFormCount()}）`);

console.log('\n=== 2. 合并写入与清除 ===');
setSessionForm(S2, { password: 'pw-B2' });
ok(getFormField(S2, 'password') === 'pw-B2', '只给 password 时覆盖该字段');
ok(getFormField(S2, 'sshPassword') === 'ssh-B', '没给的字段保持原值（合并而非替换）');
ok(getFormField(S2, 'sshUser') === 'root', '非秘密字段也保持原值');
setSessionForm(S2, { sshPassword: '' });
ok(getFormField(S2, 'sshPassword') === null, '给空串等于清除该字段');
clearSessionForm(S1);
ok(getFormField(S1, 'password') === null, 'clearSessionForm 清空整个会话');
ok(sessionFormCount() === 1, '清空后另一个会话不受影响');

console.log('\n=== 3. 状态查询：口令只回布尔，非秘密字段回传 ===');
{
  resetSessionForms();
  setSessionForm(S1, { targets: '10.0.0.9:5236', user: 'SYSDBA', topN: '20', password: 'topsecret' });
  const st = sessionFormStatus(S1);
  ok(JSON.stringify(st.configured) === JSON.stringify({ password: true, sshPassword: false }), '口令只有布尔：' + JSON.stringify(st.configured));
  const flat = JSON.stringify(st);
  ok(!flat.includes('topsecret'), '状态里不含口令内容');
  ok(st.values.targets === '10.0.0.9:5236' && st.values.topN === '20', '非秘密字段回传当前值（供卡片显示）');
  ok(st.values.password === undefined && st.values.sshPassword === undefined, 'values 里没有口令字段');
}

console.log('\n=== 4. 路由处理器（纯 Request → Response）===');
{
  resetSessionForms();
  const post = (body, method) =>
    new Request('http://127.0.0.1:3080' + SECRET_ROUTE, {
      method: method || 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  let res = await handleFormRequest(post({ session: S2, targets: '10.0.0.1:5236', user: 'SYSDBA', password: 'route-pw' }));
  let body = await res.json();
  ok(res.status === 200 && body.ok === true, 'POST 写入成功');
  ok(body.configured.password === true, 'POST 返回写入后的状态');
  ok(body.values.targets === '10.0.0.1:5236', 'POST 返回非秘密字段值');
  ok(!JSON.stringify(body).includes('route-pw'), '响应里不含口令内容');
  ok(res.headers.get('cache-control') === 'no-store', '响应带 no-store');

  res = await handleFormRequest(
    new Request('http://127.0.0.1:3080' + SECRET_ROUTE + '?session=' + encodeURIComponent(S2))
  );
  body = await res.json();
  ok(res.status === 200 && body.configured.password === true, 'GET 读到「已设置」');
  ok(!JSON.stringify(body).includes('route-pw'), 'GET 响应里同样不含口令内容');

  // 非法输入
  res = await handleFormRequest(new Request('http://127.0.0.1:3080' + SECRET_ROUTE, { method: 'POST', body: 'not-json' }));
  ok(res.status === 400, '非 JSON 请求体 → 400');
  res = await handleFormRequest(post({ session: S2 }));
  ok(res.status === 400, '没有任何可写字段 → 400');
  res = await handleFormRequest(post({ session: S2, password: 123 }));
  ok(res.status === 400, 'password 不是字符串 → 400');
  res = await handleFormRequest(post({ session: S2, evil: 'y' }));
  ok(res.status === 400, '未知字段被拒绝（字段表漂移要立刻发现）');
  res = await handleFormRequest(new Request('http://127.0.0.1:3080' + SECRET_ROUTE, { method: 'PUT' }));
  ok(res.status === 405, '不支持的方法 → 405');

  res = await handleFormRequest(
    new Request('http://127.0.0.1:3080' + SECRET_ROUTE + '?session=' + encodeURIComponent(S2), { method: 'DELETE' })
  );
  body = await res.json();
  ok(res.status === 200 && body.configured.password === false, 'DELETE 清空该会话');
  ok(getFormField(S2, 'password') === null, 'DELETE 之后内存里确实没了');
}

console.log('\n=== 5. 目标解析：一个=单实例，两个及以上=集群 ===');
{
  const one = parseTargets('10.127.11.40:5236', 5236, 'SYSDBA');
  ok(one.length === 1 && one[0].host === '10.127.11.40' && one[0].port === 5236, '单个 host:port');
  const two = parseTargets('10.127.11.61:7236\n10.127.11.62:7237', 5236, 'SYSDBA');
  ok(two.length === 2 && two[1].host === '10.127.11.62' && two[1].port === 7237, '换行分隔的两个节点');
  const mixed = parseTargets('10.0.0.1:5236, 10.0.0.2 ;10.0.0.3', 5236, 'SYSDBA');
  ok(mixed.length === 3 && mixed[1].port === 5236, '逗号/分号分隔，且缺省端口生效');
  ok(parseTargets('', 5236, 'SYSDBA').length === 0, '空文本 → 空数组');
  const v6 = parseTargets('[::1]:5236', 5236, 'SYSDBA');
  ok(v6.length === 1 && v6[0].host === '::1', 'IPv6 字面量写法');
}

console.log('\n=== 6. 这条链路不碰磁盘 ===');
{
  resetSessionForms();
  const home = path.join(os.tmpdir(), 'dm8-inspect-form-home');
  fs.rmSync(home, { recursive: true, force: true });
  prepareHome(home);
  const snapshot = (dir) => {
    const out = [];
    const walk = (d) => {
      let es = [];
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(dir);
    return out;
  };
  const before = snapshot(home);
  setSessionForm(S1, { targets: 'x', password: 'disk-check-1' });
  setSessionForm(S2, { password: 'disk-check-2', sshPassword: 'disk-check-3' });
  await handleFormRequest(
    new Request('http://127.0.0.1:3080' + SECRET_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: S1, user: 'SYSDBA', password: 'disk-check-4' }),
    })
  );
  const after = snapshot(home);
  ok(after.length === before.length, `工作目录文件数不变（${before.length} → ${after.length}）`);
  const leaked = after.filter((p) => {
    try {
      return fs.readFileSync(p, 'utf8').includes('disk-check');
    } catch (_) {
      return false;
    }
  });
  ok(leaked.length === 0, '工作目录里没有任何文件包含口令明文' + (leaked.length ? '：' + leaked.join('、') : ''));
  resetSessionForms();
}

console.log('\n=== 7. 工具侧取值优先级 ===');
{
  resetSessionForms();
  const home = path.join(os.tmpdir(), 'dm8-inspect-form-tool');
  fs.rmSync(home, { recursive: true, force: true });
  const prep = prepareHome(home);
  fs.writeFileSync(path.join(prep.driverDir, 'DmJdbcDriver18.jar'), 'fake');

  let seen = null;
  let clusterSeen = null;
  const fakeEngine = {
    runner: {
      runInspection: async (params) => {
        seen = params;
        return {
          summary: { crit: 0, warn: 0, ok: 1, info: 0, na: 0, error: 0, total: 1 },
          checks: [],
          meta: { host: params.cred.host, port: params.cred.port },
        };
      },
    },
    cluster: {
      runClusterInspection: async (params) => {
        clusterSeen = params;
        return {
          deployMode: '共享存储集群（DMDSC）',
          summary: { crit: 0, warn: 0, ok: 1, info: 0, na: 0, error: 0, total: 2 },
          nodeCount: params.targets.length,
          nodes: params.targets.map((t) => ({
            label: t.label || t.host,
            info: { label: t.label || t.host, role: 'EP' },
            data: { summary: { crit: 0, warn: 0, ok: 1, info: 0, na: 0, error: 0, total: 1 }, checks: [], issues: [] },
          })),
          issues: [],
        };
      },
    },
    report: { renderReport: () => '<html></html>', renderClusterReport: () => '<html></html>' },
  };

  const cfg = {
    home,
    driver: 'jdbc',
    credentialRef: 'FORM_TEST_PW',
    sshCredentialRef: 'FORM_TEST_SSH',
    outDir: path.join(os.tmpdir(), 'dm8-inspect-form-out'),
    queryTimeoutMs: 30000,
    connectTimeoutMs: 1,
    slowSqlMs: 1000,
    tsWarnPct: 80,
    tsCritPct: 90,
    topN: 10,
    clusterConcurrency: 1,
  };
  const execWith = (sessionId) => ({
    signal: new AbortController().signal,
    agent: { session: { id: sessionId, header: { id: sessionId, cwd: os.tmpdir() } } },
  });
  const build = (resolveSecret) =>
    makeDm8Tool({ defineTool: (s) => s, getConfig: () => cfg, loadEngine: () => fakeEngine, prepareHome, resolveSecret, log: () => {} });

  // A) 只靠卡片：targets / user / 阈值 / 口令 / SSH 全从卡片来，调用参数一个不给
  setSessionForm(S1, {
    targets: '10.0.0.7:5236',
    user: 'CARDUSER',
    topN: '25',
    tsWarnPct: '70',
    tsCritPct: '85',
    slowSqlMs: '2500',
    sshUser: 'dmdba',
    password: 'card-pw',
    sshPassword: 'card-ssh-pw',
  });
  const a = await build(async () => null).execute({}, execWith(S1));
  ok(seen && seen.cred.host === '10.0.0.7', '卡片里的目标被用上了：' + (seen && seen.cred.host));
  ok(seen && seen.cred.user === 'CARDUSER', '卡片里的数据库账号被用上了');
  ok(seen && seen.cred.password === 'card-pw', '卡片里的口令被用上了');
  ok(seen && seen.options.topN === 25 && seen.options.tsWarnPct === 70 && seen.options.slowSqlMs === 2500, '卡片里的 Top N / 阈值被用上了：' + JSON.stringify({ topN: seen && seen.options.topN, warn: seen && seen.options.tsWarnPct, slow: seen && seen.options.slowSqlMs }));
  ok(seen && seen.options.remote && seen.options.remote.enabled, '卡片里填了 SSH 账号+口令 → 自动开 OS 采集（不用再交代）');
  ok(seen && seen.options.remote.user === 'dmdba', 'SSH 账号来自卡片');
  ok(a.ok === true && a.targets[0] === '10.0.0.7:5236', '返回值里的目标正确');
  ok(a.notes.some((n) => /目标来源：调用卡片/.test(n)), 'notes 说明目标来自卡片');
  ok(a.notes.some((n) => /口令来源：调用卡片/.test(n)), 'notes 说明口令来源');

  // B) 显式参数压过卡片
  const b = await build(async () => null).execute(
    { targets: [{ host: '10.0.0.8', port: 5237 }], user: 'ARGUSER', topN: 5, password: 'arg-pw', sshUser: 'root' },
    execWith(S1)
  );
  ok(seen.cred.host === '10.0.0.8' && seen.cred.port === 5237, '参数里的目标优先');
  ok(seen.cred.user === 'ARGUSER', '参数里的账号优先');
  ok(seen.cred.password === 'arg-pw', '参数里的口令优先');
  ok(seen.options.topN === 5, '参数里的 Top N 优先');
  ok(seen.options.remote.password === 'card-ssh-pw', 'SSH 账号来自参数、口令仍可来自卡片');
  ok(b.notes.some((n) => /目标来源：本次调用参数/.test(n)), 'notes 说明目标来自参数');

  // C) 卡片多节点 → 自动走集群
  setSessionForm(S1, { targets: '10.0.0.11:7236\n10.0.0.12:7237', password: 'cluster-pw' });
  const c = await build(async () => null).execute({}, execWith(S1));
  ok(!!clusterSeen, '两个目标 → 走了集群巡检');
  ok(clusterSeen && clusterSeen.targets.length === 2, `集群节点数 = ${clusterSeen && clusterSeen.targets.length}`);
  ok(c.mode === 'cluster' && c.nodes.length === 2, '返回值标记为集群且有两个节点');

  // D) 卡片没填目标、参数也没给 → 报错要把卡片列在第一条
  resetSessionForms();
  let msg = '';
  try {
    await build(async () => null).execute({}, execWith(S1));
  } catch (e) {
    msg = e.message;
  }
  ok(/没有巡检目标/.test(msg), '没目标时明确报错');
  ok(/调用卡片/.test(msg), '并把「在卡片里填」列为首选');

  // E) 卡片没填口令 → 落到凭据库
  setSessionForm(S1, { targets: '10.0.0.9:5236' });
  const e2 = await build(async (ref) => (ref === 'FORM_TEST_PW' ? 'from-store' : null)).execute({}, execWith(S1));
  ok(seen.cred.password === 'from-store', '卡片没填口令时回落到凭据库');
  ok(e2.notes.some((n) => /口令来源：凭据 FORM_TEST_PW/.test(n)), 'notes 说明来源是凭据库');

  // F) 三处都没有 → 报错
  resetSessionForms();
  let msg2 = '';
  try {
    await build(async () => null).execute({ targets: [{ host: '10.0.0.9', port: 5236 }] }, execWith(S1));
  } catch (e) {
    msg2 = e.message;
  }
  ok(/未提供数据库口令/.test(msg2), '三处都没有口令时明确报错');
  ok(/数据库口令」那一栏/.test(msg2), '并点名卡片里的具体栏目');
  resetSessionForms();
}

console.log('\n=== 8. 卡片字段表与 host 字段表不漂移 ===');
{
  const clientSrc = fs.readFileSync(path.join(PKG, 'client', 'client.js'), 'utf8');
  const hostSrc = fs.readFileSync(path.join(PKG, 'lib', 'session-form.js'), 'utf8');

  // 每个 host 字段都必须在卡片里出现
  const missing = FIELD_NAMES.filter((n) => !clientSrc.includes("'" + n + "'"));
  ok(missing.length === 0, '卡片覆盖了全部字段' + (missing.length ? '，缺：' + missing.join('、') : `（${FIELD_NAMES.length} 个）`));

  // 卡片里那份「非秘密字段」清单必须与 host 的 kind 分类一致
  const m = /var PLAIN_FIELDS = \[([\s\S]*?)\]/.exec(clientSrc);
  ok(!!m, '卡片里有 PLAIN_FIELDS 清单');
  if (m) {
    const plain = Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
    const hostPlain = FORM_FIELDS.filter((f) => f.kind !== 'secret').map((f) => f.name);
    ok(
      JSON.stringify(plain.slice().sort()) === JSON.stringify(hostPlain.slice().sort()),
      '非秘密字段清单一致：' + JSON.stringify(plain) + ' vs ' + JSON.stringify(hostPlain)
    );
  }
  const secretMissing = SECRET_NAMES.filter((n) => !clientSrc.includes("setField('" + n + "')"));
  ok(secretMissing.length === 0, '口令字段在卡片里都有输入框：' + SECRET_NAMES.join('、'));

  // 常量两边一致
  const toolSrc = fs.readFileSync(path.join(PKG, 'lib', 'tool.js'), 'utf8');
  ok(/TOOL_NAME = 'dm8_inspect'/.test(toolSrc), 'lib/tool.js 里 TOOL_NAME 是 dm8_inspect');
  ok(clientSrc.includes("var TOOL_NAME = 'dm8_inspect'"), '卡片的 TOOL_NAME 与之一致');
  ok(hostSrc.includes("'/api/dm8-inspect.secret'"), 'lib/session-form.js 里 SECRET_ROUTE 固定');
  ok(clientSrc.includes("var ENDPOINT = '/api/dm8-inspect.secret'"), '卡片的 ENDPOINT 与之一致');
}

console.log('\n=== 9. client 产物符合闭包工厂契约 ===');
{
  const file = path.join(PKG, 'client', 'client.js');
  const src = fs.readFileSync(file, 'utf8');
  // 剥离注释后再做静态扫描：注释里出现 localStorage 之类字样不算使用。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');

  ok(!/^\s*(import|export)\s/m.test(code), '没有 import/export（契约要求经典脚本）');
  ok(/window\.__ModuleLoader__\.load\(\{/.test(code), '调用了 window.__ModuleLoader__.load({...})');
  ok(/id:\s*'dsh-plugin-dm8-inspect'/.test(code), 'module id 用包名');
  ok(/factory:\s*\(require\)\s*=>/.test(code), '有 factory(require) 形态');
  ok(/return module\.exports;/.test(code), 'factory 末尾返回 module.exports');
  for (const [re, label] of [
    [/localStorage/, '不用 localStorage'],
    [/sessionStorage/, '不用 sessionStorage'],
    [/document\.cookie/, '不写 cookie'],
    [/console\.(log|info|warn|error)/, '不往 console 打印（口令可能路过）'],
    [/indexedDB/, '不用 indexedDB'],
  ]) {
    ok(!re.test(code), label);
  }
  ok(/credentials:\s*'same-origin'/.test(code), 'fetch 带 same-origin（走 /api 的浏览器会话鉴权）');
  ok(/type:\s*props\.secret \? 'password' : 'text'/.test(code), '口令字段渲染成 password 输入框');
  ok(!/ENDPOINT\s*\+\s*\(?method\s*===\s*'POST'[^)]*\)?\s*\?\s*''\s*:\s*'[^']*password/.test(code), '口令不拼进 URL');
  ok(!/'password'\s*\+\s*'='/.test(code), '口令不出现在查询串里');

  // 真的在沙箱里跑一遍：造最小 window/require
  const registered = [];
  const g = globalThis;
  const saved = g.window;
  g.window = { __ModuleLoader__: { load: (spec) => registered.push(spec) } };
  try {
    await import(pathToFileURL(file).href + '?t=' + Date.now());
  } finally {
    if (saved === undefined) delete g.window;
    else g.window = saved;
  }
  ok(registered.length === 1, `登记了 1 个工厂（实际 ${registered.length}）`);
  const spec = registered[0] || {};
  ok(spec.id === 'dsh-plugin-dm8-inspect', `工厂 id = ${spec.id}`);

  const fakeReact = {
    createElement: (...a) => ({ type: a[0], props: a[1] }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  };
  const mod = spec.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error('契约外的 require: ' + id);
  });
  ok(typeof mod.apply === 'function', '导出 apply');
  ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), `inject = ${JSON.stringify(mod.inject)}`);
  ok(typeof mod.name === 'string' && mod.name.length > 0, `name = ${mod.name}`);

  const applied = [];
  mod.apply({
    slots: {
      inject: (key, cb) => {
        applied.push(['inject', key]);
        cb();
      },
      register: (opts) => {
        applied.push(['register', opts]);
        return () => {};
      },
    },
  });
  const inj = applied.find((x) => x[0] === 'inject');
  const reg = applied.find((x) => x[0] === 'register');
  ok(inj && inj[1] === 'tool.call.toolview', `用 slots.inject 声明注入：${inj && inj[1]}`);
  ok(reg && reg[1].name === 'tool.call.toolview' && reg[1].key === 'dm8_inspect', '注册到 tool.call.toolview（key=dm8_inspect）');
}

console.log('\n=== 10. 卡片真的渲染得出来（假 React 跑一遍组件）===');
{
  // 用最小的 React 桩把组件真正调用一遍，再遍历产出的树核对字段与输入框。
  const registered = [];
  const g = globalThis;
  const saved = g.window;
  g.window = { __ModuleLoader__: { load: (spec) => registered.push(spec) } };
  try {
    await import(pathToFileURL(path.join(PKG, 'client', 'client.js')).href + '?t=' + Date.now());
  } finally {
    if (saved === undefined) delete g.window;
    else g.window = saved;
  }

  const states = [];
  let cursor = 0;
  const fakeReact = {
    // children 是第 3 个及以后的参数，不是 props.children。
    createElement: (type, props, ...children) =>
      Object.assign({ type }, { props: Object.assign({}, props, { children: children.length === 1 ? children[0] : children }) }),
    useState: (init) => {
      const idx = cursor++;
      if (!(idx in states)) states[idx] = init;
      return [
        states[idx],
        (v) => {
          states[idx] = typeof v === 'function' ? v(states[idx]) : v;
        },
      ];
    },
    useEffect: () => {},
  };
  const mod = registered[0].factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error('契约外的 require: ' + id);
  });

  let Comp = null;
  mod.apply({
    slots: {
      inject: (_k, cb) => cb(),
      register: (_opts, comp) => {
        Comp = comp;
        return () => {};
      },
    },
  });
  ok(typeof Comp === 'function', '拿到了卡片组件');

  let tree = null;
  let threw = null;
  try {
    cursor = 0;
    tree = Comp({ sessionId: 'render-test-session' });
  } catch (e) {
    threw = e;
  }
  ok(!threw, threw ? '渲染抛异常：' + threw.message + '\n' + threw.stack : '渲染没有抛异常');

  // 把函数组件展开，收集所有 label 与 input
  const labels = [];
  const inputs = [];
  const walk = (node, depth) => {
    if (node == null || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node.type === 'function') {
      cursor = 0; // 子组件是独立的 hook 作用域，这里只需不抛
      let sub = null;
      try {
        sub = node.type(node.props || {});
      } catch (_) {
        sub = null;
      }
      return walk(sub, depth + 1);
    }
    if (node.type === 'input') inputs.push(node.props || {});
    if (node.type === 'span' && typeof node.props.children === 'string') labels.push(node.props.children);
    if (node.props && node.props.children) walk(node.props.children, depth + 1);
  };
  walk(tree, 0);

  const text = JSON.stringify(tree);
  for (const name of FIELD_NAMES) {
    const f = FORM_FIELDS.find((x) => x.name === name);
    ok(text.includes(f.label), `卡片里有「${f.label}」这一栏`);
  }
  const pwInputs = inputs.filter((i) => i.type === 'password');
  ok(pwInputs.length === SECRET_NAMES.length, `${SECRET_NAMES.length} 个口令输入框都是 type=password（实际 ${pwInputs.length}）`);
  ok(
    inputs.every((i) => i.autoComplete === 'off'),
    '所有输入框都关了自动填充'
  );
  ok(text.includes('保存') && text.includes('全部清除'), '有保存与全部清除按钮');
  ok(text.includes('只留在本次 dsh 进程内存里'), '标题里写明了不落盘');
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
