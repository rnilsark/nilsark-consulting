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

export function insertChatMessage(
  db: Db,
  msg: {
    channel: string;
    conversation_id: string;
    sender: string;
    direction: ChatDirection;
    text: string;
    ts?: string;
  },
): void {
  db.prepare(
    `INSERT INTO chat_messages (channel, conversation_id, sender, direction, text, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(msg.channel, msg.conversation_id, msg.sender, msg.direction, msg.text, msg.ts ?? now());
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
