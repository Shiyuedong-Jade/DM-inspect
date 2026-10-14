# 变更记录

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.1 — 2026-10-14

本次只动文档，`lib/` / `client/` / `engine/` 一行未改，所以取补丁号。

### 文档

- README 新增「部署与重载：改完代码为什么不生效」。宿主加载的是 profile 目录下的**安装副本**（当前走标准安装路线，`profiles/web/package.json` 里声明为 `github:` 依赖，`pnpm-lock.yaml` 还会钉住当时解析到的提交号），改本仓库不会自动生效。从「改完」到「宿主跑起来」要两步：`dsh plugin --profile web update dsh-plugin-dm8-inspect`，然后重启 `dsh web`。
- 同节说明第二步不能省的原因：profile 虽然声明了 `patchReload: live`，但 `live` 覆盖的只有补丁文件，插件代码没有热重载通道。三条原因各自独立，HMR 的 `root` 是空数组所以不监视任何目录、改补丁文件触发的 recompose 按 entry 做 diff、`nodeLinker: hoisted` 让插件路径在更新后不变而 Node 的 ESM 模块表按 URL 永久缓存。
- 同节另记两点：客户端部分（`client/client.js`）更新副本并重启之后还要刷新页面；`tools/verify-install.mjs` 回答的是「安装位置能否被加载」，不比较新旧，所以不能用它判断改动是否生效。

## 0.1.0 — 初始提交

首个版本：85 项只读巡检与 HTML 报告、设置卡片与客户端界面、库内采集（JDBC 桥）与 SSH 主机侧采集两条通道。另含投稿收录符合性自检、apply 检查、设置卡片检查与内置样例数据的全链路自检。只读设计：巡检 SQL 全为查询语句，不修改数据库任何配置。
