import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertQueue, openDb, type Db } from '../src/db.ts';
import { sweepFinanceInbox } from '../src/adapters/sweep.ts';
import { emptyMonthState, renderStateMd, type GwsRunner, type GwsResult } from '../src/adapters/state.ts';

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });

// ---- sweepFinanceInbox (the daily collect backstop, in TS) ------------------

const msg = (messageId: string, subject = 's') => ({
  messageId, internalDate: '1', from: 'x@y.z', subject, snippet: '', attachments: [{ filename: `${messageId}.pdf`, mimeType: 'application/pdf', attachmentId: `a-${messageId}` }],
});

test('sweepFinanceInbox: enqueues inbox rows only for messages not already filed or queued', () => {
  const db = openDb(':memory:');
  // m2 is already on the queue (the cursor poll grabbed it) — must not be re-enqueued.
  insertQueue(db, { agent: 'inbox', task: JSON.stringify({ messageId: 'm2' }), parent: null });
  // m1 is already filed in 2026-06's state.md.
  const stateMd = renderStateMd({
    ...emptyMonthState('2026-06'),
    processed: [{ messageId: 'm1', date: '2026-06-02', from: '', subject: '', attachmentFilename: 'm1.pdf', status: 'classified' }],
  });
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes("name='2026-05'")) return okR(JSON.stringify({ files: [] })); // no prior-month folder
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      throw new Error(`unexpected list: ${p}`);
    }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const r = sweepFinanceInbox(db, {
    today: '2026-06-15',
    sweep: () => [msg('m1'), msg('m2'), msg('m3')],
    run,
    download: () => stateMd,
    rootFolderId: () => 'ROOT',
  });
  assert.equal(r.enqueued, 1); // only m3
  const inboxTasks = (db.prepare("SELECT task FROM queue WHERE agent='inbox'").all() as Array<{ task: string }>)
    .map((row) => (JSON.parse(row.task) as { messageId: string }).messageId);
  assert.deepEqual(inboxTasks.sort(), ['m2', 'm3']); // m2 (pre-existing) + m3 (newly swept); m1 filtered out
});

test('sweepFinanceInbox: no candidate mail → no-op, never touches Drive', () => {
  const db = openDb(':memory:');
  const r = sweepFinanceInbox(db, {
    today: '2026-06-15',
    sweep: () => [],
    run: () => { throw new Error('Drive must not be read when there is no mail'); },
    rootFolderId: () => { throw new Error('root folder must not be resolved'); },
  });
  assert.equal(r.enqueued, 0);
});

test('sweepFinanceInbox: skips (no enqueue) when state.md is present but unreadable — never floods', () => {
  const db = openDb(':memory:');
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes("name='2026-05'")) return okR(JSON.stringify({ files: [] }));
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      throw new Error(`unexpected list: ${p}`);
    }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const r = sweepFinanceInbox(db, {
    today: '2026-06-15',
    sweep: () => [msg('m1'), msg('m2')],
    run,
    download: () => 'this is not valid state.md', // corrupt → parseStateMd yields month==='' → unsafe
    rootFolderId: () => 'ROOT',
  });
  assert.equal(r.enqueued, 0);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM queue WHERE agent='inbox'").get() as { c: number }).c, 0);
});

test('sweepFinanceInbox: skips when the root folder id is unavailable', () => {
  const db = openDb(':memory:');
  const r = sweepFinanceInbox(db, {
    today: '2026-06-15',
    sweep: () => [msg('m1')],
    rootFolderId: () => null, // settings missing → can't prove what's filed
  });
  assert.equal(r.enqueued, 0);
});
