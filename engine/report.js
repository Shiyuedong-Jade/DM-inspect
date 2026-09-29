'use strict';
/*
 * HTML 巡检报告生成器
 * ---------------------------------------------------------------------------
 * 输出完全自包含的 HTML（CSS 内联、无外部资源），可离线打开、可直接打印成 PDF。
 * 报告中不包含数据库口令等敏感信息。
 */

const COLUMN_LABELS = {
  INSTANCE_NAME: '实例名', SVR_VERSION: '服务端版本', DB_VERSION: '数据库版本',
  ID_CODE: '版本标识', START_TIME: '启动时间', STATUS: '状态', MODE_TYPE: '运行模式',
  DSC_ROLE: 'DSC 角色', DB_NAME: '数据库名', DB_STATUS: '数据库状态', DB_ROLE: '角色',
  ARCH_MODE: '归档模式', LAST_CKPT_TIME: '最后检查点时间', CREATE_TIME: '创建时间',
  RUN_DAYS: '已运行(天)', RUN_MINUTES: '已运行(分钟)', UNICODE_FLAG: '字符集标识', CASE_SENSITIVE: '大小写敏感',
  EXTENT_SIZE: '簇大小', PAGE_SIZE_BYTES: '页大小(字节)', SERIES_NO: '授权序列号',
  SERVER_SERIES: '产品系列', SERVER_TYPE: '产品类型', SERVER_VER: '授权版本范围',
  EXPIRED_DATE: '授权到期日', AUTHORIZED_CUSTOMER: '授权客户', MAX_CPU_NUM: '最大 CPU 数',
  DAYS_LEFT: '剩余天数', PARA_NAME: '参数名', PARA_VALUE: '内存值', FILE_VALUE: '配置文件值',
  PHY_TOTAL_GB: '物理内存(GB)', PHY_FREE_GB: '空闲物理内存(GB)', DISK_TOTAL_GB: '磁盘总量(GB)',
  DISK_FREE_GB: '磁盘剩余(GB)', DISK_FREE_PCT: '磁盘剩余(%)', CPU_USER_RATE: '用户态 CPU(%)',
  CPU_SYSTEM_RATE: '系统态 CPU(%)', NAME: '名称', THREAD_DESC: '线程说明',
  CLASS_NAME: '等待类', TOTAL_WAITS: '累计等待次数', TABLESPACE_NAME: '表空间',
  TOTAL_MB: '合计(MB)', USED_MB: '已用(MB)', FREE_MB: '剩余(MB)', USED_PCT: '使用率(%)',
  FILE_ID: '文件 ID', FILE_NAME: '文件路径', AUTOEXTENSIBLE: '自动扩展', MAXSIZE_MB: '上限(MB)',
  PCT_TO_MAX: '占上限(%)', TS_ID: '表空间 ID', PATH: '路径', AUTO_EXTEND: '自动扩展',
  NEXT_SIZE: '增量', MAX_SIZE: '上限', TS_TYPE: '类型', TS_STATUS: '状态',
  TOTAL_SIZE: '大小', FILE_NUM: '文件数', OWNER: '模式', SEGMENT_NAME: '段名',
  SEGMENT_TYPE: '段类型', SIZE_MB: '大小(MB)', LOG_HOUR: '小时', SWITCH_CNT: '切换次数',
  CUR_LSN: '当前 LSN', CKPT_LSN: '检查点 LSN', NEXT_SEQ: '日志序列号', CUR_FILE: '当前文件',
  RLOG_SIZE: '大小(字节)', REDO_FILE_CNT: 'redo 文件数', MIN_SIZE_MB: '最小(MB)',
  MAX_SIZE_MB: '最大(MB)', ARCH_NAME: '归档名', ARCH_TYPE: '归档类型', ARCH_DEST: '归档目录',
  ARCH_FILE_SIZE: '单文件上限(MB)', ARCH_SPACE_LIMIT: '空间上限(MB)', ARCH_IS_VALID: '是否有效',
  ARCH_WAIT_APPLY: '等待应用', ARCH_INCOMING_PATH: '接收路径', ARCH_DATE: '日期',
  FILE_CNT: '文件数', ARCH_GB: '归档量(GB)', ARCH_MB: '归档大小(MB)', ARCH_STATUS: '归档状态',
  N_PAGES: '页数', N_LOGIC_READS: '逻辑读', N_PHY_READS: '物理读', RAT_HIT: '命中率',
  FREE: '空闲页', N_DIRTY: '脏页', N_DISCARD64: '淘汰次数', ORG_MB: '初始(MB)',
  RESERVED_MB: '保留(MB)', DATA_MB: '数据(MB)', IS_SHARED: '共享池', IS_OVERFLOW: '使用备份池',
  N_EXTEND_NORMAL: '正常扩展', N_EXTEND_EXCLUSIVE: '池外扩展', MEMPOOL_MB: '内存池(MB)',
  BUFFER_MB: '缓冲池(MB)', TOTAL_DB_MEM_MB: '合计(MB)', TOTAL_SESS: '会话总数',
  ACTIVE_SESS: '活跃', IDLE_SESS: '空闲', PENDING_SESS: '等待中', FREEING_SESS: '释放中',
  CUR_SESS: '当前会话数', MAX_SESSIONS_MEM: '上限(内存值)', MAX_SESSIONS_FILE: '上限(配置值)',
  USER_NAME: '用户名', APPNAME: '应用名', CLNT_IP: '客户端 IP', STATE: '状态', CNT: '数量',
  SESS_ID: '会话 ID', TRX_ID: '事务 ID', TRX_STATUS: '事务状态', IDLE_SEC: '空闲(秒)',
  SQL_TEXT: 'SQL 语句', KILL_SQL: '结束会话语句', MEM_POOL_NAME: '内存池',
  BLOCKED_TRX_ID: '被阻塞事务', HOLDING_TRX_ID: '阻塞源事务', WAIT_TIME: '等待时间',
  THRD_ID: '线程 ID', TABLE_ID: '表 ID', LTYPE: '锁类型', BLOCKED: '被阻塞',
  ROW_IDX: '行标识', LMODE: '锁模式', EXEC_SEC: '已执行(秒)', N_RUNS: '执行次数',
  TIME_USED: '耗时(微秒)', AFFECTED_ROWS: '影响行数', N_LOGIC_READ: '逻辑读',
  N_PHY_READ: '物理读', IS_OVER: '已结束', HAPPEN_TIME: '发生时间',
  DEADLOCK_CYCLE: '死锁环路', SEQNO: '序号', SESS_SEQ: '会话序号',
  LAST_ANALYZED: '最后统计时间', NUM_ROWS: '行数', ACCOUNT_STATUS: '账号状态',
  USER_ID: '用户 ID', LOCK_DATE: '锁定时间', EXPIRY_DATE: '过期时间',
  CREATED_DATE: '创建时间', DEFAULT_TABLESPACE: '默认表空间', AUTHENTICATION_TYPE: '认证方式',
  USERNAME: '用户名', PWD_POLICY: '口令策略', PWD_LIFE_DAYS: '口令有效期(天)',
  FAILED_NUM: '失败锁定上限', FAILED_ATTEMPS: '已失败次数', CONN_IDLE_TIME: '空闲超时(分)',
  GRANTEE: '被授权者', PRIVILEGE: '权限', PRIV_TYPE: '权限类型', ADMIN_OPTION: '可转授',
  ENABLE_FLAG: '是否启用', JOB_NAME: '作业名', STEPNAME: '步骤', ERRCODE: '错误码',
  ERRINFO: '错误信息', EXEC_ID: '执行 ID', BACKUP_ID: '备份 ID', BACKUP_PATH: '备份路径',
  BACKUP_TIME: '备份时间', DAYS_AGO: '距今天数', DEVICE_TYPE: '设备类型',
  OBJ_TYPE: '对象类型', OBJNAME: '对象', FRAGPCT: '碎片率(%)', OBJECT_TYPE: '对象类型',
  OBJECT_NAME: '对象名', TABLE_NAME: '表名', LAST_DDL_TIME: '最后 DDL 时间',
  SQL_CACHE_ITEMS: 'SQL 缓存项数', SESS_CREATE: '会话建立时间', EXEC_TIME: '执行耗时(毫秒)',
  SQL_SOURCE: '来源',
  FINISH_TIME: '完成时间', START_TIME: '开始时间', MEM_USED_BY: '内存占用',
  DB_VERSION: '数据库版本', ID_CODE: '版本标识', DB_MAGIC: 'DB_MAGIC',
  SERVER_SERIES: '产品系列', SERVER_TYPE: '产品类型', SERVER_VER: '授权版本范围',
  AUTHENTICATION_TYPE: '认证方式', DEFAULT_TABLESPACE: '默认表空间',
  'STATUS$': '状态码', MEM_USED_BY_K: '内存(KB)', MAXBYTES: '最大(MB)', BYTES: '字节数',
  AUTOEXTENSIBLE: '自动扩展', TS_TYPE: '类型', LTYPE: '锁类型',
  // 版本解析（basic.build）
  BUILD_TYPE: '版本类型', INNER_VERSION: '内核版本',
  // 主机 OS 指标（os.host）
  HOSTNAME: '主机名', PLATFORM: '操作系统', CPU_MODEL: 'CPU 型号', CPU_CORES: 'CPU 核数',
  CPU_USED_PCT: 'CPU 使用率(%)', LOAD_1M: '1 分钟负载', LOAD_5M: '5 分钟负载',
  LOAD_15M: '15 分钟负载', MEM_TOTAL: '内存总量', MEM_AVAILABLE: '可用内存',
  MEM_USED_PCT: '内存使用率(%)', IO_READ_RATE: '磁盘读速率', IO_WRITE_RATE: '磁盘写速率',
  IO_READ_IOPS: '读 IOPS', IO_WRITE_IOPS: '写 IOPS', OS_UPTIME_DAYS: '主机运行(天)',
  DISK_USAGE: '磁盘容量', NOTE: '说明',
  // 资源与参数分析（res.params）
  ITEM: '分析项', CURRENT: '当前值', SUGGEST: '参考建议', RESULT: '结论',
  // 日志扫描（log.scan）
  TIME: '时间', LEVEL: '级别', FILE: '日志文件', TEXT: '日志内容', SCAN_RESULT: '扫描结果',
  HOST_NAME: '数据库主机名', OS_COLLECT_RESULT: '采集结果',
  THREAD_CLASS: '线程类别', THREADS: '线程（示例）',
  // 缓冲池 / 内存池分类汇总
  POOL_CLASS: '池类别', POOL_CNT: '池数', HIT_PCT: '命中率(%)', DISCARD: '淘汰次数',
  VERDICT: '结论', MAX_MB: '单池最大(MB)', BIGGEST_POOL: '最大池',
  OVERFLOW_CNT: '使用备份池的池数', EXTEND_CNT: '池外扩展的池数',
  // 部署形态与集群项
  DEPLOY_MODE: '部署形态', IS_DSC: '是否 DMDSC', IS_DW: '是否数据守护',
  EVIDENCE: '判定依据', SCOPE_NOTE: '巡检范围说明', APPLICABILITY: '适用性',
  EP_NAME: '节点名', EP_SEQNO: '节点序号', EP_MODE: '节点模式', EP_STATUS: '节点状态',
  GROUP_TYPE: '组类型', GROUP_NAME: '组名', N_EP: '节点数', DSKCHK_CNT: '磁盘心跳次数',
  NETCHK_TIME: '网络心跳时间', VERSION: '版本', VTD_PATH: 'VTD 路径', UDP_OGUID: 'OGUID',
  DCR_PATH: 'DCR 路径', G_N_CTL: '全局控制块总数', G_N_FREE_CTL: '全局控制块空闲',
  L_N_CTL: '本地控制块总数', L_N_FREE_CTL: '本地控制块空闲',
  N_DISK: '磁盘数', TOTAL_SIZE: '总大小', FREE_SIZE: '剩余', PEC_FREE: '剩余比例',
  PEC_USED: '使用比例', PEC_FREE_NUM: '剩余(%)', PEC_USED_NUM: '使用(%)',
  TOTAL_FILE_NUM: '文件数', FREE_AUNO: '空闲 AU 数', DISK_NAME: '磁盘名', DISK_PATH: '磁盘路径',
  GROUP_ID: '组 ID', DISK_ID: '磁盘 ID', REQUESTTYPE: '请求类型', REQUESTCNT: '请求次数',
  AVERAGE_REQUEST_TIME: '平均耗时', AVERAGE_RLOG_FLUSH_TIME: '平均 redo 刷盘耗时',
  MAL_NAME: 'MAL 名', INST_NAME: '实例名', MAL_PORT: 'MAL 端口', INST_IP: '实例 IP',
  INST_PORT: '实例端口', MAL_DW_PORT: '守护端口', MAL_LINK_MAGIC: '链路标识',
  SYS_STATUS: '系统状态', N_SITE: '站点数', MAL_NUM: 'MAL 数', MAL_BUF_SIZE: 'MAL 缓冲',
  MAL_VPOOL_SIZE: 'MAL 虚拟池大小', MAL_MEM_LIMIT_MB: '内存上限(MB)', MAL_MEM_PCT: '占物理内存(%)',
  APPLYING: '重演中', TASK_NUM: '任务数', TASK_MEM_USED: '任务内存(KB)', SEARCHDELAY: '主备延迟(秒)',
  RECNT_APPLY_LEN: '近期重演速率', CONN_TIME: '连接时间', MON_CONFIRM: '确认状态',
  MON_IP: '监视器 IP', MON_ID: '监视器 ID', MON_TERM: '监视器终端',
  LEVEL$: '级别', STAT_VAL: '统计值', ITEM: '项目', VAL: '值', INI_TOTAL_GB: '设计总量(GB)',
  DEFAULT_VALUE: '默认值', EVENT: '等待事件', WAIT_CLASS: '等待类', TOTAL_WAITS: '等待次数',
  TIME_WAITED: '等待时间', EVENT_WAIT_TIME: '平均等待', DICT_NUM: '字典对象数',
  DISCARD_MB: '淘汰(MB)', LRU_DISCARD: 'LRU 淘汰次数',
  // 远程 OS 检查
  OS_CHECK_RESULT: '采集结果', FILESYSTEM: '文件系统', MOUNTED_ON: '挂载点',
  USED: '已用', AVAIL: '可用', TYPE: '类别', CONTENT: '内容',
  DEVICE: '设备', DETAIL: '详情', VALUE: '值',
};

function label(col) {
  return COLUMN_LABELS[col] || col;
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isNumeric(v) {
  if (v === null || v === undefined || v === '') return false;
  return /^-?\d+(\.\d+)?$/.test(String(v).trim());
}

function fmtCell(v) {
  if (v === null || v === undefined || v === '') return '<span class="null">-</span>';
  const s = String(v);
  if (isNumeric(s)) {
    const n = Number(s);
    if (Number.isInteger(n) && Math.abs(n) >= 1000) {
      return esc(n.toLocaleString('en-US'));
    }
    return esc(s);
  }
  return esc(s);
}

const LEVEL_CLASS = { crit: 'crit', warn: 'warn', ok: 'ok', info: 'info', na: 'na', error: 'error' };
const LEVEL_TEXT = { crit: '严重', warn: '警告', ok: '正常', info: '信息', na: '不适用', error: '未取到' };

function renderKv(check) {
  if (!check.rows.length) return '<p class="empty">无数据</p>';
  const visible = check.rows.slice(0, 1);
  const items = [];
  for (const row of visible) {
    check.columns.forEach((c) => {
      items.push(
        `<div class="kv-item"><div class="kv-k">${esc(label(c))}</div><div class="kv-v">${fmtCell(row[c])}</div></div>`
      );
    });
  }
  let extra = '';
  if (check.rows.length > 1) {
    extra = renderTable(check, check.rows.slice(1), (check.rowLevels || []).slice(1));
  }
  return `<div class="kv-grid">${items.join('')}</div>${extra}`;
}

/** 把 bars 配置规范化为 { warn, crit, invert } */
function barRule(rule) {
  if (!rule) return null;
  if (Array.isArray(rule)) return { warn: rule[0], crit: rule[1] };
  return rule;
}

/**
 * 百分比单元格：进度条 + 数值，按阈值着色。
 * 默认「越大越差」（如使用率）；invert=true 表示「越小越差」（如磁盘剩余比例）。
 */
function barCell(value, rawRule) {
  const rule = barRule(rawRule);
  const n = Number(String(value === null || value === undefined ? '' : value).replace(/,/g, ''));
  if (!rule || !Number.isFinite(n)) return fmtCell(value);

  let level = '';
  if (rule.invert) {
    if (n <= rule.crit) level = 'crit';
    else if (n <= rule.warn) level = 'warn';
  } else {
    if (n >= rule.crit) level = 'crit';
    else if (n >= rule.warn) level = 'warn';
  }
  const width = Math.max(0, Math.min(100, n));
  return (
    '<div class="pct">' +
    `<div class="pct-track"><div class="pct-fill ${level}" style="width:${width}%"></div></div>` +
    `<span class="pct-num ${level}">${esc(String(value))}</span>` +
    '</div>'
  );
}

function renderTable(check, rows, rowLevels) {
  const cols = check.columns;
  const rules = check.bars || {};
  const body = rows
    .map((row, ri) => {
      const lv = rowLevels ? rowLevels[ri] : null;
      const cls = lv ? ' class="row-' + lv + '"' : '';
      const tds = cols
        .map((c) => {
          if (rules[c]) return `<td class="pct-cell">${barCell(row[c], rules[c])}</td>`;
          const align = isNumeric(row[c]) ? ' class="num"' : '';
          return `<td${align}>${fmtCell(row[c])}</td>`;
        })
        .join('');
      return `<tr${cls}>${tds}</tr>`;
    })
    .join('');
  const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** 按某一列分组渲染：每组一个小标题 + 一张表（可只取每组前 N 行） */
function renderGrouped(check, rows, rowLevels) {
  const key = check.groupBy;
  const top = check.groupTop || 0;
  const map = new Map();
  const order = [];
  rows.forEach((row, i) => {
    const raw = row[key];
    const k = raw === null || raw === undefined || raw === '' ? '（未归类）' : String(raw);
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k).push({ row, lv: rowLevels ? rowLevels[i] : null });
  });

  const subCheck = { columns: check.columns.filter((c) => c !== key), bars: check.bars };
  return order
    .map((k) => {
      const all = map.get(k);
      const items = top > 0 && all.length > top ? all.slice(0, top) : all;
      const note = top > 0 && all.length > top ? `，显示前 ${top} 个` : '';
      return `
      <div class="gsub">
        <div class="gsub-head">表空间 <b>${esc(k)}</b><span class="gsub-cnt">共 ${all.length} 个对象${note}</span></div>
        ${renderTable(subCheck, items.map((x) => x.row), items.map((x) => x.lv))}
      </div>`;
    })
    .join('');
}

function renderCheckData(check) {
  if (!check.rows.length) {
    return `<p class="empty">${check.error ? esc(check.error) : '查询成功，但未返回数据行。'}</p>`;
  }
  if (check.groupBy && check.columns.includes(check.groupBy)) {
    return renderGrouped(check, check.rows, check.rowLevels);
  }
  if (check.display === 'kv' || (check.display === 'auto' && check.columns.length > 3 && check.rows.length === 1)) {
    return renderKv(check);
  }
  return renderTable(check, check.rows, check.rowLevels);
}

function renderIssue(check, idx) {
  const cls = LEVEL_CLASS[check.status] || 'info';
  return `
  <div class="issue ${cls}">
    <div class="issue-head">
      <span class="badge ${cls}">${LEVEL_TEXT[check.status]}</span>
      <span class="issue-title">${idx}. ${esc(check.title)}</span>
      <span class="issue-group">${esc(check.group)}</span>
    </div>
    <div class="issue-body">${esc(check.message)}</div>
    ${check.advice ? `<div class="issue-advice"><b>整改建议：</b>${esc(check.advice)}</div>` : ''}
  </div>`;
}

/** 渲染单个巡检项的完整区块（单节点报告与集群报告共用） */
function renderCheckBlock(c, idPrefix) {
  const cls = LEVEL_CLASS[c.status] || 'info';
  return `
          <div class="check" id="${esc(idPrefix || '')}check-${esc(c.id)}">
            <div class="check-head">
              <span class="badge ${cls}">${LEVEL_TEXT[c.status]}</span>
              <span class="check-title">${esc(c.title)}</span>
            </div>
            ${c.desc ? `<div class="check-desc">${esc(c.desc)}</div>` : ''}
            <div class="check-msg ${cls}">${esc(c.message)}</div>
            ${renderCheckData(c)}
            ${c.status === 'crit' || c.status === 'warn' ? (c.advice ? `<div class="check-advice"><b>整改建议：</b>${esc(c.advice)}</div>` : '') : ''}
          </div>`;
}

function renderReport(data) {
  const m = data.meta;
  const s = data.summary;

  // 运行环境（虚拟化）说明：跑在虚机/云主机/容器上时，CPU、内存、磁盘 IO 都是
  // 虚拟化层呈现的数值，与物理机的解读方式不同，必须在报告最显眼处讲清楚。
  const virt = (data.checks || [])
    .map((c) => c.meta && c.meta.virtualization)
    .find((v) => v && v.virtualized);
  const envBanner = virt
    ? `
  <div class="scope-banner env-banner">
    <div class="scope-title">运行环境</div>
    <div class="scope-body">
      目标数据库运行在 <b>${esc(virt.label)}</b> 上，<b>并非物理机</b>。
      <div class="scope-sub">
        CPU 使用率、内存容量、磁盘 IO 与 IOPS 等指标都是<b>虚拟化层呈现的数值</b>：
        会受宿主机负载、CPU 超分、同宿主机其他虚机（"邻居"）以及存储后端（网络存储 / 云盘）影响，
        波动比物理机更大、峰值也更容易失真。
        因此本报告中「资源使用与参数合理性分析」的阈值判断、以及任何基于 IOPS 的容量结论，
        请结合虚拟化层或云平台的实际规格与监控数据一并判断，不要直接套用物理机的经验阈值。
        ${
          virt.kind === 'container'
            ? '另外这是<b>容器环境</b>：看到的 CPU 核数与内存可能只是 cgroup 限额，并不代表宿主机整机资源。'
            : ''
        }
      </div>
    </div>
  </div>`
    : '';

  const cards = [
    ['crit', s.crit, '严重'],
    ['warn', s.warn, '警告'],
    ['ok', s.ok, '正常'],
    ['info', s.info, '信息'],
    ['na', s.na || 0, '不适用'],
    ['error', s.error, '未取到'],
  ]
    .map(
      ([k, v, t]) => `
      <div class="card ${k}">
        <div class="card-num">${v}</div>
        <div class="card-label">${t}</div>
      </div>`
    )
    .join('');

  const issuesHtml = data.issues.length
    ? data.issues.map((c, i) => renderIssue(c, i + 1)).join('')
    : `<div class="all-good">✅ 本次巡检未发现严重或警告级别问题。</div>`;

  // 分组渲染：**整组都是「不适用」的收进一个折叠块**。
  // 为什么折叠而不是直接不显示：「不适用」是**判定结果**，不是「没这个功能」。
  // 部署形态识别的依据是「未发现集群特征视图」——万一目标其实是 DMDSC、
  // 只是当前账号读不到那几个视图，工具就会误判为单实例，这 11 项随之变「不适用」。
  // 整段删掉的话，报告看起来就是一份干净的单实例报告，读者无从怀疑形态识别错了。
  // 折叠后：阅读路径干净，判定与依据仍在（展开即可核对）。
  const allNa = (g) => g.items.length > 0 && g.items.every((c) => c.status === 'na');
  const normalGroups = data.groups.filter((g) => !allNa(g));
  const naGroups = data.groups.filter(allNa);
  const naCount = naGroups.reduce((a, g) => a + g.items.length, 0);
  const mode = (data.checks.find((c) => c.id === 'basic.topology') || {}).meta;

  const groupsHtml = normalGroups
    .map((g) => {
      const items = g.items.map((c) => renderCheckBlock(c, '')).join('');
      return `<section class="group"><h3>${esc(g.name)}<span class="group-cnt">${g.items.length} 项</span></h3>${items}</section>`;
    })
    .join('');

  const naGroupsHtml = naGroups.length
    ? `
      <details class="na-wrap">
        <summary>
          不适用项（${naCount} 项）——当前部署形态为「${esc((mode && mode.mode) || '按部署形态识别结果')}」，
          以下集群专项未执行；展开可核对判定依据
        </summary>
        <p class="hint">
          这些项不是「没问题」，而是<b>在当前形态下不适用</b>。若你确认目标其实是集群，
          请先核对报告开头的「部署形态识别」——形态判错的常见原因是当前账号读不到集群特征视图。
        </p>
        ${naGroups
          .map((g) => {
            const items = g.items.map((c) => renderCheckBlock(c, '')).join('');
            return `<section class="group"><h3>${esc(g.name)}<span class="group-cnt">${g.items.length} 项</span></h3>${items}</section>`;
          })
          .join('')}
      </details>`
    : '';

  const sqlAppendix = data.checks
    .map(
      (c) => `
      <details class="sqlitem">
        <summary>
          <span class="badge ${LEVEL_CLASS[c.status] || 'info'}">${LEVEL_TEXT[c.status]}</span>
          ${esc(c.group)} / ${esc(c.title)}
        </summary>
        ${c.sqlUsed ? `<pre>${esc(c.sqlUsed)}</pre>` : `<p class="empty">未成功执行 SQL：${esc(c.error || '')}</p>`}
        ${c.sqlCount > 1 ? `<p class="hint">该项准备了 ${c.sqlCount} 套兼容 SQL，以上为实际生效的一套。</p>` : ''}
      </details>`
    )
    .join('');

  const logHtml = (data.log || []).map((l) => `<div class="logline">${esc(l)}</div>`).join('');

  const fatalHtml = data.fatal
    ? `<div class="fatal"><b>连接失败：</b>${esc(data.fatal)}<p>未执行任何巡检项，本报告没有任何巡检结论。请检查 IP / 端口 / 用户名 / 口令，以及防火墙与 dm_svc.conf 配置。</p></div>`
    : data.noData
    ? `<div class="fatal"><b>本次巡检未采集到任何数据：</b>所有巡检项均未成功执行，本报告没有任何巡检结论。<p>请检查账号权限（建议使用 SYSDBA 或具备 DBA / VTI 角色的账号）与网络连通性。</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>达梦 DM 数据库巡检报告 - ${esc(m.host)}:${esc(m.port)} - ${esc(m.finishedAt)}</title>
<style>
  :root{
    --bg:#f5f7fa; --fg:#1f2937; --muted:#6b7280; --line:#e5e7eb; --card:#ffffff;
    --crit:#dc2626; --warn:#d97706; --ok:#059669; --info:#2563eb; --error:#6b7280;
    --crit-bg:#fef2f2; --warn-bg:#fffbeb; --ok-bg:#ecfdf5; --info-bg:#eff6ff; --error-bg:#f9fafb;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",Helvetica,Arial,sans-serif;
    font-size:14px;line-height:1.65}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
  .hero{display:flex;align-items:center;justify-content:space-between;gap:24px;
    background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-radius:14px;padding:26px 28px;
    box-shadow:0 8px 24px rgba(37,99,235,.22)}
  .hero h1{margin:0 0 8px;font-size:24px;letter-spacing:.5px}
  .hero .sub{font-size:13px;opacity:.92}
  .hero .sub b{font-weight:600}
  .cards{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin:22px 0}
  .card{background:var(--card);border-radius:12px;padding:16px 18px;border:1px solid var(--line);
    box-shadow:0 1px 3px rgba(16,24,40,.05)}
  .card-num{font-size:26px;font-weight:700;line-height:1.2}
  .card-label{font-size:13px;color:var(--muted);margin-top:2px}
  .card.crit .card-num{color:var(--crit)} .card.warn .card-num{color:var(--warn)}
  .card.ok .card-num{color:var(--ok)} .card.info .card-num{color:var(--info)}
  .card.error .card-num{color:var(--error)}
  h2{font-size:18px;margin:34px 0 14px;padding-left:11px;border-left:4px solid #2563eb}
  h3{font-size:15px;margin:22px 0 10px;color:#111827;display:flex;align-items:center;gap:8px}
  .group-cnt{font-size:12px;font-weight:400;color:var(--muted)}
  /* 整组「不适用」的折叠块：默认收起，正文只留一行摘要，展开可核对判定依据 */
  .na-wrap{margin:26px 0 0;border:1px dashed var(--line);border-radius:10px;padding:12px 16px;
    background:#fafbfc}
  .na-wrap>summary{cursor:pointer;font-size:13.5px;color:#475569;font-weight:600}
  .na-wrap>summary::marker{color:var(--muted)}
  .na-wrap[open]>summary{margin-bottom:6px}
  .na-wrap>.hint{margin:2px 0 10px}
  .issue{background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:10px;
    padding:13px 16px;margin-bottom:10px}
  .issue.crit{border-left-color:var(--crit);background:var(--crit-bg)}
  .issue.warn{border-left-color:var(--warn);background:var(--warn-bg)}
  .issue-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .issue-title{font-weight:600}
  .issue-group{font-size:12px;color:var(--muted);margin-left:auto}
  .issue-body{margin-top:6px;color:#374151;white-space:pre-line}
  .issue-advice{margin-top:6px;font-size:13px;color:#4b5563;background:rgba(255,255,255,.7);
    border-radius:6px;padding:7px 10px}
  .badge{display:inline-block;font-size:12px;line-height:18px;padding:0 8px;border-radius:9px;
    color:#fff;white-space:nowrap;font-weight:500}
  .badge.crit{background:var(--crit)} .badge.warn{background:var(--warn)}
  .badge.ok{background:var(--ok)} .badge.info{background:var(--info)} .badge.error{background:var(--error)}
  .badge.na{background:#94a3b8}
  .card.na .card-num{color:#94a3b8}
  .check-msg.na{background:#f1f5f9;color:#475569}
  .all-good{background:var(--ok-bg);border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:14px 16px}
  /* 适用范围声明：置于最显眼位置 */
  .scope-banner{background:#fff7ed;border:1px solid #fdba74;border-left:6px solid #ea580c;    border-radius:12px;padding:15px 20px;margin-bottom:18px}
  .scope-title{font-weight:700;color:#9a3412;font-size:15px;margin-bottom:5px}
  .scope-body{color:#7c2d12;font-size:13.5px;line-height:1.75}
  .scope-body b{color:#9a3412}
  .scope-sub{margin-top:5px;font-size:12.5px;color:#9a3412;opacity:.88}
  .env-banner{background:#eff6ff;border-color:#93c5fd;border-left-color:#2563eb}
  .env-banner .scope-title{color:#1e40af}
  .env-banner .scope-body{color:#1e3a8a}
  .env-banner .scope-sub{color:#1e40af}

  /* 百分比进度条单元格 */
  .pct-cell{min-width:132px}
  .pct{display:flex;align-items:center;gap:8px;justify-content:flex-end}
  .pct-track{flex:0 0 62px;height:6px;background:#e5e7eb;border-radius:4px;overflow:hidden}
  .pct-fill{height:100%;border-radius:4px;background:#10b981}
  .pct-fill.warn{background:#f59e0b}
  .pct-fill.crit{background:#dc2626}
  .pct-num{font-variant-numeric:tabular-nums;font-weight:600;min-width:52px;text-align:right}
  .pct-num.warn{color:#b45309}
  .pct-num.crit{color:#b91c1c}

  /* 分组表格（如：各表空间 Top 10 对象） */
  .gsub{margin-top:12px}
  .gsub-head{font-size:13px;color:#334155;background:#f1f5f9;border:1px solid var(--line);
    border-bottom:none;border-radius:8px 8px 0 0;padding:7px 12px}
  .gsub-head b{font-weight:700}
  .gsub-cnt{float:right;color:var(--muted);font-size:12px}
  .gsub .tbl-wrap{margin-top:0;border-radius:0 0 8px 8px}

  .check{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .check-head{display:flex;align-items:center;gap:9px}
  .check-title{font-weight:600}
  .check-desc{font-size:12.5px;color:var(--muted);margin-top:3px}
  /* pre-line：把巡检结论里的换行渲染成真正的换行，
     用于「已扫描的日志文件」「日志位置依据」这类逐条清单 */
  .check-msg{margin-top:9px;padding:8px 11px;border-radius:7px;font-size:13.5px;background:#f3f4f6;white-space:pre-line}
  .check-msg.crit{background:var(--crit-bg);color:#991b1b}
  .check-msg.warn{background:var(--warn-bg);color:#92400e}
  .check-msg.ok{background:var(--ok-bg);color:#065f46}
  .check-msg.info{background:var(--info-bg);color:#1e40af}
  .check-msg.error{background:var(--error-bg);color:#4b5563}
  .check-advice{margin-top:8px;font-size:12.5px;color:#4b5563;background:#f9fafb;border-radius:7px;padding:7px 10px}
  .kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-top:10px}
  .kv-item{background:#f9fafb;border:1px solid var(--line);border-radius:7px;padding:7px 10px}
  .kv-k{font-size:12px;color:var(--muted)}
  .kv-v{font-weight:600;word-break:break-all}
  .tbl-wrap{overflow-x:auto;margin-top:10px;border:1px solid var(--line);border-radius:8px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{padding:7px 11px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{background:#f3f4f6;font-weight:600;font-size:12.5px;color:#374151;position:sticky;top:0}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#f9fafb}
  tr.row-crit{background:var(--crit-bg)} tr.row-crit td{color:#991b1b;font-weight:600}
  tr.row-warn{background:var(--warn-bg)} tr.row-warn td{color:#92400e}
  .null{color:#d1d5db}
  .empty{color:var(--muted);font-size:13px;margin:10px 0 0}
  .hint{font-size:12px;color:var(--muted)}
  .fatal{background:var(--crit-bg);border:1px solid #fecaca;color:#991b1b;border-radius:10px;
    padding:14px 16px;margin:20px 0}
  .fatal p{margin:6px 0 0;color:#7f1d1d;font-size:13px}
  details.sqlitem{background:var(--card);border:1px solid var(--line);border-radius:8px;
    padding:9px 13px;margin-bottom:8px}
  details.sqlitem summary{cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px}
  details.sqlitem pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:8px;
    overflow-x:auto;font-size:12.5px;line-height:1.6;margin:10px 0 4px;
    font-family:"Cascadia Mono",Consolas,"Courier New",monospace;white-space:pre-wrap;word-break:break-word}
  .logbox{background:#0f172a;color:#94a3b8;border-radius:10px;padding:14px 16px;font-size:12.5px;
    font-family:"Cascadia Mono",Consolas,monospace;max-height:260px;overflow:auto}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
  footer p{margin:4px 0}
  @media (max-width:820px){.cards{grid-template-columns:repeat(2,1fr)}.hero{flex-direction:column;align-items:flex-start}}
  @media print{
    body{background:#fff}
    .wrap{max-width:none;padding:0}
    .hero{box-shadow:none;border-radius:0}
    .check,.issue,.card{break-inside:avoid;page-break-inside:avoid;box-shadow:none}
    details.sqlitem{display:none}
    h2{break-after:avoid}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="scope-banner">
    <div class="scope-title">适用范围</div>
    <div class="scope-body">
      支持 <b>DM8/9 单实例</b>、<b>数据守护集群（主备）</b>、<b>共享存储集群 DMDSC</b>；未覆盖 <b>DMDPC</b>。
      <div class="scope-sub">
        集群级指标由「数据守护集群」「共享存储集群」两组专项巡检项覆盖；形态不匹配的巡检项标注为「不适用」。
      </div>
    </div>
  </div>
${envBanner}

  <header class="hero">
    <div>
      <h1>达梦 DM 数据库巡检报告</h1>
      <div class="sub">
        目标实例：<b>${esc(m.host)}:${esc(m.port)}</b>　｜　巡检账号：<b>${esc(m.user)}</b>　｜　
        连接方式：<b>${esc(m.driverName || m.driverId)}</b>${m.serverInfo ? '　｜　服务端：<b>' + esc(m.serverInfo) + '</b>' : ''}<br>
        巡检时间：<b>${esc(m.startedAt)}</b>　｜　耗时：<b>${(m.durationMs / 1000).toFixed(2)} 秒</b>　｜　
        巡检项：<b>${s.total}</b> 项
      </div>
    </div>
  </header>

  ${fatalHtml}

  <div class="cards">${cards}</div>

  <h2>问题清单</h2>
  ${issuesHtml}

  <h2>巡检明细</h2>
  ${groupsHtml}
  ${naGroupsHtml}

  <h2>附录一：巡检执行日志</h2>
  <div class="logbox">${logHtml || '<div class="logline">无日志</div>'}</div>

  <h2>附录二：执行的 SQL（便于复核）</h2>
  ${sqlAppendix}

  <footer>
    <p>本报告由「${esc(m.tool)}」自动生成，生成时间 ${esc(m.finishedAt)}。</p>
    <p>说明：判定阈值默认取通用经验值（表空间使用率告警/严重阈值、Top 类巡检项条数、慢 SQL 阈值可在页面「高级选项」中调整），请结合业务重要性、SLA 与贵司运维规范综合判断。</p>
    <p>说明：报告中不含数据库口令。所有查询均为只读查询，未对数据库做任何修改。</p>
    <p>说明：达梦各小版本系统视图存在差异，个别巡检项可能因视图不存在或权限不足而显示“未取到”，属预期行为，可参考报告中的失败原因。</p>
  </footer>
</div>
</body>
</html>`;
}

/**
 * 取出单节点报告的样式与正文，并把 DOM id 加上前缀。
 * ---------------------------------------------------------------------------
 * 集群报告 = 集群总览 + N 份节点正文。这里刻意**复用 renderReport 的输出**，
 * 而不是另写一套节点渲染：两条渲染路径一旦分开，迟早会跑偏（改了一边忘了另一边），
 * 而报告恰恰是最需要稳定的部分。
 * 前缀用于避免多节点 id 冲突（每个巡检项都有 id="check-<id>"）。
 */
function splitSingleReport(html) {
  const cssStart = html.indexOf('<style>');
  const cssEnd = html.indexOf('</style>');
  const wrapStart = html.indexOf('<div class="wrap">');
  const footEnd = html.lastIndexOf('</footer>');
  if (cssStart < 0 || cssEnd < 0 || wrapStart < 0 || footEnd < 0) return null;
  return {
    css: html.slice(cssStart, cssEnd + '</style>'.length),
    body: html.slice(wrapStart + '<div class="wrap">'.length, footEnd + '</footer>'.length),
  };
}

/** 渲染单个节点的正文片段（供集群报告复用） */
function renderNodeFragment(data, idPrefix) {
  const parts = splitSingleReport(renderReport(data));
  if (!parts) return null;
  return {
    css: parts.css,
    body: parts.body.replace(/id="check-/g, `id="${esc(idPrefix)}check-`),
  };
}

const fmtPct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(2) + '%');

/** 级别严重度排序：多节点取「最差的那个」作为该巡检项的总体级别 */
const SEV_RANK = { crit: 5, warn: 4, error: 3, info: 2, ok: 1, na: 0 };
function worstStatus(list) {
  return list.reduce((a, b) => ((SEV_RANK[b] || 0) > (SEV_RANK[a] || 0) ? b : a), 'na');
}

/**
 * 哪些巡检项属于「库级」（集群级）。
 * ---------------------------------------------------------------------------
 * 三类：
 *  1) 数据守护集群、共享存储集群两组读的是**同一份集群数据**，从哪个节点读都一样；
 *  2) 实例身份与库属性类 —— 版本类型、归档模式、字符集/页大小/大小写敏感、授权有效期、
 *     关键参数快照、与默认值不同的参数。这些描述的是「这个库是什么样」；
 *  3) **库里的对象类** —— 表空间与数据文件、对象与统计信息、索引碎片率，
 *     读的是同一份数据字典/同一批数据文件，也不是「这个节点在做什么」。
 * 其余项目（会话、内存、缓冲池、线程、各实例的 SQL 运行时状态、OS 指标…）是**节点级**的，
 * 必须按节点并列展示。
 *
 * 一句话判据：看这一项问的是「库里有什么」还是「这个节点在干什么」。
 * 前者各节点同源，后者各节点独立。
 *
 * 注意：库级项虽然只展示一次，但**各节点取值不一致时会单独提示**
 * （见 renderClusterReport 中的 libdiff），不能因为「只显示一次」就把差异悄悄吞掉。
 *
 * ---------------------------------------------------------------------------
 * 两种集群形态下「为什么可能不一致」的原因**不同**，不要混为一谈：
 *   · DMDSC（共享存储集群）：多个 EP 对等访问**同一份**数据文件与数据字典，
 *     没有主库/备库，也没有日志重演。所以字典类项本就应当一致，
 *     出现不一致说明确有异常（例如读取时正好赶上 DDL）。
 *   · 数据守护（主备）：备库靠 redo 持续追平主库，本来就是**异步**的，
 *     因此可能短暂不一致（主库刚建的用户/刚授的权限还没同步过去）。
 *     这种不一致是正常的过渡态，但报告仍应把它显式说出来。
 */
const CLUSTER_LEVEL_IDS = new Set([
  'basic.topology',
  'basic.build',
  'basic.database',
  'basic.charset',
  'basic.license',
  'basic.params',
  'db.param_diff',
  // 归档配置属于库级配置，各节点相同
  'log.archini',
  // 索引碎片率读的是 DBA_INDEXES（数据字典里的索引定义与占用空间），
  // 属于「库里的对象」，不是「这个节点在做什么」。与「SQL 性能」里其余项
  // （慢 SQL / SQL 历史 / SQL 缓存项）是两回事——那些是各实例自己的运行时状态。
  'sql.indexfrag',
  // 「用户与安全」「作业与备份」里**读数据字典**的那几项：DBA_USERS / SYSUSERS /
  // DBA_ROLE_PRIVS / DBA_SYS_PRIVS / SYSJOB.SYSJOBS 都是同一份数据字典，
  // 各节点读到的是同一个库的用户、权限与作业定义（DMDSC 下各 EP 共享同一份字典，
  // 数据守护下备库是同一份字典的副本）。
  // 同组里另外四项**不在这里**：
  //   · sec.audit / backup.path 读 V$DM_INI —— dm.ini 是**每个实例各一份**，
  //     不随集群形态而共享；
  //   · job.history / backup.sets 读的是执行历史（SYSJOBHISTORIES2 / V$BACKUPSET）——
  //     这两项**尚未在两节点上实测比对过**，保持节点级是保守选择，
  //     等 `node tools/_compare-nodes.js "用户与安全" "作业与备份"` 拿到证据再定。
  'sec.users',
  'sec.pwdpolicy',
  'sec.privileges',
  'job.list',
]);
/**
 * 整组都是库级的巡检项。
 * - 数据守护集群：读的是同一份守护关系数据；
 * - 表空间与数据文件：表空间与数据文件本身就放在共享存储上，是**同一份数据**，
 *   真机两节点逐项比对（使用率/状态/文件明细/剩余空间/Top N 对象）结果完全一致。
 * - 对象与统计信息：对象、索引、统计信息、序列都存在同一份数据字典里，
 *   同样属于「库里的东西」而不是「节点的状态」。真机两节点逐项比对 8 项全部一致
 *   （无效对象/无效索引/无效分区索引/统计信息/无主键表/碎片表/序列使用率/对象数量），
 *   且重复取数两次结论稳定，故整组按库级处理。
 */
const CLUSTER_LEVEL_GROUPS = new Set(['数据守护集群', '表空间与数据文件', '对象与统计信息']);

/**
 * 注意：「日志与归档」**不能整组**当库级，要逐项看。
 * 保持节点级的（真机两节点实测取值不同）：
 *   - log.redofiles  redo 文件：每个 EP 各有自己的一组，节点1 是 DSC01_log1/2.log、
 *                    节点2 是 DSC02_log1/2.log（虽然都放在共享存储 +DMLOG/log/ 上）
 *   - log.rlog       LSN 与检查点：各实例独立推进（实测序列号 131337 vs 94558）
 *   - log.scan       日志扫描：各节点扫的是自己的日志文件
 *   - log.instance_history  各实例自己的异常日志（实测节点1 有 1 条 ERROR、节点2 没有）
 * 库级的：log.archini 归档配置 —— 属于库级配置，各节点相同（见 CLUSTER_LEVEL_IDS）。
 *
 * 一句话判据：**「在共享存储上」不等于「数据相同」**。
 * 表空间/数据文件是同一份数据，所以一致；redo 文件只是「放的地方相同」，
 * 每个节点写的是自己那组文件。
 */
/**
 * 共享存储集群里，哪些是真正的「集群共享数据」。
 * 不能把整组都当成库级：`V$DSC_REQUEST_STATISTIC`（各节点自己的请求统计）
 * 与 `V$DSC_LBS_POOL`（**本地**缓冲系统控制块，见 dsc.register）都是**每节点独立**的，
 * 真机两节点实测差异明显（请求量 10.3M vs 3.08M），必须按节点并列展示。
 * 真正从哪个节点读都一样的只有：节点列表、DCR 组、ASM 磁盘组与磁盘。
 */
const DSC_LIBRARY_IDS = new Set(['dsc.nodes', 'dsc.dcrgroup', 'dsc.asmgroup', 'dsc.asmdisk']);
const isClusterLevel = (c) =>
  CLUSTER_LEVEL_IDS.has(c.id) || CLUSTER_LEVEL_GROUPS.has(c.group) || DSC_LIBRARY_IDS.has(c.id);

/**
 * 这些库级项「本应各节点完全一致」，不一致就是真问题，值得单独提示。
 * 其余库级项（守护链路状态、集群计数器，如 dsc.register 的控制块空闲数）
 * 本身就是动态或按角色不同的，各节点有差异属正常，不提示。
 */
const MUST_MATCH_IDS = new Set([
  'basic.topology',
  'basic.build',
  'basic.database',
  'basic.charset',
  'basic.license',
  'basic.params',
  'db.param_diff',
  'dsc.nodes',
  'dsc.dcrgroup',
  'dsc.asmgroup',
  'dsc.asmdisk',
  // 表空间与数据文件是同一份共享数据，各节点必须一致
  'ts.usage',
  'ts.status',
  'ts.datafiles',
  'ts.datafile_pages',
  'ts.segments',
  // 对象与统计信息同理：同一份数据字典，各节点本应一致。
  // DMDSC 下各 EP 共享同一份字典，不一致就是异常；数据守护下备库追平日志，
  // 可能出现短暂不一致。两种情况都由 libdiff 显式提示，
  // 而不是因为「只展示一次」把差异悄悄吞掉。
  'obj.invalid',
  'obj.invalid_index',
  'obj.invalid_part_index',
  'obj.stats',
  'obj.nopk',
  'obj.frag_table',
  'obj.seq_usage',
  'obj.count',
  // 索引碎片率同样来自数据字典
  'sql.indexfrag',
  // 用户/权限/作业定义同样是同一份数据字典 → 各节点本应一致。
  // 加进这里有个关键作用：万一真的不一致（DMDSC 下说明有异常；
  // 数据守护下多为备库尚未追平），报告会**显式提示差异**，
  // 而不是因为「只展示一次」把差异藏起来。
  'sec.users',
  'sec.pwdpolicy',
  'sec.privileges',
  'job.list',
  'log.archini',
]);

/**
 * 集群 / 多节点报告。
 * ---------------------------------------------------------------------------
 * 结构：适用范围 → 集群总览（横向对照表）→ 各节点分节（每节复用单节点正文）。
 * 节点正文用 <details> 折叠，默认展开第一个节点，避免一打开就是几百屏。
 */
function renderClusterReport(cluster) {
  const first = cluster.nodes[0];
  const frag0 = renderNodeFragment(first.data, `n${0}_`);
  const css = frag0 ? frag0.css : '';

  const overviewRows = cluster.nodes
    .map((n, i) => {
      const f = n.info;
      const flag = f.fatal || f.noData ? '<span class="pill bad">未完成</span>' : '';
      return `
      <tr>
        <td><a href="#node-${i}">${esc(f.label)}</a></td>
        <td>${esc(f.role)}</td>
        <td>${esc(f.instanceName || '—')}</td>
        <td>${esc(f.hostName || f.host)}</td>
        <td>${esc(f.dbStatus || '—')}</td>
        <td>${f.archMode ? esc(f.archMode) : '—'}</td>
        <td>${fmtPct(f.tsMaxPct)}${f.tsMaxName ? ' <span class="dim">' + esc(f.tsMaxName) + '</span>' : ''}</td>
        <td class="num crit">${f.summary.crit}</td>
        <td class="num warn">${f.summary.warn}</td>
        <td class="num">${f.summary.error}</td>
        <td>${flag || '—'}</td>
      </tr>`;
    })
    .join('');

  // 节点之间最容易出问题的地方：同名对象/参数不一致。这里只做「能直接看出来」的对比。
  const roleList = cluster.nodes.map((n) => n.info.role);
  const dupRole = roleList.some((r, i) => r !== '未知' && roleList.indexOf(r) !== i);
  const warnings = [];
  if (dupRole) warnings.push('存在角色相同或无法区分的节点，请确认节点列表是否填重。');
  const badNodes = cluster.nodes.filter((n) => n.info.fatal || n.info.noData);
  if (badNodes.length) {
    warnings.push(
      `有 ${badNodes.length} 个节点未采集到数据：${badNodes.map((n) => n.info.label).join('、')}。` +
        '这些节点的结论缺失，不能当成「没有问题」。'
    );
  }
  const freshNodes = cluster.nodes.filter((n) => {
    const t = (n.data.checks || []).find((c) => c.id === 'basic.topology');
    return t && t.rows && t.rows.length;
  });
  if (cluster.deployMode === '多节点（未识别出集群特征）' && freshNodes.length) {
    warnings.push('各节点均未识别出集群特征视图，请确认这些实例确实属于同一集群。');
  }

  // ---------------- 巡检明细：按「巡检项」组织，每项下并列各节点结论 ----------------
  // 以第一个节点的巡检项顺序为准（所有节点跑的是同一套 85 项），
  // 再补上其它节点可能独有的项，保证不漏。
  const order = [];
  const seenIds = new Set();
  for (const n of cluster.nodes) {
    for (const c of n.data.checks || []) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        order.push(c);
      }
    }
  }
  const groupOrder = [];
  const groupMap = new Map();
  for (const c of order) {
    if (!groupMap.has(c.group)) {
      groupMap.set(c.group, []);
      groupOrder.push(c.group);
    }
    groupMap.get(c.group).push(c);
  }

  const levels = (list) => list.map((x) => x.c.status);
  const groupBlocks = groupOrder
    .map((gname) => {
      const items = groupMap
        .get(gname)
        .map((meta) => {
          const per = cluster.nodes
            .map((n) => ({
              node: n,
              c: (n.data.checks || []).find((x) => x.id === meta.id) || null,
            }))
            .filter((x) => x.c);
          if (!per.length) return '';

          // 库级指标（部署形态、数据守护、DMDSC 各组）：各节点读到的是同一份集群数据，
          // 只展示一次；优先挑真正取到数据的节点，避免拿一个「不适用」的节点当代表。
          if (isClusterLevel(meta)) {
            const pick = per.find((x) => x.c.status !== 'na' && x.c.status !== 'error') || per[0];
            // 只展示一次，但各节点取值不一致时必须说出来 ——
            // 主备/各 EP 之间版本、归档模式、关键参数不一致，恰恰是最该被发现的
            const distinct = [...new Set(per.map((x) => String(x.c.message || '')))];
            const diffHtml =
              distinct.length > 1 && MUST_MATCH_IDS.has(meta.id)
                ? `<div class="libdiff"><b>注意：本项为库级指标，各节点本应一致，但取值不同</b>，请逐节点核对：
                    ${per
                      .map(
                        (x) =>
                          `<div>· <b>${esc(x.node.info.label)}</b>：${esc(
                            String(x.c.message || '').replace(/\s+/g, ' ').slice(0, 220)
                          )}</div>`
                      )
                      .join('')}</div>`
                : '';
            return `
        <div class="libnote">库级指标，只展示一次，取自 <b>${esc(pick.node.info.label)}</b></div>
        ${diffHtml}
        ${renderCheckBlock(pick.c, 'lib-')}`;
          }

          const worst = worstStatus(levels(per));
          const cls = LEVEL_CLASS[worst] || 'info';
          // 各节点结论完全相同时只写一遍，避免 N 份重复文字（这正是「重复」的来源之一）
          const msgs = [...new Set(per.map((x) => String(x.c.message || '')))];
          const sameMsg = msgs.length === 1;

          const headCells = sameMsg ? '<th>节点</th><th>角色</th><th>级别</th>' : '<th>节点</th><th>角色</th><th>级别</th><th>结论</th>';
          const bodyRows = per
            .map((x) => {
              const c2 = LEVEL_CLASS[x.c.status] || 'info';
              const msgCell = sameMsg ? '' : `<td class="msgcell">${esc(x.c.message || '')}</td>`;
              return `<tr>
                <td class="nlabel">${esc(x.node.info.label)}</td>
                <td class="dim">${esc(x.node.info.role || '')}</td>
                <td><span class="badge ${c2}">${LEVEL_TEXT[x.c.status] || ''}</span></td>
                ${msgCell}
              </tr>`;
            })
            .join('');

          const dataHtml = per
            .map((x) => {
              const has = (x.c.rows && x.c.rows.length) || (x.c.columns && x.c.columns.length);
              if (!has) return '';
              return `<h4 class="nodedata-h">${esc(x.node.info.label)} <span class="dim">${esc(
                x.node.info.role || ''
              )}</span></h4>${renderCheckData(x.c)}`;
            })
            .filter(Boolean)
            .join('');

          return `
        <div class="check" id="check-${esc(meta.id)}">
          <div class="check-head">
            <span class="badge ${cls}">${LEVEL_TEXT[worst] || ''}</span>
            <span class="check-title">${esc(meta.title)}</span>
            <span class="group-cnt">${per.length} 个节点</span>
          </div>
          ${meta.desc ? `<div class="check-desc">${esc(meta.desc)}</div>` : ''}
          ${sameMsg ? `<div class="check-msg ${cls}">${esc(msgs[0])}</div>` : ''}
          <table class="node-cmp">
            <thead><tr>${headCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
          ${dataHtml ? `<details class="node-data"><summary>展开各节点明细数据</summary>${dataHtml}</details>` : ''}
          ${
            worst === 'crit' || worst === 'warn'
              ? meta.advice
                ? `<div class="check-advice"><b>整改建议：</b>${esc(meta.advice)}</div>`
                : ''
              : ''
          }
        </div>`;
        })
        .join('');
      return {
        gname,
        allNa: groupMap.get(gname).every((meta) =>
          cluster.nodes.every((n) => {
            const c = (n.data.checks || []).find((x) => x.id === meta.id);
            return !c || c.status === 'na';
          })
        ),
        html: `<section class="group"><h3>${esc(gname)}<span class="group-cnt">${
          groupMap.get(gname).length
        } 项</span></h3>${items}</section>`,
      };
    });

  // 整组「不适用」的收进折叠块，理由同单节点报告：
  // 「不适用」是判定结果（部署形态识别说了算），不是「没这个功能」，
  // 整段删掉会让形态判错时无从察觉；折叠则兼顾可读性与可核对性。
  const naBlockCount = groupBlocks.filter((b) => b.allNa).reduce((a, b) => a + groupMap.get(b.gname).length, 0);
  const groupHtml = groupBlocks.filter((b) => !b.allNa).map((b) => b.html).join('');
  const naGroupHtml = naBlockCount
    ? `
      <details class="na-wrap">
        <summary>
          不适用项（${naBlockCount} 项）——当前部署形态为「${esc(cluster.deployMode)}」，
          以下集群专项未执行；展开可核对判定依据
        </summary>
        <p class="hint">
          这些项不是「没问题」，而是<b>在当前形态下不适用</b>。若你确认目标其实是另一种形态，
          请先核对报告开头的「部署形态识别」——形态判错的常见原因是当前账号读不到集群特征视图。
        </p>
        ${groupBlocks.filter((b) => b.allNa).map((b) => b.html).join('')}
      </details>`
    : '';

  // ---------------- 问题清单（汇总各节点，带节点名） ----------------
  const allIssues = [];
  for (const n of cluster.nodes) {
    for (const i of n.data.issues || []) {
      allIssues.push({ node: n.info.label, role: n.info.role, issue: i });
    }
  }
  allIssues.sort((a, b) => (a.issue.status === b.issue.status ? 0 : a.issue.status === 'crit' ? -1 : 1));
  const issuesHtml = allIssues.length
    ? allIssues
        .map(
          ({ node, role, issue }, i) => `
      <div class="issue ${issue.status === 'crit' ? 'crit' : 'warn'}">
        <div class="issue-head">
          <span class="issue-no">${i + 1}</span>
          <span class="badge ${issue.status === 'crit' ? 'crit' : 'warn'}">${issue.status === 'crit' ? '严重' : '警告'}</span>
          <span class="issue-node">${esc(node)}</span>
          <span class="issue-group">${esc(issue.group)} / ${esc(issue.title)}</span>
        </div>
        <div class="issue-body">${esc(issue.message)}</div>
        ${issue.advice ? `<div class="issue-advice"><b>整改建议：</b>${esc(issue.advice)}</div>` : ''}
      </div>`
        )
        .join('')
    : `<div class="all-good">✅ 各节点均未发现严重或警告级别问题。</div>`;

  // ---------------- 附录一：各节点执行日志 ----------------
  const logsHtml = cluster.nodes
    .map(
      (n, i) => `
    <details class="node-data" ${i === 0 ? 'open' : ''}>
      <summary>${esc(n.info.label)} <span class="dim">${esc(n.info.role || '')}</span></summary>
      <div class="logbox">${
        (n.data.log || []).map((l) => `<div class="logline">${esc(l)}</div>`).join('') || '<div class="logline">无日志</div>'
      }</div>
    </details>`
    )
    .join('');

  // ---------------- 附录二：执行的 SQL（各节点相同，按巡检项去重） ----------------
  const sqlSeen = new Set();
  const sqlItems = [];
  for (const n of cluster.nodes) {
    for (const c of n.data.checks || []) {
      if (sqlSeen.has(c.id)) continue;
      sqlSeen.add(c.id);
      sqlItems.push(c);
    }
  }
  const sqlAppendix = sqlItems
    .map(
      (c) => `
      <details class="sqlitem">
        <summary>
          <span class="badge ${LEVEL_CLASS[c.status] || 'info'}">${LEVEL_TEXT[c.status]}</span>
          ${esc(c.group)} / ${esc(c.title)}
        </summary>
        ${c.sqlUsed ? `<pre>${esc(c.sqlUsed)}</pre>` : `<p class="empty">未成功执行 SQL：${esc(c.error || '')}</p>`}
        ${c.sqlCount > 1 ? `<p class="hint">该项准备了 ${c.sqlCount} 套兼容 SQL，以上为实际生效的一套。</p>` : ''}
      </details>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>达梦 DM 集群巡检报告 - ${esc(cluster.deployMode)} - ${esc(cluster.finishedAt)}</title>
${css}
<style>
  .cluster-hero{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin:18px 0 6px}
  .cluster-hero h1{font-size:22px;margin:0 0 8px}
  .nodeblock{border:1px solid var(--line);border-radius:10px;margin:14px 0;background:#fff}
  .nodeblock>summary{cursor:pointer;padding:12px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:14px}
  .nodeblock[open]>summary{border-bottom:1px solid var(--line)}
  .nodebody{padding:4px 14px 18px}
  .nodebody .wrap{padding:0}
  .pill{background:#eef2ff;color:#3730a3;border-radius:999px;padding:2px 9px;font-size:12px}
  .pill.bad{background:#fee2e2;color:#991b1b}
  .dim{color:var(--muted);font-size:12.5px}
  .cmp td.num{text-align:right;font-variant-numeric:tabular-nums}
  .cmp td.crit{color:#b91c1c;font-weight:600}
  .cmp td.warn{color:#b45309;font-weight:600}
  .libnote{background:#eff6ff;border-left:4px solid #60a5fa;color:#1e40af;font-size:12.5px;
    padding:7px 12px;border-radius:0 8px 8px 0;margin:14px 0 6px}
  .libdiff{background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;
    border-radius:0 8px 8px 0;padding:9px 13px;margin:0 0 8px;font-size:13px;color:#78350f;line-height:1.75}
  .libdiff b{color:#92400e}
  .node-cmp{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
  .node-cmp th{text-align:left;background:#f8fafc;color:#475569;font-weight:600;
    padding:7px 10px;border-bottom:1px solid var(--line);font-size:12.5px}
  .node-cmp td{padding:7px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  .node-cmp tr:last-child td{border-bottom:none}
  .node-cmp td.nlabel{font-weight:600;white-space:nowrap}
  .node-cmp td.msgcell{color:#475569;line-height:1.65;white-space:pre-line}
  .node-data{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:#fbfcfe}
  .node-data>summary{cursor:pointer;padding:9px 13px;font-size:13px;font-weight:600;color:#334155}
  .node-data[open]>summary{border-bottom:1px solid var(--line)}
  .node-data .node-cmp,.node-data .kv,.node-data table,.node-data .logbox{margin:12px 13px}
  .node-data .node-cmp{margin:0}
  .nodedata-h{margin:16px 13px 6px;font-size:13px;font-weight:600;color:#1e293b;
    padding-bottom:5px;border-bottom:1px dashed var(--line)}
  .nodedata-h:first-child{margin-top:12px}
  .node-data .logbox{margin:0;border:none;background:transparent}
  .warnbox{background:#fffbeb;border:1px solid #fde68a;border-left:5px solid #f59e0b;border-radius:8px;
    padding:11px 14px;margin:12px 0;font-size:13.5px;color:#78350f}
</style>
</head>
<body>
<div class="wrap">
  <div class="scope-banner">
    <div class="scope-title">适用范围</div>
    <div class="scope-body">
      支持 <b>DM8/9 单实例</b>、<b>数据守护集群（主备）</b>、<b>共享存储集群 DMDSC</b>；未覆盖 <b>DMDPC</b>。
      <div class="scope-sub">
        本次为<b>多节点巡检</b>：共 ${cluster.nodeCount} 个节点，每个节点各跑了一遍完整巡检。
        集群级指标（节点状态、ASR/DCR、ASM 磁盘组等）由各节点结果汇总；
        单实例类指标（会话、内存、缓冲池）仍然是<b>各节点各自的数值，不可跨节点相加</b>。
      </div>
    </div>
  </div>

  <header class="cluster-hero">
    <div>
      <h1>达梦 DM 集群巡检报告</h1>
      <div class="sub">
        部署形态：<b>${esc(cluster.deployMode)}</b>　｜　节点数：<b>${cluster.nodeCount}</b><br>
        巡检时间：<b>${esc(cluster.startedAt)}</b>　｜　总耗时：<b>${(cluster.durationMs / 1000).toFixed(2)} 秒</b>
      </div>
    </div>
  </header>

  ${warnings.length ? `<div class="warnbox">${warnings.map((w) => esc(w)).join('<br>')}</div>` : ''}

  <h2>集群总览</h2>
  <table class="cmp">
    <thead>
      <tr>
        <th>节点</th><th>角色</th><th>实例名</th><th>主机</th><th>状态</th><th>归档模式</th>
        <th>表空间最高使用率</th><th>严重</th><th>警告</th><th>未取到</th><th>备注</th>
      </tr>
    </thead>
    <tbody>${overviewRows}</tbody>
  </table>
  <p class="hint">
    各节点累计：严重 <b>${cluster.summary.crit}</b> ／ 警告 <b>${cluster.summary.warn}</b> ／
    正常 <b>${cluster.summary.ok}</b> ／ 信息 <b>${cluster.summary.info}</b> ／
    不适用 <b>${cluster.summary.na}</b> ／ 未取到 <b>${cluster.summary.error}</b>
    （合计 ${cluster.summary.total} 项·次）。
  </p>

  <h2>问题清单（汇总各节点）</h2>
  ${issuesHtml}

  <h2>巡检明细</h2>
  <p class="hint">
    每项巡检下并列列出各节点的结论；<b>库级指标</b>（部署形态、版本与归档、字符集、授权、
    关键参数，以及 DMDSC 的节点与 ASM 信息）各节点读数一致，只展示一次，取自第一个取到数据的节点。
    同一条结论若各节点相同，则只写一遍。
  </p>
  ${groupHtml}
  ${naGroupHtml}

  <h2>附录一：各节点巡检执行日志</h2>
  ${logsHtml}

  <h2>附录二：执行的 SQL（便于复核）</h2>
  <p class="hint">各节点执行的是同一套 SQL，此处按巡检项去重后列出一次。</p>
  ${sqlAppendix}

  <footer>
    <p>本报告由「${esc(cluster.tool)}」自动生成，生成时间 ${esc(cluster.finishedAt)}。</p>
    <p>说明：判定阈值默认取通用经验值（表空间使用率告警/严重阈值、Top 类巡检项条数、慢 SQL 阈值可在页面「高级选项」中调整），请结合业务重要性、SLA 与贵司运维规范综合判断。</p>
    <p>说明：报告中不含数据库口令。所有查询均为只读查询，未对数据库做任何修改。</p>
  </footer>
</div>
</body>
</html>`;
}

module.exports = { renderReport, renderClusterReport, renderNodeFragment, COLUMN_LABELS, label };
