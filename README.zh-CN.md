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
