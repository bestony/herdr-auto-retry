/**
 * Pure decision logic for resuming stalled codex goals.
 *
 * When codex hits a transient server error or a usage limit while pursuing a
 * goal, it marks the goal `blocked` / `usage_limited` and stops
 * auto-continuing after the current turn. Sending `/goal resume` fixes it, but
 * only when the turn has ended and the composer is idle: codex refuses slash
 * commands mid-turn, and a refused command stays in the composer.
 *
 * This module has no IO. The watcher collects the inputs and executes the
 * returned action.
 */
import type { GoalResumeConfig } from "./types.js";
import { flatten } from "./text.js";

export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
] as const;

/** Statuses that are never resumed, whatever the configuration says. */
export const NEVER_RESUME: ReadonlySet<string> = new Set(["active", "complete"]);

/** Statuses that a human or a budget set on purpose. Resuming them needs an explicit opt-in. */
export const DELIBERATE_STATUSES: ReadonlySet<string> = new Set(["paused", "budget_limited"]);

export type TurnEvent = "task_started" | "task_complete" | "turn_aborted";

export const TURN_EVENTS: ReadonlySet<string> = new Set<TurnEvent>([
  "task_started",
  "task_complete",
  "turn_aborted",
]);

export type ScreenState = "idle" | "busy" | "modal" | "no-composer" | "unreadable";

export type SkipReason =
  | "disabled"
  | "no-goal"
  | "goal-unavailable"
  | "status-not-resumable"
  | "turn-unknown"
  | "turn-in-progress"
  | "turn-aborted"
  | "screen-unreadable"
  | "screen-busy"
  | "screen-modal"
  | "screen-no-composer"
  | "rate-limited";

export type GoalDecision =
  | {
      action: "resume";
      /** Attempt number within the current stall episode (1-based). */
      attempt: number;
      /** Earliest unix seconds for the next resume of this agent. */
      nextAllowedAt: number;
      /** Seconds until the next resume is allowed. */
      backoff: number;
    }
  | {
      action: "skip";
      reason: SkipReason;
      /** True when the goal is stalled and waits for a later resume. */
      stalled: boolean;
      /** Seconds left before a resume is allowed (rate-limited only). */
      remaining?: number;
    };

/** Per-agent resume history used for rate limiting. */
export interface GoalResumeHistory {
  last_goal_resume_at?: number;
  next_goal_resume_at?: number;
  goal_resume_count?: number;
}

/**
 * Result of the goal lookup. `null` status with `found: false` means the
 * session has no goal record.
 */
export type GoalLookup =
  | { kind: "found"; status: string; source: string }
  | { kind: "none" }
  | { kind: "error"; error: string };

export interface GoalDecisionInput {
  goal: GoalLookup;
  /** Last turn lifecycle event from the rollout tail, or null when unknown. */
  lastTurnEvent: TurnEvent | null;
  /** Visible screen text, or null when unreadable. */
  screen: string | null;
  history: GoalResumeHistory;
  nowSec: number;
  config: GoalResumeConfig;
}

export function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function isResumableStatus(status: string, configured: string[]): boolean {
  const s = normalizeStatus(status);
  if (NEVER_RESUME.has(s)) return false;
  return configured.some((c) => normalizeStatus(c) === s);
}

function containsAny(flatLower: string, markers: string[]): boolean {
  return markers.some((m) => {
    const needle = flatten(m).toLowerCase();
    return needle.length > 0 && flatLower.includes(needle);
  });
}

/**
 * Classifies the visible codex screen.
 *
 * Order matters: a modal or a running turn wins over the composer placeholder,
 * because codex keeps drawing the placeholder while a turn runs.
 */
export function classifyScreen(
  screen: string | null,
  config: Pick<GoalResumeConfig, "idleMarkers" | "busyMarkers" | "modalMarkers">
): ScreenState {
  if (screen === null) return "unreadable";
  const flat = flatten(screen).toLowerCase();
  if (containsAny(flat, config.modalMarkers)) return "modal";
  if (containsAny(flat, config.busyMarkers)) return "busy";
  if (!containsAny(flat, config.idleMarkers)) return "no-composer";
  return "idle";
}

/**
 * Returns the last turn lifecycle event in a chunk of rollout JSONL.
 *
 * `startsMidLine` is true when the chunk starts inside a line (a tail read
 * that did not begin at offset 0); the first, partial line is dropped.
 * Malformed lines are ignored.
 */
export function parseLastTurnEvent(chunk: string, startsMidLine: boolean): TurnEvent | null {
  const lines = chunk.split("\n");
  if (startsMidLine) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap pre-filter: most lines are large tool outputs or token counts.
    if (!line.includes("event_msg")) continue;
    if (
      !line.includes("task_started") &&
      !line.includes("task_complete") &&
      !line.includes("turn_aborted")
    ) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "event_msg") continue;
    const type = record?.payload?.type;
    if (typeof type === "string" && TURN_EVENTS.has(type)) {
      return type as TurnEvent;
    }
  }
  return null;
}

/** Exponential backoff between resumes: minInterval * 2^(attempt-1), capped. */
export function goalBackoffSeconds(attempt: number, minInterval: number, maxInterval: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(minInterval * 2 ** exp, Math.max(maxInterval, minInterval));
}

/**
 * Decides whether to send `/goal resume` now.
 *
 * Resume only when all of these hold:
 * - the goal status is resumable (default: blocked, usage_limited),
 * - the last turn event is `task_complete` (the turn ended normally),
 * - the screen shows the idle composer with no running turn and no modal,
 * - the per-agent rate limit allows it.
 */
export function decideGoalResume(input: GoalDecisionInput): GoalDecision {
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
  // An aborted turn means a human pressed esc (or codex aborted on purpose).
  // Leave the agent to the human.
  if (lastTurnEvent === "turn_aborted") {
    return { action: "skip", reason: "turn-aborted", stalled: true };
  }

  const screenState = classifyScreen(screen, config);
  if (screenState !== "idle") {
    const reason: SkipReason =
      screenState === "unreadable"
        ? "screen-unreadable"
        : screenState === "busy"
        ? "screen-busy"
        : screenState === "modal"
        ? "screen-modal"
        : "screen-no-composer";
    return { action: "skip", reason, stalled: true };
  }

  const nextAllowed = history.next_goal_resume_at ?? 0;
  if (nowSec < nextAllowed) {
    return {
      action: "skip",
      reason: "rate-limited",
      stalled: true,
      remaining: Math.max(0, Math.round(nextAllowed - nowSec)),
    };
  }

  // A stall long after the last resume is a new episode: restart the backoff.
  const last = history.last_goal_resume_at ?? 0;
  const fresh = last === 0 || nowSec - last > config.resetAfter;
  const attempt = fresh ? 1 : (history.goal_resume_count ?? 0) + 1;
  const backoff = goalBackoffSeconds(attempt, config.minInterval, config.maxInterval);
  return { action: "resume", attempt, nextAllowedAt: nowSec + backoff, backoff };
}
