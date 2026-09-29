/**
 * `dm8_inspect` 工具定义。
 *
 * 把 DM8 巡检引擎包成 DSH 工具；引擎本身见 lib/engine.js，本文件负责三件事——
 *   1. 把模型给的结构化参数翻译成引擎要的 cred / options；
 *   2. 把巡检结果压缩成适合模型消费的摘要（完整明细进 HTML/JSON 文件）；
 *   3. 把 HTML 报告落到工作区，供模型接着调 present 交付给用户。
 *
 * 返回值只带结论摘要与报告路径：一轮单实例巡检的明细有几百 KB，
 * 模型需要时用 read 工具去读 JSON。
 *
 * 用工厂函数而不是直接定义：`defineTool` 由调用方注入，
 * 离线冒烟测试不必先装进 DSH 就能跑到同一个 execute 逻辑（见 tools/smoke.mjs）。
 *
 * @module dsh-plugin-dm8-inspect/tool
 */

import fs from 'node:fs';
import path from 'node:path';

import { getSessionForm, parseTargets } from './session-form.js';

/** 工具名。模型看到的就是这个名字。 */
export const TOOL_NAME = 'dm8_inspect';

/** 巡检等级 → 中文，报告与摘要共用一套词。 */
const LEVEL_CN = { crit: '严重', warn: '警告', ok: '正常', info: '提示', na: '不适用', error: '未取到' };

/** 摘要里每个等级最多列多少条（完整清单在报告里）。 */
const ISSUE_CAP = 40;

/**
 * 参数 schema（DSH 自定义 DSL，不是 JSON Schema）：
 * 参数对象是隐式开放根，必填靠每个属性上的 `required: true`。
 */
function parameters() {
  return {
    targets: {
      type: 'array',
      description:
        '要巡检的数据库节点。**可以省略**：省略时用调用卡片里「目标」那一栏填的' +
        '（每行一个 host:port）。单实例填 1 个；DMDSC 共享存储集群 / 数据守护主备把每个节点都列上（≥2 个即自动走集群巡检）。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host: { type: 'string', required: true, description: '数据库服务器 IP 或主机名' },
          port: { type: 'integer', description: '数据库端口，默认 5236（DMDSC 示例：7236 / 7237）' },
          user: { type: 'string', description: '数据库账号，默认 SYSDBA' },
          label: { type: 'string', description: '该节点在报告里的显示名，默认 host:port' },
        },
      },
    },
    user: { type: 'string', description: '数据库账号，默认 SYSDBA（也可以只填在调用卡片里）' },
    port: { type: 'integer', description: '数据库端口，默认 5236（也可以只填在调用卡片里）' },
    password: {
      type: 'string',
      description:
        '数据库口令。**不建议填**：默认从凭据库读取（见插件配置 credentialRef），' +
        '填在这里的明文会进入本次会话日志。仅在凭据未配置且用户确认日志不外传时使用。',
    },
    driver: {
      type: 'string',
      enum: ['jdbc', 'demo'],
      description: 'jdbc=连真实达梦库（默认）；demo=演示模式，用内置样例数据跑通流程（不连库，仅供自检）。',
    },
    topN: { type: 'integer', description: '所有 Top 类巡检项取前多少条，5~50，默认 10' },
    tsWarnPct: { type: 'integer', description: '表空间使用率告警阈值（%），默认 80' },
    tsCritPct: { type: 'integer', description: '表空间使用率严重告警阈值（%），默认 90' },
    slowSqlMs: { type: 'integer', description: '慢 SQL 判定阈值（毫秒），默认 1000' },
    sshUser: {
      type: 'string',
      description:
        '数据库服务器 OS 采集用的 SSH 账号（通常 dmdba）。不填则不做 OS 级检查，' +
        '报告里这些项会判为「不适用」。集群模式下每个节点用各自 IP 连接。',
    },
    sshPassword: {
      type: 'string',
      description: 'SSH 口令。同样建议走凭据库（配置 sshCredentialRef），填这里会进会话日志。',
    },
    outDir: {
      type: 'string',
      description: 'HTML 报告输出目录，默认 <会话工作目录>/dm8-inspect-reports。可用 ~ 开头。',
    },
  };
}

/** 输出 schema。模型拿到的是结构化的结论摘要 + 报告路径。 */
function outputSchema() {
  const summary = {
    type: 'object',
    additionalProperties: false,
    properties: {
      crit: { type: 'integer', required: true },
      warn: { type: 'integer', required: true },
      ok: { type: 'integer', required: true },
      info: { type: 'integer', required: true },
      na: { type: 'integer', required: true },
      error: { type: 'integer', required: true },
      total: { type: 'integer', required: true },
    },
  };
  const finding = {
    type: 'object',
    additionalProperties: false,
    properties: {
      level: { type: 'string', required: true, description: 'crit / warn / error' },
      group: { type: 'string', required: true },
      title: { type: 'string', required: true },
      message: { type: 'string', required: true },
      node: { type: 'string' },
    },
  };
  const node = {
    type: 'object',
    additionalProperties: false,
    properties: {
      label: { type: 'string', required: true },
      role: { type: 'string' },
      summary,
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true, description: '是否连上库并跑完巡检（false 时不生成报告）' },
      mode: { type: 'string', required: true, description: 'single=单实例；cluster=多节点集群' },
      deployMode: { type: 'string', required: true, description: '部署形态：单实例 / 共享存储集群（DMDSC）/ 数据守护集群 等' },
      targets: { type: 'array', required: true, items: { type: 'string' }, description: '本次巡检的目标列表' },
      summary,
      nodes: { type: 'array', required: true, items: node, description: '每个节点的结论计数（单实例时只有一项）' },
      findings: { type: 'array', required: true, items: finding, description: '严重 / 警告 / 未取到 的逐项结论（已截断，完整清单见报告）' },
      findingsTruncated: { type: 'boolean', required: true, description: 'findings 是否被截断' },
      reportPath: { type: 'string', required: true, description: 'HTML 报告绝对路径；ok=false 时为空字符串' },
      jsonPath: { type: 'string', required: true, description: '同一轮巡检的原始 JSON 结果绝对路径，便于按需读取明细' },
      durationMs: { type: 'integer', required: true },
      fatal: { type: 'string', required: true, description: '连接/巡检致命错误，正常时为空字符串' },
      notes: { type: 'array', required: true, items: { type: 'string' }, description: '环境与执行说明（驱动、工作目录、OS 采集是否生效等）' },
    },
  };
}

/** 时间戳：2026-09-29 10:31:07 → 20260929103107，用于报告文件名。 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

/** 文件名里不能出现的字符，与 server.js 同一套规则。 */
function safeName(s) {
  return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

/** 把某次巡检结果里的「不正常项」抽成 findings。 */
function collectFindings(data, nodeLabel) {
  const out = [];
  for (const c of data.checks || []) {
    if (c.status !== 'crit' && c.status !== 'warn' && c.status !== 'error') continue;
    out.push({
      level: c.status,
      group: String(c.group || ''),
      title: String(c.title || ''),
      message: String(c.message || '').replace(/\s+/g, ' ').slice(0, 400),
      ...(nodeLabel ? { node: nodeLabel } : {}),
    });
  }
  return out;
}

/** 单实例形态：部署形态取自「部署形态识别」这一项的 meta。 */
function singleDeployMode(data) {
  const t = (data.checks || []).find((c) => c.id === 'basic.topology');
  return (t && t.meta && t.meta.mode) || '单实例';
}

/**
 * 构造工具定义。
 *
 * @param {object} opts
 * @param {Function} opts.defineTool - `@deepseek-ai/dsh-tools` 的 defineTool（冒烟测试可传桩）
 * @param {Function} opts.getConfig - 返回当前生效的插件配置
 * @param {Function} opts.loadEngine - (home) => 引擎 api
 * @param {Function} opts.prepareHome - (home) => 目录准备结果
 * @param {Function} opts.resolveSecret - async (refName) => string|null，从凭据库取密码
 * @param {Function} [opts.log] - 日志回调（走 ctx.logger）
 * @returns {object} 工具定义
 */
export function makeDm8Tool(opts) {
  const { defineTool, getConfig, loadEngine, prepareHome, resolveSecret } = opts;
  const log = opts.log || (() => {});

  return defineTool({
    name: TOOL_NAME,
    description: [
      '对达梦 DM8 数据库做一次完整巡检并生成 HTML 报告：85 个巡检项覆盖实例与版本、表空间与数据文件、',
      '日志与归档、内存与缓冲池、SQL 性能、对象与统计信息、用户与安全、作业与备份，以及（可选）数据库服务器',
      '的操作系统 CPU/内存/IO 指标。支持单实例、DMDSC 共享存储集群与数据守护主备。',
      '调用后会返回分级结论（严重/警告/未取到）与报告路径；**报告是交付物，生成后请调用 present 把它交给用户**。',
      '只读巡检，不修改数据库任何配置。',
    ].join(''),
    // 一轮集群巡检（3 节点并发）实测可达 1~2 分钟。该值是声明式的，
    // 强制生效需要部署侧挂 @deepseek-ai/dsh-tool-call-timeout-policy。
    timeoutMs: 600000,
    // 巡检是纯读操作，可以与其他只读工具并行
    isConcurrencySafe: () => true,
    parameters: parameters(),
    output: {
      schema: outputSchema(),
      render: (_args, v) => [{ type: 'text', text: renderText(v) }],
    },
    async execute(args, exec) {
      const cfg = getConfig();
      const home = prepareHome(cfg.home);
      const engine = loadEngine(home.home);

      const sessionId = sessionIdOf(exec);
      const form = getSessionForm(sessionId);

      /**
       * 取值优先级：本次调用的显式参数 > 卡片里填的 > 插件配置。
       * 卡片让后续调用不必重复携带参数。
       */
      const pick = (argVal, fieldName, dflt) => {
        if (argVal !== undefined && argVal !== null && String(argVal).trim() !== '') return argVal;
        const card = form[fieldName];
        if (card !== undefined && card !== '') return card;
        return dflt;
      };
      const pickInt = (argVal, fieldName, dflt) => {
        const v = pick(argVal, fieldName, dflt);
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : dflt;
      };

      const driver = String(pick(args.driver, 'driver', cfg.driver || 'jdbc'));
      const dbUser = String(pick(args.user, 'user', 'SYSDBA')).trim() || 'SYSDBA';
      const defaultPort = pickInt(args.port, 'port', 5236);

      // 目标：参数里给了就用参数的；没给就解析卡片里那行「每行一个 host:port」
      const cardTargets = parseTargets(form.targets || '', defaultPort, dbUser);
      const argTargets = (args.targets || [])
        .filter((t) => t && String(t.host || '').trim())
        .map((t) => ({
          host: String(t.host).trim(),
          port: parseInt(t.port, 10) || defaultPort,
          user: String(t.user || dbUser).trim() || dbUser,
          label: t.label,
        }));
      const targets = argTargets.length ? argTargets : cardTargets;
      if (!targets.length) {
        throw new Error(
          `没有巡检目标。两种给法：\n` +
            `  · 在 dm8_inspect 的调用卡片里「目标」那一栏填，每行一个 host:port（填一次后续都生效）；\n` +
            `  · 或在本次调用里传 targets 参数，例如 [{host:"10.127.11.40", port:5236}]。`
        );
      }
      const isCluster = targets.length > 1;

      const notes = [];
      notes.push(`工作目录：${home.home}（驱动 jar 目录：${home.driverDir}）`);
      notes.push(
        `目标来源：${argTargets.length ? '本次调用参数' : '调用卡片'}（${targets.length} 个${
          isCluster ? '，走集群巡检' : '，单实例'
        }）`
      );

      if (driver === 'jdbc') {
        if (!home.bridge) {
          throw new Error(
            `准备工作目录失败：无法写入 ${home.javaDir}。请确认该路径可写，或在插件配置里把 home 指到别处。`
          );
        }
        if (!home.jars.length) {
          throw new Error(
            `没有找到达梦 JDBC 驱动 jar。请把达梦安装目录下的 drivers/jdbc/DmJdbcDriver18.jar 复制到：\n` +
              `  ${home.driverDir}\n` +
              `（该 jar 是达梦的商业组件，不能随插件分发，必须由使用者自己提供。）\n` +
              `如果你只是想验证插件链路，可以把参数 driver 设为 "demo" 用内置样例数据跑一遍。`
          );
        }
        notes.push(`驱动：${home.jars.join('、')}`);
      } else {
        notes.push('驱动：演示模式（内置样例数据，未连接真实数据库）');
      }

      // ---- 口令：显式参数 > 卡片 > 凭据库 ----
      let password = args.password != null ? String(args.password) : '';
      let passwordSource = password ? '本次调用参数' : '';
      if (!password && form.password) {
        password = form.password;
        passwordSource = '调用卡片（仅本次 dsh 进程内存，重启后需重新输入）';
      }
      if (!password) {
        const fromStore = await resolveSecret(cfg.credentialRef);
        if (fromStore != null) {
          password = fromStore;
          passwordSource = `凭据 ${cfg.credentialRef}`;
        }
      }
      if (!password && driver !== 'demo') {
        throw new Error(
          `未提供数据库口令。请任选一种方式：\n` +
            `  · 在 dm8_inspect 的调用卡片里「数据库口令」那一栏输入并保存（只留在 dsh 进程内存里，重启后需重新输入）；\n` +
            `  · 在凭据库里设置 ${cfg.credentialRef}；\n` +
            `  · 启动 dsh 前在环境变量里设置同名变量 ${cfg.credentialRef}；\n` +
            `  · 或者在本次调用里显式传 password 参数（会进入会话日志，明文 —— 最不建议）。`
        );
      }
      if (passwordSource) notes.push(`口令来源：${passwordSource}`);

      // ---- SSH：OS 级检查（可选） ----
      // 账号从参数或卡片来；账号与口令都在时自动开启 OS 采集。
      let sshPassword = args.sshPassword != null ? String(args.sshPassword) : '';
      const sshUser = String(pick(args.sshUser, 'sshUser', '')).trim();
      if (sshUser && !sshPassword && form.sshPassword) sshPassword = form.sshPassword;
      if (sshUser && !sshPassword) {
        const fromStore = await resolveSecret(cfg.sshCredentialRef);
        if (fromStore != null) sshPassword = fromStore;
      }
      const sshOn = !!(sshUser && sshPassword);
      if (sshUser && !sshPassword) {
        notes.push(
          `已指定 SSH 账号 ${sshUser} 但没有取到口令（卡片里没填，凭据 ${cfg.sshCredentialRef} 也未配置），本次跳过 OS 级检查。`
        );
      } else if (!sshUser) {
        notes.push('未指定 SSH 账号，本次不做数据库服务器 OS 级检查（相关项在报告里判为「不适用」）。');
      } else {
        notes.push(`OS 采集：SSH ${sshUser}@<节点 IP>`);
      }

      const options = {
        queryTimeoutMs: pickInt(args.queryTimeoutMs, 'queryTimeoutMs', cfg.queryTimeoutMs),
        connectTimeoutMs: cfg.connectTimeoutMs,
        slowSqlMs: pickInt(args.slowSqlMs, 'slowSqlMs', cfg.slowSqlMs),
        tsWarnPct: pickInt(args.tsWarnPct, 'tsWarnPct', cfg.tsWarnPct),
        tsCritPct: pickInt(args.tsCritPct, 'tsCritPct', cfg.tsCritPct),
        topN: pickInt(args.topN, 'topN', cfg.topN),
        clusterConcurrency: cfg.clusterConcurrency,
      };

      const remoteFor = (host) =>
        sshOn ? { enabled: true, host, port: 22, user: sshUser, password: sshPassword } : null;

      const onProgress = (p) => {
        // 只在服务端日志里留痕：DSH 的工具契约没有进度回传。
        if (p && (p.done === 1 || p.done % 25 === 0)) {
          log(`${p.done}/${p.total} ${String(p.current || '').slice(0, 80)}`);
        }
      };

      const started = Date.now();
      let data;
      if (isCluster) {
        data = await engine.cluster.runClusterInspection({
          driverId: driver,
          cred: { user: targets[0].user || 'SYSDBA', password },
          targets: targets.map((t) => ({
            label: t.label,
            host: String(t.host).trim(),
            port: t.port,
            user: t.user,
            password,
            remote: remoteFor(String(t.host).trim()),
          })),
          options,
          onProgress,
        });
      } else {
        const t = targets[0];
        data = await engine.runner.runInspection({
          driverId: driver,
          cred: {
            host: String(t.host).trim(),
            port: t.port,
            user: t.user || 'SYSDBA',
            password,
          },
          options: Object.assign({}, options, { remote: remoteFor(String(t.host).trim()) }),
          onProgress,
        });
      }

      if (exec && exec.signal && exec.signal.aborted) throw new Error('巡检已被调用方取消。');

      const durationMs = Date.now() - started;
      const targetLabels = targets.map((t) => `${String(t.host).trim()}:${t.port || 5236}`);

      // ---- 致命错误：不写报告 ----
      // 连接失败时不落盘，把原因原样回给模型，避免目录里出现文件名正常但内容无效的页面。
      if (data.fatal) {
        notes.push('本次巡检未连接成功，按要求不生成报告文件。');
        return {
          ok: false,
          mode: isCluster ? 'cluster' : 'single',
          deployMode: '',
          targets: targetLabels,
          summary: zeroSummary(),
          nodes: [],
          findings: [],
          findingsTruncated: false,
          reportPath: '',
          jsonPath: '',
          durationMs,
          fatal: String(data.fatal),
          notes,
        };
      }

      // ---- 落盘 ----
      // 默认写到会话的工作目录，不是进程的 cwd：`dsh web` 的 process.cwd() 是启动它的
      // 那个目录（Windows 上常常是用户主目录 C:\Users\<名>），会话的工作目录是用户
      // 正在使用的项目目录。
      const sessionCwd = sessionCwdOf(exec);
      const baseDir = sessionCwd || process.cwd();
      const wanted = String(pick(args.outDir, 'outDir', cfg.outDir || '')).trim();
      const outDir = wanted ? path.resolve(baseDir, expand(wanted)) : path.join(baseDir, 'dm8-inspect-reports');
      if (!sessionCwd) notes.push(`未取到会话工作目录，报告按进程 cwd 落盘：${baseDir}`);
      if (wanted) notes.push(`报告目录（outDir 指定）：${outDir}`);
      fs.mkdirSync(outDir, { recursive: true });
      const ts = stamp(new Date());
      const html = isCluster ? engine.report.renderClusterReport(data) : engine.report.renderReport(data);
      const base = isCluster
        ? `dm8-集群巡检报告-${data.nodeCount}节点-${ts}`
        : `dm8-巡检报告-${safeName(data.meta && data.meta.host)}-${(data.meta && data.meta.port) || 5236}-${ts}`;
      const reportPath = path.join(outDir, base + '.html');
      const jsonPath = path.join(outDir, base + '.json');
      fs.writeFileSync(reportPath, html, 'utf8');
      // 原始 JSON：报告面向人阅读，模型追明细时读此文件。
      fs.writeFileSync(jsonPath, JSON.stringify(clusterLite(data), null, 2), 'utf8');
      notes.push(`报告已写出：${reportPath}`);

      // ---- 汇总 ----
      let findings = [];
      const nodes = [];
      if (isCluster) {
        for (const n of data.nodes || []) {
          findings = findings.concat(collectFindings(n.data || {}, n.info && n.info.label));
          nodes.push({
            label: String((n.info && n.info.label) || ''),
            role: String((n.info && n.info.role) || ''),
            summary: normalizeSummary((n.data && n.data.summary) || n.summary),
          });
        }
        for (const w of data.warnings || []) notes.push(String(w));
        if (data.noData) notes.push('本次巡检没有采集到任何数据，各节点结论缺失。');
      } else {
        findings = collectFindings(data, '');
        nodes.push({
          label: targetLabels[0],
          role: '',
          summary: normalizeSummary(data.summary),
        });
        if (data.noData) notes.push('本次巡检没有采集到任何数据，报告里的结论不可用。');
      }

      // 严重优先，其次警告，再次未取到
      const rank = { crit: 0, warn: 1, error: 2 };
      findings.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));
      const truncated = findings.length > ISSUE_CAP;
      if (truncated) notes.push(`findings 只列出前 ${ISSUE_CAP} 条，完整清单见报告。`);

      return {
        ok: true,
        mode: isCluster ? 'cluster' : 'single',
        deployMode: String((isCluster ? data.deployMode : singleDeployMode(data)) || ''),
        targets: targetLabels,
        summary: normalizeSummary(data.summary),
        nodes,
        findings: findings.slice(0, ISSUE_CAP),
        findingsTruncated: truncated,
        reportPath,
        jsonPath,
        durationMs,
        fatal: '',
        notes,
      };
    },
  });
}

/**
 * 取会话的工作目录（绝对路径）。取不到返回空串。
 *
 * `exec` 上没有 workspace 字段；`exec.agent.session.header.cwd` 是会话创建时的
 * 绝对工作目录。该值只决定报告落在哪，取不到时退回进程 cwd，不影响巡检本身。
 *
 * @param {object} exec - ToolRunContext
 * @returns {string}
 */
function sessionCwdOf(exec) {
  try {
    const s = exec && exec.agent && exec.agent.session;
    const c = s && ((s.header && s.header.cwd) || (s.meta && s.meta.cwd));
    return typeof c === 'string' && c.trim() ? c.trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * 取会话 id。取不到返回空串（此时卡片暂存走兜底桶，见 session-form.js）。
 *
 * 必须和 client 半边拿到的 `sessionId` 是同一个字符串。client 的 `sessionId` 来自
 * slot 标准 props，服务端这边取 `session.header.id`，两者都是同一个 SessionId。
 *
 * @param {object} exec - ToolRunContext
 * @returns {string}
 */
function sessionIdOf(exec) {
  try {
    const s = exec && exec.agent && exec.agent.session;
    if (!s) return '';
    const id = s.id != null ? s.id : s.header && s.header.id;
    return typeof id === 'string' ? id.trim() : '';
  } catch (_) {
    return '';
  }
}

/** 展开 ~ 与环境变量（与 lib/workspace.js 同一套规则，这里只处理工具参数）。 */
function expand(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  if (s === '~') s = process.env.USERPROFILE || process.env.HOME || s;
  else if (s.startsWith('~/') || s.startsWith('~\\'))
    s = path.join(process.env.USERPROFILE || process.env.HOME || '~', s.slice(2));
  return s;
}

/** 计数缺失时补 0，避免 schema 校验因为 undefined 失败。 */
function normalizeSummary(s) {
  const x = s || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    crit: num(x.crit),
    warn: num(x.warn),
    ok: num(x.ok),
    info: num(x.info),
    na: num(x.na),
    error: num(x.error),
    total: num(x.total),
  };
}

function zeroSummary() {
  return { crit: 0, warn: 0, ok: 0, info: 0, na: 0, error: 0, total: 0 };
}

/**
 * 落盘用的精简 JSON：保留 checks（含 rows），剔除日志与渲染态字段。
 */
function clusterLite(data) {
  const strip = (d) => {
    if (!d || typeof d !== 'object') return d;
    // 剔除体积大且对追查无用的两样：执行日志、渲染用的分组结构
    const { log, groups, ...rest } = d;
    return rest;
  };
  if (data.nodes) {
    return {
      deployMode: data.deployMode,
      summary: data.summary,
      nodeCount: data.nodeCount,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      durationMs: data.durationMs,
      warnings: data.warnings,
      nodes: data.nodes.map((n) => ({ label: n.label, info: n.info, data: strip(n.data) })),
    };
  }
  return strip(data);
}

/** 模型看到的文字摘要。 */
function renderText(v) {
  const L = [];
  if (!v.ok) {
    L.push(`❌ DM8 巡检未完成：${v.fatal || '未知原因'}`);
    L.push(`目标：${v.targets.join('、')}　耗时 ${(v.durationMs / 1000).toFixed(1)} 秒`);
    if (v.notes.length) L.push('', ...v.notes.map((n) => `· ${n}`));
    return L.join('\n');
  }
  const s = v.summary;
  L.push(`✅ DM8 巡检完成（${v.deployMode || v.mode}）　目标：${v.targets.join('、')}　耗时 ${(v.durationMs / 1000).toFixed(1)} 秒`);
  L.push('');
  L.push(
    `汇总：严重 ${s.crit}　警告 ${s.warn}　正常 ${s.ok}　提示 ${s.info}　不适用 ${s.na}　未取到 ${s.error}　共 ${s.total} 项`
  );
  if (v.nodes.length > 1) {
    L.push('');
    L.push('各节点：');
    for (const n of v.nodes) {
      L.push(
        `  · ${n.label}${n.role ? `（${n.role}）` : ''}：严重 ${n.summary.crit}　警告 ${n.summary.warn}　正常 ${n.summary.ok}　未取到 ${n.summary.error}`
      );
    }
  }
  if (v.findings.length) {
    L.push('');
    L.push(`需要关注的项（${v.findings.length}${v.findingsTruncated ? '+' : ''} 条）：`);
    for (const f of v.findings) {
      L.push(
        `  · [${LEVEL_CN[f.level] || f.level}] ${f.node ? f.node + ' / ' : ''}${f.group} · ${f.title}\n      ${f.message}`
      );
    }
  } else {
    L.push('');
    L.push('没有严重 / 警告项。');
  }
  L.push('');
  L.push(`报告：${v.reportPath}`);
  L.push(`明细 JSON：${v.jsonPath}`);
  if (v.notes.length) {
    L.push('');
    L.push(...v.notes.map((n) => `· ${n}`));
  }
  L.push('');
  L.push('请把报告用 present 工具交付给用户。');
  return L.join('\n');
}
