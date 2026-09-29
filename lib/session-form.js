/**
 * 调用卡片里填的连接设置，只存在进程内存里。
 *
 * 独立版那张表单（`dm8-inspect/public/index.html`）在 DSH 里的落点：原来由人在网页
 * 表单里填、POST 给 server.js，现在由人在 dm8_inspect 的调用卡片里填，POST 给插件的
 * 一条 /api 路由，存进这里的 Map。
 *
 * 三条约束：
 *   1. 不落盘。没有文件、没有 env、没有日志、不进会话日志、不进模型上下文；
 *      进程退出（dsh 重启）后 Map 随之消失。
 *   2. 按会话隔离。不同会话可能对着不同的库（生产/测试），共用一个值会让 A 会话填的
 *      值被 B 会话用掉。
 *   3. 口令不回传。状态查询只回「有没有」，不回内容；其余字段（主机、账号、阈值）
 *      回传是为了让卡片能显示当前值。
 *
 * 口令不是安全边界：agent 的 shell 是另一个进程，读不到这里的 Map，但同一个 OS 用户
 * 仍能读到磁盘上的凭据文件。
 *
 * @module dsh-plugin-dm8-inspect/session-form
 */

/**
 * 卡片上的字段清单（host 与 client 各存一份，用自检断言两边一致）。
 *
 * kind:
 *   text   —— 普通文本
 *   secret —— 口令，只写不读
 *   int    —— 整数（夹逼交给各消费方，这里只保证是数字串）
 */
export const FORM_FIELDS = [
  {
    name: 'targets',
    kind: 'text',
    label: '目标（每行一个 host:port）',
    placeholder: '10.127.11.40:5236',
    hint: '一个 = 单实例；两个及以上 = 集群巡检',
  },
  { name: 'user', kind: 'text', label: '数据库账号', placeholder: 'SYSDBA' },
  { name: 'password', kind: 'secret', label: '数据库口令', placeholder: '输入后点保存' },
  {
    name: 'sshUser',
    kind: 'text',
    label: 'SSH 账号（数据库服务器 OS 采集，可选）',
    placeholder: 'root 或 dmdba',
    hint: '填了才会做 OS 级检查；不填这些项判为「不适用」',
  },
  { name: 'sshPassword', kind: 'secret', label: 'SSH 口令（可选）', placeholder: '留空则不做 OS 检查' },
  { name: 'topN', kind: 'int', label: 'Top N（Top 类巡检项条数）', placeholder: '10' },
  { name: 'tsWarnPct', kind: 'int', label: '表空间告警阈值 %', placeholder: '80' },
  { name: 'tsCritPct', kind: 'int', label: '表空间严重阈值 %', placeholder: '90' },
  { name: 'slowSqlMs', kind: 'int', label: '慢 SQL 阈值 ms', placeholder: '1000' },
  { name: 'queryTimeoutMs', kind: 'int', label: '单条 SQL 超时 ms', placeholder: '30000' },
  {
    name: 'outDir',
    kind: 'text',
    label: '报告目录（可选）',
    placeholder: '默认 <会话工作目录>/dm8-inspect-reports',
  },
];

/** 只写不读的字段名。 */
export const SECRET_NAMES = FORM_FIELDS.filter((f) => f.kind === 'secret').map((f) => f.name);

/** 允许写入的字段名（白名单）。 */
export const FIELD_NAMES = FORM_FIELDS.map((f) => f.name);

/** sessionId -> { 字段名: 字符串值 }。只在本进程内有效。 */
const store = new Map();

/** 会话 id 取不到时的兜底键，使没有会话上下文的调用也能读写。 */
const NO_SESSION = '(no-session)';

/** 规范化会话键：空值一律归到兜底键，避免 '' 与 undefined 分成两个键。 */
function key(sessionId) {
  const s = sessionId == null ? '' : String(sessionId).trim();
  return s || NO_SESSION;
}

/**
 * 合并写入。只覆盖显式给出的字段；给出空字符串 = 清除该字段。
 * 全部清空后整条记录删掉，不留空壳。
 *
 * @param {string} sessionId - 会话 id
 * @param {Record<string, string>} patch - 要写入的字段
 * @returns {object} 写入后的状态（见 sessionFormStatus）
 */
export function setSessionForm(sessionId, patch) {
  const k = key(sessionId);
  const cur = store.get(k) || {};
  for (const name of FIELD_NAMES) {
    if (!patch || patch[name] === undefined) continue;
    const v = patch[name] == null ? '' : String(patch[name]).trim();
    if (v === '') delete cur[name];
    else cur[name] = v;
  }
  if (Object.keys(cur).length === 0) store.delete(k);
  else store.set(k, cur);
  return sessionFormStatus(sessionId);
}

/** 取出该会话的全部字段（副本，调用方改不坏内部状态）。含口令，仅供 host 内部使用。 */
export function getSessionForm(sessionId) {
  const cur = store.get(key(sessionId));
  return cur ? Object.assign({}, cur) : {};
}

/** 取一个字段；没有则返回 null。 */
export function getFormField(sessionId, name) {
  const v = getSessionForm(sessionId)[name];
  return v == null || v === '' ? null : v;
}

/** 清除该会话的全部字段。 */
export function clearSessionForm(sessionId) {
  return store.delete(key(sessionId));
}

/**
 * 卡片要显示的状态：非秘密字段回传值，秘密字段只回布尔。
 * @param {string} sessionId - 会话 id
 * @returns {{values: object, configured: object}}
 */
export function sessionFormStatus(sessionId) {
  const cur = getSessionForm(sessionId);
  const values = {};
  const configured = {};
  for (const f of FORM_FIELDS) {
    if (f.kind === 'secret') {
      configured[f.name] = !!cur[f.name];
    } else if (cur[f.name] !== undefined) {
      values[f.name] = cur[f.name];
    }
  }
  return { values, configured };
}

/** 已填写过设置的会话数（仅用于日志，不含会话标识）。 */
export function sessionFormCount() {
  return store.size;
}

/** 仅供测试使用：清空全部。 */
export function resetSessionForms() {
  store.clear();
}

/**
 * 把卡片里那行「目标」文本解析成 targets 数组。
 *
 * 接受换行、逗号、分号、空格分隔；每项是 `host` 或 `host:port`。
 * 一个目标 → 单实例；两个及以上 → 集群巡检（与工具侧「≥2 走集群」的判定一致）。
 *
 * @param {string} text - 卡片里填的原始文本
 * @param {number} defaultPort - 没写端口时用的端口
 * @param {string} user - 数据库账号（所有节点共用）
 * @returns {Array<{host: string, port: number, user: string}>}
 */
export function parseTargets(text, defaultPort, user) {
  const raw = String(text == null ? '' : text);
  const tokens = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const t of tokens) {
    // 兼容 IPv6 字面量写法 [::1]:5236
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(t) || /^([^:]+)(?::(\d+))?$/.exec(t);
    if (!m) continue;
    const host = String(m[1] || '').trim();
    if (!host) continue;
    const port = parseInt(m[2], 10) || defaultPort || 5236;
    out.push({ host, port, user });
  }
  return out;
}

/** 路由路径（host 注册、client 调用，两处必须一致）。保持旧名以免老客户端失效。 */
export const SECRET_ROUTE = '/api/dm8-inspect.secret';

/**
 * 处理一次卡片请求。
 *
 * 纯函数：不依赖 ctx、不依赖 node:http，输入一个 WHATWG Request、输出一个 Response，
 * 便于离线测试。
 *
 * - `GET    ?session=<id>`  → `{ ok, values, configured }`
 * - `POST   { session, ...字段 }` → 同上（合并写入）
 * - `DELETE ?session=<id>`  → 清空该会话
 *
 * @param {Request} request - 已过 /api 信任与鉴权围栏的请求
 * @returns {Promise<Response>}
 */
export async function handleFormRequest(request) {
  const url = new URL(request.url);
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  try {
    if (request.method === 'GET') {
      return json(200, Object.assign({ ok: true }, sessionFormStatus(url.searchParams.get('session'))));
    }

    if (request.method === 'DELETE') {
      clearSessionForm(url.searchParams.get('session'));
      return json(200, {
        ok: true,
        values: {},
        configured: Object.fromEntries(SECRET_NAMES.map((n) => [n, false])),
      });
    }

    if (request.method === 'POST') {
      let body = null;
      try {
        body = await request.json();
      } catch (_) {
        return json(400, { ok: false, error: '请求体不是合法 JSON' });
      }
      if (!body || typeof body !== 'object') return json(400, { ok: false, error: '请求体必须是对象' });

      const patch = {};
      for (const name of FIELD_NAMES) {
        if (body[name] === undefined) continue;
        if (typeof body[name] !== 'string') return json(400, { ok: false, error: `${name} 必须是字符串` });
        patch[name] = body[name];
      }
      // 未知字段一律拒绝：卡片与 host 的字段表漂移时立刻暴露。
      for (const k of Object.keys(body)) {
        if (k !== 'session' && !FIELD_NAMES.includes(k)) {
          return json(400, { ok: false, error: `未知字段 ${k}（字段表可能不一致）` });
        }
      }
      if (Object.keys(patch).length === 0) return json(400, { ok: false, error: '没有可写入的字段' });

      const st = setSessionForm(body.session, patch);
      return json(200, Object.assign({ ok: true }, st));
    }

    return json(405, { ok: false, error: '只支持 GET / POST / DELETE' });
  } catch (e) {
    // 错误信息里不带请求体（可能含口令）。
    return json(500, { ok: false, error: e && e.message ? e.message : String(e) });
  }
}
