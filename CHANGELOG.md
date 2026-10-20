# 变更记录

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.2 — 2026-10-20

只动对外文案（README 与几处错误提示），判定与采集逻辑一行未改，所以取补丁号。

### 修正

- 驱动文件名统一写 `DmJdbcDriver8.jar`：三个插件工作目录、两个 dev home 与 live home 里放的**都是它**，`DmJdbcDriver18.jar` 在实际环境里并不存在。README「环境要求」「安装第 2 步」、`lib/index.js` / `lib/tool.js` / `engine/drivers/jdbc.js` 的错误提示、`tools/live.mjs` 的注释与 `assets/java/DmBridge.java` 的用法示例统一改过来。
- `engine/drivers/jdbc.js` 的**候选排序没有改**（18 → 8 → 11 → 7 → 6）：那只是「目录里有哪些 jar 就按这个优先级挑」，没有 18 自然落到 8；只把那条注释改写清楚，不再让读者以为要去装 18。
- `tools/smoke.mjs` 里那条「错误信息点名了要放的 jar 文件名」的断言随文案改成 `DmJdbcDriver8.jar`（它是个正则字面量，`18` 与 `.jar` 之间有反斜杠，按字面替换会漏掉）。

## 0.1.1 — 2026-10-14

本次只动文档，`lib/` / `client/` / `engine/` 一行未改，所以取补丁号。

### 文档

- README 新增「部署与重载：改完代码为什么不生效」。宿主加载的是 profile 目录下的**安装副本**（当前走标准安装路线，`profiles/web/package.json` 里声明为 `github:` 依赖，`pnpm-lock.yaml` 还会钉住当时解析到的提交号），改本仓库不会自动生效。从「改完」到「宿主跑起来」要两步：`dsh plugin --profile web update dsh-plugin-dm8-inspect`，然后重启 `dsh web`。
- 同节说明第二步不能省的原因：profile 虽然声明了 `patchReload: live`，但 `live` 覆盖的只有补丁文件，插件代码没有热重载通道。三条原因各自独立，HMR 的 `root` 是空数组所以不监视任何目录、改补丁文件触发的 recompose 按 entry 做 diff、`nodeLinker: hoisted` 让插件路径在更新后不变而 Node 的 ESM 模块表按 URL 永久缓存。
- 同节另记两点：客户端部分（`client/client.js`）更新副本并重启之后还要刷新页面；`tools/verify-install.mjs` 回答的是「安装位置能否被加载」，不比较新旧，所以不能用它判断改动是否生效。

## 0.1.0 — 初始提交

首个版本：85 项只读巡检与 HTML 报告、设置卡片与客户端界面、库内采集（JDBC 桥）与 SSH 主机侧采集两条通道。另含投稿收录符合性自检、apply 检查、设置卡片检查与内置样例数据的全链路自检。只读设计：巡检 SQL 全为查询语句，不修改数据库任何配置。
