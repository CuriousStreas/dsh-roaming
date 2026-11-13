# dsh-roaming

让你的 DSH 会话和记忆，随你在不同机器之间「漫游」。

用 **git 仓库** 作为介质，跨机器同步 **会话** 和 **记忆**。装上这个插件，你在机器 A 上聊的会话、攒下的记忆，机器 B 拉一下就到手。

## ✨ 特性

- **跨机器会话同步**：选择性上传会话，按内容指纹去重，拉取不重复、不反弹。
- **记忆同步**：可选同步 `~/.mnemon/runtime/` 的记忆文件（`MEMORY.md` / `USER.md` / `memories.json`）。
- **自动同步**：默认每小时自动拉取云端 + 推送已同步会话，间隔可调（1 分钟 ~ 7 天）。
- **git 仓库介质**：一个仓库 = 一个用户，一台机器 = 一个主机目录，天然自带版本历史。
- **校验 + 去重**：SHA-256 校验传输完整性；内容指纹（非 id）去重，防两台机器来回反弹。

## 安装

```sh
# 从 GitHub 装（推荐）
dsh plugin add github:<you>/dsh-roaming

# 或本地开发（file: 拷贝，改了代码要重跑这条）
dsh plugin add "file:D:/path/to/dsh-roaming"
```

> ⚠️ **不要用 `link:` 安装**：DSH 的 client-modules 无法通过 SymbolicLink 发现插件的 Web UI，侧栏不会出现入口。

## 使用

1. 建一个 **私有** git 仓库（记忆和会话是隐私），建议配 token。
2. 装插件后，侧栏点 **「Roaming」** 入口，在面板里 **配置仓库** 填 URL。
3. 会话列表里点 **「上传」**，把会话推到云端。
4. 点 **「⟳ 全量同步」**（或等自动同步），把云端的会话拉到本机。

## 仓库结构

```
<repo>/
  memory/                 ← 记忆文件，全局一份（属于用户）
    MEMORY.md / USER.md / memories.json
  hosts/
    <hostname-A>/         ← 每台机器一个目录
      <sessionId>.json    ← 每个会话一个 wire-format JSON
```

## 工作原理

复用 [dsh-session-sync](https://github.com/XXGxiaoyu/dsh-session-sync) 的导出/导入桥（SHA-256 校验、跨机 cwd 回退、seq 重索引、内容指纹去重），把它的「局域网 HTTP 传输层」换成 git 远程仓库。

## GUI API（`POST /roaming/api`）

| action | 参数 | 作用 |
|---|---|---|
| `status` | - | 配置与仓库状态 |
| `configure` | `{ repoUrl }` | 设置远程仓库并 clone |
| `listLocal` | - | 列出本地会话 |
| `push` | `{ sessionIds: [] }` | 导出并推会话 |
| `pull` | - | 拉取并导入会话 |
| `syncAll` | - | 全量同步（pull + push 已同步会话） |
| `settings` | `{ autoSync, autoSyncIntervalMs }` | 自动同步开关/间隔 |
| `pushMemory` / `pullMemory` | - | 上传/下载记忆文件 |

## 配置（loader 行 `config`）

| Key | 默认 | 含义 |
|---|---|---|
| `repoUrl` | - | 远程仓库地址（也可运行时 configure） |
| `home` | `$DSH_HOME` / `~/.dsh` | DSH 根目录 |
| `mnemonHome` | `~/.mnemon` | mnemon 记忆目录 |
| `syncDir` | `process.cwd()` | pull 导入的会话落到哪个工作区 |
| `verbose` | `true` | 是否打印日志 |

## 设计取舍（阶段 1）

- **只做「顺序接力」**：两台机器别同时聊同一个会话再各自 push，并发分叉暂不处理。
- **记忆同步是文件级**：只搬三个文件，不做语义合并，冲突由 git 合并（或较新时间戳覆盖）。
- **凭据永不进仓库**：`.credentials.yaml` 不参与任何同步。

## License

[MIT](./LICENSE)
