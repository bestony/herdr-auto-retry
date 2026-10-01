import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  classifyScreen,
  decideGoalResume,
  goalBackoffSeconds,
  isResumableStatus,
  parseLastTurnEvent,
  type GoalDecisionInput,
  type GoalLookup,
  type TurnEvent,
} from "../src/codex-goal.js";
import {
  cliSqliteQuery,
  findRolloutFile,
  goalDbUris,
  lookupGoalStatus,
  readFileTail,
  readLastTurnEvent,
  uuidV7Millis,
  type SqliteQuery,
} from "../src/codex-store.js";
import { loadConfig, loadGoalResumeConfig } from "../src/config.js";
import { processGoal, StateStore, type GoalIO } from "../src/watcher.js";
import { Outcome, type AgentInfo } from "../src/types.js";

const CFG = loadGoalResumeConfig();

const IDLE_SCREEN = `• Ran git status --short
  └ (no output)

› Ask Codex to do anything

  Context 54% left                         Goal stalled (/goal resume)`;

const BUSY_SCREEN = `• Working (6m 40s • esc to interrupt)


› Ask Codex to do anything

  Context 54% left                         Goal stalled (/goal resume)`;

const MODAL_SCREEN = `  Replace goal?

› 1. Yes, replace the current goal
  2. No, keep the current goal

  Press enter to confirm or esc to cancel`;

function input(over: Partial<GoalDecisionInput> = {}): GoalDecisionInput {
  return {
    goal: { kind: "found", status: "blocked", source: "ro" },
    lastTurnEvent: "task_complete",
    screen: IDLE_SCREEN,
    history: {},
    nowSec: 10_000,
    config: CFG,
    ...over,
  };
}

function eventLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type, ...extra } });
}

describe("decideGoalResume", () => {
  test("resumes a blocked goal when the turn ended and the composer is idle", () => {
    const d = decideGoalResume(input());
    assert.equal(d.action, "resume");
    if (d.action === "resume") {
      assert.equal(d.attempt, 1);
      assert.equal(d.backoff, CFG.minInterval);
      assert.equal(d.nextAllowedAt, 10_000 + CFG.minInterval);
    }
  });

  test("resumes a usage_limited goal", () => {
    const d = decideGoalResume(input({ goal: { kind: "found", status: "usage_limited", source: "ro" } }));
    assert.equal(d.action, "resume");
  });

  test("does not resume mid-turn (rollout)", () => {
    const d = decideGoalResume(input({ lastTurnEvent: "task_started" }));
    assert.deepEqual(d, { action: "skip", reason: "turn-in-progress", stalled: true });
  });

  test("does not resume mid-turn (screen shows Working)", () => {
    const d = decideGoalResume(input({ screen: BUSY_SCREEN }));
    assert.deepEqual(d, { action: "skip", reason: "screen-busy", stalled: true });
  });

  test("does not resume when the turn event is unknown or aborted", () => {
    assert.equal((decideGoalResume(input({ lastTurnEvent: null })) as any).reason, "turn-unknown");
    assert.equal((decideGoalResume(input({ lastTurnEvent: "turn_aborted" })) as any).reason, "turn-aborted");
  });

  test("does not resume when a selection list or modal is visible", () => {
    const d = decideGoalResume(input({ screen: MODAL_SCREEN }));
    assert.deepEqual(d, { action: "skip", reason: "screen-modal", stalled: true });
    // Modal wins even when the placeholder is still drawn somewhere.
    const both = decideGoalResume(input({ screen: `${IDLE_SCREEN}\n${MODAL_SCREEN}` }));
    assert.equal((both as any).reason, "screen-modal");
  });

  test("does not resume when the composer is missing or the screen is unreadable", () => {
    assert.equal((decideGoalResume(input({ screen: "some output" })) as any).reason, "screen-no-composer");
    assert.equal((decideGoalResume(input({ screen: null })) as any).reason, "screen-unreadable");
  });

  test("never resumes paused, budget_limited, complete or active goals by default", () => {
    for (const status of ["paused", "budget_limited", "complete", "active"]) {
      const d = decideGoalResume(input({ goal: { kind: "found", status, source: "ro" } }));
      assert.deepEqual(d, { action: "skip", reason: "status-not-resumable", stalled: false }, status);
    }
  });

  test("complete and active are never resumable even when configured", () => {
    assert.equal(isResumableStatus("complete", ["complete", "blocked"]), false);
    assert.equal(isResumableStatus("active", ["active"]), false);
    assert.equal(isResumableStatus("paused", ["paused"]), true);
    assert.equal(isResumableStatus(" BLOCKED ", ["blocked"]), true);
  });

  test("skips when there is no goal, the lookup failed, or resume is disabled", () => {
    assert.equal((decideGoalResume(input({ goal: { kind: "none" } })) as any).reason, "no-goal");
    assert.equal(
      (decideGoalResume(input({ goal: { kind: "error", error: "x" } })) as any).reason,
      "goal-unavailable"
    );
    assert.equal(
      (decideGoalResume(input({ config: { ...CFG, enabled: false } })) as any).reason,
      "disabled"
    );
  });

  test("rate limits resumes per agent", () => {
    const d = decideGoalResume(
      input({ history: { last_goal_resume_at: 9_900, next_goal_resume_at: 10_200, goal_resume_count: 1 } })
    );
    assert.deepEqual(d, { action: "skip", reason: "rate-limited", stalled: true, remaining: 200 });
  });

  test("backs off when the goal re-stalls soon after a resume", () => {
    const d = decideGoalResume(
      input({
        nowSec: 20_000,
        history: { last_goal_resume_at: 19_000, next_goal_resume_at: 19_300, goal_resume_count: 2 },
      })
    );
    assert.equal(d.action, "resume");
    if (d.action === "resume") {
      assert.equal(d.attempt, 3);
      assert.equal(d.backoff, Math.min(CFG.minInterval * 4, CFG.maxInterval));
    }
  });

  test("a stall long after the last resume starts a fresh episode", () => {
    const d = decideGoalResume(
      input({
        nowSec: 100_000,
        history: { last_goal_resume_at: 100_000 - CFG.resetAfter - 1, next_goal_resume_at: 0, goal_resume_count: 5 },
      })
    );
    assert.equal(d.action, "resume");
    if (d.action === "resume") assert.equal(d.attempt, 1);
  });

  test("goalBackoffSeconds grows exponentially with a cap", () => {
    assert.equal(goalBackoffSeconds(1, 300, 1800), 300);
    assert.equal(goalBackoffSeconds(2, 300, 1800), 600);
    assert.equal(goalBackoffSeconds(3, 300, 1800), 1200);
    assert.equal(goalBackoffSeconds(4, 300, 1800), 1800);
    assert.equal(goalBackoffSeconds(50, 300, 1800), 1800);
    // A max below the min never shortens the min interval.
    assert.equal(goalBackoffSeconds(1, 300, 60), 300);
  });
});

describe("classifyScreen", () => {
  test("classifies idle, busy, modal and missing composer", () => {
    assert.equal(classifyScreen(IDLE_SCREEN, CFG), "idle");
    assert.equal(classifyScreen(BUSY_SCREEN, CFG), "busy");
    assert.equal(classifyScreen(MODAL_SCREEN, CFG), "modal");
    assert.equal(classifyScreen("", CFG), "no-composer");
    assert.equal(classifyScreen(null, CFG), "unreadable");
  });

  test("matches markers across line wraps", () => {
    assert.equal(classifyScreen("› Ask Codex to do\n  anything", CFG), "idle");
  });
});

describe("rollout tail parsing", () => {
  test("returns the last lifecycle event and ignores other records", () => {
    const chunk = [
      eventLine("task_started"),
      eventLine("token_count"),
      eventLine("task_complete", { error: { message: "Selected model is at capacity." } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", text: "task_started" } }),
      eventLine("token_count"),
      "",
    ].join("\n");
    assert.equal(parseLastTurnEvent(chunk, false), "task_complete");
  });

  test("a later task_started wins over an earlier task_complete", () => {
    const chunk = [eventLine("task_complete"), eventLine("task_started")].join("\n");
    assert.equal(parseLastTurnEvent(chunk, false), "task_started");
  });

  test("drops the partial first line of a tail read and skips malformed lines", () => {
    const partial = eventLine("task_started").slice(10);
    const chunk = [partial, '{"type":"event_msg","payload":{"type":"task_complete"', ""].join("\n");
    assert.equal(parseLastTurnEvent(chunk, true), null);
    // Without the mid-line flag the first line is parsed (and here is malformed too).
    assert.equal(parseLastTurnEvent(eventLine("turn_aborted"), false), "turn_aborted");
  });

  test("reads only the tail of a large rollout file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-rollout-"));
    try {
      const file = path.join(dir, "rollout.jsonl");
      const filler = eventLine("token_count", { pad: "x".repeat(1000) });
      const lines = [eventLine("task_started")];
      for (let i = 0; i < 300; i++) lines.push(filler);
      lines.push(eventLine("task_complete"));
      for (let i = 0; i < 5; i++) lines.push(filler);
      fs.writeFileSync(file, lines.join("\n") + "\n");

      const tail = readFileTail(file, 64 * 1024);
      assert.equal(tail.startsMidLine, true);
      assert.ok(tail.text.length <= 64 * 1024);
      assert.equal(readLastTurnEvent(file, 64 * 1024), "task_complete");
      // A tail too small to reach any lifecycle event reports unknown.
      assert.equal(readLastTurnEvent(file, 2 * 1024), null);
      // Whole-file read starts at a line boundary.
      assert.equal(readFileTail(file, 10 * 1024 * 1024).startsMidLine, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rollout file discovery", () => {
  const SESSION = "01a0f6b8-017b-79a1-a400-f81bbce05c84";

  test("decodes the UUIDv7 timestamp", () => {
    const ms = uuidV7Millis(SESSION);
    assert.ok(ms !== null);
    assert.equal(new Date(ms!).getUTCFullYear(), 2026);
    assert.equal(uuidV7Millis("not-a-uuid"), null);
    assert.equal(uuidV7Millis("063acf5f-f1e6-416e-97fc-bf78dc73f102"), null); // v4
  });

  test("finds the rollout file by session id and caches it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "goal-home-"));
    try {
      const d = new Date(uuidV7Millis(SESSION)!);
      const dir = path.join(
        home,
        "sessions",
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0")
      );
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-10-01T17-07-29-${SESSION}.jsonl`);
      fs.writeFileSync(file, "");
      fs.writeFileSync(path.join(dir, "rollout-2026-10-01T17-07-29-other.jsonl"), "");

      const cache = new Map<string, string>();
      assert.equal(findRolloutFile(home, SESSION, cache), file);
      assert.equal(cache.get(SESSION), file);

      // Non-v7 ids fall back to the full walk.
      const v4 = "063acf5f-f1e6-416e-97fc-bf78dc73f102";
      const old = path.join(home, "sessions", "2025", "01", "02");
      fs.mkdirSync(old, { recursive: true });
      const v4file = path.join(old, `rollout-2025-01-02T00-00-00-${v4}.jsonl`);
      fs.writeFileSync(v4file, "");
      assert.equal(findRolloutFile(home, v4, cache), v4file);

      assert.equal(findRolloutFile(home, "00000000-0000-7000-8000-000000000000", cache), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("goal status lookup", () => {
  const DB = "/codex/goals_1.sqlite";
  const SESSION = "01a0f6b8-017b-79a1-a400-f81bbce05c84";

  test("uses read-only mode first", () => {
    const seen: string[] = [];
    const query: SqliteQuery = (uri, sql, param) => {
      seen.push(uri);
      assert.match(sql, /FROM thread_goals WHERE thread_id = \?/);
      assert.equal(param, SESSION);
      return [{ status: "blocked" }];
    };
    assert.deepEqual(lookupGoalStatus(DB, SESSION, query, () => true), {
      kind: "found",
      status: "blocked",
      source: "ro",
    });
    assert.deepEqual(seen, [goalDbUris(DB)[0].uri]);
    assert.ok(seen[0].endsWith("?mode=ro"));
  });

  test("falls back to immutable=1 when mode=ro cannot open the WAL database", () => {
    const seen: string[] = [];
    const query: SqliteQuery = (uri) => {
      seen.push(uri);
      if (!uri.includes("immutable=1")) throw new Error("unable to open database file");
      return [{ status: "usage_limited" }];
    };
    assert.deepEqual(lookupGoalStatus(DB, SESSION, query, () => true), {
      kind: "found",
      status: "usage_limited",
      source: "immutable",
    });
    assert.equal(seen.length, 2);
    assert.ok(seen[1].endsWith("?mode=ro&immutable=1"));
  });

  test("reports an error when every open mode fails", () => {
    const query: SqliteQuery = () => {
      throw new Error("unable to open database file");
    };
    const res = lookupGoalStatus(DB, SESSION, query, () => true);
    assert.equal(res.kind, "error");
    if (res.kind === "error") assert.match(res.error, /ro: .*immutable: /);
  });

  test("no row means no goal; missing db and unsafe ids are errors", () => {
    assert.deepEqual(lookupGoalStatus(DB, SESSION, () => [], () => true), { kind: "none" });
    assert.equal(lookupGoalStatus(DB, SESSION, () => [], () => false).kind, "error");
    let called = false;
    const res = lookupGoalStatus(DB, "x'; DROP TABLE t;--", () => ((called = true), []), () => true);
    assert.equal(res.kind, "error");
    assert.equal(called, false);
  });

  test("sqlite3 CLI backend reads the goal status when installed", (t) => {
    const probe = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      t.skip("sqlite3 CLI not installed");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cli-"));
    try {
      const dbPath = path.join(dir, "goals_1.sqlite");
      const init = spawnSync(
        "sqlite3",
        [
          dbPath,
          `PRAGMA journal_mode=WAL; CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO thread_goals VALUES ('${SESSION}', 'usage_limited');`,
        ],
        { encoding: "utf8" }
      );
      assert.equal(init.status, 0, init.stderr);
      assert.deepEqual(lookupGoalStatus(dbPath, SESSION, cliSqliteQuery), {
        kind: "found",
        status: "usage_limited",
        source: "ro",
      });
      assert.deepEqual(lookupGoalStatus(dbPath, "01a0f6b8-0000-7000-8000-000000000000", cliSqliteQuery), {
        kind: "none",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a real WAL database through node:sqlite when available", (t) => {
    const mod = (process as any).getBuiltinModule?.("node:sqlite");
    if (!mod?.DatabaseSync) {
      t.skip("node:sqlite not available");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-db-"));
    try {
      const dbPath = path.join(dir, "goals_1.sqlite");
      const db = new mod.DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL)");
      db.prepare("INSERT INTO thread_goals VALUES (?, ?)").run(SESSION, "blocked");
      assert.deepEqual(lookupGoalStatus(dbPath, SESSION), { kind: "found", status: "blocked", source: "ro" });
      assert.deepEqual(lookupGoalStatus(dbPath, "01a0f6b8-0000-7000-8000-000000000000"), { kind: "none" });
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("processGoal", () => {
  const AGENT: AgentInfo = {
    pane_id: "w1:p1",
    name: "lane-1",
    agent: "codex",
    agent_status: "idle",
    agent_session: { value: "01a0f6b8-017b-79a1-a400-f81bbce05c84" },
  };

  function fakeIO(goal: GoalLookup, turn: TurnEvent | null, screen: string | null) {
    const sent: string[] = [];
    let screenReads = 0;
    const io: GoalIO = {
      lookupGoal: () => goal,
      lastTurnEvent: () => turn,
      readScreen: () => {
        screenReads += 1;
        return screen;
      },
      send: (_t, text) => {
        sent.push(text);
        return { ok: true, status: 0, error: "" };
      },
    };
    return { io, sent, screenReads: () => screenReads };
  }

  function withStore(fn: (store: StateStore) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-state-"));
    try {
      fn(new StateStore(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const config = loadConfig({ goalResume: { minInterval: 300, maxInterval: 1800 } });

  test("sends /goal resume once, then rate limits", () => {
    withStore((store) => {
      const f = fakeIO({ kind: "found", status: "blocked", source: "ro" }, "task_complete", IDLE_SCREEN);
      const state = store.get("lane-1");
      assert.equal(processGoal("lane-1", AGENT, state, config, store, 1000, f.io), Outcome.STUCK);
      assert.deepEqual(f.sent, ["/goal resume"]);
      assert.equal(state.goal_resume_count, 1);
      assert.equal(state.next_goal_resume_at, 1300);
      assert.equal(state.total_goal_resumes, 1);

      assert.equal(processGoal("lane-1", AGENT, state, config, store, 1100, f.io), Outcome.STUCK);
      assert.deepEqual(f.sent, ["/goal resume"]);
      assert.equal(state.last_goal_skip_reason, "rate-limited");

      // Re-stall after the interval: second attempt with a doubled backoff.
      assert.equal(processGoal("lane-1", AGENT, state, config, store, 1400, f.io), Outcome.STUCK);
      assert.equal(f.sent.length, 2);
      assert.equal(state.goal_resume_count, 2);
      assert.equal(state.next_goal_resume_at, 2000);
    });
  });

  test("does not read the screen or send while the turn runs", () => {
    withStore((store) => {
      const f = fakeIO({ kind: "found", status: "blocked", source: "ro" }, "task_started", IDLE_SCREEN);
      const state = store.get("lane-1");
      assert.equal(processGoal("lane-1", AGENT, state, config, store, 1000, f.io), Outcome.STUCK);
      assert.equal(f.screenReads(), 0);
      assert.deepEqual(f.sent, []);
    });
  });

  test("hands non-stalled goals back to the banner retry", () => {
    withStore((store) => {
      for (const goal of [
        { kind: "found", status: "paused", source: "ro" },
        { kind: "found", status: "active", source: "ro" },
        { kind: "none" },
        { kind: "error", error: "boom" },
      ] as GoalLookup[]) {
        const f = fakeIO(goal, "task_complete", IDLE_SCREEN);
        const state = store.get("lane-1");
        assert.equal(processGoal("lane-1", AGENT, state, config, store, 1000, f.io), null);
        assert.deepEqual(f.sent, []);
      }
    });
  });

  test("skips agents without a codex session id", () => {
    withStore((store) => {
      const f = fakeIO({ kind: "found", status: "blocked", source: "ro" }, "task_complete", IDLE_SCREEN);
      const agent = { ...AGENT, agent_session: undefined };
      assert.equal(processGoal("lane-1", agent, store.get("lane-1"), config, store, 1000, f.io), null);
      assert.deepEqual(f.sent, []);
    });
  });

  test("dry-run records the attempt without sending", () => {
    withStore((store) => {
      const dry = loadConfig({ dryRun: true });
      const f = fakeIO({ kind: "found", status: "usage_limited", source: "ro" }, "task_complete", IDLE_SCREEN);
      const state = store.get("lane-1");
      assert.equal(processGoal("lane-1", AGENT, state, dry, store, 1000, f.io), Outcome.STUCK);
      assert.deepEqual(f.sent, []);
      assert.equal(state.total_goal_resumes, 1);
    });
  });
});

describe("goal resume config", () => {
  test("defaults", () => {
    const c = loadGoalResumeConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.prompt, "/goal resume");
    assert.deepEqual(c.statuses, ["blocked", "usage_limited"]);
    assert.equal(c.minInterval, 300);
    assert.equal(c.maxInterval, 1800);
    assert.equal(c.resetAfter, 3600);
    assert.equal(c.rolloutTailBytes, 2 * 1024 * 1024);
    assert.ok(c.codexHome.length > 0);
  });

  test("file values, env overrides and home expansion", () => {
    const saved = { ...process.env };
    try {
      process.env.HERDR_AUTO_RETRY_GOAL_RESUME = "0";
      process.env.HERDR_AUTO_RETRY_GOAL_STATUSES = "Blocked";
      process.env.HERDR_AUTO_RETRY_GOAL_MIN_INTERVAL = "60";
      const c = loadGoalResumeConfig({ enabled: true, maxInterval: 900, codexHome: "~/x-codex" });
      assert.equal(c.enabled, false);
      assert.deepEqual(c.statuses, ["blocked"]);
      assert.equal(c.minInterval, 60);
      assert.equal(c.maxInterval, 900);
      assert.equal(c.codexHome, path.join(os.homedir(), "x-codex"));
    } finally {
      process.env = saved;
    }
  });
});
