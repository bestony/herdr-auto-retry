export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  pane_id: string;
  workspace_id?: string;
  agent?: string;
  display_agent?: string;
  name?: string;
  agent_status?: AgentStatus;
  status?: AgentStatus;
  title?: string;
  agent_session?: AgentSession;
}

export interface AgentSession {
  agent?: string;
  kind?: string;
  source?: string;
  value?: string;
}

export enum Outcome {
  ABSENT = "absent",
  PRESENT = "present",
  STUCK = "stuck",
}

export type CadenceTier = "busy" | "active" | "idle";

export interface TargetStateData {
  first_seen_at: number;
  last_match_at: number;
  miss_count: number;
  hit_count: number;
  next_retry_at: number;
  last_retry_at?: number;
  total_retries?: number;
  last_matched_pattern?: string;
  /** Last codex goal status observed for this target (e.g. "blocked"). */
  last_goal_status?: string;
  /** Unix seconds of the last `/goal resume` attempt. */
  last_goal_resume_at?: number;
  /** Earliest unix seconds at which the next `/goal resume` may be sent. */
  next_goal_resume_at?: number;
  /** Consecutive resume attempts in the current stall episode. */
  goal_resume_count?: number;
  /** Lifetime number of `/goal resume` attempts. */
  total_goal_resumes?: number;
  /** Last skip reason logged for a stalled goal (used to avoid log spam). */
  last_goal_skip_reason?: string;
}

export interface PluginConfig {
  agents: string[];
  matches: string[];
  prompt: string;
  minWait: number;
  maxWait: number;
  missReset: number;
  staleAfter: number;
  intervals: {
    busy: number;
    active: number;
    idle: number;
  };
  workers: number;
  verbose: boolean;
  dryRun: boolean;
  goalResume: GoalResumeConfig;
}

export interface GoalResumeConfig {
  /** Resume stalled codex goals with `/goal resume`. */
  enabled: boolean;
  /** Prompt sent to resume a stalled goal. */
  prompt: string;
  /** Goal statuses that trigger a resume. */
  statuses: string[];
  /** Minimum seconds between two resumes of the same agent. */
  minInterval: number;
  /** Maximum backoff in seconds when a goal re-stalls repeatedly. */
  maxInterval: number;
  /** A stall seen this many seconds after the last resume starts a fresh episode. */
  resetAfter: number;
  /** Codex home directory (holds goals_1.sqlite and sessions/). */
  codexHome: string;
  /** Bytes read from the end of the rollout file to find the last turn event. */
  rolloutTailBytes: number;
  /** Screen text that must be visible: the idle composer placeholder. */
  idleMarkers: string[];
  /** Screen text that means a turn is still in progress. */
  busyMarkers: string[];
  /** Screen text that means a selection list or modal is open. */
  modalMarkers: string[];
}

export class ScanResult {
  present: number = 0;
  stuck: number = 0;

  get tier(): CadenceTier {
    if (this.stuck > 0) return "busy";
    if (this.present > 0) return "active";
    return "idle";
  }

  describe(): string {
    return `${this.present} target(s) present, ${this.stuck} stuck (cadence: ${this.tier})`;
  }
}
