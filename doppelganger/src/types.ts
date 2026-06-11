// The DB contract — shared by the backend and the future dashboard. Never drifts apart.

export type QueueStatus = 'pending' | 'running';
export type EventKind = 'started' | 'finished' | 'died';
export type RunStatus = 'success' | 'flagged' | 'error';

export interface QueueRow {
  id: number;
  agent: string;
  task: string;
  status: QueueStatus;
  parent: string | null;
  run_id: string | null;
  pid: number | null;
  running_since: string | null;
  attempts: number;
  created_at: string;
}

export interface EventRow {
  id: number;
  run_id: string;
  kind: EventKind;
  ts: string;
  agent: string;
  task: string;
  parent: string | null;
  status: RunStatus | null;
  cost: number | null;
  summary: string | null;
}

export interface Agent {
  name: string;
  can_be_called_by: string[];
  /** allowedTools string the worker passes to `claude -p` (comma-separated). */
  tools: string;
  /** Model the worker passes to `claude -p` (e.g. 'sonnet'). Omitted → CLI default. */
  model?: string;
}

export interface Registry {
  agents: Record<string, Agent>;
}

export interface Order {
  agent: string;
  task: string;
}

/** The agent↔worker contract: the file the agent writes in its run directory. */
export interface OutFile {
  status: RunStatus;
  summary: string;
  orders?: Order[];
}
