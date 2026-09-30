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

`herdr-auto-retry` is an official Herdr plugin that watches your agent panes, detects capacity errors with debounce protection, calculates exponential backoff, and automatically submits a `continue` prompt.

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
    "stream disconnected before completion: Our servers are currently overloaded"
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
