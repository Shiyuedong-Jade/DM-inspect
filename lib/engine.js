/**
 * 把 vendored 的巡检引擎（CJS，零依赖）接进 ESM 插件。
 *
 * 引擎用 createRequire 原样加载：巡检项定义、SQL、判定逻辑、报告渲染沿用
 * `require('./lib/xxx')` 的相对引用。唯一改动的是工作目录——`drivers/jdbc.js` 与
 * `remote.js` 认 `DM8_INSPECT_HOME`，把「java 桥接源码 / 达梦 JDBC 驱动 jar /
 * runtime 临时文件」重定向到用户可写目录，而非插件包目录（node_modules 不应被写入）。
 *
 * 环境变量是进程级的：home 变化时清掉 require 缓存重新加载，否则第一次加载的 ROOT
 * 会被永久记住。settings 是 live 生效的，该分支会被走到。
 *
 * @module dsh-plugin-dm8-inspect/engine
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** 插件包根目录（即 package.json 所在目录）。 */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 引擎里所有会读 DM8_INSPECT_HOME 的模块，缓存失效时按这些前缀清。 */
const ENGINE_PREFIX = path.join(PACKAGE_DIR, 'engine') + path.sep;

let loaded = null; // { home, api }

/**
 * 加载引擎（按 home 缓存）。
 *
 * @param {string} home - 工作目录绝对路径：其下会有 java/、drivers/、runtime/。
 * @returns {{runner: object, cluster: object, report: object, drivers: object, runtimeopts: object, remote: object}}
 */
export function loadEngine(home) {
  const dir = path.resolve(home);
  if (loaded && loaded.home === dir) return loaded.api;

  // home 变了：清掉引擎模块缓存，让新的 DM8_INSPECT_HOME 生效
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ENGINE_PREFIX)) delete require.cache[key];
  }
  process.env.DM8_INSPECT_HOME = dir;

  const api = {
    runner: require('../engine/runner.js'),
    cluster: require('../engine/cluster.js'),
    report: require('../engine/report.js'),
    drivers: require('../engine/drivers/index.js'),
    runtimeopts: require('../engine/runtimeopts.js'),
    remote: require('../engine/remote.js'),
  };
  loaded = { home: dir, api };
  return api;
}
