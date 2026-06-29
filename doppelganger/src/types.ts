// The DB contract — shared by the backend and the future dashboard. Never drifts apart.

export type QueueStatus = 'pending' | 'running';
export type EventKind = 'started' | 'finished' | 'died';
export type RunStatus = 'success' | 'flagged' | 'error';
export type ChatDirection = 'in' | 'out';

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

export type AgentKind = 'judgment' | 'orchestrator';

export interface Agent {
  name: string;
  can_be_called_by: string[];
  /** allowedTools string the worker passes to `claude -p` (comma-separated). */
  tools: string;
  /** Model the worker passes to `claude -p` (e.g. 'sonnet'). Omitted → CLI default. */
  model?: string;
  /** Maximum number of concurrent runs for this agent. Omitted → unlimited. */
  max_concurrency?: number;
  /**
   * What kind of star this is. `judgment` = an LLM run that decides (the default). `orchestrator` = a
   * deterministic TS coordinator the worker runs instead of claude (sequences a domain's flow). Drives
   * how the constellation renders it: judgment = a star, orchestrator = a hub. Optional on the type
   * (omitted ⇒ judgment); `loadRegistry` always fills it in.
   */
  kind?: AgentKind;
}

export interface Registry {
  agents: Record<string, Agent>;
}

/** Per-agent config surfaced to the dashboard: registry facts + on-disk settings.json. */
export interface AgentConfig {
  model: string | null;
  tools: string;
  callableBy: string[];
  settings: Record<string, unknown>;
}

export interface ChatMessageRow {
  id: number;
  channel: string;
  conversation_id: string;
  sender: string;
  direction: ChatDirection;
  text: string;
  ts: string;
}

export interface OutboxRow {
  id: number;
  channel: string;
  conversation_id: string;
  text: string;
  status: 'pending' | 'sent';
  created_at: string;
}

export interface Order {
  agent: string;
  task: string;
}

/** A message the worker should deliver back into a conversation via its channel. */
export interface Reply {
  conversationId: string;
  text: string;
  /** Channel name; omitted → worker resolves it from the conversation's inbound history. */
  channel?: string;
}

/** The agent↔worker contract: the file the agent writes in its run directory. */
export interface OutFile {
  status: RunStatus;
  summary: string;
  orders?: Order[];
  replies?: Reply[];
  /** Optional structured judgment a dispatching orchestrator consumes (e.g. a classifier's fields). */
  result?: unknown;
}
