#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/config.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path = __toESM(require("path"));
var import_node_os = __toESM(require("os"));
var DEFAULT_MATCHES = [
  "Selected model is at capacity",
  "stream disconnected before completion: Our servers are currently overloaded",
  "exceeded retry limit, last status: 429 Too Many Requests"
];
var DEFAULT_PROMPT = "continue";
var DEFAULT_AGENTS = ["codex"];
var DEFAULT_MIN_WAIT = 15;
var DEFAULT_MAX_WAIT = 60;
var DEFAULT_MISS_RESET = 3;
var DEFAULT_STALE_AFTER = 600;
var DEFAULT_BUSY_INTERVAL = 5;
var DEFAULT_INTERVAL = 10;
var DEFAULT_IDLE_INTERVAL = 60;
var DEFAULT_WORKERS = 8;
function getPluginConfigDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  return import_node_path.default.join(import_node_os.default.homedir(), ".config", "herdr", "plugins", "config", "bestony.auto-retry");
}
function getPluginStateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  if (process.env.HERDR_CAPACITY_STATE_DIR) {
    return process.env.HERDR_CAPACITY_STATE_DIR;
  }
  return import_node_path.default.join(import_node_os.default.homedir(), ".local", "state", "herdr-auto-retry");
}
function parseEnvInt(name, fallback) {
  const val = process.env[name];
  if (!val) return fallback;
  const num = parseInt(val, 10);
  return isNaN(num) ? fallback : num;
}
function parseEnvList(name) {
  const val = process.env[name];
  if (!val) return null;
  const lines = val.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines : null;
}
function loadConfig(overrides = {}) {
  const configDir = getPluginConfigDir();
  const configFile = import_node_path.default.join(configDir, "config.json");
  let fileConfig = {};
  if (import_node_fs.default.existsSync(configFile)) {
    try {
      const content = import_node_fs.default.readFileSync(configFile, "utf8");
      fileConfig = JSON.parse(content);
    } catch (err) {
      console.error(`[config] failed to read ${configFile}:`, err);
    }
  }
  const matchesFromEnv = parseEnvList("HERDR_AUTO_RETRY_MATCH") || parseEnvList("HERDR_CAPACITY_MATCH");
  const agentsFromEnv = process.env.HERDR_AUTO_RETRY_AGENTS ? process.env.HERDR_AUTO_RETRY_AGENTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  return {
    agents: overrides.agents || agentsFromEnv || fileConfig.agents || DEFAULT_AGENTS,
    matches: overrides.matches || matchesFromEnv || fileConfig.matches || DEFAULT_MATCHES,
    prompt: overrides.prompt || process.env.HERDR_AUTO_RETRY_PROMPT || process.env.HERDR_CAPACITY_PROMPT || fileConfig.prompt || DEFAULT_PROMPT,
    minWait: overrides.minWait ?? parseEnvInt("HERDR_AUTO_RETRY_MIN_WAIT", parseEnvInt("HERDR_CAPACITY_MIN_WAIT", fileConfig.minWait ?? DEFAULT_MIN_WAIT)),
    maxWait: overrides.maxWait ?? parseEnvInt("HERDR_AUTO_RETRY_MAX_WAIT", parseEnvInt("HERDR_CAPACITY_MAX_WAIT", fileConfig.maxWait ?? DEFAULT_MAX_WAIT)),
    missReset: overrides.missReset ?? fileConfig.missReset ?? DEFAULT_MISS_RESET,
    staleAfter: overrides.staleAfter ?? fileConfig.staleAfter ?? DEFAULT_STALE_AFTER,
    intervals: {
      busy: overrides.intervals?.busy ?? parseEnvInt(
        "HERDR_AUTO_RETRY_BUSY_INTERVAL",
        parseEnvInt("HERDR_CAPACITY_BUSY_INTERVAL", fileConfig.intervals?.busy ?? DEFAULT_BUSY_INTERVAL)
      ),
      active: overrides.intervals?.active ?? parseEnvInt(
        "HERDR_AUTO_RETRY_INTERVAL",
        parseEnvInt("HERDR_CAPACITY_INTERVAL", fileConfig.intervals?.active ?? DEFAULT_INTERVAL)
      ),
      idle: overrides.intervals?.idle ?? parseEnvInt(
        "HERDR_AUTO_RETRY_IDLE_INTERVAL",
        parseEnvInt("HERDR_CAPACITY_IDLE_INTERVAL", fileConfig.intervals?.idle ?? DEFAULT_IDLE_INTERVAL)
      )
    },
    workers: overrides.workers ?? parseEnvInt("HERDR_AUTO_RETRY_WORKERS", parseEnvInt("HERDR_CAPACITY_WORKERS", fileConfig.workers ?? DEFAULT_WORKERS)),
    verbose: overrides.verbose ?? (process.env.HERDR_AUTO_RETRY_VERBOSE === "1" || process.env.HERDR_CAPACITY_VERBOSE === "1" || Boolean(fileConfig.verbose)),
    dryRun: overrides.dryRun ?? fileConfig.dryRun ?? false
  };
}

// src/watcher.ts
var import_node_fs2 = __toESM(require("fs"));
var import_node_path2 = __toESM(require("path"));

// src/types.ts
var ScanResult = class {
  present = 0;
  stuck = 0;
  get tier() {
    if (this.stuck > 0) return "busy";
    if (this.present > 0) return "active";
    return "idle";
  }
  describe() {
    return `${this.present} target(s) present, ${this.stuck} stuck (cadence: ${this.tier})`;
  }
};

// src/herdr.ts
var import_node_child_process = require("child_process");
var DEFAULT_TIMEOUT_MS = 1e4;
function getHerdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}
function runHerdr(args, options = {}) {
  const binary = getHerdrBinary();
  try {
    const result = (0, import_node_child_process.spawnSync)(binary, args, {
      encoding: "utf8",
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    if (result.error) {
      return {
        status: result.error.code === "ENOENT" ? 127 : 1,
        stdout: "",
        stderr: result.error.message
      };
    }
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (err) {
    return {
      status: 1,
      stdout: "",
      stderr: err?.message || String(err)
    };
  }
}
function herdrJson(args) {
  const res = runHerdr(args);
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    if (err && process.env.HERDR_AUTO_RETRY_VERBOSE) {
      console.error(`[herdr] ${args.join(" ")} failed: ${err.slice(0, 300)}`);
    }
    return null;
  }
  const text = res.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    if (process.env.HERDR_AUTO_RETRY_VERBOSE) {
      console.error(`[herdr] invalid JSON from ${args.join(" ")}: ${err}`);
    }
    return null;
  }
}
function listAgents() {
  const data = herdrJson(["agent", "list"]);
  if (!data?.result?.agents || !Array.isArray(data.result.agents)) {
    return [];
  }
  return data.result.agents;
}
function getAgent(target) {
  const data = herdrJson(["agent", "get", target]);
  return data?.result?.agent ?? null;
}
function readTail(target) {
  const sources = [
    ["detection", "60"],
    ["recent-unwrapped", "80"]
  ];
  for (const [source, lines] of sources) {
    const res = runHerdr(["agent", "read", target, "--source", source, "--lines", lines]);
    if (res.status === 0) {
      return res.stdout || "";
    }
  }
  return null;
}
function sendPrompt(target, text) {
  const res = runHerdr(["agent", "send", target, text]);
  return res.status === 0;
}

// src/watcher.ts
var SETTLED = /* @__PURE__ */ new Set([
  "idle",
  "done",
  "blocked",
  "unknown"
]);
function flatten(text) {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
function findMatch(haystack, patterns) {
  const flat = flatten(haystack);
  for (const pattern of patterns) {
    if (flat.includes(flatten(pattern))) {
      return pattern;
    }
  }
  return null;
}
function backoffSeconds(hitCount, minWait, maxWait) {
  const exp = Math.min(hitCount, 6);
  const wait = minWait * 2 ** exp;
  return Math.min(wait, maxWait);
}
var StateStore = class {
  cache = /* @__PURE__ */ new Map();
  filePath;
  constructor(stateDir) {
    const dir = stateDir || getPluginStateDir();
    import_node_fs2.default.mkdirSync(dir, { recursive: true });
    this.filePath = import_node_path2.default.join(dir, "state.json");
    this.load();
  }
  load() {
    if (!import_node_fs2.default.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(import_node_fs2.default.readFileSync(this.filePath, "utf8"));
      if (typeof data === "object" && data !== null) {
        for (const [k, v] of Object.entries(data)) {
          this.cache.set(k, v);
        }
      }
    } catch (err) {
      console.error(`[state] failed to read ${this.filePath}:`, err);
    }
  }
  save() {
    try {
      const obj = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      import_node_fs2.default.writeFileSync(this.filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
    } catch (err) {
      console.error(`[state] failed to write ${this.filePath}:`, err);
    }
  }
  get(target) {
    if (!this.cache.has(target)) {
      this.cache.set(target, {
        first_seen_at: 0,
        last_match_at: 0,
        miss_count: 0,
        hit_count: 0,
        next_retry_at: 0
      });
    }
    return this.cache.get(target);
  }
  set(target, state) {
    this.cache.set(target, state);
    this.save();
  }
  getAll() {
    return new Map(this.cache);
  }
};
async function processTarget(target, config, store, nowSec = Date.now() / 1e3) {
  const agent = getAgent(target);
  const state = store.get(target);
  const configuredAgents = config.agents.map((a) => a.toLowerCase());
  const agentType = (agent?.agent || agent?.display_agent || "").toLowerCase();
  if (!agent || configuredAgents.length > 0 && !configuredAgents.includes(agentType)) {
    if (state.first_seen_at > 0) {
      state.first_seen_at = 0;
      state.miss_count = 0;
      store.set(target, state);
    }
    return "absent" /* ABSENT */;
  }
  const rawStatus = (agent.agent_status || agent.status || "unknown").toLowerCase();
  if (!SETTLED.has(rawStatus)) {
    if (state.first_seen_at > 0) {
      state.miss_count += 1;
      store.set(target, state);
    }
    return "present" /* PRESENT */;
  }
  const tail = readTail(target);
  if (tail === null) {
    return state.first_seen_at > 0 ? "stuck" /* STUCK */ : "present" /* PRESENT */;
  }
  const matchedPattern = findMatch(tail, config.matches);
  if (matchedPattern) {
    state.miss_count = 0;
    const isStale = state.first_seen_at > 0 && nowSec - state.last_match_at > config.staleAfter;
    if (isStale || state.first_seen_at === 0) {
      state.first_seen_at = nowSec;
      state.hit_count = 0;
      const initialWait = backoffSeconds(0, config.minWait, config.maxWait);
      state.next_retry_at = nowSec + initialWait;
      console.log(
        `[${target}] capacity error detected: ${JSON.stringify(matchedPattern)}; initial wait ${initialWait}s`
      );
    }
    state.last_match_at = nowSec;
    state.last_matched_pattern = matchedPattern;
    if (nowSec >= state.next_retry_at) {
      state.hit_count += 1;
      const nextWait = backoffSeconds(
        state.hit_count,
        config.minWait,
        config.maxWait
      );
      state.next_retry_at = nowSec + nextWait;
      state.last_retry_at = nowSec;
      state.total_retries = (state.total_retries || 0) + 1;
      if (!config.dryRun) {
        console.log(
          `[${target}] retrying with prompt "${config.prompt}" (attempt ${state.hit_count}, next backoff ${nextWait}s)`
        );
        sendPrompt(target, config.prompt);
      } else {
        console.log(
          `[${target}] [dry-run] would send "${config.prompt}" (attempt ${state.hit_count})`
        );
      }
    } else if (config.verbose) {
      const remaining = Math.max(0, Math.round(state.next_retry_at - nowSec));
      console.log(
        `[${target}] waiting out backoff (${remaining}s remaining before attempt ${state.hit_count + 1})`
      );
    }
    store.set(target, state);
    return "stuck" /* STUCK */;
  } else {
    if (state.first_seen_at > 0) {
      state.miss_count += 1;
      if (state.miss_count >= config.missReset) {
        console.log(
          `[${target}] capacity episode cleared after ${state.hit_count} retry attempt(s)`
        );
        state.first_seen_at = 0;
        state.hit_count = 0;
        state.miss_count = 0;
        state.next_retry_at = 0;
      } else if (config.verbose) {
        console.log(
          `[${target}] banner not visible (${state.miss_count}/${config.missReset} misses)`
        );
      }
      store.set(target, state);
      return state.first_seen_at > 0 ? "stuck" /* STUCK */ : "present" /* PRESENT */;
    }
    return "present" /* PRESENT */;
  }
}
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e = p.then(() => {
        executing.splice(executing.indexOf(e), 1);
      });
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}
async function scanOnce(config, store, targetList) {
  const result = new ScanResult();
  let targets = targetList;
  if (!targets || targets.length === 0) {
    const agents = listAgents();
    const configured = config.agents.map((a) => a.toLowerCase());
    targets = agents.filter((a) => {
      const type = (a.agent || a.display_agent || "").toLowerCase();
      return configured.length === 0 || configured.includes(type);
    }).map((a) => a.name || a.pane_id).filter(Boolean);
  }
  if (targets.length === 0) {
    return result;
  }
  const workers = Math.max(1, Math.min(config.workers, targets.length));
  const nowSec = Date.now() / 1e3;
  const outcomes = await asyncPool(workers, targets, async (target) => {
    try {
      return await processTarget(target, config, store, nowSec);
    } catch (err) {
      console.error(`[watcher] error processing ${target}:`, err);
      return "stuck" /* STUCK */;
    }
  });
  for (const outcome of outcomes) {
    if (outcome === "stuck" /* STUCK */) {
      result.stuck += 1;
    } else if (outcome === "present" /* PRESENT */) {
      result.present += 1;
    }
  }
  return result;
}

// src/daemon.ts
var import_node_fs3 = __toESM(require("fs"));
var import_node_path3 = __toESM(require("path"));
var import_node_child_process2 = require("child_process");
function getPidFile() {
  const dir = getPluginStateDir();
  import_node_fs3.default.mkdirSync(dir, { recursive: true });
  return import_node_path3.default.join(dir, "daemon.pid");
}
function getLogFile() {
  const dir = getPluginStateDir();
  import_node_fs3.default.mkdirSync(dir, { recursive: true });
  return import_node_path3.default.join(dir, "daemon.log");
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}
function getRunningPid() {
  const pidFile = getPidFile();
  if (!import_node_fs3.default.existsSync(pidFile)) return null;
  try {
    const raw = import_node_fs3.default.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && isPidAlive(pid)) {
      return pid;
    }
    try {
      import_node_fs3.default.unlinkSync(pidFile);
    } catch {
    }
    return null;
  } catch {
    return null;
  }
}
function startDaemon(entryPath) {
  const existingPid = getRunningPid();
  if (existingPid !== null) {
    return { started: false, pid: existingPid };
  }
  const logFile = getLogFile();
  const logFd = import_node_fs3.default.openSync(logFile, "a");
  const child = (0, import_node_child_process2.spawn)(process.execPath, [entryPath, "daemon", "--run"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env }
  });
  const pid = child.pid;
  child.unref();
  import_node_fs3.default.writeFileSync(getPidFile(), String(pid), "utf8");
  return { started: true, pid };
}
function stopDaemon() {
  const pid = getRunningPid();
  if (pid === null) {
    return { stopped: false };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
  }
  const pidFile = getPidFile();
  try {
    import_node_fs3.default.unlinkSync(pidFile);
  } catch {
  }
  return { stopped: true, pid };
}
async function runDaemonLoop(config, store) {
  const pid = process.pid;
  import_node_fs3.default.writeFileSync(getPidFile(), String(pid), "utf8");
  let shouldExit = false;
  const onSignal = () => {
    shouldExit = true;
    console.log(`[daemon] received shutdown signal; stopping`);
    try {
      import_node_fs3.default.unlinkSync(getPidFile());
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  console.log(
    `[daemon] auto-retry daemon started (PID: ${pid}, intervals: busy=${config.intervals.busy}s, active=${config.intervals.active}s, idle=${config.intervals.idle}s)`
  );
  let currentTier = null;
  while (!shouldExit) {
    let result;
    try {
      result = await scanOnce(config, store);
    } catch (err) {
      console.error("[daemon] scan failed:", err);
      result = { tier: "active", describe: () => "scan error fallback" };
    }
    const tier = result.tier;
    const delaySec = tier === "busy" ? config.intervals.busy : tier === "active" ? config.intervals.active : config.intervals.idle;
    if (tier !== currentTier) {
      currentTier = tier;
      console.log(`[daemon] cadence -> ${tier} (${delaySec}s): ${result.describe()}`);
    } else if (config.verbose) {
      console.log(`[daemon] ${result.describe()}; next scan in ${delaySec}s (${tier})`);
    }
    await new Promise((resolve) => setTimeout(resolve, delaySec * 1e3));
  }
}

// src/dashboard.ts
var import_node_fs4 = __toESM(require("fs"));
var import_node_path4 = __toESM(require("path"));
function renderStatus(config, store) {
  const pid = getRunningPid();
  const isRunning = pid !== null;
  const lines = [];
  lines.push("==================================================");
  lines.push("            HERDR AUTO-RETRY MONITOR              ");
  lines.push("==================================================");
  lines.push(`Daemon Status : ${isRunning ? `RUNNING (PID ${pid})` : "STOPPED"}`);
  lines.push(`Monitored Agents: ${config.agents.join(", ")}`);
  lines.push(`Prompt Text   : "${config.prompt}"`);
  lines.push(`Backoff Range : ${config.minWait}s -> ${config.maxWait}s`);
  lines.push(
    `Cadence       : busy=${config.intervals.busy}s, active=${config.intervals.active}s, idle=${config.intervals.idle}s`
  );
  lines.push("--------------------------------------------------");
  const agents = listAgents();
  const configured = config.agents.map((a) => a.toLowerCase());
  const matchedAgents = agents.filter((a) => {
    const type = (a.agent || a.display_agent || "").toLowerCase();
    return configured.length === 0 || configured.includes(type);
  });
  lines.push(`Active Agents in Herdr (${matchedAgents.length}):`);
  if (matchedAgents.length === 0) {
    lines.push("  (no matching agents currently detected)");
  } else {
    for (const a of matchedAgents) {
      const target = a.name || a.pane_id;
      const state = store.get(target);
      const status = a.agent_status || a.status || "unknown";
      const isStuck = state.first_seen_at > 0;
      const nowSec = Date.now() / 1e3;
      const nextIn = isStuck ? Math.max(0, Math.round(state.next_retry_at - nowSec)) : 0;
      lines.push(
        `  * ${target} [${a.agent || "agent"}] (${status}) - ${isStuck ? `STUCK (retries: ${state.hit_count}, next in ${nextIn}s)` : "HEALTHY"}`
      );
      if (isStuck && state.last_matched_pattern) {
        lines.push(`    Banner: "${state.last_matched_pattern}"`);
      }
    }
  }
  lines.push("--------------------------------------------------");
  const logFile = import_node_path4.default.join(getPluginStateDir(), "daemon.log");
  if (import_node_fs4.default.existsSync(logFile)) {
    try {
      const logs = import_node_fs4.default.readFileSync(logFile, "utf8").trim().split("\n");
      const recent = logs.slice(-8);
      lines.push("Recent Daemon Log Entries:");
      for (const logLine of recent) {
        lines.push(`  ${logLine}`);
      }
    } catch {
    }
  }
  lines.push("==================================================");
  return lines.join("\n");
}
function runDashboard(config, store) {
  process.stdout.write("\x1B[2J\x1B[H");
  console.log(renderStatus(config, store));
  console.log("\nPress Ctrl+C to close.");
  const interval = setInterval(() => {
    process.stdout.write("\x1B[H");
    console.log(renderStatus(config, store));
    console.log("\nPress Ctrl+C to close.");
  }, 2e3);
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

// src/index.ts
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "";
  if (process.env.HERDR_PLUGIN_EVENT === "startup" || command === "startup") {
    const res = startDaemon(__filename);
    if (res.started) {
      console.log(`[auto-retry] started background daemon (PID: ${res.pid})`);
    } else {
      console.log(`[auto-retry] background daemon already active (PID: ${res.pid})`);
    }
    return;
  }
  const config = loadConfig();
  const store = new StateStore();
  switch (command) {
    case "daemon": {
      const sub = args[1];
      if (sub === "--start" || sub === "start") {
        const res = startDaemon(__filename);
        if (res.started) {
          console.log(`Started auto-retry daemon (PID: ${res.pid})`);
        } else {
          console.log(`Auto-retry daemon already running (PID: ${res.pid})`);
        }
      } else if (sub === "--stop" || sub === "stop") {
        const res = stopDaemon();
        if (res.stopped) {
          console.log(`Stopped auto-retry daemon (PID: ${res.pid})`);
        } else {
          console.log("Auto-retry daemon is not running.");
        }
      } else if (sub === "--run" || sub === "run") {
        await runDaemonLoop(config, store);
      } else {
        console.log("Usage: herdr-auto-retry daemon [--start | --stop | --run]");
      }
      break;
    }
    case "scan": {
      const targets = args.slice(1).filter((t) => !t.startsWith("-"));
      console.log(`Scanning targets for capacity/rate-limit errors...`);
      const result = await scanOnce(config, store, targets.length > 0 ? targets : void 0);
      console.log(`Scan completed: ${result.describe()}`);
      break;
    }
    case "status": {
      console.log(renderStatus(config, store));
      break;
    }
    case "dashboard": {
      runDashboard(config, store);
      break;
    }
    case "--help":
    case "-h":
    case "help": {
      console.log(`herdr-auto-retry v0.1.0 (Plugin ID: bestony.auto-retry)

Auto-continue Herdr agents when rate-limited, overloaded, or at capacity.

Commands:
  daemon --start     Start the background watcher daemon
  daemon --stop      Stop the background watcher daemon
  daemon --run       Run the watcher loop in foreground
  scan [targets...]  Scan targets once and retry immediately if stuck
  status             Show daemon state, tracked agents, and retry stats
  dashboard          Open live monitor view (used by popup pane)

Configuration:
  Settings can be configured in ~/.config/herdr/plugins/config/bestony.auto-retry/config.json
  or through environment variables (HERDR_AUTO_RETRY_*).
`);
      break;
    }
    default: {
      if (command) {
        const targets = args.filter((t) => !t.startsWith("-"));
        console.log(`Scanning specified targets: ${targets.join(", ")}`);
        const result = await scanOnce(config, store, targets);
        console.log(`Scan completed: ${result.describe()}`);
      } else {
        console.log(renderStatus(config, store));
      }
      break;
    }
  }
}
main().catch((err) => {
  console.error("[auto-retry] unhandled error:", err);
  process.exit(1);
});
