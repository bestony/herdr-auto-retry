import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PluginConfig } from "./types.js";
import { getPluginStateDir } from "./config.js";
import { scanOnce, StateStore } from "./watcher.js";

function getPidFile(): string {
  const dir = getPluginStateDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "daemon.pid");
}

function getLogFile(): string {
  const dir = getPluginStateDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "daemon.log");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return false;
  }
}

export function getRunningPid(): number | null {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) return null;
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && isPidAlive(pid)) {
      return pid;
    }
    // Stale pid file
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return null;
  } catch {
    return null;
  }
}

export function startDaemon(entryPath: string): { started: boolean; pid: number } {
  const existingPid = getRunningPid();
  if (existingPid !== null) {
    return { started: false, pid: existingPid };
  }

  const logFile = getLogFile();
  const logFd = fs.openSync(logFile, "a");

  const child = spawn(process.execPath, [entryPath, "daemon", "--run"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env },
  });

  const pid = child.pid!;
  child.unref();

  fs.writeFileSync(getPidFile(), String(pid), "utf8");
  return { started: true, pid };
}

export function stopDaemon(): { stopped: boolean; pid?: number } {
  const pid = getRunningPid();
  if (pid === null) {
    return { stopped: false };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {}

  const pidFile = getPidFile();
  try {
    fs.unlinkSync(pidFile);
  } catch {}

  return { stopped: true, pid };
}

export async function runDaemonLoop(config: PluginConfig, store: StateStore): Promise<void> {
  const pid = process.pid;
  fs.writeFileSync(getPidFile(), String(pid), "utf8");

  let shouldExit = false;
  const onSignal = () => {
    shouldExit = true;
    console.log(`[daemon] received shutdown signal; stopping`);
    try {
      fs.unlinkSync(getPidFile());
    } catch {}
    process.exit(0);
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  console.log(
    `[daemon] auto-retry daemon started (PID: ${pid}, intervals: busy=${config.intervals.busy}s, active=${config.intervals.active}s, idle=${config.intervals.idle}s)`
  );

  let currentTier: string | null = null;

  while (!shouldExit) {
    let result;
    try {
      result = await scanOnce(config, store);
    } catch (err) {
      console.error("[daemon] scan failed:", err);
      result = { tier: "active", describe: () => "scan error fallback" } as any;
    }

    const tier = result.tier;
    const delaySec =
      tier === "busy"
        ? config.intervals.busy
        : tier === "active"
        ? config.intervals.active
        : config.intervals.idle;

    if (tier !== currentTier) {
      currentTier = tier;
      console.log(`[daemon] cadence -> ${tier} (${delaySec}s): ${result.describe()}`);
    } else if (config.verbose) {
      console.log(`[daemon] ${result.describe()}; next scan in ${delaySec}s (${tier})`);
    }

    await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
  }
}
