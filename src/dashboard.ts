import fs from "node:fs";
import path from "node:path";
import type { PluginConfig } from "./types.js";
import { getRunningPid } from "./daemon.js";
import { StateStore } from "./watcher.js";
import { listAgents } from "./herdr.js";
import { getPluginStateDir } from "./config.js";

export function renderStatus(config: PluginConfig, store: StateStore): string {
  const pid = getRunningPid();
  const isRunning = pid !== null;

  const lines: string[] = [];
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
      const nowSec = Date.now() / 1000;
      const nextIn = isStuck ? Math.max(0, Math.round(state.next_retry_at - nowSec)) : 0;

      lines.push(
        `  * ${target} [${a.agent || "agent"}] (${status}) - ${
          isStuck
            ? `STUCK (retries: ${state.hit_count}, next in ${nextIn}s)`
            : "HEALTHY"
        }`
      );
      if (isStuck && state.last_matched_pattern) {
        lines.push(`    Banner: "${state.last_matched_pattern}"`);
      }
      if (state.last_goal_status) {
        const nextGoal = Math.max(0, Math.round((state.next_goal_resume_at ?? 0) - nowSec));
        const waiting = state.last_goal_skip_reason ? `, waiting: ${state.last_goal_skip_reason}` : "";
        lines.push(
          `    Goal: ${state.last_goal_status} (resumes: ${state.total_goal_resumes ?? 0}${
            nextGoal > 0 ? `, next allowed in ${nextGoal}s` : ""
          }${waiting})`
        );
      }
    }
  }

  lines.push("--------------------------------------------------");
  const logFile = path.join(getPluginStateDir(), "daemon.log");
  if (fs.existsSync(logFile)) {
    try {
      const logs = fs.readFileSync(logFile, "utf8").trim().split("\n");
      const recent = logs.slice(-8);
      lines.push("Recent Daemon Log Entries:");
      for (const logLine of recent) {
        lines.push(`  ${logLine}`);
      }
    } catch {}
  }

  lines.push("==================================================");
  return lines.join("\n");
}

export function runDashboard(config: PluginConfig, store: StateStore): void {
  // Clear screen and print status
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(renderStatus(config, store));
  console.log("\nPress Ctrl+C to close.");

  const interval = setInterval(() => {
    process.stdout.write("\x1b[H");
    console.log(renderStatus(config, store));
    console.log("\nPress Ctrl+C to close.");
  }, 2000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });
}
