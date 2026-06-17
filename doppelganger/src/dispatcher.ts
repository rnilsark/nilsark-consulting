import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { config } from './config.ts';
import { eventAgentForRun, insertEvent, now, selectPendingFifo, selectRunning, type Db } from './db.ts';
import type { Registry } from './types.ts';
import type { QueueRow } from './types.ts';

export type SpawnWorker = (queueId: number, runId: string) => number | undefined;

const workerPath = path.join(import.meta.dirname, 'worker.ts');

/** Default spawn: own process, logs to runs/<run_id>/worker.log, never waits. */
export const spawnWorkerProcess: SpawnWorker = (queueId, runId) => {
  const runDir = path.join(config.runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const log = openSync(path.join(runDir, 'worker.log'), 'a');
  const child = spawn(process.execPath, [workerPath, String(queueId)], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  return child.pid;
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reap: dead workers → died event, then retry (attempts++) or give up. */
export function reap(db: Db, maxAttempts = config.maxAttempts): void {
  for (const row of selectRunning(db)) {
    if (row.pid !== null && pidAlive(row.pid)) continue; // alive → leave alone no matter how long
    insertEvent(db, {
      run_id: row.run_id!,
      kind: 'died',
      agent: row.agent,
      task: row.task,
      parent: row.parent,
    });
    const attempts = row.attempts + 1;
    if (attempts < maxAttempts) {
      db.prepare(
        `UPDATE queue SET status = 'pending', run_id = NULL, pid = NULL, running_since = NULL, attempts = ? WHERE id = ?`,
      ).run(attempts, row.id);
      console.error(`[dispatcher] worker died (queue=${row.id}, agent=${row.agent}), retry ${attempts}/${maxAttempts}`);
    } else {
      db.prepare(`DELETE FROM queue WHERE id = ?`).run(row.id);
      console.error(`[dispatcher] worker died (queue=${row.id}, agent=${row.agent}), giving up after ${attempts} attempts`);
    }
  }
}

/** Validate queue row against the registry: agent exists; child orders respect can_be_called_by. */
function validRow(db: Db, registry: Registry, row: QueueRow): boolean {
  const agent = registry.agents[row.agent];
  if (!agent) {
    console.error(`[dispatcher] unknown agent "${row.agent}" (queue=${row.id}), dropping`);
    return false;
  }
  if (row.parent !== null) {
    const callerAgent = eventAgentForRun(db, row.parent);
    if (!callerAgent || !agent.can_be_called_by.includes(callerAgent)) {
      console.error(
        `[dispatcher] "${callerAgent ?? '?'}" may not call "${row.agent}" (queue=${row.id}), dropping`,
      );
      return false;
    }
  }
  return true;
}

/** Pick FIFO atomically and start workers. Never blocks — full parallelism. */
export function pick(db: Db, registry: Registry, spawnWorker: SpawnWorker = spawnWorkerProcess): void {
  const runningByAgent = new Map<string, number>();
  for (const row of selectRunning(db)) {
    runningByAgent.set(row.agent, (runningByAgent.get(row.agent) ?? 0) + 1);
  }

  for (const row of selectPendingFifo(db)) {
    if (!validRow(db, registry, row)) {
      db.prepare(`DELETE FROM queue WHERE id = ?`).run(row.id);
      continue;
    }

    const agent = registry.agents[row.agent];
    if (agent?.max_concurrency !== undefined) {
      const running = runningByAgent.get(row.agent) ?? 0;
      if (running >= agent.max_concurrency) continue;
    }

    const runId = ulid();
    const res = db
      .prepare(
        `UPDATE queue SET status = 'running', run_id = ?, running_since = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(runId, now(), row.id);
    if (res.changes !== 1) continue; // someone else got there first — atomic pick

    runningByAgent.set(row.agent, (runningByAgent.get(row.agent) ?? 0) + 1);

    const pid = spawnWorker(row.id, runId);
    db.prepare(`UPDATE queue SET pid = ? WHERE id = ?`).run(pid ?? null, row.id);
    insertEvent(db, {
      run_id: runId,
      kind: 'started',
      agent: row.agent,
      task: row.task,
      parent: row.parent,
    });
    console.log(`[dispatcher] started ${row.agent} (queue=${row.id}, run=${runId}, pid=${pid})`);
  }
}

export function tick(db: Db, registry: Registry, spawnWorker: SpawnWorker = spawnWorkerProcess): void {
  reap(db);
  pick(db, registry, spawnWorker);
}

/** Loop ~5s in the same process as the scheduler. Reentrancy-guarded. */
export function startDispatcher(db: Db, registry: Registry): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      tick(db, registry);
    } catch (err) {
      console.error('[dispatcher] tick failed:', err);
    } finally {
      busy = false;
    }
  }, config.dispatchIntervalMs);
}
