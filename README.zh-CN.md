# herdr-auto-retry

在 [Herdr](https://herdr.dev) 中自动检测并重试因模型容量超限（at capacity）或服务器过载而中断的 AI 编程 Agent。

[English Documentation](./README.md)

![Herdr Plugin](https://img.shields.io/badge/herdr-plugin-blue?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)

当 Agent（例如 OpenAI Codex）在执行长任务时偶发容量超限或网络过载时，通常会中断并进入等待用户干预的空闲状态：

```text
Selected model is at capacity. Please try a different model.
```

```text
stream disconnected before completion: Our servers are currently overloaded.
Please try again later.
```

```text
exceeded retry limit, last status: 429 Too Many Requests, request id: ...
```

`herdr-auto-retry` 是一个原生的 Herdr 插件。它在后台监控 Agent 窗格，使用去抖动逻辑和指数退避算法检测容量报错与 429 速率限制，并在冷却后自动向 Agent 发送 `continue` 提示词，实现任务全自动继续执行。

---

## 核心特性

- **原生 Herdr 插件生命周期**：
  - `[[startup]]`：在 Herdr 启动或恢复会话时自动拉起后台守护进程。
  - `[[actions]]`：在 Herdr 内部提供 `status`、`scan`、`start` 和 `stop` 等操作。
  - `[[panes]]`：提供 popup 模态监控面板，随时直观查看 Agent 状态。
- **自适应轮询节拍**：
  - `busy`（5秒）：至少有一个 Agent 正处于重试周期中。
  - `active`（10秒）：有被监控的 Agent 正在健康运行。
  - `idle`（60秒）：当前没有正在运行的被监控 Agent（几乎不消耗 CPU 和 I/O）。
- **指数退避与防抖保护**：
  - 指数递增等待时间（默认 15s -> 30s -> 最多 60s）。
  - 防抖机制：连续 3 次扫描未见报错横幅才判定本轮异常恢复，避免由于终端刷新/动效导致的误判。
- **Codex Goal 自动恢复**：
  - Codex goal 停滞（`Goal stalled (/goal resume)`）时，在当前回合结束后自动发送 `/goal resume`。详见 [Codex Goal 自动恢复](#codex-goal-自动恢复)。
- **灵活扩展与配置**：
  - 支持监控多种 Agent（默认为 Codex，可自定义扩展为 Claude 等）。
  - 支持通过 JSON 文件或环境变量自定义匹配特征、重试提示词、等待参数等。
- **零外部运行时依赖**：
  - 源码通过 `tsup` 预编译为单个自包含的 JS 文件（`dist/index.js`），用户机器仅需 Node.js 18+，安装插件时无需安装 `pnpm`。

---

## 安装方式

通过 Herdr 直接从 GitHub 安装：

```bash
herdr plugin install bestony/herdr-auto-retry
```

本地开发调试链接：

```bash
herdr plugin link .
```

---

## 动作（Actions）

本插件向 Herdr 声明了以下操作：

| 动作 ID | 名称 | 说明 |
| ------- | ---- | ---- |
| `status` | Retry status | 查看守护进程状态、被监控 Agent 与重试统计 |
| `scan` | Scan and retry once | 立即扫描全部处于空闲/停滞状态的 Agent，如发现报错立即重试 |
| `start` | Start watcher daemon | 在后台启动常驻自动重试守护进程 |
| `stop` | Stop watcher daemon | 停止后台自动重试守护进程 |

通过 Herdr CLI 调用动作：

```bash
# 查看状态
herdr plugin action invoke status --plugin bestony.auto-retry

# 手动触发一次扫描
herdr plugin action invoke scan --plugin bestony.auto-retry
```

---

## 配置说明

Herdr 为插件分配的配置目录可通过以下命令查看：

```bash
herdr plugin config-dir bestony.auto-retry
# 通常位于：~/.config/herdr/plugins/config/bestony.auto-retry
```

在该目录下创建 `config.json` 即可自定义配置：

```json
{
  "agents": ["codex"],
  "prompt": "continue",
  "minWait": 15,
  "maxWait": 60,
  "missReset": 3,
  "staleAfter": 600,
  "intervals": {
    "busy": 5,
    "active": 10,
    "idle": 60
  },
  "matches": [
    "Selected model is at capacity",
    "stream disconnected before completion: Our servers are currently overloaded",
    "exceeded retry limit, last status: 429 Too Many Requests"
  ]
}
```

### 环境变量支持

| 环境变量 | 作用 | 默认值 |
| -------- | ---- | ------ |
| `HERDR_AUTO_RETRY_AGENTS` | 监控的 Agent 类型列表（逗号分隔） | `codex` |
| `HERDR_AUTO_RETRY_PROMPT` | 唤醒重试时发送的提示词 | `continue` |
| `HERDR_AUTO_RETRY_MATCH` | 自定义匹配文本（每行一个） | （内置 Codex 错误特征） |
| `HERDR_AUTO_RETRY_MIN_WAIT` | 初始重试等待时间（秒） | `15` |
| `HERDR_AUTO_RETRY_MAX_WAIT` | 最大退避等待上限（秒） | `60` |
| `HERDR_AUTO_RETRY_BUSY_INTERVAL` | 发生错误时的轮询间隔（秒） | `5` |
| `HERDR_AUTO_RETRY_INTERVAL` | Agent 正常运行时的轮询间隔（秒） | `10` |
| `HERDR_AUTO_RETRY_IDLE_INTERVAL` | 没有 Agent 时的休眠间隔（秒） | `60` |
| `HERDR_AUTO_RETRY_WORKERS` | 最大并发扫描/重试并发数 | `8` |
| `HERDR_AUTO_RETRY_VERBOSE` | 是否输出详细日志（`1` 或 `0`） | `0` |
| `HERDR_AUTO_RETRY_GOAL_RESUME` | 是否启用 codex goal 自动恢复（`1` 或 `0`） | `1` |
| `HERDR_AUTO_RETRY_GOAL_PROMPT` | 恢复停滞 goal 时发送的提示词 | `/goal resume` |
| `HERDR_AUTO_RETRY_GOAL_STATUSES` | 需要恢复的 goal 状态（逗号分隔） | `blocked,usage_limited` |
| `HERDR_AUTO_RETRY_GOAL_MIN_INTERVAL` | 同一 Agent 两次恢复的最小间隔（秒） | `300` |
| `HERDR_AUTO_RETRY_GOAL_MAX_INTERVAL` | 恢复退避上限（秒） | `1800` |
| `HERDR_AUTO_RETRY_SQLITE_BIN` | 无 `node:sqlite` 时使用的 `sqlite3` 命令 | `sqlite3` |
| `CODEX_HOME` | Codex 主目录 | `~/.codex` |

---

## Codex Goal 自动恢复

Codex 以 goal 模式（`/goal <objective>`）工作时，如果遇到临时的服务端错误或用量限制，会把 goal 标记为 `blocked` 或 `usage_limited`，界面显示 `Goal stalled (/goal resume)`。Agent 可能会跑完当前回合，但之后不会继续。发送普通的 `continue` 无法解决，因为 goal 仍处于停滞状态。

对每个被监控的 `codex` Agent，每次扫描按顺序检查：

1. herdr 报告 Agent 已停下（不是 `working` 或 `blocked`）。
2. `<codexHome>/goals_1.sqlite`（表 `thread_goals`，主键为 `herdr agent get` 返回的 codex session id）中的 goal 状态属于 `goalResume.statuses`。优先用 `?mode=ro` 打开；失败时（WAL 模式下只读无法创建 `-shm`）改用 `?mode=ro&immutable=1`，该模式忽略 WAL，读到的状态可能略旧。
3. rollout 文件（`<codexHome>/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl`）尾部最后一个回合事件是 `task_complete`。尾部找不到 `task_started` / `task_complete` / `turn_aborted` 时视为未知并继续等待；`turn_aborted` 交给人工处理。
4. 可见屏幕（`herdr agent read --source visible`）显示空闲输入框（`Ask Codex to do anything`），不含 `Working (`，且没有选择列表或模态框（例如 `Replace goal?` 或审批弹层）。
5. 该 Agent 的限速允许本次发送。

满足后通过 `herdr agent prompt` 发送 `/goal resume`，不会切换焦点。

规则：

- 默认只恢复 `blocked` 和 `usage_limited`。`paused`（人工暂停）、`budget_limited`（主动设置的预算）、`active`、`complete` 不会被恢复。可以把 `paused` 或 `budget_limited` 加入 `goalResume.statuses`，此时插件会打印警告；`active` 和 `complete` 永远不会被恢复。
- 限速：一次恢复后，同一 Agent 至少等待 `minInterval` 秒。如果在 `resetAfter` 秒内再次停滞，等待时间逐次翻倍，最多到 `maxInterval`；超过 `resetAfter` 后的停滞重新从 `minInterval` 开始。
- goal 停滞期间，该 Agent 的横幅重试（`continue`）会被跳过；goal 未停滞或没有 goal 时，横幅重试照常工作。
- 每次状态变化、每次恢复、每个新的等待原因都会写入日志；`HERDR_AUTO_RETRY_VERBOSE=1` 输出每次扫描的细节；`dryRun: true` 只记录不发送。
- SQLite 读取优先使用 Node 自带的 `node:sqlite`（Node 22.13+ / 23.4+），否则调用 `sqlite3` 命令行（可用 `HERDR_AUTO_RETRY_SQLITE_BIN` 指定路径）。Node 22 下 `node:sqlite` 可能在守护进程日志中输出 `ExperimentalWarning`。

配置（`config.json` 中的 `goalResume`，以下为默认值）：

```json
{
  "goalResume": {
    "enabled": true,
    "prompt": "/goal resume",
    "statuses": ["blocked", "usage_limited"],
    "minInterval": 300,
    "maxInterval": 1800,
    "resetAfter": 3600,
    "codexHome": "~/.codex",
    "rolloutTailBytes": 2097152,
    "idleMarkers": ["Ask Codex to do anything"],
    "busyMarkers": ["Working ("],
    "modalMarkers": [
      "Replace goal?",
      "Press enter to confirm",
      "enter to confirm",
      "esc to cancel",
      "Would you like to run the following command",
      "Would you like to make the following edits",
      "Allow command",
      "Do you trust the files in this folder"
    ]
  }
}
```

| 键 | 说明 | 默认值 |
| -- | ---- | ------ |
| `enabled` | 是否自动恢复停滞的 codex goal | `true` |
| `prompt` | 恢复 goal 时发送的文本 | `/goal resume` |
| `statuses` | 触发恢复的 goal 状态 | `["blocked", "usage_limited"]` |
| `minInterval` | 同一 Agent 两次恢复的最小间隔（秒） | `300` |
| `maxInterval` | 反复停滞时的最大退避（秒） | `1800` |
| `resetAfter` | 距上次恢复超过该秒数的停滞视为新一轮 | `3600` |
| `codexHome` | Codex 主目录 | `$CODEX_HOME` 或 `~/.codex` |
| `rolloutTailBytes` | 从 rollout 文件末尾读取的字节数 | `2097152`（2 MB） |
| `idleMarkers` / `busyMarkers` / `modalMarkers` | 空闲输入框 / 回合进行中 / 模态框的屏幕特征文本 | 见上 |

---

## 独立 CLI 命令

插件也可直接在终端独立执行：

```bash
# 后台启动守护进程
./dist/index.js daemon --start

# 查看当前状态
./dist/index.js status

# 单次扫描
./dist/index.js scan

# 停止守护进程
./dist/index.js daemon --stop
```

---

## 本地开发与构建

系统环境要求：
- Node.js 18+
- pnpm 9+

```bash
# 安装依赖
pnpm install

# TypeScript 类型检查
pnpm run typecheck

# 执行单元测试
pnpm test

# 编译打包单文件
pnpm run build
```

---

## 开源许可

MIT © [bestony](https://github.com/bestony)
