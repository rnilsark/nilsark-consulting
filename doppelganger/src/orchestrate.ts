import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { insertQueue, type Db } from './db.ts';
import type { OutFile } from './types.ts';

// Dispatch-and-await: the primitive a TS orchestrator (e.g. finance.ts) uses to run a judgment agent
// (classifier/reconciler/summarizer) for one task and read back its structured `result`. The daemon's
// dispatcher loop is what actually picks + runs the queued row, so the await must NOT block the event
// loop — it polls between `await sleep(...)` yields, letting the dispatcher tick in between.

export type TerminalStatus = 'success' | 'flagged' | 'error' | 'died';

export interface RunResult {
  /** pending = queued not yet picked; running = picked, worker live; done = terminal; lost = vanished
   *  before we ever saw a run_id (validRow dropped it). */
  state: 'pending' | 'running' | 'done' | 'lost';
  runId?: string;
  status?: TerminalStatus;
  result?: unknown;
}

/**
 * PURE inspection of a dispatched run from the DB + its out.json. `knownRunId` is the run_id we last
 * observed on the queue row (the row is deleted when the run finalizes, so we must remember it). No
 * side effects; `runsDir` is injectable for tests.
 */
export function inspectRun(
  db: Db,
  queueId: number,
  knownRunId: string | null,
  runsDir: string = config.runsDir,
): RunResult {
  const row = db.prepare('SELECT run_id FROM queue WHERE id = ?').get(queueId) as
    | { run_id: string | null }
    | undefined;

  if (row) {
    // Still queued. A non-null run_id means the dispatcher picked it (worker running); null means
    // pending, OR it was reset for a retry — either way keep the last run_id we saw.
    return { state: row.run_id ? 'running' : 'pending', runId: row.run_id ?? knownRunId ?? undefined };
  }

  // Row gone → the run finalized (worker) or was given up (reap). If we never saw a run_id, the
  // dispatcher dropped it (unknown agent / caller not allowed) before picking — treat as lost.
  if (!knownRunId) return { state: 'lost' };

  const ev = db
    .prepare(`SELECT status FROM events WHERE run_id = ? AND kind IN ('finished','died') ORDER BY id DESC LIMIT 1`)
    .get(knownRunId) as { status: string } | undefined;

  let result: unknown;
  const outPath = path.join(runsDir, knownRunId, 'out.json');
  if (existsSync(outPath)) {
    try {
      result = (JSON.parse(readFileSync(outPath, 'utf8')) as OutFile).result;
    } catch {
      // a broken out.json just means no structured result — the status already tells the story
    }
  }
  return { state: 'done', runId: knownRunId, status: (ev?.status as TerminalStatus) ?? 'died', result };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DispatchOptions {
  pollMs?: number;
  timeoutMs?: number;
  runsDir?: string;
  sleepFn?: (ms: number) => Promise<void>;
  /** Parent run_id, so the dispatched run is a CHILD (constellation edge + registry caller check). */
  parent?: string | null;
}

/**
 * Enqueue a top-level run of `agent` with `task` and await its terminal result. Returns the terminal
 * `RunResult` (success/flagged/error/died with the structured `result`), `lost` if the dispatcher
 * dropped it, or — on timeout — the last non-terminal state so the caller can decide. Never throws;
 * never blocks the event loop (polls via `sleepFn`, injectable for tests).
 */
export async function dispatchAndAwait(
  db: Db,
  agent: string,
  task: string,
  opts: DispatchOptions = {},
): Promise<RunResult> {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const sleepFn = opts.sleepFn ?? sleep;

  const queueId = insertQueue(db, { agent, task, parent: opts.parent ?? null });
  let knownRunId: string | null = null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const r = inspectRun(db, queueId, knownRunId, opts.runsDir);
    if (r.runId) knownRunId = r.runId;
    if (r.state === 'done' || r.state === 'lost') return r;
    await sleepFn(pollMs);
  }
  return { state: 'running', runId: knownRunId ?? undefined }; // timed out — caller decides
}
