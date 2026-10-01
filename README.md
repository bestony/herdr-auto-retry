# herdr-auto-retry

Auto-continue [Herdr](https://herdr.dev) coding agents when rate-limited, overloaded, or at capacity.

[中文文档](./README.zh-CN.md)

![Herdr Plugin](https://img.shields.io/badge/herdr-plugin-blue?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)

When coding agents (such as OpenAI Codex) stop mid-task with a capacity or rate-limit error, they become idle and wait for human intervention:

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

`herdr-auto-retry` is an official Herdr plugin that watches your agent panes, detects capacity/rate-limit errors with debounce protection, calculates exponential backoff, and automatically submits a `continue` prompt.

---

## Features

- **Native Herdr Lifecycle**:
  - `[[startup]]` hook automatically starts the background watcher daemon when Herdr starts or restores a session.
  - `[[actions]]` provide `status`, `scan`, `start`, and `stop` controls from Herdr.
  - `[[panes]]` provides a popup terminal monitor for live status inspection.
- **Adaptive Cadence**:
  - `busy` (5s): At least one agent is in a retry episode.
  - `active` (10s): Monitored agents are running and healthy.
  - `idle` (60s): No monitored agents are active (near-zero CPU / I/O consumption).
- **Exponential Backoff & Debounce**:
  - Exponential wait with maximum cap (default 15s -> 30s -> 60s max).
  - Debounce protection requires 3 consecutive banner-free scans before clearing an episode, preventing false resets caused by screen flicker.
- **Codex Goal Resume**:
  - When a codex goal stalls (`Goal stalled (/goal resume)`), the plugin sends `/goal resume` after the current turn ends. See [Codex goal resume](#codex-goal-resume).
- **Extensible & Configurable**:
  - Monitored agents, patterns, prompt text, intervals, and backoff parameters are configurable via JSON or environment variables.
- **Zero Runtime Dependencies**:
  - Pre-bundled into a single standalone script (`dist/index.js`). Node.js 18+ is the only runtime requirement.

---

## Installation

Install directly into Herdr from GitHub:

```bash
herdr plugin install bestony/herdr-auto-retry
```

To link a local clone during development:

```bash
herdr plugin link .
```

---

## Actions

Herdr exposes actions declared by this plugin:

| Action ID | Title | Description |
| --------- | ----- | ----------- |
| `status` | Retry status | Print daemon state, monitored agents, and retry stats |
| `scan` | Scan and retry once | Immediately scan all settled agents and retry if stuck |
| `start` | Start watcher daemon | Start the resident auto-retry daemon in the background |
| `stop` | Stop watcher daemon | Stop the background auto-retry daemon |

Invoke actions via Herdr CLI:

```bash
# Check status
herdr plugin action invoke status --plugin bestony.auto-retry

# Force a scan
herdr plugin action invoke scan --plugin bestony.auto-retry
```

---

## Configuration

Herdr manages the plugin configuration directory at:

```bash
herdr plugin config-dir bestony.auto-retry
# Typically: ~/.config/herdr/plugins/config/bestony.auto-retry
```

You can create `config.json` in that directory:

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

### Environment Variable Overrides

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `HERDR_AUTO_RETRY_AGENTS` | Comma-separated agent names to monitor | `codex` |
| `HERDR_AUTO_RETRY_PROMPT` | Prompt string sent to unblock agents | `continue` |
| `HERDR_AUTO_RETRY_MATCH` | Custom match strings (one pattern per line) | (Codex capacity banners) |
| `HERDR_AUTO_RETRY_MIN_WAIT` | Initial retry wait in seconds | `15` |
| `HERDR_AUTO_RETRY_MAX_WAIT` | Maximum retry wait cap in seconds | `60` |
| `HERDR_AUTO_RETRY_BUSY_INTERVAL` | Poll interval when an agent is stuck | `5` |
| `HERDR_AUTO_RETRY_INTERVAL` | Poll interval when agents are active | `10` |
| `HERDR_AUTO_RETRY_IDLE_INTERVAL` | Poll interval when no agents exist | `60` |
| `HERDR_AUTO_RETRY_WORKERS` | Max parallel target scans per cycle | `8` |
| `HERDR_AUTO_RETRY_VERBOSE` | Enable verbose decision logging (`1` or `0`) | `0` |
| `HERDR_AUTO_RETRY_GOAL_RESUME` | Enable codex goal resume (`1` or `0`) | `1` |
| `HERDR_AUTO_RETRY_GOAL_PROMPT` | Prompt sent to resume a stalled goal | `/goal resume` |
| `HERDR_AUTO_RETRY_GOAL_STATUSES` | Comma-separated goal statuses to resume | `blocked,usage_limited` |
| `HERDR_AUTO_RETRY_GOAL_MIN_INTERVAL` | Minimum seconds between resumes of one agent | `300` |
| `HERDR_AUTO_RETRY_GOAL_MAX_INTERVAL` | Maximum resume backoff in seconds | `1800` |
| `HERDR_AUTO_RETRY_SQLITE_BIN` | `sqlite3` CLI used when `node:sqlite` is not available | `sqlite3` |
| `CODEX_HOME` | Codex home directory | `~/.codex` |

---

## Codex Goal Resume

When codex pursues a goal (`/goal <objective>`) and hits a transient server error or a usage limit, it marks the goal `blocked` or `usage_limited` and shows `Goal stalled (/goal resume)`. The agent can finish its current turn, but it does not continue after that. A plain `continue` prompt does not fix this, because the goal stays stalled.

For every monitored `codex` agent, each scan does these checks in order:

1. herdr reports the agent as settled (not `working` or `blocked`).
2. The goal status in `<codexHome>/goals_1.sqlite` (table `thread_goals`, key = the codex session id from `herdr agent get`) is in `goalResume.statuses`. The plugin opens the database with `?mode=ro`. If that fails (WAL database, read-only cannot create `-shm`), it uses `?mode=ro&immutable=1`. The immutable mode ignores the WAL, so the status can be slightly old.
3. The last turn event in the tail of the rollout file (`<codexHome>/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl`) is `task_complete`. If the tail has no `task_started` / `task_complete` / `turn_aborted` event, the turn is unknown and the plugin waits. `turn_aborted` is left to the human.
4. The visible screen (`herdr agent read --source visible`) shows the idle composer (`Ask Codex to do anything`), does not show `Working (`, and shows no selection list or modal (for example `Replace goal?` or an approval overlay).
5. The per-agent rate limit allows it.

Then the plugin sends `/goal resume` with `herdr agent prompt`. It never focuses the pane.

Rules:

- Only `blocked` and `usage_limited` are resumed by default. `paused` (a human paused the goal), `budget_limited` (a deliberate budget), `active` and `complete` are not resumed. You can add `paused` or `budget_limited` to `goalResume.statuses`; the plugin then logs a warning. `active` and `complete` are never resumed.
- Rate limit: after a resume, the next resume for the same agent waits `minInterval` seconds. If the goal stalls again before `resetAfter` seconds, the wait doubles each time up to `maxInterval`. A stall later than `resetAfter` starts again at `minInterval`.
- While a goal is stalled, the banner retry (`continue`) is skipped for that agent. When the goal is not stalled, or the agent has no goal, the banner retry works as before.
- The plugin logs each status change, each resume, and each new wait reason. `HERDR_AUTO_RETRY_VERBOSE=1` adds per-scan details. `dryRun: true` logs the resume without sending it.
- The SQLite reader is `node:sqlite` when the Node runtime has it (Node 22.13+ / 23.4+). Otherwise the plugin runs the `sqlite3` CLI (`HERDR_AUTO_RETRY_SQLITE_BIN` sets its path). On Node 22 `node:sqlite` can print an `ExperimentalWarning` to the daemon log.

Configuration (`goalResume` in `config.json`, defaults shown):

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

| Key | Description | Default |
| --- | ----------- | ------- |
| `enabled` | Resume stalled codex goals | `true` |
| `prompt` | Text sent to resume a goal | `/goal resume` |
| `statuses` | Goal statuses that trigger a resume | `["blocked", "usage_limited"]` |
| `minInterval` | Minimum seconds between two resumes of one agent | `300` |
| `maxInterval` | Maximum backoff in seconds after repeated stalls | `1800` |
| `resetAfter` | A stall this many seconds after the last resume starts a new episode | `3600` |
| `codexHome` | Codex home directory | `$CODEX_HOME` or `~/.codex` |
| `rolloutTailBytes` | Bytes read from the end of the rollout file | `2097152` (2 MB) |
| `idleMarkers` / `busyMarkers` / `modalMarkers` | Screen text for idle composer / running turn / modal | see above |

---

## Standalone CLI Usage

The bundled CLI can also run directly outside Herdr:

```bash
# Start background daemon
./dist/index.js daemon --start

# Check status
./dist/index.js status

# Scan once
./dist/index.js scan

# Stop daemon
./dist/index.js daemon --stop
```

---

## Development

Requirements:
- Node.js 18+
- pnpm 9+

```bash
# Install dependencies
pnpm install

# Run type check
pnpm run typecheck

# Run unit tests
pnpm test

# Build bundle
pnpm run build
```

---

## License

MIT © [bestony](https://github.com/bestony)
