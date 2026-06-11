import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { EventKind, EventRow, QueueRow, RunStatus } from './types.ts';

const schemaPath = path.join(import.meta.dirname, '..', 'schema.sql');

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function insertQueue(
  db: Db,
  row: { agent: string; task: string; parent: string | null },
): void {
  db.prepare(
    `INSERT INTO queue (agent, task, status, parent, created_at) VALUES (?, ?, 'pending', ?, ?)`,
  ).run(row.agent, row.task, row.parent, now());
}

export function getQueueRow(db: Db, id: number): QueueRow | undefined {
  return db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id) as QueueRow | undefined;
}

export function selectPendingFifo(db: Db): QueueRow[] {
  return db.prepare(`SELECT * FROM queue WHERE status = 'pending' ORDER BY id`).all() as QueueRow[];
}

export function selectRunning(db: Db): QueueRow[] {
  return db.prepare(`SELECT * FROM queue WHERE status = 'running'`).all() as QueueRow[];
}

export function insertEvent(
  db: Db,
  ev: {
    run_id: string;
    kind: EventKind;
    agent: string;
    task: string;
    parent?: string | null;
    status?: RunStatus | null;
    cost?: number | null;
    summary?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO events (run_id, kind, ts, agent, task, parent, status, cost, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.run_id,
    ev.kind,
    now(),
    ev.agent,
    ev.task,
    ev.parent ?? null,
    ev.status ?? null,
    ev.cost ?? null,
    ev.summary ?? null,
  );
}

export function selectEvents(db: Db, runId: string): EventRow[] {
  return db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY id`).all(runId) as EventRow[];
}

export function eventAgentForRun(db: Db, runId: string): string | undefined {
  const row = db.prepare(`SELECT agent FROM events WHERE run_id = ? LIMIT 1`).get(runId) as
    | { agent: string }
    | undefined;
  return row?.agent;
}
