'use strict';
/*
 * JDBC 驱动后端
 * ---------------------------------------------------------------------------
 * 通过 Java 桥接器（java/DmBridge.java）连接达梦 DM8。
 * 这是兼容性最好的一条路径：只要本机有 JDK/JRE 以及达梦自带的 JDBC 驱动 jar
 * （安装目录 dmdbms/drivers/jdbc/DmJdbcDriver18.jar）即可，无需安装任何 npm 包。
 *
 * 与桥接器的通信走 127.0.0.1 回环 TCP，字段使用 Base64(UTF-8) 编码，
 * 避免 Windows 控制台 GBK 编码导致的乱码与管道限制。
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// 工作目录（放 java 桥接源码、达梦 JDBC 驱动 jar、runtime 临时文件）。
// 默认是工程根目录；被作为库内嵌时（例如 DSH 插件）可用 DM8_INSPECT_HOME 重定向到
// 一个用户可写、可预期的位置——插件包目录本身不该被写入，驱动 jar 也不该藏在
// node_modules 里面。三个路径仍保持 java/ drivers/ runtime/ 的相对结构不变。
const ROOT = process.env.DM8_INSPECT_HOME
  ? path.resolve(process.env.DM8_INSPECT_HOME)
  : path.resolve(__dirname, '..', '..');
const { removeQuietly } = require('../remote');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const JAVA_DIR = path.join(ROOT, 'java');
const DRIVER_DIR = path.join(ROOT, 'drivers');
const BRIDGE_SRC = path.join(JAVA_DIR, 'DmBridge.java');
const CLASS_DIR = path.join(RUNTIME_DIR, 'classes');

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

function b64(s) {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
}

function unb64(s) {
  if (!s) return '';
  return Buffer.from(s, 'base64').toString('utf8');
}

/** 列出 drivers/ 目录下可用的达梦 JDBC 驱动 jar */
function listDriverJars() {
  ensureDir(DRIVER_DIR);
  let files = [];
  try {
    files = fs.readdirSync(DRIVER_DIR);
  } catch (_) {
    return [];
  }
  return files
    .filter((f) => /\.jar$/i.test(f))
    .map((f) => path.join(DRIVER_DIR, f))
    .sort((a, b) => {
      // 驱动版本要和服务端匹配。优先 DmJdbcDriver18（JDK8+ 通用），其次 8，再次 11，
      // 最后才是老版本；同优先级按名称排。
      const score = (p) => {
        const n = path.basename(p).toLowerCase();
        if (/dmjdbcdriver18/.test(n)) return 0;
        if (/dmjdbcdriver8/.test(n)) return 1;
        if (/dmjdbcdriver11/.test(n)) return 2;
        if (/dmjdbcdriver7/.test(n)) return 3;
        if (/dmjdbcdriver6/.test(n)) return 4;
        return 5;
      };
      const d = score(a) - score(b);
      return d !== 0 ? d : a.localeCompare(b);
    });
}

/** 把外部 jar 复制/保存到 drivers/ 目录 */
function installDriverJar(sourcePath, originalName) {
  ensureDir(DRIVER_DIR);
  const name = path.basename(originalName || sourcePath || 'DmJdbcDriver.jar');
  const target = path.join(DRIVER_DIR, name);
  fs.copyFileSync(sourcePath, target);
  return target;
}

function saveDriverJarBuffer(buf, originalName) {
  ensureDir(DRIVER_DIR);
  const name = path.basename(originalName || 'DmJdbcDriver.jar');
  const target = path.join(DRIVER_DIR, name);
  fs.writeFileSync(target, buf);
  return target;
}

// ---------------------------------------------------------------- Java 探测

function javaCandidates() {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const list = [];
  if (process.env.DM8_JAVA) list.push(process.env.DM8_JAVA);
  if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  if (process.env.JDK_HOME) list.push(path.join(process.env.JDK_HOME, 'bin', exe));
  // 达梦安装目录常常自带 JDK（Linux 上路径固定），优先于 PATH 里的 java，
  // 这样即使服务器没单独装 JDK 也能连库
  for (const dmHome of ['/opt/dmdbms', '/home/dmdba/dmdbms', process.env.DM_HOME]) {
    if (!dmHome) continue;
    list.push(path.join(dmHome, 'jdk', 'bin', exe));
    list.push(path.join(dmHome, 'java', 'bin', exe));
  }
  list.push('java');
  return list;
}

function javacFor(javaPath) {
  const exe = process.platform === 'win32' ? 'javac.exe' : 'javac';
  if (javaPath === 'java') return 'javac';
  const dir = path.dirname(javaPath);
  return path.join(dir, exe);
}

/**
 * 执行命令并把 stdout/stderr 重定向到文件（不使用管道，避免受限环境下 EPERM）。
 */
function runToFile(cmd, args, logFile, timeoutMs) {
  return new Promise((resolve) => {
    let fd = 'ignore';
    try {
      fd = fs.openSync(logFile, 'w');
    } catch (_) {
      /* ignore */
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    } catch (e) {
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch (_) {}
      resolve({ ok: false, error: 'timeout', text: readLog(logFile) });
    }, timeoutMs || 20000);

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
      resolve({ ok: false, error: String((e && e.message) || e) });
    });

    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
      resolve({ ok: code === 0, code, text: readLog(logFile) });
    });
  });
}

function readLog(file, maxBytes) {
  try {
    const buf = fs.readFileSync(file);
    const slice = buf.length > (maxBytes || 8000) ? buf.subarray(buf.length - (maxBytes || 8000)) : buf;
    return slice.toString('utf8');
  } catch (_) {
    return '';
  }
}

function parseJavaMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text || '');
  if (!m) return 0;
  let major = parseInt(m[1], 10);
  if (major === 1 && m[2]) major = parseInt(m[2], 10);
  return major;
}

let _javaInfo = null;

/** 探测可用的 java，返回 { path, major, versionText } 或 null */
async function detectJava() {
  if (_javaInfo !== null) return _javaInfo;
  ensureDir(RUNTIME_DIR);
  const logFile = path.join(RUNTIME_DIR, 'java-probe.log');
  for (const cand of javaCandidates()) {
    const r = await runToFile(cand, ['-version'], logFile, 15000);
    const text = (r.text || '') + (r.error ? '\n' + r.error : '');
    const major = parseJavaMajor(text);
    if (major > 0) {
      const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
      _javaInfo = { path: cand, major, versionText: firstLine.trim() };
      return _javaInfo;
    }
  }
  _javaInfo = null;
  return null;
}

// ------------------------------------------------------------ 桥接器准备

/**
 * 判断 java 是否能以“源码直接运行”方式启动；否则回退到 javac 预编译。
 * 返回启动参数中 java 可执行文件之后的部分。
 */
async function prepareBridgeArgs(javaInfo, port, token) {
  ensureDir(RUNTIME_DIR);
  const jars = listDriverJars();
  if (!jars.length) {
    throw new Error(
      '未找到达梦 JDBC 驱动 jar。请把达梦安装目录 dmdbms/drivers/jdbc/DmJdbcDriver18.jar 放入 ' +
        DRIVER_DIR +
        ' 目录（也可在页面“达梦 JDBC 驱动 jar”一栏直接上传）。'
    );
  }
  // 只放排名最高的那一个驱动 jar，避免多版本混在 classpath 里
  const cp = jars[0];
  const logFile = path.join(RUNTIME_DIR, 'bridge-compile.log');

  if (javaInfo.major >= 11) {
    // JEP 330：源码直接运行，无需编译。
    // DmBridge.java 已刻意写成纯 ASCII（中文用 \uXXXX 转义），
    // 因为该模式下启动器不接受 -encoding，javac 会按平台默认编码(中文 Windows 为 GBK)读源码。
    // 注意只放**一个**驱动 jar：drivers/ 下若有多个版本，全部塞进 classpath 时
    // 先命中的那个类会被加载，可能用到与服务端不匹配的驱动版本。
    return { args: ['-cp', jars[0], BRIDGE_SRC, String(port), token], mode: 'source' };
  }

  // Java 8 回退：用 javac 编译一次（带缓存）
  ensureDir(CLASS_DIR);
  const cls = path.join(CLASS_DIR, 'DmBridge.class');
  const needCompile =
    !fs.existsSync(cls) || fs.statSync(cls).mtimeMs < fs.statSync(BRIDGE_SRC).mtimeMs;
  if (needCompile) {
    const javac = javacFor(javaInfo.path);
    const r = await runToFile(javac, ['-encoding', 'UTF-8', '-cp', cp, '-d', CLASS_DIR, BRIDGE_SRC], logFile, 90000);
    if (!r.ok) {
      throw new Error('编译 Java 桥接器失败：' + (r.text || r.error || '').trim());
    }
  }
  return { args: ['-cp', cp + path.delimiter + CLASS_DIR, 'DmBridge', String(port), token], mode: 'class' };
}

// ------------------------------------------------------------ 会话实现

const ROW_LIMIT_DEFAULT = 5000;

class JdbcSession {
  constructor(options) {
    this.options = options || {};
    this.seq = 0;
    this.pending = new Map();
    this.bridge = null;
    this.server = null;
    this.socket = null;
    this.buffer = '';
    this.token = crypto.randomBytes(16).toString('hex');
    this.closed = false;
    this.poisoned = false;
    this.stderrLog = path.join(RUNTIME_DIR, 'bridge-' + process.pid + '-' + Date.now() + '.log');
    this.serverInfo = '';
    this.bridgeMode = '';
  }

  _fail(reason) {
    this.poisoned = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async open() {
    ensureDir(RUNTIME_DIR);

    const javaInfo = await detectJava();
    if (!javaInfo) {
      throw new Error(
        '未检测到可用的 Java 运行环境。请安装 JDK/JRE 8 及以上，或设置环境变量 DM8_JAVA 指向 java 可执行文件。'
      );
    }

    // 1) 监听回环端口，等待桥接器连入
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    this.server = net.createServer((sock) => {
      this.socket = sock;
      sock.setNoDelay(true);
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('error', (e) => this._fail('桥接器连接错误：' + e.message));
      sock.on('close', () => {
        if (!this.closed && !this._handshakeDone) {
          rejectReady(new Error('桥接器连接被关闭'));
        }
      });
      this._resolveReady = resolveReady;
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });

    // 2) 启动 Java 桥接器
    const { args, mode } = await prepareBridgeArgs(javaInfo, this.port, this.token);
    this.bridgeMode = mode;

    let fd = 'ignore';
    try {
      fd = fs.openSync(this.stderrLog, 'w');
    } catch (_) {}

    this.bridge = spawn(javaInfo.path, args, {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      cwd: ROOT,
    });
    if (typeof fd === 'number') {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }

    this.bridge.on('error', (e) => this._fail('启动 Java 桥接器失败：' + e.message));
    this.bridge.on('exit', (code) => {
      if (!this.closed) {
        this._fail(
          'Java 桥接器意外退出（code=' +
            code +
            '）。' +
            this._logTail()
        );
      }
    });

    const timeoutMs = this.options.spawnTimeoutMs || 60000;
    await Promise.race([
      ready,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('启动 Java 桥接器超时。' + this._logTail())), timeoutMs)
      ),
    ]);
  }

  _logTail() {
    const t = readLog(this.stderrLog, 4000).trim();
    return t ? '\n--- 桥接器日志 ---\n' + t : '';
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    const sp1 = line.indexOf(' ');
    const cmd = (sp1 < 0 ? line : line.slice(0, sp1)).toUpperCase();
    const rest = sp1 < 0 ? '' : line.slice(sp1 + 1);

    if (cmd === 'READY') {
      const token = unb64(rest.trim());
      if (token !== this.token) {
        this._fail('桥接器握手校验失败（token 不匹配）');
        return;
      }
      this._handshakeDone = true;
      if (this._resolveReady) this._resolveReady();
      return;
    }

    if (cmd === 'PONG') {
      const p = this.pending.get('__ping__');
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete('__ping__');
        p.resolve(true);
      }
      return;
    }

    if (cmd === 'BYE') {
      this.closed = true;
      return;
    }

    // 其余都是带 id 的响应：COLS / ROW / END / ERR / CONNECTED
    const sp2 = rest.indexOf(' ');
    const id = sp2 < 0 ? rest.trim() : rest.slice(0, sp2);
    const payload = sp2 < 0 ? '' : rest.slice(sp2 + 1);

    if (cmd === 'CONNECTED') {
      this.serverInfo = unb64(id);
      const p = this.pending.get('__connect__');
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete('__connect__');
        p.resolve(this.serverInfo);
      }
      return;
    }

    const p = this.pending.get(id);
    if (!p) return;

    if (cmd === 'COLS') {
      p.columns = payload
        .split('|')
        .map((x) => unb64(x));
      return;
    }
    if (cmd === 'ROW') {
      const vals = payload.split('|').map((x) => (x === '~' ? null : unb64(x)));
      p.rows.push(vals);
      return;
    }
    if (cmd === 'END') {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ columns: p.columns, rows: p.rows, rowCount: parseInt(payload, 10) || p.rows.length });
      return;
    }
    if (cmd === 'ERR') {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(unb64(payload)));
      return;
    }
  }

  _send(line) {
    if (!this.socket || this.poisoned) {
      throw new Error('桥接器不可用');
    }
    this.socket.write(line + '\n');
  }

  _request(id, line, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.poisoned) {
        reject(new Error('桥接器已失效，请重试'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时无法安全恢复：杀死桥接器并由上层重连
        this._fail('查询超时（' + timeoutMs + 'ms）');
        reject(new Error('查询超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, rows: [], columns: [] });
      try {
        this._send(line);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** 建立数据库连接。@param {{host,port,user,password,schema}} cred */
  async connect(cred) {
    const url = 'jdbc:dm://' + cred.host + ':' + cred.port;
    const timeoutSec = Math.max(5, Math.round((this.options.queryTimeoutMs || 60000) / 1000));
    const connectTimeout = this.options.connectTimeoutMs || 15000;
    const loginTimeoutSec = Math.max(3, Math.round(connectTimeout / 1000) - 2);
    const line =
      'CONNECT ' +
      [
        b64(url),
        b64(cred.user),
        b64(cred.password),
        String(timeoutSec),
        String(loginTimeoutSec),
        b64(cred.schema || ''),
      ].join(' ');
    const id = '__connect__';

    try {
      return await this._request(id, line, connectTimeout);
    } catch (e) {
      const raw = (e && e.message) || String(e);
      // 区分「网络不可达」与「驱动返回的业务错误（如口令错误）」
      if (/超时|timeout/i.test(raw)) {
        throw new Error(
          `连接 ${cred.host}:${cred.port} 超时（${Math.round(connectTimeout / 1000)} 秒）：` +
            '请确认 IP 与端口正确、数据库实例已启动、网络可达且防火墙已放通（达梦默认端口 5236）。' +
            '另外注意：达梦驱动在认证失败时有时表现为「超时」而不是立刻报错（真机验证过），' +
            '所以超时也要一并核对用户名与口令。'
        );
      }
      throw new Error(`连接 ${cred.host}:${cred.port} 失败：${raw}`);
    }
  }

  /** 执行 SQL，返回 { columns, rows, rowCount } */
  async query(sql, options) {
    const o = options || {};
    const id = 'q' + ++this.seq;
    const maxRows = o.maxRows || ROW_LIMIT_DEFAULT;
    const timeoutMs = o.timeoutMs || this.options.queryTimeoutMs || 60000;
    const line = 'QUERY ' + [id, String(maxRows), b64(sql)].join(' ');
    return this._request(id, line, timeoutMs);
  }

  async ping() {
    const id = '__ping__';
    return this._request(id, 'PING', 5000);
  }

  async close() {
    this.closed = true;
    try {
      if (this.socket && !this.poisoned) {
        this.socket.write('QUIT\n');
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 60));
    try {
      if (this.socket) this.socket.destroy();
    } catch (_) {}
    try {
      if (this.server) this.server.close();
    } catch (_) {}
    try {
      if (this.bridge && !this.bridge.killed) this.bridge.kill();
    } catch (_) {}
    this._fail('会话已关闭');
    // 本次会话的桥接器 stderr 只在排查时有用，关掉就删（只删自己这一个，固定名的由兜底清理处理）
    removeQuietly(this.stderrLog);
  }
}

/** 环境自检：返回 JDBC 路径是否可用及原因 */
async function probe() {
  const jars = listDriverJars();
  const javaInfo = await detectJava();
  const available = !!(javaInfo && jars.length);
  let detail = '';
  if (!javaInfo) {
    detail = '未检测到 Java（需要 JDK/JRE 8+）。';
  } else if (!jars.length) {
    detail = '检测到 ' + javaInfo.versionText + '，但 drivers/ 目录下没有达梦 JDBC 驱动 jar。';
  } else {
    detail =
      'Java: ' +
      javaInfo.versionText +
      '；驱动: ' +
      jars.map((j) => path.basename(j)).join(', ');
  }
  return {
    id: 'jdbc',
    name: 'JDBC 桥接（推荐）',
    available,
    detail,
    java: javaInfo ? { path: javaInfo.path, major: javaInfo.major, version: javaInfo.versionText } : null,
    jars: jars.map((j) => path.basename(j)),
  };
}

module.exports = {
  JdbcSession,
  probe,
  listDriverJars,
  installDriverJar,
  saveDriverJarBuffer,
  detectJava,
  DRIVER_DIR,
  RUNTIME_DIR,
};
