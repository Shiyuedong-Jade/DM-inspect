'use strict';
/*
 * 达梦数据库日志扫描
 * ---------------------------------------------------------------------------
 * 达梦没有类似 Oracle V$DIAG_ALERT_EXT 的视图可以查询错误日志内容，
 * 只能读服务器上的日志文件。因此本模块直接扫描日志目录：
 *   dm_<实例名>_<YYYYMM>.log   运行日志（DM8，旧版 DM7 为 dmserver.log）
 *   dmsql_<实例名>_<YYYYMM>.log SQL 日志（仅当 SVR_LOG=1 时才有内容）
 *   *.trc                      跟踪日志
 *
 * 两条读取通道，解析逻辑完全共用：
 *   1) 本机文件系统（scanLogs）——工具与数据库同机时最快，不需要任何凭据；
 *   2) shell 通道（scanLogsViaShell）——工具在跳板机上时通过 SSH 读，
 *      用配置的账号（dmdba 即可，达梦日志本来就归 dmdba 所有）。
 *
 * 早期版本只有本机通道，导致「填了 SSH 密码却依然提示无权访问」——
 * 因为日志检查根本没走 SSH。现在先试本机，不可访问时自动改走 shell 通道。
 */

const fs = require('node:fs');
const path = require('node:path');
const { shellQuote } = require('./remote');

/**
 * 是否像达梦的日志文件。
 * ---------------------------------------------------------------------------
 * 必须限定命名，否则日志目录里任何程序的 .log（例如 JRE 的 JavaLauncher.log）
 * 都会被扫进来，把别的程序的 ERROR 误判成数据库的错误。
 *
 * 判据用「以 dm 开头」而不是罗列一堆前缀：达梦的日志名远不止 dm_ / dmsql_，
 * 真机（DMDSC）日志目录里就有 dm_DSC01_*.log、dm_CSS0_*.log、dm_ASM0_*.log、
 * dmasm_trace_*.log、dmcssm_*.log、dminit_*.log、DmAPService.log ——
 * 原先的前缀白名单只认 dm_/dmsql_/dmserver/… ，上面这些全被当成「非达梦日志」跳过了。
 * 以 dm 开头既能覆盖它们，也不会误收 JavaLauncher.log 这类无关文件。
 * 另附 DM 的 huge_ / rep_ 前缀与 .trc 跟踪文件。
 */
function isDmLogName(name) {
  const n = String(name || '');
  if (/\.trc$/i.test(n)) return true;
  return /^(dm|huge_|rep_)/i.test(n);
}

/**
 * 按「输入路径自身的分隔符风格」取上级目录。
 * 不能用 path.dirname：本工具可能运行在 Windows 上而数据库在 Linux 上，
 * 那时 path.dirname 会把 /opt/dmdbms/data/DAMENG 拼成 /opt/dmdbms\data 这种混合路径。
 */
function parentDir(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (idx < 0) return '';
  if (idx === 0) return s.slice(0, 1) === '/' ? '/' : '';
  return s.slice(0, idx);
}

/** 按目录自身的分隔符风格拼接子路径 */
function joinDir(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  if (!d) return name;
  const sep = d.includes('\\') && !d.includes('/') ? '\\' : '/';
  return d + sep + name;
}

/**
 * 从数据库初始化参数（V$DM_INI）推导候选日志目录。
 * ---------------------------------------------------------------------------
 * 刻意「不写死默认路径」：达梦日志目录随版本、安装方式、是否自定义过
 * SYSTEM_PATH / CONFIG_PATH 而不同，写死 $DM_HOME/log 在很多现场是错的。
 * 这里改为扫描所有形如 *PATH* / *LOG* 的参数值，把它们当作候选目录，
 * 同时按典型安装结构做推导，最后逐条给出「哪个参数推出了哪个目录」，便于核对。
 *
 * @param {object} params 参数名(大写) -> 参数值
 * @param {object} [opts] { instanceName, exclude: string[] }
 * @returns {{ dirs: string[], sources: string[] }}
 */
function collectLogDirs(params, opts) {
  const o = opts || {};
  const p = params || {};
  // 备份目录、BCT 目录里放的是备份集而非日志，不纳入扫描（避免误读同名文件）
  const exclude = new Set((o.exclude || ['BAK_PATH', 'BCT_PATH']).map((s) => s.toUpperCase()));

  const dirs = [];
  const sources = [];
  // 收集本次出现过的「真实文件系统路径」参数值，最后统一在其祖先目录下找 log
  const fsBases = [];

  /**
   * 是否像操作系统路径。
   * 注意排除达梦的 ASM 卷路径：DMDSC 下 SYSTEM_PATH / CTL_PATH 等会写成
   * `+DMDATA/data/dameng` 这种形式，那是 ASM 磁盘组内的路径，
   * 在操作系统上根本不存在，当目录去探测只会白白多出一堆「目录不存在」。
   * 真机上 SYSTEM_PATH 正是 `+DMDATA/data/dameng`，把真正的文件系统路径
   * （CONFIG_PATH=/home/dmdba/dmdbms/data/DSC01/DSC01_conf）挡在了后面。
   */
  const isAsmPath = (v) => /^\s*\+/.test(String(v || ''));
  const looksLikePath = (v) => {
    const s = String(v || '').trim();
    if (!s || isAsmPath(s)) return false;
    return /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
  };

  const push = (d, from) => {
    const v = String(d || '').trim().replace(/[\\/]+$/, '');
    if (!v || dirs.includes(v)) return;
    dirs.push(v);
    sources.push(from ? `${from} → ${v}` : v);
  };

  const addFrom = (name, value) => {
    if (!value || !looksLikePath(value)) return;
    fsBases.push({ name, value });
    push(value, name); // 参数值本身可能就是日志目录
    const parent = parentDir(value);
    if (parent && parent !== value && parent !== '.') {
      push(joinDir(parent, 'log'), `${name} 的上级目录 + /log`);
    }
    push(joinDir(value, 'log'), `${name} + /log`);
  };

  // 1) 与日志位置最相关的参数优先
  for (const k of ['ERRORLOG_PATH', 'LOG_PATH', 'SVR_LOG_PATH', 'AUDIT_PATH', 'SYSTEM_PATH', 'CONFIG_PATH']) {
    if (p[k]) addFrom(k, p[k]);
  }

  // 2) 兜底：任何名字里带 PATH 或 LOG 的参数（自动适配不同版本的参数命名差异）
  for (const k of Object.keys(p)) {
    if (exclude.has(k.toUpperCase())) continue;
    if (!/PATH|LOG/i.test(k)) continue;
    addFrom(k, p[k]);
  }

  // 3) 在「每一个」真实文件系统路径参数的祖先目录下找 log / cssm_log。
  //
  // 刻意不写死「上两级就是 DM_HOME」：安装结构不止一种——
  //   单实例： <DM_HOME>/data/DAMENG            → <DM_HOME>/log（上两级）
  //   DMDSC ： <DM_HOME>/data/DSC01/DSC01_conf  → <DM_HOME>/log（上三级）
  // 真机（两节点 DMDSC）就是固定上两级推出 <DM_HOME>/data/log，
  // 而日志其实在 /home/dmdba/dmdbms/log，于是报「未找到达梦命名的日志文件」。
  //
  // 必须遍历**所有**路径参数而不是只取第一个：DMDSC 下 SYSTEM_PATH 是 ASM 路径
  // （已被 looksLikePath 排除），真正有用的是 CONFIG_PATH。
  // cssm_log 是达梦集群同步服务（CSSM）的日志目录，藏在 <DM_HOME>/data/cssm_log，
  // 不由任何 *PATH* 参数直接给出，只能靠祖先目录拼出来。
  const LOG_SUBDIRS = ['log', 'cssm_log'];
  for (const { name, value } of fsBases) {
    let dir = value;
    for (let i = 0; i < 5; i++) {
      const parent = parentDir(dir);
      if (!parent || parent === dir || parent === '.' || parent === '/' || parent === '\\') break;
      for (const sub of LOG_SUBDIRS) {
        push(joinDir(parent, sub), `${name} 向上第 ${i + 1} 级的 ${sub} 目录`);
      }
      dir = parent;
    }
  }

  return { dirs, sources };
}

/** 日志级别判定，顺序即优先级（先匹配到先算） */
const SEVERITY_RULES = [
  { re: /(\bFATAL\b|\bABORT\b|assertion|\bAssert\b|can not startup|fail to startup)/i, level: 'crit', name: '致命' },
  { re: /(out of memory|no space left|disk full|fail to allocate memory|磁盘空间不足)/i, level: 'crit', name: '严重' },
  { re: /(DEADLOCK|dead\s*lock|死锁)/i, level: 'crit', name: '死锁' },
  { re: /(\bERROR\b|\bERR\b|-6\d{3}|错误)/i, level: 'warn', name: '错误' },
  { re: /(\bWARNING\b|\bWARN\b|告警|警告)/i, level: 'warn', name: '告警' },
];

const TS_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/;

function classify(line) {
  for (const r of SEVERITY_RULES) {
    if (r.re.test(line)) return r;
  }
  return null;
}

/** 读取文件尾部（避免把几个 GB 的日志全读进内存） */
function readTail(file, maxBytes) {
  const limit = maxBytes || 2 * 1024 * 1024;
  let fd = null;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - limit);
    const len = st.size - start;
    if (len <= 0) return { text: '', size: st.size, truncated: false };
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // 若从文件中部开始，丢掉第一行残片
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return { text, size: st.size, truncated: start > 0 };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/** 从文件中部截断时，第一行往往是残片，丢掉（本机/远程共用同一约定） */
function dropPartialFirstLine(text) {
  const s = String(text || '');
  const nl = s.indexOf('\n');
  return nl >= 0 ? s.slice(nl + 1) : '';
}

/**
 * 从候选文件里挑出本次要扫描的文件（本机/远程共用）。
 * 优先运行日志与 SQL 日志，其次按修改时间倒序。
 */
function pickCandidates(candidates, maxFiles) {
  const rank = (n) => (/^dm_/i.test(n) ? 0 : /^dmsql_/i.test(n) ? 1 : 2);
  return candidates
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name) || (b.mtime || 0) - (a.mtime || 0))
    .slice(0, maxFiles);
}

/**
 * 把「已读出的文件文本」解析成告警条目（本机/远程共用）。
 * @param {Array<{name,path,sizeMB,truncated,text}>} items
 * @param {{since?:string,maxEntries?:number}} opts
 */
function parseLogTexts(items, opts) {
  const since = (opts && opts.since) || null;
  const maxEntries = (opts && opts.maxEntries) || 200;

  const files = [];
  const entries = [];
  let truncated = false;

  for (const it of items) {
    files.push({ name: it.name, path: it.path, sizeMB: it.sizeMB, truncated: !!it.truncated });

    let curTs = null;
    let lastKept = null;
    for (const raw of String(it.text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = TS_RE.exec(line);
      if (m) {
        curTs = m[1].replace('T', ' ');
        lastKept = null;
      }
      // 只保留实例启动之后的记录
      if (since && curTs && curTs < since) continue;
      if (since && !curTs) continue; // 无时间戳且无法归属，忽略

      const sev = classify(line);
      if (sev) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const entry = {
          file: it.name,
          time: curTs || '',
          level: sev.level,
          levelName: sev.name,
          text: line.length > 500 ? line.slice(0, 500) + '…' : line,
        };
        entries.push(entry);
        lastKept = entry;
      } else if (lastKept && /^\s/.test(raw) && lastKept.text.length < 700) {
        // 缩进的续行，补充到上一条命中记录，便于看清上下文
        lastKept.text += ' ' + line.slice(0, 200);
      }
    }
    if (truncated) break;
  }

  return { files, entries, truncated };
}

/**
 * 扫描一批目录中的日志文件（本机文件系统通道）。
 * @param {object} p
 * @param {string[]} p.dirs       候选日志目录
 * @param {string} [p.since]      起始时间文本 'YYYY-MM-DD HH:MM:SS'（一般为实例启动时间）
 * @param {number} [p.maxFiles]   最多扫描文件数
 * @param {number} [p.maxEntries] 最多返回命中条数
 * @param {number} [p.maxBytesPerFile]
 */
function scanLogs(p) {
  const dirs = (p.dirs || []).filter(Boolean);
  const maxFiles = p.maxFiles || 12;
  const maxBytesPerFile = p.maxBytesPerFile || 2 * 1024 * 1024;

  const existsDirs = [];
  const missingDirs = [];
  const deniedDirs = [];
  for (const d of dirs) {
    try {
      if (fs.statSync(d).isDirectory()) {
        // 目录存在但不可读时不要当成「没有日志」，否则会得出「未发现错误」的假阴性
        try {
          fs.accessSync(d, fs.constants.R_OK);
          existsDirs.push(d);
        } catch (_) {
          deniedDirs.push(d);
        }
      } else {
        missingDirs.push(d);
      }
    } catch (_) {
      missingDirs.push(d);
    }
  }

  if (!existsDirs.length) {
    return {
      ok: false,
      reason: deniedDirs.length ? 'denied' : 'none-accessible',
      dirs,
      missingDirs,
      deniedDirs,
      files: [],
      entries: [],
      scannedFiles: 0,
    };
  }

  // 收集候选文件
  const candidates = [];
  const genericSkipped = [];
  for (const d of existsDirs) {
    let names = [];
    try {
      names = fs.readdirSync(d);
    } catch (_) {
      continue;
    }
    for (const n of names) {
      if (!/\.(log|trc)$/i.test(n)) continue;
      const full = path.join(d, n);
      let st = null;
      try {
        st = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (!st.isFile()) continue;
      // 只扫达梦命名的日志，避免把同目录下其他程序的日志误判为数据库错误
      if (!isDmLogName(n)) {
        genericSkipped.push(full);
        continue;
      }
      candidates.push({ path: full, name: n, dir: d, size: st.size, mtime: st.mtimeMs });
    }
  }

  const picked = pickCandidates(candidates, maxFiles);

  const items = [];
  for (const f of picked) {
    const tail = readTail(f.path, maxBytesPerFile);
    if (!tail) continue;
    items.push({
      name: f.name,
      path: f.path,
      sizeMB: +(f.size / 1024 / 1024).toFixed(2),
      truncated: tail.truncated,
      text: tail.text,
    });
  }

  const parsed = parseLogTexts(items, { since: p.since, maxEntries: p.maxEntries });

  return {
    ok: true,
    via: 'local',
    dirs: existsDirs,
    missingDirs,
    deniedDirs,
    files: parsed.files,
    entries: parsed.entries,
    scannedFiles: picked.length,
    truncated: parsed.truncated,
    /** 目录可访问但没有找到任何达梦命名的日志文件 */
    noMatch: picked.length === 0,
    /** 被跳过的非达梦命名日志文件（供用户核对） */
    genericSkipped: genericSkipped.slice(0, 10),
    genericSkippedCount: genericSkipped.length,
  };
}

/**
 * 通过 shell 通道扫描日志（工具在跳板机上时使用）。
 * 命令全部为纯 ASCII 只读命令；解析逻辑与 scanLogs 完全共用。
 * @param {import('./remote').RemoteShell} shell
 * @param {object} p 同 scanLogs
 */
async function scanLogsViaShell(shell, p) {
  const dirs = (p.dirs || []).filter(Boolean);
  const maxFiles = p.maxFiles || 12;
  const maxBytesPerFile = p.maxBytesPerFile || 2 * 1024 * 1024;

  const existsDirs = [];
  const missingDirs = [];
  const deniedDirs = [];
  const findFailed = [];
  const candidates = [];
  const genericSkipped = [];

  // ---- 1. 一次性探测所有候选目录并列出达梦日志 ----
  // 三种哨兵把「目录不存在 / 无权限 / find 不可用」区分开，
  // 避免把「读不到」误报成「没有日志」，也避免把「无权限」笼统写成「不可访问」。
  const probeEntries = dirs.map((d, i) => ({
    id: 'dir' + i,
    cmd:
      `D=${shellQuote(d)}; ` +
      'if [ ! -d "$D" ]; then echo \'##NODIR##\'; ' +
      'elif [ ! -r "$D" ]; then echo \'##NOPERM##\'; ' +
      'else echo \'##DIR##\'; ' +
      "find \"$D\" -maxdepth 1 -type f \\( -name '*.log' -o -name '*.trc' \\) -printf '%s\\t%T@\\t%f\\n' 2>/dev/null || echo '##FINDFAIL##'; " +
      "echo '##END##'; fi",
  }));

  const probe = await shell.runBatch(probeEntries);

  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const text = String(probe['dir' + i] || '');
    if (/##NODIR##/.test(text)) {
      missingDirs.push(d);
      continue;
    }
    if (/##NOPERM##/.test(text)) {
      deniedDirs.push(d);
      continue;
    }
    if (!/##DIR##/.test(text)) {
      missingDirs.push(d);
      continue;
    }
    if (/##FINDFAIL##/.test(text)) {
      // 目录可读但 find 不支持 -printf：如实标注，不能当作「没有日志」
      findFailed.push(d);
      continue;
    }
    existsDirs.push(d);

    const body = text.slice(text.indexOf('##DIR##') + '##DIR##'.length, text.lastIndexOf('##END##'));
    for (const line of body.split('\n')) {
      const s = line.replace(/\r$/, '');
      if (!s.trim()) continue;
      const parts = s.split('\t');
      if (parts.length < 3) continue;
      const size = Number(parts[0]);
      const mtime = Number(parts[1]) * 1000;
      const name = parts.slice(2).join('\t');
      if (!/\.(log|trc)$/i.test(name)) continue;
      if (!isDmLogName(name)) {
        genericSkipped.push(joinDir(d, name));
        continue;
      }
      candidates.push({
        path: joinDir(d, name),
        name,
        dir: d,
        size: Number.isFinite(size) ? size : 0,
        mtime: Number.isFinite(mtime) ? mtime : 0,
      });
    }
  }

  if (!existsDirs.length) {
    return {
      ok: false,
      reason: deniedDirs.length ? 'denied' : 'none-accessible',
      via: 'shell',
      dirs,
      missingDirs,
      deniedDirs,
      findFailed,
      files: [],
      entries: [],
      scannedFiles: 0,
    };
  }

  // ---- 2. 读取选中文件的尾部 ----
  const picked = pickCandidates(candidates, maxFiles);
  const readEntries = picked.map((f, i) => ({
    id: 'file' + i,
    // 末尾补一个换行，避免与 batch 的分隔标记黏在一起
    cmd: `tail -c ${maxBytesPerFile} ${shellQuote(f.path)} 2>/dev/null; echo`,
  }));
  const read = picked.length ? await shell.runBatch(readEntries) : {};

  const items = picked.map((f, i) => {
    const isTruncated = f.size > maxBytesPerFile;
    let text = String(read['file' + i] || '');
    if (isTruncated) text = dropPartialFirstLine(text);
    return {
      name: f.name,
      path: f.path,
      sizeMB: +(f.size / 1024 / 1024).toFixed(2),
      truncated: isTruncated,
      text,
    };
  });

  const parsed = parseLogTexts(items, { since: p.since, maxEntries: p.maxEntries });

  return {
    ok: true,
    via: 'shell',
    dirs: existsDirs,
    missingDirs,
    deniedDirs,
    findFailed,
    files: parsed.files,
    entries: parsed.entries,
    scannedFiles: picked.length,
    truncated: parsed.truncated,
    noMatch: picked.length === 0,
    genericSkipped: genericSkipped.slice(0, 10),
    genericSkippedCount: genericSkipped.length,
  };
}

module.exports = { scanLogs, scanLogsViaShell, collectLogDirs, isDmLogName, parentDir, joinDir };
