'use strict';
/*
 * DM8 巡检项定义
 * ---------------------------------------------------------------------------
 * 每个巡检项的结构：
 *   id        唯一标识
 *   group     所属分类（报告按分类分节）
 *   title     巡检项名称
 *   desc      巡检内容说明
 *   sql       字符串或字符串数组。数组表示“按顺序尝试”，
 *             用于兼容不同 DM8 小版本 / 不同权限下的视图差异。
 *   maxRows   最多取回行数（默认 200）
 *   evaluate  (rows) => { level, message }  判定规则；省略则记为“信息”
 *   rowLevel  (row)  => 'crit'|'warn'|null  逐行高亮（报告中标注危险行）
 *   advice    发现问题时的整改建议
 *
 * level 取值：crit(严重) / warn(警告) / ok(正常) / info(信息)
 *
 * 设计原则：达梦各小版本视图列名差异很大（尤其 V$ 视图），因此
 *   1) 尽量单表查询，避免复杂 JOIN 解析失败；
 *   2) 关键项提供多套 SQL 降级；
 *   3) 任何一项查询失败都不会中断整体巡检，只在报告中标注原因。
 *
 * 参考来源：达梦官方社区 eco.dameng.com、达梦《系统管理员手册》及大量 DBA 实战脚本。
 */

const os = require('node:os');
const { fmtBytes } = require('./osinfo');
const { scanLogs, scanLogsViaShell, collectLogDirs } = require('./logscan');
// 同机判定抽到独立模块，本文件与 oschecks-host.js 共用（避免循环依赖）
const { detectColocation } = require('./colocation');
// 日志检查复用 OS 检查同一条 shell 通道（本机 shell / SSH），避免重复建连。
// oschecks-host.js 只依赖 remote/colocation/osinfo，不反向依赖本文件，不会形成循环。
const { ensureShell, dbHostOsInfo } = require('./oschecks-host');
// 高级选项（表空间使用率阈值 / Top N）的取值与夹逼工具
const { topLimit } = require('./runtimeopts');
// SQL 指纹：区分「本工具自己跑的查询」与业务 SQL
const { isSelfSql } = require('./sqlsig');

/**
 * 后台线程分类规则。
 * 达梦的线程名随版本变化，这里用关键字归类，而不是按固定名称精确匹配；
 * 顺序即优先级（先匹配到的类别生效）。
 */
const THREAD_CLASSES = [
  { name: '归档线程', re: /ARCH/i },
  { name: '检查点线程', re: /CKPT|CHECKPOINT/i },
  { name: 'SQL 执行线程', re: /SQL|SESS|SERVICE/i },
  { name: '工作与任务线程', re: /WORKER|TASK|THREAD_POOL/i },
  { name: 'IO 线程', re: /(^|_)IO($|_)|IO_|_IO/i },
  { name: '事务与回滚线程', re: /TRX|TRANS|ROLL|UNDO/i },
  { name: '日志与刷盘线程', re: /LOG|REDO|FLUSH/i },
  { name: '定时与作业线程', re: /JOB|TIMER|SCHED/i },
  { name: '监控与统计线程', re: /MONITOR|STAT|AWR|AUDIT/i },
  { name: '通信线程', re: /MAL|NET|COMM|MSG|RPC/i },
  { name: '其他线程', re: /.*/ },
];

function classifyThread(name) {
  const s = String(name || '');
  for (const c of THREAD_CLASSES) {
    if (c.re.test(s)) return c.name;
  }
  return '其他线程';
}

/** 「长 SQL / SQL 历史 Top 耗时」默认阈值（毫秒），可在页面「高级选项」调整 */
const DEFAULT_SLOW_SQL_MS = 1000;
function slowSqlMs(ctx) {
  const v = ctx && ctx.options ? Number(ctx.options.slowSqlMs) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : DEFAULT_SLOW_SQL_MS;
}

/** 缓冲池类别：达梦的缓冲池按用途分为 NORMAL / KEEP / RECYCLE 等 */
function bufferPoolClass(name) {
  const n = String(name || '').trim().toUpperCase();
  if (!n) return '未命名池';
  if (/KEEP/.test(n)) return '常驻池（KEEP）';
  if (/RECYCLE/.test(n)) return '回收池（RECYCLE）';
  if (/NORMAL/.test(n)) return '常规池（NORMAL）';
  if (/FAST/.test(n)) return '快速池（FAST）';
  return n;
}

/** 内存池用途分类规则（顺序即优先级，先匹配到的类别生效） */
const MEM_POOL_CLASSES = [
  { name: 'SQL 与执行计划缓存', re: /SQL|PLAN|CURSOR|CACHE/i },
  { name: '数据字典缓存', re: /DICT/i },
  { name: '排序缓存', re: /SORT/i },
  { name: '哈希连接缓存', re: /HJ|HASH/i },
  { name: '聚合与分组缓存', re: /HAGR|AGG/i },
  { name: '虚拟机与表达式', re: /VM|VIRTUAL|EXPR/i },
  { name: '事务与回滚', re: /TRX|TRANS|ROLL|UNDO/i },
  { name: '备份与恢复', re: /BACKUP|RESTORE|BAK/i },
  { name: '监控与统计', re: /MONITOR|STAT|AWR/i },
  { name: '复制与同步', re: /REPL|SYNC|MAL/i },
  { name: '会话与连接', re: /SESS|CONN/i },
  { name: '临时与大对象', re: /TEMP|LOB|HUGE|MASSIVE/i },
  { name: '其他内存池', re: /.*/ },
];

function memPoolClass(name) {
  const n = String(name || '');
  for (const c of MEM_POOL_CLASSES) {
    if (c.re.test(n)) return c.name;
  }
  return '其他内存池';
}


const num = (v) => {  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 取第一行第一列的值 */
const first = (rows, key) => {
  if (!rows || !rows.length) return null;
  if (key === undefined) return Object.values(rows[0])[0];
  return rows[0][key];
};

const SYS_OWNERS =
  "'SYS','SYSDBA','SYSAUDITOR','SYSSSO','SYSJOB','SCHEDULER','CTISYS','SYSBO'";

/**
 * 达梦内置账号。
 * ---------------------------------------------------------------------------
 * 这些账号由实例创建时自动生成，它们的**状态与口令策略通常是安装默认值**，
 * 不代表用户配置出了问题；把它们和业务账号混在一起判定，会让刚装好的库一上手就报「严重」：
 *   - SYSSSO 是「安全管理员」，**企业版上本来就不可用**（需安全版），默认即 EXPIRED；
 *     真机核对（企业版 8.1.5.60）：SYSSSO 的 EXPIRY_DATE 为 NULL 且 PWD_LIFE_DAYS=0，
 *     说明这个 EXPIRED 不是「口令到期」造成的，而是建库时显式置成的初始状态。
 *     参考：达梦技术社区「企业版三权分立不能使用 syssso 用户吗」。
 *   - SYSSSO / SYSAUDITOR 属三权分立体系；SYS / SYSDBA 是必需账号，正常应为 OPEN。
 *
 * 因此：内置账号的非 OPEN 状态、以及口令永不过期，只做**提示**，不参与告警；
 *      业务账号的同类问题照旧判「严重 / 警告」。
 */
const DM_BUILTIN_USERS = [
  'SYS', 'SYSDBA', 'SYSAUDITOR', 'SYSSSO', 'SYSDBO', 'SYSJOB', 'SCHEDULER', 'CTISYS', 'SYSBO',
];
/**
 * 除内置账号外，达梦还有一些**由数据库自己创建**的账号，同样不属于业务账号：
 *   - AWR1 / AWR2 …：AWR（自动工作负载仓库）按节点创建的采集账号；
 *   - SYSAWR：DMDSC 上见到的 AWR 系统账号。
 * 真机原样：某企业版单实例上 PWD_LIFE_DAYS=0 的 5 个账号是
 *   AWR1 / SYS / SYSAUDITOR / SYSDBA / SYSSSO —— 全是这一类和内置账号，没有一个业务账号。
 * 把它们算进「业务账号口令永不过期」，会让新装的库一上手就报「不符合等保」。
 */
const isBuiltinUser = (name) => {
  const u = String(name == null ? '' : name).trim().toUpperCase();
  return DM_BUILTIN_USERS.includes(u) || u === 'SYSAWR' || /^AWR\d*$/.test(u);
};

/**
 * 把「已运行多少天」写成人能一眼看懂的话。
 * 真机踩过：「实例刚启动」显示成「约 0.0 小时」——因为 SQL 里 RUN_DAYS 只保留两位小数，
 * 7 分钟的实例四舍五入成 0.0 天，乘 24 还是 0.0。
 */
function fmtUptime(days, minutes) {
  const mins = minutes !== null && minutes !== undefined ? minutes : days === null ? null : days * 1440;
  if (mins === null) return '';
  // 先按「不足 1 分钟」判断再取整：0.5 分钟四舍五入会变成 1，就漏掉了这个分支
  if (mins < 1) return '不到 1 分钟';
  const m = Math.round(mins);
  if (m < 60) return `${m} 分钟`;
  if (m < 60 * 48) return `${(m / 60).toFixed(1)} 小时`;
  return `${Math.floor(m / 1440)} 天`;
}

/**
 * 把「本工具自己跑的查询」从慢 SQL 结果里区分出来。
 * ---------------------------------------------------------------------------
 * 为什么必须区分：巡检项「长 SQL 历史」「SQL 历史」读的是数据库的慢 SQL 记录，
 * 而本工具自己那条重查询（如 ts.segments 的 DBA_SEGMENTS 窗口函数）同样会进
 * V$SQL_HISTORY / V$LONG_EXEC_SQLS。不区分就会**自己告警自己**——真机实测报
 * 「共 2 条 SQL 超过 1000 毫秒」，两条全是本工具的查询，还建议 DBA 去优化它。
 *
 * 处理方式：**标出来但不删掉**。行照常列在表里（来源列写明「本工具巡检查询」），
 * 只是不计入告警判定与行级高亮——既不让 DBA 去优化一个工具查询，
 * 也不把事实藏起来（万一是误判，用户能在表里看到并核对）。
 */
const SELF_SQL_LABEL = '本工具巡检查询';
function markSelfSql(ctx, data, textCol) {
  const self = ctx && ctx.state && ctx.state.executedSql;
  const rows = (data.rows || []).map((row) => {
    const mine = isSelfSql(self, row[textCol]);
    return Object.assign({}, row, { SQL_SOURCE: mine ? SELF_SQL_LABEL : '' });
  });
  return {
    columns: (data.columns || []).concat(['SQL_SOURCE']),
    rows,
    rowCount: rows.length,
    meta: data.meta || null,
  };
}
/** 慢 SQL 检查的结论文案里统一带上「排除了几条本工具自身的查询」 */
function selfSqlNote(mine) {
  return mine.length ? `另有 ${mine.length} 条为本工具自身的巡检查询（来源列已标注），已排除、不计入告警。` : '';
}

/**
 * 计算缓冲池命中率（%）。
 * 不同 DM8 小版本 V$BUFFERPOOL 的口径不一致，这里按优先级兼容：
 *   1) N_LOGIC_READS / N_PHY_READS 现算（最可靠）
 *   2) RAT_HIT，可能是 0~1 的小数，也可能已是百分数
 */
function hitRatioOf(row) {
  const lr = num(row.N_LOGIC_READS);
  const pr = num(row.N_PHY_READS);
  if (lr !== null && pr !== null && lr + pr > 0) {
    return (1 - pr / (lr + pr)) * 100;
  }
  const h = num(row.RAT_HIT);
  if (h === null) return null;
  return h <= 1.0001 ? h * 100 : h;
}

// DM 把 MAXSIZE UNLIMITED 记作 67108863(MB)（在 V$DATAFILE.MAX_SIZE 与
// DBA_DATA_FILES.MAXBYTES/1MB 中一致，实测确认单位为 MB）
const DM_UNLIMITED_MB = 67108863;

/**
 * 判断数据文件「是否真的存在空间耗尽风险」。
 *
 * 只看「剩余 < 1GB」会产生误报：ROLL/TEMP 这类表空间按设计就只有 128MB，
 * 永远不可能有 1GB 剩余，但只要开启了自动扩展就不会写满。
 * 因此先判断增长能力——只有事实上已经无法再增长的文件才值得告警；
 * 能自动扩展的文件剩余空间少只意味着「即将触发一次扩展」，
 * 真正的磁盘水位风险由 os.disk 检查单独负责。
 */
function datafileGrowth(row) {
  const pick = (a, b) => (row[a] !== undefined && row[a] !== null ? row[a] : row[b]);
  const canExtend = /^(1|ON|YES|TRUE|Y)$/i.test(String(pick('AUTO_EXTEND', 'AUTOEXTENSIBLE') ?? '').trim());
  const totalMB = num(pick('TOTAL_MB', 'SIZE_MB'));
  const maxMB = num(pick('MAX_SIZE', 'MAX_MB'));
  const unlimited = maxMB === null || maxMB >= DM_UNLIMITED_MB;
  const atCeiling = !unlimited && totalMB !== null && maxMB !== null && totalMB >= maxMB;
  return {
    canGrow: canExtend && !atCeiling,
    frozen: !canExtend || atCeiling,
    atCeiling,
    totalMB,
    maxMB,
    usedPct: num(pick('USED_PCT', 'PCT_TO_MAX')),
    freeMB: num(pick('FREE_MB', 'FREE_MB')),
  };
}

const fileBase = (p) => String(p || '').split(/[\\/]/).pop();

/**
 * 作业子系统是否未安装。
 * ---------------------------------------------------------------------------
 * 达梦的定时作业依赖 SYSJOB 模式，但它并非每个实例都有：
 * 真机 DMDSC 两节点（DM 8.1.5.60）的 DBA_USERS 只有 SYS / SYSAUDITOR / SYSDBA / SYSSSO，
 * 没有 SYSJOB，直接查 SYSJOB.SYSJOBS 会报「无效的模式名[SYSJOB]」，整项变成「未取到」。
 * 这既不是权限问题也不是 SQL 写错，而是该实例没装作业子系统，应当如实说明。
 */
const JOB_MISSING_NOTE = '本实例未安装作业子系统（SYSJOB 模式不存在），因此没有 DM 定时作业可查。';

async function jobSubsystemMissing(ctx) {
  const r = await ctx.queryTry([
    `SELECT COUNT(*) AS CNT FROM DBA_USERS WHERE USERNAME = 'SYSJOB'`,
    `SELECT COUNT(*) AS CNT FROM SYS.SYSOBJECTS WHERE NAME = 'SYSJOB' AND TYPE$ = 'SCH'`,
  ]);
  if (!r || !r.rows.length) return false; // 连探测都做不了，就别拦，交给 SQL 自己报错
  return Number(r.rows[0].CNT) === 0;
}

// 本文件定义的基础巡检项（补充项在文件末尾统一合并与排序）
const BASE_CHECKS = [
  // ============================================ 〇、部署形态识别（最先执行）
  {
    id: 'basic.topology',
    group: '基础信息',
    title: '部署形态识别',
    desc:
      '识别当前实例属于单实例、数据守护集群还是共享存储集群（DMDSC）。' +
      '集群类巡检项会依据本项结果判断自身是否适用，不适用时明确标注「不适用」而非报错。',
    display: 'kv',
    custom: async (ctx) => {
      const t = { mode: '单实例', isDsc: false, isDw: false, evidence: [] };

      // 共享存储集群：优先用最典型的 V$DSC_EP_INFO，再退到 V$DCR_INFO
      const dsc = await ctx.queryTry([
        `SELECT COUNT(*) AS CNT FROM V$DSC_EP_INFO`,
        `SELECT COUNT(*) AS CNT FROM V$DCR_INFO`,
      ]);
      if (dsc && dsc.rows.length && (num(dsc.rows[0].CNT) || 0) > 0) {
        t.isDsc = true;
        t.evidence.push('V$DSC_EP_INFO / V$DCR_INFO 可查询且有记录');
      }

      // 数据守护：V$RAPPLY_SYS 为守护专有；V$ARCH_SEND_INFO 在开启守护后才有记录
      const dw1 = await ctx.queryTry([`SELECT COUNT(*) AS CNT FROM V$RAPPLY_SYS`]);
      const dw2 = await ctx.queryTry([`SELECT COUNT(*) AS CNT FROM V$ARCH_SEND_INFO`]);
      const dwCnt = (dw1 ? num(dw1.rows[0] && dw1.rows[0].CNT) || 0 : 0) + (dw2 ? num(dw2.rows[0] && dw2.rows[0].CNT) || 0 : 0);
      if (dwCnt > 0) {
        t.isDw = true;
        t.evidence.push('V$RAPPLY_SYS / V$ARCH_SEND_INFO 可查询且有记录');
      }

      if (t.isDsc && t.isDw) t.mode = '共享存储集群（DMDSC）+ 数据守护';
      else if (t.isDsc) t.mode = '共享存储集群（DMDSC）';
      else if (t.isDw) t.mode = '数据守护集群（主备）';

      ctx.state.topology = t;

      return {
        columns: ['DEPLOY_MODE', 'IS_DSC', 'IS_DW', 'EVIDENCE', 'SCOPE_NOTE'],
        rows: [
          {
            DEPLOY_MODE: t.mode,
            IS_DSC: t.isDsc ? '是' : '否',
            IS_DW: t.isDw ? '是' : '否',
            EVIDENCE: t.evidence.join('；') || '未发现集群特征视图',
            SCOPE_NOTE:
              t.mode === '单实例'
                ? '按单实例执行全部巡检项。'
                : '已按集群形态执行对应巡检项；单实例类指标仍仅反映当前所连节点。',
          },
        ],
        rowCount: 1,
        meta: t,
      };
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未能识别部署形态。' };
      const r = rows[0];
      const mode = String(r.DEPLOY_MODE || '');
      if (mode === '单实例') {
        return { level: 'info', message: `部署形态：单实例。${r.EVIDENCE}。` };
      }
      return { level: 'info', message: `部署形态：${mode}。判定依据：${r.EVIDENCE}。集群类巡检项已相应启用。` };
    },
  },
  // ======================================================= 一、基础信息
  {
    id: 'basic.role',
    group: '基础信息',
    title: '实例角色（主库 / 备库 / 集群节点）',
    desc:
      '识别本实例在集群里的角色：数据守护的主库/备库、DMDSC 的节点编号与模式。' +
      '多节点巡检报告靠本项区分各节点，单实例下显示为「单实例」。',
    display: 'kv',
    custom: async (ctx) => {
      const t = (ctx.state && ctx.state.topology) || {};
      const inst = await ctx.queryTry([
        `SELECT INSTANCE_NAME, MODE$ AS MODE_TYPE, STATUS$ AS STATUS FROM V$INSTANCE`,
      ]);
      const r0 = inst && inst.rows.length ? inst.rows[0] : {};
      const instName = String(r0.INSTANCE_NAME || '').trim();
      const modeType = String(r0.MODE_TYPE || '').trim();
      const status = String(r0.STATUS || '').trim();

      const roles = [];
      const detail = [];

      if (t.isDsc) {
        const eps = await ctx.queryTry([
          `SELECT EP_NAME, EP_SEQNO, EP_MODE, EP_STATUS FROM V$DSC_EP_INFO`,
        ]);
        if (eps && eps.rows.length) {
          const me = eps.rows.find(
            (r) => String(r.EP_NAME || '').trim().toUpperCase() === instName.toUpperCase()
          );
          if (me) {
            roles.push(`共享集群节点 EP${me.EP_SEQNO}（${me.EP_MODE}）`);
            detail.push(
              `V$DSC_EP_INFO 中本实例为 EP${me.EP_SEQNO}，模式 ${me.EP_MODE}，状态 ${me.EP_STATUS}`
            );
          } else {
            roles.push('共享集群节点（未在 EP 列表中匹配到本实例名）');
          }
          const bad = eps.rows.filter((r) => !/OK|NORMAL|OPEN/i.test(String(r.EP_STATUS || '')));
          detail.push(`集群共 ${eps.rows.length} 个节点${bad.length ? `，其中 ${bad.length} 个状态异常` : '，状态均正常'}`);
        } else {
          detail.push('V$DSC_EP_INFO 无数据，无法确定节点编号');
        }
      }

      if (t.isDw) {
        const rap = await ctx.queryTry([`SELECT COUNT(*) AS CNT FROM V$RAPPLY_SYS`]);
        const snd = await ctx.queryTry([`SELECT COUNT(*) AS CNT FROM V$ARCH_SEND_INFO`]);
        const rapN = rap && rap.rows.length ? num(rap.rows[0].CNT) || 0 : 0;
        const sndN = snd && snd.rows.length ? num(snd.rows[0].CNT) || 0 : 0;
        if (rapN > 0) {
          roles.push('备库（正在重演日志）');
          detail.push(`V$RAPPLY_SYS 有 ${rapN} 条重演记录`);
        } else if (sndN > 0) {
          roles.push('主库（正在发送归档）');
          detail.push(`V$ARCH_SEND_INFO 有 ${sndN} 条发送记录`);
        } else {
          detail.push('V$RAPPLY_SYS 与 V$ARCH_SEND_INFO 均无记录，暂无法判定主备角色');
        }
      }

      if (!roles.length) roles.push('单实例');

      const row = {
        ROLE: roles.join('，'),
        INSTANCE_NAME: instName || '未知',
        MODE_TYPE: modeType || '未知',
        STATUS: status || '未知',
        DETAIL: detail.join('；') || '未发现集群特征，按单实例处理',
      };
      return {
        columns: Object.keys(row),
        rows: [row],
        rowCount: 1,
        meta: { role: row.ROLE, instanceName: instName },
      };
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未能识别实例角色。' };
      const r = rows[0];
      return {
        level: 'info',
        message: `角色：${r.ROLE}。实例 ${r.INSTANCE_NAME}，运行模式 ${r.MODE_TYPE}，状态 ${r.STATUS}。${r.DETAIL}。`,
      };
    },
  },
  {
    id: 'basic.instance',
    group: '基础信息',
    title: '实例基本信息',
    desc: '实例名、数据库主机名、启动时间、状态（版本信息见「数据库版本与版本类型」一项；集群角色不在本工具范围）',
    display: 'kv',
    sql: [
      `SELECT INSTANCE_NAME, HOST_NAME,
              TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
              STATUS$ AS STATUS, MODE$ AS MODE_TYPE
         FROM V$INSTANCE`,
      `SELECT INSTANCE_NAME,
              TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
              STATUS$ AS STATUS
         FROM V$INSTANCE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'crit', message: '无法获取实例信息，实例可能异常。' };
      const r = rows[0];
      const host = r.HOST_NAME ? `，运行主机 ${r.HOST_NAME}` : '';
      return { level: 'info', message: `实例 ${r.INSTANCE_NAME || '未知'}${host}。` };
    },
  },
  {
    id: 'basic.build',
    group: '基础信息',
    title: '数据库版本与版本类型',
    desc: '从 ID_CODE 解析版本类型（企业版 / 安全版 / 标准版）与四位内核版本号',
    display: 'kv',
    sql: [
      // 由用户提供的脚本整理而来。原脚本最内层未指定数据来源、也未把 ID_CODE 投影到外层，
      // 而最外层却引用了 ID_CODE，在 DM 中会报「无效的标识符」。
      // 这里补上 V$INSTANCE 来源与 ID_CODE 透传，版本解析逻辑保持原样未改。
      `SELECT ID_CODE, BUILD_TYPE,
              TO_NUMBER(SUBSTR(VER,1,2),'XX')||'.'||
              TO_NUMBER(SUBSTR(VER,3,2),'XX')||'.'||
              TO_NUMBER(SUBSTR(VER,5,2),'XX')||'.'||
              TO_NUMBER(SUBSTR(VER,7,2),'XX') AS INNER_VERSION
         FROM (SELECT ID_CODE,
                      DECODE(SUBSTR(VER,1,2),'03','企业版','05','安全版','02','标准版','其他') AS BUILD_TYPE,
                      RAWTOHEX(CAST(SUBSTR(VER,3) AS INT)) AS VER
                 FROM (SELECT ID_CODE, REGEXP_SUBSTR(ID_CODE,'[^-]+',1,1) AS VER FROM V$INSTANCE))`,
      // 降级一：只解析版本类型，不做内核版本位运算
      `SELECT ID_CODE,
              DECODE(SUBSTR(REGEXP_SUBSTR(ID_CODE,'[^-]+',1,1),1,2),
                     '03','企业版','05','安全版','02','标准版','其他') AS BUILD_TYPE
         FROM V$INSTANCE`,
      // 降级二：取原始版本字段
      `SELECT ID_CODE, SVR_VERSION, DB_VERSION FROM V$INSTANCE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'warn', message: '无法解析数据库版本信息，请人工核对。' };
      const r = rows[0];
      const type = r.BUILD_TYPE === null || r.BUILD_TYPE === undefined ? '' : String(r.BUILD_TYPE).trim();
      const ver = r.INNER_VERSION === null || r.INNER_VERSION === undefined ? '' : String(r.INNER_VERSION).trim();
      if (type === '其他') {
        return {
          level: 'warn',
          message: `未能识别出版本类型（ID_CODE=${r.ID_CODE || '未知'}），请人工核对数据库版本是否符合采购与授权约定。`,
        };
      }
      const parts = [];
      if (type) parts.push(`版本类型 ${type}`);
      if (ver) parts.push(`内核版本 ${ver}`);
      if (r.ID_CODE) parts.push(`ID_CODE ${r.ID_CODE}`);
      if (!parts.length) return { level: 'info', message: '已获取版本字段，请人工核对。' };
      return { level: 'info', message: parts.join('，') + '。' };
    },
  },
  {
    id: 'basic.database',
    group: '基础信息',
    title: '数据库状态与归档模式',
    desc: '数据库打开状态、主备角色、归档模式、检查点时间',
    display: 'kv',
    sql: [
      `SELECT NAME AS DB_NAME,
              CASE STATUS$ WHEN 1 THEN 'STARTUP' WHEN 2 THEN 'STARTUP_REDO_DONE'
                           WHEN 3 THEN 'MOUNT' WHEN 4 THEN 'OPEN'
                           WHEN 5 THEN 'SUSPENDED' WHEN 6 THEN 'SHUTDOWN'
                           ELSE TO_CHAR(STATUS$) END AS DB_STATUS,
              CASE ROLE$ WHEN 0 THEN 'NORMAL' WHEN 1 THEN 'PRIMARY'
                         WHEN 2 THEN 'STANDBY' ELSE TO_CHAR(ROLE$) END AS DB_ROLE,
              CASE ARCH_MODE WHEN 'Y' THEN 'ARCHIVELOG' ELSE 'NOARCHIVELOG' END AS ARCH_MODE,
              TO_CHAR(LAST_CKPT_TIME,'YYYY-MM-DD HH24:MI:SS') AS LAST_CKPT_TIME,
              TO_CHAR(CREATE_TIME,'YYYY-MM-DD HH24:MI:SS') AS CREATE_TIME,
              DB_MAGIC
         FROM V$DATABASE`,
      `SELECT NAME AS DB_NAME, ARCH_MODE FROM V$DATABASE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'crit', message: '无法读取 V$DATABASE。' };
      const r = rows[0];
      const status = String(r.DB_STATUS || '');
      const arch = String(r.ARCH_MODE || '');
      if (status && status !== 'OPEN') {
        return { level: 'crit', message: `数据库当前状态为 ${status}，非 OPEN 状态，请立即检查。` };
      }
      if (arch === 'NOARCHIVELOG') {
        return {
          level: 'crit',
          message: '数据库处于非归档模式（NOARCHIVELOG）。生产库无法进行联机备份与时间点恢复，建议开启归档。',
        };
      }
      return { level: 'ok', message: `状态 ${status || 'OPEN'}，归档模式 ${arch || 'ARCHIVELOG'}。` };
    },
    advice: '非归档模式下只能做脱机备份，无法恢复到任意时间点；开启归档：编辑 dmarch.ini 并设置 ARCH_INI=1 后重启。',
  },
  {
    id: 'basic.uptime',
    group: '基础信息',
    title: '实例运行时长',
    desc: '根据启动时间计算已运行时长（不足一天时按分钟/小时显示，避免出现「约 0.0 小时」）',
    sql: [
      `SELECT INSTANCE_NAME,
              TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
              ROUND(SYSDATE - START_TIME, 2) AS RUN_DAYS,
              ROUND((SYSDATE - START_TIME) * 1440, 1) AS RUN_MINUTES
         FROM V$INSTANCE`,
    ],
    evaluate(rows) {
      const d = num(first(rows, 'RUN_DAYS'));
      const mins = num(first(rows, 'RUN_MINUTES'));
      if (d === null && mins === null) return { level: 'info', message: '无法解析运行时长。' };
      const text = fmtUptime(d, mins);
      if (d !== null && d < 1) {
        return { level: 'warn', message: `实例${d < 0.05 ? '刚刚' : '近期'}启动（约 ${text}），请确认是否为计划内重启。` };
      }
      if (d !== null && d > 30) {
        return { level: 'warn', message: `实例已连续运行 ${Math.floor(d)} 天，建议择机安排重启窗口。` };
      }
      return { level: 'ok', message: `已连续运行 ${d === null ? text : Math.floor(d) + ' 天'}。` };
    },
  },
  {
    id: 'basic.charset',
    group: '基础信息',
    title: '字符集 / 页大小 / 大小写敏感',
    desc: '建库时确定、事后不可更改的关键参数',
    display: 'kv',
    sql: [
      `SELECT SF_GET_UNICODE_FLAG() AS UNICODE_FLAG,
              SF_GET_CASE_SENSITIVE_FLAG() AS CASE_SENSITIVE,
              SF_GET_EXTENT_SIZE() AS EXTENT_SIZE,
              SF_GET_PAGE_SIZE() AS PAGE_SIZE_BYTES
         FROM DUAL`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '无法获取建库参数。' };
      const r = rows[0];
      const uf = num(r.UNICODE_FLAG);
      const cs = num(r.CASE_SENSITIVE);
      const page = num(r.PAGE_SIZE_BYTES);
      const charset = { 0: 'GB18030', 1: 'UTF-8', 2: 'EUC-KR' }[uf] || ('未知(' + uf + ')');
      const extra = page && page < 8192 ? ' 页大小小于 8K，大行/大表性能可能受限。' : '';
      return {
        level: page && page < 8192 ? 'warn' : 'info',
        message: `字符集 ${charset}，页大小 ${page} 字节，大小写${cs === 1 ? '敏感' : '不敏感'}，簇大小 ${r.EXTENT_SIZE}。${extra}`,
      };
    },
    advice: '页大小与字符集在数据库创建后不可修改，若与建库规范不符只能重建数据库。',
  },
  {
    id: 'basic.license',
    group: '基础信息',
    title: '授权（License）有效期',
    desc:
      '达梦授权到期后实例将无法启动，属于高风险项。' +
      '其中「授权版本范围」指授权文件允许的产品版本，不是当前运行的数据库版本' +
      '（后者见「数据库版本与版本类型」）；授权文件里写 X.X.x.x 属于通配，表示不限定具体小版本。',
    sql: [
      // 真机核对（DM 8.1.5.60，DMDSC 节点）：V$LICENSE.SERVER_VER 原值就是 "X.X.x.x"。
      // 这不是解析失败，是达梦授权文件自己的通配写法。直接原样展示会让人以为版本没取到，
      // 所以在 SQL 侧翻译一次，同时保留原值便于核对授权文件。
      `SELECT SERIES_NO, SERVER_SERIES, SERVER_TYPE,
              CASE WHEN UPPER(SERVER_VER) LIKE '%X%'
                   THEN '通配（授权文件为 ' || SERVER_VER || '）'
                   ELSE SERVER_VER END AS SERVER_VER,
              TO_CHAR(EXPIRED_DATE,'YYYY-MM-DD') AS EXPIRED_DATE,
              AUTHORIZED_CUSTOMER, MAX_CPU_NUM,
              ROUND(EXPIRED_DATE - SYSDATE) AS DAYS_LEFT
         FROM V$LICENSE`,
      `SELECT TO_CHAR(EXPIRED_DATE,'YYYY-MM-DD') AS EXPIRED_DATE,
              ROUND(EXPIRED_DATE - SYSDATE) AS DAYS_LEFT
         FROM V$LICENSE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未能读取授权信息（需要 SYSDBA/DBA 权限）。' };
      const d = num(first(rows, 'DAYS_LEFT'));
      const ver = String(first(rows, 'SERVER_VER') || '');
      // 授权版本是通配时补一句说明，避免读者把「授权版本」当成「数据库版本」
      const verNote = /X/i.test(ver)
        ? '（授权版本为通配，不限定具体小版本；当前实际运行的数据库版本见「数据库版本与版本类型」）'
        : '';
      if (d === null) return { level: 'info', message: '未解析到剩余天数，请人工核对授权到期时间。' };
      if (d < 0) return { level: 'crit', message: `授权已过期 ${Math.abs(d)} 天，实例存在无法启动的风险！${verNote}` };
      if (d < 30) return { level: 'crit', message: `授权仅剩 ${d} 天到期，请立即联系达梦续期。${verNote}` };
      if (d < 90) return { level: 'warn', message: `授权剩余 ${d} 天，请提前安排续期。${verNote}` };
      return { level: 'ok', message: `授权剩余 ${d} 天。${verNote}` };
    },
    advice: '授权到期后数据库实例将无法启动，务必在到期前完成授权更新。',
  },
  {
    id: 'basic.params',
    group: '基础信息',
    title: '关键运行参数快照',
    desc: '内存、会话、兼容性等核心初始化参数',
    maxRows: 100,
    sql: [
      // 参数名以真机 V$DM_INI 为准（真机核对：8.1.5.60 共 910 个参数）。
      // MAX_BUFFER_SIZE / MAX_MEMORY 不在其中，但保留着——它们是别的版本上的名字，
      // 取不到只是少一行快照，不会出错；同时补上真机确实存在的 BUFFER_POOLS / MEMORY_TARGET。
      `SELECT PARA_NAME, PARA_VALUE, FILE_VALUE
         FROM V$DM_INI
        WHERE PARA_NAME IN ('BUFFER','BUFFER_POOLS','MAX_BUFFER_SIZE','MAX_MEMORY','MEMORY_TARGET',
                            'MEMORY_POOL','SORT_BUF_SIZE','MAX_SESSIONS','MAX_CONCURRENT_TRX',
                            'COMPATIBLE_MODE','ENABLE_MONITOR','SVR_LOG','ENABLE_AUDIT',
                            'PWD_POLICY','GLOBAL_PAGE_SIZE','ARCH_INI','BAK_PATH')
        ORDER BY PARA_NAME`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '无法读取参数（需要 DBA 权限）。' };
      const diff = rows.filter((r) => String(r.PARA_VALUE) !== String(r.FILE_VALUE));
      if (diff.length) {
        return {
          level: 'warn',
          message: `有 ${diff.length} 个参数的内存值与配置文件值不一致（可能改过 dm.ini 但未重启，或运行时动态修改）。`,
        };
      }
      return { level: 'info', message: `已获取 ${rows.length} 个关键参数。` };
    },
    advice: '内存值与文件值不一致时，请确认是否预期；静态参数需重启实例才生效。',
  },

  // ======================================================= 二、实例状态
  // 注：「操作系统资源（V$SYSTEMINFO）」原在本分组，已移到「主机与资源」，
  //     与基于 shell 采集的 OS 指标放在一起，避免同一份主机资源信息散落在两个分组。
  {
    id: 'instance.threads',
    group: '实例状态',
    title: '后台线程状态',
    desc: '按类别统计后台线程的数量与状态，并检查归档线程等关键线程是否存在（不逐条罗列线程）',
    maxRows: 40,
    sql: [
      `SELECT * FROM V$THREADS`,
      `SELECT NAME, THREAD_DESC FROM V$THREADS`,
    ],
    custom: async (ctx) => {
      const r = await ctx.queryTry([
        `SELECT * FROM V$THREADS`,
        `SELECT NAME, THREAD_DESC FROM V$THREADS`,
      ]);
      if (!r) throw new Error('V$THREADS 不可读（需要 DBA 或 VTI 权限）');
      if (!r.rows.length) {
        return { columns: ['THREAD_CLASS', 'CNT', 'THREADS', 'STATUS'], rows: [], rowCount: 0, meta: { total: 0 } };
      }

      // 不同版本的 V$THREADS 列不同，若有 STATUS/STATE 列就一并展示
      const statusCol = (r.columns || []).find((c) => /STATUS|STATE/i.test(c));

      // 归档是否开启，用于判断「没有归档线程」是不是问题
      let archOn = null;
      const db = await ctx.queryTry([`SELECT ARCH_MODE FROM V$DATABASE`]);
      if (db && db.rows.length) {
        archOn = String(db.rows[0].ARCH_MODE || '').trim().toUpperCase() === 'Y';
      }
      if (archOn === null) {
        const ai = await ctx.queryTry([`SELECT COUNT(*) AS CNT FROM V$DM_ARCH_INI`]);
        if (ai && ai.rows.length) archOn = Number(ai.rows[0].CNT) > 0;
      }

      const map = new Map();
      for (const t of r.rows) {
        const name = String(t.NAME || t.THREAD_DESC || '').trim();
        if (!name) continue;
        const cls = classifyThread(name);
        if (!map.has(cls)) map.set(cls, []);
        map.get(cls).push({ name, status: statusCol ? String(t[statusCol] || '').trim() : '' });
      }

      const out = [];
      for (const [cls, list] of map) {
        const shown =
          list.slice(0, 6).map((x) => x.name).join('、') + (list.length > 6 ? ` 等 ${list.length} 个` : '');
        const statuses = Array.from(new Set(list.map((x) => x.status).filter(Boolean)));
        out.push({
          THREAD_CLASS: cls,
          CNT: String(list.length),
          THREADS: shown,
          STATUS: statuses.length ? statuses.join(' / ') : '正常（存在即已启动）',
        });
      }
      out.sort((a, b) => Number(b.CNT) - Number(a.CNT));

      return {
        columns: ['THREAD_CLASS', 'CNT', 'THREADS', 'STATUS'],
        rows: out,
        rowCount: out.length,
        meta: {
          total: r.rows.length,
          archOn,
          hasArch: map.has('归档线程'),
          classCount: out.length,
        },
      };
    },
    evaluate(rows, data) {
      const meta = (data && data.meta) || {};
      if (!rows.length) return { level: 'crit', message: '未读取到任何后台线程，实例可能处于异常状态。' };
      if (meta.archOn === true && !meta.hasArch) {
        return {
          level: 'crit',
          message:
            `数据库已开启归档（ARCH_MODE=Y），但未发现归档线程，共 ${meta.total} 个线程。` +
            '归档写入可能已停滞，请检查归档目录是否可写、空间是否充足。',
        };
      }
      const detail = rows.map((r) => `${r.THREAD_CLASS} ${r.CNT} 个`).join('，');
      const archNote =
        meta.archOn === true
          ? '已开启归档且归档线程存在。'
          : meta.archOn === false
            ? '数据库未开启归档。'
            : '未能判定归档是否开启。';
      return {
        level: 'ok',
        message: `共 ${meta.total} 个后台线程，归为 ${rows.length} 类：${detail}。${archNote}`,
      };
    },
  },
  {
    id: 'instance.waitclass',
    group: '实例状态',
    title: '等待事件热点',
    desc: '累计等待次数最高的等待类，用于定位系统瓶颈',
    maxRows: 20,
    sql: [
      `SELECT CLASS_NAME, TOTAL_WAITS FROM V$WAIT_CLASS ORDER BY TOTAL_WAITS DESC`,
      `SELECT * FROM V$WAIT_CLASS`,
    ],
    evaluate(rows) {
      // 注意：evaluate 只在 SQL 执行成功时才会被调用（失败会走 error 分支），
      // 因此「rows 为空」只可能意味着「查询成功但视图里没有数据」，
      // 不能写成「视图可能不存在」——那与事实相反。
      if (!rows.length) return { level: 'info', message: '查询成功，但 V$WAIT_CLASS 未返回数据行。' };
      const top = rows[0];
      return { level: 'info', message: `等待次数最高的等待类：${top.CLASS_NAME || Object.values(top)[0]}。` };
    },
  },

  // ==================================================== 二·五、主机与资源
  // 说明：原先这里还有一项「数据库服务器 OS 指标（CPU / 内存 / 磁盘 IO）」，
  // 它采的 CPU 使用率/内存/磁盘容量/IOPS 与下面 os.cpu / os.mem / os.disk / os.io
  // 四项高度重复，已删除并把其中独有的指标（CPU 使用率、磁盘吞吐与 IOPS）
  // 并入那四项，避免同一台主机的主机信息在同一分组里出现两遍。
  {
    // 由数据库自身报告宿主机资源：不需要 shell 通道，任何情况下都可用，
    // 与后面基于 shell 采集的 OS 指标互为印证（前者是数据库视角，后者是操作系统视角）。
    id: 'instance.systeminfo',
    group: '主机与资源',
    title: '操作系统资源（数据库视角 V$SYSTEMINFO）',
    desc:
      '物理内存、磁盘空间、CPU 使用率（CPU 指标仅 Linux 有效）。数据来自数据库自身，' +
      '无需 shell 通道即可读取，因此是主机资源信息的兜底来源。',
    display: 'kv',
    bars: { DISK_FREE_PCT: { warn: 20, crit: 10, invert: true } },
    sql: [
      `SELECT ROUND(TOTAL_PHY_SIZE/1024/1024/1024,2) AS PHY_TOTAL_GB,
              ROUND(FREE_PHY_SIZE /1024/1024/1024,2) AS PHY_FREE_GB,
              ROUND(TOTAL_DISK_SIZE/1024/1024/1024,2) AS DISK_TOTAL_GB,
              ROUND(FREE_DISK_SIZE /1024/1024/1024,2) AS DISK_FREE_GB,
              ROUND(FREE_DISK_SIZE*100.0/NULLIF(TOTAL_DISK_SIZE,0),2) AS DISK_FREE_PCT,
              ROUND(CPU_USER_RATE,2)   AS CPU_USER_RATE,
              ROUND(CPU_SYSTEM_RATE,2) AS CPU_SYSTEM_RATE
         FROM V$SYSTEMINFO`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '查询成功，但 V$SYSTEMINFO 未返回数据行。' };
      const pct = num(first(rows, 'DISK_FREE_PCT'));
      const cpuU = num(first(rows, 'CPU_USER_RATE'));
      const cpuS = num(first(rows, 'CPU_SYSTEM_RATE'));
      const cpu = cpuU !== null && cpuS !== null ? cpuU + cpuS : null;
      const cpuText =
        cpu === null
          ? '未知（该平台下此指标无效）'
          : `用户态 ${cpuU.toFixed(2)}% / 系统态 ${cpuS.toFixed(2)}%（合计 ${cpu.toFixed(2)}%）`;
      if (pct !== null && pct < 10) {
        return { level: 'crit', message: `数据库所在磁盘剩余空间仅 ${pct}%，磁盘写满会导致数据库挂起！CPU 使用率：${cpuText}。` };
      }
      if (pct !== null && pct < 20) {
        return { level: 'warn', message: `数据库所在磁盘剩余空间 ${pct}%，请及时清理或扩容。CPU 使用率：${cpuText}。` };
      }
      if (cpu !== null && cpu > 90) {
        return { level: 'warn', message: `CPU 总使用率 ${cpu.toFixed(2)}%，持续高位请排查慢 SQL。` };
      }
      return { level: 'ok', message: `磁盘剩余 ${pct === null ? '未知' : pct + '%'}，CPU 使用率：${cpuText}。` };
    },
  },
  {
    id: 'res.params',
    group: '主机与资源',
    title: '资源使用与参数合理性分析',
    desc:
      '把数据库实际内存占用、OS 资源水位与 V$DM_INI 中的关键参数放在一起比对，' +
      '判断 CPU / 内存 / IO 相关参数设置是否合理。阈值均为通用经验值，需结合业务实际调整。',
    maxRows: 40,
    custom: async (ctx) => {
      const rows = [];
      const add = (ITEM, CURRENT, SUGGEST, RESULT) => rows.push({ ITEM, CURRENT, SUGGEST, RESULT });
      const na = (ITEM, SUGGEST, why) => add(ITEM, why || '未获取', SUGGEST, '未获取');

      // ---------- 1. 数据库主机 OS 资源（来自 V$SYSTEMINFO） ----------
      const sys = await ctx.queryTry([
        `SELECT ROUND(TOTAL_PHY_SIZE/1024/1024/1024,2) AS PHY_TOTAL_GB,
                ROUND(FREE_PHY_SIZE /1024/1024/1024,2) AS PHY_FREE_GB,
                ROUND(TOTAL_DISK_SIZE/1024/1024/1024,2) AS DISK_TOTAL_GB,
                ROUND(FREE_DISK_SIZE /1024/1024/1024,2) AS DISK_FREE_GB,
                ROUND(FREE_DISK_SIZE*100.0/NULLIF(TOTAL_DISK_SIZE,0),2) AS DISK_FREE_PCT
           FROM V$SYSTEMINFO`,
      ]);
      const s = sys && sys.rows.length ? sys.rows[0] : null;
      const phyTotalGB = s ? num(s.PHY_TOTAL_GB) : null;
      const diskFreePct = s ? num(s.DISK_FREE_PCT) : null;

      // ---------- 2. 数据库实际内存占用 ----------
      const mem = await ctx.queryTry([
        `SELECT (SELECT ROUND(SUM(TOTAL_SIZE)/1024/1024, 2) FROM V$MEM_POOL) AS MEMPOOL_MB,
                (SELECT ROUND(SUM(N_PAGES)*SF_GET_PAGE_SIZE()/1024/1024, 2) FROM V$BUFFERPOOL) AS BUFFER_MB`,
      ]);
      let dbMemMB = null;
      let mempoolMB = null;
      let bufferMB = null;
      if (mem && mem.rows.length) {
        mempoolMB = num(mem.rows[0].MEMPOOL_MB);
        bufferMB = num(mem.rows[0].BUFFER_MB);
        if (mempoolMB !== null || bufferMB !== null) dbMemMB = (mempoolMB || 0) + (bufferMB || 0);
      }

      // ---------- 3. 关键参数 ----------
      // 参数名随小版本变化很大，这里把**候选别名**一并查出来：
      // 某个名字取不到时，可以列出本版本里实际存在的相近参数，而不是只丢一句「未获取」。
      // 真机核对（企业版 8.1.5.60，V$DM_INI 共 910 个参数）：
      //   · 没有 MAX_MEMORY（内存类相近的有 MEMORY_TARGET / MAX_SESSION_MEMORY）
      //   · IO 线程组叫 IO_THR_GROUPS / HIO_THR_GROUPS（**不是** IO_THREADS —— 那是写错的）
      // 参数名审计脚本：tools/_audit-params.js（把代码里硬编码的名字全部对一遍真机）
      const ini = await ctx.queryTry([
        `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI
          WHERE PARA_NAME IN ('BUFFER','MAX_BUFFER_SIZE','MAX_MEMORY','MEMORY_POOL',
                              'SORT_BUF_SIZE','SORT_BUF_GLOBAL_SIZE','HJ_BUF_GLOBAL_SIZE',
                              'CACHE_POOL_SIZE','MAX_SESSIONS',
                              'WORKER_THREADS','TASK_THREADS','IO_THR_GROUPS','HIO_THR_GROUPS',
                              'MEMORY_TARGET','MAX_SESSION_MEMORY',
                              'MAX_SEC_ASYNC_THREADS','STHD_THREAD_NUM')`,
      ]);
      const p = {};
      if (ini) for (const r of ini.rows) p[String(r.PARA_NAME).toUpperCase()] = String(r.PARA_VALUE).trim();
      const g = (k) => (p[k] !== undefined ? num(p[k]) : null);
      /**
       * 某参数在本版本不存在时，列出**本版本实际存在**的相近参数供参考。
       * 只列「另有单独一行展示」之外的参数，避免和同表其它行重复。
       */
      const aliasHint = (names) => {
        const hit = names.filter((k) => p[k] !== undefined).map((k) => `${k}=${p[k]}`);
        return hit.length ? `；本版本相近参数：${hit.join('、')}` : '；本版本未发现相近参数';
      };

      // ---------- 4. 逐项分析 ----------
      // 4.1 数据库内存占物理内存的比例
      if (dbMemMB !== null && phyTotalGB) {
        const phyMB = phyTotalGB * 1024;
        const pct = (dbMemMB / phyMB) * 100;
        const cur = `${(dbMemMB / 1024).toFixed(2)} GB（内存池 ${mempoolMB}MB + 缓冲池 ${bufferMB}MB），占物理内存 ${pct.toFixed(1)}%`;
        const sug = '建议控制在物理内存的 50%~70%';
        let result = '合理';
        if (pct > 80) result = '偏大（易触发 OS OOM）';
        else if (pct > 70) result = '偏大';
        else if (pct < 20) result = '偏小（未充分利用内存）';
        add('数据库内存 / 物理内存', cur, sug, result);
      } else {
        na('数据库内存 / 物理内存', '建议控制在物理内存的 50%~70%', 'V$SYSTEMINFO 或内存池视图不可用');
      }

      // 4.2 物理内存剩余
      // 口径很重要：V$SYSTEMINFO.FREE_PHY_SIZE 对应 Linux 的 MemFree，
      // 而 MemFree **不含可回收的页缓存**，在健康机器上常年接近 0
      // （真机 DMDSC 节点：V$SYSTEMINFO 报空闲 0GB，而 /proc/meminfo 的 MemAvailable 还有 604MB）。
      // 直接拿它算剩余比例会得出「严重不足」的假警报。
      // 因此优先用 OS 侧（同机 /proc 或 shell）的「可用内存 MemAvailable」，
      // 只有拿不到时才退回 V$SYSTEMINFO，并明确标注口径差异、放宽阈值。
      const osi = await dbHostOsInfo(ctx, { sampleMs: 800 });
      const osTotal = osi && osi.memTotalBytes ? osi.memTotalBytes : null;
      const osAvail = osi && osi.memAvailableBytes !== null && osi.memAvailableBytes !== undefined ? osi.memAvailableBytes : null;
      if (osTotal && osAvail !== null) {
        const availPct = (osAvail / osTotal) * 100;
        add(
          '物理内存剩余',
          `${(osAvail / 1024 / 1024 / 1024).toFixed(2)} GB（${availPct.toFixed(1)}%，MemAvailable）`,
          '建议保留 20% 以上给操作系统与文件缓存',
          availPct < 10 ? '严重不足' : availPct < 20 ? '偏少' : '合理'
        );
      } else if (s && num(s.PHY_FREE_GB) !== null && phyTotalGB) {
        const freeGB = num(s.PHY_FREE_GB);
        const freePct = (freeGB / phyTotalGB) * 100;
        add(
          '物理内存剩余',
          `${freeGB} GB（${freePct.toFixed(1)}%，V$SYSTEMINFO 的 MemFree 口径，不含可回收缓存）`,
          '该口径不含页缓存，偏低属正常；需按 MemAvailable 判断',
          freePct < 2 ? '需结合 MemAvailable 复核' : '合理'
        );
      } else {
        na('物理内存剩余', '建议保留 20% 以上', 'V$SYSTEMINFO 与 OS 采集均不可用');
      }

      // 4.3 磁盘剩余
      if (diskFreePct !== null) {
        add(
          '数据库磁盘剩余空间',
          `${s.DISK_FREE_GB} GB / ${s.DISK_TOTAL_GB} GB（剩余 ${diskFreePct}%）`,
          '建议剩余 ≥20%；同时保证归档目录与备份目录有独立空间',
          diskFreePct < 10 ? '严重不足' : diskFreePct < 20 ? '偏少' : '合理'
        );
      } else {
        na('数据库磁盘剩余空间', '建议剩余 ≥20%', 'V$SYSTEMINFO 未返回磁盘信息');
      }

      // 4.4 MAX_MEMORY
      if (p.MAX_MEMORY !== undefined) {
        const v = g('MAX_MEMORY');
        add(
          'MAX_MEMORY（实例最大内存）',
          v === 0 ? '0（不限制）' : `${v} MB`,
          v === 0 ? '不限制时数据库可能持续增长，建议按业务峰值显式设定上限' : '不超过物理内存的 70%~80%',
          v === 0 ? '需关注（未设上限）' : phyTotalGB && v > phyTotalGB * 1024 * 0.8 ? '偏大' : '合理'
        );
      } else {
        na(
          'MAX_MEMORY（实例最大内存）',
          '建议按业务峰值显式设定；各小版本参数名不同，请直接核对 dm.ini',
          '本版本 V$DM_INI 未提供 MAX_MEMORY' + aliasHint(['MEMORY_TARGET', 'MAX_SESSION_MEMORY', 'MAX_BUFFER_SIZE'])
        );
      }

      // 4.5 MEMORY_POOL
      if (p.MEMORY_POOL !== undefined) {
        const v = g('MEMORY_POOL');
        let result = '合理';
        if (phyTotalGB && v !== null && v < (phyTotalGB * 1024) / 16) result = '偏小（可能影响排序/哈希）';
        add('MEMORY_POOL（内存池）', `${v} MB`, '经验值：不小于物理内存的 1/16；建议 512MB~4GB 起步', result);
      } else {
        na('MEMORY_POOL（内存池）', '经验值：不小于物理内存的 1/16', 'V$DM_INI 未返回该参数');
      }

      // 4.6 BUFFER
      if (p.BUFFER !== undefined) {
        const v = g('BUFFER');
        add(
          'BUFFER（数据缓冲区）',
          `${v} MB${bufferMB !== null ? `（当前缓冲池实际 ${bufferMB} MB）` : ''}`,
          'OLTP 场景建议为物理内存的 50% 左右；DM 动态缓冲管理下 BUFFER 显示很小属正常',
          '需结合缓冲池命中率判断'
        );
      } else {
        na('BUFFER（数据缓冲区）', '建议为物理内存的 50% 左右', 'V$DM_INI 未返回该参数');
      }

      // 4.7 排序/哈希等会话级内存
      if (p.SORT_BUF_SIZE !== undefined) {
        const v = g('SORT_BUF_SIZE');
        add(
          'SORT_BUF_SIZE（排序缓冲区）',
          `${v} MB`,
          'OLTP 建议 10~20MB；OLAP/报表库可适当加大',
          v !== null && v > 128 ? '偏大（高并发下内存放大）' : '合理'
        );
      } else {
        na('SORT_BUF_SIZE（排序缓冲区）', 'OLTP 建议 10~20MB', 'V$DM_INI 未返回该参数');
      }

      // 4.8 IO 线程组与 CPU 核数
      // 参数名更正：原先写的是 IO_THREADS / MAX_IO_THREADS —— 达梦**没有这两个参数**，
      // 真机（8.1.5.60）V$DM_INI 共 910 个参数，里面没有它们，导致这一行永远显示「未获取」。
      // 达梦真实的参数名是 IO_THR_GROUPS（普通 IO 线程组）与 HIO_THR_GROUPS（大表 IO 线程组）。
      const ioGroups = g('IO_THR_GROUPS');
      const hioGroups = g('HIO_THR_GROUPS');
      if (ioGroups !== null || hioGroups !== null) {
        const parts = [];
        if (ioGroups !== null) parts.push(`普通 IO 线程组 ${ioGroups}`);
        if (hioGroups !== null) parts.push(`大表 IO 线程组 ${hioGroups}`);
        if (s && num(s.CPU_CORE_NUM) !== null) parts.push(`CPU ${s.CPU_CORE_NUM} 核`);
        add(
          'IO_THR_GROUPS（IO 线程组）/ CPU 核数',
          parts.join('，'),
          'IO 线程组数不宜远超磁盘并发能力，也不宜过大导致上下文切换开销',
          '需结合磁盘 IOPS 实测判断'
        );
      } else {
        na(
          'IO_THR_GROUPS（IO 线程组）/ CPU 核数',
          'IO 线程组数应与磁盘并发能力匹配；各小版本参数名不同，请直接核对 dm.ini',
          '本版本 V$DM_INI 未提供 IO_THR_GROUPS' + aliasHint(['MAX_SEC_ASYNC_THREADS', 'STHD_THREAD_NUM'])
        );
      }

      // 4.9 工作线程
      if (p.WORKER_THREADS !== undefined || p.TASK_THREADS !== undefined) {
        const v = g('WORKER_THREADS') !== null ? g('WORKER_THREADS') : g('TASK_THREADS');
        add(
          'WORKER_THREADS（工作线程）',
          `${v}`,
          '建议与 CPU 核数同量级；过大反而增加上下文切换',
          '需结合并发会话数判断'
        );
      } else {
        na('WORKER_THREADS（工作线程）', '建议与 CPU 核数同量级', 'V$DM_INI 未返回该参数');
      }

      // 4.10 IO 实际压力：本机 /proc 采到的是工具所在主机的 IO，异机时与数据库无关，
      //      因此统一走 dbHostOsInfo —— 同机用本机，异机则通过 shell 通道到数据库服务器上采。
      const co = await detectColocation(ctx);
      const osInfo = await dbHostOsInfo(ctx, { sampleMs: 800 });
      if (osInfo && osInfo.io) {
        add(
          '数据库服务器磁盘 IO 实测',
          `读 ${fmtBytes(osInfo.io.readBytesPerSec)}/s（${osInfo.io.readIops.toFixed(0)} IOPS），` +
            `写 ${fmtBytes(osInfo.io.writeBytesPerSec)}/s（${osInfo.io.writeIops.toFixed(0)} IOPS）`,
          '若写 IOPS 长期接近磁盘上限，应优先排查 redo 切换频率与大批量写入',
          '供参考'
        );
      } else if (osInfo) {
        na('数据库服务器磁盘 IO 实测', '结合磁盘 IOPS 上限判断', '未采集到 /proc/diskstats');
      } else {
        na(
          '数据库服务器磁盘 IO 实测',
          '在上方「数据库服务器 OS 采集（SSH）」里填写 dmdba 账号与密码',
          `未采集：${co.reason}`
        );
      }

      return { columns: ['ITEM', 'CURRENT', 'SUGGEST', 'RESULT'], rows, rowCount: rows.length };
    },
    rowLevel(row) {
      const r = String(row.RESULT || '');
      if (/严重不足|偏大（易触发/.test(r)) return 'crit';
      if (/偏小|偏大|偏少|需关注/.test(r)) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未能完成资源与参数比对。' };
      const bad = rows.filter((r) => {
        const x = String(r.RESULT || '');
        return /严重不足|偏大|偏小|偏少|需关注/.test(x);
      });
      if (!bad.length) {
        const unknown = rows.filter((r) => String(r.RESULT) === '未获取').length;
        return {
          level: 'ok',
          message:
            `已完成 ${rows.length} 项资源与参数比对，未发现明显不合理项。` +
            (unknown ? `其中 ${unknown} 项因视图或参数名不可用未能判断。` : ''),
        };
      }
      const list = bad.map((r) => `${r.ITEM}【${r.RESULT}】`).join('、');
      const severe = bad.some((r) => /严重不足|易触发/.test(String(r.RESULT)));
      return {
        level: severe ? 'crit' : 'warn',
        message: `有 ${bad.length} 项资源/参数需要关注：${list}。详见下方分析表。`,
      };
    },
  },

  // =============================================== 三、表空间与数据文件
  {
    id: 'ts.usage',
    group: '表空间与数据文件',
    title: '表空间使用率',
    desc: '各表空间总大小、已用空间与使用率（核心告警项）',
    maxRows: 200,
    // 阈值可在「高级选项」里配置（默认告警 80%、严重 90%）；
    // 这里写成 (options) => 值的函数，报告里的进度条配色才会跟着用户配置走。
    bars: (o) => ({ USED_PCT: { warn: o.tsWarnPct, crit: o.tsCritPct } }),
    sql: [
      `SELECT d.TABLESPACE_NAME,
              ROUND(SUM(d.BYTES)/1024/1024, 2) AS TOTAL_MB,
              ROUND(SUM(d.BYTES - NVL(f.FREE_BYTES,0))/1024/1024, 2) AS USED_MB,
              ROUND(NVL(SUM(f.FREE_BYTES),0)/1024/1024, 2) AS FREE_MB,
              ROUND((SUM(d.BYTES)-NVL(SUM(f.FREE_BYTES),0))*100/SUM(d.BYTES), 2) AS USED_PCT
         FROM DBA_DATA_FILES d
         LEFT JOIN (SELECT TABLESPACE_NAME, SUM(BYTES) FREE_BYTES
                      FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) f
                ON d.TABLESPACE_NAME = f.TABLESPACE_NAME
        GROUP BY d.TABLESPACE_NAME
        ORDER BY USED_PCT DESC`,
      `SELECT TABLESPACE_NAME,
              ROUND(SUM(BYTES)/1024/1024, 2) AS TOTAL_MB
         FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME`,
    ],
    rowLevel(row, o) {
      const p = num(row.USED_PCT);
      if (p === null) return null;
      const warnPct = (o && o.tsWarnPct) || 80;
      const critPct = (o && o.tsCritPct) || 90;
      if (p >= critPct) return 'crit';
      if (p >= warnPct) return 'warn';
      return null;
    },
    evaluate(rows, data, ectx) {
      const o = (ectx && ectx.options) || {};
      const warnPct = o.tsWarnPct || 80;
      const critPct = o.tsCritPct || 90;
      if (!rows.length) return { level: 'info', message: '未读取到表空间数据文件信息。' };
      const critical = rows.filter((r) => num(r.USED_PCT) >= critPct);
      const warn = rows.filter((r) => {
        const p = num(r.USED_PCT);
        return p >= warnPct && p < critPct;
      });
      if (critical.length) {
        return {
          level: 'crit',
          message:
            `以下表空间使用率超过 ${critPct}%：` +
            critical.map((r) => `${r.TABLESPACE_NAME}(${r.USED_PCT}%)`).join('、') +
            '。表空间写满将直接导致业务写入失败。',
        };
      }
      if (warn.length) {
        return {
          level: 'warn',
          message: `以下表空间使用率超过 ${warnPct}%：` + warn.map((r) => `${r.TABLESPACE_NAME}(${r.USED_PCT}%)`).join('、') + '。',
        };
      }
      return { level: 'ok', message: `共 ${rows.length} 个表空间，使用率均在 ${warnPct}% 以下。` };
    },
    advice: '及时扩大数据文件或新增数据文件；ALTER TABLESPACE "名" ADD DATAFILE \'路径\' SIZE 1024 AUTOEXTEND ON;',
  },
  {
    id: 'ts.status',
    group: '表空间与数据文件',
    title: '表空间状态与类型',
    desc: '表空间是否 ONLINE，是否为临时表空间',
    maxRows: 200,
    sql: [
      `SELECT ID, NAME,
              CASE TYPE$ WHEN 1 THEN 'DB' WHEN 2 THEN 'TEMP' ELSE TO_CHAR(TYPE$) END AS TS_TYPE,
              CASE STATUS$ WHEN 0 THEN 'ONLINE' WHEN 1 THEN 'OFFLINE'
                           WHEN 2 THEN 'RES_OFFLINE' WHEN 3 THEN 'CORRUPT'
                           ELSE TO_CHAR(STATUS$) END AS TS_STATUS,
              ROUND(TOTAL_SIZE * SF_GET_PAGE_SIZE()/1024/1024, 2) AS TOTAL_MB,
              FILE_NUM
         FROM V$TABLESPACE ORDER BY ID`,
      `SELECT TABLESPACE_NAME AS NAME, STATUS AS TS_STATUS FROM DBA_TABLESPACES`,
    ],
    rowLevel(row) {
      const s = String(row.TS_STATUS || '');
      if (s === 'CORRUPT') return 'crit';
      if (s === 'OFFLINE' || s === 'RES_OFFLINE') return 'crit';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到表空间状态。' };
      const bad = rows.filter((r) => {
        const s = String(r.TS_STATUS || '');
        return s && s !== 'ONLINE' && s !== '1';
      });
      if (bad.length) {
        return {
          level: 'crit',
          message: '存在非 ONLINE 状态的表空间：' + bad.map((r) => `${r.NAME}(${r.TS_STATUS})`).join('、') + '，请立即检查。',
        };
      }
      return { level: 'ok', message: `共 ${rows.length} 个表空间，状态均正常。` };
    },
  },
  {
    id: 'ts.datafiles',
    group: '表空间与数据文件',
    title: '数据文件明细与自动扩展',
    desc: '文件路径、大小、是否自动扩展、距上限比例',
    maxRows: 300,
    // 「已达文件上限的比例」沿用同一组阈值（高级选项可配，默认 80/90）
    bars: (o) => ({ PCT_TO_MAX: { warn: o.tsWarnPct, crit: o.tsCritPct } }),
    sql: [
      `SELECT TABLESPACE_NAME, FILE_ID, FILE_NAME,
              ROUND(BYTES/1024/1024, 2) AS SIZE_MB,
              AUTOEXTENSIBLE,
              ROUND(MAXBYTES/1024/1024, 2) AS MAXSIZE_MB,
              ROUND((BYTES*100.0)/NULLIF(MAXBYTES,0), 2) AS PCT_TO_MAX,
              STATUS
         FROM DBA_DATA_FILES ORDER BY BYTES DESC`,
      `SELECT TABLESPACE_NAME, FILE_ID, FILE_NAME,
              ROUND(BYTES/1024/1024, 2) AS SIZE_MB
         FROM DBA_DATA_FILES ORDER BY BYTES DESC`,
    ],
    rowLevel(row, o) {
      const ae = String(row.AUTOEXTENSIBLE || '').toUpperCase();
      const p = num(row.PCT_TO_MAX);
      const warnPct = (o && o.tsWarnPct) || 80;
      const critPct = (o && o.tsCritPct) || 90;
      if (ae === 'NO' && p !== null && p >= critPct) return 'crit';
      if (ae === 'NO' && p !== null && p >= warnPct) return 'warn';
      return null;
    },
    evaluate(rows, data, ectx) {
      const o = (ectx && ectx.options) || {};
      const critPct = o.tsCritPct || 90;
      if (!rows.length) return { level: 'info', message: '未读取到数据文件信息。' };
      const risky = rows.filter((r) => {
        const ae = String(r.AUTOEXTENSIBLE || '').toUpperCase();
        const p = num(r.PCT_TO_MAX);
        return ae === 'NO' && p !== null && p >= critPct;
      });
      const noExt = rows.filter((r) => String(r.AUTOEXTENSIBLE || '').toUpperCase() === 'NO');
      if (risky.length) {
        return {
          level: 'crit',
          message:
            `以下数据文件未开启自动扩展且已达上限 ${critPct}% 以上：` +
            risky.map((r) => r.FILE_NAME).join('、'),
        };
      }
      if (noExt.length) {
        return { level: 'warn', message: `有 ${noExt.length}/${rows.length} 个数据文件未开启自动扩展，需人工关注容量。` };
      }
      return { level: 'ok', message: `共 ${rows.length} 个数据文件。` };
    },
    advice: 'ALTER TABLESPACE "名" DATAFILE \'路径\' AUTOEXTEND ON NEXT 128 MAXSIZE UNLIMITED;',
  },
  {
    id: 'ts.datafile_pages',
    group: '表空间与数据文件',
    title: '数据文件剩余空间（按页换算）',
    desc: 'V$DATAFILE 中 TOTAL_SIZE/FREE_SIZE 为页数，需乘以页大小',
    maxRows: 300,
    bars: (o) => ({ USED_PCT: { warn: o.tsWarnPct, crit: o.tsCritPct } }),
    sql: [
      `SELECT GROUP_ID AS TS_ID, PATH,
              ROUND(TOTAL_SIZE * PAGE/1024/1024, 2) AS TOTAL_MB,
              ROUND(FREE_SIZE  * PAGE/1024/1024, 2) AS FREE_MB,
              ROUND((TOTAL_SIZE - FREE_SIZE)*100.0/NULLIF(TOTAL_SIZE,0), 2) AS USED_PCT,
              AUTO_EXTEND, NEXT_SIZE, MAX_SIZE, STATUS$
         FROM V$DATAFILE ORDER BY USED_PCT DESC`,
      `SELECT PATH,
              ROUND(TOTAL_SIZE * SF_GET_PAGE_SIZE()/1024/1024, 2) AS TOTAL_MB,
              ROUND(FREE_SIZE  * SF_GET_PAGE_SIZE()/1024/1024, 2) AS FREE_MB
         FROM V$DATAFILE`,
    ],
    rowLevel(row, o) {
      const warnPct = (o && o.tsWarnPct) || 80;
      const critPct = (o && o.tsCritPct) || 90;
      const s = datafileGrowth(row);
      if (!s.frozen) return null;
      if (s.usedPct !== null && s.usedPct >= critPct) return 'crit';
      if (s.usedPct !== null && s.usedPct >= warnPct) return 'warn';
      // 与百分比无关的独立规则：已无法扩展且剩余空间不足 1GB，同样需要关注
      if (s.freeMB !== null && s.freeMB < 1024) return 'warn';
      return null;
    },
    evaluate(rows, data, ectx) {
      const o = (ectx && ectx.options) || {};
      const critPct = o.tsCritPct || 90;
      if (!rows.length) return { level: 'info', message: '未读取到数据文件页信息。' };
      const frozen = rows.filter((r) => datafileGrowth(r).frozen);
      const risky = frozen.filter((r) => {
        const u = datafileGrowth(r).usedPct;
        return u !== null && u >= critPct;
      });
      if (risky.length) {
        return {
          level: 'crit',
          message: `有 ${risky.length} 个数据文件已无法再扩展且使用率已达 ${critPct}%：${risky
            .map((r) => fileBase(r.PATH))
            .join('、')}，请立即扩容。`,
        };
      }
      const low = frozen.filter((r) => {
        const f = datafileGrowth(r).freeMB;
        return f !== null && f < 1024;
      });
      if (low.length) {
        return {
          level: 'warn',
          message: `有 ${low.length} 个数据文件无法自动扩展且剩余不足 1GB：${low
            .map((r) => fileBase(r.PATH))
            .join('、')}，请关注扩容。`,
        };
      }
      if (frozen.length) {
        return {
          level: 'warn',
          message: `有 ${frozen.length}/${rows.length} 个数据文件未开启自动扩展或已达上限（${frozen
            .map((r) => fileBase(r.PATH))
            .join('、')}），需人工关注容量。`,
        };
      }
      const growable = rows.filter((r) => datafileGrowth(r).canGrow).length;
      return {
        level: 'ok',
        message: `共 ${rows.length} 个数据文件，其中 ${growable} 个已开启自动扩展且未达上限，空间耗尽风险可控。`,
      };
    },
  },
  {
    id: 'ts.segments',
    group: '表空间与数据文件',
    title: (o) => `各表空间占用空间最大的对象 Top ${o.topN}`,
    desc: (o) =>
      `按表空间分组，列出每个表空间中占用空间最大的前 ${o.topN} 个对象，便于快速定位空间消耗大户`,
    maxRows: 3000,
    groupBy: 'TABLESPACE_NAME',
    groupTop: (o) => o.topN,
    // LIMIT 的条数来自「高级选项」，用 topLimit() 再校验一次必须是 5~50 的整数
    sql: (ctx) => {
      const n = topLimit(ctx.options);
      return [
        // 首选：用窗口函数在数据库端直接取每个表空间的 Top N，避免把全库段信息拉到客户端
        `SELECT TABLESPACE_NAME, OWNER, SEGMENT_NAME, SEGMENT_TYPE, SIZE_MB
         FROM (SELECT TABLESPACE_NAME, OWNER, SEGMENT_NAME, SEGMENT_TYPE,
                      ROUND(BYTES/1024/1024, 2) AS SIZE_MB,
                      ROW_NUMBER() OVER (PARTITION BY TABLESPACE_NAME ORDER BY BYTES DESC) AS RN
                 FROM DBA_SEGMENTS) T
        WHERE RN <= ${n}
        ORDER BY TABLESPACE_NAME, SIZE_MB DESC`,
        // 降级：窗口函数不可用时取回有序全量，由报告层按表空间分组截取前 N
        `SELECT TABLESPACE_NAME, OWNER, SEGMENT_NAME, SEGMENT_TYPE,
                ROUND(BYTES/1024/1024, 2) AS SIZE_MB
           FROM DBA_SEGMENTS
          ORDER BY TABLESPACE_NAME, BYTES DESC`,
      ];
    },
    rowLevel(row) {
      const s = num(row.SIZE_MB);
      if (s !== null && s > 51200) return 'crit';
      if (s !== null && s > 10240) return 'warn';
      return null;
    },
    evaluate(rows, data, ectx) {
      const o = (ectx && ectx.options) || {};
      if (!rows.length) return { level: 'info', message: '未读取到段信息。' };
      const tsSet = new Set(rows.map((r) => r.TABLESPACE_NAME).filter(Boolean));
      const big = rows.filter((r) => num(r.SIZE_MB) > 51200);
      const biggest = rows.reduce((a, r) => (num(r.SIZE_MB) > num(a.SIZE_MB) ? r : a), rows[0]);
      const head = `覆盖 ${tsSet.size} 个表空间共 ${rows.length} 个对象（每个表空间列出前 ${o.topN || 10}）`;
      const top = `最大对象 ${biggest.OWNER}.${biggest.SEGMENT_NAME}（${biggest.SIZE_MB}MB，位于 ${biggest.TABLESPACE_NAME}）`;
      if (big.length) {
        return {
          level: 'warn',
          message: `${head}；其中 ${big.length} 个对象超过 50GB，建议评估分区改造或历史数据归档。${top}。`,
        };
      }
      return { level: 'info', message: `${head}。${top}。` };
    },
  },

  // ======================================================= 四、日志与归档
  {
    id: 'log.redofiles',
    group: '日志与归档',
    title: '联机日志（redo）文件',
    desc: '日志文件数量、大小与路径，组数过少易频繁切换',
    maxRows: 100,
    sql: [
      `SELECT PATH, ROUND(RLOG_SIZE/1024/1024, 2) AS SIZE_MB FROM V$RLOGFILE`,
      `SELECT COUNT(*) AS REDO_FILE_CNT, ROUND(MIN(RLOG_SIZE)/1024/1024,2) AS MIN_SIZE_MB,
              ROUND(MAX(RLOG_SIZE)/1024/1024,2) AS MAX_SIZE_MB FROM V$RLOGFILE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到联机日志信息。' };
      const sizes = rows.map((r) => num(r.SIZE_MB)).filter((x) => x !== null);
      if (!sizes.length) {
        return { level: 'info', message: `共 ${num(first(rows, 'REDO_FILE_CNT')) || rows.length} 个 redo 文件。` };
      }
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      const msgs = [];
      let level = 'ok';
      if (rows.length < 3) {
        level = 'warn';
        msgs.push(`redo 日志组数仅 ${rows.length} 个，建议不少于 3 组`);
      }
      if (min < 256) {
        level = level === 'ok' ? 'warn' : level;
        msgs.push(`最小的日志文件仅 ${min}MB，容易频繁切换`);
      }
      if (max > min * 1.2) {
        level = level === 'ok' ? 'warn' : level;
        msgs.push(`日志文件大小不一致（${min}MB ~ ${max}MB）`);
      }
      return {
        level,
        message: msgs.length ? msgs.join('；') + '。' : `共 ${rows.length} 个 redo 文件，大小 ${min}MB，配置合理。`,
      };
    },
    advice: '增大日志文件或增加日志组：ALTER DATABASE ADD LOGFILE \'路径\' SIZE 512;',
  },
  {
    id: 'log.rlog',
    group: '日志与归档',
    title: 'Redo LSN 与检查点',
    desc: '当前 LSN、检查点 LSN 与当前日志序列号',
    display: 'kv',
    sql: [
      `SELECT CUR_LSN, CKPT_LSN, DB_MAGIC, NEXT_SEQ, CUR_FILE FROM V$RLOG`,
      `SELECT CUR_LSN, CKPT_LSN FROM V$RLOG`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到 V$RLOG。' };
      const cur = num(first(rows, 'CUR_LSN'));
      const ck = num(first(rows, 'CKPT_LSN'));
      if (cur !== null && ck !== null && cur - ck > 0) {
        const gapGB = (cur - ck) / 1024 / 1024 / 1024;
        if (gapGB > 8) {
          return { level: 'warn', message: `当前 LSN 与检查点 LSN 相差约 ${gapGB.toFixed(2)}GB，检查点推进偏慢，请关注 redo 增长。` };
        }
      }
      return { level: 'info', message: `当前日志序列号 ${first(rows, 'NEXT_SEQ') || '未知'}。` };
    },
  },
  {
    id: 'log.switch',
    group: '日志与归档',
    title: 'Redo 日志切换频率',
    desc: '按小时统计日志切换次数，过高说明日志偏小或写入量激增',
    maxRows: 48,
    sql: [
      `SELECT TO_CHAR(RECTIME,'YYYY-MM-DD HH24') AS LOG_HOUR, COUNT(*) AS SWITCH_CNT
         FROM V$LOG_HISTORY
        GROUP BY TO_CHAR(RECTIME,'YYYY-MM-DD HH24')
        ORDER BY LOG_HOUR DESC LIMIT 48`,
      `SELECT TO_CHAR(RECTIME,'YYYY-MM-DD HH24') AS LOG_HOUR, COUNT(*) AS SWITCH_CNT
         FROM V$LOG_HISTORY GROUP BY TO_CHAR(RECTIME,'YYYY-MM-DD HH24')`,
    ],
    rowLevel(row) {
      const c = num(row.SWITCH_CNT);
      if (c === null) return null;
      if (c > 20) return 'crit';
      if (c > 6) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '无日志切换历史（可能实例刚启动）。' };
      const cnts = rows.map((r) => num(r.SWITCH_CNT)).filter((x) => x !== null);
      const max = Math.max(...cnts);
      const avg = cnts.reduce((a, b) => a + b, 0) / cnts.length;
      if (max > 20) {
        return { level: 'crit', message: `单小时最大切换 ${max} 次，日志切换过于频繁，请增大 redo 日志文件。` };
      }
      if (avg > 6) {
        return { level: 'warn', message: `小时平均切换 ${avg.toFixed(1)} 次，建议关注 redo 日志容量。` };
      }
      return { level: 'ok', message: `小时平均切换 ${avg.toFixed(1)} 次，最大 ${max} 次，频率正常。` };
    },
  },
  {
    id: 'log.archini',
    group: '日志与归档',
    title: '归档配置',
    desc: '归档目标目录、单文件大小、归档空间上限',
    maxRows: 50,
    sql: [
      `SELECT ARCH_NAME, ARCH_TYPE, ARCH_DEST, ARCH_FILE_SIZE, ARCH_SPACE_LIMIT,
              ARCH_IS_VALID, ARCH_WAIT_APPLY, ARCH_INCOMING_PATH
         FROM V$DM_ARCH_INI`,
      `SELECT ARCH_NAME, ARCH_TYPE, ARCH_DEST, ARCH_IS_VALID FROM V$DM_ARCH_INI`,
    ],
    rowLevel(row) {
      const v = String(row.ARCH_IS_VALID || '').toUpperCase();
      if (v === 'N' || v === '0' || v === 'FALSE') return 'crit';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'warn', message: '未配置归档（V$DM_ARCH_INI 无记录），数据库可能未开启归档。' };
      const invalid = rows.filter((r) => {
        const v = String(r.ARCH_IS_VALID || '').toUpperCase();
        return v === 'N' || v === '0' || v === 'FALSE';
      });
      if (invalid.length) {
        return { level: 'crit', message: `有 ${invalid.length} 路归档配置无效：${invalid.map((r) => r.ARCH_NAME).join('、')}。` };
      }
      const noLimit = rows.filter((r) => num(r.ARCH_SPACE_LIMIT) === 0);
      const msg = `共 ${rows.length} 路归档配置，目标目录：${rows.map((r) => r.ARCH_DEST).filter(Boolean).join('、') || '未知'}。`;
      if (noLimit.length) {
        return {
          level: 'warn',
          message: msg + '归档空间上限为 0（不限制），需依靠操作系统磁盘监控，避免归档写满磁盘。',
        };
      }
      return { level: 'ok', message: msg };
    },
    advice: '归档目录所在磁盘务必纳入监控；ARCH_SPACE_LIMIT=0 表示不限制，磁盘写满会导致数据库挂起。',
  },
  {
    id: 'log.archstatus',
    group: '日志与归档',
    title: '归档状态',
    desc: '归档是否正常进行（该视图仅在主库查询有效）',
    maxRows: 50,
    sql: [`SELECT * FROM V$ARCH_STATUS`],
    evaluate(rows) {
      // evaluate 只在查询成功时被调用，因此这里不写「版本无此视图」这类臆测
      if (!rows.length) {
        return {
          level: 'info',
          message: '查询成功，但 V$ARCH_STATUS 未返回数据行。',
        };
      }
      return { level: 'info', message: `归档状态共 ${rows.length} 条记录，请结合 ARCH_* 列核对是否正常。` };
    },
  },
  {
    id: 'log.archfile',
    group: '日志与归档',
    title: '归档文件与归档量',
    desc: '按天统计归档文件数量与容量，用于容量预测',
    maxRows: 60,
    sql: [
      `SELECT TO_CHAR(CREATE_TIME,'YYYY-MM-DD') AS ARCH_DATE,
              COUNT(*) AS FILE_CNT,
              ROUND(SUM(LEN)/1024/1024/1024, 2) AS ARCH_GB
         FROM V$ARCH_FILE
        GROUP BY TO_CHAR(CREATE_TIME,'YYYY-MM-DD')
        ORDER BY ARCH_DATE DESC LIMIT 60`,
      `SELECT TO_CHAR(CREATE_TIME,'YYYY-MM-DD HH24:MI:SS') AS CREATE_TIME,
              PATH, ROUND(LEN/1024/1024, 2) AS ARCH_MB
         FROM V$ARCH_FILE ORDER BY CREATE_TIME DESC LIMIT 50`,
    ],
    evaluate(rows) {
      if (!rows.length) {
        return {
          level: 'info',
          message: '查询成功，但 V$ARCH_FILE 未返回数据行。',
        };
      }
      const gbs = rows.map((r) => num(r.ARCH_GB || r.ARCH_MB)).filter((x) => x !== null);
      if (!gbs.length) return { level: 'info', message: `共 ${rows.length} 条归档记录。` };
      const unit = rows[0].ARCH_GB !== undefined ? 'GB' : 'MB';
      return { level: 'info', message: `共 ${rows.length} 条归档记录，单条最大 ${Math.max(...gbs)}${unit}。` };
    },
  },
  {
    id: 'log.scan',
    group: '日志与归档',
    title: '日志告警与错误检查（本次启动以来）',
    desc:
      '达梦没有可查询错误日志的视图，本项直接扫描数据库服务器上的运行日志、SQL 日志与跟踪日志，' +
      '提取本次实例启动以来出现的 ERROR / WARNING / FATAL / 死锁 / 内存与磁盘不足等记录。' +
      '需要本工具能访问数据库服务器的日志目录：先走本机文件系统，读不到时自动改走 shell 通道' +
      '（与数据库同机时用本机 shell，跨主机时用 SSH 远程采集，dmdba 账号即可读到达梦自己的日志）。',
    maxRows: 200,
    sql: [
      `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI
        WHERE PARA_NAME LIKE '%PATH%' OR PARA_NAME LIKE '%LOG%'`,
    ],
    custom: async (ctx) => {
      // ---- 1. 实例名与启动时间（决定“本次启动以来”的范围） ----
      const inst = await ctx.queryTry([
        `SELECT INSTANCE_NAME, TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME FROM V$INSTANCE`,
      ]);
      const instName = inst && inst.rows.length ? inst.rows[0].INSTANCE_NAME : null;
      const startTime = inst && inst.rows.length ? inst.rows[0].START_TIME : null;

      // ---- 2. 从数据库初始化参数确定日志位置（不写死默认路径） ----
      // 达梦日志目录随版本、安装方式、是否自定义过 SYSTEM_PATH/CONFIG_PATH 而不同，
      // 因此这里把 V$DM_INI 里所有形如 *PATH* / *LOG* 的参数都取回来，交由 collectLogDirs 推导。
      const ini = await ctx.queryTry([
        `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI
          WHERE PARA_NAME LIKE '%PATH%' OR PARA_NAME LIKE '%LOG%'`,
        `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI
          WHERE PARA_NAME IN ('ERRORLOG_PATH','SYSTEM_PATH','LOG_PATH','CONFIG_PATH',
                              'SVR_LOG','SVR_LOG_NAME','LOG_SQL','AUDIT_PATH')`,
      ]);
      const pv = {};
      if (ini) {
        for (const r of ini.rows) pv[String(r.PARA_NAME).toUpperCase()] = String(r.PARA_VALUE || '').trim();
      }

      // ---- 3. 推导候选日志目录，并保留「哪个参数推出了哪个目录」的溯源信息 ----
      const derived = collectLogDirs(pv, { instanceName: instName });
      const dirs = derived.dirs;
      const pathSources = derived.sources;

      const scanOpts = { dirs, since: startTime, maxFiles: 12, maxEntries: 150 };

      // 先走本机文件系统：同机部署时最快，且不需要任何凭据。
      let res = scanLogs(scanOpts);
      let scanVia = res.ok ? 'local' : null;
      let shellNote = '';

      // 本机读不到时自动改走 shell 通道（SSH 或本机 shell）。
      // 达梦日志本来就归 dmdba 所有，dmdba 即可读取 —— 只要配置了远程采集就该能读到。
      // 早期版本只有本机通道，因此「填了 SSH 密码依然提示无权访问」，这里补上。
      if (!res.ok) {
        const sh = await ensureShell(ctx);
        if (sh) {
          const viaShell = await scanLogsViaShell(sh, scanOpts);
          if (viaShell && viaShell.ok) {
            res = viaShell;
            scanVia = 'shell';
          } else if (viaShell) {
            res = viaShell; // 保留更精确的原因（无权限 / 目录不存在）
            scanVia = 'shell';
          }
        } else if (ctx.state.hostShellReason) {
          shellNote = ctx.state.hostShellReason.message || '';
        }
      }

      const baseMeta = {
        dirs,
        pathSources,
        startTime,
        svrLog: pv.SVR_LOG === undefined ? null : pv.SVR_LOG,
        logParamCount: Object.keys(pv).length,
        scanVia,
      };

      // ---- 4. 两条通道都读不到：明确告知“未采集”，不误报为正常 ----
      if (!res.ok) {
        const srcText = pathSources.length
          ? `已按初始化参数推导出 ${pathSources.length} 个候选目录`
          : '未能从初始化参数中推导出任何日志目录';
        const denied = (res.deniedDirs || []).length;
        const findFail = (res.findFailed || []).length;
        let why;
        if (denied) {
          why =
            `其中 ${denied} 个目录存在但当前账号无读取权限，达梦日志目录通常归 dmdba 所有，` +
            '用 dmdba 账号或 root 读取即可。无权限目录：\n' +
            (res.deniedDirs || []).map((d) => '  · ' + d).join('\n');
        } else if (findFail) {
          why = `目录可读，但服务器上的 find 命令不支持 -printf，无法列出日志文件：\n${(res.findFailed || []).map((d) => '  · ' + d).join('\n')}`;
        } else {
          why = '这些目录在数据库服务器上均不存在。';
        }
        const shellText =
          scanVia === 'shell'
            ? '\n已通过 SSH 在数据库服务器上尝试过读取。'
            : shellNote
            ? `\n本机文件系统不可访问，且未能建立远程采集通道：${shellNote}`
            : '\n本机文件系统不可访问，且未配置远程采集（可在上方「数据库服务器 OS 采集（SSH）」中填写 dmdba 账号与密码）。';
        const candList = pathSources.length
          ? '\n候选目录及其来源：\n' + pathSources.map((x) => '  · ' + x).join('\n')
          : '';
        return {
          columns: ['SCAN_RESULT'],
          rows: [{ SCAN_RESULT: `未采集：${srcText}，均无法读取。${why}${shellText}${candList}` }],
          rowCount: 1,
          meta: Object.assign({ scanSkipped: true, deniedDirs: res.deniedDirs || [] }, baseMeta),
        };
      }

      const filesDesc = res.files.map((f) => `${f.name}(${f.sizeMB}MB)`).join('、') || '无';
      const scanMeta = Object.assign(
        { scannedFiles: res.scannedFiles, filesDesc, files: res.files, truncated: res.truncated },
        baseMeta
      );
      // ---- 4.5 目录可访问，但里面没有达梦命名的日志文件 ----
      // 不能当成「没有错误」，必须明确区分，否则会给出虚假的「一切正常」结论
      if (res.noMatch) {
        const skippedNote = res.genericSkippedCount
          ? `\n另有 ${res.genericSkippedCount} 个非达梦命名的文件已跳过，例如：\n  · ${res.genericSkipped[0]}`
          : '';
        return {
          columns: ['SCAN_RESULT'],
          rows: [
            {
              SCAN_RESULT:
                `未找到达梦命名的日志文件。已检查目录：\n${res.dirs.map((d) => '  · ' + d).join('\n')}${skippedNote}\n` +
                '可能原因：日志文件被改名、日志目录不在推导结果中、或实例尚未产生日志。' +
                '请人工确认日志实际位置。注意：这不代表「数据库没有错误」。',
            },
          ],
          rowCount: 1,
          meta: Object.assign({ noMatch: true, genericSkipped: res.genericSkipped }, scanMeta),
        };
      }

      // ---- 5. 无命中：返回空集，由 evaluate 给出结论 ----
      if (!res.entries.length) {
        return { columns: ['TIME', 'LEVEL', 'FILE', 'TEXT'], rows: [], rowCount: 0, meta: scanMeta };
      }

      const rows = res.entries.map((e) => ({
        TIME: e.time,
        LEVEL: e.levelName,
        FILE: e.file,
        TEXT: e.text,
      }));
      return { columns: ['TIME', 'LEVEL', 'FILE', 'TEXT'], rows, rowCount: rows.length, meta: scanMeta };
    },
    rowLevel(row) {
      const lv = String(row.LEVEL || '');
      if (lv === '致命' || lv === '严重' || lv === '死锁') return 'crit';
      if (lv === '错误' || lv === '告警') return 'warn';
      return null;
    },
    evaluate(rows, data) {
      const meta = (data && data.meta) || {};
      // 日志文件清单与「目录由哪个参数推导而来」都比较长，拼成一句话会糊成一团，
      // 这里改成换行 + 圆点的列表（报告侧用 white-space:pre-line 渲染）。
      const bullet = (title, items) =>
        items && items.length ? `\n${title}（${items.length} 项）：\n` + items.map((x) => '  · ' + x).join('\n') : '';
      const filesList = (meta.files || []).map((f) => `${f.name}　${f.sizeMB} MB${f.truncated ? '（已截断，只读尾部）' : ''}`);
      const srcList = meta.pathSources || [];

      if (meta.scanSkipped || meta.noMatch) {
        return { level: 'info', message: (rows[0] && rows[0].SCAN_RESULT) || '未采集日志。' };
      }
      const scope = meta.startTime ? `本次启动（${meta.startTime}）以来` : '日志文件尾部';
      const scanned = `已扫描 ${meta.scannedFiles || 0} 个日志文件`;
      const svrLogNote =
        meta.svrLog === '0' ? '\n注意：SVR_LOG=0，SQL 日志未开启，dmsql_*.log 不会有内容。' : '';
      const tail = bullet(scanned, filesList) + bullet('日志位置依据', srcList) + svrLogNote;
      if (!rows.length) {
        return {
          level: 'ok',
          message: `${scope}，未发现 ERROR / WARNING / FATAL 等告警与错误记录。${tail}`,
        };
      }
      const severe = rows.filter((r) => ['致命', '严重', '死锁'].includes(String(r.LEVEL)));
      const errs = rows.filter((r) => String(r.LEVEL) === '错误').length;
      const warns = rows.filter((r) => String(r.LEVEL) === '告警').length;
      const detail = `${scope}共发现 ${rows.length} 条记录：致命/严重/死锁 ${severe.length} 条、错误 ${errs} 条、告警 ${warns} 条。${tail}`;
      if (severe.length) {
        return { level: 'crit', message: detail + '\n存在致命或死锁类记录，请立即排查。' };
      }
      return { level: 'warn', message: detail };
    },
  },

  // ======================================================= 五、内存与缓冲
  {
    id: 'mem.bufferpool',
    group: '内存与缓冲',
    title: '缓冲池命中率（按类别汇总）',
    desc: '按缓冲池类别（NORMAL / KEEP / RECYCLE）汇总命中率与淘汰情况，并逐类给出结论，不逐池罗列原始计数',
    maxRows: 30,
    // 命中率越高越好，因此 warn/crit 是「低于」阈值；豁免类别带「（豁免）」后缀不会渲染成色条
    bars: { HIT_PCT: { warn: 95, crit: 90, invert: true } },
    sql: [
      `SELECT * FROM V$BUFFERPOOL`,
      `SELECT NAME, N_PAGES, N_LOGIC_READS, N_PHY_READS FROM V$BUFFERPOOL`,
    ],
    custom: async (ctx) => {
      const r = await ctx.queryTry([
        `SELECT * FROM V$BUFFERPOOL`,
        `SELECT NAME, N_PAGES, N_LOGIC_READS, N_PHY_READS FROM V$BUFFERPOOL`,
      ]);
      if (!r) throw new Error('V$BUFFERPOOL 不可读（需要 DBA 或 VTI 权限）');

      let pageSize = 8192;
      const ps = await ctx.queryTry([`SELECT SF_GET_PAGE_SIZE() AS PS FROM DUAL`]);
      if (ps && ps.rows.length) {
        const v = num(ps.rows[0].PS);
        if (v) pageSize = v;
      }

      const map = new Map();
      for (const row of r.rows) {
        const cls = bufferPoolClass(row.NAME);
        if (!map.has(cls)) map.set(cls, []);
        map.get(cls).push(row);
      }

      // ---------------------------------------------------------------------
      // 样本量闸门
      // 命中率是「本次启动以来」的**累计**比值，样本太小会被冷启动的物理读主导。
      // 真机实测（企业版 8.1.5.60 单实例，缓冲池 11×5545 页）：
      //   启动 7 分钟：NORMAL 2871 逻辑读 / 652 物理读 → 81.49% → 被判「严重」
      //   再过 5 分钟：NORMAL 29260 逻辑读 / 762 物理读 → 97.46%
      // 同一个库、同一个池，结论自己翻了个面 —— 问题在样本，不在库。
      // 所以读写次数低于 MIN_READS 时明确标注「样本不足，暂不判定」，
      // 既不报假警报，也不假装「均达标」（那是没判定，不是判定为达标）。
      // ---------------------------------------------------------------------
      const MIN_READS = 10000;
      let uptimeMin = null;
      const up = await ctx.queryTry([`SELECT ROUND((SYSDATE - START_TIME) * 1440) AS UP_MIN FROM V$INSTANCE`]);
      if (up && up.rows && up.rows.length) uptimeMin = num(up.rows[0].UP_MIN);
      const sampleNote = (reads) =>
        uptimeMin !== null && uptimeMin < 120
          ? `样本不足：实例启动约 ${Math.round(uptimeMin)} 分钟，缓冲池尚未预热，暂不判定`
          : `样本不足：本次启动以来仅 ${reads} 次读写，暂不判定`;

      const out = [];
      for (const [cls, list] of map) {
        const sum = (f) => list.reduce((a, x) => a + (num(x[f]) || 0), 0);
        const pages = sum('N_PAGES');
        const lr = sum('N_LOGIC_READS');
        const pr = sum('N_PHY_READS');
        const reads = lr + pr;
        const hit = reads > 0 ? (1 - pr / reads) * 100 : hitRatioOf(list[0]);
        const discard = list.some((x) => x.N_DISCARD64 !== undefined) ? sum('N_DISCARD64') : null;
        const freeAllZero = list.every((x) => x.FREE !== undefined && num(x.FREE) === 0);
        const noAccess = reads === 0;
        const exempt = /RECYCLE/i.test(cls);

        let verdict;
        if (noAccess) verdict = '正常（本次启动以来无读写访问）';
        else if (exempt) verdict = '设计上命中率偏低，不参与告警';
        else if (hit === null) verdict = '无法判定（缺少读写计数）';
        else if (reads < MIN_READS) verdict = sampleNote(reads);
        else if (hit < 90) verdict = '严重：命中率过低，建议加大 BUFFER 或优化 SQL';
        else if (hit < 95) verdict = '需关注：命中率低于 95%';
        else if (freeAllZero && discard !== null && discard > 0) verdict = '需关注：空闲页为 0 且存在淘汰，缓冲页不足';
        else verdict = '正常';

        out.push({
          POOL_CLASS: cls,
          POOL_CNT: String(list.length),
          BUFFER_MB: ((pages * pageSize) / 1024 / 1024).toFixed(2),
          N_LOGIC_READS: String(lr),
          N_PHY_READS: String(pr),
          // 无访问的池不显示 0%，避免看起来像命中率告警；豁免类别加后缀，也不会渲染成色条
          HIT_PCT: noAccess ? '无访问' : hit === null ? '' : exempt ? hit.toFixed(2) + '（豁免）' : hit.toFixed(2),
          DISCARD: discard === null ? '' : String(discard),
          VERDICT: verdict,
          _hit: hit === null ? 999 : hit,
        });
      }
      out.sort((a, b) => a._hit - b._hit);

      return {
        columns: [
          'POOL_CLASS', 'POOL_CNT', 'BUFFER_MB', 'N_LOGIC_READS', 'N_PHY_READS', 'HIT_PCT', 'DISCARD', 'VERDICT',
        ],
        rows: out,
        rowCount: out.length,
        meta: { totalPools: r.rows.length, pageSize, minReads: MIN_READS, uptimeMin },
      };
    },
    rowLevel(row) {
      const v = String(row.VERDICT || '');
      if (/严重/.test(v)) return 'crit';
      if (/需关注/.test(v)) return 'warn';
      return null;
    },
    evaluate(rows, data) {
      if (!rows.length) return { level: 'info', message: '未读取到缓冲池信息。' };
      const meta = (data && data.meta) || {};
      const minReads = meta.minReads || 10000;
      const list = rows.map((r) => `${r.POOL_CLASS} ${r.HIT_PCT}%`).join('，');
      const head = `共 ${meta.totalPools || rows.length} 个缓冲池，按用途归为 ${rows.length} 类：${list}`;
      const bad = rows.filter((r) => /严重|需关注/.test(String(r.VERDICT)));
      const thin = rows.filter((r) => /样本不足/.test(String(r.VERDICT)));
      const coldStart = meta.uptimeMin !== null && meta.uptimeMin !== undefined && meta.uptimeMin < 120;
      const thinNote = thin.length
        ? (coldStart ? `实例启动约 ${Math.round(meta.uptimeMin)} 分钟，缓冲池尚未预热。` : '') +
          `另有 ${thin.length} 类因读写次数太少（低于 ${minReads} 次）暂不判定：` +
          thin.map((r) => r.POOL_CLASS).join('、') +
          ' —— 命中率是本次启动以来的累计比值，冷启动阶段物理读占比偏高，此时下结论会得到假警报。'
        : '';
      if (!bad.length) {
        // 全部「样本不足」时不能说「均达标」——那是没判定，不是判定为达标
        if (thin.length) {
          return { level: 'info', message: `${head}。${thinNote}` };
        }
        return { level: 'ok', message: `${head}。各类命中率均达标。` };
      }
      const severe = bad.some((r) => /严重/.test(String(r.VERDICT)));
      const detail = bad
        .map((r) => r.POOL_CLASS + '：' + String(r.VERDICT).replace(/^(严重|需关注)：/, ''))
        .join('；');
      return {
        level: severe ? 'crit' : 'warn',
        message: `${head}。其中 ${bad.length} 类需要关注 —— ${detail}。${thinNote}`,
      };
    },
  },
  {
    id: 'mem.mempool',
    group: '内存与缓冲',
    title: '内存池使用情况（按用途汇总）',
    desc: '按内存池用途分类汇总占用与异常（池外扩展 / 使用备份池），并逐类给出结论，不逐池罗列',
    maxRows: 30,
    sql: [`SELECT * FROM V$MEM_POOL`],
    custom: async (ctx) => {
      const r = await ctx.queryTry([`SELECT * FROM V$MEM_POOL`, `SELECT NAME, TOTAL_SIZE FROM V$MEM_POOL`]);
      if (!r) throw new Error('V$MEM_POOL 不可读（需要 DBA 或 VTI 权限）');
      if (!r.rows.length) {
        return {
          columns: ['POOL_CLASS', 'POOL_CNT', 'TOTAL_MB', 'MAX_MB', 'BIGGEST_POOL', 'OVERFLOW_CNT', 'EXTEND_CNT', 'VERDICT'],
          rows: [],
          rowCount: 0,
          meta: { totalPools: 0 },
        };
      }

      const map = new Map();
      for (const row of r.rows) {
        const cls = memPoolClass(row.NAME);
        if (!map.has(cls)) map.set(cls, []);
        map.get(cls).push(row);
      }

      const out = [];
      for (const [cls, list] of map) {
        let totalBytes = 0;
        let maxRow = list[0];
        let maxBytes = -1;
        for (const x of list) {
          const b = num(x.TOTAL_SIZE) || 0;
          totalBytes += b;
          if (b > maxBytes) {
            maxBytes = b;
            maxRow = x;
          }
        }
        const overflow = list.filter((x) => /^(Y|1|TRUE)$/i.test(String(x.IS_OVERFLOW == null ? '' : x.IS_OVERFLOW).trim())).length;
        const extend = list.filter((x) => (num(x.N_EXTEND_EXCLUSIVE) || 0) > 0).length;

        let verdict = '正常';
        if (overflow) verdict = '严重：已使用备份池，系统内存极度紧张';
        else if (extend) verdict = '需关注：发生池外扩展（N_EXTEND_EXCLUSIVE>0），疑似内存泄漏';

        out.push({
          POOL_CLASS: cls,
          POOL_CNT: String(list.length),
          TOTAL_MB: (totalBytes / 1024 / 1024).toFixed(2),
          MAX_MB: ((maxBytes < 0 ? 0 : maxBytes) / 1024 / 1024).toFixed(2),
          BIGGEST_POOL: String(maxRow.NAME || ''),
          OVERFLOW_CNT: String(overflow),
          EXTEND_CNT: String(extend),
          VERDICT: verdict,
        });
      }
      out.sort((a, b) => Number(b.TOTAL_MB) - Number(a.TOTAL_MB));

      return {
        columns: ['POOL_CLASS', 'POOL_CNT', 'TOTAL_MB', 'MAX_MB', 'BIGGEST_POOL', 'OVERFLOW_CNT', 'EXTEND_CNT', 'VERDICT'],
        rows: out,
        rowCount: out.length,
        meta: { totalPools: r.rows.length },
      };
    },
    rowLevel(row) {
      const v = String(row.VERDICT || '');
      if (/严重/.test(v)) return 'crit';
      if (/需关注/.test(v)) return 'warn';
      return null;
    },
    evaluate(rows, data) {
      if (!rows.length) return { level: 'info', message: '未读取到内存池信息。' };
      const meta = (data && data.meta) || {};
      const overflow = rows.filter((r) => /严重/.test(String(r.VERDICT)));
      const extend = rows.filter((r) => /需关注/.test(String(r.VERDICT)));
      const head = `共 ${meta.totalPools || rows.length} 个内存池，按用途归为 ${rows.length} 类`;
      if (overflow.length) {
        return {
          level: 'crit',
          message: `${head}；${overflow.map((r) => r.POOL_CLASS).join('、')} 已使用备份池（IS_OVERFLOW），系统内存极度紧张，请立即处理。`,
        };
      }
      if (extend.length) {
        const cnt = extend.reduce((a, r) => a + (Number(r.EXTEND_CNT) || 0), 0);
        return {
          level: 'warn',
          message:
            `${head}；${extend.map((r) => r.POOL_CLASS).join('、')}发生过池外扩展（共 ${cnt} 个池），` +
            '需持续观察是否为内存泄漏。',
        };
      }
      return { level: 'ok', message: `${head}，均未发现池外扩展或备份池使用。` };
    },
    advice: 'N_EXTEND_EXCLUSIVE 长期大于 0 通常意味着内存泄漏，建议收集现场并联系达梦技术支持。',
  },
  {
    id: 'mem.total',
    group: '内存与缓冲',
    title: '数据库内存总量',
    desc: '内存池 + 缓冲池合计，应与物理内存匹配',
    display: 'kv',
    sql: [
      `SELECT (SELECT ROUND(SUM(TOTAL_SIZE)/1024/1024, 2) FROM V$MEM_POOL) AS MEMPOOL_MB,
              (SELECT ROUND(SUM(N_PAGES)*SF_GET_PAGE_SIZE()/1024/1024, 2) FROM V$BUFFERPOOL) AS BUFFER_MB,
              (SELECT ROUND(SUM(TOTAL_SIZE)/1024/1024, 2) FROM V$MEM_POOL)
            + (SELECT ROUND(SUM(N_PAGES)*SF_GET_PAGE_SIZE()/1024/1024, 2) FROM V$BUFFERPOOL) AS TOTAL_DB_MEM_MB
         FROM DUAL`,
    ],
    evaluate(rows) {
      const mb = num(first(rows, 'TOTAL_DB_MEM_MB'));
      if (mb === null) return { level: 'info', message: '无法计算数据库内存总量。' };
      return { level: 'info', message: `数据库内存合计约 ${(mb / 1024).toFixed(2)} GB（内存池 ${first(rows, 'MEMPOOL_MB')}MB + 缓冲池 ${first(rows, 'BUFFER_MB')}MB）。` };
    },
  },

  // ======================================================= 六、会话与连接
  {
    id: 'sess.summary',
    group: '会话与连接',
    title: '会话总数与状态分布',
    desc: '当前会话按 ACTIVE/IDLE/PENDING 等状态统计',
    display: 'kv',
    sql: [
      `SELECT COUNT(*) AS TOTAL_SESS,
              SUM(CASE WHEN STATE='ACTIVE'  THEN 1 ELSE 0 END) AS ACTIVE_SESS,
              SUM(CASE WHEN STATE='IDLE'    THEN 1 ELSE 0 END) AS IDLE_SESS,
              SUM(CASE WHEN STATE='PENDING' THEN 1 ELSE 0 END) AS PENDING_SESS,
              SUM(CASE WHEN STATE='FREEING' THEN 1 ELSE 0 END) AS FREEING_SESS
         FROM V$SESSIONS`,
      `SELECT STATE, COUNT(*) AS CNT FROM V$SESSIONS GROUP BY STATE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到会话信息（需要 VTI 或 DBA 权限）。' };
      const p = num(first(rows, 'PENDING_SESS'));
      if (p !== null && p > 10) {
        return { level: 'warn', message: `有 ${p} 个会话处于 PENDING 状态，可能触及 MAX_CONCURRENT_TRX 限流。` };
      }
      const total = num(first(rows, 'TOTAL_SESS'));
      if (total === null) return { level: 'info', message: `会话状态分布：${JSON.stringify(rows)}` };
      return {
        level: 'info',
        message: `当前会话总数 ${total}（活跃 ${first(rows, 'ACTIVE_SESS')}，空闲 ${first(rows, 'IDLE_SESS')}）。`,
      };
    },
  },
  {
    id: 'sess.maxratio',
    group: '会话与连接',
    title: '最大会话数使用率',
    desc: '当前会话数相对 MAX_SESSIONS 的占比，接近上限将无法建立新连接',
    display: 'kv',
    sql: [
      `SELECT (SELECT COUNT(*) FROM V$SESSIONS) AS CUR_SESS,
              SF_GET_PARA_VALUE(2,'MAX_SESSIONS') AS MAX_SESSIONS_MEM,
              SF_GET_PARA_VALUE(1,'MAX_SESSIONS') AS MAX_SESSIONS_FILE
         FROM DUAL`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到会话上限信息。' };
      const cur = num(first(rows, 'CUR_SESS'));
      const maxMem = num(first(rows, 'MAX_SESSIONS_MEM'));
      const maxFile = num(first(rows, 'MAX_SESSIONS_FILE'));
      if (cur === null || !maxMem) return { level: 'info', message: `当前会话数 ${cur}，最大会话数 ${maxMem}。` };
      const pct = (cur / maxMem) * 100;
      const drift = maxMem !== maxFile && maxFile ? `（注意：内存值 ${maxMem} 与文件值 ${maxFile} 不一致）` : '';
      if (pct >= 85) {
        return { level: 'crit', message: `会话使用率 ${pct.toFixed(1)}%（${cur}/${maxMem}），接近上限，随时可能拒绝新连接。${drift}` };
      }
      if (pct >= 60) {
        return { level: 'warn', message: `会话使用率 ${pct.toFixed(1)}%（${cur}/${maxMem}），偏高。${drift}` };
      }
      return { level: 'ok', message: `会话使用率 ${pct.toFixed(1)}%（${cur}/${maxMem}）。${drift}` };
    },
    advice: '定期清理空闲连接（连接池泄漏）；必要时调大 MAX_SESSIONS 并同步调整操作系统句柄限制。',
  },
  {
    id: 'sess.byapp',
    group: '会话与连接',
    title: '按用户 / 程序 / 客户端 IP 统计连接',
    desc: '识别连接来源分布与异常堆积',
    maxRows: 50,
    sql: [
      `SELECT USER_NAME, APPNAME, CLNT_IP, STATE, COUNT(*) AS CNT
         FROM V$SESSIONS
        GROUP BY USER_NAME, APPNAME, CLNT_IP, STATE
        ORDER BY CNT DESC LIMIT 50`,
      `SELECT USER_NAME, COUNT(*) AS CNT FROM V$SESSIONS GROUP BY USER_NAME ORDER BY CNT DESC LIMIT 50`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到连接分布。' };
      const total = rows.reduce((a, r) => a + (num(r.CNT) || 0), 0);
      const top = rows[0];
      const share = total ? ((num(top.CNT) / total) * 100).toFixed(1) : null;
      // 会话总数很少时（例如刚启动、只有巡检自己在连）谈「分布集中」没有意义，会变成误报
      if (share && Number(share) > 50 && total >= 5) {
        return {
          level: 'warn',
          message: `来源 ${top.USER_NAME}@${top.CLNT_IP || '-'}/${top.APPNAME || '-'} 占全部会话的 ${share}%，连接分布过于集中。`,
        };
      }
      return { level: 'info', message: `共 ${rows.length} 组连接来源，合计 ${total} 个会话。` };
    },
  },
  {
    id: 'sess.idletrx',
    group: '会话与连接',
    title: '空闲且持有事务的会话',
    desc: '会话空闲但事务未提交，是典型的锁阻塞源头（重点项）',
    maxRows: 50,
    sql: [
      `SELECT s.SESS_ID, s.USER_NAME, s.CLNT_IP, s.APPNAME, s.STATE,
              t.ID AS TRX_ID, t.STATUS AS TRX_STATUS,
              ROUND((SYSDATE - s.LAST_RECV_TIME)*86400) AS IDLE_SEC,
              SUBSTR(s.SQL_TEXT,1,200) AS SQL_TEXT,
              'SP_CLOSE_SESSION(' || s.SESS_ID || ');' AS KILL_SQL
         FROM V$SESSIONS s, V$TRX t
        WHERE s.TRX_ID = t.ID AND t.STATUS = 'ACTIVE' AND s.STATE = 'IDLE'
        ORDER BY IDLE_SEC DESC`,
      `SELECT s.SESS_ID, s.USER_NAME, s.CLNT_IP, s.STATE,
              ROUND((SYSDATE - s.LAST_RECV_TIME)*86400) AS IDLE_SEC,
              SUBSTR(s.SQL_TEXT,1,200) AS SQL_TEXT
         FROM V$SESSIONS s
        WHERE s.TRX_ID IS NOT NULL AND s.TRX_ID <> 0 AND s.STATE = 'IDLE'
        ORDER BY IDLE_SEC DESC`,
    ],
    rowLevel(row) {
      const s = num(row.IDLE_SEC);
      if (s === null) return null;
      if (s > 3600) return 'crit';
      if (s > 600) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '没有空闲持有事务的会话，状态良好。' };
      const severe = rows.filter((r) => num(r.IDLE_SEC) > 3600);
      if (severe.length) {
        return { level: 'crit', message: `有 ${severe.length} 个会话空闲超过 1 小时仍未提交事务（最长 ${severe[0].IDLE_SEC} 秒），极易造成锁阻塞，建议立即确认或杀掉。` };
      }
      return { level: 'warn', message: `有 ${rows.length} 个会话空闲且持有未提交事务，最长已空闲 ${rows[0].IDLE_SEC} 秒。` };
    },
    advice: '确认为应用忘记提交后，可用 SELECT 出的 KILL_SQL 执行 SP_CLOSE_SESSION(sess_id) 结束会话（生产执行前请与业务确认）。',
  },
  {
    id: 'sess.memtop',
    group: '会话与连接',
    title: (o) => `会话内存占用 Top ${o.topN}`,
    desc: '定位占用大量内存的会话（多为超大排序或大结果集）',
    maxRows: 200,
    sql: (ctx) => {
      const n = topLimit(ctx.options);
      return [
        `SELECT s.SESS_ID, s.USER_NAME, s.CLNT_IP, s.STATE,
                m.NAME AS MEM_POOL_NAME,
                ROUND(m.TOTAL_SIZE/1024/1024, 2) AS TOTAL_MB,
                SUBSTR(s.SQL_TEXT,1,200) AS SQL_TEXT
           FROM V$MEM_POOL m, V$SESSIONS s
          WHERE m.CREATOR = s.THRD_ID
          ORDER BY m.TOTAL_SIZE DESC LIMIT ${n}`,
        `SELECT SESS_ID, USER_NAME, STATE,
                ROUND(MEM_USED_BY_K/1024, 2) AS TOTAL_MB
           FROM V$SESSIONS ORDER BY MEM_USED_BY_K DESC LIMIT ${n}`,
      ];
    },
    rowLevel(row) {
      const m = num(row.TOTAL_MB);
      if (m === null) return null;
      if (m > 4096) return 'crit';
      if (m > 1024) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到会话内存占用。' };
      const big = rows.filter((r) => num(r.TOTAL_MB) > 1024);
      if (big.length) {
        return { level: 'warn', message: `有 ${big.length} 个会话内存占用超过 1GB，最大 ${big[0].TOTAL_MB}MB，请检查是否存在超大排序/批量操作。` };
      }
      return { level: 'ok', message: `会话内存占用正常，最大 ${rows[0].TOTAL_MB || '未知'}MB。` };
    },
  },

  // ======================================================= 七、锁与事务
  {
    id: 'lock.trxwait',
    group: '锁与事务',
    title: '锁等待（阻塞链）',
    desc: '当前存在的事务等待，直接反映阻塞情况（重点项）',
    maxRows: 50,
    sql: [
      `SELECT ID AS BLOCKED_TRX_ID, WAIT_FOR_ID AS HOLDING_TRX_ID,
              WAIT_TIME, THRD_ID
         FROM V$TRXWAIT ORDER BY WAIT_TIME DESC`,
      `SELECT COUNT(*) AS LOCK_WAIT_CNT FROM V$TRXWAIT`,
    ],
    rowLevel(row) {
      const w = num(row.WAIT_TIME);
      if (w === null) return null;
      if (w > 60) return 'crit';
      return 'warn';
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '当前没有锁等待，状态良好。' };
      const cnt = num(first(rows, 'LOCK_WAIT_CNT'));
      if (cnt !== null && rows.length === 1 && rows[0].BLOCKED_TRX_ID === undefined) {
        return cnt === 0
          ? { level: 'ok', message: '当前没有锁等待。' }
          : { level: 'warn', message: `当前有 ${cnt} 个事务正在等待锁。` };
      }
      const waits = rows.map((r) => num(r.WAIT_TIME)).filter((x) => x !== null);
      const max = waits.length ? Math.max(...waits) : null;
      if (max !== null && max > 60) {
        return { level: 'crit', message: `存在 ${rows.length} 个锁等待，最长已等待 ${max} 秒，请立即定位阻塞源会话！` };
      }
      return { level: 'warn', message: `存在 ${rows.length} 个锁等待${max !== null ? '，最长 ' + max + ' 秒' : ''}。` };
    },
    advice: '通过 V$TRXWAIT.WAIT_FOR_ID 找到阻塞源事务，再关联 V$SESSIONS 定位会话与 SQL。',
  },
  {
    id: 'lock.blocked',
    group: '锁与事务',
    title: '被阻塞的锁对象明细',
    desc: '列出当前处于阻塞状态的锁记录',
    maxRows: 50,
    sql: [
      `SELECT TRX_ID, TABLE_ID, LTYPE, BLOCKED, ROW_IDX, LMODE
         FROM V$LOCK WHERE BLOCKED = 1`,
      `SELECT * FROM V$LOCK WHERE BLOCKED = 1`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '没有处于阻塞状态的锁。' };
      return { level: 'warn', message: `有 ${rows.length} 条锁记录处于被阻塞状态，请结合 V$TRXWAIT 定位。` };
    },
  },
  {
    id: 'lock.trx',
    group: '锁与事务',
    title: '当前事务状态分布',
    desc: '按状态统计事务数量，关注 LOCK WAIT 与 ROLLING',
    maxRows: 30,
    sql: [
      `SELECT STATUS AS TRX_STATUS, COUNT(*) AS CNT FROM V$TRX GROUP BY STATUS ORDER BY CNT DESC`,
      `SELECT ID AS TRX_ID, SESS_ID, STATUS AS TRX_STATUS, ISOLATION, READ_ONLY FROM V$TRX`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '当前没有活跃事务。' };
      const map = {};
      for (const r of rows) {
        const k = r.TRX_STATUS;
        if (k !== undefined) map[k] = (map[k] || 0) + (num(r.CNT) || 1);
      }
      const lockWait = map['LOCK WAIT'] || 0;
      const rolling = map['ROLLING'] || 0;
      const desc = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('，');
      if (lockWait > 0) return { level: 'warn', message: `${lockWait} 个事务处于 LOCK WAIT 状态（${desc}）。` };
      if (rolling > 0) return { level: 'warn', message: `有 ${rolling} 个事务正在回滚（ROLLING），大事务回滚可能持续较久（${desc}）。` };
      return { level: 'info', message: `事务状态分布：${desc}。` };
    },
  },
  {
    id: 'lock.longtrx',
    group: '锁与事务',
    title: '长事务',
    desc: '长时间未结束的事务会膨胀 UNDO 并阻塞他人',
    maxRows: 30,
    sql: [
      `SELECT SESS_ID, TRX_ID, USER_NAME, CLNT_IP, STATE,
              ROUND((SYSDATE - LAST_RECV_TIME)*86400) AS IDLE_SEC,
              TO_CHAR(CREATE_TIME,'YYYY-MM-DD HH24:MI:SS') AS SESS_CREATE,
              SUBSTR(SQL_TEXT,1,200) AS SQL_TEXT
         FROM V$SESSIONS
        WHERE TRX_ID IS NOT NULL AND TRX_ID <> 0
        ORDER BY IDLE_SEC DESC LIMIT 30`,
    ],
    rowLevel(row) {
      const s = num(row.IDLE_SEC);
      if (s === null) return null;
      if (s > 1800) return 'crit';
      if (s > 300) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '当前没有未结束的事务。' };
      const long = rows.filter((r) => num(r.IDLE_SEC) > 1800);
      if (long.length) {
        return { level: 'crit', message: `有 ${long.length} 个事务持续超过 30 分钟未提交（最长 ${long[0].IDLE_SEC} 秒）。` };
      }
      const mid = rows.filter((r) => num(r.IDLE_SEC) > 300);
      if (mid.length) {
        return { level: 'warn', message: `有 ${mid.length} 个事务持续超过 5 分钟（最长 ${mid[0].IDLE_SEC} 秒）。` };
      }
      return { level: 'ok', message: `当前有 ${rows.length} 个未结束事务，持续时间均在 5 分钟以内。` };
    },
  },
  {
    id: 'lock.deadlock',
    group: '锁与事务',
    title: '历史死锁',
    desc: '死锁历史记录，反映应用并发逻辑问题（重点项）',
    maxRows: 50,
    sql: [
      `SELECT SEQNO, TRX_ID, SESS_ID, HAPPEN_TIME, SQL_TEXT, DEADLOCK_CYCLE
         FROM V$DEADLOCK_HISTORY ORDER BY HAPPEN_TIME DESC`,
      `SELECT COUNT(*) AS DEADLOCK_CNT FROM V$DEADLOCK_HISTORY`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '未发现死锁历史记录。' };
      const cnt = num(first(rows, 'DEADLOCK_CNT'));
      if (cnt !== null && rows.length === 1) {
        return cnt === 0
          ? { level: 'ok', message: '未发现死锁历史。' }
          : { level: 'warn', message: `历史死锁记录 ${cnt} 条。` };
      }
      if (rows.length >= 3) {
        return { level: 'crit', message: `历史死锁记录达 ${rows.length} 条，应用需增加重试机制并优化并发 SQL 的加锁顺序。` };
      }
      return { level: 'warn', message: `存在 ${rows.length} 条死锁记录，请分析 DEADLOCK_CYCLE 定位加锁环路。` };
    },
    advice: '死锁由达梦自动检测并回滚代价最小的事务，业务侧需捕获错误码 -6403 并实现重试。',
  },

  // ======================================================= 八、SQL 性能
  {
    id: 'sql.slow_now',
    group: 'SQL 性能',
    title: '当前运行中的慢 SQL',
    desc: '活跃会话中执行时间较长的语句（重点项）',
    maxRows: 30,
    sql: [
      `SELECT SESS_ID, USER_NAME, CLNT_IP, STATE,
              ROUND((SYSDATE - LAST_RECV_TIME)*86400) AS EXEC_SEC,
              SUBSTR(SQL_TEXT,1,300) AS SQL_TEXT,
              'SP_CLOSE_SESSION(' || SESS_ID || ');' AS KILL_SQL
         FROM V$SESSIONS
        WHERE STATE = 'ACTIVE' AND (SYSDATE - LAST_RECV_TIME)*86400 >= 5
        ORDER BY EXEC_SEC DESC`,
      `SELECT SESS_ID, USER_NAME, STATE, SUBSTR(SQL_TEXT,1,300) AS SQL_TEXT
         FROM V$SESSIONS WHERE STATE = 'ACTIVE'`,
    ],
    rowLevel(row) {
      const s = num(row.EXEC_SEC);
      if (s === null) return null;
      if (s > 60) return 'crit';
      if (s > 5) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '当前没有执行时间较长的活跃 SQL。' };
      const slow = rows.filter((r) => num(r.EXEC_SEC) > 60);
      if (slow.length) {
        return { level: 'crit', message: `有 ${slow.length} 条 SQL 已执行超过 60 秒（最长 ${slow[0].EXEC_SEC} 秒），请立即分析执行计划。` };
      }
      return { level: 'warn', message: `有 ${rows.length} 条 SQL 已执行超过 5 秒。` };
    },
    advice: '使用 ET(执行号) 或 DBMS_SQLTUNE 分析执行计划；确认为异常语句可用 SP_CLOSE_SESSION(sess_id) 中止。',
  },
  {
    id: 'sql.longexec',
    group: 'SQL 性能',
    title: '长 SQL 历史（超过阈值）',
    desc:
      '只列出执行耗时超过阈值的 SQL，按耗时倒序；阈值默认 1000 毫秒，可在「高级选项」调整。' +
      '来源 V$LONG_EXEC_SQLS / V$SYSTEM_LONG_EXEC_SQLS，需 ENABLE_MONITOR=1（EXEC_TIME 单位为毫秒）。' +
      '本工具自己跑的巡检查询也会出现在这类记录里，因此按 SQL 指纹把它们标注为「本工具巡检查询」并排除出告警（行仍然列出，便于核对）。',
    maxRows: 50,
    // sql 写成函数：按运行时的阈值动态生成，报告附录里展示的也是实际执行的那条
    sql: (ctx) => {
      const ms = slowSqlMs(ctx);
      return [
        `SELECT SQL_TEXT, EXEC_TIME, FINISH_TIME, N_RUNS
           FROM V$SYSTEM_LONG_EXEC_SQLS
          WHERE EXEC_TIME >= ${ms}
          ORDER BY EXEC_TIME DESC`,
        `SELECT SESS_ID, SQL_TEXT, EXEC_TIME, FINISH_TIME, N_RUNS, TRX_ID
           FROM V$LONG_EXEC_SQLS
          WHERE EXEC_TIME >= ${ms}
          ORDER BY EXEC_TIME DESC`,
      ];
    },
    custom: async (ctx) => {
      const r = await ctx.queryTry(ctx.sql);
      if (!r) throw new Error('V$LONG_EXEC_SQLS / V$SYSTEM_LONG_EXEC_SQLS 不可读（需 ENABLE_MONITOR=1）');
      return markSelfSql(ctx, r, 'SQL_TEXT');
    },
    rowLevel(row) {
      if (row.SQL_SOURCE) return null; // 本工具自己的查询不高亮
      const ms = num(row.EXEC_TIME);
      if (ms === null) return null;
      if (ms >= 10000) return 'crit';
      if (ms >= 3000) return 'warn';
      return null;
    },
    evaluate(rows, data, ectx) {
      const ms = slowSqlMs(ectx);
      const mine = rows.filter((r) => r.SQL_SOURCE);
      const biz = rows.filter((r) => !r.SQL_SOURCE);
      const note = selfSqlNote(mine);
      if (!biz.length) {
        return {
          level: 'ok',
          message: mine.length
            ? `超过阈值 ${ms} 毫秒的记录里只有本工具自身的巡检查询，共 ${mine.length} 条，已排除、不计入告警。`
            : `未发现执行耗时超过 ${ms} 毫秒的长 SQL。`,
        };
      }
      const worst = num(first(biz, 'EXEC_TIME'));
      const slowest = worst === null ? '未知' : (worst / 1000).toFixed(2) + ' 秒';
      const over10 = biz.filter((r) => (num(r.EXEC_TIME) || 0) >= 10000).length;
      const detail =
        `共 ${biz.length} 条 SQL 超过阈值 ${ms} 毫秒，最慢 ${slowest}` + (over10 ? `，其中 ${over10} 条超过 10 秒` : '');
      if (over10) return { level: 'crit', message: detail + '，需重点优化。' + note };
      return { level: 'warn', message: detail + '。' + note };
    },
    advice: '阈值可在网页「高级选项」中调整；用 ET(执行号) 或 DBMS_SQLTUNE 分析执行计划后再优化。',
  },
  {
    id: 'sql.history',
    group: 'SQL 性能',
    title: 'SQL 历史（超过阈值）',
    desc:
      '只列出耗时超过阈值的 SQL，按耗时倒序；阈值默认 1000 毫秒，可在「高级选项」调整。' +
      '来源 V$SQL_HISTORY，需 ENABLE_MONITOR=1（TIME_USED 单位为微秒）。' +
      '本工具自己跑的巡检查询同样会进这张历史表（包括以往几轮巡检留下的记录），因此按 SQL 指纹把它们标注为「本工具巡检查询」并排除出告警。',
    maxRows: 50,
    sql: (ctx) => {
      const us = slowSqlMs(ctx) * 1000; // 阈值按毫秒配置，而 TIME_USED 是微秒
      return [
        `SELECT SESS_ID, TRX_ID, TOP_SQL_TEXT AS SQL_TEXT, TIME_USED,
                AFFECTED_ROWS, N_LOGIC_READ, N_PHY_READ,
                TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME, IS_OVER
           FROM V$SQL_HISTORY
          WHERE TIME_USED >= ${us}
          ORDER BY TIME_USED DESC`,
        `SELECT SESS_ID, TOP_SQL_TEXT AS SQL_TEXT, TIME_USED
           FROM V$SQL_HISTORY
          WHERE TIME_USED >= ${us}
          ORDER BY TIME_USED DESC`,
      ];
    },
    custom: async (ctx) => {
      const r = await ctx.queryTry(ctx.sql);
      if (!r) throw new Error('V$SQL_HISTORY 不可读（需 ENABLE_MONITOR=1）');
      return markSelfSql(ctx, r, 'SQL_TEXT');
    },
    rowLevel(row) {
      if (row.SQL_SOURCE) return null; // 本工具自己的查询不高亮
      const t = num(row.TIME_USED);
      if (t === null) return null;
      if (t >= 10000000) return 'crit';
      if (t >= 3000000) return 'warn';
      return null;
    },
    evaluate(rows, data, ectx) {
      const ms = slowSqlMs(ectx);
      const mine = rows.filter((r) => r.SQL_SOURCE);
      const biz = rows.filter((r) => !r.SQL_SOURCE);
      const note = selfSqlNote(mine);
      if (!biz.length) {
        return {
          level: 'ok',
          message: mine.length
            ? `超过阈值 ${ms} 毫秒的历史记录里只有本工具自身的巡检查询，共 ${mine.length} 条，已排除、不计入告警。`
            : `未发现耗时超过 ${ms} 毫秒的 SQL 历史记录。`,
        };
      }
      const worst = num(first(biz, 'TIME_USED'));
      const slowest = worst === null ? '未知' : (worst / 1000000).toFixed(3) + ' 秒';
      const over10 = biz.filter((r) => (num(r.TIME_USED) || 0) >= 10000000).length;
      const detail =
        `共 ${biz.length} 条 SQL 超过阈值 ${ms} 毫秒，最慢 ${slowest}` + (over10 ? `，其中 ${over10} 条超过 10 秒` : '');
      if (over10) return { level: 'crit', message: detail + '，需重点优化。' + note };
      return { level: 'warn', message: detail + '。' + note };
    },
    advice: '需 ENABLE_MONITOR=1 才有历史数据；注意 TIME_USED 单位为微秒，与 V$LONG_EXEC_SQLS 的毫秒不同。',
  },
  {
    id: 'sql.cache',
    group: 'SQL 性能',
    title: 'SQL 缓存项数量',
    desc: '缓存项短时间内激增通常意味着大量字面量 SQL（未用绑定变量）',
    display: 'kv',
    sql: [`SELECT COUNT(*) AS SQL_CACHE_ITEMS FROM V$CACHEITEM`, `SELECT COUNT(*) AS SQL_CACHE_ITEMS FROM V$DICT_CACHE`],
    evaluate(rows) {
      const n = num(first(rows, 'SQL_CACHE_ITEMS'));
      if (n === null) return { level: 'info', message: '未读取到 SQL 缓存项。' };
      return { level: 'info', message: `当前 SQL 缓存项 ${n} 个，建议纳入基线做趋势对比。` };
    },
  },
  {
    id: 'sql.indexfrag',
    group: 'SQL 性能',
    title: (o) => `索引碎片率 Top ${o.topN}`,
    desc: '碎片率过高的索引应重建（部分版本无相关函数，失败属正常）',
    maxRows: 200,
    bars: { FRAGPCT: { warn: 30, crit: 50 } },
    sql: (ctx) => {
      const n = topLimit(ctx.options);
      return [
        `SELECT * FROM (
         SELECT OWNER||'.'||INDEX_NAME AS OBJNAME,
                ROUND(100.0*(1 - INDEX_USED_PAGES(OWNER,INDEX_NAME)*1.0
                             / INDEX_USED_SPACE(OWNER,INDEX_NAME)), 2) AS FRAGPCT
           FROM DBA_INDEXES
          WHERE TABLESPACE_NAME NOT IN ('TEMP','ROLL','SYSTEM')
            AND OWNER NOT IN (${SYS_OWNERS})
            AND TEMPORARY = 'N'
            AND INDEX_USED_SPACE(OWNER,INDEX_NAME) > 0
       ) T WHERE FRAGPCT IS NOT NULL AND FRAGPCT > 30
       ORDER BY FRAGPCT DESC LIMIT ${n}`,
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
      if (!rows.length) return { level: 'ok', message: '未发现碎片率超过 30% 的索引（或该版本不支持相关函数）。' };
      const bad = rows.filter((r) => num(r.FRAGPCT) > 50);
      if (bad.length) {
        return { level: 'crit', message: `有 ${bad.length} 个索引碎片率超过 50%，建议重建：${bad.map((r) => r.OBJNAME).join('、')}。` };
      }
      return { level: 'warn', message: `有 ${rows.length} 个索引碎片率超过 30%。` };
    },
    advice: '整理碎片：ALTER INDEX "模式"."索引名" REBUILD ONLINE;（大表请在业务低峰执行）',
  },

  // ============================================= 九、对象与统计信息
  {
    id: 'obj.invalid',
    group: '对象与统计信息',
    title: '无效对象',
    desc: '状态非 VALID 的存储过程、视图、函数、触发器等（重点项）',
    maxRows: 100,
    sql: [
      `SELECT OWNER, OBJECT_TYPE, OBJECT_NAME, STATUS,
              TO_CHAR(LAST_DDL_TIME,'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME
         FROM DBA_OBJECTS
        WHERE STATUS <> 'VALID' AND OWNER NOT IN (${SYS_OWNERS})
        ORDER BY OWNER, OBJECT_TYPE, OBJECT_NAME`,
      `SELECT OWNER, OBJECT_TYPE, OBJECT_NAME, STATUS
         FROM DBA_OBJECTS WHERE STATUS <> 'VALID'`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '没有无效对象，状态良好。' };
      if (rows.length > 5) {
        return { level: 'crit', message: `存在 ${rows.length} 个无效对象，涉及业务包将导致调用报错，需尽快重新编译。` };
      }
      return {
        level: 'warn',
        message: `存在 ${rows.length} 个无效对象：${rows
          .map((r) => `${r.OWNER}.${r.OBJECT_NAME}${r.OBJECT_TYPE ? '(' + r.OBJECT_TYPE + ')' : ''}`)
          .join('、')}。`,
      };
    },
    advice: '重新编译：ALTER PROCEDURE/FUNCTION/VIEW/TRIGGER "模式"."对象名" COMPILE;',
  },
  {
    id: 'obj.stats',
    group: '对象与统计信息',
    title: '统计信息陈旧或未收集',
    desc: '超过 30 天未收集统计信息的表，执行计划易劣化（重点项）',
    maxRows: 100,
    sql: [
      `SELECT OWNER, TABLE_NAME,
              TO_CHAR(LAST_ANALYZED,'YYYY-MM-DD HH24:MI:SS') AS LAST_ANALYZED,
              NUM_ROWS
         FROM DBA_TABLES
        WHERE OWNER NOT LIKE 'SYS%'
          AND OWNER NOT IN ('CTISYS','SYSJOB','SCHEDULER')
          AND (LAST_ANALYZED IS NULL OR LAST_ANALYZED < SYSDATE - 30)
        ORDER BY LAST_ANALYZED`,
      `SELECT OWNER, TABLE_NAME, TO_CHAR(LAST_ANALYZED,'YYYY-MM-DD HH24:MI:SS') AS LAST_ANALYZED
         FROM DBA_TABLES
        WHERE OWNER NOT LIKE 'SYS%' AND LAST_ANALYZED IS NULL`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '业务表统计信息均在 30 天内更新过。' };
      if (rows.length > 50) {
        return { level: 'warn', message: `有 ${rows.length} 张表的统计信息缺失或超过 30 天未更新，建议在业务低峰批量收集。` };
      }
      return { level: 'warn', message: `有 ${rows.length} 张表统计信息陈旧或未收集。` };
    },
    advice: '收集统计信息：DBMS_STATS.GATHER_TABLE_STATS(\'模式\',\'表名\',NULL,100,TRUE,\'FOR ALL COLUMNS SIZE AUTO\');',
  },
  {
    id: 'obj.nopk',
    group: '对象与统计信息',
    title: '无主键表',
    desc: '缺少主键的表会影响数据同步、行级锁效率与数据恢复',
    maxRows: 100,
    sql: [
      `SELECT t.OWNER, t.TABLE_NAME
         FROM DBA_TABLES t
        WHERE t.OWNER NOT IN (${SYS_OWNERS})
          AND NOT EXISTS (SELECT 1 FROM DBA_CONSTRAINTS c
                           WHERE c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
                             AND c.CONSTRAINT_TYPE = 'P')
        ORDER BY t.OWNER, t.TABLE_NAME`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'ok', message: '所有业务表均已定义主键。' };
      if (rows.length > 10) {
        return { level: 'warn', message: `有 ${rows.length} 张业务表没有主键约束，建议补充。` };
      }
      return {
        level: 'info',
        message: `有 ${rows.length} 张表无主键：${rows.slice(0, 10).map((r) => r.OWNER + '.' + r.TABLE_NAME).join('、')}。`,
      };
    },
    advice: '达梦普通表默认为聚簇索引表，本身需要聚簇索引；此处针对的是未显式定义主键约束的表。',
  },
  {
    id: 'obj.count',
    group: '对象与统计信息',
    title: '对象数量统计',
    desc: '用于与历史基线对比，发现异常增长',
    display: 'kv',
    sql: [
      `SELECT 'TABLES' AS OBJ_TYPE, COUNT(*) AS CNT FROM DBA_TABLES WHERE OWNER NOT IN (${SYS_OWNERS})
        UNION ALL SELECT 'INDEXES', COUNT(*) FROM DBA_INDEXES WHERE OWNER NOT IN (${SYS_OWNERS})
        UNION ALL SELECT 'VIEWS', COUNT(*) FROM DBA_VIEWS WHERE OWNER NOT IN (${SYS_OWNERS})
        UNION ALL SELECT 'PROCEDURES', COUNT(*) FROM DBA_PROCEDURES
        UNION ALL SELECT 'TRIGGERS', COUNT(*) FROM DBA_TRIGGERS
        UNION ALL SELECT 'SEQUENCES', COUNT(*) FROM DBA_SEQUENCES
        UNION ALL SELECT 'USERS_OPEN', COUNT(*) FROM DBA_USERS WHERE ACCOUNT_STATUS = 'OPEN'`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到对象数量。' };
      return { level: 'info', message: rows.map((r) => `${r.OBJ_TYPE}=${r.CNT}`).join('，') + '。' };
    },
  },

  // ======================================================= 十、用户与安全
  {
    id: 'sec.users',
    group: '用户与安全',
    title: '用户账号状态',
    desc: '锁定、过期的账号，以及 SYSDBA 等管理员账号状态',
    maxRows: 200,
    sql: [
      `SELECT USERNAME, ACCOUNT_STATUS, USER_ID,
              TO_CHAR(LOCK_DATE,'YYYY-MM-DD HH24:MI:SS')   AS LOCK_DATE,
              TO_CHAR(EXPIRY_DATE,'YYYY-MM-DD HH24:MI:SS') AS EXPIRY_DATE,
              TO_CHAR(CREATED,'YYYY-MM-DD HH24:MI:SS')     AS CREATED_DATE,
              DEFAULT_TABLESPACE, AUTHENTICATION_TYPE
         FROM DBA_USERS ORDER BY ACCOUNT_STATUS, USERNAME`,
      `SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS ORDER BY USERNAME`,
    ],
    rowLevel(row) {
      const s = String(row.ACCOUNT_STATUS || '').toUpperCase();
      if (!s || s === 'OPEN') return null;
      // 内置账号的默认状态不标红：整体结论是「信息级」，行却标红会自相矛盾
      if (isBuiltinUser(row.USERNAME)) return null;
      if (s.includes('EXPIRED')) return 'crit';
      if (s.includes('LOCKED')) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到用户信息（需要 DBA 权限）。' };
      const notOpen = rows.filter((r) => {
        const s = String(r.ACCOUNT_STATUS || '').toUpperCase();
        return s && s !== 'OPEN';
      });
      const fmt = (list) => list.map((r) => `${r.USERNAME}(${r.ACCOUNT_STATUS})`).join('、');
      // 内置账号与业务账号分开：内置账号的状态通常是安装默认值（见 DM_BUILTIN_USERS 说明）
      const biz = notOpen.filter((r) => !isBuiltinUser(r.USERNAME));
      const builtin = notOpen.filter((r) => isBuiltinUser(r.USERNAME));
      const bizExpired = biz.filter((r) => String(r.ACCOUNT_STATUS).toUpperCase().includes('EXPIRED'));
      const bizOther = biz.filter((r) => !String(r.ACCOUNT_STATUS).toUpperCase().includes('EXPIRED'));
      const builtinNote = builtin.length
        ? `另有 ${builtin.length} 个内置账号非 OPEN：${fmt(builtin)}` +
          '（属内置账号的默认状态——例如 SYSSSO 是「安全管理员」，企业版上本来就不可用，需安全版；' +
          '若非有意启用，可忽略，不必按故障处理）'
        : '';
      if (bizExpired.length) {
        return { level: 'crit', message: `有 ${bizExpired.length} 个业务账号已过期：${fmt(bizExpired)}。${builtinNote}` };
      }
      if (bizOther.length) {
        return { level: 'warn', message: `有 ${bizOther.length} 个业务账号非 OPEN 状态：${fmt(bizOther)}。${builtinNote}` };
      }
      if (builtin.length) {
        return { level: 'info', message: `业务账号状态均正常（共 ${rows.length} 个数据库用户）。${builtinNote}` };
      }
      return { level: 'ok', message: `共 ${rows.length} 个数据库用户，账号状态均正常。` };
    },
  },
  {
    id: 'sec.pwdpolicy',
    group: '用户与安全',
    title: '密码策略与登录限制',
    desc: '等保要求口令长度、有效期、锁定策略达标',
    maxRows: 100,
    sql: [
      `SELECT d.USERNAME, s.PWD_POLICY, s.LIFE_TIME AS PWD_LIFE_DAYS,
              s.FAILED_NUM, s.FAILED_ATTEMPS, s.LOCK_TIME, s.CONN_IDLE_TIME
         FROM SYSUSERS s, DBA_USERS d WHERE s.ID = d.USER_ID ORDER BY d.USERNAME`,
      `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI
        WHERE PARA_NAME IN ('PWD_POLICY','PWD_MIN_LEN')`,
    ],
    rowLevel(row) {
      const life = num(row.PWD_LIFE_DAYS);
      const fail = num(row.FAILED_ATTEMPS);
      const maxFail = num(row.FAILED_NUM);
      // 内置账号的默认口令策略不标黄：整体结论是「信息级」，行却标黄会自相矛盾。
      // 失败次数是真实状态，对所有账号都照常标。
      if (!isBuiltinUser(row.USERNAME) && life !== null && (life === 0 || life > 180)) return 'warn';
      if (fail !== null && maxFail !== null && maxFail > 0 && fail >= maxFail - 1) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到密码策略（需要 SYSDBA 权限）。' };
      const never = rows.filter((r) => num(r.PWD_LIFE_DAYS) === 0);
      // 同 sec.users：内置账号的 LIFE_TIME=0 是安装默认值，不该让新装的库一上手就报「不符合等保」
      const bizNever = never.filter((r) => !isBuiltinUser(r.USERNAME));
      const builtinNever = never.filter((r) => isBuiltinUser(r.USERNAME));
      const names = (list) => list.map((r) => r.USERNAME).join('、');
      if (bizNever.length) {
        return {
          level: 'warn',
          message:
            `有 ${bizNever.length} 个业务账号的口令永不过期（PWD_LIFE_DAYS=0），不符合等保要求：${names(bizNever)}。` +
            (builtinNever.length ? `另有 ${builtinNever.length} 个内置账号同样为 0（安装默认值，不计入）：${names(builtinNever)}。` : ''),
        };
      }
      if (builtinNever.length) {
        return {
          level: 'info',
          message:
            `已获取 ${rows.length} 个账号的口令策略。` +
            `${builtinNever.length} 个内置账号的口令永不过期（PWD_LIFE_DAYS=0，属安装默认值，非业务账号）：${names(builtinNever)}；` +
            '若需满足等保，请针对业务账号设置有效期，内置账号的策略按贵司规范单独评估。',
        };
      }
      return { level: 'info', message: `已获取 ${rows.length} 个账号的口令策略配置。` };
    },
    advice: '建议 PWD_POLICY=31（禁同名+长度≥9+大写+数字+标点），口令有效期 ≤90 天，失败锁定次数 ≤5 次。',
  },
  {
    id: 'sec.audit',
    group: '用户与安全',
    title: '审计开关',
    desc: '等保要求开启数据库审计',
    display: 'kv',
    sql: [
      `SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI
        WHERE PARA_NAME IN ('ENABLE_AUDIT','AUDIT_MAX_FILE_SIZE','AUDIT_FILE_FULL_MODE','SVR_LOG')`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到审计参数。' };
      const audit = rows.find((r) => r.PARA_NAME === 'ENABLE_AUDIT');
      const v = audit ? String(audit.PARA_VALUE).trim() : null;
      const svrlog = rows.find((r) => r.PARA_NAME === 'SVR_LOG');
      const sv = svrlog ? String(svrlog.PARA_VALUE).trim() : null;
      const msgs = [];
      let level = 'ok';
      if (v === '0' || v === null) {
        level = 'warn';
        msgs.push('数据库审计未开启（ENABLE_AUDIT=0），不满足等保要求');
      } else {
        msgs.push(`审计已开启（ENABLE_AUDIT=${v}）`);
      }
      if (sv === '1') {
        level = level === 'ok' ? 'warn' : level;
        msgs.push('SQL 日志（SVR_LOG）已开启，生产环境常开会带来性能开销，建议只记录执行时间较长的语句');
      }
      return { level, message: msgs.join('；') + '。' };
    },
    advice: '开启审计需使用 SYSAUDITOR 登录执行 SP_SET_ENABLE_AUDIT(1)。',
  },
  {
    id: 'sec.privileges',
    group: '用户与安全',
    title: '高权限用户',
    desc: '检查拥有 DBA 角色或 ANY TABLE 类系统权限的业务账号（内置账号与 AWR 采集账号除外）',
    maxRows: 100,
    sql: [
      `SELECT GRANTEE, GRANTED_ROLE AS PRIVILEGE, 'ROLE' AS PRIV_TYPE, ADMIN_OPTION
         FROM DBA_ROLE_PRIVS
        WHERE GRANTED_ROLE IN ('DBA','DB_AUDIT_ADMIN','DB_POLICY_ADMIN')
        ORDER BY GRANTED_ROLE, GRANTEE`,
      `SELECT GRANTEE, PRIVILEGE, 'SYS' AS PRIV_TYPE, ADMIN_OPTION
         FROM DBA_SYS_PRIVS
        WHERE PRIVILEGE IN ('SELECT ANY TABLE','UPDATE ANY TABLE','DELETE ANY TABLE',
                            'DROP ANY TABLE','GRANT ANY PRIVILEGE','ALTER DATABASE')
        ORDER BY PRIVILEGE, GRANTEE`,
    ],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未读取到权限信息（需要 DBA 权限）。' };
      const dba = rows.filter((r) => String(r.PRIVILEGE).toUpperCase() === 'DBA');
      // 默认管理账号与数据库自己创建的账号（AWR1 之类）都不算「非预期用户」：
      // 否则同一份报告会在「用户账号状态」里说「AWR1 属内置账号、可忽略」，
      // 又在这里把它列成可疑的高权限账号 —— 自相矛盾。
      const suspicious = dba.filter((r) => !isBuiltinUser(r.GRANTEE));
      if (suspicious.length) {
        return {
          level: 'warn',
          message: `以下非默认管理账号拥有 DBA 角色，请确认是否符合权限最小化原则：${suspicious.map((r) => r.GRANTEE).join('、')}。`,
        };
      }
      return { level: 'info', message: `共 ${rows.length} 条高权限授予记录，未发现异常。` };
    },
    advice: '遵循权限最小化原则，业务账号不应授予 DBA 或 ANY TABLE 类系统权限。',
  },

  // =================================================== 十一、作业与备份
  {
    id: 'job.list',
    group: '作业与备份',
    title: '作业（定时任务）清单',
    desc: '作业系统是否初始化，关键作业是否启用',
    maxRows: 200,
    sql: [
      `SELECT ID, NAME, "ENABLE" AS ENABLE_FLAG, USERNAME,
              TO_CHAR(CREATETIME,'YYYY-MM-DD HH24:MI:SS') AS CREATE_TIME
         FROM SYSJOB.SYSJOBS ORDER BY NAME`,
      `SELECT ID, NAME FROM SYSJOB.SYSJOBS`,
    ],
    custom: async (ctx) => {
      if (await jobSubsystemMissing(ctx)) {
        return {
          columns: ['JOB_INFO'],
          rows: [{ JOB_INFO: JOB_MISSING_NOTE }],
          rowCount: 1,
          meta: { jobNotInstalled: true },
        };
      }
      return ctx.queryTry(ctx.sql);
    },
    rowLevel(row) {
      const e = String(row.ENABLE_FLAG || '').trim();
      if (e === '0' || e.toUpperCase() === 'DISABLED') return 'warn';
      return null;
    },
    evaluate(rows, data) {
      if (data && data.meta && data.meta.jobNotInstalled) {
        return { level: 'info', message: JOB_MISSING_NOTE };
      }
      if (!rows.length) {
        // 「没有配置任何作业」本身不是缺陷（很多库靠外部调度/备份工具），
        // 备份缺失已由「备份集有效性」单独判定，这里只作提示避免重复告警。
        return {
          level: 'info',
          message: '未配置任何 DM 定时作业（SYSJOB）。若备份由外部工具完成，请以「备份集有效性」检查结论为准。',
        };
      }
      const disabled = rows.filter((r) => {
        const e = String(r.ENABLE_FLAG || '').trim();
        return e === '0' || e.toUpperCase() === 'DISABLED';
      });
      if (disabled.length) {
        return { level: 'warn', message: `有 ${disabled.length}/${rows.length} 个作业处于禁用状态：${disabled.map((r) => r.NAME).join('、')}。` };
      }
      return { level: 'ok', message: `共 ${rows.length} 个作业，均已启用。` };
    },
  },
  {
    id: 'job.history',
    group: '作业与备份',
    title: '作业执行失败历史',
    desc: '近 50 条失败的作业步骤，备份类作业连续失败风险极高（重点项）',
    maxRows: 50,
    sql: [
      `SELECT EXEC_ID, NAME AS JOB_NAME, STEPNAME,
              TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
              TO_CHAR(END_TIME,'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
              ERRCODE, ERRINFO
         FROM SYSJOB.SYSSTEPHISTORIES2
        WHERE ERRCODE <> 0
        ORDER BY START_TIME DESC LIMIT 50`,
      `SELECT * FROM SYSJOB.SYSJOBHISTORIES2 ORDER BY START_TIME DESC LIMIT 50`,
    ],
    custom: async (ctx) => {
      if (await jobSubsystemMissing(ctx)) {
        return {
          columns: ['JOB_INFO'],
          rows: [{ JOB_INFO: JOB_MISSING_NOTE }],
          rowCount: 1,
          meta: { jobNotInstalled: true },
        };
      }
      return ctx.queryTry(ctx.sql);
    },
    evaluate(rows, data) {
      if (data && data.meta && data.meta.jobNotInstalled) {
        return { level: 'info', message: JOB_MISSING_NOTE };
      }
      if (!rows.length) return { level: 'ok', message: '未发现失败的作业执行记录。' };
      const errs = rows.filter((r) => r.ERRCODE !== undefined && num(r.ERRCODE) !== 0);
      const list = errs.length ? errs : rows;
      if (list.length >= 2) {
        return { level: 'crit', message: `有 ${list.length} 次作业执行失败，请检查备份/统计信息等关键作业是否连续失败。` };
      }
      return { level: 'warn', message: `有 ${list.length} 次作业执行失败记录。` };
    },
    advice: '作业历史在 SYSJOB.SYSJOBHISTORIES2 / SYSSTEPHISTORIES2（带 2 的才有数据）。',
  },
  {
    id: 'backup.sets',
    group: '作业与备份',
    title: '备份集信息',
    desc: '近 7 天备份集及最近一次成功备份时间（重点项）',
    maxRows: 100,
    sql: [
      `SELECT DEVICE_TYPE, BACKUP_ID, BACKUP_PATH,
              TO_CHAR(BACKUP_TIME,'YYYY-MM-DD HH24:MI:SS') AS BACKUP_TIME,
              ROUND(SYSDATE - BACKUP_TIME, 2) AS DAYS_AGO
         FROM V$BACKUPSET
        WHERE BACKUP_TIME > SYSDATE - 30
        ORDER BY BACKUP_TIME DESC`,
      `SELECT * FROM V$BACKUPSET ORDER BY BACKUP_TIME DESC LIMIT 50`,
    ],
    rowLevel(row) {
      const d = num(row.DAYS_AGO);
      if (d === null) return null;
      if (d > 3) return 'crit';
      if (d > 1) return 'warn';
      return null;
    },
    evaluate(rows) {
      if (!rows.length) {
        return { level: 'crit', message: '近 30 天未查询到任何备份集记录，数据库可能没有有效备份，风险极高！' };
      }
      const d = num(first(rows, 'DAYS_AGO'));
      if (d === null) return { level: 'info', message: `共 ${rows.length} 个备份集记录。` };
      if (d > 3) return { level: 'crit', message: `最近一次备份在 ${d} 天前（${first(rows, 'BACKUP_TIME')}），已超过 3 天，请立即检查备份任务。` };
      if (d > 1) return { level: 'warn', message: `最近一次备份在 ${d} 天前（${first(rows, 'BACKUP_TIME')}）。` };
      return { level: 'ok', message: `最近一次备份时间：${first(rows, 'BACKUP_TIME')}，备份正常。` };
    },
    advice: '建议至少每日一次全备，并用 dmrman 的 CHECK BACKUPSET 定期校验备份集可恢复性。',
  },
  {
    id: 'backup.path',
    group: '作业与备份',
    title: '备份路径配置',
    desc: '默认备份目录与 BCT 路径',
    display: 'kv',
    sql: [`SELECT PARA_NAME, PARA_VALUE, FILE_VALUE FROM V$DM_INI WHERE PARA_NAME IN ('BAK_PATH','BCT_PATH')`],
    evaluate(rows) {
      if (!rows.length) return { level: 'info', message: '未配置默认备份路径（BAK_PATH 为空）。' };
      const bak = rows.find((r) => r.PARA_NAME === 'BAK_PATH');
      if (bak && (!bak.PARA_VALUE || String(bak.PARA_VALUE).trim() === '')) {
        return { level: 'warn', message: '未配置默认备份路径 BAK_PATH，备份时必须显式指定路径。' };
      }
      return { level: 'info', message: `备份路径：${bak ? bak.PARA_VALUE : '未配置'}。` };
    },
  },
];

// ===========================================================================
// 巡检项排列顺序
// ---------------------------------------------------------------------------
// 三个文件（checks / checks-extra / oschecks-host）是分阶段写成的，直接 concat
// 会让顺序变成「历史遗留顺序」：同一个分组会被后面的文件再次「打开」
// （例如「实例状态」原本在第 2 组，补充项又让它散落在第 66、69、74 项的位置），
// 阅读时既跳跃又难核对。
//
// 因此这里显式声明排列规则，由数组顺序统一决定**报告分组顺序**与**组内项目顺序**
// （runner 按「分组首次出现」建组、按数组顺序收集组内项目，排序一次即可全部生效）。
//
// 排列逻辑：由外到内、由静态到动态、由可用性到安全性
//   1 概况      —— 这是什么库、什么形态、什么版本、什么状态（部署形态必须最先，它决定后续项的适用性）
//   2 运行平台  —— 数据库跑在什么主机上（OS / CPU / 内存 / 磁盘 / 内核参数）
//   3 实例状态  —— 实例自身在做什么（线程、统计、检查点、等待）
//   4 内存缓冲  —— 实例的内存分配与命中情况
//   5 存储      —— 表空间与数据文件（容量从哪来）
//   6 日志归档  —— redo 与归档（数据能不能恢复）
//   7 会话锁    —— 当前连接与阻塞（谁在用、堵在哪）
//   8 SQL 性能  —— 语句级性能
//   9 对象统计  —— 对象健康度与统计信息
//  10 安全运维  —— 账号、审计、作业与备份
//  11 集群      —— 仅集群形态适用，放最后，不打断单实例用户的阅读动线
// ===========================================================================
const GROUP_ORDER = [
  '基础信息',
  '主机与资源',
  '实例状态',
  '内存与缓冲',
  '表空间与数据文件',
  '日志与归档',
  '会话与连接',
  '锁与事务',
  'SQL 性能',
  '对象与统计信息',
  '用户与安全',
  '作业与备份',
  '数据守护集群',
  '共享存储集群',
];

// 组内顺序：未列出的项保持原相对顺序，排在已列出的项之后
const ITEM_ORDER = {
  基础信息: [
    'basic.topology',
    'basic.role',
    'basic.instance',
    'basic.build',
    'basic.database',
    'basic.uptime',
    'basic.charset',
    'basic.license',
    'basic.params',
    'db.param_diff',
  ],
  主机与资源: [
    'instance.systeminfo',
    'os.cpu',
    'os.mem',
    'os.disk',
    'os.diskconf',
    'os.io',
    'os.kernel',
    'os.proc',
    'os.account',
    'res.params',
  ],
  实例状态: ['instance.threads', 'db.sysstat', 'db.ckpt_history', 'instance.waitclass', 'db.sysevent'],
  内存与缓冲: ['mem.total', 'mem.bufferpool', 'mem.mempool', 'mem.dict_cache', 'mem.design_size'],
  表空间与数据文件: ['ts.usage', 'ts.status', 'ts.datafiles', 'ts.datafile_pages', 'ts.segments'],
  日志与归档: [
    'log.redofiles',
    'log.rlog',
    'log.switch',
    'log.archini',
    'log.archstatus',
    'log.archfile',
    'log.scan',
    'log.instance_history',
  ],
  会话与连接: ['sess.summary', 'sess.maxratio', 'sess.byapp', 'sess.idletrx', 'sess.memtop'],
  锁与事务: ['lock.trxwait', 'lock.blocked', 'lock.trx', 'lock.longtrx', 'lock.deadlock'],
  'SQL 性能': ['sql.slow_now', 'sql.longexec', 'sql.history', 'sql.cache', 'sql.indexfrag'],
  对象与统计信息: [
    'obj.invalid',
    'obj.invalid_index',
    'obj.invalid_part_index',
    'obj.stats',
    'obj.nopk',
    'obj.frag_table',
    'obj.seq_usage',
    'obj.count',
  ],
  用户与安全: ['sec.users', 'sec.pwdpolicy', 'sec.privileges', 'sec.audit'],
  作业与备份: ['job.list', 'job.history', 'backup.sets', 'backup.path'],
  数据守护集群: ['dw.archsend', 'dw.sync', 'dw.mal', 'dw.malmem', 'dw.monitor'],
  共享存储集群: ['dsc.nodes', 'dsc.dcrgroup', 'dsc.register', 'dsc.asmgroup', 'dsc.asmdisk', 'dsc.request'],
};

const ALL_CHECKS = BASE_CHECKS
  // 依据《巡检检查项 V4.3》补充的检查项：数据守护集群、共享存储集群、以及单实例补充项
  .concat(require('./checks-extra'))
  // 数据库服务器 OS 级检查项（同机本机 shell / 异机 SSH）
  .concat(require('./oschecks-host'));

/** 未知分组与重复 id 直接抛错，而不是悄悄排到末尾 / 产生歧义 */
for (const c of ALL_CHECKS) {
  if (!GROUP_ORDER.includes(c.group)) {
    throw new Error(`巡检项 ${c.id} 的分组「${c.group}」未在 GROUP_ORDER 中登记`);
  }
}
const DUP_IDS = [...new Set(ALL_CHECKS.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (DUP_IDS.length) throw new Error('巡检项 id 重复：' + DUP_IDS.join('、'));

const groupRank = (g) => GROUP_ORDER.indexOf(g);
const itemRank = (c) => {
  const list = ITEM_ORDER[c.group] || [];
  const i = list.indexOf(c.id);
  return i < 0 ? list.length + 1000 : i; // 未登记的项排在已登记项之后
};

// 稳定排序：同组同序时保持原数组顺序（V8 的 Array#sort 自 Node 11 起稳定）
module.exports = ALL_CHECKS.map((c, i) => ({ c, i }))
  .sort((a, b) => {
    const g = groupRank(a.c.group) - groupRank(b.c.group);
    if (g !== 0) return g;
    const t = itemRank(a.c) - itemRank(b.c);
    return t !== 0 ? t : a.i - b.i;
  })
  .map((x) => x.c);
