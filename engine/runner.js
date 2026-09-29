'use strict';
/*
 * 巡检执行器
 * ---------------------------------------------------------------------------
 * 职责：
 *   1) 依次执行 lib/checks.js 中定义的巡检项；
 *   2) 每个巡检项按顺序尝试多套 SQL（兼容不同 DM8 小版本的视图差异）；
 *   3) 单项失败不影响整体，只记录失败原因；
 *   4) 查询超时导致桥接器熔断时自动重连并继续后面的巡检项；
 *   5) 汇总各类别数量并产出报告数据模型（不评分、不评级）。
 */

const checks = require('./checks');
const { createSession } = require('./drivers');
const { sweepRuntime } = require('./remote');
const { normalizeOptions, resolveOpt } = require('./runtimeopts');
const { recordSql } = require('./sqlsig');

const LEVELS = ['crit', 'warn', 'ok', 'info', 'na', 'error'];
const LEVEL_TEXT = { crit: '严重', warn: '警告', ok: '正常', info: '信息', na: '不适用', error: '未取到' };

/** 当前正在跑的巡检数（多节点并行时 >1）。最后一个跑完的负责兜底清理临时文件。 */
let ACTIVE_RUNS = 0;

function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) +
    ':' + p(d.getMinutes()) +
    ':' + p(d.getSeconds())
  );
}

function normalizeCred(cred) {
  const c = cred || {};
  const host = String(c.host || '').trim();
  const port = parseInt(c.port, 10);
  if (!host) throw new Error('请填写数据库 IP 或主机名。');
  if (!port || port < 1 || port > 65535) throw new Error('请填写合法的端口号（达梦默认 5236）。');
  return {
    host,
    port,
    user: String(c.user || '').trim() || 'SYSDBA',
    password: String(c.password == null ? '' : c.password),
    schema: c.schema ? String(c.schema).trim() : '',
  };
}

/** 驱动层返回的行是「按位置的数组」，统一转换成「按列名的对象」 */
function normalizeRows(r) {
  if (!r || !Array.isArray(r.rows)) return r;
  const cols = r.columns || [];
  r.rows = r.rows.map((arr) => {
    if (!Array.isArray(arr)) return arr; // 自定义巡检项已返回对象
    const o = {};
    for (let k = 0; k < cols.length; k++) o[cols[k]] = arr[k];
    return o;
  });
  return r;
}

/**
 * @param {object} params
 * @param {string} [params.driverId] 'jdbc' | 'demo'
 * @param {object} params.cred         { host, port, user, password, schema }
 * @param {object} [params.options]    { queryTimeoutMs, connectTimeoutMs, demoDelayMs }
 * @param {function} [params.onProgress] (info) => void
 */
async function runInspection(params) {
  const startedAt = nowLocal();
  const t0 = Date.now();
  const options = Object.assign(
    { queryTimeoutMs: 20000, connectTimeoutMs: 15000, assumeLocalOs: false, slowSqlMs: 1000, remote: null },
    params.options || {},
    // 高级选项里的「表空间使用率阈值 / Top N」先夹逼再覆盖，保证后续 SQL 与判定拿到的是安全值
    normalizeOptions(params.options)
  );
  const onProgress = typeof params.onProgress === 'function' ? params.onProgress : () => {};

  const cred = normalizeCred(params.cred);
  const log = [];
  ACTIVE_RUNS++;

  let session = null;
  let driverId = '';
  let driverName = '';
  let serverInfo = '';
  // 提到外层：收尾时要拿它释放 shell 通道（ctx 原本声明在下面的 if 块里）
  let ctxRef = null;

  async function openSession() {
    const made = await createSession(params.driverId, options);
    session = made.session;
    driverId = made.driverId;
    driverName = made.driverName;
    if (typeof session.open === 'function') {
      await session.open();
    }
    serverInfo = (await session.connect(cred)) || '';
    return serverInfo;
  }

  async function reopenSession(reason) {
    log.push(`[${nowLocal()}] 会话不可用（${reason}），正在重连…`);
    try {
      if (session && typeof session.close === 'function') await session.close();
    } catch (_) {
      /* ignore */
    }
    session = null;
    await openSession();
  }

  const results = [];
  const summary = { crit: 0, warn: 0, ok: 0, info: 0, na: 0, error: 0, total: checks.length };
  let fatal = null;

  try {
    await openSession();
    log.push(`[${nowLocal()}] 已连接 ${cred.host}:${cred.port}（${driverName}）${serverInfo ? '，服务端：' + serverInfo : ''}`);
  } catch (e) {
    fatal = e;
    log.push(`[${nowLocal()}] 连接失败：${e.message}`);
  }

  if (!fatal) {
    // 供自定义巡检项使用的上下文：可查库、可读服务器文件、可采集 OS 指标
    const ctx = {
      driverId,
      cred,
      options,
      // 巡检项之间共享的运行时状态（例如 basic.topology 识别出的部署形态，
      // 集群类巡检项据此判断自己是否适用）
      state: {
        // 本工具本轮执行过的 SQL 指纹：「长 SQL 历史」「SQL 历史」据此把
        // **工具自己跑的查询**从业务慢 SQL 里区分出来（否则会自己告警自己）
        executedSql: new Set(),
      },
      get session() {
        return session;
      },
      log(msg) {
        log.push(`[${nowLocal()}] ${msg}`);
      },
      async query(sql, opts) {
        recordSql(ctx.state.executedSql, sql);
        if (session && session.poisoned) {
          await reopenSession('上一次查询超时');
        }
        return normalizeRows(
          await session.query(sql, {
            maxRows: (opts && opts.maxRows) || 500,
            timeoutMs: (opts && opts.timeoutMs) || options.queryTimeoutMs,
          })
        );
      },
      /** 按顺序尝试多套 SQL，返回第一个成功的结果；全部失败返回 null */
      async queryTry(sqlList) {
        const list = Array.isArray(sqlList) ? sqlList : [sqlList];
        for (const sql of list) {
          try {
            return await ctx.query(sql);
          } catch (_) {
            /* 换下一套 */
          }
        }
        return null;
      },
    };
    ctxRef = ctx;

    // -----------------------------------------------------------------------
    // 开跑前把**所有巡检项声明的 SQL**都记进指纹集合。
    // 为什么不能只记「已经执行过的」：慢 SQL 检查（sql.longexec / sql.history）
    // 在「SQL 性能」组里排在 sql.indexfrag 前面，如果只记执行过的，
    // 排在它们之后的项指纹还没进集合，上一轮留下的同一条查询就会被当成业务慢 SQL。
    // 真机 DMDSC 上正是这样漏了一条（INDEX_USED_PAGES 那条）。
    // 自定义巡检项的内部拼 SQL 无法静态枚举，仍由执行时记录兜底。
    // -----------------------------------------------------------------------
    for (const c of checks) {
      try {
        const raw = typeof c.sql === 'function' ? c.sql(ctx) : c.sql;
        for (const s of [].concat(raw || [])) recordSql(ctx.state.executedSql, s);
      } catch (_) {
        /* 取不到就算了，执行时还会再记一次 */
      }
    }

    const total = checks.length;
    for (let i = 0; i < total; i++) {
      const check = checks[i];
      // 标题/说明允许写成 (options) => 字符串：Top 类巡检项的标题里带条数，
      // 条数可配置后必须跟着变，否则会出现「标题写 Top 10、实际列 20 行」的自相矛盾。
      const checkTitle = resolveOpt(check.title, options);
      const checkDesc = resolveOpt(check.desc, options);
      onProgress({
        phase: 'running',
        index: i,
        done: i,
        total,
        current: checkTitle,
        group: check.group,
      });

      // sql 可以是字符串数组，也可以是 (ctx) => 数组 的函数
      // （用于按运行参数动态拼 SQL，例如「慢 SQL 阈值」这类可配置项）
      const rawSql = typeof check.sql === 'function' ? check.sql(ctx) : check.sql;
      const sqls = Array.isArray(rawSql) ? rawSql.slice() : rawSql ? [rawSql] : [];
      const maxRows = check.maxRows || 200;
      let data = null;
      let usedSql = null;
      let lastError = null;

      const isDemo = typeof session.queryCheck === 'function';

      if (isDemo) {
        // 演示模式：直接使用内置样例数据，不执行 SQL，也不跑自定义逻辑
        try {
          data = normalizeRows(await session.queryCheck(check, { maxRows, timeoutMs: options.queryTimeoutMs }));
          lastError = null;
        } catch (e) {
          lastError = e;
        }
      } else if (typeof check.custom === 'function') {
        // 自定义巡检项：允许自行组织多次查询、读取服务器文件、采集 OS 指标等
        try {
          // 把本项声明的 SQL 挂到 ctx 上，自定义逻辑可直接复用（避免同一段 SQL 写两遍）
          ctx.sql = sqls;
          ctx.check = check;
          data = normalizeRows(await check.custom(ctx));
          // 自定义项如果同时声明了 sql，就把主查询作为报告附录里展示的 SQL，便于复核
          usedSql = sqls.length
            ? sqls[0] +
              (sqls.length > 1 ? `\n-- （该项另有 ${sqls.length - 1} 套兼容/降级 SQL，此处展示主查询）` : '')
            : '（自定义巡检项：由程序采集，未使用固定 SQL）';
          lastError = null;
        } catch (e) {
          lastError = e;
          if (session && session.poisoned) {
            try {
              await reopenSession('自定义巡检项查询超时');
            } catch (e2) {
              lastError = e2;
            }
          }
        }
      } else {
        for (let a = 0; a < sqls.length; a++) {
          const sql = sqls[a];
          recordSql(ctx.state.executedSql, sql);
          if (session && session.poisoned) {
            try {
              await reopenSession('上一次查询超时');
            } catch (e) {
              lastError = e;
              break;
            }
          }
          try {
            data = normalizeRows(await session.query(sql, { maxRows, timeoutMs: options.queryTimeoutMs }));
            usedSql = sql;
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            // 该套 SQL 不可用（视图/列不存在或权限不足），继续尝试下一套
          }
        }
      }

      let status = 'error';
      let message = '';

      if (data) {
        try {
          const ev =
            typeof check.evaluate === 'function' ? check.evaluate(data.rows, data, { options }) : null;
          if (ev && ev.level) {
            status = LEVELS.includes(ev.level) ? ev.level : 'info';
            message = ev.message || '';
          } else {
            status = 'info';
            message = `共取回 ${data.rowCount} 行数据。`;
          }
        } catch (e) {
          status = 'error';
          message = '判定规则执行异常：' + e.message;
        }
        // 形态不匹配（如单实例下的集群巡检项）：独立记为「不适用」，
        // 既不报错，也不混进正常/异常统计
        if (data.meta && data.meta.notApplicable) {
          status = 'na';
        }
      } else {
        message = lastError ? lastError.message.split('\n')[0] : '未取到数据';
      }

      summary[status] = (summary[status] || 0) + 1;

      results.push({
        id: check.id,
        group: check.group,
        title: checkTitle,
        desc: checkDesc || '',
        advice: check.advice || '',
        status,
        statusText: LEVEL_TEXT[status],
        message,
        columns: data ? data.columns : [],
        rows: data ? data.rows : [],
        rowCount: data ? data.rowCount : 0,
        display: check.display || 'auto',
        // bars / groupTop 也允许是 (options) => 值，取值时已经把高级选项算进去
        bars: resolveOpt(check.bars, options) || null,
        groupBy: check.groupBy || null,
        groupTop: resolveOpt(check.groupTop, options) || null,
        meta: data ? data.meta || null : null,
        isCustom: typeof check.custom === 'function',
        hasRowLevel: typeof check.rowLevel === 'function',
        rowLevels: data && typeof check.rowLevel === 'function'
          ? data.rows.map((r) => {
              try {
                // 把高级选项透给 rowLevel：表空间使用率等阈值由用户配置
                return check.rowLevel(r, options) || null;
              } catch (_) {
                return null;
              }
            })
          : null,
        sqlUsed: usedSql,
        sqlCount: sqls.length,
        error: data ? null : message,
      });

      onProgress({
        phase: 'running',
        index: i,
        done: i + 1,
        total,
        current: checkTitle,
        group: check.group,
        status,
      });
    }
  }

  try {
    if (session && typeof session.close === 'function') await session.close();
  } catch (_) {
    /* ignore */
  }

  const finishedAt = nowLocal();
  const durationMs = Date.now() - t0;

  // 连接都没建立起来、或者所有巡检项都没成功执行时，「0 个问题」并不代表「一切正常」——
  // 恰恰相反，它意味着什么都没查到。这种情况单独标出来，报告顶部要给出醒目提示，
  // 不能让人把一份空报告当成健康报告（本工具不评分，但这个区分仍然必要）。
  const nothingCollected = !!(fatal || results.every((r) => r.status === 'error' || r.status === 'na'));

  // 问题清单：严重在前
  const issues = results
    .filter((r) => r.status === 'crit' || r.status === 'warn')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'crit' ? -1 : 1));

  // 按分类分组，保持 checks.js 中的出现顺序
  const groupOrder = [];
  const groupMap = new Map();
  for (const r of results) {
    if (!groupMap.has(r.group)) {
      groupMap.set(r.group, []);
      groupOrder.push(r.group);
    }
    groupMap.get(r.group).push(r);
  }

  // 收尾：关会话、释放 shell 通道、删掉本次运行产生的临时文件。
  // 放在这里（唯一的返回点之前），保证成功/失败/异常都会执行到。
  await finishRun(ctxRef, session);

  return {
    ok: !fatal,
    fatal: fatal ? fatal.message : null,
    meta: {
      host: cred.host,
      port: cred.port,
      user: cred.user,
      driverId,
      driverName,
      serverInfo,
      startedAt,
      finishedAt,
      durationMs,
      tool: 'DM数据库巡检工具',
    },
    summary,
    // 什么都没采集到时为 true：报告据此给出醒目提示（不再涉及任何评分）
    noData: nothingCollected,
    issues,
    groups: groupOrder.map((name) => ({ name, items: groupMap.get(name) })),
    checks: results,
    log,
  };
}

/**
 * 一次巡检结束后的收尾：关会话、释放 shell 通道、清理临时文件。
 * ---------------------------------------------------------------------------
 * 无论成功、失败还是抛异常都必须执行 —— 否则临时文件会一直留在 runtime/ 里。
 * 单个步骤出错不影响其它步骤，也绝不让清理失败影响返回给用户的结果。
 *
 * 临时文件分两级清理（多节点并行时会同时有多个 runInspection 在跑）：
 *   1) 各实例只删**自己**那个按 pid+时间戳命名的文件，不会误伤其它节点；
 *   2) 只有**最后一个**跑完的巡检才做兜底 sweep，删掉固定名的诊断日志。
 *      早期版本「每个节点跑完就全清」，并行时会删掉别的节点正在读的文件。
 */
async function finishRun(ctx, session) {
  try {
    if (ctx && ctx.state && ctx.state.hostShell && typeof ctx.state.hostShell.dispose === 'function') {
      ctx.state.hostShell.dispose();
    }
  } catch (_) {
    /* ignore */
  }
  try {
    if (session && typeof session.close === 'function') await session.close();
  } catch (_) {
    /* ignore */
  }
  ACTIVE_RUNS = Math.max(0, ACTIVE_RUNS - 1);
  if (ACTIVE_RUNS === 0) {
    try {
      sweepRuntime();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { runInspection, normalizeCred, LEVEL_TEXT };
