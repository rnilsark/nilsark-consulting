import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, insertQueue, openDb, type Db } from '../src/db.ts';
import { bankStatementNudge, documentFromClassification, fileDocument, intakeDocument, normalizeAmount, pollBankDrop, sweepFinanceInbox } from '../src/adapters/finance-intake.ts';
import { emptyMonthState, renderStateMd, type GwsRunner, type GwsResult } from '../src/adapters/state.ts';

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });

// ---- normalizeAmount --------------------------------------------------------

test('normalizeAmount: Swedish formats → plain dot-decimal', () => {
  assert.equal(normalizeAmount('2 513,00'), '2513.00'); // space thousands + comma decimal (the live case)
  assert.equal(normalizeAmount('502,50'), '502.50');
  assert.equal(normalizeAmount('1.234,56'), '1234.56'); // dot thousands + comma decimal
  assert.equal(normalizeAmount('129,00'), '129.00');
});

test('normalizeAmount: already-normalized + empty pass through', () => {
  assert.equal(normalizeAmount('2513.00'), '2513.00'); // no comma → assumed dot-decimal already
  assert.equal(normalizeAmount('0.00'), '0.00');
  assert.equal(normalizeAmount(''), '');
  assert.equal(normalizeAmount('  '), '');
});

// ---- documentFromClassification ---------------------------------------------

test('documentFromClassification: the live Elwa classification → a correct ledger row', () => {
  // exactly what the classifier returned in prod
  const d = documentFromClassification('Faktura_2908.pdf', '2026-06', {
    type: 'leverantörsfaktura', supplier: 'Elwa AB', amount: '2 513,00', currency: 'SEK',
    vat_amount: '502,50', due_date: '2026-06-14', ocr_number: '290866', bank_account: 'BG 5542-9468',
    document_date: '2026-06-04',
  });
  assert.equal(d.file, 'Faktura_2908.pdf');
  assert.equal(d.type, 'leverantörsfaktura');
  assert.equal(d.amount, '2513.00'); // normalized from "2 513,00"
  assert.equal(d.vatAmount, '502.50');
  assert.equal(d.drivePath, '2026-06/Leverantörsfakturor/');
  assert.equal(d.paymentStatus, 'unpaid'); // leverantörsfaktura → unpaid
  assert.equal(d.fortnoxSent, 'no');
  assert.equal(d.driveFileId, ''); // set later, by the upload step
});

test('documentFromClassification: a kvitto → Verifikationer folder, payment n/a', () => {
  const d = documentFromClassification('kvitto.pdf', '2026-06', { type: 'kvitto', supplier: 'SL', amount: '430,00' });
  assert.equal(d.drivePath, '2026-06/Verifikationer/');
  assert.equal(d.paymentStatus, 'n/a');
  assert.equal(d.currency, 'SEK'); // defaulted
});

test('documentFromClassification: an unknown type falls back to Verifikationer / n/a', () => {
  const d = documentFromClassification('mystery.pdf', '2026-06', { type: 'sövpös', amount: '1,00' });
  assert.equal(d.type, 'unknown');
  assert.equal(d.drivePath, '2026-06/Verifikationer/');
  assert.equal(d.paymentStatus, 'n/a');
});

// ---- intakeDocument (orchestrator, simulated classifier) --------------------

function freshDb(): Db {
  return openDb(':memory:');
}

/** Drive a simulated classifier run via the injected sleepFn: pick on step 1, finalize on step 2. */
function simulatedClassifier(db: Db, runsDir: string, result: unknown) {
  let step = 0;
  return async (): Promise<void> => {
    step += 1;
    const row = db.prepare("SELECT id FROM queue WHERE agent='classifier' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (!row) return;
    if (step === 1) {
      db.prepare(`UPDATE queue SET status='running', run_id='RC', running_since=? WHERE id=?`).run(new Date().toISOString(), row.id);
      insertEvent(db, { run_id: 'RC', kind: 'started', agent: 'classifier', task: 't', parent: null });
    } else if (step === 2) {
      mkdirSync(path.join(runsDir, 'RC'), { recursive: true });
      writeFileSync(path.join(runsDir, 'RC', 'out.json'), JSON.stringify({ status: 'success', summary: 'ok', result }));
      db.prepare('DELETE FROM queue WHERE id=?').run(row.id);
      insertEvent(db, { run_id: 'RC', kind: 'finished', agent: 'classifier', task: 't', parent: null, status: 'success' });
    }
  };
}

test('intakeDocument: dispatches the classifier and returns the assembled, normalized row', async () => {
  const db = freshDb();
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  const sleepFn = simulatedClassifier(db, runsDir, {
    type: 'leverantörsfaktura', supplier: 'Avanza Pension', amount: '15 352,00', due_date: '2026-06-30',
  });
  const r = await intakeDocument(db, '2026-06', { filePath: '/x.pdf', filename: 'x.pdf' }, { pollMs: 1, runsDir, sleepFn });
  rmSync(runsDir, { recursive: true, force: true });
  assert.equal(r.status, 'classified');
  assert.equal(r.document?.supplier, 'Avanza Pension');
  assert.equal(r.document?.amount, '15352.00'); // normalized
  assert.equal(r.document?.paymentStatus, 'unpaid');
});

test('intakeDocument: a classifier that never finishes → failed, no document', async () => {
  const db = freshDb();
  const r = await intakeDocument(db, '2026-06', { filePath: '/x.pdf', filename: 'x.pdf' }, { pollMs: 1, timeoutMs: 5, sleepFn: async () => {} });
  assert.equal(r.status, 'failed');
  assert.equal(r.document, undefined);
});

// ---- fileDocument (Drive write orchestration, mocked gws) -------------------

test('fileDocument: uploads the PDF and writes the normalized row into state.md', () => {
  const STATE_MD = renderStateMd(emptyMonthState('2026-06')); // empty ledger to merge into
  let written = '';
  const run: GwsRunner = (args, opts) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'MONTH' }] }));
      if (p.includes("name='Leverantörsfakturor'")) return okR(JSON.stringify({ files: [{ id: 'TYPE' }] }));
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      throw new Error(`unexpected list: ${p}`);
    }
    if (args[1] === '+upload') return okR(JSON.stringify({ id: 'PDFID' }));
    if (args[2] === 'get') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes('headRevisionId')) return okR(JSON.stringify({ headRevisionId: 'R1' })); // write guard re-check
      if (args.includes('-o')) { writeFileSync(path.join(opts!.cwd!, 'download'), STATE_MD); return okR(''); }
    }
    if (args[2] === 'update') { written = readFileSync(path.join(opts!.cwd!, 'state.md'), 'utf8'); return okR('{}'); }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };

  const doc = documentFromClassification('Faktura_2908.pdf', '2026-06', {
    type: 'leverantörsfaktura', supplier: 'Elwa AB', amount: '2 513,00', vat_amount: '502,50',
    due_date: '2026-06-14', ocr_number: '290866', bank_account: 'BG 5542-9468', document_date: '2026-06-04',
  });
  const proc = { messageId: 'm9', date: '2026-06-04', from: 'Elwa', subject: 'Faktura 2908', attachmentFilename: 'Faktura_2908.pdf', status: 'classified' };

  const r = fileDocument('2026-06', '/tmp/x/Faktura_2908.pdf', proc, doc, { run, rootFolderId: () => 'ROOT' });

  assert.equal(r.ok, true, r.detail);
  assert.equal(r.driveFileId, 'PDFID');
  assert.ok(written.includes('Elwa AB'), 'supplier in the written ledger');
  assert.ok(written.includes('2513.00'), 'NORMALIZED amount in the written ledger');
  assert.ok(written.includes('PDFID'), 'drive_file_id stamped from the upload');
});

test('fileDocument: a missing month folder → ok:false (never throws, no write)', () => {
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') return okR(JSON.stringify({ files: [] })); // nothing resolves
    throw new Error('should not reach upload/write');
  };
  const doc = documentFromClassification('x.pdf', '2026-06', { type: 'kvitto', amount: '1,00' });
  const proc = { messageId: 'm', date: '', from: '', subject: '', attachmentFilename: 'x.pdf', status: 'classified' };
  const r = fileDocument('2026-06', '/tmp/x.pdf', proc, doc, { run, rootFolderId: () => 'ROOT' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /month folder/);
});

// ---- pollBankDrop (Drive drop folder → reconcile) --------------------------

test('pollBankDrop: enqueues a reconcile per new statement file, deduped, skips subfolders', () => {
  const db = openDb(':memory:');
  const run: GwsRunner = (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='Kontoutdrag'")) return okR(JSON.stringify({ files: [{ id: 'DROP' }] }));
    if (p.includes("'DROP' in parents")) return okR(JSON.stringify({ files: [
      { id: 'F1', name: 'juni.csv', mimeType: 'text/csv' },
      { id: 'SUB', name: 'old', mimeType: 'application/vnd.google-apps.folder' },
    ] }));
    throw new Error(`unexpected: ${p}`);
  };
  assert.equal(pollBankDrop(db, { run, rootFolderId: () => 'ROOT' }).enqueued, 1); // F1 only; SUB is a folder
  assert.equal(pollBankDrop(db, { run, rootFolderId: () => 'ROOT' }).enqueued, 0); // deduped on re-poll
  const rows = db.prepare("SELECT task FROM queue WHERE agent='reconcile'").all() as Array<{ task: string }>;
  assert.equal(rows.length, 1);
  assert.equal((JSON.parse(rows[0].task) as { driveFileId: string }).driveFileId, 'F1');
});

test('pollBankDrop: no drop folder yet → no-op', () => {
  const db = openDb(':memory:');
  const run: GwsRunner = (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='Kontoutdrag'")) return okR(JSON.stringify({ files: [] })); // folder not created
    throw new Error(`unexpected: ${p}`);
  };
  assert.equal(pollBankDrop(db, { run, rootFolderId: () => 'ROOT' }).enqueued, 0);
});

// ---- bankStatementNudge -----------------------------------------------------

const fsDeps = (json: string) => ({
  run: ((args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'D' }] }));
    if (p.includes('state.json')) return okR(JSON.stringify({ files: [{ id: 'SJ' }] }));
    throw new Error(`unexpected: ${p}`);
  }) as GwsRunner,
  download: () => json,
  rootFolderId: () => 'ROOT',
});

test('bankStatementNudge: past the first week → no nudge', () => {
  const r = bankStatementNudge(openDb(':memory:'), { today: '2026-07-15' });
  assert.equal(r.nudged, false);
  assert.match(r.detail, /not the start/);
});

test('bankStatementNudge: last month already reconciled → no nudge', () => {
  const json = JSON.stringify({ version: 2, periods: { '2026-06': { export_status: 'reconciled' } } });
  const r = bankStatementNudge(openDb(':memory:'), { today: '2026-07-03', financeState: fsDeps(json) });
  assert.equal(r.nudged, false);
  assert.match(r.detail, /reconciled/);
});

test('bankStatementNudge: last month unreconciled early in the month → flags it, then dedups', () => {
  const db = openDb(':memory:');
  const json = JSON.stringify({ version: 2, periods: { '2026-06': { export_status: 'pending' } } });
  const r1 = bankStatementNudge(db, { today: '2026-07-03', financeState: fsDeps(json) });
  assert.match(r1.detail, /2026-06/); // (no operator push target in test → "would nudge")
  const r2 = bankStatementNudge(db, { today: '2026-07-04', financeState: fsDeps(json) });
  assert.match(r2.detail, /already nudged/);
});

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

// ---- runReconcile: period read from the statement, not assumed ----------------

import { runReconcile } from '../src/adapters/finance-intake.ts';
import type { LedgerDocument } from '../src/adapters/state.ts';

function lev(file: string, supplier: string, amount: string, due: string): LedgerDocument {
  return { file, type: 'leverantörsfaktura', supplier, amount, currency: 'SEK', dueDate: due, documentDate: due, ocrNumber: '290866', bankAccount: '', vatAmount: '0', drivePath: '', driveFileId: '', paymentStatus: 'unpaid', fortnoxSent: 'no' };
}

/** Drive a simulated reconciler run (mirrors simulatedClassifier, agent=reconciler). */
function simulatedReconciler(db: Db, runsDir: string, result: unknown) {
  let step = 0;
  return async (): Promise<void> => {
    step += 1;
    const row = db.prepare("SELECT id FROM queue WHERE agent='reconciler' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (!row) return;
    if (step === 1) {
      db.prepare(`UPDATE queue SET status='running', run_id='RR', running_since=? WHERE id=?`).run(new Date().toISOString(), row.id);
      insertEvent(db, { run_id: 'RR', kind: 'started', agent: 'reconciler', task: 't', parent: null });
    } else {
      mkdirSync(path.join(runsDir, 'RR'), { recursive: true });
      writeFileSync(path.join(runsDir, 'RR', 'out.json'), JSON.stringify({ status: 'success', summary: 'ok', result }));
      db.prepare('DELETE FROM queue WHERE id=?').run(row.id);
      insertEvent(db, { run_id: 'RR', kind: 'finished', agent: 'reconciler', task: 't', parent: null, status: 'success' });
    }
  };
}

test('runReconcile: a June statement reconciles JUNE (read off its dates), not prevMonth May', async () => {
  const db = openDb(':memory:');
  const runsDir = mkdtempSync(path.join(tmpdir(), 'runs-'));
  const juneMd = renderStateMd({ ...emptyMonthState('2026-06'), documents: [lev('Faktura_A.pdf', 'Elwa', '2513.00', '2026-06-14')] });
  const mayMd = renderStateMd({ ...emptyMonthState('2026-05'), documents: [lev('Faktura_B.pdf', 'Telia', '1250.00', '2026-05-20')] });
  let juneWritten = '';
  let mayWritten = '';
  const run: GwsRunner = (args, opts) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (args[2] === 'list') {
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes("name='2026-05'")) return okR(JSON.stringify({ files: [{ id: 'M5' }] }));
      if (p.includes('.doppelganger') && p.includes("'M6'")) return okR(JSON.stringify({ files: [{ id: 'DOPP6' }] }));
      if (p.includes('.doppelganger') && p.includes("'M5'")) return okR(JSON.stringify({ files: [{ id: 'DOPP5' }] }));
      if (p.includes('state.md') && p.includes("'DOPP6'")) return okR(JSON.stringify({ files: [{ id: 'SM6', headRevisionId: 'R6' }] }));
      if (p.includes('state.md') && p.includes("'DOPP5'")) return okR(JSON.stringify({ files: [{ id: 'SM5', headRevisionId: 'R5' }] }));
      if (p.includes('state.json')) return okR(JSON.stringify({ files: [{ id: 'SJ' }] }));
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPPROOT' }] })); // root .doppelganger for state.json
      return okR(JSON.stringify({ files: [] }));
    }
    if (args[2] === 'get' && p.includes('headRevisionId')) return okR(JSON.stringify({ headRevisionId: p.includes('SM6') ? 'R6' : 'R5' }));
    if (args[2] === 'update') {
      const content = readFileSync(path.join(opts!.cwd!, args[args.indexOf('--upload') + 1]), 'utf8');
      if (p.includes('SM6')) juneWritten = content;
      if (p.includes('SM5')) mayWritten = content;
      return okR('{}');
    }
    if (args[1] === '+upload') return okR('{}');
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const download = (id: string) => (id === 'SM6' ? juneMd : id === 'SM5' ? mayMd : '{"version":2,"periods":{}}');
  const sleepFn = simulatedReconciler(db, runsDir, {
    period: '2026-06',
    transactions: [{ date: '2026-06-14', description: 'ELWA AB', amount: '-2513.00', currency: 'SEK', matched_to_file: 'Faktura_A.pdf', match_confidence: 'exact' }],
  });
  const r = await runReconcile(db, { filePath: '/s.csv', filename: 's.csv' }, {
    today: '2026-06-15',
    dispatch: { pollMs: 1, runsDir, sleepFn },
    filing: { run, download, rootFolderId: () => 'ROOT' },
    financeState: { run, download: () => '{"version":2,"periods":{}}', rootFolderId: () => 'ROOT' },
  });
  rmSync(runsDir, { recursive: true, force: true });
  assert.equal(r.matched, 1);
  assert.match(r.detail, /2026-06/);            // period detected as June
  assert.match(juneWritten, /Faktura_A\.pdf \|[^\n]*\| paid \|/); // June invoice marked paid
  assert.equal(mayWritten, '');                 // May NEVER touched — the old prevMonth assumption is gone
});
