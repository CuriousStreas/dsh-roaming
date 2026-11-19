# dsh-roaming

> **安全预览版 `0.3.0-preview`，目前不能同步会话或记忆。** 不要为了尝试同步而安装到日常 DSH profile。本地旧版镜像和状态不自动迁移。

目标是通过 Git 数据仓库在设备间接续已授权的 DSH 会话；云端只存数据，压缩与数据协议版本检查仅属于本地镜像与数据仓库，不修改 DSH 原生会话格式。

## 当前可做 / 不可做

| 当前可以 | 当前禁止 |
|---|---|
| 列出本机会话元数据；克隆或拉取**隔离的 v3 数据镜像**，展示经 SHA-256 校验的旧仓库会话条目和错误清单 | 上传、导入、追加原生会话、修改 DSH 工作区或模型、记忆文件覆盖、自动同步、迁移旧版状态 |

新状态在 `<DSH_HOME>/roaming/v3/`，完全不复用旧 `<DSH_HOME>/roaming/state.json` 或 `repo/`。启动时不自动网络访问。配置仓库时要求 clone 成功、原仓库 origin 与配置匹配；拉取失败不能用旧镜像冒充最新数据。仓库 `SCHEMA_VERSION` 是 roaming 数据协议版本，不是 DSH 会话版本；**预览旧版数据不表示允许写入**。

`POST /roaming/api` 的 `status`、`listLocal`、`configure`、`pull`、`syncAll`（当前仅预览）、`openLogs` 可用。`push`、`pushMemory`、`pullMemory`、`pushConfig` 明确返回 `preview-only`；`settings` 不能打开自动同步。API 必须由 DSH connection 服务验证身份，缺失时拒绝请求；安装前仍需完成真实 Host 的 API 路由及隔离端到端测试。

## 重构路线与迁移闸门

1. 只读预览；先离线备份旧镜像、旧状态与云端仓库，不对历史做原地改写。旧镜像有未推送的 Git 历史，不能当云端已确认。
2. 新仓库协议使用稳定 conversation key + 持久化用户明确选择的本地 session binding；完整内容摘要作共享基线。三路比较只接受相同修订/单边推进，双方变化保留两个 revision，不自动覆盖。新旧文件扩展名只是编码，不参与会话身份。
3. 只有在临时 DSH profile 中验证可打开、可续聊、可再次导出后才开放导入；导入失败不写原生会话。真实会话必须是只读源，插件不能使用 `open(id,'write')` 更新原生会话。
4. Git 拉取/推送和远端确认状态分开记录。记忆迁移走独立安全协议，不直接覆盖 Mnemon 运行态文件。
5. 双机隔离测试包括未授权会话不上传、等长内容冲突、断网/推送拒绝、坏压缩包、历史会话、重复导入、活跃会话与附件；通过后才讨论安装到日常 profile。

迁移边界与验收细则见 [MIGRATION.md](./MIGRATION.md)。测试（仅临时目录，不连接用户仓库）：`node test/safety.test.mjs`、`node test/api.test.mjs`、`node test/revisions.test.mjs`、`node test/ledger.test.mjs`、`node test/manifest.test.mjs`、`node test/git.test.mjs`。Git fixture 在受限 sandbox 无法建立 signal pipe，需在允许运行本地 Git 的隔离环境执行。当前 ledger/manifest 是离线协议核心，**尚未连入 API，也不能据此声称已完成双机同步**。

## License

[MIT](./LICENSE)
