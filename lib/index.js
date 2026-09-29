/**
 * DSH 插件入口：把 DM8 达梦数据库巡检注册成一个模型可调用的工具 `dm8_inspect`。
 *
 * 插件契约（cordis）：
 *   name   —— 诊断用的显示名
 *   inject —— 依赖的服务；`tools` 不可用时本插件的 apply 不会执行（fiber 停在 pending）
 *   Config —— schemastery 配置校验
 *   apply  —— 注册工具（返回值即销毁函数，由 fiber 自动回收）
 *
 * 挂在 host 层（web profile 的 cordis.patch.yml 里插一行）。工具注册进全局层，
 * DSH 的工具注册表 view(scope) 从全局层起步，内置的 agent preset 未 restrict 任何工具，
 * 因此每个会话都能看到该工具。
 *
 * @module dsh-plugin-dm8-inspect
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

import { loadEngine } from './engine.js';
import { defaultHome, prepareHome, expandHome } from './workspace.js';
import { makeDm8Tool, TOOL_NAME } from './tool.js';
import { SECRET_ROUTE, handleFormRequest, sessionFormCount } from './session-form.js';

/** 诊断名：日志与 `dsh --dump-config` 里看到的就是它。 */
const name = 'dm8-inspect';

/**
 * 只依赖 `tools`。凭据服务（credentials）用 ctx.get 软取：它由 dsh-base 恒定挂载，
 * 取不到时插件不必停在 pending。
 */
const inject = ['tools'];

/** 插件配置，写在 cordis.patch.yml 的那一行里。 */
const Config = z.object({
  /** 工作目录：其下有 java/、drivers/、runtime/。默认 ~/.dsh/dm8-inspect */
  home: z.string().default(''),
  /** 巡检驱动：jdbc=连真实达梦库；demo=演示模式（不连库，仅自检用） */
  driver: z.string().default('jdbc'),
  /** 数据库口令的凭据名（credentialRef） */
  credentialRef: z.string().default('DM8_INSPECT_PASSWORD'),
  /** 数据库服务器 OS 采集用的 SSH 口令凭据名 */
  sshCredentialRef: z.string().default('DM8_INSPECT_SSH_PASSWORD'),
  /** 报告输出目录，默认 <当前工作目录>/dm8-inspect-reports */
  outDir: z.string().default(''),
  /** 单条 SQL 超时（毫秒） */
  queryTimeoutMs: z.number().default(30000),
  /** 建立连接超时（毫秒） */
  connectTimeoutMs: z.number().default(20000),
  /** 慢 SQL 阈值（毫秒） */
  slowSqlMs: z.number().default(1000),
  /** 表空间使用率告警阈值（%） */
  tsWarnPct: z.number().default(80),
  /** 表空间使用率严重告警阈值（%） */
  tsCritPct: z.number().default(90),
  /** Top 类巡检项条数 */
  topN: z.number().default(10),
  /** 集群巡检的节点并发数 */
  clusterConcurrency: z.number().default(3),
});

/**
 * 注册 `dm8_inspect` 工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 携带 tools 服务的上下文
 * @param {object} config - 上面 Config 解析后的配置
 */
function apply(ctx, config) {
  // settings 服务由 dsh-base 挂载；applies 为 live，用户改设置后 getConfig() 立刻反映。
  const scope = ctx.get('settings')
    ? ctx.settings.register('dsh-plugin-dm8-inspect', Config, { base: config, applies: 'live' })
    : null;
  const getConfig = () => {
    const c = Object.assign({}, config, scope ? scope.get() : {});
    return Object.assign(c, { home: expandHome(c.home || defaultHome()) });
  };

  const credentials = ctx.get('credentials');

  /**
   * 从凭据库取口令。取不到就返回 null，由工具给出「怎么配」的提示。
   * 每次调用时读取，不做缓存；凭据轮换后下一次调用立刻生效。
   *
   * @param {string} refName - 凭据名（POSIX 标识符）
   * @returns {Promise<string|null>}
   */
  async function resolveSecret(refName) {
    const key = String(refName || '').trim();
    if (!credentials || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
    try {
      const got = await credentials.resolve(credentialRef(key));
      return got && got.value != null ? String(got.value) : null;
    } catch (e) {
      ctx.logger.warn(`dm8-inspect: 读取凭据 ${key} 失败：${e && e.message ? e.message : e}`);
      return null;
    }
  }

  const tool = makeDm8Tool({
    defineTool,
    getConfig,
    loadEngine,
    prepareHome: (home) => prepareHome(home),
    resolveSecret,
    log: (m) => ctx.logger.info(`dm8-inspect: ${m}`),
  });

  ctx.tools.register(tool);

  // ---- 卡片设置接收路由 ----
  // 独立版那张表单（主机/账号/口令/SSH/阈值/TopN）搬进 dm8_inspect 的调用卡片，
  // client 半边把值 POST 到这里，值进 lib/session-form.js 的进程内 Map，
  // 不落盘、不记日志、不回显口令。
  //
  // 路由用 ctx.connection.fetch 注册：它由 /api 那条物理通道承载，
  // Host/Origin 信任围栏与浏览器会话鉴权在该通道上完成；直接挂 webServer 是裸的
  // node:http 端点，围栏不覆盖，需要自行实现同源校验。
  //
  // connection 由 web bundle 插入，晚于 dsh-base 的 tools；用 ctx.get 取一次会拿到
  // undefined 并永久跳过注册，客户端点保存拿到通道兜底的 404 "not found"。
  // ctx.inject 在服务出现时才回调，服务被替换后会重跑。
  // 在没有 connection 的组合（headless / sdk）里该回调不触发，插件其余部分照常工作，
  // 只是没有界面入口。
  ctx.inject(['connection'], (connCtx) => {
    const conn = connCtx.connection;
    if (!conn || !conn.fetch || typeof conn.fetch.register !== 'function') {
      ctx.logger.warn('dm8-inspect: connection 服务存在但没有 fetch.register，跳过卡片路由');
      return;
    }
    try {
      conn.fetch.register({
        path: SECRET_ROUTE,
        methods: ['GET', 'POST', 'DELETE'],
        requestBody: 'buffered',
        fetch: (request) => handleFormRequest(request),
      });
      ctx.logger.info(`dm8-inspect: 卡片路由已注册 ${SECRET_ROUTE}（连接设置只存内存，重启即失效）`);
    } catch (e) {
      ctx.logger.warn(`dm8-inspect: 注册卡片路由失败：${e && e.message ? e.message : e}`);
    }
  });

  // 启动时探一次工作目录，把「缺驱动 jar」这类问题提前写进日志。
  try {
    const cfg = getConfig();
    const prep = prepareHome(cfg.home);
    ctx.logger.info(
      `dm8-inspect 已加载：工作目录 ${prep.home}，驱动 jar ${prep.jars.length} 个` +
        (prep.jars.length ? `（${prep.jars.join('、')}）` : `（未放 jar，请把 DmJdbcDriver18.jar 复制到 ${prep.driverDir}）`)
    );
  } catch (e) {
    ctx.logger.warn(`dm8-inspect: 工作目录检查失败：${e && e.message ? e.message : e}`);
  }

  ctx.logger.info(`dm8-inspect: 已注册工具 ${TOOL_NAME}（卡片已填 ${sessionFormCount()} 个会话）`);
}

export { Config, apply, inject, name };
