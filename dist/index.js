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
var import_node_fs2 = __toESM(require("fs"));
var import_node_path2 = __toESM(require("path"));
var import_node_os2 = __toESM(require("os"));

// src/text.ts
function flatten(text) {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

// src/codex-goal.ts
var NEVER_RESUME = /* @__PURE__ */ new Set(["active", "complete"]);
var DELIBERATE_STATUSES = /* @__PURE__ */ new Set(["paused", "budget_limited"]);
var TURN_EVENTS = /* @__PURE__ */ new Set([
  "task_started",
  "task_complete",
  "turn_aborted"
]);
function normalizeStatus(status) {
  return status.trim().toLowerCase();
}
function isResumableStatus(status, configured) {
  const s = normalizeStatus(status);
  if (NEVER_RESUME.has(s)) return false;
  return configured.some((c) => normalizeStatus(c) === s);
}
function containsAny(flatLower, markers) {
  return markers.some((m) => {
    const needle = flatten(m).toLowerCase();
    return needle.length > 0 && flatLower.includes(needle);
  });
}
function classifyScreen(screen, config) {
  if (screen === null) return "unreadable";
  const flat = flatten(screen).toLowerCase();
  if (containsAny(flat, config.modalMarkers)) return "modal";
  if (containsAny(flat, config.busyMarkers)) return "busy";
  if (!containsAny(flat, config.idleMarkers)) return "no-composer";
  return "idle";
}
function parseLastTurnEvent(chunk, startsMidLine) {
  const lines = chunk.split("\n");
  if (startsMidLine) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("event_msg")) continue;
    if (!line.includes("task_started") && !line.includes("task_complete") && !line.includes("turn_aborted")) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const type = record?.payload?.type;
    if (typeof type === "string" && TURN_EVENTS.has(type)) {
      return type;
    }
  }
  return null;
}
function goalBackoffSeconds(attempt, minInterval, maxInterval) {
  const exp = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(minInterval * 2 ** exp, Math.max(maxInterval, minInterval));
}
function decideGoalResume(input) {
  const { goal, lastTurnEvent, screen, history, nowSec, config } = input;
  if (!config.enabled) return { action: "skip", reason: "disabled", stalled: false };
  if (goal.kind === "none") return { action: "skip", reason: "no-goal", stalled: false };
  if (goal.kind === "error") return { action: "skip", reason: "goal-unavailable", stalled: false };
  if (!isResumableStatus(goal.status, config.statuses)) {
    return { action: "skip", reason: "status-not-resumable", stalled: false };
  }
  if (lastTurnEvent === null) return { action: "skip", reason: "turn-unknown", stalled: true };
  if (lastTurnEvent === "task_started") {
    return { action: "skip", reason: "turn-in-progress", stalled: true };
  }
  if (lastTurnEvent === "turn_aborted") {
    return { action: "skip", reason: "turn-aborted", stalled: true };
  }
  const screenState = classifyScreen(screen, config);
  if (screenState !== "idle") {
    const reason = screenState === "unreadable" ? "screen-unreadable" : screenState === "busy" ? "screen-busy" : screenState === "modal" ? "screen-modal" : "screen-no-composer";
    return { action: "skip", reason, stalled: true };
  }
  const nextAllowed = history.next_goal_resume_at ?? 0;
  if (nowSec < nextAllowed) {
    return {
      action: "skip",
      reason: "rate-limited",
      stalled: true,
      remaining: Math.max(0, Math.round(nextAllowed - nowSec))
    };
  }
  const last = history.last_goal_resume_at ?? 0;
  const fresh = last === 0 || nowSec - last > config.resetAfter;
  const attempt = fresh ? 1 : (history.goal_resume_count ?? 0) + 1;
  const backoff = goalBackoffSeconds(attempt, config.minInterval, config.maxInterval);
  return { action: "resume", attempt, nextAllowedAt: nowSec + backoff, backoff };
}

// src/codex-store.ts
var import_node_fs = __toESM(require("fs"));
var import_node_os = __toESM(require("os"));
var import_node_path = __toESM(require("path"));
var import_node_child_process = require("child_process");
var import_node_url = require("url");
var GOAL_DB_FILE = "goals_1.sqlite";
var DEFAULT_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
var SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
var GOAL_SQL = "SELECT status FROM thread_goals WHERE thread_id = ?";
function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".codex");
}
function isValidSessionId(id) {
  return SESSION_ID_RE.test(id);
}
function goalDbUris(dbPath) {
  const base = (0, import_node_url.pathToFileURL)(dbPath).href;
  return [
    { uri: `${base}?mode=ro`, source: "ro" },
    { uri: `${base}?mode=ro&immutable=1`, source: "immutable" }
  ];
}
function errorMessage(err) {
  return err?.message ? String(err.message) : String(err);
}
function lookupGoalStatus(dbPath, threadId, query = defaultSqliteQuery, exists = import_node_fs.default.existsSync) {
  if (!isValidSessionId(threadId)) {
    return { kind: "error", error: `invalid session id ${JSON.stringify(threadId)}` };
  }
  if (!exists(dbPath)) {
    return { kind: "error", error: `goal database not found: ${dbPath}` };
  }
  const errors = [];
  for (const { uri, source } of goalDbUris(dbPath)) {
    try {
      const rows = query(uri, GOAL_SQL, threadId);
      const status = rows[0]?.status;
      if (typeof status !== "string" || status === "") return { kind: "none" };
      return { kind: "found", status, source };
    } catch (err) {
      errors.push(`${source}: ${errorMessage(err)}`);
    }
  }
  return { kind: "error", error: errors.join("; ") };
}
var nodeSqliteCache;
function loadNodeSqlite() {
  if (nodeSqliteCache !== void 0) return nodeSqliteCache;
  nodeSqliteCache = null;
  try {
    const getBuiltin = process.getBuiltinModule;
    const mod = getBuiltin?.("node:sqlite");
    if (mod?.DatabaseSync) nodeSqliteCache = mod;
  } catch {
  }
  return nodeSqliteCache;
}
function nodeSqliteQuery(uri, sql, param) {
  const mod = loadNodeSqlite();
  if (!mod) throw new Error("node:sqlite is not available");
  const db = new mod.DatabaseSync(uri, { readOnly: true });
  try {
    return db.prepare(sql).all(param);
  } finally {
    db.close();
  }
}
function cliSqliteQuery(uri, sql, param) {
  if (!isValidSessionId(param)) throw new Error("refusing to inline an unsafe parameter");
  const inlined = sql.replace("?", `'${param}'`);
  const res = (0, import_node_child_process.spawnSync)(process.env.HERDR_AUTO_RETRY_SQLITE_BIN || "sqlite3", ["-json", uri, inlined], {
    encoding: "utf8",
    timeout: 5e3,
    windowsHide: true
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `sqlite3 exited ${res.status}`).trim().slice(0, 300));
  }
  const out = (res.stdout || "").trim();
  if (!out) return [];
  return JSON.parse(out);
}
function defaultSqliteQuery(uri, sql, param) {
  return loadNodeSqlite() ? nodeSqliteQuery(uri, sql, param) : cliSqliteQuery(uri, sql, param);
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function dayDir(sessionsDir, d, utc) {
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utc ? d.getUTCDate() : d.getDate();
  return import_node_path.default.join(sessionsDir, String(y), pad2(m), pad2(day));
}
function uuidV7Millis(id) {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || hex[12] !== "7") return null;
  const ms = parseInt(hex.slice(0, 12), 16);
  if (ms < 15778368e5 || ms > Date.now() + 864e5) return null;
  return ms;
}
function findInDir(dir, suffix) {
  let names;
  try {
    names = import_node_fs.default.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
  return hit ? import_node_path.default.join(dir, hit) : null;
}
function listDesc(dir) {
  try {
    return import_node_fs.default.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
}
function findRolloutFile(codexHome, sessionId, cache = rolloutPathCache) {
  const cached = cache.get(sessionId);
  if (cached && import_node_fs.default.existsSync(cached)) return cached;
  cache.delete(sessionId);
  if (!isValidSessionId(sessionId)) return null;
  const sessionsDir = import_node_path.default.join(codexHome, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  const tried = /* @__PURE__ */ new Set();
  const ms = uuidV7Millis(sessionId);
  if (ms !== null) {
    for (const offset of [0, -864e5, 864e5]) {
      const d = new Date(ms + offset);
      for (const utc of [false, true]) {
        const dir = dayDir(sessionsDir, d, utc);
        if (tried.has(dir)) continue;
        tried.add(dir);
        const hit = findInDir(dir, suffix);
        if (hit) {
          cache.set(sessionId, hit);
          return hit;
        }
      }
    }
  }
  for (const y of listDesc(sessionsDir)) {
    for (const m of listDesc(import_node_path.default.join(sessionsDir, y))) {
      for (const d of listDesc(import_node_path.default.join(sessionsDir, y, m))) {
        const dir = import_node_path.default.join(sessionsDir, y, m, d);
        if (tried.has(dir)) continue;
        const hit = findInDir(dir, suffix);
        if (hit) {
          cache.set(sessionId, hit);
          return hit;
        }
      }
    }
  }
  return null;
}
var rolloutPathCache = /* @__PURE__ */ new Map();
function readFileTail(file, maxBytes) {
  const fd = import_node_fs.default.openSync(file, "r");
  try {
    const size = import_node_fs.default.fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, maxBytes));
    const length = size - start;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = import_node_fs.default.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString("utf8"), startsMidLine: start > 0 };
  } finally {
    import_node_fs.default.closeSync(fd);
  }
}
function readLastTurnEvent(file, maxBytes) {
  const { text, startsMidLine } = readFileTail(file, maxBytes);
  return parseLastTurnEvent(text, startsMidLine);
}

// src/config.ts
var DEFAULT_MATCHES = [
  "Selected model is at capacity",
  "stream disconnected before completion: Our servers are currently overloaded",
  "exceeded retry limit, last status: 429 Too Many Requests",
  "429 Too Many Requests"
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
var DEFAULT_GOAL_RESUME_PROMPT = "/goal resume";
var DEFAULT_GOAL_RESUME_STATUSES = ["blocked", "usage_limited"];
var DEFAULT_GOAL_MIN_INTERVAL = 300;
var DEFAULT_GOAL_MAX_INTERVAL = 1800;
var DEFAULT_GOAL_RESET_AFTER = 3600;
var DEFAULT_GOAL_IDLE_MARKERS = ["Ask Codex to do anything"];
var DEFAULT_GOAL_BUSY_MARKERS = ["Working ("];
var DEFAULT_GOAL_MODAL_MARKERS = [
  "Replace goal?",
  "Press enter to confirm",
  "enter to confirm",
  "esc to cancel",
  "Would you like to run the following command",
  "Would you like to make the following edits",
  "Allow command",
  "Do you trust the files in this folder"
];
function getPluginConfigDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  return import_node_path2.default.join(import_node_os2.default.homedir(), ".config", "herdr", "plugins", "config", "bestony.auto-retry");
}
function getPluginStateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  if (process.env.HERDR_CAPACITY_STATE_DIR) {
    return process.env.HERDR_CAPACITY_STATE_DIR;
  }
  return import_node_path2.default.join(import_node_os2.default.homedir(), ".local", "state", "herdr-auto-retry");
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
function parseEnvBool(name) {
  const val = process.env[name];
  if (val === void 0 || val === "") return null;
  return !["0", "false", "no", "off"].includes(val.trim().toLowerCase());
}
function parseEnvCsv(name) {
  const val = process.env[name];
  if (!val) return null;
  const items = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length > 0 ? items : null;
}
function expandHome(p) {
  if (p === "~") return import_node_os2.default.homedir();
  if (p.startsWith("~/")) return import_node_path2.default.join(import_node_os2.default.homedir(), p.slice(2));
  return p;
}
function loadGoalResumeConfig(file = {}, overrides = {}) {
  const statuses = (overrides.statuses || parseEnvCsv("HERDR_AUTO_RETRY_GOAL_STATUSES") || file.statuses || DEFAULT_GOAL_RESUME_STATUSES).map((s) => s.trim().toLowerCase());
  const deliberate = statuses.filter((s) => DELIBERATE_STATUSES.has(s));
  if (deliberate.length > 0) {
    console.warn(
      `[config] goalResume.statuses includes ${deliberate.join(", ")}; goals paused by a human or by a budget will be resumed`
    );
  }
  const minInterval = overrides.minInterval ?? parseEnvInt("HERDR_AUTO_RETRY_GOAL_MIN_INTERVAL", file.minInterval ?? DEFAULT_GOAL_MIN_INTERVAL);
  return {
    enabled: overrides.enabled ?? parseEnvBool("HERDR_AUTO_RETRY_GOAL_RESUME") ?? file.enabled ?? true,
    prompt: overrides.prompt || process.env.HERDR_AUTO_RETRY_GOAL_PROMPT || file.prompt || DEFAULT_GOAL_RESUME_PROMPT,
    statuses,
    minInterval: Math.max(1, minInterval),
    maxInterval: overrides.maxInterval ?? parseEnvInt("HERDR_AUTO_RETRY_GOAL_MAX_INTERVAL", file.maxInterval ?? DEFAULT_GOAL_MAX_INTERVAL),
    resetAfter: overrides.resetAfter ?? file.resetAfter ?? DEFAULT_GOAL_RESET_AFTER,
    codexHome: expandHome(overrides.codexHome || file.codexHome || defaultCodexHome()),
    rolloutTailBytes: overrides.rolloutTailBytes ?? file.rolloutTailBytes ?? DEFAULT_ROLLOUT_TAIL_BYTES,
    idleMarkers: overrides.idleMarkers || file.idleMarkers || DEFAULT_GOAL_IDLE_MARKERS,
    busyMarkers: overrides.busyMarkers || file.busyMarkers || DEFAULT_GOAL_BUSY_MARKERS,
    modalMarkers: overrides.modalMarkers || file.modalMarkers || DEFAULT_GOAL_MODAL_MARKERS
  };
}
function loadConfig(overrides = {}) {
  const configDir = getPluginConfigDir();
  const configFile = import_node_path2.default.join(configDir, "config.json");
  let fileConfig = {};
  if (import_node_fs2.default.existsSync(configFile)) {
    try {
      const content = import_node_fs2.default.readFileSync(configFile, "utf8");
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
    dryRun: overrides.dryRun ?? fileConfig.dryRun ?? false,
    goalResume: loadGoalResumeConfig(fileConfig.goalResume, overrides.goalResume)
  };
}

// src/watcher.ts
var import_node_fs3 = __toESM(require("fs"));
var import_node_path3 = __toESM(require("path"));

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
var import_node_child_process2 = require("child_process");
var DEFAULT_TIMEOUT_MS = 1e4;
function getHerdrBinary() {
  return process.env.HERDR_BIN_PATH || "herdr";
}
function runHerdr(args, options = {}) {
  const binary = getHerdrBinary();
  try {
    const result = (0, import_node_child_process2.spawnSync)(binary, args, {
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
function readVisible(target) {
  const res = runHerdr(["agent", "read", target, "--source", "visible"]);
  return res.status === 0 ? res.stdout || "" : null;
}
function sendPrompt(target, text) {
  const res = runHerdr(["agent", "prompt", target, text]);
  if (res.status === 0) {
    return { ok: true, status: 0, error: "" };
  }
  const error = (res.stderr || res.stdout || "").trim().slice(0, 300);
  return { ok: false, status: res.status, error };
}

// src/watcher.ts
var SETTLED = /* @__PURE__ */ new Set([
  "idle",
  "done",
  "unknown"
]);
function findMatch(haystack, patterns) {
  const flat = flatten(haystack).toLowerCase();
  for (const pattern of patterns) {
    if (flat.includes(flatten(pattern).toLowerCase())) {
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
    import_node_fs3.default.mkdirSync(dir, { recursive: true });
    this.filePath = import_node_path3.default.join(dir, "state.json");
    this.load();
  }
  load() {
    if (!import_node_fs3.default.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(import_node_fs3.default.readFileSync(this.filePath, "utf8"));
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
      import_node_fs3.default.writeFileSync(this.filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
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
function defaultGoalIO(config) {
  const { codexHome, rolloutTailBytes } = config.goalResume;
  return {
    lookupGoal: (sessionId) => lookupGoalStatus(import_node_path3.default.join(codexHome, GOAL_DB_FILE), sessionId),
    lastTurnEvent: (sessionId) => {
      const file = findRolloutFile(codexHome, sessionId);
      if (!file) {
        if (config.verbose) console.log(`[goal] no rollout file for session ${sessionId}`);
        return null;
      }
      try {
        return readLastTurnEvent(file, rolloutTailBytes);
      } catch (err) {
        console.error(`[goal] failed to read rollout ${file}: ${err?.message || err}`);
        return null;
      }
    },
    readScreen: readVisible,
    send: sendPrompt
  };
}
function processGoal(target, agent, state, config, store, nowSec, io = defaultGoalIO(config)) {
  const gc = config.goalResume;
  const sessionId = agent.agent_session?.value;
  if (!sessionId) {
    if (config.verbose) console.log(`[${target}] goal: no codex session id; skipping goal check`);
    return null;
  }
  const goal = io.lookupGoal(sessionId);
  if (goal.kind === "error") {
    if (state.last_goal_skip_reason !== "goal-unavailable") {
      console.error(`[${target}] goal: cannot read goal status: ${goal.error}`);
      state.last_goal_skip_reason = "goal-unavailable";
      store.set(target, state);
    }
    return null;
  }
  const status = goal.kind === "found" ? goal.status : void 0;
  if (status !== state.last_goal_status) {
    if (status !== void 0 || state.last_goal_status !== void 0) {
      console.log(`[${target}] goal status: ${state.last_goal_status ?? "none"} -> ${status ?? "none"}`);
    }
    state.last_goal_status = status;
    store.set(target, state);
  }
  if (goal.kind === "found" && goal.source !== "ro" && config.verbose) {
    console.log(`[${target}] goal: status read via ${goal.source} fallback (may lag the WAL)`);
  }
  if (status === void 0 || !isResumableStatus(status, gc.statuses)) {
    if (state.last_goal_skip_reason !== void 0) {
      state.last_goal_skip_reason = void 0;
      store.set(target, state);
    }
    return null;
  }
  const lastTurnEvent = io.lastTurnEvent(sessionId);
  const screen = lastTurnEvent === "task_complete" ? io.readScreen(target) : null;
  const decision = decideGoalResume({
    goal,
    lastTurnEvent,
    screen,
    history: state,
    nowSec,
    config: gc
  });
  if (decision.action === "skip") {
    const detail = decision.reason === "rate-limited" ? ` (${decision.remaining}s until next resume)` : "";
    if (decision.reason !== state.last_goal_skip_reason) {
      console.log(`[${target}] goal ${status}: waiting (${decision.reason})${detail}`);
      state.last_goal_skip_reason = decision.reason;
      store.set(target, state);
    } else if (config.verbose) {
      console.log(`[${target}] goal ${status}: still waiting (${decision.reason})${detail}`);
    }
    return decision.stalled ? "stuck" /* STUCK */ : null;
  }
  state.last_goal_resume_at = nowSec;
  state.next_goal_resume_at = decision.nextAllowedAt;
  state.goal_resume_count = decision.attempt;
  state.total_goal_resumes = (state.total_goal_resumes || 0) + 1;
  state.last_goal_skip_reason = void 0;
  store.set(target, state);
  if (config.dryRun) {
    console.log(
      `[${target}] [dry-run] goal ${status}: would send "${gc.prompt}" (attempt ${decision.attempt}, next allowed in ${decision.backoff}s)`
    );
    return "stuck" /* STUCK */;
  }
  console.log(
    `[${target}] goal ${status}: sending "${gc.prompt}" (attempt ${decision.attempt}, next allowed in ${decision.backoff}s)`
  );
  const sent = io.send(target, gc.prompt);
  if (!sent.ok) {
    console.error(`[${target}] goal: failed to send "${gc.prompt}" (exit ${sent.status}): ${sent.error || "no output"}`);
  }
  return "stuck" /* STUCK */;
}
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
  if (agentType === "codex" && config.goalResume.enabled) {
    const goalOutcome = processGoal(target, agent, state, config, store, nowSec);
    if (goalOutcome !== null) return goalOutcome;
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
        const sent = sendPrompt(target, config.prompt);
        if (!sent.ok) {
          console.error(
            `[${target}] failed to send prompt (exit ${sent.status}): ${sent.error || "no output"}`
          );
        }
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
var import_node_fs4 = __toESM(require("fs"));
var import_node_path4 = __toESM(require("path"));
var import_node_child_process3 = require("child_process");
function getPidFile() {
  const dir = getPluginStateDir();
  import_node_fs4.default.mkdirSync(dir, { recursive: true });
  return import_node_path4.default.join(dir, "daemon.pid");
}
function getLogFile() {
  const dir = getPluginStateDir();
  import_node_fs4.default.mkdirSync(dir, { recursive: true });
  return import_node_path4.default.join(dir, "daemon.log");
}
var INVOCATION_ENV_KEYS = ["HERDR_PLUGIN_EVENT", "HERDR_PLUGIN_ACTION_ID"];
function buildDaemonEnv(env) {
  const out = { ...env };
  for (const key of INVOCATION_ENV_KEYS) {
    delete out[key];
  }
  return out;
}
function isStartupInvocation(command, env) {
  if (command === "startup") return true;
  if (command === "daemon") return false;
  return env.HERDR_PLUGIN_EVENT === "startup";
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
  if (!import_node_fs4.default.existsSync(pidFile)) return null;
  try {
    const raw = import_node_fs4.default.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && isPidAlive(pid)) {
      return pid;
    }
    try {
      import_node_fs4.default.unlinkSync(pidFile);
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
  const logFd = import_node_fs4.default.openSync(logFile, "a");
  const child = (0, import_node_child_process3.spawn)(process.execPath, [entryPath, "daemon", "--run"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: buildDaemonEnv(process.env)
  });
  const pid = child.pid;
  child.unref();
  import_node_fs4.default.writeFileSync(getPidFile(), String(pid), "utf8");
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
    import_node_fs4.default.unlinkSync(pidFile);
  } catch {
  }
  return { stopped: true, pid };
}
async function runDaemonLoop(config, store) {
  const pid = process.pid;
  import_node_fs4.default.writeFileSync(getPidFile(), String(pid), "utf8");
  let shouldExit = false;
  const onSignal = () => {
    shouldExit = true;
    console.log(`[daemon] received shutdown signal; stopping`);
    try {
      import_node_fs4.default.unlinkSync(getPidFile());
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
var import_node_fs5 = __toESM(require("fs"));
var import_node_path5 = __toESM(require("path"));
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
  const gr = config.goalResume;
  lines.push(
    `Goal Resume   : ${gr.enabled ? `on ("${gr.prompt}" for ${gr.statuses.join("/")}, ${gr.minInterval}s -> ${gr.maxInterval}s)` : "off"}`
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
      if (state.last_goal_status) {
        const nextGoal = Math.max(0, Math.round((state.next_goal_resume_at ?? 0) - nowSec));
        const waiting = state.last_goal_skip_reason ? `, waiting: ${state.last_goal_skip_reason}` : "";
        lines.push(
          `    Goal: ${state.last_goal_status} (resumes: ${state.total_goal_resumes ?? 0}${nextGoal > 0 ? `, next allowed in ${nextGoal}s` : ""}${waiting})`
        );
      }
    }
  }
  lines.push("--------------------------------------------------");
  const logFile = import_node_path5.default.join(getPluginStateDir(), "daemon.log");
  if (import_node_fs5.default.existsSync(logFile)) {
    try {
      const logs = import_node_fs5.default.readFileSync(logFile, "utf8").trim().split("\n");
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
  if (isStartupInvocation(command, process.env)) {
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

Codex goals:
  Stalled codex goals (blocked, usage_limited) get "/goal resume" after the
  turn ends and the composer is idle. Configure with "goalResume" in config.json
  or HERDR_AUTO_RETRY_GOAL_* variables; HERDR_AUTO_RETRY_GOAL_RESUME=0 disables it.
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
