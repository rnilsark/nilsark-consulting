import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, openDb, type Db } from '../src/db.ts';
import { applyLedgerCorrection, composeReconcileSummary, financeLedgerSnapshot, pollBankDrop, reviewReconcile, runReconcile } from '../src/adapters/reconcile.ts';
import { emptyMonthState, renderStateMd, type BankTransaction, type GwsRunner, type GwsResult, type LedgerDocument, type MonthState } from '../src/adapters/state.ts';

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });

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
  const rows = db.prepare("SELECT task FROM queue WHERE agent='statement'").all() as Array<{ task: string }>;
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

// ---- runReconcile: period read from the statement, not assumed ----------------

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
  assert.ok(r.summary && /Avstämning 2026-06/.test(r.summary)); // the run now carries an operator-facing breakdown
});

// ---- composeReconcileSummary: the reviewable breakdown ------------------------

function bank(over: Partial<BankTransaction>): BankTransaction {
  return { date: '2026-06-10', description: '', amount: '-100.00', currency: 'SEK', matchedToFile: '', matchConfidence: 'unmatched', unmatchedReason: '', ...over };
}

function reconciledJune(): MonthState {
  return {
    ...emptyMonthState('2026-06'),
    documents: [
      lev('A.pdf', 'Elwa', '2513.00', '2026-06-14'),        // will be paid
      { ...lev('B.pdf', 'Telia', '349.00', '2026-06-20'), paymentStatus: 'unpaid' }, // still unpaid
    ].map((d) => (d.file === 'A.pdf' ? { ...d, paymentStatus: 'paid' } : d)),
    bank: [
      bank({ description: 'ELWA AB', amount: '-2513.00', matchedToFile: 'A.pdf', matchConfidence: 'exact' }),
      bank({ description: 'ICA', amount: '-432.00', unmatchedReason: 'kvitto' }),
      bank({ description: 'OKQ8', amount: '-701.00', unmatchedReason: 'kvitto' }),
      bank({ description: 'LÖN', amount: '-30000.00', unmatchedReason: 'lön' }),
      bank({ description: 'GLESYS', amount: '-1200.00', unmatchedReason: '' }),  // untagged → okänd → to check
      bank({ description: 'KUND AB', amount: '+45000.00', unmatchedReason: 'inkommande' }),
    ],
  };
}

test('composeReconcileSummary: splits expected noise from the rows that need a look', () => {
  const s = composeReconcileSummary(reconciledJune());
  assert.match(s, /Fakturor: 1\/2 betalda/);
  assert.match(s, /Kvar att matcha \(1\):/);
  assert.match(s, /- Telia — 349 kr — förf 2026-06-20/);
  assert.match(s, /1 matchade mot faktura/);            // only the exact ELWA row settled
  assert.match(s, /Omatchade utgående \(4\):/);          // 2 kvitto + 1 lön + 1 okänd (incoming excluded)
  assert.match(s, /Väntat \(3\): kvitto 2 · lön 1/);     // expected bucket, most-common first
  assert.match(s, /Att kolla \(1\):/);
  assert.match(s, /GLESYS/);                             // the untagged row surfaces for review
  assert.match(s, /Inkommande: 1 rad/);
});

test('composeReconcileSummary: a fully-matched month says nothing needs a look', () => {
  const s = composeReconcileSummary({
    ...emptyMonthState('2026-06'),
    documents: [{ ...lev('A.pdf', 'Elwa', '2513.00', '2026-06-14'), paymentStatus: 'paid' }],
    bank: [bank({ amount: '-2513.00', matchedToFile: 'A.pdf', matchConfidence: 'exact' })],
  });
  assert.match(s, /Fakturor: 1\/1 betalda/);
  assert.doesNotMatch(s, /Kvar att matcha/);
  assert.match(s, /Omatchade utgående \(0\):\n {2}\(inga\)/);
});

test('reviewReconcile: reads the month with bank rows and composes its summary', () => {
  const juneMd = renderStateMd(reconciledJune());
  const run: GwsRunner = (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='2026-07'")) return okR(JSON.stringify({ files: [] }));   // this month not created
    if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
    if (p.includes('.doppelganger') && p.includes("'M6'")) return okR(JSON.stringify({ files: [{ id: 'DOPP6' }] }));
    if (p.includes('state.md') && p.includes("'DOPP6'")) return okR(JSON.stringify({ files: [{ id: 'SM6', headRevisionId: 'R6' }] }));
    return okR(JSON.stringify({ files: [] }));
  };
  const rv = reviewReconcile(undefined, { filing: { run, download: () => juneMd, rootFolderId: () => 'ROOT' }, today: '2026-07-03' });
  assert.ok(rv);
  assert.equal(rv!.month, '2026-06');                    // fell back from empty July to reconciled June
  assert.match(rv!.summary, /Avstämning 2026-06/);
});

// ---- ledger read + correct (the chat explain/correct loop) --------------------

/** A June ledger with the two real correction cases: Walley-paid invoice + mis-dated skattekonto. */
function juneToCorrect(): MonthState {
  return {
    ...emptyMonthState('2026-06'),
    documents: [
      { ...lev('Verktygsboden.pdf', 'Verktygsboden Erfilux AB', '655.00', '2026-07-05'), paymentStatus: 'unpaid' },
      { ...lev('Skatt.pdf', 'Skatteverket', '47183.00', '2026-06-12'), type: 'skattekonto', paymentStatus: 'overdue' },
    ],
    bank: [
      bank({ date: '2026-06-26', description: 'Walley', amount: '-655.00' }),
      bank({ date: '2026-06-10', description: 'SKATTEVERKET', amount: '-47245.00' }),
    ],
  };
}

/** Mock a single Drive month (June present, July empty) that serves `md` and captures the written state.md. */
function mockMonth(md: string) {
  const cap = { written: '' };
  const run: GwsRunner = (args, opts) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (args[2] === 'list') {
      if (p.includes("name='2026-07'")) return okR(JSON.stringify({ files: [] }));
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes('.doppelganger') && p.includes("'M6'")) return okR(JSON.stringify({ files: [{ id: 'DOPP6' }] }));
      if (p.includes('state.md') && p.includes("'DOPP6'")) return okR(JSON.stringify({ files: [{ id: 'SM6', headRevisionId: 'R6' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    if (args[2] === 'get' && p.includes('headRevisionId')) return okR(JSON.stringify({ headRevisionId: 'R6' }));
    if (args[2] === 'update') { cap.written = readFileSync(path.join(opts!.cwd!, args[args.indexOf('--upload') + 1]), 'utf8'); return okR('{}'); }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  return { run, download: () => md, cap };
}

test('applyLedgerCorrection: mark paid + manually link a bank row (Verktygsboden = Walley)', () => {
  const m = mockMonth(renderStateMd(juneToCorrect()));
  const r = applyLedgerCorrection(
    { file: 'Verktygsboden.pdf', setPaid: true, linkBankDescription: 'Walley' },
    { filing: { run: m.run, download: m.download, rootFolderId: () => 'ROOT' }, today: '2026-07-03' },
  );
  assert.ok(r.ok);
  assert.equal(r.month, '2026-06');
  assert.match(m.cap.written, /Verktygsboden\.pdf \|[^\n]*\| paid \| no \|/);           // invoice now paid
  assert.match(m.cap.written, /Walley \| -655\.00 \| SEK \| Verktygsboden\.pdf \| manual \|/); // bank row linked
});

test('applyLedgerCorrection: fix a mis-parsed due date by supplier (Skatteverket → July)', () => {
  const m = mockMonth(renderStateMd(juneToCorrect()));
  const r = applyLedgerCorrection(
    { supplier: 'Skatteverket', dueDate: '2026-07-12' },
    { filing: { run: m.run, download: m.download, rootFolderId: () => 'ROOT' }, today: '2026-07-03' },
  );
  assert.ok(r.ok);
  assert.match(r.detail, /2026-07-12/);
  assert.match(m.cap.written, /Skatt\.pdf \| skattekonto \| Skatteverket \| 47183\.00 \| SEK \| 2026-07-12 \|/);
});

test('applyLedgerCorrection: no matching document → ok:false, writes nothing', () => {
  const m = mockMonth(renderStateMd(juneToCorrect()));
  const r = applyLedgerCorrection(
    { supplier: 'Obefintlig', setPaid: true },
    { filing: { run: m.run, download: m.download, rootFolderId: () => 'ROOT' }, today: '2026-07-03' },
  );
  assert.equal(r.ok, false);
  assert.equal(m.cap.written, '');
});

test('financeLedgerSnapshot: renders the open month for the chat LLM to explain', () => {
  const m = mockMonth(renderStateMd(juneToCorrect()));
  const snap = financeLedgerSnapshot({ filing: { run: m.run, download: m.download, rootFolderId: () => 'ROOT' }, today: '2026-07-03' });
  assert.ok(snap);
  assert.match(snap!, /### 2026-06/);
  assert.match(snap!, /\[unpaid\] Verktygsboden/);
  assert.match(snap!, /Omatchat utgående:.*Walley -655\.00/);
});
