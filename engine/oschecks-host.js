'use strict';
/*
 * 数据库服务器 OS 级巡检项
 * ---------------------------------------------------------------------------
 * 依据《巡检检查项 V4.3》「操作系统信息」一节整理，命令基本沿用文档原文，
 * 对文档中明显有误的条目做了修正（例如「网卡信息」在文档里写的是 free -g）。
 *
 * 执行方式**自动选择**，二者共用同一套命令与判定逻辑：
 *   1) 工具与数据库同机（推荐）→ 本机 shell 执行，不需要任何 SSH 凭据；
 *   2) 工具在跳板机上        → 通过 SSH 以 dmdba 账号远程执行。
 *
 * 说明：
 *  1) 全部为**只读命令**，不修改数据库服务器任何状态；
 *  2) **不做磁盘写测速**：文档中的 dd 写测试会向生产服务器写入数百 MB，
 *      风险高于收益，本工具默认不执行；
 *  3) 两种方式都不可用时，本组巡检项统一标注「不适用」（不计入正常/异常统计）。
 */

const { RemoteShell } = require('./remote');
const { detectColocation } = require('./colocation');
const { probeOs, probeOsViaShell, fmtBytes: fmtBytesOf } = require('./osinfo');

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim().replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
};

const COLS_BASE = ['ITEM', 'VALUE', 'VERDICT'];

/**
 * 运行环境（虚拟化）识别。
 * ---------------------------------------------------------------------------
 * 为什么必须识别：数据库跑在虚拟机 / 云主机 / 容器上时，
 * CPU 使用率、内存容量、磁盘 IO 与 IOPS 都是**虚拟化层呈现的数值**——
 * 会受宿主机负载、CPU 超分、其他虚机（"邻居"）和存储后端（网络存储/云盘）影响，
 * 波动比物理机大、峰值容易失真。若不说明，会让人把云盘的 IOPS 当成物理盘来判断。
 *
 * 取值来源（命令侧已按优先级拼好）：
 *   virt-what（裸机输出为空）→ systemd-detect-virt（裸机输出 none）
 *   → DMI 厂商 / 产品名 → /proc/cpuinfo 的 hypervisor 标志
 * 三者都不能单独作为判据：有些云主机 virt-what 返回空但 DMI 里有厂商名，
 * 因此这里统一按关键字归类，而不是只判断「有没有输出」。
 */
const VIRT_RULES = [
  { kind: 'container', label: '容器环境', re: /docker|lxc|podman|container|rkt|systemd-nspawn|wsl|openvz/i },
  {
    kind: 'cloud',
    label: '云主机',
    // 注意 \b：不能写成 hyper-?v，否则会匹配到 "hypervisor" 这个词本身
    // （/proc/cpuinfo 的裸 hypervisor 标志会被误判成 Hyper-V / Azure）
    re: /\bhyper-?v\b|microsoft|azure|alibaba|aliyun|ali_cloud|amazon|ec2|google|gcp|huawei|tencent|qingcloud|openstack|nutanix/i,
  },
  {
    kind: 'vm',
    label: '虚拟机',
    re: /kvm|qemu|vmware|virtualbox|innotek|xen|parallels|bhyve|bochs|uml|zvm|virtual machine|hypervisor/i,
  },
];

// 云厂商是「谁提供的」，比 hypervisor 技术更能说明问题，因此单独一组并优先匹配：
// 阿里云主机的 virt-what 常只输出 kvm，厂商名来自 DMI，若按 token 顺序取会误报成 KVM。
const CLOUD_VENDOR = [
  [/alibaba|aliyun|ali_cloud/i, '阿里云'],
  [/amazon|ec2/i, 'AWS'],
  [/\bhyper-?v\b|microsoft|azure/i, 'Azure / Hyper-V'],
  [/google/i, 'GCP'],
  [/huawei/i, '华为云'],
  [/tencent/i, '腾讯云'],
  [/qingcloud/i, '青云'],
  [/openstack/i, 'OpenStack'],
  [/nutanix/i, 'Nutanix'],
];
// 同类中按 virt-what 输出顺序（由外到内）取第一个：
// VirtualBox 里跑嵌套 KVM 会同时输出 virtualbox 与 kvm，外层才是要报告的。
const VM_VENDOR = [
  [/vmware/i, 'VMware'],
  [/virtualbox|innotek/i, 'VirtualBox'],
  [/kvm|qemu/i, 'KVM/QEMU'],
  [/xen/i, 'Xen'],
  [/parallels/i, 'Parallels'],
  [/bhyve/i, 'bhyve'],
  [/bochs/i, 'Bochs'],
];
const CONTAINER_VENDOR = [
  [/docker/i, 'Docker'],
  [/lxc/i, 'LXC'],
  [/podman/i, 'Podman'],
  [/wsl/i, 'WSL'],
];

function pickVendor(kind, tokens) {
  if (kind === 'container') {
    for (const t of tokens) {
      const hit = CONTAINER_VENDOR.find(([re]) => re.test(t));
      if (hit) return hit[1];
    }
    return null;
  }
  if (kind === 'cloud') {
    // 云厂商优先，且不受 token 顺序影响
    for (const t of tokens) {
      const hit = CLOUD_VENDOR.find(([re]) => re.test(t));
      if (hit) return hit[1];
    }
  }
  for (const t of tokens) {
    const hit = VM_VENDOR.find(([re]) => re.test(t));
    if (hit) return hit[1];
  }
  return null;
}

function classifyVirt(raw) {
  const text = String(raw || '');
  const toks = text
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const meaningful = toks.filter((s) => s !== 'none' && s !== 'unknown');
  const hasHypervisorFlag = /(^|\n)\s*hypervisor\s*($|\n)/i.test(text);

  if (!meaningful.length && !hasHypervisorFlag) {
    return { virtualized: false, kind: 'physical', label: '物理机', raw: text.trim() };
  }

  const eff = meaningful.length ? meaningful : ['hypervisor'];
  for (const rule of VIRT_RULES) {
    if (eff.some((s) => rule.re.test(s))) {
      const vendor = pickVendor(rule.kind, eff);
      const label = vendor ? `${rule.label}（${vendor}）` : `${rule.label}（${eff.join(' ')}）`;
      return { virtualized: true, kind: rule.kind, label, raw: text.trim() };
    }
  }
  return { virtualized: true, kind: 'vm', label: `虚拟化环境（${eff.join(' ')}）`, raw: text.trim() };
}


function skipped(reason) {
  return {
    columns: ['OS_CHECK_RESULT'],
    rows: [{ OS_CHECK_RESULT: '不适用：' + reason }],
    rowCount: 1,
    meta: { notApplicable: true },
  };
}

function failed(reason) {
  return {
    columns: ['OS_CHECK_RESULT'],
    rows: [{ OS_CHECK_RESULT: '本机/远程采集失败：' + reason }],
    rowCount: 1,
    meta: { remoteFailed: true },
  };
}

/**
 * 取得（并复用）本次巡检的执行通道。
 * 优先级：显式配置的 SSH 远程采集 → 确认同机则用本机 shell → 都不行则「不适用」。
 */
async function ensureShell(ctx) {
  // 运行时共享状态由 runner 注入；这里兜底，避免调用方漏传就把整轮巡检打断
  if (!ctx.state) ctx.state = {};
  if (ctx.state.hostShellReason !== undefined) return null;
  if (ctx.state.hostShell) return ctx.state.hostShell;

  // 1) 显式配置了 SSH 远程采集
  const cfg = (ctx.options && ctx.options.remote) || null;
  if (cfg && cfg.enabled && String(cfg.host || '').trim()) {
    const sh = new RemoteShell(cfg);
    const p = await sh.probe();
    if (!p.ok) {
      ctx.state.hostShellReason = { kind: 'failed', message: p.message || '远程连接失败' };
      return null;
    }
    ctx.state.hostShell = sh;
    ctx.state.hostShellInfo = p;
    if (typeof ctx.log === 'function') ctx.log(p.message);
    return sh;
  }

  // 2) 未配置远程采集：如果工具本身就跑在数据库服务器上，直接本地执行
  if (process.platform !== 'linux') {
    ctx.state.hostShellReason = {
      kind: 'na',
      message:
        `本机 OS 检查项基于 Linux 命令（free / df / lscpu / sysctl 等），而当前工具运行在 ${process.platform} 上，无法本地采集。` +
        '请在「数据库服务器 OS 采集（SSH）」中填写 dmdba 账号与密码，改为 SSH 远程采集。',
    };
    return null;
  }

  const co = await detectColocation(ctx);
  if (!co.coLocated) {
    ctx.state.hostShellReason = {
      kind: 'na',
      message:
        `${co.reason}。请在「数据库服务器 OS 采集（SSH）」中填写 dmdba 账号与密码，改为 SSH 远程采集。`,
    };
    return null;
  }

  const sh = new RemoteShell({ local: true });
  const p = await sh.probe();
  if (!p.ok) {
    ctx.state.hostShellReason = { kind: 'failed', message: p.message || '本机 shell 不可用' };
    return null;
  }
  ctx.state.hostShell = sh;
  ctx.state.hostShellInfo = p;
  if (typeof ctx.log === 'function') ctx.log(p.message);
  return sh;
}

/**
 * 取得「数据库服务器」的 OS 指标（CPU 使用率 / 内存 / 磁盘 IO 速率与容量）。
 * ---------------------------------------------------------------------------
 * 按可用通道自动选择：
 *   1) 工具与数据库同机 → 本机 /proc（最快，不需要任何凭据）；
 *   2) 异机但能建立 shell 通道 → 在数据库服务器上采集；
 *   3) 都不行 → 返回 null，由调用方给出「未采集」说明。
 *
 * 为什么异机不能直接采本机：`/proc` 采到的是**工具所在主机**的指标，
 * 展示它会把跳板机的 CPU/IO 当成数据库服务器的，结论完全错误。
 *
 * 结果缓存在 ctx.state 上，供多个巡检项共用一次采样（也就只多一次 shell 往返）。
 * 放在本模块而不是 checks.js，是为了让 OS 巡检项也能直接复用，同时避免循环依赖。
 */
async function dbHostOsInfo(ctx, opts) {
  if (!ctx.state) ctx.state = {}; // 调用方可能未注入 state（单测桩），这里兜底
  if (ctx.state.dbOsInfo !== undefined) return ctx.state.dbOsInfo;

  const co = await detectColocation(ctx);
  if (co.coLocated) {
    const info = await probeOs(opts);
    info.via = 'local';
    ctx.state.dbOsInfo = info;
    return info;
  }

  const sh = await ensureShell(ctx);
  if (sh) {
    const info = await probeOsViaShell(sh, opts);
    if (info) {
      ctx.state.dbOsInfo = info;
      return info;
    }
  }

  ctx.state.dbOsInfo = null;
  ctx.state.dbOsReason = co.reason;
  return null;
}

/** 统一入口：拿到批量执行结果，或返回跳过/失败结果 */
async function withRemote(ctx, entries, build) {
  const sh = await ensureShell(ctx);
  if (!sh) {
    const r = ctx.state.hostShellReason || { kind: 'na', message: '不可用' };
    return r.kind === 'failed' ? failed(r.message) : skipped(r.message);
  }
  const res = await sh.runBatch(entries);
  if (!res._ok && !res._markers.length) {
    return failed(res._message || res._error || '命令执行失败');
  }
  return build(res, ctx.state.hostShellInfo || {});
}

/** 统一处理「不适用（未配置远程采集）」与「远程采集失败」两种情况 */
function guarded(fn) {
  return (rows, data, ectx) => {
    const meta = (data && data.meta) || {};
    if (meta.notApplicable) {
      return { level: 'info', message: (rows[0] && rows[0].OS_CHECK_RESULT) || '不适用。' };
    }
    if (meta.remoteFailed) {
      return {
        level: 'warn',
        message: (rows[0] && rows[0].OS_CHECK_RESULT) || '远程采集失败。请检查 SSH 地址、账号、认证方式与网络连通性。',
      };
    }
    return fn(rows, data, ectx);
  };
}

function verdictEval(rows) {
  const bad = rows.filter((r) => /严重|警告|需关注|异常/.test(String(r.VERDICT || '')));
  if (!rows.length) return { level: 'info', message: '未采集到数据。' };
  if (!bad.length) return { level: 'ok', message: `共 ${rows.length} 项检查项，均正常。` };
  const crit = bad.some((r) => /严重/.test(String(r.VERDICT)));
  return {
    level: crit ? 'crit' : 'warn',
    message: `共 ${bad.length}/${rows.length} 项需要关注：${bad.map((r) => r.ITEM + '（' + r.VERDICT + '）').join('；')}。`,
  };
}

function rowLevelOf(row) {
  const v = String(row.VERDICT || '');
  if (/严重/.test(v)) return 'crit';
  if (/警告|需关注|异常/.test(v)) return 'warn';
  return null;
}

module.exports = [
  // ------------------------------------------------------- 主机与 CPU
  {
    // 注意：不要用 os.host —— checks.js 里采集数据库服务器 OS 指标的那一项已占用该 id，
    // 重复 id 会在报告的 DOM 里产生重复锚点，也会让按 id 查找的代码产生歧义。
    id: 'os.cpu',
    group: '主机与资源',
    title: '主机与 CPU 信息',
    desc:
      '采集数据库服务器的操作系统、内核、架构、glibc、虚拟化类型、CPU 型号与核数、系统负载与 CPU 使用率。' +
      'CPU 使用率需要两次采样，由 dbHostOsInfo 统一采集（同机读本机 /proc，异机走 shell 通道）。',
    display: 'table',
    custom: async (ctx) => {
      // CPU 使用率需要间隔采样，单独取一次；结果在 ctx.state 上缓存，
      // 本组其它项与「资源与参数合理性分析」共用，不会重复建连。
      const osi = await dbHostOsInfo(ctx, { sampleMs: 1000 });
      return withRemote(
        ctx,
        [
          { id: 'osrel', cmd: 'cat /etc/system-release 2>/dev/null || head -3 /etc/os-release 2>/dev/null' },
          { id: 'kernel', cmd: 'uname -r' },
          { id: 'arch', cmd: 'uname -m' },
          { id: 'glibc', cmd: 'ldd --version 2>&1 | head -1' },
          {
            // 运行环境识别：virt-what 裸机输出为空、systemd-detect-virt 裸机输出 none，
            // 云主机有时两者都识别不出，因此再补 DMI 厂商与 cpuinfo 的 hypervisor 标志
            id: 'virt',
            cmd:
              "if command -v virt-what >/dev/null 2>&1; then virt-what 2>/dev/null; " +
              "elif command -v systemd-detect-virt >/dev/null 2>&1; then systemd-detect-virt 2>/dev/null; fi; " +
              'cat /sys/class/dmi/id/sys_vendor 2>/dev/null; ' +
              'cat /sys/class/dmi/id/product_name 2>/dev/null; ' +
              "grep -m1 -ow hypervisor /proc/cpuinfo 2>/dev/null",
          },
          { id: 'cpumodel', cmd: "awk -F: '/model name/ {gsub(/^ +/,\"\",$2); print $2; exit}' /proc/cpuinfo" },
          { id: 'sockets', cmd: "awk -F: '/physical id/ {print $2}' /proc/cpuinfo | sort -u | wc -l" },
          { id: 'cores', cmd: 'grep -c ^processor /proc/cpuinfo' },
          { id: 'load', cmd: 'cat /proc/loadavg' },
          { id: 'uptime', cmd: 'uptime -p 2>/dev/null || uptime' },
        ],
        (r, info) => {
          const load = String(r.load || '').trim().split(/\s+/);
          const load1 = num(load[0]);
          const cores = num(String(r.cores || '').trim());
          const virt = classifyVirt(r.virt);
          const rows = [
            { ITEM: '远程主机', VALUE: info.hostname || '未知', VERDICT: '正常' },
            { ITEM: '操作系统', VALUE: String(r.osrel || '').split('\n')[0] || '未知', VERDICT: '正常' },
            { ITEM: '内核版本', VALUE: r.kernel || '未知', VERDICT: '正常' },
            { ITEM: '系统架构', VALUE: r.arch || '未知', VERDICT: '正常' },
            { ITEM: 'glibc 版本', VALUE: String(r.glibc || '').trim() || '未知', VERDICT: '正常' },
            {
              ITEM: '运行环境',
              VALUE: virt.virtualized
                ? `${virt.label}｜检测输出：${virt.raw || '(空)'}`
                : '物理机（未检测到虚拟化）',
              VERDICT: virt.virtualized
                ? virt.kind === 'container'
                  ? '提示：容器环境，CPU/内存受 cgroup 限额约束，读数不代表宿主机整机'
                  : '提示：非物理机，CPU/内存/磁盘 IO 受宿主机与其他虚机影响，容量与性能结论需结合虚拟化层判断'
                : '正常',
            },
            { ITEM: 'CPU 型号', VALUE: r.cpumodel || '未知', VERDICT: '正常' },
            { ITEM: '物理 CPU 座数', VALUE: String(r.sockets || '').trim(), VERDICT: '正常' },
            { ITEM: '逻辑 CPU 核数', VALUE: String(cores === null ? r.cores : cores), VERDICT: '正常' },
            { ITEM: '系统运行时长', VALUE: String(r.uptime || '').trim() || '未知', VERDICT: '正常' },
          ];
          if (load1 !== null && cores) {
            const ratio = load1 / cores;
            rows.push({
              ITEM: '1 分钟负载',
              VALUE: `${load1}（${load.slice(1, 3).join(' / ')}），核数 ${cores}`,
              VERDICT: ratio > 1 ? '警告：负载已超过核数，系统存在排队' : '正常',
            });
          }
          // CPU 使用率（原「数据库服务器 OS 指标」一项独有，合并到这里）
          if (osi && osi.cpuPct !== null && osi.cpuPct !== undefined) {
            const pct = osi.cpuPct;
            rows.push({
              ITEM: 'CPU 使用率（采样 1 秒）',
              VALUE: `${pct.toFixed(2)}%`,
              VERDICT: pct > 90 ? '警告：CPU 使用率持续高位，请排查慢 SQL' : '正常',
            });
          }
          return { columns: COLS_BASE, rows, rowCount: rows.length, meta: { virtualization: virt } };
        }
      );
    },
    rowLevel: rowLevelOf,
    evaluate: guarded(verdictEval),
  },

  // ------------------------------------------------------- 内存与 swap
  {
    id: 'os.mem',
    group: '主机与资源',
    title: '内存与 Swap 使用情况',
    desc: '采集操作系统物理内存、可用内存、Swap 使用情况并判断水位',
    display: 'table',
    custom: async (ctx) =>
      withRemote(
        ctx,
        [
          { id: 'free', cmd: 'free -m 2>/dev/null' },
          { id: 'meminfo', cmd: "awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/ {printf \"%s %.0f MB\\n\", $1, $2/1024}' /proc/meminfo 2>/dev/null" },
        ],
        (r) => {
          const rows = [];
          const lines = String(r.free || '').split('\n');
          const memLine = lines.find((l) => /^Mem:/.test(l.trim()));
          const swapLine = lines.find((l) => /^Swap:/.test(l.trim()));
          const p = (l) => (l || '').trim().split(/\s+/);
          if (memLine) {
            const f = p(memLine);
            const total = num(f[1]);
            const used = num(f[2]);
            const avail = num(f[6]) !== null ? num(f[6]) : num(f[3]);
            const usedPct = total ? ((total - (avail === null ? 0 : avail)) / total) * 100 : null;
            rows.push({
              ITEM: '物理内存',
              VALUE: `总 ${total} MB，已用 ${used} MB，可用 ${avail} MB${usedPct === null ? '' : '（使用率 ' + usedPct.toFixed(2) + '%）'}`,
              VERDICT:
                usedPct === null ? '无法判定' : usedPct > 95 ? '严重：内存几乎耗尽' : usedPct > 90 ? '警告：内存使用率偏高' : '正常',
            });
          } else {
            rows.push({ ITEM: '物理内存', VALUE: String(r.meminfo || '').replace(/\n/g, '；') || '未能采集', VERDICT: '未知' });
          }
          if (swapLine) {
            const f = p(swapLine);
            const st = num(f[1]);
            const su = num(f[2]);
            const pct = st ? (su / st) * 100 : null;
            rows.push({
              ITEM: 'Swap',
              VALUE: st === 0 ? '未启用 Swap' : `总 ${st} MB，已用 ${su} MB${pct === null ? '' : '（使用率 ' + pct.toFixed(2) + '%）'}`,
              VERDICT: st === 0 ? '正常' : pct > 50 ? '警告：Swap 使用率偏高，可能存在内存压力' : '正常',
            });
          }
          return { columns: COLS_BASE, rows, rowCount: rows.length };
        }
      ),
    rowLevel: rowLevelOf,
    evaluate: guarded(verdictEval),
  },

  // ------------------------------------------------------- 磁盘使用率
  {
    id: 'os.disk',
    group: '主机与资源',
    title: '磁盘空间使用率',
    desc: '各挂载点的容量与使用率；使用率超过 85% 警告、超过 90% 严重（达梦数据/归档/备份目录写满会导致实例异常）',
    maxRows: 60,
    bars: { USED_PCT: { warn: 85, crit: 90 } },
    custom: async (ctx) =>
      withRemote(
        ctx,
        [{
          // 必须排除只读/伪文件系统：真机（DMDSC 节点）上挂着一个 VirtualBox
          // 增强功能光盘 /dev/sr0（iso9660，只读），df 显示 100% 已用，
          // 若不过滤就会报「严重：随时可能写满」——而只读介质根本不可能被写满。
          id: 'df',
          cmd:
            'df -hP -x tmpfs -x devtmpfs -x overlay -x iso9660 -x squashfs -x autofs -x squashfs -x nsfs 2>/dev/null ' +
            "|| df -hP 2>/dev/null | grep -vE 'tmpfs|devtmpfs|iso9660|squashfs|overlay'",
        }],
        (r) => {
          const rows = [];
          for (const line of String(r.df || '').split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length < 6 || !/^\d+%$/.test(f[4])) continue;
            const pct = num(f[4]);
            rows.push({
              FILESYSTEM: f[0],
              SIZE: f[1],
              USED: f[2],
              AVAIL: f[3],
              USED_PCT: String(pct),
              MOUNTED_ON: f.slice(5).join(' '),
              VERDICT: pct >= 90 ? '严重：随时可能写满' : pct >= 85 ? '警告：空间不足' : '正常',
            });
          }
          return {
            columns: ['FILESYSTEM', 'SIZE', 'USED', 'AVAIL', 'USED_PCT', 'MOUNTED_ON', 'VERDICT'],
            rows,
            rowCount: rows.length,
          };
        }
      ),
    rowLevel(row) {
      const p = num(row.USED_PCT);
      if (p === null) return null;
      if (p >= 90) return 'crit';
      if (p >= 85) return 'warn';
      return null;
    },
    evaluate: guarded(function (rows) {
      if (!rows.length) return { level: 'info', message: '未采集到磁盘信息。' };
      const crit = rows.filter((r) => num(r.USED_PCT) >= 90);
      const warn = rows.filter((r) => num(r.USED_PCT) >= 85 && num(r.USED_PCT) < 90);
      if (crit.length) {
        return {
          level: 'crit',
          message: `以下挂载点使用率超过 90%：${crit.map((r) => r.MOUNTED_ON + '(' + r.USED_PCT + '%)').join('、')}。请立即清理或扩容，磁盘写满会导致数据库挂起。`,
        };
      }
      if (warn.length) {
        return { level: 'warn', message: `以下挂载点使用率超过 85%：${warn.map((r) => r.MOUNTED_ON + '(' + r.USED_PCT + '%)').join('、')}。` };
      }
      return { level: 'ok', message: `共 ${rows.length} 个挂载点，使用率均在 85% 以下。` };
    }),
  },

  // --------------------------------------------- 磁盘配置（分区/挂载/调度）
  {
    id: 'os.diskconf',
    group: '主机与资源',
    title: '磁盘分区、挂载与调度算法',
    desc: 'lsblk 分区信息、/etc/fstab 挂载配置、块设备 IO 调度算法（SSD 建议 none/mq-deadline，机械盘建议 mq-deadline）',
    maxRows: 80,
    custom: async (ctx) =>
      withRemote(
        ctx,
        [
          { id: 'lsblk', cmd: 'lsblk -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null || lsblk 2>/dev/null || echo "(lsblk unavailable)"' },
          { id: 'fstab', cmd: "grep -v '^#' /etc/fstab 2>/dev/null | grep -v '^$' || echo '(fstab unreadable)'" },
          {
            id: 'sched',
            cmd:
              'for d in /sys/block/sd* /sys/block/vd* /sys/block/nvme* /sys/block/xvd*; do ' +
              '[ -e "$d/queue/scheduler" ] && echo "$(basename $d): $(cat $d/queue/scheduler)"; done 2>/dev/null || echo "(scheduler unreadable)"',
          },
        ],
        (r) => {
          const rows = [];
          const push = (type, content) => {
            String(content || '')
              .split('\n')
              .filter((l) => l.trim())
              .slice(0, 25)
              .forEach((l) => rows.push({ TYPE: type, CONTENT: l.trim() }));
          };
          push('分区(lsblk)', r.lsblk);
          push('挂载(/etc/fstab)', r.fstab);
          push('调度算法(scheduler)', r.sched);
          return { columns: ['TYPE', 'CONTENT'], rows, rowCount: rows.length };
        }
      ),
    evaluate: guarded(function (rows) {
      if (!rows.length) return { level: 'info', message: '未采集到磁盘配置信息。' };
      const sched = rows.filter((r) => r.TYPE.startsWith('调度算法'));
      const md = sched.filter((r) => /mq-deadline|none|noop|deadline/.test(String(r.CONTENT)));
      const msg = `共采集 ${rows.length} 条（分区 ${rows.filter((r) => r.TYPE.startsWith('分区')).length}、挂载 ${rows.filter((r) => r.TYPE.startsWith('挂载')).length}、调度算法 ${sched.length}）`;
      if (sched.length && !md.length) {
        return { level: 'warn', message: msg + '。磁盘调度算法中未发现 none/mq-deadline，SSD 场景下建议调整为 none 或 mq-deadline。' };
      }
      return { level: 'info', message: msg + '。' };
    }),
  },

  // ------------------------------------------------------- IO 压力
  {
    id: 'os.io',
    group: '主机与资源',
    title: '磁盘 IO 压力与内核报错',
    desc:
      'iostat 各设备利用率、读写吞吐与 IOPS（/proc 采样）、内核 dmesg 中的 IO 错误' +
      '（iostat 需安装 sysstat；dmesg 通常需要 root）',
    maxRows: 60,
    custom: async (ctx) => {
      // 吞吐与 IOPS 需要间隔采样，由 dbHostOsInfo 统一采集（结果已缓存）
      const osi = await dbHostOsInfo(ctx, { sampleMs: 1000 });
      return withRemote(
        ctx,
        [
          {
            id: 'iostat',
            cmd:
              'if command -v iostat >/dev/null 2>&1; then iostat -x 1 1 2>/dev/null | tail -30; ' +
              "else echo '(iostat unavailable: install sysstat)'; fi",
          },
          {
            // 只关注真正的 IO / 文件系统错误。泛泛的 "error" 会把 ACPI、
            // 固件之类的正常告警也算进来，在虚拟机上几乎每次都命中，没有参考价值。
            // 另外必须显式区分「可读但无错误」与「不可读」，否则空输出会被误判为未采集。
            id: 'dmesg',
            cmd:
              'if dmesg >/dev/null 2>&1; then ' +
              "out=$(dmesg 2>/dev/null | grep -iE 'i/o error|blk_update_request|buffer i/o|medium error|critical medium|EXT4-fs error|XFS .*error|attempt to access beyond end of device|remounting filesystem read-only' | tail -15); " +
              'if [ -n "$out" ]; then echo "$out"; else echo "(no-io-errors)"; fi; ' +
              "else echo '(dmesg-unreadable: dmesg_restrict or needs root; try journalctl -k)'; fi",
          },
        ],
        (r) => {
          const rows = [];
          // 吞吐与 IOPS（原「数据库服务器 OS 指标」一项独有，合并到这里）
          if (osi && osi.io) {
            const io = osi.io;
            rows.push({
              TYPE: '读写吞吐',
              DEVICE: `${io.devices} 个整块设备`,
              VALUE: `读 ${fmtBytesOf(io.readBytesPerSec)}/s，写 ${fmtBytesOf(io.writeBytesPerSec)}/s`,
              DETAIL: '采样 1 秒',
              VERDICT: '正常',
            });
            rows.push({
              TYPE: 'IOPS',
              DEVICE: `${io.devices} 个整块设备`,
              VALUE: `读 ${io.readIops.toFixed(1)}，写 ${io.writeIops.toFixed(1)}`,
              DETAIL: '采样 1 秒',
              VERDICT: '正常',
            });
          }
          const lines = String(r.iostat || '').split('\n');
          let header = null;
          for (const line of lines) {
            const f = line.trim().split(/\s+/);
            if (!f.length) continue;
            if (/^Device$/i.test(f[0])) {
              header = f;
              continue;
            }
            if (!header || !/^(sd|vd|nvme|dm-|hd|xvd)/i.test(f[0])) continue;
            const idx = header.findIndex((h) => /%util/i.test(h));
            const util = idx >= 0 ? num(f[idx]) : null;
            const rAwait = header.findIndex((h) => /await/i.test(h));
            rows.push({
              TYPE: 'IO 利用率',
              DEVICE: f[0],
              VALUE: util === null ? '-' : util + '%',
              DETAIL: rAwait >= 0 ? ('await ' + (f[rAwait] || '-') + ' ms') : '',
              VERDICT: util === null ? '未知' : util >= 90 ? '严重：磁盘接近饱和' : util >= 70 ? '警告：磁盘 IO 偏高' : '正常',
            });
          }
          const dmesgText = String(r.dmesg || '').trim();
          const dmesgUnreadable = /dmesg-unreadable/.test(dmesgText);
          const noIoErrors = /\(no-io-errors\)/.test(dmesgText);
          if (dmesgUnreadable || !dmesgText) {
            // 读不到不能被当成「没有内核错误」，单独标为未采集
            rows.push({ TYPE: '内核报错', DEVICE: '-', VALUE: dmesgText || '未采集', DETAIL: '', VERDICT: '未采集' });
          } else if (noIoErrors) {
            // 明确区分：dmesg 读到了，只是确实没有 IO 类错误
            rows.push({ TYPE: '内核报错', DEVICE: '-', VALUE: 'dmesg 中未发现 IO / 文件系统错误', DETAIL: '', VERDICT: '正常' });
          } else {
            dmesgText
              .split('\n')
              .filter((l) => l.trim())
              .slice(0, 15)
              .forEach((l) => rows.push({ TYPE: '内核报错', DEVICE: '-', VALUE: l.trim().slice(0, 160), DETAIL: '', VERDICT: '需关注' }));
          }
          if (!rows.length) rows.push({ TYPE: 'IO 检查', DEVICE: '-', VALUE: '未能采集到 IO 数据', DETAIL: '', VERDICT: '未知' });
          return { columns: ['TYPE', 'DEVICE', 'VALUE', 'DETAIL', 'VERDICT'], rows, rowCount: rows.length };
        }
      );
    },
    rowLevel: rowLevelOf,
    evaluate: guarded(function (rows) {
      const io = rows.filter((r) => r.TYPE === 'IO 利用率');
      // 只有明确标为「需关注」的才是真正的内核错误；
      // 「未采集」和「未发现 IO 错误」这两类提示行不能被算进去
      const errs = rows.filter((r) => r.TYPE === '内核报错' && String(r.VERDICT) === '需关注');
      const unread = rows.filter((r) => r.TYPE === '内核报错' && String(r.VERDICT) === '未采集');
      const msgs = [];
      let level = 'ok';
      const bad = io.filter((r) => num(String(r.VALUE).replace('%', '')) >= 70);
      if (bad.length) {
        level = bad.some((r) => num(String(r.VALUE).replace('%', '')) >= 90) ? 'crit' : 'warn';
        msgs.push(`设备 ${bad.map((r) => r.DEVICE + '(' + r.VALUE + ')').join('、')} 的 IO 利用率偏高`);
      }
      if (errs.length) {
        level = level === 'ok' ? 'warn' : level;
        msgs.push(`内核日志中有 ${errs.length} 条 IO / 文件系统错误记录，请确认磁盘或文件系统是否异常`);
      }
      if (unread.length) {
        msgs.push('内核日志未能读取（dmesg 权限不足，需要 root 或关闭 dmesg_restrict），该项未采集');
      }
      if (!msgs.length) {
        return {
          level: 'ok',
          message: io.length
            ? `已采集 ${io.length} 个设备的 IO 利用率，均低于 70%；内核日志中未发现 IO / 文件系统错误。`
            : '未采集到 IO 数据（可能未安装 sysstat）；内核日志中未发现 IO / 文件系统错误。',
        };
      }
      return { level, message: msgs.join('；') + '。' };
    }),
  },

  // ------------------------------------------------- 进程与定时任务
  {
    id: 'os.proc',
    group: '主机与资源',
    title: '数据库进程、定时任务与 core 路径',
    desc: '确认 dmserver / dmwatcher / dmmonitor 等关键进程存活，列出 crontab 与 core dump 路径',
    maxRows: 60,
    custom: async (ctx) =>
      withRemote(
        ctx,
        [
          {
            id: 'procs',
            cmd:
              "ps -eo pid,user,pcpu,pmem,rss,etime,args --sort=-rss 2>/dev/null | grep -E 'dmserver|dmwatcher|dmmonitor|dmagent|dmap' | grep -v grep | head -15 || echo '(no dm process found)'",
          },
          { id: 'crontab', cmd: "crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | head -20 || echo '(no crontab)'" },
          { id: 'crond', cmd: 'ls -l /etc/cron.d/ 2>/dev/null | head -10 || echo "(no /etc/cron.d)"' },
          { id: 'core', cmd: "cat /proc/sys/kernel/core_pattern 2>/dev/null || echo '(unknown)'" },
        ],
        (r) => {
          const rows = [];
          const procs = String(r.procs || '').split('\n').filter((l) => l.trim());
          const hasDm = procs.some((l) => /dmserver/.test(l));
          procs.slice(0, 15).forEach((l) => rows.push({ TYPE: '数据库进程', CONTENT: l.trim().slice(0, 200) }));
          if (!procs.length || !hasDm) {
            rows.push({ TYPE: '数据库进程', CONTENT: '未发现 dmserver 进程' });
          }
          String(r.crontab || '')
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 20)
            .forEach((l) => rows.push({ TYPE: '定时任务(crontab)', CONTENT: l.trim().slice(0, 200) }));
          String(r.crond || '')
            .split('\n')
            .filter((l) => l.trim())
            .slice(0, 10)
            .forEach((l) => rows.push({ TYPE: '系统定时任务(/etc/cron.d)', CONTENT: l.trim().slice(0, 200) }));
          rows.push({ TYPE: 'core dump 路径', CONTENT: String(r.core || '').trim() || '未知' });
          return { columns: ['TYPE', 'CONTENT'], rows, rowCount: rows.length, meta: { hasDmServer: hasDm } };
        }
      ),
    evaluate: guarded(function (rows, data) {
      const meta = (data && data.meta) || {};
      if (!rows.length) return { level: 'info', message: '未采集到进程信息。' };
      const cron = rows.filter((r) => r.TYPE.startsWith('定时任务') || r.TYPE.startsWith('系统定时任务'));
      const core = rows.find((r) => r.TYPE === 'core dump 路径');
      if (meta.hasDmServer === false) {
        return { level: 'crit', message: '远程主机上未发现 dmserver 进程，请确认数据库实例是否运行在采集的主机上。' };
      }
      const coreNote = core && /^\|/.test(String(core.CONTENT)) ? ' core_pattern 以管道符开头（交由 apport 等处理），排查崩溃现场时注意。' : '';
      return { level: 'ok', message: `已采集数据库进程与 ${cron.length} 条定时任务配置。${coreNote}` };
    }),
  },

  // --------------------------------------------- 内核与系统参数合规
  {
    id: 'os.kernel',
    group: '主机与资源',
    title: '内核与系统参数检查',
    desc: 'SELinux、透明大页(THP)、NUMA、limits.conf、pam_limits、sysctl、systemd 资源限制——这些参数不达标会直接影响达梦性能与稳定性',
    display: 'table',
    custom: async (ctx) =>
      withRemote(
        ctx,
        [
          { id: 'selinux', cmd: "getenforce 2>/dev/null; grep -v '^#' /etc/selinux/config 2>/dev/null | grep SELINUX || echo '(no /etc/selinux/config)'" },
          {
            // 麒麟 V10 用的是自研的 kysec 安全模块，而不是 SELinux，单独检查
            id: 'kysec',
            cmd:
              "cat /etc/kylin-release 2>/dev/null || (cat /etc/.kyinfo 2>/dev/null | head -3) || echo '(not-kylin)'; " +
              'echo "---kysec---"; cat /sys/kernel/security/kysec/status 2>/dev/null || (getstatus 2>/dev/null | head -5) || echo "(kysec not detected)"',
          },
          { id: 'thp', cmd: "cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || echo '(not-exist)'" },
          { id: 'numa', cmd: "lscpu 2>/dev/null | grep -i numa || echo '(no numa info)'" },
          { id: 'limits', cmd: "grep -v '^#' /etc/security/limits.conf 2>/dev/null | grep -v '^$' | grep -v '^\\s*$' | head -20 || echo '(empty)'" },
          { id: 'pam', cmd: "grep pam_limits /etc/pam.d/login 2>/dev/null || echo '(pam_limits not configured)'" },
          { id: 'sysctlc', cmd: "grep -v '^#' /etc/sysctl.conf 2>/dev/null | grep -v '^$' | head -30 || echo '(empty)'" },
          { id: 'sysctlv', cmd: "sysctl -n vm.swappiness 2>/dev/null; sysctl -n vm.overcommit_memory 2>/dev/null; sysctl -n fs.file-max 2>/dev/null; sysctl -n net.core.somaxconn 2>/dev/null" },
          { id: 'systemd', cmd: "grep -E 'DefaultLimitNOFILE|DefaultLimitNPROC' /etc/systemd/system.conf 2>/dev/null || echo '(not configured)'" },
        ],
        (r) => {
          const rows = [];
          const add = (ITEM, VALUE, VERDICT) => rows.push({ ITEM, VALUE: String(VALUE || '').replace(/\n/g, '；') || '未采集', VERDICT });
          const sv = String(r.sysctlv || '').split('\n').map((x) => x.trim());
          const swappiness = num(sv[0]);
          const overcommit = num(sv[1]);
          const filemax = sv[2];
          const somaxconn = sv[3];

          const sel = String(r.selinux || '').trim();
          add('SELinux', sel || 'unknown', /enforcing/i.test(sel) ? '警告：SELinux 处于 enforcing，可能影响数据库运行' : '正常');

          // 麒麟系统自研的 kysec 安全模块（替代 SELinux）
          const ky = String(r.kysec || '').trim();
          const kyStatus = (ky.split('---kysec---')[1] || '').trim();
          if (kyStatus) {
            const detected = !/not detected/.test(kyStatus);
            const num = Number(kyStatus);
            // 麒麟 kysec 状态：0=关闭(正常)，1=警告模式，2=强制模式
            const on = detected && (/[1-9]/.test(kyStatus) || /enforc|enable/i.test(kyStatus));
            const off = detected && num === 0;
            add(
              '麒麟 kysec 安全模块',
              kyStatus.slice(0, 200),
              !detected || off ? '正常（kysec 未启用）' : on ? '提示：kysec 已启用，若遇权限类异常可临时切到 warning 模式核查' : '供核对'
            );
          }

          const thp = String(r.thp || '').trim();
          const thpAlways = /\[always\]/.test(thp);
          add('透明大页(THP)', thp || '不存在', thpAlways ? '警告：THP 为 always，达梦建议关闭以避免性能抖动' : '正常');

          add('NUMA', r.numa || '未采集', /numa/i.test(String(r.numa)) && !/无 NUMA/.test(String(r.numa)) ? '提示：存在 NUMA，建议确认绑核与内存策略' : '正常');

          const limits = String(r.limits || '').trim();
          const hasNofile = /nofile/i.test(limits);
          const hasNproc = /nproc/i.test(limits);
          add('limits.conf', limits.slice(0, 300), hasNofile && hasNproc ? '正常' : '警告：建议配置 nofile 与 nproc（如 65536）');

          const pam = String(r.pam || '').trim();
          add('pam_limits', pam || '未配置', /pam_limits/.test(pam) ? '正常' : '警告：/etc/pam.d/login 未启用 pam_limits.so，ulimit 设置不会生效');

          add('swappiness', swappiness === null ? '未采集' : String(swappiness), swappiness === null ? '未知' : swappiness > 10 ? '警告：建议设为 0~10，降低换页对数据库的影响' : '正常');
          add('overcommit_memory', overcommit === null ? '未采集' : String(overcommit), overcommit === null ? '未知' : overcommit === 2 ? '警告：建议设为 0 或 1' : '正常');
          // fs.file-max 在多数内核上就是 2^63-1（等同不限制），用 Number() 转成 JS 数字会
          // 丢掉精度、显示成 9223372036854776000 这种 19 位的假数字，所以超长值直接说明含义。
          const filemaxTxt = !filemax
            ? '未采集'
            : String(filemax).replace(/[,\s]/g, '').length > 15 || (num(filemax) || 0) >= 1e15
            ? `${filemax}（等同不限制）`
            : filemax;
          add('fs.file-max', filemaxTxt, filemax && num(filemax) < 100000 ? '警告：文件句柄上限偏小' : '正常');
          add('net.core.somaxconn', somaxconn || '未采集', somaxconn && num(somaxconn) < 1024 ? '警告：建议提高到 4096 以上' : '正常');
          // 注释掉的行（#DefaultLimitNOFILE=...）**不算已配置**：
          // 真机实测 /etc/systemd/system.conf 里两行都是注释，原实现因为「包含 DefaultLimitNOFILE
          // 这个字符串」就判「正常」，等于把注释当成了配置。
          const sysdTxt = String(r.systemd || '');
          const sysdSet = /^\s*DefaultLimit(NOFILE|NPROC)\s*=/m.test(sysdTxt);
          add(
            'systemd 资源限制',
            sysdTxt || '未配置',
            sysdSet ? '正常' : '提示：未配置 DefaultLimitNOFILE（注释掉的行不算配置），systemd 托管的实例可能继承默认限制'
          );
          add('sysctl.conf 内容', String(r.sysctlc || '').slice(0, 300), '供核对');

          return { columns: COLS_BASE, rows, rowCount: rows.length };
        }
      ),
    rowLevel(row) {
      const v = String(row.VERDICT || '');
      if (/警告/.test(v)) return 'warn';
      return null;
    },
    evaluate: guarded(verdictEval),
  },

  // ------------------------------------------------ 账号、环境与安全
  {
    id: 'os.account',
    group: '主机与资源',
    title: '账号、环境变量与安全设置',
    desc: 'dmdba 用户与 dinstall 组、环境变量、MALLOC_ARENA_MAX、防火墙状态、系统时区、网卡 IP、系统日志错误',
    maxRows: 80,
    custom: async (ctx) =>
      withRemote(
        ctx,
        [
          { id: 'dmdba', cmd: "id dmdba 2>/dev/null || echo 'dmdba-user-not-found'" },
          { id: 'group', cmd: "getent group dinstall 2>/dev/null || echo 'dinstall-group-not-found'" },
          {
            id: 'env',
            cmd:
              'if [ -r /home/dmdba/.bash_profile ]; then grep -v "^#" /home/dmdba/.bash_profile | grep -v "^$" | head -20; ' +
              "else echo '(bash_profile-unreadable)'; fi",
          },
          {
            // 达梦安装路径因环境而异：/opt/dmdbms、/home/dmdba/dmdbms 都常见，
            // 先按运行中的 dmserver 进程推断，再退回常见路径。
            // 不能硬编码 /opt/dmdbms——真实环境里装在 /home/dmdba/dmdbms 的情况很普遍。
            id: 'malloc',
            cmd:
              "dmhome=$(ps -eo args 2>/dev/null | grep -m1 '[d]mserver' | awk '{print $1}' | sed 's#/bin/.*##'); " +
              'if [ -z "$dmhome" ]; then for d in /opt/dmdbms /home/dmdba/dmdbms; do if [ -d "$d" ]; then dmhome=$d; break; fi; done; fi; ' +
              'echo "DM_HOME=${dmhome:-unknown}"; ' +
              'svc=$(ls "$dmhome"/bin/DmService* 2>/dev/null | head -1); ' +
              'if [ -n "$svc" ]; then ' +
              'if grep -q MALLOC_ARENA_MAX "$svc"; then grep -h MALLOC_ARENA_MAX "$svc"; else echo "(MALLOC_ARENA_MAX not set)"; fi; ' +
              "else echo '(DmService-script-not-found)'; fi",
          },
          {
            id: 'fw',
            cmd:
              'systemctl is-active firewalld 2>/dev/null || echo unknown; ' +
              'if command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --list-all 2>&1 | head -12; ' +
              "else echo '(firewalld not installed)'; fi",
          },
          { id: 'tz', cmd: 'date 2>/dev/null; date -R 2>/dev/null' },
          { id: 'net', cmd: "ip -4 addr show 2>/dev/null | grep inet || ifconfig 2>/dev/null | grep 'inet ' || echo '(no network info)'" },
          {
            // 同上：不能靠管道后的 || 判断权限，必须先判可读性，
            // 否则「读不到日志」会被误判成「日志里没有错误」。
            //
            // 还要排除「本工具自己造成的记录」：麒麟等系统有审计子系统
            // （mm_audit_run_command / audit_run_command），会把我们通过 SSH 执行的
            // 每条命令原文记进系统日志，其中就带 error/@@@DM8CHK 等字样，
            // 不过滤就会把自己跑的命令当成系统错误报出来。
            id: 'syslog',
            cmd:
              'EXC="mm_audit_run_command|audit_run_command|@@@DM8CHK|##NODIR##|##DIR##|##NOPERM##|##FINDFAIL##"; ' +
              'if [ -r /var/log/messages ]; then grep -iE "error|fail" /var/log/messages | grep -viE "$EXC" | tail -10; ' +
              'elif [ -r /var/log/syslog ]; then grep -iE "error|fail" /var/log/syslog | grep -viE "$EXC" | tail -10; ' +
              "else echo '(syslog-unreadable: needs root or adm group)'; fi",
          },
        ],
        (r) => {
          const rows = [];
          const add = (ITEM, VALUE, VERDICT) => rows.push({ ITEM, VALUE: String(VALUE || '').replace(/\n/g, '；').slice(0, 300) || '未采集', VERDICT });

          const idOut = String(r.dmdba || '').trim();
          add('dmdba 用户', idOut, /not-found/.test(idOut) ? '严重：未找到 dmdba 用户，达梦通常以该账号运行' : '正常');

          const grp = String(r.group || '').trim();
          // dinstall 只是达梦安装器默认创建的组，手工安装的实例常常只有 dmdba 组
          // （真机 DMDSC 节点就是 dmdba:x:1000:，没有 dinstall），这属于安装方式差异，
          // 不是缺陷 —— 数据库本身以 dmdba 正常运行时不该因此报警告。
          add('dinstall 组', grp, /not-found/.test(grp) ? '供核对：未创建 dinstall 组（手工安装常见，dmdba 单独成组即可）' : '正常');

          const env = String(r.env || '').trim();
          add(
            'dmdba 环境变量',
            env.slice(0, 300),
            /unreadable/.test(env) ? '供核对' : /DM_HOME|LD_LIBRARY_PATH/.test(env) ? '正常' : '警告：环境变量中未见 DM_HOME / LD_LIBRARY_PATH，建议核查'
          );

          const ml = String(r.malloc || '').trim();
          const dmHome = (/DM_HOME=([^\s]+)/.exec(ml) || [])[1] || '';
          if (dmHome && dmHome !== 'unknown') {
            add('达梦安装目录', dmHome, '供核对');
          }
          let mlVerdict;
          if (/MALLOC_ARENA_MAX/.test(ml)) mlVerdict = '正常';
          else if (/not-found|not set/.test(ml)) {
            mlVerdict = /not-found/.test(ml) ? '供核对' : '警告：DmService 脚本未设置 MALLOC_ARENA_MAX，多核高并发下 glibc 内存分配可能膨胀';
          } else mlVerdict = '供核对';
          add('MALLOC_ARENA_MAX', ml.replace(/^DM_HOME=[^\s]*\s*/, ''), mlVerdict);

          const fw = String(r.fw || '').trim();
          const fwActive = /^active/m.test(fw);
          add('防火墙', fw.slice(0, 300), fwActive ? '提示：firewalld 处于 active，请确认数据库端口已放通' : '正常');

          const tz = String(r.tz || '').trim();
          add('日期时间与时区', tz, /\+0800|CST/.test(tz) ? '正常' : '警告：时区不是 +0800/CST，可能导致日志时间与业务时间对不上');

          add('网卡 IP', r.net || '未采集', '供核对');
          add(
            '系统日志 error/fail',
            r.syslog || '未采集',
            /(unreadable|needs root|denied)/.test(String(r.syslog)) ? '未采集：dmdba 默认读不到系统日志，需要 root 或加入 adm 组' : '供核对'
          );

          return { columns: COLS_BASE, rows, rowCount: rows.length };
        }
      ),
    rowLevel(row) {
      const v = String(row.VERDICT || '');
      if (/严重/.test(v)) return 'crit';
      if (/警告/.test(v)) return 'warn';
      return null;
    },
    evaluate: guarded(verdictEval),
  },
];

// 日志检查（log.scan）需要复用同一条 shell 通道，避免重复建连
module.exports.ensureShell = ensureShell;
// OS 指标采样供本模块的巡检项与 checks.js 的「资源与参数合理性分析」共用
module.exports.dbHostOsInfo = dbHostOsInfo;
// 运行环境识别（供自检与报告复用）
module.exports.classifyVirt = classifyVirt;
