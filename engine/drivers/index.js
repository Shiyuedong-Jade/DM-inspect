'use strict';
/*
 * 驱动工厂
 * ---------------------------------------------------------------------------
 * 目前提供两条可用路径：
 *   jdbc —— 通过 Java 桥接器连接真实达梦 DM8（推荐，兼容性最好）
 *   demo —— 演示模式，用内置样例数据生成报告，无需任何数据库
 *
 * 两条路径对上层暴露完全一致的会话接口：
 *   connect(cred) -> string
 *   query(sql, opts) -> { columns, rows, rowCount }
 *   queryCheck(check, opts) -> 同上（demo 专用，jdbc 会退化为 query）
 *   close()
 */

const jdbc = require('./jdbc');
const demo = require('./demo');

const DRIVERS = {
  jdbc: {
    id: 'jdbc',
    name: 'JDBC 桥接（真实连接）',
    probe: jdbc.probe,
    create(options) {
      return new jdbc.JdbcSession(options);
    },
  },
  demo: {
    id: 'demo',
    name: '演示模式（无需数据库）',
    probe: demo.probe,
    create(options) {
      return new demo.DemoSession(options);
    },
  },
};

/** 探测所有驱动可用性 */
async function probeAll() {
  const out = [];
  for (const key of Object.keys(DRIVERS)) {
    try {
      out.push(await DRIVERS[key].probe());
    } catch (e) {
      out.push({ id: key, name: DRIVERS[key].name, available: false, detail: '探测失败：' + e.message });
    }
  }
  // 把推荐顺序调整一下：jdbc 优先，demo 兜底
  out.sort((a, b) => (a.id === 'jdbc' ? -1 : b.id === 'jdbc' ? 1 : 0));
  return out;
}

/** 创建会话；未指定驱动时自动选择 jdbc，不可用则回退 demo */
async function createSession(driverId, options) {
  let id = driverId;
  if (!id) {
    const all = await probeAll();
    const usable = all.find((d) => d.available && d.id === 'jdbc');
    id = usable ? 'jdbc' : 'demo';
  }
  const d = DRIVERS[id];
  if (!d) throw new Error('未知的驱动：' + id);
  return { session: d.create(options || {}), driverId: id, driverName: d.name };
}

module.exports = { probeAll, createSession, DRIVERS };
