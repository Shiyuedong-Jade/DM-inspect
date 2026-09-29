'use strict';
/*
 * 补充巡检项
 * ---------------------------------------------------------------------------
 * 依据《巡检检查项 V4.3.X.x》官方检查项表补齐，分三块：
 *   一、数据守护集群相关内容   V$ARCH_SEND_INFO / V$RAPPLY_SYS / V$RAPPLY_STAT
 *                              V$DM_MAL_INI / V$MAL_SYS / V$DMMONITOR
 *   二、共享存储集群相关内容   V$DSC_EP_INFO / V$DCR_GROUP / V$DCR_INFO
 *                              V$DSC_GBS_POOL / V$DSC_LBS_POOL / V$ASMGROUP
 *                              V$ASMDISK / V$DSC_REQUEST_STATISTIC
 *   三、单实例补充项           V$INSTANCE_LOG_HISTORY（实例异常日志，走视图而非读文件）
 *                              V$CKPT_HISTORY / V$DB_CACHE / V$SYSTEM_EVENT / V$SYSSTAT
 *                              DBA_INDEXES / DBA_IND_PARTITIONS / DBA_SEQUENCES
 *                              TABLE_USED_PAGES / INDEX_USED_PAGES 等
 *
 * 集群类巡检项会先读取 basic.topology 识别出的部署形态：
 * 形态不匹配时直接返回「不适用」，而不是把一堆「视图不存在」当成异常刷屏。
 */

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim().replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
};
const first = (rows, key) => (rows && rows.length ? rows[0][key] : null);

const SYS_OWNERS =
  "'SYS','SYSAUDITOR','SYSSSO','SYSDBA','SYSJOB','SYSDBO','SCHEDULER','CTISYS','SYSBO'";

// 高级选项（Top N）的取值与夹逼工具
const { topLimit } = require('./runtimeopts');

/** 形态不匹配时返回统一的「不适用」结果 */
function notApplicable(kind, ctx) {
  const t = (ctx && ctx.state && ctx.state.topology) || null;
  if (!t) return null; // 未识别出形态，仍尝试执行，由 SQL 自身决定成功与否
  const need = kind === 'dw' ? t.isDw : t.isDsc;
  if (need) return null;
  const label = kind === 'dw' ? '数据守护集群' : '共享存储集群（DMDSC）';
  return {
    columns: ['APPLICABILITY'],
    rows: [{ APPLICABILITY: `不适用：未检测到${label}（当前部署形态：${t.mode}）` }],
    rowCount: 1,
    meta: { notApplicable: true },
  };
}

/** 把「不适用」判断包进 evaluate */
const guarded = (fn) => (rows, data, ectx) => {
  if (data && data.meta && data.meta.notApplicable) {
    return { level: 'info', message: (rows[0] && rows[0].APPLICABILITY) || '不适用。' };
  }
  return fn(rows, data, ectx);
};

const NA_COLUMNS = ['APPLICABILITY'];

module.exports = [
  // ==================================================== 一、数据守护集群
  {
    id: 'dw.archsend',
    group: '数据守护集群',
    title: '数据守护发送信息',
    desc: '主库向备库发送归档日志的耗时，反映主备链路（MAL）是否健康',
    sql: [
      `SELECT ARCH_DEST,
              ROUND(MAX_SEND_TIME/1000.0, 2)  AS MAX_SEND_TIME,
              ROUND(LAST_SEND_TIME/1000.0, 2) AS LAST_SEND_TIME,
              TO_CHAR(LAST_START_TIME,'YYYY-MM-DD HH24:MI:SS') AS LAST_START_TIME
         FROM V$ARCH_SEND_INFO`,
    ],
    custom: async (ctx) => notApplicable('dw', ctx) || ctx.query(ctx.sql[0]),
    rowLevel(row) {
      const s = num(row.MAX_SEND_TIME);
      if (s === null) return null;
      if (s > 60) return 'crit';
      if (s > 10) return 'warn';
      return null;
    },
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'ok', message: '没有待发送的归档日志，主备发送队列为空。' };
      const worst = rows.reduce((a, r) => Math.max(a, num(r.MAX_SEND_TIME) || 0), 0);
      if (worst > 60) {
        return { level: 'crit', message: `归档发送最大耗时 ${worst} 秒，主备同步严重滞后，请检查 MAL 链路与备库状态。` };
      }
      if (worst > 10) return { level: 'warn', message: `归档发送最大耗时 ${worst} 秒，建议关注主备链路。` };
      return { level: 'ok', message: `共 ${rows.length} 个归档发送目标，最大发送耗时 ${worst} 秒，链路正常。` };
    }),
  },
  {
    id: 'dw.sync',
    group: '数据守护集群',
    title: '数据守护同步信息',
    desc: '备库日志重演（APPLY）状态与主备延迟（SEARCHDELAY）',
    sql: [
      `SELECT * FROM
         (SELECT APPLYING, TASK_NUM,
                 TO_CHAR(ROUND(TASK_MEM_USED/1024.0, 2)) AS TASK_MEM_USED
            FROM V$RAPPLY_SYS),
         (SELECT TO_CHAR(ROUND(RECNT_APPLY_LEN/1024.0/NULLIF(RECNT_APPLY_TIME,0), 2)) AS RECNT_APPLY_LEN
            FROM V$RAPPLY_STAT),
         (SELECT DATEDIFF(SECOND, APPLY_CMT_TIME, LAST_CMT_TIME) AS SEARCHDELAY
            FROM V$RAPPLY_STAT)`,
      `SELECT APPLYING, TASK_NUM FROM V$RAPPLY_SYS`,
    ],
    custom: async (ctx) => notApplicable('dw', ctx) || ctx.queryTry(ctx.sql),
    rowLevel(row) {
      const d = num(row.SEARCHDELAY);
      if (d === null) return null;
      if (d > 300) return 'crit';
      if (d > 60) return 'warn';
      return null;
    },
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'info', message: '未读取到日志重演信息（可能本机为主库，或该视图在当前角色下无数据）。' };
      const r = rows[0];
      const applying = String(r.APPLYING == null ? '' : r.APPLYING).trim().toUpperCase();
      const delay = num(r.SEARCHDELAY);
      const msgs = [];
      let level = 'ok';
      if (applying === 'N' || applying === '0') {
        level = 'crit';
        msgs.push('日志重演状态 APPLYING=N，备库未在应用日志');
      } else if (applying) {
        msgs.push('日志重演进行中');
      }
      if (delay !== null) {
        if (delay > 300) {
          level = 'crit';
          msgs.push(`主备延迟 ${delay} 秒`);
        } else if (delay > 60) {
          level = level === 'ok' ? 'warn' : level;
          msgs.push(`主备延迟 ${delay} 秒，偏高`);
        } else {
          msgs.push(`主备延迟 ${delay} 秒`);
        }
      }
      return { level, message: msgs.length ? msgs.join('；') + '。' : `日志重演任务数 ${r.TASK_NUM || '未知'}。` };
    }),
    advice: '主备延迟过大时检查 MAL 链路带宽、备库磁盘 IO 与重演线程负载。',
  },
  {
    id: 'dw.mal',
    group: '数据守护集群',
    title: '内部 MAL 信息',
    desc: 'dmmal.ini 中的 MAL 链路配置：实例、私有网络地址、端口与链路标识',
    // 真机（DMDSC 两节点，DM 8.1.5.60）核对：V$DM_MAL_INI 的列名是
    // MAL_NAME / MAL_INST_NAME / MAL_HOST / MAL_PORT / MAL_INST_HOST / MAL_INST_PORT …
    // 原先写的 INST_NAME / INST_IP / INST_PORT 在真机上直接报「无效的列名」，
    // 而该巡检项在单实例下永远被判定为「不适用」，所以这个错误此前从未暴露。
    // 另外 MAL_INST_HOST / MAL_INST_PORT 在真机上是空/0，实际可用的是 MAL_HOST / MAL_PORT。
    sql: [
      `SELECT MAL_NAME, MAL_INST_NAME, MAL_HOST, MAL_PORT, MAL_DW_PORT, MAL_LINK_MAGIC
         FROM V$DM_MAL_INI`,
      `SELECT * FROM V$DM_MAL_INI`,
    ],
    custom: async (ctx) => notApplicable('dw', ctx) || ctx.query(ctx.sql[0]),
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'warn', message: '未读取到 MAL 配置，请确认 dmmal.ini 已正确配置。' };
      const desc = rows
        .map((r) => `${r.MAL_INST_NAME || r.MAL_NAME || '?'}(${r.MAL_HOST || '?'}:${r.MAL_PORT || '?'})`)
        .filter((s) => !/\(\?:?\)?$/.test(s))
        .join('、');
      return { level: 'info', message: `共 ${rows.length} 条 MAL 链路配置：${desc}。` };
    }),
  },
  {
    id: 'dw.malmem',
    group: '数据守护集群',
    title: '守护集群 MAL 内存配置',
    desc: 'MAL 发送缓冲区实际内存上限与物理内存的比例，过大易导致内存紧张',
    sql: [`SELECT SYS_STATUS, STMT_ID, NEXT_MAL_ID, N_SITE, MAL_NUM, MAL_COMPRESS_LEVEL, MAL_BUF_SIZE, MAL_VPOOL_SIZE FROM V$MAL_SYS`],
    custom: async (ctx) => {
      const na = notApplicable('dw', ctx);
      if (na) return na;
      const r = await ctx.queryTry(ctx.sql);
      if (!r) throw new Error('V$MAL_SYS 不可读');
      // 取物理内存用于比对（V$SYSTEMINFO 不可用时按无法判定处理）
      const sys = await ctx.queryTry([
        `SELECT ROUND(TOTAL_PHY_SIZE/1024/1024/1024, 2) AS PHY_TOTAL_GB FROM V$SYSTEMINFO`,
      ]);
      const phyGB = sys && sys.rows.length ? num(sys.rows[0].PHY_TOTAL_GB) : null;
      const limit = r.rows.length ? (num(r.rows[0].MAL_VPOOL_SIZE) || 0) * 10 : 0; // 单位 MB
      const limitGB = limit / 1024;
      const pct = phyGB ? (limit / (phyGB * 1024)) * 100 : null;
      const rows = r.rows.map((x) => Object.assign({}, x, {
        MAL_MEM_LIMIT_MB: limitGB.toFixed(2),
        MAL_MEM_PCT: pct === null ? '' : pct.toFixed(2),
      }));
      return {
        columns: r.columns.concat(['MAL_MEM_LIMIT_MB', 'MAL_MEM_PCT']),
        rows,
        rowCount: rows.length,
        meta: { phyGB, limitGB, pct },
      };
    },
    rowLevel(row) {
      const p = num(row.MAL_MEM_PCT);
      if (p === null) return null;
      if (p > 20) return 'crit';
      if (p > 10) return 'warn';
      return null;
    },
    evaluate: guarded((rows, data) => {
      if (!rows.length) return { level: 'info', message: '未读取到 MAL 内存配置。' };
      const meta = (data && data.meta) || {};
      if (meta.pct === null || meta.pct === undefined) {
        return { level: 'info', message: `MAL 发送缓冲内存上限约 ${meta.limitGB.toFixed(2)} GB（未能取到物理内存，无法比对比例）。` };
      }
      const msg = `MAL 发送缓冲内存上限约 ${meta.limitGB.toFixed(2)} GB，占物理内存 ${meta.phyGB} GB 的 ${meta.pct.toFixed(2)}%`;
      if (meta.pct > 20) return { level: 'crit', message: msg + '，超过 20%，内存压力过大，建议调小 MAL_VPOOL_SIZE。' };
      if (meta.pct > 10) return { level: 'warn', message: msg + '，超过 10%，建议关注。' };
      return { level: 'ok', message: msg + '，配置合理。' };
    }),
    advice: 'MAL_VPOOL_SIZE 实际最大内存上限约为其值的 10 倍，建议控制在物理内存的 10% 以内。',
  },
  {
    id: 'dw.monitor',
    group: '数据守护集群',
    title: '守护监视器信息',
    desc: '已连接的数据守护监视器（dmmonitor）信息，用于确认监控覆盖情况',
    sql: [
      `SELECT TO_CHAR(DW_CONN_TIME,'YYYY-MM-DD HH24:MI:SS') AS CONN_TIME,
              MON_CONFIRM, MON_IP, MON_ID, MON_TERM
         FROM V$DMMONITOR`,
    ],
    custom: async (ctx) => notApplicable('dw', ctx) || ctx.query(ctx.sql[0]),
    evaluate: guarded((rows) => {
      if (!rows.length) {
        return { level: 'warn', message: '当前没有已连接的数据守护监视器，主备状态异常时可能无法及时告警。' };
      }
      return { level: 'ok', message: `已连接 ${rows.length} 个守护监视器：${rows.map((r) => r.MON_IP || r.MON_ID).filter(Boolean).join('、')}。` };
    }),
  },

  // ================================================ 二、共享存储集群 DMDSC
  {
    id: 'dsc.nodes',
    group: '共享存储集群',
    title: '共享集群节点信息',
    desc: 'DMDSC 各节点（EP）的状态，任一节点异常都需立即处理',
    sql: [`SELECT EP_NAME, EP_SEQNO, EP_MODE, EP_STATUS FROM V$DSC_EP_INFO`],
    custom: async (ctx) => notApplicable('dsc', ctx) || ctx.query(ctx.sql[0]),
    rowLevel(row) {
      const s = String(row.EP_STATUS == null ? '' : row.EP_STATUS).trim().toUpperCase();
      if (!s) return null;
      if (/OPEN|NORMAL|OK|1/.test(s)) return null;
      return 'crit';
    },
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'crit', message: '未读取到任何 DMDSC 节点信息，集群可能异常。' };
      const bad = rows.filter((r) => !/OPEN|NORMAL|OK|1/.test(String(r.EP_STATUS || '').trim().toUpperCase()));
      const list = rows.map((r) => `${r.EP_NAME}(${r.EP_STATUS})`).join('、');
      if (bad.length) {
        return { level: 'crit', message: `共 ${rows.length} 个节点，其中 ${bad.length} 个状态异常：${bad.map((r) => r.EP_NAME + '=' + r.EP_STATUS).join('、')}。` };
      }
      return { level: 'ok', message: `共 ${rows.length} 个节点，状态均正常：${list}。` };
    }),
    advice: '节点状态异常时检查 CSS 通信、共享存储（DCR/VTD）可访问性与节点日志。',
  },
  {
    id: 'dsc.dcrgroup',
    group: '共享存储集群',
    title: '共享集群服务信息',
    desc: 'DCR 中的集群组与节点数，用于确认集群视图与磁盘心跳配置',
    sql: [`SELECT GROUP_TYPE, GROUP_NAME, N_EP, DSKCHK_CNT, NETCHK_TIME FROM V$DCR_GROUP`],
    custom: async (ctx) => notApplicable('dsc', ctx) || ctx.query(ctx.sql[0]),
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'info', message: '未读取到 DCR 组信息。' };
      const eps = rows.reduce((a, r) => Math.max(a, num(r.N_EP) || 0), 0);
      return { level: 'info', message: `共 ${rows.length} 个集群组，最大节点数 ${eps}：${rows.map((r) => r.GROUP_NAME).filter(Boolean).join('、')}。` };
    }),
  },
  {
    id: 'dsc.register',
    group: '共享存储集群',
    title: '共享集群注册信息',
    desc: 'DCR/VTD 路径、OGUID 与全局/本地缓冲池控制块使用情况',
    // 原实现把三个视图写在 FROM 里做笛卡尔连接：
    //   V$DCR_INFO(3 行) × V$DSC_GBS_POOL(1 行) × V$DSC_LBS_POOL(19 行) = 57 行，
    // 于是报告里出现一大片几乎相同的记录。
    // 真机核对后：V$DCR_INFO 是「一个 DCR 盘一行」（V1/V2/V3），
    // V$DSC_LBS_POOL 的 19 行内容完全相同（N_SUB_POOL=19 的汇总值），
    // 因此改为分别查询、在 JS 侧汇总成一行，DCR 路径去重后合并展示。
    sql: [
      `SELECT VERSION, N_GROUP, VTD_PATH, UDP_OGUID, DCR_PATH FROM V$DCR_INFO`,
      `SELECT N_CTL, N_FREE_CTL, N_SUB_POOL FROM V$DSC_GBS_POOL`,
      `SELECT MAX(N_CTL) AS N_CTL, MIN(N_FREE_CTL) AS N_FREE_CTL, MAX(N_SUB_POOL) AS N_SUB_POOL FROM V$DSC_LBS_POOL`,
    ],
    custom: async (ctx) => {
      const na = notApplicable('dsc', ctx);
      if (na) return na;
      const dcr = await ctx.queryTry([ctx.sql[0]]);
      const gbs = await ctx.queryTry([ctx.sql[1]]);
      const lbs = await ctx.queryTry([ctx.sql[2]]);
      if (!dcr && !gbs && !lbs) throw new Error('V$DCR_INFO / V$DSC_GBS_POOL / V$DSC_LBS_POOL 均不可读');

      const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined && String(x).trim() !== ''))];
      const d0 = dcr && dcr.rows.length ? dcr.rows[0] : {};
      const dcrPaths = uniq((dcr ? dcr.rows : []).map((r) => String(r.DCR_PATH || '').trim()));
      const vtdPaths = uniq((dcr ? dcr.rows : []).map((r) => String(r.VTD_PATH || '').trim()));
      const g = gbs && gbs.rows.length ? gbs.rows[0] : {};
      const l = lbs && lbs.rows.length ? lbs.rows[0] : {};

      const row = {
        VERSION: d0.VERSION === undefined ? '' : String(d0.VERSION),
        UDP_OGUID: d0.UDP_OGUID === undefined ? '' : String(d0.UDP_OGUID),
        N_GROUP: d0.N_GROUP === undefined ? '' : String(d0.N_GROUP),
        DCR_PATH: dcrPaths.join('、'),
        VTD_PATH: vtdPaths.join('、'),
        DCR_DISK_CNT: dcr ? String(dcr.rows.length) : '',
        G_N_CTL: g.N_CTL === undefined ? '' : String(g.N_CTL),
        G_N_FREE_CTL: g.N_FREE_CTL === undefined ? '' : String(g.N_FREE_CTL),
        L_N_CTL: l.N_CTL === undefined ? '' : String(l.N_CTL),
        L_N_FREE_CTL: l.N_FREE_CTL === undefined ? '' : String(l.N_FREE_CTL),
      };
      return { columns: Object.keys(row), rows: [row], rowCount: 1 };
    },
    rowLevel(row) {
      const g = num(row.G_N_FREE_CTL);
      const l = num(row.L_N_FREE_CTL);
      if (g !== null && g <= 0) return 'crit';
      if (l !== null && l <= 0) return 'crit';
      if (g !== null && g < 100) return 'warn';
      if (l !== null && l < 100) return 'warn';
      return null;
    },
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'info', message: '未读取到集群注册信息。' };
      const r = rows[0];
      const g = num(r.G_N_FREE_CTL);
      const l = num(r.L_N_FREE_CTL);
      const msgs = [
        `DCR 盘 ${r.DCR_DISK_CNT || '?'} 个：${r.DCR_PATH || '未知'}`,
        `OGUID=${r.UDP_OGUID || '未知'}`,
      ];
      let level = 'ok';
      if (g !== null) {
        msgs.push(`全局控制块空闲 ${g}/${r.G_N_CTL || '?'}`);
        if (g <= 0) level = 'crit';
        else if (g < 100) level = level === 'ok' ? 'warn' : level;
      }
      if (l !== null) {
        msgs.push(`本地控制块空闲 ${l}/${r.L_N_CTL || '?'}`);
        if (l <= 0) level = 'crit';
        else if (l < 100) level = level === 'ok' ? 'warn' : level;
      }
      return { level, message: msgs.join('，') + '。' };
    }),
  },
  {
    id: 'dsc.asmgroup',
    group: '共享存储集群',
    title: 'ASM 磁盘组信息',
    desc: 'ASM 磁盘组容量与剩余比例，DMDSC 的共享存储写满会直接导致集群异常',
    maxRows: 50,
    bars: { PEC_FREE_NUM: { warn: 20, crit: 10, invert: true } },
    sql: [
      `SELECT GROUP_NAME, N_DISK, TOTAL_SIZE, FREE_SIZE,
              ROUND((FREE_SIZE * 1.0 / NULLIF(TOTAL_SIZE,0)), 4) * 100 AS PEC_FREE_NUM,
              ROUND((TOTAL_SIZE - FREE_SIZE) * 1.0 / NULLIF(TOTAL_SIZE,0), 4) * 100 AS PEC_USED_NUM,
              TOTAL_FILE_NUM
         FROM V$ASMGROUP`,
    ],
    custom: async (ctx) => {
      const na = notApplicable('dsc', ctx);
      if (na) return na;
      const r = await ctx.queryTry(ctx.sql);
      if (!r) throw new Error('V$ASMGROUP 不可读');
      const rows = r.rows.map((x) => Object.assign({}, x, {
        PEC_FREE: x.PEC_FREE_NUM === undefined ? '' : Number(x.PEC_FREE_NUM).toFixed(2) + '%',
        PEC_USED: x.PEC_USED_NUM === undefined ? '' : Number(x.PEC_USED_NUM).toFixed(2) + '%',
      }));
      return {
        columns: ['GROUP_NAME', 'N_DISK', 'TOTAL_SIZE', 'FREE_SIZE', 'PEC_FREE', 'PEC_USED', 'TOTAL_FILE_NUM'],
        rows,
        rowCount: rows.length,
      };
    },
    rowLevel(row) {
      const f = num(row.PEC_FREE_NUM);
      if (f === null) return null;
      if (f < 10) return 'crit';
      if (f < 20) return 'warn';
      return null;
    },
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'info', message: '未读取到 ASM 磁盘组信息。' };
      const low = rows.filter((r) => num(r.PEC_FREE_NUM) < 20);
      const list = rows.map((r) => `${r.GROUP_NAME} 剩余 ${Number(r.PEC_FREE_NUM).toFixed(2)}%`).join('，');
      if (low.some((r) => num(r.PEC_FREE_NUM) < 10)) {
        return { level: 'crit', message: `ASM 磁盘组剩余空间严重不足：${list}。共享存储写满会导致整个集群异常。` };
      }
      if (low.length) return { level: 'warn', message: `以下 ASM 磁盘组剩余不足 20%：${list}。` };
      return { level: 'ok', message: `共 ${rows.length} 个 ASM 磁盘组：${list}。` };
    }),
  },
  {
    id: 'dsc.asmdisk',
    group: '共享存储集群',
    title: 'ASM 磁盘信息',
    desc: 'ASM 磁盘明细与空闲 AU 数',
    maxRows: 100,
    sql: [`SELECT GROUP_ID, DISK_ID, DISK_NAME, DISK_PATH, SIZE, FREE_AUNO FROM V$ASMDISK`],
    custom: async (ctx) => notApplicable('dsc', ctx) || ctx.query(ctx.sql[0]),
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'info', message: '未读取到 ASM 磁盘信息。' };
      const zero = rows.filter((r) => num(r.FREE_AUNO) === 0);
      if (zero.length) {
        return { level: 'crit', message: `有 ${zero.length} 块 ASM 磁盘空闲 AU 为 0：${zero.map((r) => r.DISK_NAME).join('、')}。` };
      }
      return { level: 'info', message: `共 ${rows.length} 块 ASM 磁盘，均有空闲 AU。` };
    }),
  },
  {
    id: 'dsc.request',
    group: '共享存储集群',
    title: (o) => `共享集群高频请求 Top ${o.topN}`,
    desc:
      '按请求类型统计的集群内部请求量与平均耗时，用于定位全局争用。' +
      '请求耗时为集群内部消息/锁的往返统计，非磁盘 IO。',
    maxRows: 200,
    // 真机（DMDSC 两节点，DM 8.1.5.60）核对：
    //   V$DSC_REQUEST_STATISTIC 实际列是 TYPE / TOTAL_REQUEST_COUNT / MIN_REQUEST_TIME /
    //   MAX_REQUEST_TIME / AVERAGE_REQUEST_TIME / TOTAL_REQUEST_TIME，
    //   原先写的 AVERAGE_RLOG_FLUSH_TIME 真机上不存在，直接报「无效的列名」。
    //   该视图每个 TYPE 只有一行（真机 33 行 = 33 个 TYPE），因此不需要 SUM/GROUP BY。
    //   单位：视图中为微秒——physical write 的 AVERAGE_REQUEST_TIME 真机实测 42772，
    //   按微秒计约 42.8ms（合理），按毫秒计则 42 秒（不可能）。故 /1000 换算为毫秒。
    //   MAX_REQUEST_TIME 在本版本恒为 0，仅作展示，不参与判定。
    sql: (ctx) => {
      const n = topLimit(ctx.options);
      return [
        `SELECT TYPE AS REQUESTTYPE,
                TOTAL_REQUEST_COUNT AS REQUESTCNT,
                ROUND(AVERAGE_REQUEST_TIME/1000.0, 2) AS AVG_MS,
                ROUND(MAX_REQUEST_TIME/1000.0, 2) AS MAX_MS,
                ROUND(TOTAL_REQUEST_TIME/1000.0, 2) AS TOTAL_MS
           FROM V$DSC_REQUEST_STATISTIC
          ORDER BY REQUESTCNT DESC
          LIMIT ${n}`,
        `SELECT TYPE AS REQUESTTYPE, TOTAL_REQUEST_COUNT AS REQUESTCNT, AVERAGE_REQUEST_TIME AS AVG_MS
           FROM V$DSC_REQUEST_STATISTIC`,
      ];
    },
    custom: async (ctx) => notApplicable('dsc', ctx) || ctx.queryTry(ctx.sql),
    rowLevel(row) {
      const t = num(row.AVG_MS);
      if (t === null) return null;
      // 阈值 100ms 告警、1000ms 严重：集群内部写请求要跨节点镜像到共享存储，
      // 几十毫秒在虚拟化环境下属常见（报告顶部的运行环境说明也会提示这点），
      // 只有到秒级才说明链路或共享存储确实出了问题。
      if (t > 1000) return 'crit';
      if (t > 100) return 'warn';
      return null;
    },
    evaluate: guarded((rows) => {
      if (!rows.length) return { level: 'info', message: '查询成功，但 V$DSC_REQUEST_STATISTIC 未返回数据行。' };
      // 列表按请求量排序（“高频”），但争用要看耗时，所以单独找出平均耗时最高的一类
      let worst = null;
      for (const r of rows) {
        const t = num(r.AVG_MS);
        if (t !== null && (!worst || t > num(worst.AVG_MS))) worst = r;
      }
      const total = rows.reduce((a, r) => a + (num(r.REQUESTCNT) || 0), 0);
      if (!worst) {
        return { level: 'info', message: `共 ${rows.length} 类集群请求，合计 ${total} 次。` };
      }
      const w = num(worst.AVG_MS);
      const detail = `请求量最大的 ${rows.length} 类合计 ${total} 次；其中平均耗时最高的是 ${worst.REQUESTTYPE}（${w} ms，${worst.REQUESTCNT} 次）`;
      if (w > 1000) {
        return {
          level: 'crit',
          message: `${detail}，已达秒级，请立即排查共享存储 IO 延迟与集群互联网络。`,
        };
      }
      if (w > 100) {
        return {
          level: 'warn',
          message: `${detail}，偏高，建议核对共享存储的 IO 延迟与集群互联网络。`,
        };
      }
      return { level: 'ok', message: `${detail}，耗时正常。` };
    }),
  },

  // ==================================================== 三、单实例补充项
  {
    id: 'log.instance_history',
    group: '日志与归档',
    title: '实例异常日志（V$INSTANCE_LOG_HISTORY）',
    desc:
      '直接从动态视图读取实例运行日志中的 ERROR / FATAL 记录，' +
      '无需访问服务器日志文件，跨主机部署时同样可用（比文件扫描更可靠）',
    maxRows: 100,
    sql: [
      `SELECT * FROM V$INSTANCE_LOG_HISTORY WHERE LEVEL$ IN ('ERROR','FATAL')`,
      `SELECT * FROM V$INSTANCE_LOG_HISTORY`,
    ],
    rowLevel(row) {
      const lv = String((row && (row['LEVEL$'] || row.LEVEL)) || '').toUpperCase();
      if (lv === 'FATAL') return 'crit';
      if (lv === 'ERROR') return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '实例日志历史中未发现 ERROR / FATAL 级记录。' };
      const lvOf = (r) => String((r && (r['LEVEL$'] || r.LEVEL)) || '').toUpperCase();
      const fatal = rows.filter((r) => lvOf(r) === 'FATAL');
      const errs = rows.filter((r) => lvOf(r) === 'ERROR');
      const detail = `实例日志历史中共 ${rows.length} 条异常记录：FATAL ${fatal.length} 条、ERROR ${errs.length} 条`;
      if (fatal.length) return { level: 'crit', message: detail + '，存在致命级错误，请立即排查。' };
      return { level: 'warn', message: detail + '，请结合下方明细排查。' };
    },
    advice: '本项走 V$INSTANCE_LOG_HISTORY 视图，不依赖服务器文件；若视图在某版本不存在，可参考「日志告警与错误检查」一项的文件扫描结果。',
  },
  {
    id: 'db.ckpt_history',
    group: '实例状态',
    title: '近期检查点信息',
    desc: '最近 10 次检查点的耗时与刷盘页数，用于判断磁盘 IO 能力是否成为瓶颈',
    maxRows: 10,
    sql: [
      `SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
              ROUND(TIME_USED/1000.0, 2) AS TIME_USED,
              PAGE_FLUSHED
         FROM V$CKPT_HISTORY ORDER BY START_TIME DESC LIMIT 10`,
      `SELECT * FROM V$CKPT_HISTORY`,
    ],
    rowLevel(row) {
      const t = num(row.TIME_USED);
      const p = num(row.PAGE_FLUSHED);
      if (t === null) return null;
      // 官方经验：刷盘 3000 页耗时超过 1000ms 说明磁盘写入能力不足（低于约 100MB/s）
      if (t > 3000) return 'crit';
      if (t > 1000 && p !== null && p >= 3000) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到检查点历史。' };
      const slow = rows.filter((r) => num(r.TIME_USED) > 1000 && (num(r.PAGE_FLUSHED) || 0) >= 3000);
      const worst = rows.reduce((a, r) => Math.max(a, num(r.TIME_USED) || 0), 0);
      if (slow.length) {
        return {
          level: 'warn',
          message: `有 ${slow.length}/${rows.length} 次检查点刷盘 ${rows[0].PAGE_FLUSHED} 页以上耗时超过 1000ms（最慢 ${worst}ms），磁盘写入能力可能不足。`,
        };
      }
      return { level: 'ok', message: `最近 ${rows.length} 次检查点，最慢耗时 ${worst}ms，磁盘 IO 表现正常。` };
    },
    advice: '参考标准：刷盘 3000 页耗时超过 1000ms，约等于写入带宽低于 100MB/s，建议检查磁盘性能或调整检查点参数。',
  },
  {
    id: 'mem.dict_cache',
    group: '内存与缓冲',
    title: '字典池使用情况',
    desc: '数据字典缓存使用率与 LRU 淘汰情况，使用率过高或存在淘汰说明字典缓存偏小',
    sql: [
      `SELECT ROUND(TOTAL_SIZE/1024.0/1024, 2) AS TOTAL_MB,
              ROUND(USED_SIZE/1024.0/1024, 2)  AS USED_MB,
              DICT_NUM,
              ROUND(SIZE_LRU_DISCARD/1024.0/1024, 2) AS DISCARD_MB,
              LRU_DISCARD,
              ROUND((USED_SIZE/1024.0/1024)/(TOTAL_SIZE/1024.0/1024)*100, 2) AS USED_PCT
         FROM V$DB_CACHE`,
      `SELECT * FROM V$DB_CACHE`,
    ],
    bars: { USED_PCT: { warn: 80, crit: 95 } },
    rowLevel(row) {
      const p = num(row.USED_PCT);
      const d = num(row.LRU_DISCARD);
      if (p !== null && p > 95) return 'crit';
      if ((p !== null && p > 80) || (d !== null && d > 0)) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到字典池（V$DB_CACHE）信息。' };
      const r = rows[0];
      const pct = num(r.USED_PCT);
      const disc = num(r.LRU_DISCARD);
      const head = `字典缓存 ${r.USED_MB}/${r.TOTAL_MB} MB（${pct === null ? '未知' : pct + '%'}），字典对象 ${r.DICT_NUM} 个`;
      if (pct !== null && pct > 95) {
        return { level: 'crit', message: `${head}，使用率过高，请调大 DICT_BUF_SIZE。` };
      }
      if (pct !== null && pct > 80) {
        return { level: 'warn', message: `${head}，使用率超过 80%，建议关注。` };
      }
      if (disc !== null && disc > 0) {
        return { level: 'warn', message: `${head}，但已发生 LRU 淘汰 ${disc} 次（淘汰 ${r.DISCARD_MB} MB），建议调大字典缓存。` };
      }
      return { level: 'ok', message: `${head}，使用率正常且无 LRU 淘汰。` };
    },
  },
  {
    id: 'db.sysevent',
    group: '实例状态',
    title: (o) => `全局等待事件 Top ${o.topN}`,
    desc: '累计等待次数与等待时间最长的等待事件，用于定位系统级瓶颈',
    maxRows: 200,
    sql: (ctx) => {
      const n = topLimit(ctx.options);
      return [
        `SELECT WAIT_CLASS, EVENT, TOTAL_WAITS, TIME_WAITED,
                TO_CHAR(ROUND(TIME_WAITED/NULLIF(TOTAL_WAITS,0), 2)) AS EVENT_WAIT_TIME
           FROM V$SYSTEM_EVENT ORDER BY 3 DESC, 4 DESC LIMIT ${n}`,
        `SELECT * FROM V$SYSTEM_EVENT`,
      ];
    },
    evaluate(rows) {
      // 同 instance.waitclass：evaluate 只在查询成功时被调用，空结果不能反推「视图不存在」
      if (!rows.length) return { level: 'info', message: '查询成功，但 V$SYSTEM_EVENT 未返回数据行。' };
      const top = rows[0];
      return {
        level: 'info',
        message: `等待次数最多的等待事件：${top.EVENT || '未知'}（等待类 ${top.WAIT_CLASS || '未知'}，累计 ${top.TOTAL_WAITS || 0} 次，平均 ${top.EVENT_WAIT_TIME || 0}）。`,
      };
    },
  },
  {
    id: 'obj.invalid_index',
    group: '对象与统计信息',
    title: '无效索引',
    desc: '状态非 VALID 的索引，会导致相关查询无法走索引甚至报错',
    maxRows: 100,
    sql: [
      `SELECT OWNER, INDEX_NAME, TABLE_NAME, INDEX_TYPE, STATUS
         FROM DBA_INDEXES
        WHERE STATUS != 'VALID' AND OWNER NOT IN (${SYS_OWNERS})
        ORDER BY OWNER, INDEX_NAME`,
    ],
    rowLevel() {
      return 'warn';
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '没有无效索引。' };
      if (rows.length > 5) {
        return { level: 'crit', message: `存在 ${rows.length} 个无效索引，请尽快重建。` };
      }
      return { level: 'warn', message: `存在 ${rows.length} 个无效索引：${rows.map((r) => r.OWNER + '.' + r.INDEX_NAME).join('、')}。` };
    },
    advice: '重建索引：ALTER INDEX "模式"."索引名" REBUILD;',
  },
  {
    id: 'obj.invalid_part_index',
    group: '对象与统计信息',
    title: '无效分区表全局索引',
    desc: '状态为 UNUSABLE 的分区/子分区索引，常见于分区维护后未重建索引',
    maxRows: 100,
    sql: [
      `SELECT * FROM (
         SELECT SCH_NAME, INDEX_NAME, PARTITION_NAME, SUBPARTITION_NAME, STATUS
           FROM DBA_IND_SUBPARTITIONS
         UNION
         SELECT SCH_NAME, INDEX_NAME, PARTITION_NAME, NULL AS SUBPARTITION_NAME, STATUS
           FROM DBA_IND_PARTITIONS
         UNION
         SELECT OWNER AS SCH_NAME, INDEX_NAME, NULL AS PARTITION_NAME, NULL AS SUBPARTITION_NAME, STATUS
           FROM DBA_INDEXES
       ) S
       WHERE S.STATUS = 'UNUSABLE' AND S.SCH_NAME NOT IN (${SYS_OWNERS})
       ORDER BY 1, 2`,
    ],
    rowLevel() {
      return 'warn';
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '没有 UNUSABLE 的分区索引。' };
      if (rows.length > 5) {
        return { level: 'crit', message: `存在 ${rows.length} 个 UNUSABLE 的分区索引，分区维护后可能未重建索引，请尽快处理。` };
      }
      return { level: 'warn', message: `存在 ${rows.length} 个 UNUSABLE 的分区索引。` };
    },
    advice: 'ALTER INDEX "模式"."索引名" REBUILD PARTITION "分区名";',
  },
  {
    id: 'obj.seq_usage',
    group: '对象与统计信息',
    title: '非循环序列使用率',
    desc: 'CYCLE_FLAG=N 的序列若接近 MAX_VALUE 将报错，使用率达到 70% 即告警',
    maxRows: 100,
    bars: { PEC_USED: { warn: 70, crit: 90 } },
    sql: [
      `SELECT * FROM (
         SELECT SEQUENCE_OWNER, SEQUENCE_NAME,
                ROUND(100 * (CASE WHEN INCREMENT_BY < 0
                                  THEN ABS(A.LAST_NUMBER - A.MAX_VALUE) * 1.0 / ABS(A.MAX_VALUE - MIN_VALUE)
                                  ELSE ABS(A.LAST_NUMBER - A.MIN_VALUE) * 1.0 / ABS(A.MAX_VALUE - MIN_VALUE)
                             END), 2) AS PEC_USED,
                MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, CACHE_SIZE, LAST_NUMBER
           FROM DBA_SEQUENCES A
          WHERE CYCLE_FLAG = 'N'
       ) WHERE PEC_USED >= 70
       ORDER BY PEC_USED DESC`,
    ],
    rowLevel(row) {
      const p = num(row.PEC_USED);
      if (p === null) return null;
      if (p >= 90) return 'crit';
      if (p >= 70) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '没有使用率超过 70% 的非循环序列。' };
      const bad = rows.filter((r) => num(r.PEC_USED) >= 90);
      const list = rows.map((r) => `${r.SEQUENCE_OWNER}.${r.SEQUENCE_NAME}(${r.PEC_USED}%)`).join('、');
      if (bad.length) {
        return { level: 'crit', message: `有 ${bad.length} 个非循环序列使用率超过 90%，即将耗尽并导致业务报错：${list}。` };
      }
      return { level: 'warn', message: `有 ${rows.length} 个非循环序列使用率超过 70%：${list}。` };
    },
    advice: '非循环（CYCLE_FLAG=N）序列耗尽后会报错，需提前调整 MAX_VALUE 或改为循环序列。',
  },
  {
    id: 'obj.frag_table',
    group: '对象与统计信息',
    title: (o) => `碎片表 Top ${o.topN}`,
    desc: '按碎片率排序的大表，碎片率过高应做表重组',
    maxRows: 200,
    bars: { FRAGPCT: { warn: 30, crit: 50 } },
    sql: (ctx) => {
      const n = topLimit(ctx.options);
      return [
        `SELECT OBJNAME, OBJTYPE, TO_CHAR(FRAGPCT) AS FRAGPCT FROM (
         SELECT * FROM (
           SELECT OWNER || '.' || TABLE_NAME AS OBJNAME,
                  'TABLE/TABLE PART' AS OBJTYPE,
                  ROUND(100.0 * (1 - TABLE_USED_PAGES(OWNER, TABLE_NAME) / 1.0
                                     / TABLE_USED_SPACE(OWNER, TABLE_NAME)), 2) AS FRAGPCT
             FROM DBA_TABLES
            WHERE TABLESPACE_NAME NOT IN ('TEMP','ROLL','SYSTEM')
              AND OWNER NOT IN (${SYS_OWNERS})
              AND TEMPORARY = 'N'
              AND TABLE_USED_SPACE(OWNER, TABLE_NAME) > (SELECT SUM(TOTAL_SIZE) * 0.0001 FROM V$DATAFILE)
            ORDER BY TABLE_USED_SPACE(OWNER, TABLE_NAME) DESC
            LIMIT ${n}
         ) ORDER BY FRAGPCT DESC
         LIMIT ${n}
       )`,
      ];
    },
    rowLevel(row) {
      const f = num(row.FRAGPCT);
      if (f === null) return null;
      if (f > 50) return 'crit';
      if (f > 30) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '未发现明显碎片的表（或该版本不支持 TABLE_USED_PAGES 函数）。' };
      const bad = rows.filter((r) => num(r.FRAGPCT) > 50);
      if (bad.length) {
        return { level: 'crit', message: `有 ${bad.length} 张表碎片率超过 50%：${bad.map((r) => r.OBJNAME + '(' + r.FRAGPCT + '%)').join('、')}。` };
      }
      const mid = rows.filter((r) => num(r.FRAGPCT) > 30);
      if (mid.length) return { level: 'warn', message: `有 ${mid.length} 张表碎片率超过 30%。` };
      return { level: 'info', message: `已列出碎片率最高的 ${rows.length} 张大表，均低于 30%。` };
    },
    advice: '表碎片整理：ALTER TABLE "模式"."表名" MOVE; 之后需重建该表上的索引。',
  },
  {
    id: 'db.sysstat',
    group: '实例状态',
    title: '运行统计概要（V$SYSSTAT）',
    desc: '事务、SQL、redo 等关键累计统计，用于快速掌握实例运行负载',
    maxRows: 60,
    sql: [
      `SELECT STAT_VAL, NAME FROM V$SYSSTAT
        WHERE NAME IN ('transaction total count','transaction commit count','transaction rollback count',
                       'transaction deadlock count','select statements','insert statements','update statements',
                       'delete statements','redo log size in bytes','transaction duration waits',
                       'transaction total time in sec')
        ORDER BY NAME`,
      `SELECT * FROM V$SYSSTAT`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到运行统计。' };
      const get = (n) => {
        const r = rows.find((x) => String(x.NAME || '').toLowerCase() === n);
        return r ? num(r.STAT_VAL) : null;
      };
      const total = get('transaction total count');
      const commit = get('transaction commit count');
      const rollback = get('transaction rollback count');
      const deadlock = get('transaction deadlock count');
      const msgs = [];
      if (total !== null) msgs.push(`总事务 ${total}`);
      if (commit !== null) msgs.push(`提交 ${commit}`);
      if (rollback !== null) msgs.push(`回滚 ${rollback}`);
      if (deadlock !== null) msgs.push(`死锁 ${deadlock}`);
      if (total && rollback !== null && rollback / total > 0.05) {
        return { level: 'warn', message: `${msgs.join('，')}。回滚事务占比 ${((rollback / total) * 100).toFixed(2)}%，偏高，请排查应用异常处理逻辑。` };
      }
      return { level: 'info', message: msgs.length ? msgs.join('，') + '。' : `已读取 ${rows.length} 项运行统计。` };
    },
  },
  {
    id: 'mem.design_size',
    group: '内存与缓冲',
    title: '内存设计大小（按参数估算）',
    desc: '按 dm.ini 中内存相关参数估算数据库的内存设计总量，用于与物理内存比对',
    display: 'kv',
    sql: [
      `SELECT 'INI_TOTAL_GB' AS ITEM, ROUND(SUM(PARA_VALUE)/1024, 2) AS VAL FROM (
         SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'BUFFER'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'KEEP'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'RECYCLE'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'SORT_BUF_GLOBAL_SIZE'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'HJ_BUF_GLOBAL_SIZE'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'HAGR_BUF_GLOBAL_SIZE'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'DICT_BUF_SIZE'
         UNION ALL SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'CACHE_POOL_SIZE'
       )`,
      `SELECT ROUND(SUM(PARA_VALUE)/1024, 2) AS INI_TOTAL_GB FROM V$DM_INI WHERE PARA_NAME IN ('BUFFER','MEMORY_POOL')`,
    ],
    evaluate(rows) {
      const v = num(first(rows, 'INI_TOTAL_GB') ?? first(rows, 'VAL'));
      if (v === null) return { level: 'info', message: '无法估算内存设计大小。' };
      return { level: 'info', message: `按参数估算的数据库内存设计总量约 ${v} GB（不含按会话数动态分配的池）。` };
    },
  },
  {
    id: 'db.param_diff',
    group: '基础信息',
    title: '与默认值不同的参数',
    desc: '列出被显式调整过（PARA_VALUE ≠ DEFAULT_VALUE）的参数，便于核对变更',
    maxRows: 200,
    sql: [
      `SELECT PARA_NAME, DEFAULT_VALUE, PARA_VALUE
         FROM V$DM_INI
        WHERE PARA_VALUE <> DEFAULT_VALUE
          AND PARA_NAME NOT IN ('AUD_PATH','DFS_PATH','CTL_PATH','CTL_BAK_PATH','SYSTEM_PATH',
                                'CONFIG_PATH','TEMP_PATH','BAK_PATH','WORKER_THREADS','TASK_THREADS',
                                'IO_THR_GROUPS','MAX_OS_MEMORY','MEMORY_POOL','MEMORY_N_POOLS',
                                'MEMORY_TARGET','BUFFER','BUFFER_POOLS','RECYCLE','RECYCLE_POOLS',
                                'FAST_POOL_PAGES','FAST_ROLL_PAGES','SORT_BUF_GLOBAL_SIZE',
                                'HJ_BUF_GLOBAL_SIZE','HAGR_BUF_GLOBAL_SIZE','CACHE_POOL_SIZE',
                                'DICT_BUF_SIZE','VM_POOL_TARGET','SESS_POOL_TARGET','MAX_SESSIONS')
        ORDER BY PARA_NAME`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '未发现与默认值不同的参数（内存/路径类参数已排除）。' };
      return { level: 'info', message: `有 ${rows.length} 个参数与默认值不同，请核对是否符合规划（内存、路径类参数已排除）。` };
    },
  },
];
