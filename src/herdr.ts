import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { AgentInfo } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10000;

export function getHerdrBinary(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function runHerdr(
  args: string[],
  options: { timeout?: number } = {}
): { status: number; stdout: string; stderr: string } {
  const binary = getHerdrBinary();
  try {
    const result: SpawnSyncReturns<string> = spawnSync(binary, args, {
      encoding: "utf8",
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      return {
        status: (result.error as any).code === "ENOENT" ? 127 : 1,
        stdout: "",
        stderr: result.error.message,
      };
    }

    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (err: any) {
    return {
      status: 1,
      stdout: "",
      stderr: err?.message || String(err),
    };
  }
}

export function herdrJson<T = any>(args: string[]): T | null {
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
    return JSON.parse(text) as T;
  } catch (err) {
    if (process.env.HERDR_AUTO_RETRY_VERBOSE) {
      console.error(`[herdr] invalid JSON from ${args.join(" ")}: ${err}`);
    }
    return null;
  }
}

export function listAgents(): AgentInfo[] {
  const data = herdrJson<{ result?: { agents?: AgentInfo[] } }>(["agent", "list"]);
  if (!data?.result?.agents || !Array.isArray(data.result.agents)) {
    return [];
  }
  return data.result.agents;
}

export function getAgent(target: string): AgentInfo | null {
  const data = herdrJson<{ result?: { agent?: AgentInfo } }>(["agent", "get", target]);
  return data?.result?.agent ?? null;
}

/**
 * Returns tail of the pane.
 * Returns "" if readable but empty.
 * Returns null if unreadable (means no observation, does not count as a miss).
 */
export function readTail(target: string): string | null {
  const sources: Array<[string, string]> = [
    ["detection", "60"],
    ["recent-unwrapped", "80"],
  ];

  for (const [source, lines] of sources) {
    const res = runHerdr(["agent", "read", target, "--source", source, "--lines", lines]);
    if (res.status === 0) {
      return res.stdout || "";
    }
  }
  return null;
}

/**
 * Returns the currently visible screen of the agent pane, or null when the
 * pane cannot be read. Used to check that the codex composer is idle.
 */
export function readVisible(target: string): string | null {
  const res = runHerdr(["agent", "read", target, "--source", "visible"]);
  return res.status === 0 ? res.stdout || "" : null;
}

export interface SendResult {
  ok: boolean;
  status: number;
  error: string;
}

/**
 * Submits a prompt to an agent via `herdr agent prompt`.
 * herdr rejects the submission when the agent is blocked (agent_blocked).
 */
export function sendPrompt(target: string, text: string): SendResult {
  const res = runHerdr(["agent", "prompt", target, text]);
  if (res.status === 0) {
    return { ok: true, status: 0, error: "" };
  }
  const error = (res.stderr || res.stdout || "").trim().slice(0, 300);
  return { ok: false, status: res.status, error };
}
