import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { GoalResumeConfig, PluginConfig } from "./types.js";
import { DELIBERATE_STATUSES } from "./codex-goal.js";
import { DEFAULT_ROLLOUT_TAIL_BYTES, defaultCodexHome } from "./codex-store.js";

export const DEFAULT_MATCHES: string[] = [
  "Selected model is at capacity",
  "stream disconnected before completion: Our servers are currently overloaded",
  "exceeded retry limit, last status: 429 Too Many Requests",
  "429 Too Many Requests",
];

export const DEFAULT_PROMPT = "continue";
export const DEFAULT_AGENTS = ["codex"];
export const DEFAULT_MIN_WAIT = 15;
export const DEFAULT_MAX_WAIT = 60;
export const DEFAULT_MISS_RESET = 3;
export const DEFAULT_STALE_AFTER = 600;
export const DEFAULT_BUSY_INTERVAL = 5;
export const DEFAULT_INTERVAL = 10;
export const DEFAULT_IDLE_INTERVAL = 60;
export const DEFAULT_WORKERS = 8;

export const DEFAULT_GOAL_RESUME_PROMPT = "/goal resume";
export const DEFAULT_GOAL_RESUME_STATUSES = ["blocked", "usage_limited"];
export const DEFAULT_GOAL_MIN_INTERVAL = 300;
export const DEFAULT_GOAL_MAX_INTERVAL = 1800;
export const DEFAULT_GOAL_RESET_AFTER = 3600;
export const DEFAULT_GOAL_IDLE_MARKERS = ["Ask Codex to do anything"];
export const DEFAULT_GOAL_BUSY_MARKERS = ["Working ("];
// Selection lists and approval overlays replace the composer. Never type into them.
export const DEFAULT_GOAL_MODAL_MARKERS = [
  "Replace goal?",
  "Press enter to confirm",
  "enter to confirm",
  "esc to cancel",
  "Would you like to run the following command",
  "Would you like to make the following edits",
  "Allow command",
  "Do you trust the files in this folder",
];

export function getPluginConfigDir(): string {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  return path.join(os.homedir(), ".config", "herdr", "plugins", "config", "bestony.auto-retry");
}

export function getPluginStateDir(): string {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  if (process.env.HERDR_CAPACITY_STATE_DIR) {
    return process.env.HERDR_CAPACITY_STATE_DIR;
  }
  return path.join(os.homedir(), ".local", "state", "herdr-auto-retry");
}

function parseEnvInt(name: string, fallback: number): number {
  const val = process.env[name];
  if (!val) return fallback;
  const num = parseInt(val, 10);
  return isNaN(num) ? fallback : num;
}

function parseEnvList(name: string): string[] | null {
  const val = process.env[name];
  if (!val) return null;
  const lines = val
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

function parseEnvBool(name: string): boolean | null {
  const val = process.env[name];
  if (val === undefined || val === "") return null;
  return !["0", "false", "no", "off"].includes(val.trim().toLowerCase());
}

function parseEnvCsv(name: string): string[] | null {
  const val = process.env[name];
  if (!val) return null;
  const items = val
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadGoalResumeConfig(
  file: Partial<GoalResumeConfig> = {},
  overrides: Partial<GoalResumeConfig> = {}
): GoalResumeConfig {
  const statuses = (
    overrides.statuses ||
    parseEnvCsv("HERDR_AUTO_RETRY_GOAL_STATUSES") ||
    file.statuses ||
    DEFAULT_GOAL_RESUME_STATUSES
  ).map((s) => s.trim().toLowerCase());
  const deliberate = statuses.filter((s) => DELIBERATE_STATUSES.has(s));
  if (deliberate.length > 0) {
    console.warn(
      `[config] goalResume.statuses includes ${deliberate.join(", ")}; goals paused by a human or by a budget will be resumed`
    );
  }
  const minInterval =
    overrides.minInterval ??
    parseEnvInt("HERDR_AUTO_RETRY_GOAL_MIN_INTERVAL", file.minInterval ?? DEFAULT_GOAL_MIN_INTERVAL);
  return {
    enabled: overrides.enabled ?? parseEnvBool("HERDR_AUTO_RETRY_GOAL_RESUME") ?? file.enabled ?? true,
    prompt:
      overrides.prompt || process.env.HERDR_AUTO_RETRY_GOAL_PROMPT || file.prompt || DEFAULT_GOAL_RESUME_PROMPT,
    statuses,
    minInterval: Math.max(1, minInterval),
    maxInterval:
      overrides.maxInterval ??
      parseEnvInt("HERDR_AUTO_RETRY_GOAL_MAX_INTERVAL", file.maxInterval ?? DEFAULT_GOAL_MAX_INTERVAL),
    resetAfter: overrides.resetAfter ?? file.resetAfter ?? DEFAULT_GOAL_RESET_AFTER,
    codexHome: expandHome(overrides.codexHome || file.codexHome || defaultCodexHome()),
    rolloutTailBytes: overrides.rolloutTailBytes ?? file.rolloutTailBytes ?? DEFAULT_ROLLOUT_TAIL_BYTES,
    idleMarkers: overrides.idleMarkers || file.idleMarkers || DEFAULT_GOAL_IDLE_MARKERS,
    busyMarkers: overrides.busyMarkers || file.busyMarkers || DEFAULT_GOAL_BUSY_MARKERS,
    modalMarkers: overrides.modalMarkers || file.modalMarkers || DEFAULT_GOAL_MODAL_MARKERS,
  };
}

/** Partial config as accepted from config.json or from callers. */
export type PluginConfigInput = Partial<Omit<PluginConfig, "goalResume">> & {
  goalResume?: Partial<GoalResumeConfig>;
};

export function loadConfig(overrides: PluginConfigInput = {}): PluginConfig {
  const configDir = getPluginConfigDir();
  const configFile = path.join(configDir, "config.json");

  let fileConfig: PluginConfigInput = {};
  if (fs.existsSync(configFile)) {
    try {
      const content = fs.readFileSync(configFile, "utf8");
      fileConfig = JSON.parse(content);
    } catch (err) {
      console.error(`[config] failed to read ${configFile}:`, err);
    }
  }

  const matchesFromEnv = parseEnvList("HERDR_AUTO_RETRY_MATCH") || parseEnvList("HERDR_CAPACITY_MATCH");
  const agentsFromEnv = process.env.HERDR_AUTO_RETRY_AGENTS
    ? process.env.HERDR_AUTO_RETRY_AGENTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;

  return {
    agents: overrides.agents || agentsFromEnv || fileConfig.agents || DEFAULT_AGENTS,
    matches: overrides.matches || matchesFromEnv || fileConfig.matches || DEFAULT_MATCHES,
    prompt:
      overrides.prompt ||
      process.env.HERDR_AUTO_RETRY_PROMPT ||
      process.env.HERDR_CAPACITY_PROMPT ||
      fileConfig.prompt ||
      DEFAULT_PROMPT,
    minWait:
      overrides.minWait ??
      parseEnvInt("HERDR_AUTO_RETRY_MIN_WAIT", parseEnvInt("HERDR_CAPACITY_MIN_WAIT", fileConfig.minWait ?? DEFAULT_MIN_WAIT)),
    maxWait:
      overrides.maxWait ??
      parseEnvInt("HERDR_AUTO_RETRY_MAX_WAIT", parseEnvInt("HERDR_CAPACITY_MAX_WAIT", fileConfig.maxWait ?? DEFAULT_MAX_WAIT)),
    missReset: overrides.missReset ?? fileConfig.missReset ?? DEFAULT_MISS_RESET,
    staleAfter: overrides.staleAfter ?? fileConfig.staleAfter ?? DEFAULT_STALE_AFTER,
    intervals: {
      busy:
        overrides.intervals?.busy ??
        parseEnvInt(
          "HERDR_AUTO_RETRY_BUSY_INTERVAL",
          parseEnvInt("HERDR_CAPACITY_BUSY_INTERVAL", fileConfig.intervals?.busy ?? DEFAULT_BUSY_INTERVAL)
        ),
      active:
        overrides.intervals?.active ??
        parseEnvInt(
          "HERDR_AUTO_RETRY_INTERVAL",
          parseEnvInt("HERDR_CAPACITY_INTERVAL", fileConfig.intervals?.active ?? DEFAULT_INTERVAL)
        ),
      idle:
        overrides.intervals?.idle ??
        parseEnvInt(
          "HERDR_AUTO_RETRY_IDLE_INTERVAL",
          parseEnvInt("HERDR_CAPACITY_IDLE_INTERVAL", fileConfig.intervals?.idle ?? DEFAULT_IDLE_INTERVAL)
        ),
    },
    workers:
      overrides.workers ??
      parseEnvInt("HERDR_AUTO_RETRY_WORKERS", parseEnvInt("HERDR_CAPACITY_WORKERS", fileConfig.workers ?? DEFAULT_WORKERS)),
    verbose:
      overrides.verbose ??
      (process.env.HERDR_AUTO_RETRY_VERBOSE === "1" ||
        process.env.HERDR_CAPACITY_VERBOSE === "1" ||
        Boolean(fileConfig.verbose)),
    dryRun: overrides.dryRun ?? fileConfig.dryRun ?? false,
    goalResume: loadGoalResumeConfig(fileConfig.goalResume, overrides.goalResume),
  };
}
