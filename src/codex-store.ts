/**
 * Read-only access to codex state on disk:
 * - goal status in `<codexHome>/goals_1.sqlite` (table `thread_goals`),
 * - the last turn event in `<codexHome>/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`.
 *
 * Nothing here writes to codex files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type GoalLookup, type TurnEvent, parseLastTurnEvent } from "./codex-goal.js";

export const GOAL_DB_FILE = "goals_1.sqlite";
export const DEFAULT_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
const GOAL_SQL = "SELECT status FROM thread_goals WHERE thread_id = ?";

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * Runs `sql` with one bound parameter against the database at `uri` and
 * returns the rows. Throws when the database cannot be opened or queried.
 */
export type SqliteQuery = (uri: string, sql: string, param: string) => Array<Record<string, unknown>>;

export interface GoalDbUri {
  uri: string;
  /** Label used in logs and in the lookup result. */
  source: "ro" | "immutable";
}

/**
 * Connection URIs, in order of preference.
 *
 * `mode=ro` sees the latest WAL content but can fail with "unable to open
 * database file" when SQLite cannot create the `-shm` file. `immutable=1`
 * always opens but ignores the WAL, so it can return a slightly older status.
 */
export function goalDbUris(dbPath: string): GoalDbUri[] {
  const base = pathToFileURL(dbPath).href;
  return [
    { uri: `${base}?mode=ro`, source: "ro" },
    { uri: `${base}?mode=ro&immutable=1`, source: "immutable" },
  ];
}

function errorMessage(err: unknown): string {
  return (err as any)?.message ? String((err as any).message) : String(err);
}

/** Looks up the goal status of one codex thread (session uuid). */
export function lookupGoalStatus(
  dbPath: string,
  threadId: string,
  query: SqliteQuery = defaultSqliteQuery,
  exists: (p: string) => boolean = fs.existsSync
): GoalLookup {
  if (!isValidSessionId(threadId)) {
    return { kind: "error", error: `invalid session id ${JSON.stringify(threadId)}` };
  }
  if (!exists(dbPath)) {
    return { kind: "error", error: `goal database not found: ${dbPath}` };
  }

  const errors: string[] = [];
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

type NodeSqlite = { DatabaseSync: new (p: string, opts?: Record<string, unknown>) => any };

let nodeSqliteCache: NodeSqlite | null | undefined;

/** Loads `node:sqlite` when the runtime provides it (Node 22.13+ / 23.4+). */
function loadNodeSqlite(): NodeSqlite | null {
  if (nodeSqliteCache !== undefined) return nodeSqliteCache;
  nodeSqliteCache = null;
  try {
    const getBuiltin = (process as any).getBuiltinModule as ((id: string) => unknown) | undefined;
    const mod = getBuiltin?.("node:sqlite") as NodeSqlite | undefined;
    if (mod?.DatabaseSync) nodeSqliteCache = mod;
  } catch {
    // Not available (old Node, or the module is behind a flag).
  }
  return nodeSqliteCache;
}

export function nodeSqliteQuery(uri: string, sql: string, param: string): Array<Record<string, unknown>> {
  const mod = loadNodeSqlite();
  if (!mod) throw new Error("node:sqlite is not available");
  const db = new mod.DatabaseSync(uri, { readOnly: true });
  try {
    return db.prepare(sql).all(param) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/**
 * Fallback for runtimes without `node:sqlite`: the `sqlite3` CLI.
 * The parameter is validated as a session id before it goes into the SQL text.
 */
export function cliSqliteQuery(uri: string, sql: string, param: string): Array<Record<string, unknown>> {
  if (!isValidSessionId(param)) throw new Error("refusing to inline an unsafe parameter");
  const inlined = sql.replace("?", `'${param}'`);
  const res = spawnSync(process.env.HERDR_AUTO_RETRY_SQLITE_BIN || "sqlite3", ["-json", uri, inlined], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `sqlite3 exited ${res.status}`).trim().slice(0, 300));
  }
  const out = (res.stdout || "").trim();
  if (!out) return [];
  return JSON.parse(out) as Array<Record<string, unknown>>;
}

export function defaultSqliteQuery(uri: string, sql: string, param: string): Array<Record<string, unknown>> {
  return loadNodeSqlite() ? nodeSqliteQuery(uri, sql, param) : cliSqliteQuery(uri, sql, param);
}

/** Name of the sqlite backend in use, for logs. */
export function sqliteBackendName(): string {
  return loadNodeSqlite() ? "node:sqlite" : "sqlite3 cli";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayDir(sessionsDir: string, d: Date, utc: boolean): string {
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utc ? d.getUTCDate() : d.getDate();
  return path.join(sessionsDir, String(y), pad2(m), pad2(day));
}

/**
 * Codex session ids are UUIDv7: the first 48 bits are the creation time in
 * milliseconds. Returns that time, or null when the id does not look like one.
 */
export function uuidV7Millis(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex) || hex[12] !== "7") return null;
  const ms = parseInt(hex.slice(0, 12), 16);
  // Accept 2020-01-01 .. now + 1 day.
  if (ms < 1577836800000 || ms > Date.now() + 86400000) return null;
  return ms;
}

function findInDir(dir: string, suffix: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
  return hit ? path.join(dir, hit) : null;
}

function listDesc(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^\d+$/.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Finds the rollout file of a codex session.
 *
 * First tries the day directories derived from the UUIDv7 timestamp (local
 * and UTC date, +/- 1 day), then walks all day directories, newest first.
 * Results are cached; a cached path is dropped when the file disappears.
 */
export function findRolloutFile(
  codexHome: string,
  sessionId: string,
  cache: Map<string, string> = rolloutPathCache
): string | null {
  const cached = cache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  cache.delete(sessionId);
  if (!isValidSessionId(sessionId)) return null;

  const sessionsDir = path.join(codexHome, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  const tried = new Set<string>();

  const ms = uuidV7Millis(sessionId);
  if (ms !== null) {
    for (const offset of [0, -86400000, 86400000]) {
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
    for (const m of listDesc(path.join(sessionsDir, y))) {
      for (const d of listDesc(path.join(sessionsDir, y, m))) {
        const dir = path.join(sessionsDir, y, m, d);
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

export const rolloutPathCache: Map<string, string> = new Map();

/** Reads at most `maxBytes` from the end of a file. */
export function readFileTail(file: string, maxBytes: number): { text: string; startsMidLine: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, maxBytes));
    const length = size - start;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString("utf8"), startsMidLine: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Last turn lifecycle event of a rollout file, or null when none is in the tail. */
export function readLastTurnEvent(file: string, maxBytes: number): TurnEvent | null {
  const { text, startsMidLine } = readFileTail(file, maxBytes);
  return parseLastTurnEvent(text, startsMidLine);
}
