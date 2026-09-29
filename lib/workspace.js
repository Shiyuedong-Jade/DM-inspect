/**
 * 工作目录准备：把「引擎跑起来需要的东西」放到一个用户可写、可预期的位置。
 *
 * 目录结构（与独立运行时的工程目录一致，引擎无需特殊分支）：
 *   <home>/java/DmBridge.java      JDBC 桥接源码，首次使用时从插件包 assets/ 复制过去
 *   <home>/drivers/*.jar           达梦 JDBC 驱动，需要用户自己放（商业授权，不能随包分发）
 *   <home>/runtime/                一次性文件：java 探测日志、编译出的 class、桥接日志
 *
 * 插件装在 node_modules 里，不可写入，用户也无处放 jar，因此使用独立的 home。
 * 默认放在 ~/.dsh/dm8-inspect 下，与 DSH 其它状态文件（sessions/ storages/）并列，见 README。
 *
 * @module dsh-plugin-dm8-inspect/workspace
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_DIR } from './engine.js';

/** 默认工作目录：~/.dsh/dm8-inspect */
export function defaultHome() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'dm8-inspect');
}

/** 展开 ~ 开头与环境变量，返回绝对路径。 */
export function expandHome(p) {
  if (!p) return defaultHome();
  let s = String(p).trim();
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => process.env[n] ?? m);
  return path.resolve(s);
}

/**
 * 准备目录，返回可用状态。
 * 不抛异常：缺驱动 jar 属正常状态（用户尚未放置），由工具在返回值里说明；
 * 插件 apply 失败会影响整个 DSH 树。
 *
 * @param {string} home - 工作目录（已展开）
 * @returns {{home: string, javaDir: string, driverDir: string, runtimeDir: string, bridge: string|null, jars: string[]}}
 */
export function prepareHome(home) {
  const javaDir = path.join(home, 'java');
  const driverDir = path.join(home, 'drivers');
  const runtimeDir = path.join(home, 'runtime');
  for (const d of [javaDir, driverDir, runtimeDir]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (_) {
      /* 建不出来也继续，下面会按实际结果报告 */
    }
  }

  // 桥接源码：随包分发，复制到 home（用户可改，也便于 Java 8 的 javac 缓存复用）
  const bridge = path.join(javaDir, 'DmBridge.java');
  const src = path.join(PACKAGE_DIR, 'assets', 'java', 'DmBridge.java');
  let bridgeOk = fs.existsSync(bridge);
  if (!bridgeOk) {
    try {
      fs.copyFileSync(src, bridge);
      bridgeOk = true;
    } catch (_) {
      bridgeOk = false;
    }
  } else {
    // 内容升级过就以包内的为准（纯 ASCII 源码，比对字节即可）
    try {
      if (fs.readFileSync(bridge).length !== fs.readFileSync(src).length) fs.copyFileSync(src, bridge);
    } catch (_) {
      /* 比对失败时沿用现有文件 */
    }
  }

  let jars = [];
  try {
    jars = fs.readdirSync(driverDir).filter((f) => /\.jar$/i.test(f));
  } catch (_) {
    /* 目录不存在时按空处理 */
  }

  return { home, javaDir, driverDir, runtimeDir, bridge: bridgeOk ? bridge : null, jars };
}
