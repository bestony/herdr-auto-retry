import fs from "node:fs";
import path from "node:path";
import {
  type AgentInfo,
  type AgentStatus,
  Outcome,
  ScanResult,
  type TargetStateData,
  type PluginConfig,
} from "./types.js";
import { getPluginStateDir } from "./config.js";
import { flatten } from "./text.js";
import { getAgent, listAgents, readTail, readVisible, sendPrompt, type SendResult } from "./herdr.js";
import { decideGoalResume, isResumableStatus, type GoalLookup, type TurnEvent } from "./codex-goal.js";
import {
  GOAL_DB_FILE,
  findRolloutFile,
  lookupGoalStatus,
  readLastTurnEvent,
} from "./codex-store.js";

// "blocked" is excluded: the agent waits on a human approval, and
// `herdr agent prompt` rejects submissions to blocked agents.
export const SETTLED: ReadonlySet<AgentStatus> = new Set([
  "idle",
  "done",
  "unknown",
]);

export { flatten };

export function findMatch(haystack: string, patterns: string[]): string | null {
  const flat = flatten(haystack).toLowerCase();
  for (const pattern of patterns) {
    if (flat.includes(flatten(pattern).toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

export function backoffSeconds(
  hitCount: number,
  minWait: number,
  maxWait: number
): number {
  const exp = Math.min(hitCount, 6);
  const wait = minWait * 2 ** exp;
  return Math.min(wait, maxWait);
}

export class StateStore {
  private cache: Map<string, TargetStateData> = new Map();
  private filePath: string;

  constructor(stateDir?: string) {
    const dir = stateDir || getPluginStateDir();
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "state.json");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (typeof data === "object" && data !== null) {
        for (const [k, v] of Object.entries(data)) {
          this.cache.set(k, v as TargetStateData);
        }
      }
    } catch (err) {
      console.error(`[state] failed to read ${this.filePath}:`, err);
    }
  }

  save(): void {
    try {
      const obj: Record<string, TargetStateData> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
    } catch (err) {
      console.error(`[state] failed to write ${this.filePath}:`, err);
    }
  }

  get(target: string): TargetStateData {
    if (!this.cache.has(target)) {
      this.cache.set(target, {
        first_seen_at: 0,
        last_match_at: 0,
        miss_count: 0,
        hit_count: 0,
        next_retry_at: 0,
      });
    }
    return this.cache.get(target)!;
  }

  set(target: string, state: TargetStateData): void {
    this.cache.set(target, state);
    this.save();
  }

  getAll(): Map<string, TargetStateData> {
    return new Map(this.cache);
  }
}

/** IO used by the codex goal resume step. Replaced by fakes in tests. */
export interface GoalIO {
  lookupGoal(sessionId: string): GoalLookup;
  lastTurnEvent(sessionId: string): TurnEvent | null;
  readScreen(target: string): string | null;
  send(target: string, text: string): SendResult;
}

export function defaultGoalIO(config: PluginConfig): GoalIO {
  const { codexHome, rolloutTailBytes } = config.goalResume;
  return {
    lookupGoal: (sessionId) => lookupGoalStatus(path.join(codexHome, GOAL_DB_FILE), sessionId),
    lastTurnEvent: (sessionId) => {
      const file = findRolloutFile(codexHome, sessionId);
      if (!file) {
        if (config.verbose) console.log(`[goal] no rollout file for session ${sessionId}`);
        return null;
      }
      try {
        return readLastTurnEvent(file, rolloutTailBytes);
      } catch (err) {
        console.error(`[goal] failed to read rollout ${file}: ${(err as any)?.message || err}`);
        return null;
      }
    },
    readScreen: readVisible,
    send: sendPrompt,
  };
}

/**
 * Codex goal resume step.
 *
 * Returns an outcome when the goal is stalled (resumable status) and this step
 * owns the target for this scan. Returns null when the goal is not stalled, so
 * the banner-based retry runs as before. A stalled goal needs `/goal resume`,
 * not "continue": a plain prompt starts a turn but leaves the goal stalled.
 */
export function processGoal(
  target: string,
  agent: AgentInfo,
  state: TargetStateData,
  config: PluginConfig,
  store: StateStore,
  nowSec: number,
  io: GoalIO = defaultGoalIO(config)
): Outcome | null {
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

  const status = goal.kind === "found" ? goal.status : undefined;
  if (status !== state.last_goal_status) {
    if (status !== undefined || state.last_goal_status !== undefined) {
      console.log(`[${target}] goal status: ${state.last_goal_status ?? "none"} -> ${status ?? "none"}`);
    }
    state.last_goal_status = status;
    store.set(target, state);
  }
  if (goal.kind === "found" && goal.source !== "ro" && config.verbose) {
    console.log(`[${target}] goal: status read via ${goal.source} fallback (may lag the WAL)`);
  }

  if (status === undefined || !isResumableStatus(status, gc.statuses)) {
    if (state.last_goal_skip_reason !== undefined) {
      state.last_goal_skip_reason = undefined;
      store.set(target, state);
    }
    return null;
  }

  const lastTurnEvent = io.lastTurnEvent(sessionId);
  // Read the screen only when the turn has ended; the decision ignores it otherwise.
  const screen = lastTurnEvent === "task_complete" ? io.readScreen(target) : null;

  const decision = decideGoalResume({
    goal,
    lastTurnEvent,
    screen,
    history: state,
    nowSec,
    config: gc,
  });

  if (decision.action === "skip") {
    const detail =
      decision.reason === "rate-limited" ? ` (${decision.remaining}s until next resume)` : "";
    if (decision.reason !== state.last_goal_skip_reason) {
      console.log(`[${target}] goal ${status}: waiting (${decision.reason})${detail}`);
      state.last_goal_skip_reason = decision.reason;
      store.set(target, state);
    } else if (config.verbose) {
      console.log(`[${target}] goal ${status}: still waiting (${decision.reason})${detail}`);
    }
    return decision.stalled ? Outcome.STUCK : null;
  }

  state.last_goal_resume_at = nowSec;
  state.next_goal_resume_at = decision.nextAllowedAt;
  state.goal_resume_count = decision.attempt;
  state.total_goal_resumes = (state.total_goal_resumes || 0) + 1;
  state.last_goal_skip_reason = undefined;
  store.set(target, state);

  if (config.dryRun) {
    console.log(
      `[${target}] [dry-run] goal ${status}: would send "${gc.prompt}" (attempt ${decision.attempt}, next allowed in ${decision.backoff}s)`
    );
    return Outcome.STUCK;
  }

  console.log(
    `[${target}] goal ${status}: sending "${gc.prompt}" (attempt ${decision.attempt}, next allowed in ${decision.backoff}s)`
  );
  const sent = io.send(target, gc.prompt);
  if (!sent.ok) {
    console.error(`[${target}] goal: failed to send "${gc.prompt}" (exit ${sent.status}): ${sent.error || "no output"}`);
  }
  return Outcome.STUCK;
}

export async function processTarget(
  target: string,
  config: PluginConfig,
  store: StateStore,
  nowSec: number = Date.now() / 1000
): Promise<Outcome> {
  const agent = getAgent(target);
  const state = store.get(target);

  const configuredAgents = config.agents.map((a) => a.toLowerCase());
  const agentType = (agent?.agent || agent?.display_agent || "").toLowerCase();

  // If target agent is gone or doesn't match configured types
  if (!agent || (configuredAgents.length > 0 && !configuredAgents.includes(agentType))) {
    if (state.first_seen_at > 0) {
      // Episode was active, target is now absent
      state.first_seen_at = 0;
      state.miss_count = 0;
      store.set(target, state);
    }
    return Outcome.ABSENT;
  }

  const rawStatus = (agent.agent_status || agent.status || "unknown").toLowerCase() as AgentStatus;

  // If agent is still actively working, do not attempt retry
  if (!SETTLED.has(rawStatus)) {
    if (state.first_seen_at > 0) {
      state.miss_count += 1;
      store.set(target, state);
    }
    return Outcome.PRESENT;
  }

  // Codex goal mode: a stalled goal needs `/goal resume` once the turn ends.
  if (agentType === "codex" && config.goalResume.enabled) {
    const goalOutcome = processGoal(target, agent, state, config, store, nowSec);
    if (goalOutcome !== null) return goalOutcome;
  }

  // Read terminal tail
  const tail = readTail(target);
  if (tail === null) {
    // Unreadable (failed command); do not count as a miss
    return state.first_seen_at > 0 ? Outcome.STUCK : Outcome.PRESENT;
  }

  const matchedPattern = findMatch(tail, config.matches);

  if (matchedPattern) {
    state.miss_count = 0;

    // Check if previous episode became stale
    const isStale =
      state.first_seen_at > 0 &&
      nowSec - state.last_match_at > config.staleAfter;

    if (isStale || state.first_seen_at === 0) {
      // Fresh episode
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
    return Outcome.STUCK;
  } else {
    // Banner not found in tail
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
      return state.first_seen_at > 0 ? Outcome.STUCK : Outcome.PRESENT;
    }

    return Outcome.PRESENT;
  }
}

/**
 * Limit concurrency over array of tasks
 */
async function asyncPool<T, R>(
  poolLimit: number,
  array: T[],
  iteratorFn: (item: T) => Promise<R>
): Promise<R[]> {
  const ret: Promise<R>[] = [];
  const executing: Promise<void>[] = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e: Promise<void> = p.then(() => {
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

export async function scanOnce(
  config: PluginConfig,
  store: StateStore,
  targetList?: string[]
): Promise<ScanResult> {
  const result = new ScanResult();

  let targets = targetList;
  if (!targets || targets.length === 0) {
    const agents = listAgents();
    const configured = config.agents.map((a) => a.toLowerCase());
    targets = agents
      .filter((a) => {
        const type = (a.agent || a.display_agent || "").toLowerCase();
        return configured.length === 0 || configured.includes(type);
      })
      .map((a) => a.name || a.pane_id)
      .filter(Boolean);
  }

  if (targets.length === 0) {
    return result;
  }

  const workers = Math.max(1, Math.min(config.workers, targets.length));
  const nowSec = Date.now() / 1000;

  const outcomes = await asyncPool(workers, targets, async (target) => {
    try {
      return await processTarget(target, config, store, nowSec);
    } catch (err) {
      console.error(`[watcher] error processing ${target}:`, err);
      return Outcome.STUCK;
    }
  });

  for (const outcome of outcomes) {
    if (outcome === Outcome.STUCK) {
      result.stuck += 1;
    } else if (outcome === Outcome.PRESENT) {
      result.present += 1;
    }
  }

  return result;
}
