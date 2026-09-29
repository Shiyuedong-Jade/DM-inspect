'use strict';
/*
 * 主机（OS）指标采集
 * ---------------------------------------------------------------------------
 * 采集「运行本巡检工具的主机」的操作系统级指标：
 *   CPU 型号/核数/负载/使用率、物理内存、磁盘 IO 速率与 IOPS、关键目录磁盘占用。
 *
 * 重要说明：
 *   本模块采集的是「巡检工具所在主机」。若工具与数据库同机部署（推荐做法），
 *   这些指标即数据库主机的真实 OS 指标；若工具部署在跳板机上，则只代表跳板机。
 *   数据库主机自身的 OS 信息另有来源：V$SYSTEMINFO（见 instance.systeminfo 巡检项）。
 *
 * 仅依赖 Node 标准库与 Linux /proc 伪文件系统，无第三方依赖。
 * Windows 下 /proc 不可用，CPU 使用率与 IO 速率会标注为「未采集」，不会报错。
 */

const os = require('node:os');
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

/** 读取 /proc/stat 的整机 CPU 累计时间片 */
function cpuTimes() {
  const t = readText('/proc/stat');
  if (!t) return null;
  const line = t.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (!v.length) return null;
  const total = v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const idle = (v[3] || 0) + (v[4] || 0); // idle + iowait
  return { total, idle };
}

/** 读取 /proc/diskstats 的累计扇区数（扇区固定 512 字节） */
function diskCounters() {
  const t = readText('/proc/diskstats');
  if (!t) return null;
  // 只统计整块设备，排除分区与 device-mapper 逻辑卷（避免与物理盘重复计数）
  const devRe = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
  let sectorsRead = 0;
  let sectorsWritten = 0;
  let reads = 0;
  let writes = 0;
  let found = 0;
  for (const line of t.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!devRe.test(name)) continue;
    reads += Number(f[3]) || 0;
    sectorsRead += Number(f[5]) || 0;
    writes += Number(f[7]) || 0;
    sectorsWritten += Number(f[9]) || 0;
    found++;
  }
  return found ? { sectorsRead, sectorsWritten, reads, writes, devices: found } : null;
}

/** 读取 /proc/meminfo */
function procMemInfo() {
  const t = readText('/proc/meminfo');
  if (!t) return null;
  const get = (k) => {
    const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(t);
    return m ? Number(m[1]) * 1024 : null;
  };
  return { total: get('MemTotal'), available: get('MemAvailable'), free: get('MemFree') };
}

/** 目录所在文件系统的容量（Node 18.15+ 提供 fs.statfsSync） */
function diskUsage(p) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return {
      path: p,
      totalBytes: total,
      freeBytes: free,
      usedPct: total > 0 ? (1 - free / total) * 100 : null,
    };
  } catch (_) {
    return null;
  }
}

function fmtBytes(b) {
  if (b === null || b === undefined || !Number.isFinite(b)) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(2)) + ' ' + u[i];
}

/**
 * 采集主机指标。
 * @param {object} [opts]
 * @param {number} [opts.sampleMs] 采样间隔，默认 1000ms（用于算 CPU% 与 IO 速率）
 * @param {string[]} [opts.diskPaths] 需要查看容量的目录，默认取当前工作目录
 */
async function probeOs(opts) {
  const o = opts || {};
  const sampleMs = Math.max(300, Math.min(5000, o.sampleMs || 1000));
  const isLinux = os.platform() === 'linux';

  const out = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: ((os.cpus() || [])[0] || {}).model || '未知',
    cpuCount: (os.cpus() || []).length,
    uptimeSec: os.uptime(),
    loadavg: null,
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    cpuPct: null,
    io: null,
    disks: [],
    notes: [],
    sampleMs,
  };

  // 负载：Windows 上 os.loadavg() 恒返回 [0,0,0]，标注为不可用
  const la = os.loadavg();
  if (!isLinux || la.some((x) => x !== 0)) {
    out.loadavg = la;
  } else {
    out.notes.push('未能获取系统负载（该平台不支持）。');
  }

  // 内存：优先用 /proc/meminfo 的 MemAvailable（更能反映真实可用量）
  const mi = isLinux ? procMemInfo() : null;
  if (mi && mi.total) {
    out.memTotalBytes = mi.total;
    out.memAvailableBytes = mi.available;
  } else {
    out.memAvailableBytes = out.memFreeBytes;
  }

  if (isLinux) {
    const c1 = cpuTimes();
    const d1 = diskCounters();
    await sleep(sampleMs);
    const c2 = cpuTimes();
    const d2 = diskCounters();

    if (c1 && c2 && c2.total > c1.total) {
      const dTotal = c2.total - c1.total;
      const dIdle = c2.idle - c1.idle;
      out.cpuPct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    }

    if (d1 && d2) {
      const sec = sampleMs / 1000;
      const rSectors = d2.sectorsRead - d1.sectorsRead;
      const wSectors = d2.sectorsWritten - d1.sectorsWritten;
      const rIops = (d2.reads - d1.reads) / sec;
      const wIops = (d2.writes - d1.writes) / sec;
      out.io = {
        readBytesPerSec: (rSectors * 512) / sec,
        writeBytesPerSec: (wSectors * 512) / sec,
        readIops: rIops,
        writeIops: wIops,
        devices: d2.devices,
      };
    }
  } else {
    out.notes.push('当前平台非 Linux，未采集 CPU 使用率与磁盘 IO 速率（依赖 /proc）。');
  }

  // 磁盘容量：工具所在目录（以及调用方额外指定的目录）
  const paths = (o.diskPaths && o.diskPaths.length ? o.diskPaths : [process.cwd()]).slice(0, 6);
  for (const p of paths) {
    const du = diskUsage(p);
    if (du) out.disks.push(du);
  }
  if (!out.disks.length) {
    out.notes.push('未能获取磁盘容量信息。');
  }

  return out;
}

/**
 * 通过 shell 通道（本机 shell / SSH）采集**数据库服务器**的 OS 指标。
 * ---------------------------------------------------------------------------
 * 本机 probeOs 只能采到「工具所在主机」的指标；工具部署在跳板机上时，
 * 展示跳板机的 CPU/IO 会得出完全错误的资源结论，所以原来直接跳过。
 * 但既然 OS 巡检项已经能通过 shell 通道拿到数据库服务器的数据，
 * 本函数就用同一条通道把 CPU 使用率、内存、磁盘 IO 速率与容量也采回来，
 * 避免在报告里出现「同一分组下别的项有数据、这一项却说采不到」。
 *
 * 采样方式：在一次批量执行里取两次 /proc 快照，中间 sleep，
 * 用**远端自己的时钟**（date +%s.%N）计算实际间隔，比按标称间隔更准。
 *
 * @param {{runBatch: Function}} shell  RemoteShell 实例（鸭子类型，避免循环依赖）
 * @param {object} [opts] { sampleMs }
 * @returns {Promise<object|null>} 与 probeOs 同构；通道不可用时返回 null
 */
async function probeOsViaShell(shell, opts) {
  if (!shell || typeof shell.runBatch !== 'function') return null;
  const o = opts || {};
  const sampleSec = Math.max(1, Math.round((o.sampleMs || 1000) / 1000));
  const S = '##DMS##';

  const snap = (extra) =>
    [
      `date +%s.%N 2>/dev/null || echo 0`,
      `head -1 /proc/stat`,
      `cat /proc/diskstats`,
      extra || '',
    ]
      .filter(Boolean)
      .join(`; echo '${S}'; `);

  const res = await shell.runBatch([
    {
      id: 'a',
      cmd:
        `${snap()}; echo '${S}'; cat /proc/meminfo; echo '${S}'; cat /proc/loadavg 2>/dev/null; ` +
        `echo '${S}'; uname -r; echo '${S}'; uname -m; echo '${S}'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; ` +
        `echo '${S}'; grep -m1 'model name' /proc/cpuinfo 2>/dev/null; ` +
        `echo '${S}'; cut -d' ' -f1 /proc/uptime 2>/dev/null; echo '${S}'; hostname 2>/dev/null; ` +
        `echo '${S}'; df -B1 -P -x tmpfs -x devtmpfs 2>/dev/null`,
    },
    { id: 'b', cmd: `sleep ${sampleSec}; ${snap()}` },
  ]);

  const seg = (txt) => String(txt || '').split(S).map((s) => s.trim());
  const A = seg(res.a);
  const B = seg(res.b);
  if (A.length < 4 || !/^cpu\s/.test(A[1] || '')) return null; // 拿不到 /proc/stat 就认定通道不可用

  const parseStat = (line) => {
    const v = String(line || '').trim().split(/\s+/).slice(1).map(Number);
    if (!v.length) return null;
    const total = v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return { total, idle: (v[3] || 0) + (v[4] || 0) };
  };

  const DEV_RE = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
  const parseDisk = (text) => {
    let sectorsRead = 0;
    let sectorsWritten = 0;
    let reads = 0;
    let writes = 0;
    let devices = 0;
    for (const line of String(text || '').split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 14) continue;
      if (!DEV_RE.test(f[2])) continue;
      reads += Number(f[3]) || 0;
      sectorsRead += Number(f[5]) || 0;
      writes += Number(f[7]) || 0;
      sectorsWritten += Number(f[9]) || 0;
      devices++;
    }
    return devices ? { sectorsRead, sectorsWritten, reads, writes, devices } : null;
  };

  // 分隔标记在每个字段之间都出现一次，因此段落下标是确定的：
  //   0=时钟 1=/proc/stat 2=/proc/diskstats 3=meminfo 4=loadavg
  //   5=uname -r 6=uname -m 7=nproc 8=cpu model 9=uptime 10=hostname 11=df
  // 刻意按固定下标取，而不是按内容猜：`date +%s.%N` 在 %N 不支持时只返回整数秒，
  // 「看起来像数字」的启发式会把时间戳误当成 CPU 核数或运行时长。
  const at = (i) => (A[i] === undefined ? '' : A[i]);
  // 注意 Number('') === 0：空字段必须判为「未知」而不是 0，否则会把「取不到」
  // 伪装成「测到了 0」。同时只取第一个空白分隔的记号，兼容 /proc/uptime 这类
  // 带多列的原样输出（不依赖 cut 一定可用）。
  const numOr = (v) => {
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (!s) return null;
    const n = Number(s.split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  };

  const out = {
    hostname: at(10) || '未知',
    platform: 'linux',
    release: at(5),
    arch: at(6),
    cpuModel: (at(8).split(':').slice(1).join(':').trim() || '未知'),
    cpuCount: numOr(at(7)) || 0,
    uptimeSec: numOr(at(9)) || 0,
    loadavg: null,
    memTotalBytes: null,
    memAvailableBytes: null,
    memFreeBytes: null,
    cpuPct: null,
    io: null,
    disks: [],
    notes: [],
    sampleMs: sampleSec * 1000,
    via: 'shell',
  };

  const la = at(4).split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  if (la.length >= 3) out.loadavg = la.slice(0, 3);

  const memText = at(3);
  if (memText) {
    const get = (k) => {
      const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(memText);
      return m ? Number(m[1]) * 1024 : null;
    };
    out.memTotalBytes = get('MemTotal');
    out.memAvailableBytes = get('MemAvailable');
    out.memFreeBytes = get('MemFree');
  }

  // CPU 使用率：用远端两次采样各自的时钟算实际间隔，比按标称间隔更准
  const t1 = numOr((A[0] || '').split('\n')[0]);
  const t2 = numOr((B[0] || '').split('\n')[0]);
  const c1 = parseStat(A[1]);
  const c2 = parseStat(B[1]);
  if (c1 && c2 && c2.total > c1.total) {
    out.cpuPct = Math.max(0, Math.min(100, (1 - (c2.idle - c1.idle) / (c2.total - c1.total)) * 100));
  }

  const d1 = parseDisk(A[2]);
  const d2 = parseDisk(B[2]);
  if (d1 && d2) {
    // 实际间隔：远端时钟优先，取不到或不合理时退回标称值
    let sec = t1 !== null && t2 !== null && t2 > t1 ? t2 - t1 : sampleSec;
    if (!(sec > 0.05) || sec > 30) sec = sampleSec;
    out.io = {
      readBytesPerSec: Math.max(0, (d2.sectorsRead - d1.sectorsRead) * 512) / sec,
      writeBytesPerSec: Math.max(0, (d2.sectorsWritten - d1.sectorsWritten) * 512) / sec,
      readIops: Math.max(0, d2.reads - d1.reads) / sec,
      writeIops: Math.max(0, d2.writes - d1.writes) / sec,
      devices: d2.devices,
    };
  }

  // 磁盘容量（df -B1 -P，每行一个文件系统）
  for (const line of at(11).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const total = numOr(f[1]);
    const free = numOr(f[3]);
    if (!total) continue;
    out.disks.push({
      path: f.slice(5).join(' '),
      totalBytes: total,
      freeBytes: free,
      usedPct: total > 0 && free !== null ? (1 - free / total) * 100 : null,
    });
  }
  out.disks = out.disks.slice(0, 8);

  if (!out.disks.length) out.notes.push('未采集到磁盘容量（df 不可用）。');
  return out;
}

module.exports = { probeOs, probeOsViaShell, fmtBytes, diskUsage };
