// Pure fold from the append-only events log to the dashboard state.
// v1 reads only `events` in a window: fold per run_id, a lone `started` = running
// (pulse), never guess "stale" via timeout. Shared types keep the FE payload from
// drifting away from the DB contract.

import type { EventKind, EventRow, RunStatus } from './types.ts';

export type WindowKey = 'hour' | 'today' | 'live';

export type NodeStatus = 'running' | 'done' | 'flagged' | 'error' | 'idle';

/** The constellation's center node: the runtime/orchestrator that lays top-level orders. */
export const CORE = 'core';

export type NodeKind = 'judgment' | 'orchestrator';

/** Which agents are deterministic TS orchestrators (hubs), not LLM judgment stars. Mirrors registry.yaml `kind`. */
const ORCHESTRATORS = new Set(['intake', 'statement', 'digest']);

/** Domain groupings — the structural "star formations". Each becomes a cluster tethered to CORE via a hub. */
export const DOMAINS: Array<{ name: string; members: string[] }> = [
  // `entrepreneur` is an OFFLOADED sub-system — the dissolved entrepreneur agent, now six nodes. It's
  // the one cluster drawn as a trunk-and-branch. `calendar`/`comms` are personal nodes wired direct.
  { name: 'entrepreneur', members: ['inbox', 'intake', 'classifier', 'statement', 'reconciler', 'digest'] },
  { name: 'calendar', members: ['planner'] },
  { name: 'comms', members: ['triage', 'chat'] },
];
const domainOf = (name: string): string | null => DOMAINS.find((d) => d.members.includes(name))?.name ?? null;

export interface AgentState {
  name: string;
  /** `judgment` = LLM star; `orchestrator` = deterministic TS hub. */
  kind: NodeKind;
  /** Domain this agent belongs to (the star formation it orbits), or null if ungrouped. */
  cluster: string | null;
  status: NodeStatus;
  running: boolean;
  task: string;
  summary: string;
  /** Cost of the last completed run, null when none. */
  cost: number | null;
  /** Completed runs in the window. */
  count: number;
  ts: string | null;
  /** Last 8 finished costs, oldest first (sparkline). */
  history: number[];
}

export interface EdgeState {
  from: string;
  to: string;
  active: boolean;
}

export interface FeedRow {
  id: number;
  ts: string;
  kind: EventKind;
  status: RunStatus | null;
  agent: string;
  text: string;
  cost: number | null;
  /** A `started` whose run was ordered by another run (parent != null). */
  delegated: boolean;
}

export interface DashboardState {
  agents: AgentState[];
  edges: EdgeState[];
  stats: { runs: number; cost: number; active: number };
  feed: FeedRow[];
  /** Domain star-formations (only those with a present member), for the FE to cluster around a hub. */
  clusters: Array<{ name: string; members: string[] }>;
}

/** Inclusive lower bound (ISO) for a window; events store ISO UTC so string compare works. */
export function windowSince(win: WindowKey, now: Date = new Date()): string {
  if (win === 'hour') return new Date(now.getTime() - 3600_000).toISOString();
  if (win === 'today') {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.toISOString();
  }
  return new Date(now.getTime() - 24 * 3600_000).toISOString();
}

interface Run {
  runId: string;
  agent: string;
  parent: string | null;
  started?: EventRow;
  terminal?: EventRow;
}

function foldRuns(events: EventRow[]): Map<string, Run> {
  const runs = new Map<string, Run>();
  for (const ev of [...events].sort((a, b) => a.id - b.id)) {
    let run = runs.get(ev.run_id);
    if (!run) {
      run = { runId: ev.run_id, agent: ev.agent, parent: ev.parent };
      runs.set(ev.run_id, run);
    }
    if (ev.parent != null) run.parent = ev.parent;
    if (ev.kind === 'started') run.started = ev;
    else run.terminal = ev;
  }
  return runs;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function project(
  windowEvents: EventRow[],
  todayEvents: EventRow[],
  registryAgents: string[],
): DashboardState {
  const runs = foldRuns(windowEvents);

  // Node list is fully dynamic: registry ∪ agents seen in the window.
  const names = new Set(registryAgents);
  for (const ev of windowEvents) names.add(ev.agent);

  const agents: AgentState[] = [...names].map((name) => {
    const own = [...runs.values()].filter((r) => r.agent === name);
    const live = own.filter((r) => !r.terminal && r.started);
    const running = live.length > 0;
    const terminals = own
      .filter((r) => r.terminal)
      .sort((a, b) => a.terminal!.id - b.terminal!.id);
    const last = terminals.at(-1)?.terminal;
    const liveRun = live.sort((a, b) => a.started!.id - b.started!.id).at(-1);
    const history = terminals
      .map((r) => r.terminal!)
      .filter((t) => t.kind === 'finished' && t.cost != null)
      .map((t) => t.cost as number)
      .slice(-8);

    let status: NodeStatus;
    if (running) status = 'running';
    else if (!last) status = 'idle';
    else if (last.kind === 'died' || last.status === 'error') status = 'error';
    else if (last.status === 'flagged') status = 'flagged';
    else status = 'done';

    return {
      name,
      kind: ORCHESTRATORS.has(name) ? ('orchestrator' as const) : ('judgment' as const),
      cluster: domainOf(name),
      status,
      running,
      task: liveRun?.started?.task ?? last?.task ?? '—',
      summary:
        last?.kind === 'died' ? 'worker died' : (last?.summary ?? ''),
      cost: last?.cost ?? null,
      count: terminals.length,
      ts: liveRun?.started?.ts ?? last?.ts ?? null,
      history,
    };
  });

  // Edges: a spoke core→agent for every node (top-level orders come from the core);
  // agent→agent where a run's parent resolves to another agent's run in the window.
  const edgeMap = new Map<string, EdgeState>();
  const addEdge = (from: string, to: string, active: boolean): void => {
    const key = `${from}→${to}`;
    const existing = edgeMap.get(key);
    if (existing) existing.active = existing.active || active;
    else edgeMap.set(key, { from, to, active });
  };
  const topLevelRunning = new Set(
    [...runs.values()].filter((r) => !r.terminal && r.started && !r.parent).map((r) => r.agent),
  );
  for (const name of names) addEdge(CORE, name, topLevelRunning.has(name));
  for (const run of runs.values()) {
    if (!run.parent) continue;
    const parentAgent = runs.get(run.parent)?.agent;
    if (!parentAgent || parentAgent === run.agent) continue;
    addEdge(parentAgent, run.agent, !run.terminal && !!run.started);
  }

  const finishedToday = todayEvents.filter((e) => e.kind === 'finished');
  const stats = {
    runs: finishedToday.length,
    cost: round2(finishedToday.reduce((sum, e) => sum + (e.cost ?? 0), 0)),
    active: agents.filter((a) => a.running).length,
  };

  const feed: FeedRow[] = [...windowEvents]
    .sort((a, b) => b.id - a.id)
    .slice(0, 80)
    .map((ev) => ({
      id: ev.id,
      ts: ev.ts,
      kind: ev.kind,
      status: ev.status,
      agent: ev.agent,
      text:
        ev.kind === 'finished'
          ? (ev.summary ?? ev.task)
          : ev.kind === 'died'
            ? `worker died — ${ev.task}`
            : ev.task,
      cost: ev.cost,
      delegated: ev.kind === 'started' && ev.parent != null,
    }));

  const present = new Set(names);
  const clusters = DOMAINS.map((d) => ({ name: d.name, members: d.members.filter((m) => present.has(m)) })).filter((c) => c.members.length > 0);

  return { agents, edges: [...edgeMap.values()], stats, feed, clusters };
}
