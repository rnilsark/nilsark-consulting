import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getChannelCursor, openDb, selectPendingFifo, setChannelCursor } from '../src/db.ts';
import {
  buildQuery,
  buildSweepQuery,
  ingestInbox,
  INBOX_CURSOR_KEY,
  parseGmailMessage,
  selectNewMessages,
  type GmailList,
  type InboxMessage,
} from '../src/adapters/inbox.ts';

function freshDb() {
  return openDb(':memory:');
}

/** A db whose inbox watermark is already primed, so a test exercises the steady-state poll (not the
 *  first-poll watermark-prime path). `since='0'` means "everything is newer", matching the old tests. */
function primedDb(since = '0') {
  const db = freshDb();
  setChannelCursor(db, INBOX_CURSOR_KEY, since);
  return db;
}

/** A lister driven from an in-memory array, honoring the cursor like the real one (strict-greater). */
function memList(all: InboxMessage[]): { list: GmailList; calls: Array<{ allowlist: string[]; cursor: string | null }> } {
  const calls: Array<{ allowlist: string[]; cursor: string | null }> = [];
  const list: GmailList = (allowlist, cursor) => {
    calls.push({ allowlist, cursor });
    const since = cursor ? Number(cursor) : 0;
    return all.filter((m) => Number(m.internalDate) > since);
  };
  return { list, calls };
}

function msg(id: string, internalDate: string, over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageId: id,
    internalDate,
    from: 'fakturor@leverantor.se',
    subject: 'Faktura',
    snippet: 'Att betala',
    attachments: [{ filename: 'faktura.pdf', mimeType: 'application/pdf' }],
    ...over,
  };
}

test('buildQuery: has:attachment alone when allowlist empty; from:(a OR b) when set', () => {
  assert.equal(buildQuery([]), 'has:attachment in:inbox');
  assert.equal(
    buildQuery(['a@x.se', 'b@y.se']),
    'has:attachment in:inbox from:(a@x.se OR b@y.se)',
  );
  assert.equal(buildQuery(['  ', 'a@x.se']), 'has:attachment in:inbox from:(a@x.se)');
});

test('ingest: FIRST poll primes the watermark to now and enqueues nothing (never replays inbox history)', () => {
  const db = freshDb(); // no cursor yet
  const before = Date.now();
  const { list, calls } = memList([msg('m1', '1000'), msg('m2', '2000')]);
  ingestInbox(db, [], list);

  assert.equal(selectPendingFifo(db).length, 0, 'no history replayed on first poll');
  assert.equal(calls.length, 0, 'first poll does not even call the lister');
  const cursor = getChannelCursor(db, INBOX_CURSOR_KEY);
  assert.ok(cursor !== null && Number(cursor) >= before, 'watermark primed to ~now');
});

test('ingest: enqueues one inbox row per message (metadata only), advances cursor to newest internalDate', () => {
  const db = primedDb();
  const { list } = memList([msg('m1', '1000'), msg('m2', '2000')]);
  ingestInbox(db, [], list);

  const queued = selectPendingFifo(db);
  assert.equal(queued.length, 2);
  assert.ok(queued.every((q) => q.agent === 'inbox'));

  // oldest-first enqueue, and the task is metadata only (no bytes)
  const t1 = JSON.parse(queued[0].task) as Record<string, unknown>;
  assert.equal(t1.messageId, 'm1');
  assert.equal(t1.from, 'fakturor@leverantor.se');
  assert.equal(t1.subject, 'Faktura');
  assert.deepEqual(t1.attachments, [{ filename: 'faktura.pdf', mimeType: 'application/pdf' }]);
  assert.ok(!('data' in t1) && !('bytes' in t1), 'no attachment bytes in the enqueued row');

  assert.equal(getChannelCursor(db, INBOX_CURSOR_KEY), '2000');
});

test('ingest: re-poll with advanced cursor enqueues nothing new (dedup, no double-enqueue)', () => {
  const db = primedDb();
  const all = [msg('m1', '1000'), msg('m2', '2000')];
  const { list, calls } = memList(all);

  ingestInbox(db, [], list);
  assert.equal(selectPendingFifo(db).length, 2);

  // second poll: lister sees the persisted cursor and returns nothing newer
  ingestInbox(db, [], list);
  assert.equal(selectPendingFifo(db).length, 2, 'no duplicate rows');
  assert.equal(calls[1].cursor, '2000', 'cursor was passed back to the lister');
});

test('ingest: a later poll picks up only the genuinely new message', () => {
  const db = primedDb();
  const all = [msg('m1', '1000')];
  const { list } = memList(all);
  ingestInbox(db, [], list);
  assert.equal(selectPendingFifo(db).length, 1);

  all.push(msg('m3', '3000'));
  ingestInbox(db, [], list);
  const queued = selectPendingFifo(db);
  assert.equal(queued.length, 2);
  assert.equal((JSON.parse(queued[1].task) as { messageId: string }).messageId, 'm3');
  assert.equal(getChannelCursor(db, INBOX_CURSOR_KEY), '3000');
});

test('ingest: empty result on a primed db is a no-op (cursor unchanged)', () => {
  const db = primedDb('500');
  const { list } = memList([]);
  ingestInbox(db, [], list);
  assert.equal(selectPendingFifo(db).length, 0);
  assert.equal(getChannelCursor(db, INBOX_CURSOR_KEY), '500', 'cursor not moved by an empty poll');
});

test('ingest: the allowlist is passed to the lister (the from: gate lives in the query)', () => {
  const db = primedDb();
  const { list, calls } = memList([]);
  ingestInbox(db, ['fakturor@leverantor.se'], list);
  assert.deepEqual(calls[0].allowlist, ['fakturor@leverantor.se']);
});

test('parseGmailMessage: pulls headers + attachment parts, skips multipart wrappers and bodiless parts', () => {
  const parsed = parseGmailMessage('mX', {
    internalDate: '1700000000000',
    snippet: 'Faktura bifogad',
    payload: {
      headers: [
        { name: 'From', value: 'Leverantör <fakturor@leverantor.se>' },
        { name: 'Subject', value: 'Faktura 123' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain' }, // body, no filename → skipped
        { mimeType: 'application/pdf', filename: 'faktura.pdf' },
        {
          mimeType: 'multipart/related',
          parts: [{ mimeType: 'image/png', filename: 'logo.png' }],
        },
      ],
    },
  });

  assert.equal(parsed.messageId, 'mX');
  assert.equal(parsed.internalDate, '1700000000000');
  assert.equal(parsed.from, 'Leverantör <fakturor@leverantor.se>');
  assert.equal(parsed.subject, 'Faktura 123');
  assert.equal(parsed.snippet, 'Faktura bifogad');
  assert.deepEqual(parsed.attachments, [
    { filename: 'faktura.pdf', mimeType: 'application/pdf' },
    { filename: 'logo.png', mimeType: 'image/png' },
  ]);
});

// ---- daily sweep helpers (step 3) ------------------------------------------

test('buildSweepQuery: attachment-bearing inbox mail since the first of the month', () => {
  assert.equal(buildSweepQuery('2026/06/01'), 'has:attachment in:inbox after:2026/06/01');
});

test('selectNewMessages: drops ids already handled, keeps the rest', () => {
  const listed = [msg('a', '1'), msg('b', '2'), msg('c', '3')];
  const out = selectNewMessages(listed, ['b']);
  assert.deepEqual(out.map((m) => m.messageId), ['a', 'c']);
});

test('selectNewMessages: everything handled → empty (the common quiet-day case)', () => {
  const listed = [msg('a', '1'), msg('b', '2')];
  assert.equal(selectNewMessages(listed, ['a', 'b']).length, 0);
});

test('selectNewMessages: empty handled set → all are new', () => {
  const listed = [msg('a', '1'), msg('b', '2')];
  assert.equal(selectNewMessages(listed, []).length, 2);
});
