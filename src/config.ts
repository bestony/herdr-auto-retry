import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "./types.js";

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

export function loadConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  const configDir = getPluginConfigDir();
  const configFile = path.join(configDir, "config.json");

  let fileConfig: Partial<PluginConfig> = {};
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
  };
}
