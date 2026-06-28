import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { getChannelCursor, insertQueue, setChannelCursor, type Db } from '../db.ts';

/** Adapter source name — what the inbox queue rows are attributed to in the registry. */
export const INBOX_INGEST_SOURCE = 'inbox-ingest';

/** Cursor key in `channel_state`. Not a real channel — distinct from stub/whatsapp/imessage. */
export const INBOX_CURSOR_KEY = 'inbox';

/** Attachment metadata only — NO bytes (lazy download via `downloadAttachment`). `attachmentId` is
 *  Gmail's handle for fetching the bytes later. */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  attachmentId: string;
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
  if (res.error) return { ok: false, stdout: '', detail: res.error.message };
  // Status only — do NOT content-match for auth keywords. A message's own headers and subject
  // legitimately contain words like "Authentication-Results", "login", or "token", and a content
  // match would mistake every such email for an auth failure and silently drop it (basically all
  // mail has an Authentication-Results header). A real gws auth failure exits non-zero; the
  // healthcheck adapter is what alerts on auth, and a bad exit here just means "no candidates".
  if (res.status !== 0) {
    const output = (res.stdout ?? '') + (res.stderr ?? '');
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
  body?: { attachmentId?: string };
}
interface GmailGetResponse {
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: GmailHeader[]; parts?: GmailPart[] } & GmailPart;
}

/**
 * Default lister: shells out to `gws gmail`. Lists message ids matching the query, then fetches each
 * one's headers + MIME structure. Uses `format: full` (not `metadata`) because `metadata` omits the
 * parts tree, so attachment filenames wouldn't be visible. `full` still does NOT pull the attachment
 * BYTES — attachments are returned as `attachmentId` references; only the email body is inlined, and
 * that is read-and-discarded here (never enqueued). The lazy attachment download still happens later
 * inside `entrepreneur:intake`, one message per run, so each document gets an isolated context.
 * Returns messages newer than `cursor` (strict `internalDate >`).
 */
/**
 * Shared list+fetch: run the `q`, then `get` each message `full` and parse it to an InboxMessage.
 * Both the cursor poll (defaultGmailList) and the daily sweep (defaultGmailSweep) build on this — the
 * only difference between them is the query and how they decide which results count as "new".
 */
function fetchMessages(q: string, maxResults: number, tag: string): InboxMessage[] {
  const listParams = JSON.stringify({ userId: 'me', q, maxResults });
  const list = runGws(['gmail', 'users', 'messages', 'list', '--params', listParams, '--format', 'json']);
  if (!list.ok) {
    console.error(`[${tag}] gmail list failed: ${list.detail}`);
    return [];
  }
  let ids: string[];
  try {
    const parsed = JSON.parse(list.stdout) as { messages?: Array<{ id?: string }> };
    ids = (parsed.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  } catch {
    console.error(`[${tag}] gmail list returned non-JSON`);
    return [];
  }
  const out: InboxMessage[] = [];
  for (const id of ids) {
    const getParams = JSON.stringify({ userId: 'me', id, format: 'full' });
    const got = runGws(['gmail', 'users', 'messages', 'get', '--params', getParams, '--format', 'json']);
    if (!got.ok) {
      console.error(`[${tag}] gmail get ${id} failed: ${got.detail}`);
      continue;
    }
    try {
      out.push(parseGmailMessage(id, JSON.parse(got.stdout) as GmailGetResponse));
    } catch {
      console.error(`[${tag}] gmail get ${id} returned non-JSON`);
    }
  }
  return out;
}

export const defaultGmailList: GmailList = (allowlist, cursor) => {
  const since = cursor ? Number(cursor) : 0;
  return fetchMessages(buildQuery(allowlist), 50, 'inbox-ingest')
    .filter((m) => Number(m.internalDate) > since); // strictly newer than the cursor → not yet seen
};

// ---- daily catch-all sweep (step 3: the mailbox work the entrepreneur's run does today, in TS) -----

/** The daily-sweep query: every attachment-bearing inbox mail since the month's first day. */
export function buildSweepQuery(firstDay: string): string {
  return `has:attachment in:inbox after:${firstDay}`;
}

/** Lists attachment-bearing inbox messages since `firstDay` (Gmail `after:` form). Injectable for tests. */
export type GmailSweep = (firstDay: string) => InboxMessage[];

export const defaultGmailSweep: GmailSweep = (firstDay) => fetchMessages(buildSweepQuery(firstDay), 100, 'intake-sweep');

/**
 * The new-message set for the daily sweep: listed messages whose id is not already handled. The
 * handled set is the union of `Processed Gmail` ids that are `classified`/`skipped — …` across the
 * open periods (the same dedup key the agent uses) — so a doc already booked is never re-fetched.
 */
export function selectNewMessages(messages: InboxMessage[], handledIds: Iterable<string>): InboxMessage[] {
  const handled = new Set(handledIds);
  return messages.filter((m) => !handled.has(m.messageId));
}

/**
 * Fetch one attachment's BYTES from Gmail and write the raw file to `destPath`. gws returns the data
 * base64url-encoded in `{ "data": "..." }`; we decode and write. Returns true on success. This is the
 * lazy byte-fetch the orchestrator does just before classifying a document.
 */
export function downloadAttachment(messageId: string, attachmentId: string, destPath: string): boolean {
  const params = JSON.stringify({ userId: 'me', messageId, id: attachmentId });
  const res = runGws(['gmail', 'users', 'messages', 'attachments', 'get', '--params', params, '--format', 'json']);
  if (!res.ok) {
    console.error(`[intake] attachment ${attachmentId} fetch failed: ${res.detail}`);
    return false;
  }
  try {
    const data = (JSON.parse(res.stdout) as { data?: string }).data;
    if (!data) return false;
    writeFileSync(destPath, Buffer.from(data, 'base64url'));
    return true;
  } catch {
    console.error(`[intake] attachment ${attachmentId} returned non-JSON`);
    return false;
  }
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  const h = (headers ?? []).find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** Walk the MIME tree collecting parts that carry a filename (the actual attachments). */
function collectAttachments(part: GmailPart | undefined, acc: AttachmentMeta[]): void {
  if (!part) return;
  if (part.filename && part.mimeType && !part.mimeType.startsWith('multipart/')) {
    acc.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body?.attachmentId ?? '' });
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
