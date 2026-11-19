# dsh-roaming

> **安全预览版 `0.3.0-preview`，目前不能同步会话或记忆。** 不要为了尝试同步而安装到日常 DSH profile。本地旧版镜像和状态不自动迁移。

目标是通过 Git 数据仓库在设备间接续已授权的 DSH 会话；云端只存数据，压缩与数据协议版本检查仅属于本地镜像与数据仓库，不修改 DSH 原生会话格式。

## 当前可做 / 不可做

| 当前可以 | 当前禁止 |
|---|---|
| 克隆或拉取**隔离镜像**；旧版 `hosts/*.json` 只读条目校验展示；v3 仓库在独立验证 marker/manifest/不可变对象 SHA 后仅展示 key 与 revision 指针，不解析原生会话内容 | 扫描原生会话、上传、导入、追加、修改 DSH 工作区或模型、记忆文件覆盖、自动同步、迁移旧版状态 |

新状态在 `<DSH_HOME>/roaming/v3/`，完全不复用旧 `<DSH_HOME>/roaming/state.json` 或 `repo/`。启动时不自动网络访问。预览数据的 `SCHEMA_VERSION` 标记和条目必须是镜像内的普通文件，软链接/重解析跳转拒绝读取；该同步预览对同时发生的本地目录替换仍不是强原子沙箱，不应用于敌对共用工作目录。配置仓库时要求浅克隆成功、原仓库 origin 与配置匹配，已存在的非浅镜像会失败关闭；预览拉取只允许快进，不合并本地分叉；已有镜像如有工作树修改、未追踪或被忽略的文件，或其 HEAD 与刚拉取的远端跟踪分支不一致，拒绝将它作为远端预览。拉取失败不能用旧镜像冒充最新数据。仓库 `SCHEMA_VERSION` 是 roaming 数据协议版本，不是 DSH 会话版本；旧版 `hosts` 读器不理解 v3 manifest/immutable objects，因此 v3 只走独立指针校验预览，坏对象拒绝而非假装空仓库，**预览旧版数据不表示允许写入**。

`POST /roaming/api` 的 `status`、`listLocal`（空列表）、`configure`、`pull`、`syncAll`（当前仅预览）、`openLogs` 可用。`push`、`pushMemory`、`pullMemory`、`pushConfig` 明确返回 `preview-only`；`settings` 不能打开自动同步。API 必须由 DSH connection 服务验证身份，缺失时拒绝请求；安装前仍需完成真实 Host 的 API 路由及隔离端到端测试。

## 重构路线与迁移闸门

1. 只读预览；先离线备份旧镜像、旧状态与云端仓库，不对历史做原地改写。旧镜像有未推送的 Git 历史，不能当云端已确认。
2. 新仓库协议使用稳定 conversation key + 持久化用户明确选择的本地 session binding；完整内容摘要作共享基线。三路比较只接受相同修订/单边推进，双方变化保留两个 revision，不自动覆盖。新旧文件扩展名只是编码，不参与会话身份。
3. 只有在临时 DSH profile 中验证可打开、可续聊、可再次导出后才开放导入；导入失败不写原生会话。真实会话必须是只读源，插件不能使用 `open(id,'write')` 更新原生会话。
4. Git 拉取/推送和远端确认状态分开记录。记忆迁移走独立安全协议，不直接覆盖 Mnemon 运行态文件。
5. 双机隔离测试包括未授权会话不上传、等长内容冲突、断网/推送拒绝、坏压缩包、历史会话、重复导入、活跃会话与附件；通过后才讨论安装到日常 profile。

迁移边界与验收细则见 [MIGRATION.md](./MIGRATION.md)。测试（仅临时目录，不连接用户仓库）：`node test/safety.test.mjs`、`node test/api.test.mjs`、`node test/revisions.test.mjs`、`node test/ledger.test.mjs`、`node test/manifest.test.mjs`、`node test/publisher.test.mjs`、`node test/git.test.mjs`、`node test/transport.test.mjs`、`node test/protocol-e2e.test.mjs`、`node test/snapshot-gate.test.mjs`、`node test/read-only-snapshot.test.mjs`。Git fixture 在受限 sandbox 无法建立 signal pipe，需在允许运行本地 Git 的隔离环境执行。`transport` 现在从独立临时 clone 发布，测试覆盖拒绝推送后原镜像不变与重试；镜像下载后会以 64 MiB 文件总量上限失败关闭，但这**不能限制 Git 传输时的网络字节、临时磁盘或目录数量**；完整 Git 历史下载上限及真实网络故障仍未验收。`read-only-snapshot` 仅是未接入 API 的隔离 fixture 适配器：从明确绑定的 ID 取公共 `open('read')`，按分页读取并用同服务的 stat 修订夹住读取，对已取得的事件逐条执行累积字节上限；后者不能限制持久层在返回单个事件前的内存分配，也不能证明来源绝对静止或跨机回放。`snapshot-gate` 只是断开 DSH 的离线入选预检：拒绝明显缺失的 v4 元数据、不保真的 JSON 值与内嵌或残缺的 image/file/attachment 引用；其 SHA-256 对重序列化后的候选结构计算，**不是原始会话字节摘要，更不是导出器、完整媒体校验或 replay/import 证明**。在安装的 DSH `0.2.1-rc.5` JSONL 后端上，`test/native-roundtrip.manual.mjs` 已在系统临时目录中以包含合成用户文本、无附件会话验证 `create/append/flush` → 已绑定 ID 的 `open('read')` 快照 → `Session.fromRestore`（测试入口必须显式设置绝对路径 `DSH_INSTALL_ROOT`）；对提取的字节投影运行原生 `Session.fromRestore` 并检查读前后 stat revision 相同、未绑定 key 不能访问持久层；仅证明这一受限 fixture 可读取和脱离运行态回放，原生消息投影在这个合成 fixture 中与源一致；第二个独立临时 JSONL root 可创建相同合成 ID 并保持事件/消息一致，重复 ID 创建被拒绝；`AgentLoop.resume`、模型输出、fork/附件、跨机 ID 映射、写入中故障隔离及正式导入策略仍未验证，不开放原生导入。当前 ledger/manifest/publisher/transport 是离线协议核心；`protocol-e2e` 仅模拟两设备 Git 镜像，**尚未连入 API、未完成 DSH 跨机导入，不能据此声称已完成双机同步**。其中 transport 只接受新仓库的 schema=3 标记，不会升级旧仓库；纯 publisher 的确认结果必须由独立远端校验提供，不能信任调用方自行构造的确认；同修订会合通过只读远端观察和完整对象比对推进共享基线，不写原生会话。

## License

[MIT](./LICENSE)
