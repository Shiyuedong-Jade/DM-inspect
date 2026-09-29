'use strict';
/*
 * SQL 指纹：用来判断「某条历史 SQL 是不是本工具自己跑的查询」。
 * ---------------------------------------------------------------------------
 * 要解决的问题：巡检项「长 SQL 历史」「SQL 历史」读的是数据库的慢 SQL 记录，
 * 而本工具自己跑的巡检 SQL（例如 ts.segments 那条 DBA_SEGMENTS 窗口函数查询）
 * 同样会进 V$SQL_HISTORY / V$LONG_EXEC_SQLS。不区分的话，报告会把**工具自己**的查询
 * 当成「业务慢 SQL」报警——真机实测就发生过：报「共 2 条 SQL 超过 1000 毫秒」，
 * 两条全是 ts.segments 的查询，还建议 DBA 去优化它。
 *
 * 为什么用「指纹」而不是硬编码一张 SQL 清单：
 *   1. 很多巡检项的 SQL 是在 custom 函数里拼的，静态枚举不全；
 *   2. 指纹可以跨轮次生效——上一轮巡检留下的历史记录同样能认出来。
 * 所以做法是：**运行期把所有执行过的 SQL 记下来，再按归一化后的指纹比对**。
 *
 * 归一化要去掉那些「同一条查询、不同次运行会长得不一样」的部分：
 *   · 空白与大小写；
 *   · 注释；
 *   · 字符串字面量；
 *   · **数字字面量**（阈值、Top N 都可配置，`LIMIT 10` 与 `LIMIT 20` 是同一条查询）。
 */

/** 计算 SQL 指纹；空/过短返回空串（调用方据此跳过比对，避免误伤） */
function sqlSignature(sql) {
  if (sql === null || sql === undefined) return '';
  const s = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/--[^\n]*/g, ' ') // 行注释
    .replace(/'[^']*'/g, "''") // 字符串字面量
    .replace(/\b\d+(?:\.\d+)?\b/g, '0') // 数字字面量
    .replace(/\s+/g, ' ')
    // 运算符/括号两侧的空格也要归一：`x >= 0` 与 `x>=0` 是同一条查询
    .replace(/\s*([(),*=<>+\-/])\s*/g, '$1')
    .trim()
    .toLowerCase();
  // 太短的串（如 'select 0'）不具备区分度，宁可不当成自己人
  return s.length >= 12 ? s : '';
}

/** 把一条执行过的 SQL 记进指纹集合 */
function recordSql(set, sql) {
  if (!set) return;
  const sig = sqlSignature(sql);
  if (sig) set.add(sig);
}

/** 判断一条历史 SQL 是否属于本工具自己跑的查询 */
function isSelfSql(set, sql) {
  if (!set) return false;
  const sig = sqlSignature(sql);
  return sig ? set.has(sig) : false;
}

module.exports = { sqlSignature, recordSql, isSelfSql };
