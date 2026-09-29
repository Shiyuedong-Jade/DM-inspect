'use strict';
/*
 * 演示模式数据源
 * ---------------------------------------------------------------------------
 * 不连接任何数据库，用一份贴近真实生产环境的 DM8 快照数据走完整条链路，
 * 用于在没有达梦环境时预览报告样式、验证报告逻辑。
 * 数据刻意包含若干告警项（表空间 91%、缓冲池命中率偏低、锁等待、死锁历史等），
 * 以便展示报告的告警与高亮效果。
 */

function rs(columns, rows, meta) {
  const o = { columns, rows, rowCount: rows.length };
  if (meta) o.meta = meta;
  return o;
}

const DATA = {
  'basic.instance': rs(
    ['INSTANCE_NAME', 'HOST_NAME', 'START_TIME', 'STATUS', 'MODE_TYPE'],
    [['DMSERVER', 'dmdb01', '2026-01-05 09:12:33', '4', '1']]
  ),
  'basic.database': rs(
    ['DB_NAME', 'DB_STATUS', 'DB_ROLE', 'ARCH_MODE', 'LAST_CKPT_TIME', 'CREATE_TIME', 'DB_MAGIC'],
    [['DAMENG', 'OPEN', 'NORMAL', 'ARCHIVELOG', '2026-01-20 14:02:11', '2025-03-11 10:00:00', '1456789012']]
  ),
  'basic.build': rs(
    ['ID_CODE', 'BUILD_TYPE', 'INNER_VERSION'],
    [['03134284368-20250101-200209-10050', '企业版', '8.1.60.80']]
  ),
  'basic.uptime': rs(['INSTANCE_NAME', 'START_TIME', 'RUN_DAYS'], [['DMSERVER', '2026-01-05 09:12:33', '15.21']]),
  'basic.charset': rs(
    ['UNICODE_FLAG', 'CASE_SENSITIVE', 'EXTENT_SIZE', 'PAGE_SIZE_BYTES'],
    [['1', '1', '16', '8192']]
  ),
  'basic.license': rs(
    ['SERIES_NO', 'SERVER_SERIES', 'SERVER_TYPE', 'SERVER_VER', 'EXPIRED_DATE', 'AUTHORIZED_CUSTOMER', 'MAX_CPU_NUM', 'DAYS_LEFT'],
    // SERVER_VER 取真机原样（DM 8.1.5.60：授权文件里写的就是 X.X.x.x），
    // 并且带上 SQL 侧 CASE 的翻译结果——演示数据模拟的是「SQL 的返回值」，
    // 不是库里的原始列值，否则演示报告会和真实报告长得不一样。
    [['DM8-ENT-2025-0001', 'P', 'ENTERPRISE', '通配（授权文件为 X.X.x.x）', '2026-04-30', '某某集团有限公司', '64', '100']]
  ),
  'basic.params': rs(
    ['PARA_NAME', 'PARA_VALUE', 'FILE_VALUE'],
    [
      ['ARCH_INI', '1', '1'],
      ['BAK_PATH', '/dm8/backup', '/dm8/backup'],
      ['BUFFER', '4096', '4096'],
      ['COMPATIBLE_MODE', '0', '0'],
      ['ENABLE_AUDIT', '0', '0'],
      ['ENABLE_MONITOR', '1', '1'],
      ['GLOBAL_PAGE_SIZE', '8192', '8192'],
      ['MAX_BUFFER_SIZE', '8192', '8192'],
      ['MAX_CONCURRENT_TRX', '0', '0'],
      ['MAX_MEMORY', '0', '0'],
      ['MAX_SESSIONS', '1500', '1000'],
      ['MEMORY_POOL', '1024', '1024'],
      ['PWD_POLICY', '31', '31'],
      ['SORT_BUF_SIZE', '20', '10'],
      ['SVR_LOG', '0', '0'],
    ]
  ),

  'instance.systeminfo': rs(
    ['PHY_TOTAL_GB', 'PHY_FREE_GB', 'DISK_TOTAL_GB', 'DISK_FREE_GB', 'DISK_FREE_PCT', 'CPU_USER_RATE', 'CPU_SYSTEM_RATE'],
    [['128', '21.4', '2000', '412.6', '20.63', '34.28', '12.06']]
  ),
  'instance.threads': rs(
    ['THREAD_CLASS', 'CNT', 'THREADS', 'STATUS'],
    [
      ['SQL 执行线程', '24', 'DM_SQL_THREAD、DM_SQL_THREAD_2、DM_SQL_THREAD_3、DM_SQL_THREAD_4、DM_SQL_THREAD_5、DM_SQL_THREAD_6 等 24 个', '正常（存在即已启动）'],
      ['IO 线程', '8', 'IO_THREAD、IO_THREAD_2、IO_THREAD_3、IO_THREAD_4、IO_THREAD_5、IO_THREAD_6 等 8 个', '正常（存在即已启动）'],
      ['工作与任务线程', '6', 'TASK_THREAD、WORKER_THREAD、WORKER_THREAD_2、WORKER_THREAD_3、WORKER_THREAD_4、WORKER_THREAD_5', '正常（存在即已启动）'],
      ['检查点线程', '2', 'CKPT_THREAD、CKPT_THREAD_2', '正常（存在即已启动）'],
      ['归档线程', '1', 'ARCH_THREAD', '正常（存在即已启动）'],
      ['事务与回滚线程', '1', 'ROLL_THREAD', '正常（存在即已启动）'],
      ['日志与刷盘线程', '1', 'LOG_FLUSH_THREAD', '正常（存在即已启动）'],
      ['定时与作业线程', '1', 'JOB_THREAD', '正常（存在即已启动）'],
      ['通信线程', '1', 'MAL_THREAD', '正常（存在即已启动）'],
    ],
    { total: 45, archOn: true, hasArch: true, classCount: 9 }
  ),
  'instance.waitclass': rs(
    ['CLASS_NAME', 'TOTAL_WAITS'],
    [
      ['USER_IO', '184223'],
      ['CONFIGURATION', '22841'],
      ['CONCURRENCY', '9012'],
      ['COMMIT', '1120'],
      ['NETWORK', '412'],
    ]
  ),

  'ts.usage': rs(
    ['TABLESPACE_NAME', 'TOTAL_MB', 'USED_MB', 'FREE_MB', 'USED_PCT'],
    [
      ['TBS_ORDER', '512000', '465920', '46080', '91.0'],
      ['TBS_USER', '204800', '150732', '54068', '73.6'],
      ['SYSTEM', '32768', '19456', '13312', '59.38'],
      ['ROLL', '16384', '1024', '15360', '6.25'],
      ['TEMP', '16384', '0', '16384', '0'],
    ]
  ),
  'ts.status': rs(
    ['ID', 'NAME', 'TS_TYPE', 'TS_STATUS', 'TOTAL_MB', 'FILE_NUM'],
    [
      ['0', 'SYSTEM', 'DB', 'ONLINE', '32768', '1'],
      ['1', 'ROLL', 'DB', 'ONLINE', '16384', '1'],
      ['2', 'TEMP', 'TEMP', 'ONLINE', '16384', '1'],
      ['3', 'TBS_USER', 'DB', 'ONLINE', '204800', '2'],
      ['4', 'TBS_ORDER', 'DB', 'ONLINE', '512000', '4'],
    ]
  ),
  'ts.datafiles': rs(
    ['TABLESPACE_NAME', 'FILE_ID', 'FILE_NAME', 'SIZE_MB', 'AUTOEXTENSIBLE', 'MAXSIZE_MB', 'PCT_TO_MAX', 'STATUS'],
    [
      ['TBS_ORDER', '8', '/dm8/data/DAMENG/TBS_ORDER04.DBF', '262144', 'YES', '1048576', '25', '1'],
      ['TBS_ORDER', '7', '/dm8/data/DAMENG/TBS_ORDER03.DBF', '131072', 'YES', '1048576', '12.5', '1'],
      ['TBS_USER', '5', '/dm8/data/DAMENG/TBS_USER01.DBF', '204800', 'NO', '204800', '100', '1'],
      ['SYSTEM', '0', '/dm8/data/DAMENG/SYSTEM.DBF', '32768', 'YES', '1048576', '3.13', '1'],
    ]
  ),
  'ts.datafile_pages': rs(
    ['TS_ID', 'PATH', 'TOTAL_MB', 'FREE_MB', 'USED_PCT', 'AUTO_EXTEND', 'NEXT_SIZE', 'MAX_SIZE', 'STATUS$'],
    [
      ['4', '/dm8/data/DAMENG/TBS_ORDER04.DBF', '262144', '46080', '82.42', '1', '128', '1048576', '1'],
      ['3', '/dm8/data/DAMENG/TBS_USER01.DBF', '204800', '54068', '73.6', '0', '0', '204800', '1'],
      ['0', '/dm8/data/DAMENG/SYSTEM.DBF', '32768', '13312', '59.38', '1', '128', '1048576', '1'],
    ]
  ),
  'ts.segments': rs(
    ['TABLESPACE_NAME', 'OWNER', 'SEGMENT_NAME', 'SEGMENT_TYPE', 'SIZE_MB'],
    [
      ['TBS_ORDER', 'APP', 'T_ORDER_DETAIL', 'TABLE', '204800'],
      ['TBS_ORDER', 'APP', 'T_ORDER', 'TABLE', '131072'],
      ['TBS_ORDER', 'APP', 'IDX_ORDER_DETAIL_PK', 'INDEX', '65536'],
      ['TBS_ORDER', 'APP', 'T_ORDER_HIS', 'TABLE', '49152'],
      ['TBS_ORDER', 'APP', 'IDX_ORDER_CREATE_TIME', 'INDEX', '32768'],
      ['TBS_ORDER', 'APP', 'T_ORDER_ITEM', 'TABLE', '24576'],
      ['TBS_ORDER', 'APP', 'IDX_ORDER_ITEM_PK', 'INDEX', '16384'],
      ['TBS_ORDER', 'APP', 'T_ORDER_LOG', 'TABLE', '12288'],
      ['TBS_ORDER', 'APP', 'IDX_ORDER_LOG_TIME', 'INDEX', '8192'],
      ['TBS_ORDER', 'APP', 'T_ORDER_TMP', 'TABLE', '6144'],
      ['TBS_ORDER', 'APP', 'IDX_ORDER_TMP_PK', 'INDEX', '4096'],
      ['TBS_ORDER', 'APP', 'T_ORDER_BAK_2025', 'TABLE', '2048'],
      ['TBS_USER', 'APP', 'T_LOG', 'TABLE', '32768'],
      ['TBS_USER', 'APP', 'T_CUSTOMER', 'TABLE', '8192'],
      ['TBS_USER', 'APP', 'IDX_CUSTOMER_NAME', 'INDEX', '4096'],
      ['TBS_USER', 'APP', 'T_DICT', 'TABLE', '1024'],
      ['TBS_USER', 'APP', 'T_CONFIG', 'TABLE', '512'],
      ['TBS_USER', 'APP', 'T_AREA', 'TABLE', '256'],
      ['SYSTEM', 'SYS', 'SYS_TABLES', 'TABLE', '128'],
      ['SYSTEM', 'SYS', 'SYS_COLUMNS', 'TABLE', '96'],
      ['SYSTEM', 'SYS', 'SYS_INDEXES', 'TABLE', '64'],
      ['SYSTEM', 'SYS', 'SYS_OBJECTS', 'TABLE', '48'],
    ]
  ),

  'log.redofiles': rs(
    ['PATH', 'SIZE_MB'],
    [
      ['/dm8/data/DAMENG/DAMENG01.log', '256'],
      ['/dm8/data/DAMENG/DAMENG02.log', '256'],
    ]
  ),
  'log.rlog': rs(
    ['CUR_LSN', 'CKPT_LSN', 'DB_MAGIC', 'NEXT_SEQ', 'CUR_FILE'],
    [['523418632', '510032114', '1456789012', '89412', '1']]
  ),
  'log.switch': rs(
    ['LOG_HOUR', 'SWITCH_CNT'],
    [
      ['2026-01-20 14', '4'],
      ['2026-01-20 13', '5'],
      ['2026-01-20 12', '22'],
      ['2026-01-20 11', '7'],
      ['2026-01-20 10', '4'],
      ['2026-01-20 09', '3'],
    ]
  ),
  'log.archini': rs(
    ['ARCH_NAME', 'ARCH_TYPE', 'ARCH_DEST', 'ARCH_FILE_SIZE', 'ARCH_SPACE_LIMIT', 'ARCH_IS_VALID', 'ARCH_WAIT_APPLY', 'ARCH_INCOMING_PATH'],
    [['ARCH_LOCAL', 'LOCAL', '/dm8/arch', '1024', '0', 'Y', 'N', null]]
  ),
  'log.archstatus': rs(['ARCH_NAME', 'ARCH_STATUS'], [['ARCH_LOCAL', 'VALID']]),
  'log.archfile': rs(
    ['ARCH_DATE', 'FILE_CNT', 'ARCH_GB'],
    [
      ['2026-01-20', '42', '38.5'],
      ['2026-01-19', '40', '35.2'],
      ['2026-01-18', '12', '9.8'],
    ]
  ),

  'mem.bufferpool': rs(
    ['POOL_CLASS', 'POOL_CNT', 'BUFFER_MB', 'N_LOGIC_READS', 'N_PHY_READS', 'HIT_PCT', 'DISCARD', 'VERDICT'],
    [
      ['回收池（RECYCLE）', '1', '256.00', '44120', '31200', '58.58（豁免）', '41220', '设计上命中率偏低，不参与告警'],
      ['常规池（NORMAL）', '1', '4096.00', '8842133021', '612334021', '93.52', '118243', '需关注：命中率低于 95%'],
      ['常驻池（KEEP）', '1', '128.00', '1023311', '1204', '99.88', '0', '正常'],
    ],
    { totalPools: 3, pageSize: 8192 }
  ),
  'mem.mempool': rs(
    ['POOL_CLASS', 'POOL_CNT', 'TOTAL_MB', 'MAX_MB', 'BIGGEST_POOL', 'OVERFLOW_CNT', 'EXTEND_CNT', 'VERDICT'],
    [
      ['SQL 与执行计划缓存', '1', '1180.50', '1180.50', 'SQL_POOL', '0', '0', '正常'],
      ['数据字典缓存', '1', '268.25', '268.25', 'DICT_POOL', '0', '0', '正常'],
      ['排序缓存', '1', '196.50', '196.50', 'SORT_POOL', '0', '1', '需关注：发生池外扩展（N_EXTEND_EXCLUSIVE>0），疑似内存泄漏'],
      ['虚拟机与表达式', '1', '132.75', '132.75', 'VM_POOL', '0', '0', '正常'],
    ],
    { totalPools: 4 }
  ),
  'mem.total': rs(['MEMPOOL_MB', 'BUFFER_MB', 'TOTAL_DB_MEM_MB'], [['1778', '4480', '6258']]),

  'sess.summary': rs(
    ['TOTAL_SESS', 'ACTIVE_SESS', 'IDLE_SESS', 'PENDING_SESS', 'FREEING_SESS'],
    [['412', '37', '372', '3', '0']]
  ),
  'sess.maxratio': rs(['CUR_SESS', 'MAX_SESSIONS_MEM', 'MAX_SESSIONS_FILE'], [['412', '1500', '1000']]),
  'sess.byapp': rs(
    ['USER_NAME', 'APPNAME', 'CLNT_IP', 'STATE', 'CNT'],
    [
      ['APPUSER', 'order-service', '::ffff:10.20.31.15', 'IDLE', '186'],
      ['APPUSER', 'order-service', '::ffff:10.20.31.16', 'IDLE', '142'],
      ['REPORT', 'bi-tool', '::ffff:10.20.44.7', 'ACTIVE', '41'],
      ['SYSDBA', 'disql', '::ffff:10.20.9.2', 'ACTIVE', '2'],
    ]
  ),
  'sess.idletrx': rs(
    ['SESS_ID', 'USER_NAME', 'CLNT_IP', 'APPNAME', 'STATE', 'TRX_ID', 'TRX_STATUS', 'IDLE_SEC', 'SQL_TEXT', 'KILL_SQL'],
    [
      ['140238912', 'APPUSER', '::ffff:10.20.31.15', 'order-service', 'IDLE', '8842011', 'ACTIVE', '4820', 'UPDATE T_ORDER SET STATUS=1 WHERE ORDER_ID=?', 'SP_CLOSE_SESSION(140238912);'],
      ['140241007', 'APPUSER', '::ffff:10.20.31.16', 'order-service', 'IDLE', '8842098', 'ACTIVE', '912', 'DELETE FROM T_ORDER_DETAIL WHERE ORDER_ID=?', 'SP_CLOSE_SESSION(140241007);'],
    ]
  ),
  'sess.memtop': rs(
    ['SESS_ID', 'USER_NAME', 'CLNT_IP', 'STATE', 'MEM_POOL_NAME', 'TOTAL_MB', 'SQL_TEXT'],
    [
      ['140238912', 'REPORT', '::ffff:10.20.44.7', 'ACTIVE', 'SORT_POOL', '2680.5', 'SELECT * FROM T_ORDER_DETAIL ORDER BY CREATE_TIME'],
      ['140241007', 'APPUSER', '::ffff:10.20.31.16', 'ACTIVE', 'SQL_POOL', '412.25', 'SELECT COUNT(*) FROM T_LOG'],
    ]
  ),

  'lock.trxwait': rs(
    ['BLOCKED_TRX_ID', 'HOLDING_TRX_ID', 'WAIT_TIME', 'THRD_ID'],
    [
      ['8842103', '8842011', '92', '42318'],
      ['8842110', '8842011', '74', '42402'],
    ]
  ),
  'lock.blocked': rs(
    ['TRX_ID', 'TABLE_ID', 'LTYPE', 'BLOCKED', 'ROW_IDX', 'LMODE'],
    [
      ['8842103', '1082', 'OBJECT', '1', '8842011', '3'],
      ['8842110', '1082', 'OBJECT', '1', '8842011', '3'],
    ]
  ),
  'lock.trx': rs(
    ['TRX_STATUS', 'CNT'],
    [
      ['ACTIVE', '24'],
      ['LOCK WAIT', '2'],
      ['NOT START', '386'],
    ]
  ),
  'lock.longtrx': rs(
    ['SESS_ID', 'TRX_ID', 'USER_NAME', 'CLNT_IP', 'STATE', 'IDLE_SEC', 'SESS_CREATE', 'SQL_TEXT'],
    [
      ['140238912', '8842011', 'APPUSER', '::ffff:10.20.31.15', 'IDLE', '4820', '2026-01-20 13:00:12', 'UPDATE T_ORDER SET STATUS=1 WHERE ORDER_ID=?'],
    ]
  ),
  'lock.deadlock': rs(
    ['SEQNO', 'TRX_ID', 'SESS_ID', 'HAPPEN_TIME', 'SQL_TEXT', 'DEADLOCK_CYCLE'],
    [
      ['10231', '8820113', '140238912', '2026-01-19 22:14:03', 'UPDATE T_STOCK SET QTY=QTY-1 WHERE SKU=?', 'self -> (8842011, 0x7f2a) -> self'],
      ['10248', '8823440', '140241007', '2026-01-20 10:02:41', 'UPDATE T_ORDER SET AMOUNT=? WHERE ORDER_ID=?', 'self -> (8823990, 0x7f31) -> self'],
      ['10260', '8830122', '140244551', '2026-01-20 13:41:19', 'DELETE FROM T_ORDER_DETAIL WHERE ORDER_ID=?', 'self -> (8829990, 0x7f44) -> self'],
    ]
  ),

  'sql.slow_now': rs(
    ['SESS_ID', 'USER_NAME', 'CLNT_IP', 'STATE', 'EXEC_SEC', 'SQL_TEXT', 'KILL_SQL'],
    [
      ['140238912', 'REPORT', '::ffff:10.20.44.7', 'ACTIVE', '412', 'SELECT O.*, D.* FROM T_ORDER O JOIN T_ORDER_DETAIL D ON O.ORDER_ID=D.ORDER_ID WHERE O.CREATE_TIME > ? ORDER BY O.CREATE_TIME DESC', 'SP_CLOSE_SESSION(140238912);'],
      ['140241007', 'APPUSER', '::ffff:10.20.31.16', 'ACTIVE', '18', 'SELECT COUNT(*) FROM T_LOG WHERE LOG_TIME BETWEEN ? AND ?', 'SP_CLOSE_SESSION(140241007);'],
    ]
  ),
  'sql.longexec': rs(
    ['SQL_TEXT', 'EXEC_TIME', 'FINISH_TIME', 'N_RUNS', 'SQL_SOURCE'],
    [
      ['SELECT O.*, D.* FROM T_ORDER O JOIN T_ORDER_DETAIL D ON O.ORDER_ID=D.ORDER_ID', '42800', '2026-01-20 14:01:02', '37', ''],
      ['SELECT * FROM T_ORDER_DETAIL WHERE CREATE_TIME > ?', '12600', '2026-01-20 13:22:41', '124', ''],
      ['UPDATE T_STOCK SET QTY=QTY-1 WHERE SKU=?', '2400', '2026-01-20 12:10:00', '8841', ''],
      // 本工具自己的巡检查询也会出现在这类记录里：列出但标注来源、不计入告警
      ['SELECT TABLESPACE_NAME, OWNER, SEGMENT_NAME, SEGMENT_TYPE, SIZE_MB FROM (SELECT TABLESPACE_NAME, OWNER, SEGMENT_NAME, SEGMENT_TYPE, ROUND(BYTES/1024/1024, 2) AS SIZE_MB, ROW_NUMBER() OVER (PARTITION BY TABLESPACE_NAME ORDER BY BYTES DESC) AS RN FROM DBA_SEGMENTS) T WHERE RN <= 10 ORDER BY TABLESPACE_NAME, SIZE_MB DESC', '3800', '2026-01-20 14:00:11', '2', '本工具巡检查询'],
    ]
  ),
  'sql.history': rs(
    ['SESS_ID', 'TRX_ID', 'SQL_TEXT', 'TIME_USED', 'AFFECTED_ROWS', 'N_LOGIC_READ', 'N_PHY_READ', 'START_TIME', 'IS_OVER', 'SQL_SOURCE'],
    [
      ['140238912', '8842011', 'SELECT O.*, D.* FROM T_ORDER O JOIN T_ORDER_DETAIL D ON O.ORDER_ID=D.ORDER_ID', '42800112', '1204', '8812344', '412883', '2026-01-20 13:54:10', 'Y', ''],
      ['140241007', '8842098', 'SELECT COUNT(*) FROM T_LOG WHERE LOG_TIME BETWEEN ? AND ?', '12600441', '1', '44120', '1204', '2026-01-20 13:22:41', 'Y', ''],
      ['140241113', '8842107', 'SELECT TABLESPACE_NAME, OWNER, SEGMENT_NAME, SEGMENT_TYPE, SIZE_MB FROM DBA_SEGMENTS ORDER BY TABLESPACE_NAME, BYTES DESC', '1629895', '0', '9222', '733', '2026-01-20 13:59:02', 'Y', '本工具巡检查询'],
    ]
  ),
  'sql.cache': rs(['SQL_CACHE_ITEMS'], [['38412']]),
  'sql.indexfrag': rs(
    ['OBJNAME', 'FRAGPCT'],
    [
      ['APP.IDX_ORDER_CREATE_TIME', '62.4'],
      ['APP.IDX_LOG_TIME', '48.1'],
      ['APP.IDX_CUSTOMER_NAME', '35.7'],
    ]
  ),

  'obj.invalid': rs(
    ['OWNER', 'OBJECT_TYPE', 'OBJECT_NAME', 'STATUS', 'LAST_DDL_TIME'],
    [
      ['APP', 'PROCEDURE', 'P_SYNC_ORDER', 'INVALID', '2026-01-18 09:00:00'],
      ['APP', 'VIEW', 'V_ORDER_SUMMARY', 'INVALID', '2026-01-19 15:20:00'],
    ]
  ),
  'obj.stats': rs(
    ['OWNER', 'TABLE_NAME', 'LAST_ANALYZED', 'NUM_ROWS'],
    [
      ['APP', 'T_LOG', null, null],
      ['APP', 'T_ORDER_DETAIL', '2025-11-02 03:00:00', '88412033'],
      ['APP', 'T_ORDER', '2025-12-01 03:00:00', '12048822'],
    ]
  ),
  'obj.nopk': rs(
    ['OWNER', 'TABLE_NAME'],
    [
      ['APP', 'T_LOG'],
      ['APP', 'T_TMP_IMPORT'],
    ]
  ),
  'obj.count': rs(
    ['OBJ_TYPE', 'CNT'],
    [
      ['TABLES', '412'],
      ['INDEXES', '689'],
      ['VIEWS', '88'],
      ['PROCEDURES', '256'],
      ['TRIGGERS', '24'],
      ['SEQUENCES', '61'],
      ['USERS_OPEN', '12'],
    ]
  ),

  'sec.users': rs(
    ['USERNAME', 'ACCOUNT_STATUS', 'USER_ID', 'LOCK_DATE', 'EXPIRY_DATE', 'CREATED_DATE', 'DEFAULT_TABLESPACE', 'AUTHENTICATION_TYPE'],
    [
      ['SYSDBA', 'OPEN', '1', null, null, '2025-03-11 10:00:00', 'SYSTEM', 'PASSWORD'],
      ['APPUSER', 'OPEN', '50331651', null, '2026-03-01 00:00:00', '2025-03-11 10:02:00', 'TBS_USER', 'PASSWORD'],
      ['REPORT', 'OPEN', '50331652', null, null, '2025-04-02 11:00:00', 'TBS_USER', 'PASSWORD'],
      ['TESTUSER', 'LOCKED(TIMED)', '50331660', '2026-01-12 08:20:00', null, '2025-06-01 09:00:00', 'TBS_USER', 'PASSWORD'],
    ]
  ),
  'sec.pwdpolicy': rs(
    ['USERNAME', 'PWD_POLICY', 'PWD_LIFE_DAYS', 'FAILED_NUM', 'FAILED_ATTEMPS', 'LOCK_TIME', 'CONN_IDLE_TIME'],
    [
      ['SYSDBA', '31', '90', '5', '0', '10', '30'],
      ['APPUSER', '31', '90', '5', '0', '10', '30'],
      ['REPORT', '0', '0', '100', '0', '0', '0'],
      ['TESTUSER', '31', '90', '5', '4', '10', '30'],
    ]
  ),
  'sec.audit': rs(
    ['PARA_NAME', 'PARA_VALUE'],
    [
      ['AUDIT_FILE_FULL_MODE', '1'],
      ['AUDIT_MAX_FILE_SIZE', '100'],
      ['ENABLE_AUDIT', '0'],
      ['SVR_LOG', '0'],
    ]
  ),
  'sec.privileges': rs(
    ['GRANTEE', 'PRIVILEGE', 'PRIV_TYPE', 'ADMIN_OPTION'],
    [
      ['SYSDBA', 'DBA', 'ROLE', 'YES'],
      ['APPUSER', 'DBA', 'ROLE', 'NO'],
      ['REPORT', 'SELECT ANY TABLE', 'SYS', 'NO'],
    ]
  ),

  'job.list': rs(
    ['ID', 'NAME', 'ENABLE_FLAG', 'USERNAME', 'CREATE_TIME'],
    [
      ['1', 'JOB_BACKUP_FULL', '1', 'SYSDBA', '2025-03-12 09:00:00'],
      ['2', 'JOB_GATHER_STATS', '1', 'SYSDBA', '2025-03-12 09:05:00'],
      ['3', 'JOB_CLEAN_ARCH', '0', 'SYSDBA', '2025-03-12 09:10:00'],
    ]
  ),
  'job.history': rs(
    ['EXEC_ID', 'JOB_NAME', 'STEPNAME', 'START_TIME', 'END_TIME', 'ERRCODE', 'ERRINFO'],
    [
      ['88231', 'JOB_BACKUP_FULL', 'STEP1', '2026-01-19 02:00:00', '2026-01-19 02:04:12', '-6002', '磁盘空间不足'],
      ['88235', 'JOB_BACKUP_FULL', 'STEP1', '2026-01-20 02:00:00', '2026-01-20 02:00:31', '-6002', '磁盘空间不足'],
    ]
  ),
  'backup.sets': rs(
    ['DEVICE_TYPE', 'BACKUP_ID', 'BACKUP_PATH', 'BACKUP_TIME', 'DAYS_AGO'],
    [
      ['DISK', '8842101', '/dm8/backup/full_20260118', '2026-01-18 02:04:12', '2.51'],
      ['DISK', '8841220', '/dm8/backup/full_20260117', '2026-01-17 02:03:58', '3.51'],
    ]
  ),
  'backup.path': rs(
    ['PARA_NAME', 'PARA_VALUE', 'FILE_VALUE'],
    [
      ['BAK_PATH', '/dm8/backup', '/dm8/backup'],
      ['BCT_PATH', '', ''],
    ]
  ),

  'os.host': rs(
    [
      'HOSTNAME', 'PLATFORM', 'CPU_MODEL', 'CPU_CORES', 'CPU_USED_PCT',
      'LOAD_1M', 'LOAD_5M', 'LOAD_15M',
      'MEM_TOTAL', 'MEM_AVAILABLE', 'MEM_USED_PCT',
      'IO_READ_RATE', 'IO_WRITE_RATE', 'IO_READ_IOPS', 'IO_WRITE_IOPS',
      'OS_UPTIME_DAYS', 'DISK_USAGE', 'NOTE',
    ],
    [
      [
        'dmdb01', 'linux 4.19.90-24.4.v2101.ky10.aarch64 aarch64',
        'Kunpeng-920', '64', '38.42',
        '12.31', '10.02', '8.77',
        '128.00 GB', '21.42 GB', '83.27',
        '412.55 MB/s', '96.31 MB/s', '3120.4', '780.2',
        '46.3',
        '/dm8 已用 62.18%（剩余 412.60 GB / 共 2000.00 GB）；/dm8/backup 已用 88.40%（剩余 116.20 GB / 共 1000.00 GB）',
        '—',
      ],
    ]
  ),
  'res.params': rs(
    ['ITEM', 'CURRENT', 'SUGGEST', 'RESULT'],
    [
      ['数据库内存 / 物理内存', '6.11 GB（内存池 1778MB + 缓冲池 4480MB），占物理内存 4.8%', '建议控制在物理内存的 50%~70%', '偏小（未充分利用内存）'],
      ['物理内存剩余', '21.42 GB（16.7%）', '建议保留 20% 以上给操作系统与文件缓存', '偏少'],
      ['数据库磁盘剩余空间', '412.6 GB / 2000 GB（剩余 20.63%）', '建议剩余 ≥20%；同时保证归档目录与备份目录有独立空间', '合理'],
      ['MAX_MEMORY（实例最大内存）', '0（不限制）', '不限制时数据库可能持续增长，建议按业务峰值显式设定上限', '需关注（未设上限）'],
      ['MEMORY_POOL（内存池）', '1024 MB', '经验值：不小于物理内存的 1/16；建议 512MB~4GB 起步', '合理'],
      ['BUFFER（数据缓冲区）', '4096 MB（当前缓冲池实际 4480 MB）', 'OLTP 场景建议为物理内存的 50% 左右；DM 动态缓冲管理下 BUFFER 显示很小属正常', '需结合缓冲池命中率判断'],
      ['SORT_BUF_SIZE（排序缓冲区）', '20 MB', 'OLTP 建议 10~20MB；OLAP/报表库可适当加大', '合理'],
      ['IO_THREADS / CPU 核数', 'IO 线程 8', 'IO 线程数不宜远超磁盘并发能力，也不宜过大导致上下文切换开销', '需结合磁盘 IOPS 实测判断'],
      ['WORKER_THREADS（工作线程）', '32', '建议与 CPU 核数同量级；过大反而增加上下文切换', '需结合并发会话数判断'],
      ['主机磁盘 IO 实测（工具所在主机）', '读 412.55 MB/s（3120 IOPS），写 96.31 MB/s（780 IOPS）', '若写 IOPS 长期接近磁盘上限，应优先排查 redo 切换频率与大批量写入', '供参考'],
    ]
  ),
  // ---------------------------------------------------- 部署形态与集群项
  // 演示数据按「单实例」形态呈现：集群类巡检项应显示「不适用」而非报错
  'basic.topology': rs(
    ['DEPLOY_MODE', 'IS_DSC', 'IS_DW', 'EVIDENCE', 'SCOPE_NOTE'],
    [['单实例', '否', '否', '未发现集群特征视图', '按单实例执行全部巡检项。']],
    { mode: '单实例', isDsc: false, isDw: false, evidence: [] }
  ),
  ...['dw.archsend', 'dw.sync', 'dw.mal', 'dw.malmem', 'dw.monitor', 'dsc.nodes', 'dsc.dcrgroup', 'dsc.register', 'dsc.asmgroup', 'dsc.asmdisk', 'dsc.request'].reduce(
    (acc, id) => {
      const dw = id.startsWith('dw.');
      acc[id] = rs(
        ['APPLICABILITY'],
        [[`不适用：未检测到${dw ? '数据守护集群' : '共享存储集群（DMDSC）'}（当前部署形态：单实例）`]],
        { notApplicable: true }
      );
      return acc;
    },
    {}
  ),

  // 远程 OS 采集未配置时，这组巡检项应显示「不适用」
  ...['os.host', 'os.mem', 'os.disk', 'os.diskconf', 'os.io', 'os.proc', 'os.kernel', 'os.account'].reduce(
    (acc, id) => {
      acc[id] = rs(
        ['OS_CHECK_RESULT'],
        [['不适用：未配置远程采集（可在网页「数据库服务器 OS 采集（SSH）」中填写数据库服务器 SSH 信息）']],
        { notApplicable: true }
      );
      return acc;
    },
    {}
  ),

  // ------------------------------------------------------------ 新增补充项
  'log.instance_history': rs(
    ['LEVEL$', 'TIME$', 'INFO$'],
    [
      ['ERROR', '2026-01-20 10:02:41', 'DEADLOCK detected, trx 8823440 rolled back'],
      ['ERROR', '2026-01-20 02:00:31', '作业 JOB_BACKUP_FULL 执行失败，错误码 -6002 磁盘空间不足'],
      ['FATAL', '2026-01-18 03:11:02', 'fail to allocate memory from OS'],
    ]
  ),
  'db.ckpt_history': rs(
    ['START_TIME', 'TIME_USED', 'PAGE_FLUSHED'],
    [
      ['2026-01-20 14:02:11', '1842.35', '5240'],
      ['2026-01-20 13:52:07', '412.18', '1280'],
      ['2026-01-20 13:42:03', '386.44', '1195'],
      ['2026-01-20 13:32:01', '358.90', '1102'],
    ]
  ),
  'mem.dict_cache': rs(
    ['TOTAL_MB', 'USED_MB', 'DICT_NUM', 'DISCARD_MB', 'LRU_DISCARD', 'USED_PCT'],
    [['256', '228.46', '41812', '3.25', '118', '89.24']]
  ),
  'db.sysevent': rs(
    ['WAIT_CLASS', 'EVENT', 'TOTAL_WAITS', 'TIME_WAITED', 'EVENT_WAIT_TIME'],
    [
      ['USER_IO', 'db file sequential read', '184223', '8821344', '47.88'],
      ['CONFIGURATION', 'latch free', '22841', '118234', '5.18'],
      ['CONCURRENCY', 'enq: TX - row lock contention', '9012', '882134', '97.88'],
      ['COMMIT', 'log file sync', '1120', '41288', '36.86'],
    ]
  ),
  'obj.invalid_index': rs(
    ['OWNER', 'INDEX_NAME', 'TABLE_NAME', 'INDEX_TYPE', 'STATUS'],
    [
      ['APP', 'IDX_ORDER_STATUS', 'T_ORDER', 'NORMAL', 'INVALID'],
      ['APP', 'IDX_LOG_TIME', 'T_LOG', 'NORMAL', 'INVALID'],
    ]
  ),
  'obj.invalid_part_index': rs(
    ['SCH_NAME', 'INDEX_NAME', 'PARTITION_NAME', 'SUBPARTITION_NAME', 'STATUS'],
    [['APP', 'IDX_ORDER_DETAIL_PK', 'P202601', null, 'UNUSABLE']]
  ),
  'obj.seq_usage': rs(
    ['SEQUENCE_OWNER', 'SEQUENCE_NAME', 'PEC_USED', 'MIN_VALUE', 'MAX_VALUE', 'INCREMENT_BY', 'CYCLE_FLAG', 'CACHE_SIZE', 'LAST_NUMBER'],
    [
      ['APP', 'SEQ_ORDER_ID', '93.42', '1', '999999999', '1', 'N', '20', '934200000'],
      ['APP', 'SEQ_LOG_ID', '76.18', '1', '99999999', '1', 'N', '20', '76180000'],
    ]
  ),
  'obj.frag_table': rs(
    ['OBJNAME', 'OBJTYPE', 'FRAGPCT'],
    [
      ['APP.T_LOG', 'TABLE/TABLE PART', '68.42'],
      ['APP.T_ORDER_DETAIL', 'TABLE/TABLE PART', '42.15'],
      ['APP.T_ORDER', 'TABLE/TABLE PART', '31.08'],
    ]
  ),
  'db.sysstat': rs(
    ['STAT_VAL', 'NAME'],
    [
      ['8841203', 'transaction total count'],
      ['8820114', 'transaction commit count'],
      ['21089', 'transaction rollback count'],
      ['37', 'transaction deadlock count'],
      ['42881442', 'select statements'],
      ['12883902', 'insert statements'],
      ['8841204', 'update statements'],
      ['442013', 'delete statements'],
    ]
  ),
  'mem.design_size': rs(['ITEM', 'VAL'], [['INI_TOTAL_GB', '6.25']]),
  'db.param_diff': rs(
    ['PARA_NAME', 'DEFAULT_VALUE', 'PARA_VALUE'],
    [
      ['COMPATIBLE_MODE', '0', '0'],
      ['ENABLE_MONITOR', '0', '1'],
      ['OPTIMIZER_MODE', '1', '0'],
      ['SVR_LOG', '0', '0'],
    ]
  ),

  'log.scan': rs(
    ['TIME', 'LEVEL', 'FILE', 'TEXT'],
    [
      ['2026-01-20 02:00:31', '错误', 'dm_DMSERVER_202601.log', '2026-01-20 02:00:31.442 [ERROR] 作业 JOB_BACKUP_FULL 执行失败，错误码 -6002 磁盘空间不足'],
      ['2026-01-20 10:02:41', '死锁', 'dm_DMSERVER_202601.log', '2026-01-20 10:02:41.108 [ERROR] DEADLOCK detected, trx 8823440 rolled back, cycle: self -> (8823990, 0x7f31) -> self'],
      ['2026-01-20 13:41:19', '死锁', 'dm_DMSERVER_202601.log', '2026-01-20 13:41:19.774 [ERROR] DEADLOCK detected, trx 8830122 rolled back'],
      ['2026-01-20 13:55:02', '告警', 'dm_DMSERVER_202601.log', '2026-01-20 13:55:02.301 [WARNING] 会话 140238912 执行的语句已持续 3600 秒，内存池 SORT_POOL 使用率超过 80%'],
      ['2026-01-20 14:03:11', '错误', 'dmsql_DMSERVER_202601.log', '2026-01-20 14:03:11.882 [ERROR] EXECTIME: 42800(ms) SELECT O.*, D.* FROM T_ORDER O JOIN T_ORDER_DETAIL D ON O.ORDER_ID=D.ORDER_ID'],
    ],
    {
      scannedFiles: 2,
      filesDesc: 'dm_DMSERVER_202601.log(18.4MB)、dmsql_DMSERVER_202601.log(6.2MB)',
      startTime: '2026-01-05 09:12:33',
      truncated: false,
      svrLog: '1',
      dirs: ['/dm8/log'],
      pathSources: ['SYSTEM_PATH = /dm8/data/DAMENG', 'SYSTEM_PATH 推导：<DM_HOME>/log → /dm8/log'],
    }
  ),
};

/**
 * 未在演示数据中定义的巡检项：返回空结果集。
 * 刻意不伪造数据——否则判定规则会基于假数据给出误导性的告警。
 */
function fallback(id) {
  return { columns: [], rows: [], rowCount: 0 };
}

class DemoSession {
  constructor(options) {
    this.options = options || {};
    this.poisoned = false;
    this.info = 'DM8 (演示模式)';
    this._queue = Object.keys(DATA);
  }

  async connect() {
    await new Promise((r) => setTimeout(r, 120));
    return this.info;
  }

  async query(sql, options) {
    // 用 SQL 内容反查是哪一个巡检项：巡检项定义中的 SQL 均来自同一份数据表，
    // 这里通过调用方传入的 checkId 关联更可靠，因此 runner 会走 queryCheck。
    throw new Error('DemoSession 请使用 queryCheck()');
  }

  async queryCheck(check, options) {
    await new Promise((r) => setTimeout(r, this.options.demoDelayMs == null ? 45 : this.options.demoDelayMs));
    const data = DATA[check.id] || fallback(check.id);
    // 注意：meta 必须一并透传，部分巡检项的判定逻辑依赖它（如日志扫描的“已扫描文件数”）
    return { columns: data.columns, rows: data.rows, rowCount: data.rowCount, meta: data.meta };
  }

  async close() {}
}

async function probe() {
  return {
    id: 'demo',
    name: '演示模式（无需数据库）',
    available: true,
    detail: '使用内置的达梦 DM8 样例数据生成报告，用于预览报告样式与验证功能。',
  };
}

function isDemo() {
  return true;
}

module.exports = { DemoSession, probe, isDemo };
