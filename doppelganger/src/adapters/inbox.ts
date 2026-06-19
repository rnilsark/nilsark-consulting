import { spawnSync } from 'node:child_process';
import { getChannelCursor, insertQueue, setChannelCursor, type Db } from '../db.ts';

/** Adapter source name — what the inbox queue rows are attributed to in the registry. */
export const INBOX_INGEST_SOURCE = 'inbox-ingest';

/** Cursor key in `channel_state`. Not a real channel — distinct from stub/whatsapp/imessage. */
export const INBOX_CURSOR_KEY = 'inbox';

/** Attachment metadata only — filename + mimeType. NO bytes (lazy download happens in the run). */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
}

/** One candidate email, reduced to the metadata the intake run needs to fetch it later. */
export interface InboxMessage {
  messageId: string;
  /** ms-epoch as a string — Gmail's `internalDate`. The cursor compares on this. */
  internalDate: string;
  from: string;
  subject: string;
  snippet: string;
  attachments: AttachmentMeta[];
}

/**
 * Lists new candidate messages since `cursor` (a Gmail `internalDate` in ms, or null on first poll).
 * Deterministic — no LLM. Injectable so tests drive it without a live `gws`.
 */
export type GmailList = (allowlist: string[], cursor: string | null) => InboxMessage[];

/** Build the Gmail `q`: always `has:attachment`; add a `from:(a OR b)` clause when allowlisted. */
export function buildQuery(allowlist: string[]): string {
  const base = 'has:attachment in:inbox';
  if (allowlist.length === 0) return base;
  const from = allowlist.map((s) => s.trim()).filter(Boolean).join(' OR ');
  return from ? `${base} from:(${from})` : base;
}

function runGws(args: string[]): { ok: boolean; stdout: string; detail: string } {
  const res = spawnSync('gws', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const output = (res.stdout ?? '') + (res.stderr ?? '');
  if (res.error) return { ok: false, stdout: '', detail: res.error.message };
  if (res.status !== 0 || /auth|token|unauthenticated|unauthorized|login/i.test(output)) {
    return { ok: false, stdout: res.stdout ?? '', detail: output.slice(0, 200) };
  }
  return { ok: true, stdout: res.stdout ?? '', detail: '' };
}

interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailPart {
  filename?: string;
  mimeType?: string;
  parts?: GmailPart[];
}
interface GmailGetResponse {
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: GmailHeader[]; parts?: GmailPart[] } & GmailPart;
}

/**
 * Default lister: shells out to `gws gmail`. Lists message ids matching the query, then fetches each
 * one's metadata (headers + attachment parts) — metadata ONLY, never the attachment bytes. Lazy
 * download of the bytes happens later inside `entrepreneur:intake`, one message per run, so each
 * document gets an isolated context. Returns messages newer than `cursor` (strict `internalDate >`).
 */
export const defaultGmailList: GmailList = (allowlist, cursor) => {
  const q = buildQuery(allowlist);
  const listParams = JSON.stringify({ userId: 'me', q, maxResults: 50 });
  const list = runGws(['gmail', 'users', 'messages', 'list', '--params', listParams, '--format', 'json']);
  if (!list.ok) {
    console.error(`[inbox-ingest] gmail list failed: ${list.detail}`);
    return [];
  }
  let ids: string[];
  try {
    const parsed = JSON.parse(list.stdout) as { messages?: Array<{ id?: string }> };
    ids = (parsed.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  } catch {
    console.error('[inbox-ingest] gmail list returned non-JSON');
    return [];
  }

  const since = cursor ? Number(cursor) : 0;
  const out: InboxMessage[] = [];
  for (const id of ids) {
    const getParams = JSON.stringify({ userId: 'me', id, format: 'metadata' });
    const got = runGws(['gmail', 'users', 'messages', 'get', '--params', getParams, '--format', 'json']);
    if (!got.ok) {
      console.error(`[inbox-ingest] gmail get ${id} failed: ${got.detail}`);
      continue;
    }
    let msg: GmailGetResponse;
    try {
      msg = JSON.parse(got.stdout) as GmailGetResponse;
    } catch {
      console.error(`[inbox-ingest] gmail get ${id} returned non-JSON`);
      continue;
    }
    if (Number(msg.internalDate ?? '') <= since) continue; // already past the cursor → not new
    out.push(parseGmailMessage(id, msg));
  }
  return out;
};

function header(headers: GmailHeader[] | undefined, name: string): string {
  const h = (headers ?? []).find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** Walk the MIME tree collecting parts that carry a filename (the actual attachments). */
function collectAttachments(part: GmailPart | undefined, acc: AttachmentMeta[]): void {
  if (!part) return;
  if (part.filename && part.mimeType && !part.mimeType.startsWith('multipart/')) {
    acc.push({ filename: part.filename, mimeType: part.mimeType });
  }
  for (const child of part.parts ?? []) collectAttachments(child, acc);
}

/** Reduce a Gmail metadata response to the InboxMessage we enqueue. Exported for tests. */
export function parseGmailMessage(id: string, msg: GmailGetResponse): InboxMessage {
  const attachments: AttachmentMeta[] = [];
  collectAttachments(msg.payload, attachments);
  return {
    messageId: id,
    internalDate: msg.internalDate ?? '',
    from: header(msg.payload?.headers, 'From'),
    subject: header(msg.payload?.headers, 'Subject'),
    snippet: msg.snippet ?? '',
    attachments,
  };
}

/**
 * Dumb ingest poll (no LLM): list new `has:attachment` mail from allowlisted senders, enqueue one
 * `inbox` row per message carrying METADATA ONLY (`{messageId, from, subject, snippet, attachments}`)
 * — never the attachment bytes — and advance the cursor to the newest `internalDate` seen. The bytes
 * are lazily fetched later, one message per `entrepreneur:intake` run, so each document gets an
 * isolated context. The `inbox` agent (haiku) is the gate that decides intake vs reconcile; this
 * adapter just gets candidates onto the queue.
 */
export function ingestInbox(db: Db, allowlist: string[] = [], list: GmailList = defaultGmailList): void {
  const cursor = getChannelCursor(db, INBOX_CURSOR_KEY);
  if (cursor === null) {
    // First poll ever: prime the watermark to "now" and enqueue NOTHING. Never replay the inbox
    // history — everything predating the inbox path going live is already owned by the daily backstop
    // run. Mirrors the whatsapp/imessage channels, whose watermark also starts at "now".
    setChannelCursor(db, INBOX_CURSOR_KEY, String(Date.now()));
    console.log('[inbox-ingest] first poll — watermark primed to now, no history replayed');
    return;
  }
  const messages = list(allowlist, cursor);
  if (messages.length === 0) return;

  const floor = cursor ? Number(cursor) : 0;
  let maxInternal = floor;
  let enqueued = 0;
  // Oldest-first so the newest internalDate is the last cursor we commit.
  const ordered = [...messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  for (const msg of ordered) {
    const internal = Number(msg.internalDate);
    if (cursor !== null && Number.isFinite(internal) && internal <= floor) continue; // already seen
    insertQueue(db, {
      agent: 'inbox',
      task: JSON.stringify({
        messageId: msg.messageId,
        from: msg.from,
        subject: msg.subject,
        snippet: msg.snippet,
        attachments: msg.attachments,
      }),
      parent: null,
    });
    enqueued++;
    if (Number.isFinite(internal) && internal > maxInternal) maxInternal = internal;
  }

  if (maxInternal > floor) setChannelCursor(db, INBOX_CURSOR_KEY, String(maxInternal));
  if (enqueued > 0) console.log(`[inbox-ingest] enqueued ${enqueued} message(s) → inbox`);
}
