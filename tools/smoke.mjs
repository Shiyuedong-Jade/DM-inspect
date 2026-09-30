/**
 * 离线冒烟测试：不装进 DSH 也能验证插件是否成立。
 *
 * 覆盖：
 *   1. 工具定义能被真的 defineTool 接受（参数 DSL 与输出 schema 都能编译）；
 *   2. execute 跑完整条巡检链路（用 demo 驱动，不连库），并写出 HTML + JSON；
 *   3. 返回值能通过注册表自己的校验器 `validateJsonSchemaValue`；
 *   4. 集群路径（2 个目标）与连接失败路径（不落盘）的返回值同样合法；
 *   5. 渲染出的文字摘要包含关键信息（汇总数字、报告路径、present 提示）；
 *   6. 缺驱动 jar / 缺口令这类失败的报错信息给出可执行的下一步；
 *   7. 账号与口令的来源必须写在结果里（显式参数会静默盖掉卡片里的账号）。
 *
 * 用法：node tools/smoke.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeDm8Tool } from '../lib/tool.js';
import { loadEngine } from '../lib/engine.js';
import { prepareHome, defaultHome } from '../lib/workspace.js';
import { setSessionForm, resetSessionForms } from '../lib/session-form.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  [通过] ' : '  [失败] ') + msg);
  if (!cond) failed++;
};

/** 加载真的 defineTool；加载不到时退回桩函数。 */
async function loadDefineTool() {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
    path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const mod = await import(pathToFileURL(c).href);
      if (typeof mod.defineTool === 'function') return { mod, defineTool: mod.defineTool, from: c };
    } catch (e) {
      console.log(`  （提示）加载 ${c} 失败：${e.message}`);
    }
  }
  return {
    mod: null,
    defineTool: (spec) => spec,
    from: null,
  };
}

(async () => {
  console.log('\n=== 1. 工具定义能被真 defineTool 接受 ===');
  const { mod: toolsMod, defineTool, from } = await loadDefineTool();
  if (from) {
    console.log(`  （使用真实 defineTool：${from}）`);
  } else {
    console.log('  （未找到 @deepseek-ai/dsh-tools，改用桩函数——schema 编译这一步没被验证）');
  }

  const cfg = {
    home: path.join(os.tmpdir(), 'dm8-inspect-smoke-home'),
    driver: 'demo',
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
  };

  let spec = null;
  try {
    spec = makeDm8Tool({
      defineTool,
      getConfig: () => cfg,
      loadEngine,
      prepareHome,
      resolveSecret: async () => null,
      log: () => {},
    });
    ok(true, 'defineTool 接受了参数 DSL 与输出 schema');
  } catch (e) {
    ok(false, 'defineTool 拒绝了这个定义：' + (e && e.stack ? e.stack : e));
  }
  if (!spec) {
    console.log(`\n有 ${failed} 项失败 ❌`);
    process.exit(1);
  }

  ok(spec.name === 'dm8_inspect', `工具名 = ${spec.name}`);
  ok(/达梦/.test(spec.description) && /巡检/.test(spec.description), '描述里写清了「达梦巡检」');
  ok(spec.timeoutMs >= 60000, `声明了足够长的超时：${spec.timeoutMs} ms`);
  ok(typeof spec.execute === 'function', '有 execute');
  ok(typeof spec.output.render === 'function', '有 output.render');
  const pnames = Object.keys((spec.parameters && spec.parameters.properties) || {}).sort();
  ok(
    pnames.includes('targets') && pnames.includes('topN') && pnames.includes('sshUser'),
    '关键参数齐全：' + pnames.join('、')
  );
  // 真的 defineTool 把 DSL 编译成 JSON Schema（必填从每属性的 required:true
  // 变成对象级 required 数组）；桩函数则原样返回 DSL。两种形状都要能认。
  const requiredOf = (node) =>
    node && Array.isArray(node.required) ? node.required : Object.keys(node.properties || {}).filter((k) => node.properties[k].required === true);
  // targets 不是必填：目标可以只填在调用卡片里，模型一个参数都不传。
  ok(!requiredOf(spec.parameters).includes('targets'), 'targets 是可选的（目标可以只填在调用卡片里）');
  ok(/卡片/.test(spec.parameters.properties.targets.description), 'targets 的说明里提到了卡片');

  console.log('\n=== 2. 跑一遍完整链路（demo 驱动，不连库）===');
  const outDir = path.join(os.tmpdir(), 'dm8-inspect-smoke-out');
  fs.rmSync(outDir, { recursive: true, force: true });
  const t0 = Date.now();
  const value = await spec.execute(
    { targets: [{ host: '127.0.0.1', port: 5236 }], driver: 'demo', outDir, topN: 5 },
    { signal: new AbortController().signal }
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(value && value.ok === true, `execute 成功返回（耗时 ${secs} 秒）`);
  ok(fs.existsSync(value.reportPath), 'HTML 报告已落盘：' + value.reportPath);
  ok(fs.existsSync(value.jsonPath), '明细 JSON 已落盘：' + value.jsonPath);
  if (fs.existsSync(value.reportPath)) {
    const html = fs.readFileSync(value.reportPath, 'utf8');
    ok(html.length > 50000, `报告体积正常：${(html.length / 1024).toFixed(1)} KB`);
    ok(html.includes('达梦') && html.includes('巡检'), '报告里有工具名与巡检字样');
    ok(!html.includes('**'), '报告里没有未渲染的 markdown 星号');
  }

  console.log('\n=== 3. 用**注册表自己的校验器**核对返回值 ===');
  // dsh-tools 的 validateJsonSchemaValue 才是注册表实际使用的校验器：返回值不符合声明的
  // output schema 时会抛 ToolOutputError。这里用它再核一遍。
  const validate = toolsMod && typeof toolsMod.validateJsonSchemaValue === 'function' ? toolsMod.validateJsonSchemaValue : null;
  if (!validate) {
    ok(false, '没拿到 validateJsonSchemaValue（dsh-tools 未加载），这一步没验到');
  } else {
    const v1 = validate(spec.output.schema, value);
    ok(v1.length === 0, '单实例返回值通过注册表校验' + (v1.length ? '：' + v1.join('；') : ''));
  }

  console.log('\n=== 4. 集群路径（2 个目标 → 自动走集群巡检）===');
  let clusterValue = null;
  {
    const outDir2 = path.join(os.tmpdir(), 'dm8-inspect-smoke-out-cluster');
    fs.rmSync(outDir2, { recursive: true, force: true });
    clusterValue = await spec.execute(
      {
        targets: [
          { host: '10.0.0.1', port: 7236, label: 'DSC01' },
          { host: '10.0.0.2', port: 7237, label: 'DSC02' },
        ],
        driver: 'demo',
        outDir: outDir2,
        topN: 5,
      },
      { signal: new AbortController().signal }
    );
    ok(clusterValue.ok === true, '集群巡检成功返回');
    ok(clusterValue.mode === 'cluster', `mode = ${clusterValue.mode}`);
    ok(clusterValue.nodes.length === 2, `汇总了 ${clusterValue.nodes.length} 个节点`);
    ok(
      clusterValue.nodes.every((n) => n.label && n.summary.total > 50),
      '每个节点都有独立的汇总：' + clusterValue.nodes.map((n) => `${n.label}=${n.summary.total}`).join(' ') + ' 项'
    );
    ok(clusterValue.findings.some((f) => f.node), 'findings 里带上了节点名（多节点下必须能分清是谁的问题）');
    ok(fs.existsSync(clusterValue.reportPath), '集群 HTML 报告已落盘');
    if (fs.existsSync(clusterValue.reportPath)) {
      const ch = fs.readFileSync(clusterValue.reportPath, 'utf8');
      ok(/集群总览/.test(ch) && /class="node-cmp"/.test(ch), '集群报告结构正确（总览 + 节点对照表）');
      ok(ch.length > 50000, `集群报告体积正常：${(ch.length / 1024).toFixed(1)} KB`);
    }
    if (validate) {
      const v2 = validate(spec.output.schema, clusterValue);
      ok(v2.length === 0, '集群返回值通过注册表校验' + (v2.length ? '：' + v2.join('；') : ''));
    }
  }

  console.log('\n=== 5. 连接失败时返回值的形状也要合法 ===');
  {
    // ok=false 那条分支（连接失败不写报告）同样要满足 output schema，
    // 否则模型看到的是「工具调用失败」而不是「连不上，原因是 X」。
    // demo 驱动不会失败，这里直接构造一个假引擎，逼出 fatal 分支
    const fakeEngine = {
      runner: {
        runInspection: async () => ({
          fatal: '连接 10.0.0.9:5236 超时',
          summary: { crit: 0, warn: 0, ok: 0, info: 0, na: 0, error: 0, total: 0 },
          checks: [],
          log: [],
        }),
      },
      cluster: {},
      report: { renderReport: () => '', renderClusterReport: () => '' },
    };
    const spec2 = makeDm8Tool({
      defineTool,
      getConfig: () => cfg,
      loadEngine: () => fakeEngine,
      prepareHome,
      resolveSecret: async () => 'pw',
      log: () => {},
    });
    const v3 = await spec2.execute({ targets: [{ host: '10.0.0.9', port: 5236 }], driver: 'demo' }, { signal: new AbortController().signal });
    ok(v3.ok === false, 'fatal 时 ok=false');
    ok(v3.reportPath === '' && v3.jsonPath === '', 'fatal 时不落盘（不留假报告）');
    ok(/超时/.test(v3.fatal), '把致命原因原样带回来了：' + v3.fatal);
    if (validate) {
      const v4 = validate(spec.output.schema, v3);
      ok(v4.length === 0, '失败返回值也通过注册表校验' + (v4.length ? '：' + v4.join('；') : ''));
    }
    const txt = spec2.output.render({}, v3).map((b) => b.text).join('\n');
    ok(/巡检未完成/.test(txt), '失败时的文字摘要说明了原因');
  }

  console.log('\n=== 6. 报告默认落在**会话工作目录**（不是进程 cwd）===');
  {
    // dsh web 的 process.cwd() 是启动它的目录（Windows 上常常是用户主目录），
    // 与用户在用的项目目录无关。默认目录取 exec.agent.session.header.cwd。
    const fakeSession = path.join(os.tmpdir(), 'dm8-inspect-smoke-session');
    fs.rmSync(fakeSession, { recursive: true, force: true });
    const v = await spec.execute(
      { targets: [{ host: '127.0.0.1', port: 5236 }], driver: 'demo' },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: fakeSession } } } }
    );
    ok(
      v.reportPath.startsWith(fakeSession + path.sep),
      `报告落在会话工作目录下：${path.dirname(v.reportPath)}`
    );
    ok(/dm8-inspect-reports$/.test(path.dirname(v.reportPath)), '会话工作目录下用 dm8-inspect-reports 子目录');
    ok(!v.notes.some((n) => /未取到会话工作目录/.test(n)), '取到会话目录时不该有「退回 cwd」的提示');

    // 取不到会话目录时退回进程 cwd，并在 notes 里说明。
    // 这一条会在进程 cwd 下建目录，所以先把 cwd 换到临时目录，
    // 免得在包目录里留下 dm8-inspect-reports/。
    const cwd0 = process.cwd();
    const fakeCwd = path.join(os.tmpdir(), 'dm8-inspect-smoke-cwd');
    fs.rmSync(fakeCwd, { recursive: true, force: true });
    fs.mkdirSync(fakeCwd, { recursive: true });
    let v2;
    try {
      process.chdir(fakeCwd);
      v2 = await spec.execute(
        { targets: [{ host: '127.0.0.1', port: 5236 }], driver: 'demo' },
        { signal: new AbortController().signal }
      );
    } finally {
      process.chdir(cwd0);
    }
    ok(v2.ok === true, '没有 agent/session 时依然能跑完（不因为取不到目录而失败）');
    ok(v2.notes.some((n) => /未取到会话工作目录/.test(n)), '退回进程 cwd 时在 notes 里说清楚了');
    ok(v2.reportPath.startsWith(fakeCwd + path.sep), '退回的确实是进程 cwd');
    ok(!fs.existsSync(path.join(cwd0, 'dm8-inspect-reports')), '冒烟测试没在包目录里留下报告目录');

    // outDir 显式给出时，相对路径相对会话目录解析，而不是进程 cwd
    const v3 = await spec.execute(
      { targets: [{ host: '127.0.0.1', port: 5236 }], driver: 'demo', outDir: 'sub/dir' },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: fakeSession } } } }
    );
    ok(
      v3.reportPath.startsWith(path.join(fakeSession, 'sub', 'dir') + path.sep),
      `相对 outDir 按会话目录解析：${path.dirname(v3.reportPath)}`
    );
    // 绝对 outDir 原样使用
    const abs = path.join(os.tmpdir(), 'dm8-inspect-smoke-abs');
    const v4 = await spec.execute(
      { targets: [{ host: '127.0.0.1', port: 5236 }], driver: 'demo', outDir: abs },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: fakeSession } } } }
    );
    ok(v4.reportPath.startsWith(abs + path.sep), '绝对 outDir 原样使用');
  }

  console.log('\n=== 7. 文字摘要 ===');
  const text = spec.output.render({}, value).map((b) => b.text).join('\n');
  ok(/巡检完成/.test(text), '摘要写明完成');
  ok(/汇总：严重 \d+/.test(text), '摘要带汇总数字');
  ok(text.includes(value.reportPath), '摘要里给出报告路径');
  ok(/present/.test(text), '摘要提示用 present 交付报告');
  ok(value.summary.total > 50, `巡检项数量正常：${value.summary.total} 项`);
  ok(value.deployMode.length > 0, `识别出部署形态：${value.deployMode}`);

  console.log('\n=== 8. 缺驱动 jar 时报错要可操作 ===');
  {
    const spec2 = makeDm8Tool({
      defineTool: (s) => s,
      getConfig: () => Object.assign({}, cfg, { driver: 'jdbc', home: path.join(os.tmpdir(), 'dm8-inspect-smoke-empty') }),
      loadEngine,
      prepareHome,
      resolveSecret: async () => 'pw',
      log: () => {},
    });
    let msg = '';
    try {
      await spec2.execute({ targets: [{ host: '10.0.0.1', port: 5236 }] }, { signal: new AbortController().signal });
    } catch (e) {
      msg = e.message;
    }
    ok(/DmJdbcDriver18\.jar/.test(msg), '错误信息点名了要放的 jar 文件名');
    ok(/drivers/.test(msg), '错误信息给出了要放到的目录');
  }

  console.log('\n=== 9. 有 jar 但缺口令时报错要可操作 ===');
  {
    // 造一个工作目录齐备（含假 jar）的场景，让检查走到口令这一关。
    // 假 jar 只用于通过「有没有 jar」的存在性判断，不会被拿来连库。
    const home3 = path.join(os.tmpdir(), 'dm8-inspect-smoke-home3');
    fs.rmSync(home3, { recursive: true, force: true });
    const prep3 = prepareHome(home3);
    fs.writeFileSync(path.join(prep3.driverDir, 'DmJdbcDriver18.jar'), 'not-a-real-jar');
    const spec3 = makeDm8Tool({
      defineTool: (s) => s,
      getConfig: () => Object.assign({}, cfg, { driver: 'jdbc', home: home3 }),
      loadEngine,
      prepareHome,
      resolveSecret: async () => null,
      log: () => {},
    });
    let msg = '';
    try {
      await spec3.execute(
        { targets: [{ host: '10.0.0.1', port: 5236 }], driver: 'jdbc' },
        { signal: new AbortController().signal }
      );
    } catch (e) {
      msg = e.message;
    }
    ok(/未提供数据库口令/.test(msg), '缺口令时报的是「未提供口令」而不是别的错：' + msg.split('\n')[0]);
    ok(/凭据/.test(msg) && /DM8_INSPECT_PASSWORD/.test(msg), '错误信息说清了凭据名与三种提供方式');
  }

  console.log('\n=== 10. 凭据库取到的口令会被用上 ===');
  {
    let asked = '';
    const home4 = path.join(os.tmpdir(), 'dm8-inspect-smoke-home4');
    fs.rmSync(home4, { recursive: true, force: true });
    const prep4 = prepareHome(home4);
    fs.writeFileSync(path.join(prep4.driverDir, 'DmJdbcDriver18.jar'), 'not-a-real-jar');
    const spec4 = makeDm8Tool({
      defineTool: (s) => s,
      getConfig: () => Object.assign({}, cfg, { driver: 'jdbc', home: home4, credentialRef: 'MY_DM8_PW' }),
      loadEngine,
      prepareHome,
      resolveSecret: async (ref) => {
        asked = ref;
        return 'from-store';
      },
      log: () => {},
    });
    try {
      // 目标不可达，会连很久；这里只验证「凭据被读过」，
      // 所以给一个立刻会失败的超时，并且不关心结果。
      await spec4.execute(
        { targets: [{ host: '127.0.0.1', port: 1 }], driver: 'jdbc' },
        { signal: AbortSignal.timeout(9000) }
      );
    } catch (_) {
      /* 连不上是预期的 */
    }
    ok(asked === 'MY_DM8_PW', `按配置里的凭据名去取了口令：${asked || '(没取)'}`);
  }

  console.log('\n=== 11. 工作目录准备 ===');
  {
    const home = path.join(os.tmpdir(), 'dm8-inspect-smoke-home2');
    fs.rmSync(home, { recursive: true, force: true });
    const prep = prepareHome(home);
    ok(fs.existsSync(prep.javaDir), '建出 java/');
    ok(fs.existsSync(prep.driverDir), '建出 drivers/');
    ok(fs.existsSync(prep.runtimeDir), '建出 runtime/');
    ok(prep.bridge && fs.existsSync(prep.bridge), 'DmBridge.java 已从插件包复制过去');
    ok(fs.readFileSync(prep.bridge, 'utf8').includes('class DmBridge'), '复制过来的确实是桥接源码');
    ok(prep.jars.length === 0, '没放 jar 时如实报告 0 个');
  }

  console.log('\n=== 12. 账号来源要报出来，SSH 备注不能留占位符 ===');
  {
    // 显式参数会静默盖掉卡片里填的账号：卡片填 awr1、调用里带了 user=SYSDBA，
    // 结果就是拿 awr1 的口令去登 SYSDBA，而失败只表现为「连接超时」。
    // 所以「账号从哪来」必须写进结果，否则隔着一次覆盖根本看不出来。
    const sid = 'smoke-credsource';
    const scratch = path.join(os.tmpdir(), 'dm8-inspect-smoke-src');
    fs.rmSync(scratch, { recursive: true, force: true });
    const exec = {
      signal: new AbortController().signal,
      agent: { session: { id: sid, header: { id: sid, cwd: scratch } } },
    };
    try {
      resetSessionForms();
      setSessionForm(sid, {
        user: 'awr1',
        password: 'pw',
        targets: '127.0.0.1:5236',
        sshUser: 'root',
        sshPassword: 'pw',
      });

      // 卡片 user=awr1、调用参数 user=SYSDBA：后者赢，且必须说明是它赢的
      const v = await spec.execute({ driver: 'demo', user: 'SYSDBA' }, exec);
      ok(
        v.notes.some((n) => /账号来源：本次调用参数（SYSDBA）/.test(n)),
        '显式参数覆盖卡片时，结果里说明账号来自调用参数'
      );
      ok(!v.notes.some((n) => /账号来源：调用卡片/.test(n)), '不会同时报两个账号来源');

      // 不传 user：用卡片里的 awr1
      const v2 = await spec.execute({ driver: 'demo' }, exec);
      ok(
        v2.notes.some((n) => /账号来源：调用卡片（awr1）/.test(n)),
        '卡片里的账号被用上，并标明来源'
      );

      // 卡片与参数都没有：落到默认账号
      resetSessionForms();
      const v3 = await spec.execute(
        { driver: 'demo', targets: [{ host: '127.0.0.1', port: 5236 }] },
        exec
      );
      ok(
        v3.notes.some((n) => /账号来源：默认值（SYSDBA）/.test(n)),
        '两处都没给时，标明用的是默认账号'
      );

      // SSH 备注里要写真实节点地址，不能是没被替换的占位符
      const sshNote = v.notes.find((n) => /^OS 采集：/.test(n)) || '';
      ok(sshNote === 'OS 采集：SSH root@127.0.0.1', 'SSH 备注里是真实节点地址：' + (sshNote || '(没有这条)'));
      ok(
        !v.notes.concat(v2.notes, v3.notes).some((n) => /节点 IP/.test(n)),
        '结果里没有残留的 <节点 IP> 占位符'
      );
    } finally {
      resetSessionForms();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  console.log(`\n包目录：${PKG}`);
  console.log(`默认工作目录：${defaultHome()}`);
  console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[冒烟测试异常] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
