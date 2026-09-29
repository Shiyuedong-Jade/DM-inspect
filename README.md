# dsh-plugin-dm8-inspect

达梦 DM8 数据库巡检插件。执行 85 项只读巡检，生成 HTML 报告。

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [注意事项](#注意事项)
- [卸载](#卸载)
- [目录结构](#目录结构)
- [开发](#开发)
- [许可证](#许可证)

## 功能

- 85 项只读巡检项，覆盖实例与版本、表空间与数据文件、日志与归档、内存与缓冲池、SQL 性能、对象与统计信息、用户与安全、作业与备份
- 可选采集数据库服务器的操作系统指标：CPU / 内存 / 磁盘 IO、内核参数、达梦日志告警
- 支持单实例、共享存储集群（DMDSC）、数据守护主备
- 表空间使用率按阈值着色，Top 类巡检项的条数可调
- 输出 HTML 报告，同目录附一份内容相同的 JSON
- 所有巡检 SQL 均为查询语句，不修改数据库配置

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20 |
| Java | 8 及以上（JDK 或 JRE）。11+ 以源码方式运行桥接器；8 先用 javac 编译一次，结果缓存在工作目录 |
| 达梦 JDBC 驱动 | `DmJdbcDriver18.jar` 或 `DmJdbcDriver8.jar`，需自行提供，见[安装](#安装)第 2 步 |
| DeepSeek Harness | 0.1.x |

## 安装

### 1. 安装插件

```sh
dsh plugin --profile web add github:Shiyuedong-Jade/DM-inspect
```

从本地目录安装：

```sh
dsh plugin --profile web add file:/path/to/dsh-plugin-dm8-inspect
```

`file:` 安装时绝对路径不能含空格：`dsh plugin` 会转发给 pnpm，参数在空格处断开。

### 2. 放置达梦 JDBC 驱动

驱动 jar 是达梦的商业组件，不随插件分发。把达梦安装目录下的
`dmdbms/drivers/jdbc/DmJdbcDriver18.jar` 复制到工作目录的 `drivers/` 下：

| 平台 | 路径 |
|---|---|
| Windows | `%USERPROFILE%\.dsh\dm8-inspect\drivers\` |
| Linux | `~/.dsh/dm8-inspect/drivers/` |

插件加载时会自动建好工作目录（`drivers/`、`java/`、`runtime/`）。工作目录可用插件配置 `home` 修改，见[配置](#配置)。

### 3. 重启

首次安装后重启 `dsh web`，并刷新已打开的页面。

## 使用

在会话里调用 `dm8_inspect`。所有参数都可以不填，目标、账号、口令都能在设置卡片里预先填好。

每次调用 `dm8_inspect` 时会出现一张设置卡片，填好保存后说一句「巡检一下」即可。

工具返回分级结论（严重 / 警告 / 正常 / 提示 / 不适用 / 未取到）和报告路径。报告为 HTML，同目录另存一份内容相同的 JSON。

### 调用参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `targets` | array | 设置卡片中的目标 | `[{host, port, user, label}]`。1 个为单实例，2 个及以上为集群巡检 |
| `user` | string | `SYSDBA` | 数据库账号 |
| `port` | integer | `5236` | 数据库端口 |
| `driver` | string | `jdbc` | `jdbc` 连真实库；`demo` 使用内置样例数据，不连库 |
| `topN` | integer | `10` | Top 类巡检项条数，5~50 |
| `tsWarnPct` | integer | `80` | 表空间使用率告警阈值（%） |
| `tsCritPct` | integer | `90` | 表空间使用率严重阈值（%） |
| `slowSqlMs` | integer | `1000` | 慢 SQL 阈值（毫秒） |
| `queryTimeoutMs` | integer | `30000` | 单条 SQL 超时（毫秒） |
| `sshUser` | string | — | 数据库服务器 OS 采集账号，填写后才会执行 |
| `sshPassword` | string | — | 数据库服务器 OS 采集口令 |
| `outDir` | string | `<会话工作目录>/dm8-inspect-reports` | 报告目录 |
| `password` | string | — | 数据库口令。会写入会话日志，建议改用设置卡片或凭据库 |

取值优先级：本次调用参数 > 设置卡片 > 凭据库。

## 配置

### 设置卡片

| 字段 | 说明 |
|---|---|
| 目标 | 每行一个 `host:port`。1 个为单实例，2 个及以上为集群巡检 |
| 数据库账号 / 数据库口令 | 默认 `SYSDBA` |
| SSH 账号 / SSH 口令 | 填写后才会执行数据库服务器 OS 级检查 |
| Top N | Top 类巡检项条数 |
| 慢 SQL 阈值 / 单条 SQL 超时 | 毫秒 |
| 表空间告警阈值 / 表空间严重阈值 | 百分比 |
| 报告目录 | 可选 |

卡片中的值按会话隔离，保存在 dsh 进程内存中，重启 dsh 后需要重新填写。

### 口令的另外两种来源

环境变量（启动 dsh 前设置）：

```sh
export DM8_INSPECT_PASSWORD='数据库口令'
export DM8_INSPECT_SSH_PASSWORD='SSH口令'
```

或写入 `~/.dsh/.credentials.yaml` 的 `refs`，键名同上。

### 插件配置

写在 profile 的 `cordis.patch.yml` 中该插件那一行上，也可以在设置界面里修改：

```yaml
- insert:
    - id: dm8-inspect
      name: 'dsh-plugin-dm8-inspect'
      config:
        home: 'D:\dm8-inspect-home'      # 工作目录，默认 ~/.dsh/dm8-inspect
        driver: 'jdbc'
        credentialRef: 'DM8_INSPECT_PASSWORD'
        sshCredentialRef: 'DM8_INSPECT_SSH_PASSWORD'
        outDir: ''                        # 默认 <会话工作目录>/dm8-inspect-reports
        topN: 10
        tsWarnPct: 80
        tsCritPct: 90
        slowSqlMs: 1000
        queryTimeoutMs: 30000
        connectTimeoutMs: 20000
        clusterConcurrency: 3             # 集群巡检的节点并发数
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `home` | `~/.dsh/dm8-inspect` | 工作目录，其下有 `drivers/`、`java/`、`runtime/` |
| `driver` | `jdbc` | 默认巡检驱动 |
| `credentialRef` | `DM8_INSPECT_PASSWORD` | 数据库口令的凭据名 |
| `sshCredentialRef` | `DM8_INSPECT_SSH_PASSWORD` | SSH 口令的凭据名 |
| `outDir` | 空 | 报告目录，留空则使用会话工作目录下的 `dm8-inspect-reports` |
| `topN` | `10` | Top 类巡检项条数 |
| `tsWarnPct` / `tsCritPct` | `80` / `90` | 表空间使用率阈值（%） |
| `slowSqlMs` | `1000` | 慢 SQL 阈值（毫秒） |
| `queryTimeoutMs` | `30000` | 单条 SQL 超时（毫秒） |
| `connectTimeoutMs` | `20000` | 连接超时（毫秒） |
| `clusterConcurrency` | `3` | 集群巡检的节点并发数，上限 8 |

## 注意事项

- 所有巡检 SQL 都是查询语句，不修改数据库任何配置。
- 连接失败时不生成报告文件，只返回失败原因。
- 单实例环境下「不适用」最少 11 项，这些是共享存储集群与数据守护专项。要覆盖全部 85 项，还需在卡片中填写 SSH 账号。
- OS 级检查依赖 SSH。未填 SSH 账号时，主机 CPU / 内存 / IO、内核参数、日志扫描等项判为「不适用」。
- 报告默认输出到会话工作目录，而不是 dsh 进程的启动目录。
- 数据守护（主备）形态尚未在真机验证：`dw.*` 那 5 个巡检项使用相同的视图，但结论文案与形态判定没有实测。
- 以下环境未验证：DM9、Windows 上的达梦、ARM 架构（鲲鹏 / 飞腾）、启用归档的库。
- 工作目录会保留编译缓存。Java 8 下首次运行会编译桥接器，产物在 `home/runtime/classes`；删除 `home/runtime/` 可清空，下次运行自动重建。
- 报告文件名带时间戳，同一目录下多次巡检不会互相覆盖。

## 卸载

```sh
dsh plugin --profile web remove dsh-plugin-dm8-inspect
```

再删除工作目录（其中包含驱动 jar）：

| 平台 | 命令 |
|---|---|
| Windows | `Remove-Item "$env:USERPROFILE\.dsh\dm8-inspect" -Recurse -Force` |
| Linux | `rm -rf ~/.dsh/dm8-inspect` |

## 目录结构

```
├── package.json          插件清单
├── cordis.patch.yml      作为 bundle 的插入清单
├── lib/
│   ├── index.js          插件入口：注册工具与会话设置路由
│   ├── tool.js           dm8_inspect 工具定义
│   ├── session-form.js   设置卡片的进程内暂存
│   ├── engine.js         加载 engine/ 下的巡检引擎
│   └── workspace.js      工作目录准备
├── client/
│   └── client.js         设置卡片的客户端部分
├── engine/               巡检引擎：巡检项定义、执行器、报告生成
├── assets/java/
│   └── DmBridge.java     JDBC 桥接器源码
└── tools/                开发与自检脚本
```

## 开发

```sh
node tools/package-check.mjs        # 清单与文档中的声明是否与代码一致
node tools/smoke.mjs                # 用内置样例数据跑完整链路
node tools/session-form-check.mjs   # 设置卡片：字段、取值优先级、渲染
node tools/apply-check.mjs          # 插件注册与路由
node tools/verify-install.mjs       # 安装结果能否被加载，--profile 指定 profile
node tools/live.mjs                 # 连真实库巡检一次，需 DM8_TEST_HOST、DM8_TEST_DB_PW 等环境变量
node tools/install.mjs              # 手动安装或卸载，支持 --dry-run、--uninstall
```

## 许可证

[MIT](LICENSE)
