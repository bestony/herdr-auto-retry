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
