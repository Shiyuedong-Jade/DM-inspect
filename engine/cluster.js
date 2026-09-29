'use strict';
/*
 * 多节点（集群）巡检编排
 * ---------------------------------------------------------------------------
 * 单节点巡检（runner.runInspection）已经稳定，这里**不改它**，而是在其上再加一层：
 * 对每个目标节点各跑一次完整巡检，再把结果汇总成一份集群报告。
 *
 * 为什么不做成「一个连接巡检多节点」：主备/DMDSC 的每个节点都是独立的实例
 * （各自的 IP、端口、日志目录、shell 通道、OS 指标），
 * 用一份连接去够多台机器只会把已有的单节点逻辑搞复杂。
 * 每个节点跑一遍，既复用了全部已验证的代码，也天然得到「每节点一节」的报告结构。
 *
 * 关键点：**每个节点的 shell 通道必须各自独立**——否则第二个节点会复用
 * 第一个节点的 ctx.state.hostShell，把 A 机的 OS 指标当成 B 机的报出来。
 * 因为 runInspection 每次调用都新建 ctx（state 是新的），这一点自动满足。
 */

const { runInspection } = require('./runner');

/** 把用户填的节点列表规范化 */
function normalizeTargets(params) {
  const raw = Array.isArray(params.targets) ? params.targets : [];
  const shared = params.cred || {};
  const out = [];
  for (const t of raw) {
    const host = String((t && t.host) || '').trim();
    if (!host) continue;
    const port = parseInt((t && t.port) || shared.port || 5236, 10);
    if (!port || port < 1 || port > 65535) {
      throw new Error(`节点 ${host} 的端口不合法：${t && t.port}`);
    }
    out.push({
      label: String((t && t.label) || '').trim() || `${host}:${port}`,
      cred: {
        host,
        port,
        user: String((t && t.user) || shared.user || 'SYSDBA').trim(),
        password: String((t && t.password) != null ? t.password : shared.password || ''),
      },
      // 每个节点可以有独立的 SSH 目标（主备常在不同机器上）
      remote: t && t.remote && t.remote.enabled
        ? { enabled: true, host: String(t.remote.host || host).trim(), user: t.remote.user, password: t.remote.password }
        : null,
    });
  }
  if (!out.length) throw new Error('请至少填写一个数据库节点。');
  return out;
}

/** 从某个节点的巡检结果里取指定巡检项 */
function findCheck(data, id) {
  return (data.checks || []).find((c) => c.id === id) || null;
}

/** 取某个巡检项的第一行 */
function firstRow(data, id) {
  const c = findCheck(data, id);
  return c && c.rows && c.rows.length ? c.rows[0] : null;
}

/**
 * 每个节点的关键信息（用于集群总览的横向对照）。
 * 全部来自该节点已跑完的巡检结果，不额外连库。
 */
function summarizeNode(node) {
  const d = node.data;
  const inst = firstRow(d, 'basic.instance') || {};
  const roleRow = firstRow(d, 'basic.role') || {};
  const dbRow = firstRow(d, 'basic.database') || {};

  // 表空间最高使用率
  let tsMax = null;
  let tsName = '';
  const ts = findCheck(d, 'ts.usage');
  if (ts && ts.rows) {
    for (const r of ts.rows) {
      const v = Number(String(r.USED_PCT == null ? '' : r.USED_PCT).replace(/[,%]/g, ''));
      if (Number.isFinite(v) && (tsMax === null || v > tsMax)) {
        tsMax = v;
        tsName = String(r.TABLESPACE_NAME || r.NAME || '');
      }
    }
  }

  return {
    label: node.label,
    host: node.cred.host,
    port: node.cred.port,
    instanceName: String(inst.INSTANCE_NAME || roleRow.INSTANCE_NAME || '').trim(),
    hostName: String(inst.HOST_NAME || '').trim(),
    dbStatus: String(inst.STATUS || roleRow.STATUS || '').trim(),
    role: String(roleRow.ROLE || '未知').trim(),
    archMode: String(dbRow.ARCH_MODE || '').trim(),
    tsMaxPct: tsMax,
    tsMaxName: tsName,
    summary: d.summary,
    noData: !!d.noData,
    fatal: d.fatal || null,
    durationMs: d.durationMs,
  };
}

/**
 * 汇总各节点，得到集群级结论。
 * 各类别数量按节点求和（严重/警告…），不涉及评分。
 */
function buildCluster(nodes, meta) {
  const infos = nodes.map(summarizeNode);

  const totalOf = (k) => infos.reduce((a, x) => a + ((x.summary && x.summary[k]) || 0), 0);

  // 部署形态：取各节点识别结果的并集表述
  const modes = [...new Set(infos.map((x) => x.role).filter(Boolean))];
  const anyDsc = (nodes || []).some((n) => {
    const t = firstRow(n.data, 'basic.topology');
    return t && String(t.IS_DSC || '').includes('是');
  });
  const anyDw = (nodes || []).some((n) => {
    const t = firstRow(n.data, 'basic.topology');
    return t && String(t.IS_DW || '').includes('是');
  });
  const deployMode = anyDsc && anyDw
    ? '共享存储集群（DMDSC）+ 数据守护'
    : anyDsc
    ? '共享存储集群（DMDSC）'
    : anyDw
    ? '数据守护集群（主备）'
    : nodes.length > 1
    ? '多节点（未识别出集群特征）'
    : '单实例';

  return {
    ...meta,
    // 与单节点结果保持同样的 meta 形状，便于 server / report 等下游代码统一处理
    meta: {
      ...meta,
      host: `集群（${nodes.length} 节点）`,
      port: deployMode,
      user: '',
      driverName: 'jdbc（多节点）',
      driverId: 'jdbc',
      serverInfo: '',
    },
    isCluster: nodes.length > 1,
    deployMode,
    nodeCount: nodes.length,
    nodes: nodes.map((n, i) => ({ ...n, info: infos[i] })),
    infos,
    // 没有任何一个节点采到数据时提示「未完成」（不做评分，只是个事实标记）
    noData: infos.every((x) => x.noData || x.fatal),
    summary: {
      crit: totalOf('crit'),
      warn: totalOf('warn'),
      ok: totalOf('ok'),
      info: totalOf('info'),
      na: totalOf('na'),
      error: totalOf('error'),
      total: totalOf('total'),
    },
    roles: modes,
  };
}

/**
 * 有限的并发执行：按顺序取任务，最多同时跑 limit 个。
 * 各节点的连接、shell 通道、Java 桥接进程都是独立的，因此可以并行，
 * 总耗时从「各节点耗时之和」降为「最慢的那个节点」。
 * 仍要限并发：每个节点会起一个 Java 进程 + 一条 SSH 会话，开太多会互相拖慢，
 * 也可能触发目标机的连接数限制。
 */
async function runWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 多节点巡检。
 * @param {object} params
 * @param {Array} params.targets  [{label, host, port, user, password, remote}]
 * @param {object} [params.cred]  公共凭据（端口/账号/口令），被单节点覆盖
 * @param {object} [params.options] 传给 runner 的选项（超时、慢 SQL 阈值等）
 * @param {number} [params.options.clusterConcurrency] 并行节点数，默认 3，上限 8
 * @param {function} [params.onProgress] 进度回调，多节点时额外带 aggregate 字段
 */
async function runClusterInspection(params) {
  const targets = normalizeTargets(params);
  const startedAt = new Date();
  const t0 = Date.now();
  const opts = params.options || {};
  const limit = Math.max(1, Math.min(8, parseInt(opts.clusterConcurrency, 10) || 3));

  // 各节点的进度分别记录，再汇总成一条总进度（并行时不能只看某一个节点）
  const nodeState = targets.map(() => ({ done: 0, total: 0 }));
  const emitProgress = (i, p) => {
    nodeState[i] = { done: p.done || 0, total: p.total || 0 };
    if (typeof params.onProgress !== 'function') return;
    const done = nodeState.reduce((a, s) => a + s.done, 0);
    const total = nodeState.reduce((a, s) => a + s.total, 0);
    const parts = nodeState
      .map((s, idx) => (s.total ? `${idx + 1}·${s.done}/${s.total}` : null))
      .filter(Boolean);
    params.onProgress({
      nodeIndex: i,
      nodeTotal: targets.length,
      nodeLabel: targets[i].label,
      // 这些字段必须透传，否则前端的进度文案会变成 undefined
      phase: p.phase,
      done,
      total,
      current: `${targets[i].label} · ${p.current || ''}`,
      group: p.group,
      // 多节点并行时用这条聚合文案，避免进度在几个节点之间来回跳
      aggregate: targets.length > 1 ? parts.join(' ｜ ') : '',
    });
  };

  const nodes = await runWithLimit(targets, limit, async (t, i) => {
    const data = await runInspection({
      driverId: params.driverId || 'jdbc',
      cred: t.cred,
      options: Object.assign({}, opts, { remote: t.remote }),
      onProgress: (p) => emitProgress(i, p),
    });
    return { label: t.label, cred: t.cred, data };
  });

  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}:${pad(d.getSeconds())}`;
  return buildCluster(nodes, {
    tool: 'DM数据库巡检工具',
    startedAt: stamp(startedAt),
    finishedAt: stamp(new Date()),
    durationMs: Date.now() - t0,
    concurrency: limit,
  });
}

module.exports = { runClusterInspection, normalizeTargets, summarizeNode, buildCluster };
