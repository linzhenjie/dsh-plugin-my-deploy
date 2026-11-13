# my-deploy

DSH（DeepSeek Harness）Web 插件：在左侧导航栏增加一个 Grafana 观测面板入口，提供监控指标、
日志与链路追踪标签。页面右上角填写 Grafana MCP HTTP 地址并连接；日志与链路追踪通过对话查询，
当前工具名为 `query_loki_logs` / `query_tempo_traces`，需 Grafana MCP 服务提供对应工具。
指标实时接入仍需 MCP 数据源实现。

## 安装

前置条件：本机已装好 `dsh` CLI（DeepSeek Harness）与 pnpm，Node.js 版本满足该 DSH 版本的
要求。下面命令里的 `web` 换成你自己的 profile 名；**`--profile` 必须放在所有 pnpm 参数之前**。

```powershell
dsh plugin --profile web add github:linzhenjie/dsh-plugin-my-deploy
```

等价的完整 URL 写法：

```powershell
dsh plugin --profile web add https://github.com/linzhenjie/dsh-plugin-my-deploy.git
```

锁版本：`github:linzhenjie/dsh-plugin-my-deploy#v1.6.0`（`#` 后接 tag 或 commit sha）。

仓库根目录就是插件包根，`client.js` / `client.*.js` / `cordis.patch.yml` 等运行时产物都已提交，
包里没有 `prepare` 脚本，安装时无需构建，也不会触发 pnpm 10 的 `allowBuilds` 授权。

### 与 my-navigation 同时安装

两个插件的 bundle id、侧边栏入口、Host 路由和数据文件是隔离的：

| | my-navigation | my-deploy |
|---|---|---|
| Host 路由 | `/api/my-navigation/state` | `/api/my-deploy/state` |
| 数据文件 | `%DSH_HOME%\storages\my-navigation.json` | `%DSH_HOME%\storages\my-deploy.json` |

可以直接在同一个 profile 里都装上，不会互相覆盖。

### 本地开发

```powershell
git clone https://github.com/linzhenjie/dsh-plugin-my-deploy.git
dsh plugin --profile web add ./dsh-plugin-my-deploy
```

相对路径按当前目录解析，本地以 `link:` 安装。改完 `src/` 跑 `node build.mjs`
（`node build.mjs --check` 只校验，不写文件）；`index.js` 改完要重启 `dsh web`。

### 验证与重启

```powershell
dsh plugin --profile web list
```

`$DSH_HOME\profiles\web\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都应有
`my-deploy`。**装完必须重启 `dsh web`**：Host 半边是进程内已加载的模块，路由要重启才注册。

### 卸载

```powershell
dsh plugin --profile web remove my-deploy
```
