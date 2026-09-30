import { loadConfig } from "./config.js";
import { StateStore, scanOnce } from "./watcher.js";
import { startDaemon, stopDaemon, runDaemonLoop, getRunningPid } from "./daemon.js";
import { renderStatus, runDashboard } from "./dashboard.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "";

  // Herdr startup hook detection
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
      const result = await scanOnce(config, store, targets.length > 0 ? targets : undefined);
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
        // If unknown command, could be target names for scan
        const targets = args.filter((t) => !t.startsWith("-"));
        console.log(`Scanning specified targets: ${targets.join(", ")}`);
        const result = await scanOnce(config, store, targets);
        console.log(`Scan completed: ${result.describe()}`);
      } else {
        // Default action: print status
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
