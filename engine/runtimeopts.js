'use strict';

/**
 * 高级选项（运行参数）的归一化与求值工具。
 *
 * 为什么单独放一个模块：
 *   1. 界面传来的是 JSON，可能是字符串、空值、越界值，必须在进入巡检逻辑前统一夹逼，
 *      否则拼进 SQL 的 LIMIT 会有注入风险，阈值也可能出现 crit < warn 这种自相矛盾的组合。
 *   2. app.js 的后端校验逻辑、runner.js 的执行逻辑、tests 里的构造逻辑都要用同一份默认值，
 *      否则「界面上显示 80」和「实际按 90 判定」会悄悄不一致。
 *
 * 可配置的两组参数：
 *   - 表空间使用率阈值：tsWarnPct / tsCritPct（默认 80 / 90）
 *   - Top 类巡检项的条数：topN（默认 10，夹逼到 5~50）
 */

const DEFAULTS = { tsWarnPct: 80, tsCritPct: 90, topN: 10 };
const TOPN_MIN = 5;
const TOPN_MAX = 50;

/** 取数字；空串、null、NaN 一律视为「未填」 */
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** 夹逼到 [min, max]，空值取默认值 */
function clamp(v, min, max, dflt) {
  const n = numOrNull(v);
  if (n === null) return dflt;
  return Math.min(max, Math.max(min, n));
}

function normalizeOptions(input) {
  const src = input && typeof input === 'object' ? input : {};

  const topN = Math.round(clamp(src.topN, TOPN_MIN, TOPN_MAX, DEFAULTS.topN));

  // 使用率两个阈值：先夹逼告警阈值，再保证严重阈值严格大于告警阈值。
  // 若用户把严重填得比告警还低，按「以告警阈值为准 +10」修正，并把上限收到 100。
  const tsWarnPct = Math.round(clamp(src.tsWarnPct, 1, 99, DEFAULTS.tsWarnPct));
  let tsCritPct = Math.round(clamp(src.tsCritPct, 2, 100, DEFAULTS.tsCritPct));
  if (tsCritPct <= tsWarnPct) tsCritPct = Math.min(100, tsWarnPct + 10);

  return { tsWarnPct, tsCritPct, topN };
}

/**
 * 巡检项里的 bars / groupTop / title 允许写成 (options) => 值 的形式，
 * 这样「同一份巡检项定义」就能适配不同阈值，不必为每种阈值复制一份。
 */
function resolveOpt(v, options) {
  return typeof v === 'function' ? v(options) : v;
}

/** 供 SQL 使用：拼 LIMIT 前再确认一次是纯整数，杜绝任何注入可能 */
function topLimit(options, dflt) {
  const o = options && typeof options === 'object' ? options : {};
  const n = numOrNull(o.topN);
  if (n === null || !Number.isInteger(n)) {
    const d = numOrNull(dflt);
    return Number.isInteger(d) ? d : DEFAULTS.topN;
  }
  return Math.min(TOPN_MAX, Math.max(TOPN_MIN, n));
}

module.exports = { DEFAULTS, TOPN_MIN, TOPN_MAX, normalizeOptions, resolveOpt, topLimit };
