import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  ChatDirection,
  ChatMessageRow,
  EventKind,
  EventRow,
  OutboxRow,
  QueueRow,
  RunStatus,
} from './types.ts';

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
): number {
  const info = db
    .prepare(`INSERT INTO queue (agent, task, status, parent, created_at) VALUES (?, ?, 'pending', ?, ?)`)
    .run(row.agent, row.task, row.parent, now());
  return Number(info.lastInsertRowid);
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

export function insertChatMessage(
  db: Db,
  msg: {
    channel: string;
    conversation_id: string;
    sender: string;
    direction: ChatDirection;
    text: string;
    ts?: string;
    is_direct?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO chat_messages (channel, conversation_id, sender, direction, text, ts, is_direct)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.channel,
    msg.conversation_id,
    msg.sender,
    msg.direction,
    msg.text,
    msg.ts ?? now(),
    msg.is_direct ? 1 : 0,
  );
}

/** Last n messages in a conversation, oldest-first, for injecting as the chat agent's memory. */
export function recentChatMessages(db: Db, conversationId: string, n: number): ChatMessageRow[] {
  const rows = db
    .prepare(`SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
    .all(conversationId, n) as ChatMessageRow[];
  return rows.reverse();
}

/**
 * The channel of the most recent INBOUND message for a conversation, or undefined if we never
 * received from it. The reply-routing guard: we only send back into threads we've heard from.
 */
export function inboundConversationChannel(db: Db, conversationId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT channel FROM chat_messages
       WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId) as { channel: string } | undefined;
  return row?.channel;
}

/**
 * The operator's own direct (1:1) thread to push proactive messages into: the most recent INBOUND
 * `is_direct` message whose sender matches the operator's number (compared on digits, so `+46…`,
 * `46…`, and `46…@s.whatsapp.net` are equal). Returns the conversation_id + the channel it arrived
 * on, or undefined if the operator has never DM'd us (push target unknown until their first message).
 *
 * Derived live (not stored config) so it self-heals if the channel rotates the thread id. Iterates
 * newest-first and stops at the first match — the operator is the dominant DM partner, so this
 * returns within the first few rows in practice; no dedicated index needed.
 */
export function operatorPushTarget(
  db: Db,
  operatorNumber: string,
): { conversationId: string; channel: string } | undefined {
  const want = operatorNumber.replace(/\D/g, '');
  if (!want) return undefined;
  const stmt = db.prepare(
    `SELECT conversation_id, channel, sender FROM chat_messages
     WHERE direction = 'in' AND is_direct = 1 ORDER BY id DESC`,
  );
  for (const r of stmt.iterate() as Iterable<{ conversation_id: string; channel: string; sender: string }>) {
    if (r.sender.replace(/\D/g, '') === want) {
      return { conversationId: r.conversation_id, channel: r.channel };
    }
  }
  return undefined;
}

export function insertOutbox(
  db: Db,
  reply: { channel: string; conversation_id: string; text: string },
): void {
  db.prepare(
    `INSERT INTO outbox (channel, conversation_id, text, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(reply.channel, reply.conversation_id, reply.text, now());
}

export function selectPendingOutbox(db: Db): OutboxRow[] {
  return db.prepare(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY id`).all() as OutboxRow[];
}

export function markOutboxSent(db: Db, id: number): void {
  db.prepare(`UPDATE outbox SET status = 'sent' WHERE id = ?`).run(id);
}

/** Newest successful `digest` heartbeat run, for the gate backstop + healthcheck. Forward-only: after a
 *  rename, history under the old name simply doesn't count, so the gate fires one (cheap) extra rollup
 *  until the first `digest` success lands — a null result reads as "fresh deploy", never an alert. */
export function lastFinanceRunSuccess(db: Db): { ts: string } | undefined {
  return db
    .prepare(
      `SELECT ts FROM events WHERE agent = 'digest' AND kind = 'finished' AND status = 'success' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { ts: string } | undefined;
}

export function getChannelCursor(db: Db, channel: string): string | null {
  const row = db.prepare(`SELECT cursor FROM channel_state WHERE channel = ?`).get(channel) as
    | { cursor: string | null }
    | undefined;
  return row?.cursor ?? null;
}

export function setChannelCursor(db: Db, channel: string, cursor: string): void {
  db.prepare(
    `INSERT INTO channel_state (channel, cursor) VALUES (?, ?)
     ON CONFLICT(channel) DO UPDATE SET cursor = excluded.cursor`,
  ).run(channel, cursor);
}
