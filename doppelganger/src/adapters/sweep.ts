import { insertQueue, type Db } from '../db.ts';
import {
  DRIVE_FOLDER_MIME,
  findChildId,
  operatorToday,
  prevMonth,
  readDriveRootFolderId,
} from './ledger-store.ts';
import {
  defaultGwsRunner,
  makeDriveDownloader,
  parseStateMd,
  resolveStateFile,
  type DriveDownloader,
  type GwsRunner,
} from './state.ts';
import { defaultGmailSweep, selectNewMessages, type GmailSweep } from './inbox.ts';

// The daily catch-all sweep (the entrepreneur's old collect step, in TS): a once-daily backstop that
// re-enqueues any attachment-bearing finance mail the 15-minute cursor poll missed.

export interface SweepDeps {
  sweep?: GmailSweep;
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
  today?: string;
}

/** A daily backstop should only ever turn up a handful of missed messages. More than this means the
 *  dedup basis is broken (a Drive hiccup), not that the mailbox really has that many unfiled docs — so
 *  the sweep refuses to enqueue rather than risk a re-processing storm. */
const SWEEP_MAX_ENQUEUE = 25;

/**
 * message-ids already filed (state.md) or already on the queue — so the sweep never re-enqueues one.
 * Returns `null` when the filed-set can't be trusted (no root folder, or a state.md that resolves but
 * won't parse): the caller then skips the sweep entirely rather than flood the queue with re-fetches.
 */
function alreadySeenMessageIds(
  db: Db,
  months: string[],
  run: GwsRunner,
  download: DriveDownloader,
  rootFolderId: () => string | null,
): Set<string> | null {
  const seen = new Set<string>();
  // (a) on the queue right now (enqueued by the cursor poll but not yet filed) — any inbox/intake/statement row.
  const rows = db.prepare(`SELECT task FROM queue WHERE agent IN ('inbox','intake','statement')`).all() as Array<{ task: string }>;
  for (const r of rows) {
    try {
      const id = (JSON.parse(r.task) as { messageId?: string }).messageId;
      if (id) seen.add(id);
    } catch {
      // a non-JSON task carries no messageId — nothing to dedup on
    }
  }
  // (b) already filed: Processed-Gmail ids (classified / skipped) in the in-scope months' state.md.
  const rootId = rootFolderId();
  if (!rootId) return null; // can't prove what's filed → unsafe to sweep
  for (const m of months) {
    const monthId = findChildId(rootId, m, DRIVE_FOLDER_MIME, run);
    if (!monthId) continue; // month folder not created yet → legitimately nothing filed there
    const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
    if (!doppId) continue;
    const ref = resolveStateFile(doppId, run);
    if (!ref) continue; // no state.md yet → nothing filed for this month
    const state = parseStateMd(download(ref.fileId));
    if (state.month === '') return null; // state.md is THERE but unreadable → don't trust the dedup, skip
    for (const p of state.processed) {
      if (p.status === 'classified' || p.status.startsWith('skipped')) seen.add(p.messageId);
    }
  }
  return seen;
}

/**
 * The daily collect backstop (TS, no LLM) — the work the entrepreneur's `collect-finance` skill used to
 * do. List every attachment-bearing inbox message since the start of LAST month, drop any already filed
 * (state.md) or already queued (the cursor poll), and enqueue one metadata-only `inbox` row per
 * remaining message — the same shape `ingestInbox` enqueues, so the haiku gate routes each to
 * intake/reconcile. The 15-minute cursor poll is the fast primary; this is the once-daily insurance for
 * anything it missed (an outage, a watermark gap). Best-effort: a Drive/Gmail miss yields 0, never throws.
 */
export function sweepFinanceInbox(db: Db, deps: SweepDeps = {}): { enqueued: number } {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const rootFolderId = deps.rootFolderId ?? readDriveRootFolderId;
  const today = deps.today ?? operatorToday();
  const months = [prevMonth(today), today.slice(0, 7)];
  const firstDay = `${months[0]}-01`;

  const messages = (deps.sweep ?? defaultGmailSweep)(firstDay);
  if (messages.length === 0) return { enqueued: 0 };

  const seen = alreadySeenMessageIds(db, months, run, download, rootFolderId);
  if (seen === null) {
    console.error('[intake-sweep] skipped — could not establish the filed-set (Drive read failed)');
    return { enqueued: 0 };
  }
  const fresh = selectNewMessages(messages, seen);
  if (fresh.length > SWEEP_MAX_ENQUEUE) {
    console.error(`[intake-sweep] skipped — ${fresh.length} candidates exceeds cap ${SWEEP_MAX_ENQUEUE}; dedup basis likely broken`);
    return { enqueued: 0 };
  }
  let enqueued = 0;
  for (const msg of fresh) {
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
  }
  if (enqueued > 0) console.log(`[intake-sweep] enqueued ${enqueued} message(s) → inbox`);
  return { enqueued };
}
