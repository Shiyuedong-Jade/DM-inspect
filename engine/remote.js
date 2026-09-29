'use strict';
/*
 * 远程 shell 采集（SSH）
 * ---------------------------------------------------------------------------
 * 设计要点：
 *  1) 零依赖：直接调用操作系统自带的 ssh 客户端，不引入 ssh2 等 npm 包；
 *  2) 输出重定向到文件而不是管道——既避开受限环境下无法创建命名管道的问题，
 *     也避免 Windows 控制台 GBK 编码破坏中文输出；
 *  3) 批量执行：多条命令拼成一个脚本、一次 SSH 往返完成，
 *     避免 50 条命令建 50 次连接（这点对巡检耗时影响很大）；
 *  4) 认证：优先 SSH 密钥（-i）；也支持密码，但需要系统装有 sshpass，
 *     且密码通过环境变量 SSHPASS 传递（不用 -p 参数，避免出现在 ps 输出里）；
 *  5) 所有执行的命令都来自本工具内置的白名单，不接受用户直接下发 shell。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
// 与 drivers/jdbc.js 保持同一套「工作目录」规则：默认工程根目录，
// 被内嵌（DSH 插件）时由 DM8_INSPECT_HOME 重定向。SSH 通道的一次性文件
// （known_hosts、批量脚本、输出）都落在这里。
const RUNTIME_DIR = process.env.DM8_INSPECT_HOME
  ? path.join(path.resolve(process.env.DM8_INSPECT_HOME), 'runtime')
  : path.join(__dirname, '..', 'runtime');

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

/**
 * 运行期临时文件的清理。
 * ---------------------------------------------------------------------------
 * 巡检会在 runtime/ 下落一些中间文件（ssh 输出、Java 桥接 stderr、编译日志…），
 * 它们只对「本次运行排查问题」有用，跑完就该删掉 —— 否则会一直堆积
 * （实测每轮一个 ssh 日志，最快时一天能堆到近百 MB）。
 *
 * 清理分两级，**是为了支持多节点并行巡检**：
 *   1) 每个 RemoteShell / JdbcSession 在 dispose/close 时删掉**自己那一个**
 *      按 pid+时间戳命名的文件（不会碰到别的节点正在用的文件）；
 *   2) 整轮巡检最后一个节点跑完时，再做一次 sweepRuntime() 兜底清理
 *      ——此时确定没有其它节点在使用，删固定名的诊断日志才安全。
 * 早期版本用「全局登记表 + 每个节点跑完就全清」，在多节点并行时会误删
 * 其它节点正在读取的文件（例如 keyscan 输出），这里改掉了。
 *
 * 刻意不清理的两项（是可复用状态，不是本次运行的临时产物）：
 *   - runtime/ssh_known_hosts  主机密钥信任库（删了每次都要重新协商/确认）
 *   - runtime/classes/         Java 8 下 javac 编译缓存（重建代价高）
 */
const TEMP_PATTERNS = [
  /^ssh-\d+-\d+\.log$/,
  /^bridge-\d+-\d+\.log$/,
  /^probe-.*\.log$/,
  /^keyscan-.*\.log$/,
  /^java-probe\.log$/,
  /^bridge-compile\.log$/,
  /^sshpass-probe\.log$/,
];
const KEEP_NAMES = new Set(['ssh_known_hosts']);

/** 兜底清理：删除所有已知的临时文件（保留信任库与编译缓存），返回删除数量 */
function sweepRuntime() {
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(RUNTIME_DIR);
  } catch (_) {
    return 0;
  }
  for (const name of names) {
    if (KEEP_NAMES.has(name) || name === 'classes') continue;
    if (!TEMP_PATTERNS.some((re) => re.test(name))) continue;
    try {
      fs.unlinkSync(path.join(RUNTIME_DIR, name));
      n++;
    } catch (_) {
      /* 尽力而为，不影响巡检 */
    }
  }
  return n;
}

function removeQuietly(p) {
  try {
    fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

/** 单引号安全包裹，用于把脚本作为单个参数交给 ssh */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** 执行命令并把 stdout/stderr 写入文件（不使用管道） */
function runToFile(cmd, args, logFile, timeoutMs, env) {
  return new Promise((resolve) => {
    let fd = 'ignore';
    try {
      fd = fs.openSync(logFile, 'w');
    } catch (_) {
      /* ignore */
    }
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: env || process.env,
      });
    } catch (e) {
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
      return resolve({ ok: false, code: -1, error: String((e && e.message) || e), text: '' });
    }

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
      let text = '';
      try {
        const buf = fs.readFileSync(logFile);
        const slice = buf.length > 2 * 1024 * 1024 ? buf.subarray(buf.length - 2 * 1024 * 1024) : buf;
        text = decodeOutput(slice);
      } catch (_) {
        /* ignore */
      }
      resolve(Object.assign({ text }, result));
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish({ ok: false, code: -1, error: 'timeout' });
    }, timeoutMs || 45000);

    child.on('error', (e) => finish({ ok: false, code: -1, error: String((e && e.message) || e) }));
    child.on('exit', (code) => finish({ ok: code === 0, code }));
  });
}

const MARK_PREFIX = '@@@DM8CHK:';
const MARK_END = '@@@DM8CHK:__END__@@@';

/**
 * 从 plink 自己的输出中提取主机密钥指纹。
 *
 * 这是 Windows 上**最可靠**的取指纹方式：plink 已经用自己的 KEX 策略成功协商到了
 * 服务端密钥，再把结果直接告诉我们，不存在「我们取到的密钥类型和它协商到的不一致」的问题。
 * 相比 ssh-keyscan 还少一个依赖——Windows 自带的 OpenSSH 可能不支持服务端的
 * sntrup761x25519 等新 KEX 算法，导致 ssh-keyscan 直接协商失败。
 *
 * plink 的原文形如：
 *   The server's ssh-ed25519 key fingerprint is:
 *     ssh-ed25519 255 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
 */
function fingerprintsFromPlinkOutput(text) {
  const t = String(text || '');
  // 必须先确认确实是「主机密钥」相关消息，避免把输出里恰好长得像指纹的字符串误当指纹
  if (!/(key fingerprint is|host key is not cached|Cannot confirm a host key)/i.test(t)) return [];
  const out = [];
  const re = /(SHA256:[A-Za-z0-9+/]{20,}={0,2}|(?:[0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2})/g;
  let m;
  while ((m = re.exec(t))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 从 ssh-keyscan 的输出中解析出**所有**主机密钥的 SHA256 指纹。
 *
 * 为什么必须返回全部：ssh-keyscan 会列出该主机所有类型的密钥（rsa/ecdsa/ed25519），
 * 而 plink 是按自己的偏好顺序去协商的，未必就是我们取到的那一条。
 * 只传一条会导致 plink 报「Host key not in manually configured list」。
 *
 * 同时必须校验是真正的 SSH 公钥，否则 ssh-keyscan 的报错文本
 * （如 "getaddrinfo xxx: Name or service not known"）会被 base64 出来当成指纹，
 * 把一个假指纹传给 plink -hostkey 反而比不传更糟。
 */
const SSH_KEY_TYPES =
  /^(ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

function fingerprintsFromKeyscanOutput(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 3) continue;
    if (!SSH_KEY_TYPES.test(parts[1])) continue;
    try {
      const blob = Buffer.from(parts[2], 'base64');
      if (blob.length < 8) continue;
      // SSH 公钥 blob 结构：uint32 算法名长度 + 算法名 + 密钥数据
      const algoLen = blob.readUInt32BE(0);
      if (algoLen <= 0 || algoLen > blob.length - 4) continue;
      if (blob.subarray(4, 4 + algoLen).toString('utf8') !== parts[1]) continue;
      const fp = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
      if (!out.includes(fp)) out.push(fp);
    } catch (_) {
      /* 换下一行 */
    }
  }
  return out;
}

/**
 * 解析批量脚本的输出：按 @@@DM8CHK:<id>@@@ 标记切分。
 * 抽成纯函数便于单测（不需要真的连 SSH）。
 * 必须先判断结束标记，否则 __END__ 会被当成一个命令 id，截断检测也就失效了。
 */
function parseBatchOutput(text) {
  const map = {};
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line === MARK_END) {
      cur = null;
      continue;
    }
    const m = /^@@@DM8CHK:([A-Za-z0-9_.\-]+)@@@\s*$/.exec(line);
    if (m) {
      cur = m[1];
      map[cur] = [];
      continue;
    }
    if (cur) map[cur].push(line);
  }
  const out = {};
  for (const k of Object.keys(map)) out[k] = map[k].join('\n').trim();
  return out;
}

/**
 * 文本解码。
 * ---------------------------------------------------------------------------
 * 远端命令输出可能是系统本地编码（中文 Windows 下 plink/ssh 的报错就是 GBK），
 * 直接按 UTF-8 解码会乱码。这里按**逐行**判断：
 *   先按 UTF-8 解，若某行出现替换字符，则只把那一行改用 GBK 解。
 * 注意不能对整个缓冲区统一判断——只要有一处非法字节，就会把整段都回退成 GBK，
 * 把本来正常的 UTF-8 行（例如 lsblk 的制表符）也一起带歪。
 */
function decodeOutput(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;

  let gbkDecoder = null;
  try {
    gbkDecoder = new TextDecoder('gbk');
  } catch (_) {
    return utf8; // 当前 Node 构建不支持 gbk
  }

  const raw = buf.toString('latin1');
  const rawLines = raw.split('\n');
  const utf8Lines = utf8.split('\n');
  const out = utf8Lines.map((line, i) => {
    if (!line.includes('\uFFFD')) return line;
    try {
      const gbk = gbkDecoder.decode(Buffer.from(rawLines[i] || '', 'latin1'));
      return gbk.includes('\uFFFD') ? line : gbk;
    } catch (_) {
      return line;
    }
  });
  return out.join('\n');
}

class RemoteShell {
  constructor(opts) {
    const o = opts || {};
    /**
     * 本地执行模式：工具与数据库同机时直接跑本机 shell，不走 SSH。
     * 这样就不需要任何 SSH 凭据（密码、密钥、主机密钥全都不需要）。
     */
    this.local = !!o.local;
    /** 本地模式下可指定 shell 可执行文件，留空则 Linux 用 /bin/sh、Windows 用 cmd.exe */
    this.localShellBin = o.shellBin ? String(o.shellBin) : '';
    this.host = String(o.host || '').trim();
    this.port = parseInt(o.port, 10) || 22;
    this.user = String(o.user || 'dmdba').trim() || 'dmdba';
    this.keyFile = o.keyFile ? String(o.keyFile).trim() : '';
    this.password = o.password == null ? '' : String(o.password);
    /** Windows 上密码认证需要 plink（PuTTY），留空则自动探测 */
    this.plinkPath = o.plinkPath ? String(o.plinkPath).trim() : '';
    /** plink 首次连接需要主机密钥指纹（-hostkey），否则会因「Host key not cached」失败 */
    this.hostKey = o.hostKey ? String(o.hostKey).trim() : '';
    this.connectTimeoutMs = o.connectTimeoutMs || 12000;
    this.commandTimeoutMs = o.commandTimeoutMs || 60000;
    this.sudo = !!o.sudo;
    ensureDir(RUNTIME_DIR);
    this.knownHosts = path.join(RUNTIME_DIR, 'ssh_known_hosts');
    this.logFile = path.join(RUNTIME_DIR, 'ssh-' + process.pid + '-' + Date.now() + '.log');
    this._backend = null;
    /** 缓存 ssh-keyscan 取到的全部主机密钥指纹 */
    this._hostKeyFps = undefined;
    /** 一旦确认 plink 需要 -hostkey，后续调用直接带上，避免每次多跑一次 */
    this._needHostKey = false;
  }

  /** 释放本次连接产生的临时文件（只删自己这一个；固定名的留给整轮结束时的兜底清理） */
  dispose() {
    removeQuietly(this.logFile);
  }

  get target() {
    return this.user + '@' + this.host;
  }

  /** 探测某个可执行文件是否存在（用 spawn 是否报 ENOENT 判断） */
  async _exists(cmd, args) {
    const r = await runToFile(
      cmd,
      args || ['-V'],
      path.join(RUNTIME_DIR, 'probe-' + path.basename(cmd) + '.log'),
      8000
    );
    return !r.error || !/ENOENT/i.test(String(r.error));
  }

  /** 在 PATH 与常见安装位置中寻找 plink.exe */
  async _findPlink() {
    const cands = [];
    if (this.plinkPath) cands.push(this.plinkPath);
    cands.push('plink', 'plink.exe');
    if (process.platform === 'win32') {
      cands.push(
        'C:\\Program Files\\PuTTY\\plink.exe',
        'C:\\Program Files (x86)\\PuTTY\\plink.exe'
      );
      if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'PuTTY', 'plink.exe'));
      if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'PuTTY', 'plink.exe'));
    }
    for (const c of cands) {
      if (c !== 'plink' && c !== 'plink.exe' && !fs.existsSync(c)) continue;
      if (await this._exists(c, ['-V'])) return c;
    }
    return null;
  }

  /**
   * 选择认证后端。优先级：
   *   密钥 / 免密  → 系统 ssh
   *   密码        → sshpass（Unix）→ plink（Windows / PuTTY）
   */
  async detectBackend() {
    if (this._backend) return this._backend;
    if (this.local) {
      const isWin = process.platform === 'win32';
      this._backend = {
        kind: 'local',
        bin: this.localShellBin || (isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'),
        desc: '本机 shell（工具与数据库同机，无需 SSH 凭据）',
      };
      return this._backend;
    }
    if (this.keyFile || !this.password) {
      this._backend = {
        kind: 'ssh',
        bin: 'ssh',
        desc: this.keyFile ? 'OpenSSH 密钥认证' : 'OpenSSH（免密或 agent）',
      };
      return this._backend;
    }
    if (await this._exists('sshpass', ['-V'])) {
      this._backend = { kind: 'sshpass', bin: 'sshpass', desc: 'sshpass + OpenSSH' };
      return this._backend;
    }
    const plink = await this._findPlink();
    if (plink) {
      this._backend = { kind: 'plink', bin: plink, desc: 'plink（PuTTY）' };
      return this._backend;
    }
    this._backend = {
      kind: 'none',
      desc: '无可用认证方式',
      message:
        '需要使用密码认证，但本机既没有 sshpass（Unix 工具），也没有找到 plink.exe（PuTTY）。' +
        (process.platform === 'win32'
          ? ' Windows 上的解决办法：① 推荐改用 SSH 密钥认证（填写私钥路径）；' +
            '② 或安装 PuTTY，并把 plink.exe 放入 PATH，或在本页「plink 路径」中填写其完整路径。'
          : ' 建议安装 sshpass（yum/apt install sshpass），或改用 SSH 密钥认证。'),
    };
    return this._backend;
  }

  _sshArgs(script) {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=' + this.knownHosts,
      '-o', 'ConnectTimeout=' + Math.max(3, Math.round(this.connectTimeoutMs / 1000)),
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'LogLevel=ERROR',
      '-p', String(this.port),
    ];
    if (this.keyFile) args.push('-i', this.keyFile);
    args.push(this.target);
    if (script) args.push(script);
    return args;
  }

  /**
   * 构造 OpenSSH 参数。
   * 注意：走密码认证时**不能**用 BatchMode=yes —— 它会一并禁掉口令认证，
   * sshpass 就再也没有提示符可应答了，必然是 Permission denied。
   */
  _sshArgs(script, usePassword) {
    const args = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'UserKnownHostsFile=' + this.knownHosts,
      '-o', 'ConnectTimeout=' + Math.max(3, Math.round(this.connectTimeoutMs / 1000)),
      '-o', 'LogLevel=ERROR',
      '-p', String(this.port),
    ];
    if (usePassword) {
      args.push('-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=password,keyboard-interactive');
    } else {
      // 密钥/免密场景：禁止任何交互式提示，避免卡住
      args.push('-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0');
    }
    if (this.keyFile) args.push('-i', this.keyFile);
    args.push(this.target);
    if (script) args.push(script);
    return args;
  }

  /**
   * 自动获取目标主机**所有**密钥类型的 SHA256 指纹（供 plink -hostkey 使用）。
   * 这样界面上就不需要让用户填指纹，也不必先手工执行一次 plink 去缓存。
   */
  async _fetchHostKeyFingerprints() {
    if (this._hostKeyFps !== undefined) return this._hostKeyFps;
    this._hostKeyFps = [];
    const r = await runToFile(
      'ssh-keyscan',
      ['-T', '6', '-p', String(this.port), this.host],
      path.join(RUNTIME_DIR, 'keyscan-' + this.host + '.log'),
      20000
    );
    if (r.error && /ENOENT/i.test(String(r.error))) return this._hostKeyFps; // 系统没有 ssh-keyscan
    this._hostKeyFps = fingerprintsFromKeyscanOutput(r.text);
    return this._hostKeyFps;
  }

  /**
   * 在远端执行一段 shell 脚本。
   * @returns {Promise<{ok:boolean, out:string, err:string, text:string, error?:string}>}
   */
  async run(script) {
    const backend = await this.detectBackend();
    if (backend.kind === 'none') {
      return { ok: false, error: 'NO_AUTH_METHOD', text: '', message: backend.message };
    }

    const full = script && this.sudo && !this.local ? 'sudo -n sh -c ' + shellQuote(script) : script;
    const env = Object.assign({}, process.env);
    let r;

    if (backend.kind === 'local') {
      // 本机执行：Linux 走 /bin/sh -c；Windows 走 cmd.exe /c
      // （本机 OS 检查项都是 Linux 命令，调用方会先在非 Linux 平台上判定为不适用）
      const isWin = process.platform === 'win32' && /cmd\.exe$/i.test(backend.bin);
      const shellBin = backend.bin;
      r = await runToFile(
        shellBin,
        isWin ? ['/d', '/s', '/c', String(full || '')] : ['-c', String(full || '')],
        this.logFile,
        this.commandTimeoutMs,
        env
      );
    } else if (backend.kind === 'plink') {
      r = await this._runPlink(backend, full, env);
    } else if (backend.kind === 'sshpass') {
      env.SSHPASS = this.password;
      r = await runToFile('sshpass', ['-e'].concat(this._sshArgs(full, true)), this.logFile, this.commandTimeoutMs, env);
    } else {
      r = await runToFile('ssh', this._sshArgs(full, false), this.logFile, this.commandTimeoutMs, env);
    }

    const text = r.text || '';
    // ssh/plink 自身的报错与命令输出混在一起（都重定向到同一个文件），这里挑出来
    const errLines = text
      .split(/\r?\n/)
      .filter((l) =>
        /^(ssh:|sshpass:|plink:|Permission denied|Host key verification|Host key not cached|Connection (refused|timed out)|FATAL ERROR|Unable to open connection|The server's host key is not cached)/i.test(
          l
        )
      );
    return {
      ok: r.ok,
      code: r.code,
      text,
      out: text,
      err: errLines.join('\n'),
      error: r.error,
      backend: backend.kind,
      // 优先用内部给出的更具体的说明（如 plink 主机密钥校验失败），其次才是抓到的错误行
      message: r.message || (errLines.length ? errLines.join(' ').slice(0, 400) : undefined),
    };
  }

  /**
   * plink 执行。主机密钥分两步处理：
   *   1) 先不带 -hostkey，走 PuTTY 自身缓存的主机密钥（已缓存时最快，也没有匹配风险）；
   *   2) 若报「host key not cached」，再用 ssh-keyscan 取到的**全部**密钥指纹重试。
   * 一旦确认需要 -hostkey，后续调用直接走第 2 步，避免每次多跑一次。
   */
  async _runPlink(backend, full, env) {
    const build = (fps) => {
      const a = ['-ssh', '-batch', '-P', String(this.port)];
      if (this.keyFile) a.push('-i', this.keyFile);
      for (const fp of fps || []) a.push('-hostkey', fp);
      if (!this.keyFile && this.password) a.push('-pw', this.password);
      a.push(this.target);
      if (full) a.push(full);
      return a;
    };
    const mismatch = (t) => /Host key not in manually configured list|host key.*not.*match/i.test(String(t || ''));

    const explicit = this.hostKey ? [this.hostKey] : [];
    if (explicit.length || this._needHostKey) {
      const fps = explicit.length ? explicit : await this._fetchHostKeyFingerprints();
      this._usedHostKeys = fps;
      this._hostKeySource = explicit.length ? '配置指定' : 'ssh-keyscan';
      const r = await runToFile(backend.bin, build(fps), this.logFile, this.commandTimeoutMs, env);
      if (mismatch(r.text)) {
        r.message =
          `plink 主机密钥校验失败。已尝试的指纹（${fps.length} 个）：${fps.join('、')}。` +
          '请确认目标主机地址与端口是否正确。';
      }
      return r;
    }

    // 第一步：不带 -hostkey，依赖 PuTTY 已缓存的主机密钥。
    // 注意各版本 plink 的措辞不同，判定必须覆盖全部已知说法：
    //   plink 0.80： "The host key is not cached for this server:" / "Cannot confirm a host key in batch mode"
    //   旧版 plink： "The server's host key is not cached in the registry"
    let r = await runToFile(backend.bin, build([]), this.logFile, this.commandTimeoutMs, env);
    const needRetry = (t) => /not cached|Cannot confirm a host key/i.test(String(t || ''));
    if (!needRetry(r.text)) return r;

    // 第二步：取指纹后重试。
    // 优先从 plink 自己的输出里提取——它已经协商成功过，给出的密钥类型必然对得上；
    // 取不到再退回 ssh-keyscan（注意 Windows 自带 OpenSSH 可能不支持服务端的
    // sntrup761x25519 等新 KEX，ssh-keyscan 会直接协商失败）。
    let fps = fingerprintsFromPlinkOutput(r.text);
    let source = 'plink 输出';
    if (!fps.length) {
      fps = await this._fetchHostKeyFingerprints();
      source = 'ssh-keyscan';
    }
    if (!fps.length) {
      r.message =
        'plink 报主机密钥未缓存，且未能自动取得主机密钥指纹' +
        '（plink 输出中未包含指纹，ssh-keyscan 也取不到——可能是系统未安装 ssh-keyscan）。' +
        '请先手工执行一次 plink 以缓存主机密钥。';
      return r;
    }
    this._needHostKey = true;
    this._usedHostKeys = fps;
    this._hostKeySource = source;
    const r2 = await runToFile(backend.bin, build(fps), this.logFile, this.commandTimeoutMs, env);
    if (mismatch(r2.text)) {
      r2.message =
        `plink 主机密钥校验失败。已尝试的指纹（来自${source}，共 ${fps.length} 个）：${fps.join('、')}。` +
        '请确认目标主机地址与端口是否正确。';
    }
    return r2;
  }

  /** 连通性测试 */
  async probe() {
    const backend = await this.detectBackend();
    if (backend.kind === 'none') {
      return { ok: false, backend: 'none', message: backend.message };
    }

    // 本机模式：没有连接概念，只需确认 shell 可用
    if (backend.kind === 'local') {
      const r = await this.run('echo DM8_LOCAL_OK; hostname; uname -s');
      if (!r.ok || !String(r.text || '').includes('DM8_LOCAL_OK')) {
        return { ok: false, backend: 'local', message: '本机 shell 不可用：' + (r.message || r.error || '未返回预期内容') };
      }
      const hn = (String(r.text).split(/\r?\n/)[1] || '').trim() || os.hostname();
      return {
        ok: true,
        backend: 'local',
        backendDesc: backend.desc,
        hostname: hn,
        hostKey: null,
        message: `以本机方式采集（工具与数据库同机 ${hn}，无需 SSH 凭据）`,
      };
    }

    const r = await this.run('echo DM8_REMOTE_OK; hostname; uname -s');
    if (!r.ok) {
      return {
        ok: false,
        backend: backend.kind,
        message:
          (r.message || '') ||
          (r.error === 'timeout'
            ? `连接 ${this.target}:${this.port} 超时`
            : `无法连接 ${this.target}:${this.port}（${r.error || '退出码 ' + r.code}）`),
      };
    }
    if (!r.text.includes('DM8_REMOTE_OK')) {
      return { ok: false, backend: backend.kind, message: 'SSH 已连通但未返回预期内容，请确认远端 shell 可用。' };
    }
    const hn = (r.text.split(/\r?\n/)[1] || '').trim();
    // 自动接受的主机密钥要显式报出来，便于与服务器实际指纹核对（这才是主机密钥校验的意义）
    const keyNote =
      this._usedHostKeys && this._usedHostKeys.length
        ? `；主机密钥 ${this._usedHostKeys.join('、')}（来源：${this._hostKeySource}，已自动接受，建议核对）`
        : '';
    return {
      ok: true,
      backend: backend.kind,
      backendDesc: backend.desc,
      hostname: hn,
      hostKey: this._usedHostKeys && this._usedHostKeys[0] ? this._usedHostKeys[0] : null,
      message: `已连接 ${this.target}:${this.port}（认证方式：${backend.desc}；远程主机名 ${hn || '未知'}${keyNote}）`,
    };
  }

  /**
   * 批量执行：把多条命令拼成一个脚本，一次 SSH 往返完成。
   * @param {Array<{id:string, cmd:string}>} entries
   * @returns {Promise<Object>} id -> 输出文本
   */
  async runBatch(entries) {
    const parts = [];
    for (const e of entries) {
      parts.push(`echo '${MARK_PREFIX}${e.id}@@@'`);
      parts.push(String(e.cmd).replace(/\n+$/, ''));
      parts.push("echo ''");
    }
    parts.push(`echo '${MARK_END}'`);
    const script = parts.join('\n');

    const r = await this.run(script);
    const result = { _ok: r.ok, _error: r.error, _message: r.message, _raw: r.text };
    const map = parseBatchOutput(r.text);
    for (const k of Object.keys(map)) result[k] = map[k];
    result._markers = Object.keys(map);
    return result;
  }
}

/** 从 V$INSTANCE 探测到的形态推断远程采集的默认用户 */
function defaultRemoteUser() {
  return 'dmdba';
}

module.exports = {
  RemoteShell,
  shellQuote,
  parseBatchOutput,
  fingerprintsFromKeyscanOutput,
  fingerprintsFromPlinkOutput,
  defaultRemoteUser,
  MARK_PREFIX,
  RUNTIME_DIR,
  sweepRuntime,
  removeQuietly,
};
