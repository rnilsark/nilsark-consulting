import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDirs } from './config.ts';
import { insertEvent, now, openDb, type Db } from './db.ts';
import { agentsDir, callableBy, loadRegistry } from './registry.ts';
import type { Order, OutFile, QueueRow, Registry, RunStatus } from './types.ts';

export interface Outcome {
  status: RunStatus;
  summary: string;
  orders: Order[];
  cost: number | null;
}

export function buildPrompt(row: QueueRow, outPath: string, registry: Registry): string {
  const callable = callableBy(registry, row.agent).map((a) => a.name);
  return [
    `You are running headless as the role "${row.agent}" in the Doppelgänger runtime.`,
    ``,
    `## Task`,
    row.task,
    ``,
    `## Contract`,
    `When you are done you MUST write a JSON file to exactly this path: ${outPath}`,
    `Format:`,
    `{`,
    `  "status": "success" | "flagged" | "error",`,
    `  "summary": "your own words about what you did",`,
    `  "orders": [ { "agent": "...", "task": "..." } ]`,
    `}`,
    `"orders" is optional and puts new work on the queue. Agents you may order: ${
      callable.length > 0 ? callable.join(', ') : '(none)'
    }.`,
    `Write artifacts (e.g. briefs) under ${config.home} — never into the repo.`,
  ].join('\n');
}

export function runClaude(
  row: QueueRow,
  prompt: string,
  registry: Registry,
): { cost: number | null; failure: string | null } {
  const agent = registry.agents[row.agent];
  const args = ['-p', prompt, '--output-format', 'json'];
  if (agent?.tools) args.push('--allowedTools', agent.tools);
  if (agent?.model) args.push('--model', agent.model);

  const res = spawnSync(config.claudeBin, args, {
    cwd: path.join(agentsDir, row.agent),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DOPPELGANGER_HOME: config.home },
  });

  if (res.error) return { cost: null, failure: `claude failed to start: ${res.error.message}` };

  let cost: number | null = null;
  try {
    const parsed = JSON.parse(res.stdout) as { total_cost_usd?: number; is_error?: boolean };
    if (typeof parsed.total_cost_usd === 'number') cost = parsed.total_cost_usd;
    if (parsed.is_error) return { cost, failure: 'claude reported is_error' };
  } catch {
    return { cost: null, failure: `claude stdout was not JSON (exit ${res.status})` };
  }
  if (res.status !== 0) return { cost, failure: `claude exited ${res.status}` };
  return { cost, failure: null };
}

export function readOutcome(outPath: string, cost: number | null, failure: string | null): Outcome {
  if (!existsSync(outPath)) {
    return {
      status: 'error',
      summary: failure ?? `agent never wrote ${path.basename(outPath)}`,
      orders: [],
      cost,
    };
  }
  let out: OutFile;
  try {
    out = JSON.parse(readFileSync(outPath, 'utf8')) as OutFile;
  } catch {
    return { status: 'error', summary: 'out.json was not valid JSON', orders: [], cost };
  }
  if (!['success', 'flagged', 'error'].includes(out.status) || typeof out.summary !== 'string') {
    return { status: 'error', summary: 'out.json did not follow the contract', orders: [], cost };
  }
  const orders = (Array.isArray(out.orders) ? out.orders : []).filter(
    (o): o is Order => typeof o?.agent === 'string' && typeof o?.task === 'string',
  );
  return { status: out.status, summary: out.summary, orders, cost };
}

/** Completion in ONE transaction: finished event + child orders + delete own queue row. */
export function finalize(db: Db, row: QueueRow, outcome: Outcome): void {
  const orders = outcome.status === 'error' ? [] : outcome.orders; // poisonous task → no children, no retry
  db.transaction(() => {
    insertEvent(db, {
      run_id: row.run_id!,
      kind: 'finished',
      agent: row.agent,
      task: row.task,
      parent: row.parent,
      status: outcome.status,
      cost: outcome.cost,
      summary: outcome.summary,
    });
    for (const order of orders) {
      db.prepare(
        `INSERT INTO queue (agent, task, status, parent, created_at) VALUES (?, ?, 'pending', ?, ?)`,
      ).run(order.agent, order.task, row.run_id, now());
    }
    db.prepare(`DELETE FROM queue WHERE id = ?`).run(row.id);
  })();
}

function main(): void {
  const queueId = Number(process.argv[2]);
  if (!Number.isInteger(queueId)) {
    console.error('usage: worker.ts <queueId>');
    process.exit(2);
  }
  ensureDirs();
  const db = openDb(config.dbPath);
  const row = db.prepare(`SELECT * FROM queue WHERE id = ?`).get(queueId) as QueueRow | undefined;
  if (!row || row.status !== 'running' || !row.run_id) {
    console.error(`[worker] queue row ${queueId} missing or not running, exiting`);
    process.exit(1);
  }

  const registry = loadRegistry();
  const runDir = path.join(config.runsDir, row.run_id);
  mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, 'out.json');

  console.log(`[worker] run=${row.run_id} agent=${row.agent} task=${row.task}`);
  const { cost, failure } = runClaude(row, buildPrompt(row, outPath, registry), registry);
  const outcome = readOutcome(outPath, cost, failure);
  finalize(db, row, outcome);
  console.log(`[worker] finished status=${outcome.status} cost=${outcome.cost ?? '?'} — ${outcome.summary}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
