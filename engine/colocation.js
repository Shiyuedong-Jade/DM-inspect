'use strict';
/*
 * 同机判定
 * ---------------------------------------------------------------------------
 * 判断「运行本巡检工具的主机」是否就是「数据库服务器」。
 *
 * 为什么必须判断：OS 级指标与检查命令只能在本机执行。如果工具跑在跳板机上
 * 而数据库在另一台机器上，采到的就是跳板机的数据 —— 把它当成数据库服务器的
 * 数据展示，比「不展示」更危险（会得出完全错误的资源结论）。
 *
 * 判定方式：比对 V$INSTANCE.HOST_NAME 与本机主机名（取第一段，兼容短名/FQDN）。
 * 取不到数据库主机名时按「未确认」处理，同样不采集。
 *
 * 注意：本工具的正常用法是**不在目标服务器上部署**，OS 数据一律走 SSH 远程采集，
 * 因此界面上不再提供「强制按同机处理」的开关（那个开关会诱导用户以为勾上就等于远程采集）。
 * 自动比对始终生效：万一真的把工具跑在了数据库服务器上，仍会正常本地采集。
 * 少数主机名确实不一致的场景（如容器），用环境变量 DM8_OS_LOCAL=1 兜底。
 */

const os = require('node:os');

async function detectColocation(ctx) {
  const localHost = os.hostname();
  const forced = (ctx && ctx.options && ctx.options.assumeLocalOs) || process.env.DM8_OS_LOCAL === '1';
  if (forced) {
    return { coLocated: true, forced: true, dbHost: localHost, localHost, reason: '已由用户指定按同机处理' };
  }
  const shortName = (s) =>
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '')
      .split('.')[0];
  let dbHost = '';
  try {
    const r = await ctx.queryTry([`SELECT HOST_NAME FROM V$INSTANCE`]);
    if (r && r.rows.length) dbHost = String(r.rows[0].HOST_NAME || '').trim();
  } catch (_) {
    /* 忽略，按未确认处理 */
  }
  if (!dbHost) {
    return {
      coLocated: false,
      dbHost: '',
      localHost,
      reason: '未能从 V$INSTANCE 获取数据库主机名，无法确认是否同机',
    };
  }
  const same = shortName(dbHost) === shortName(localHost);
  return {
    coLocated: same,
    dbHost,
    localHost,
    reason: same
      ? `数据库主机与本机同名（${dbHost}），确认同机部署`
      : `数据库实例运行在 ${dbHost}，而本工具运行在 ${localHost}，不是同一台主机`,
  };
}

module.exports = { detectColocation };
