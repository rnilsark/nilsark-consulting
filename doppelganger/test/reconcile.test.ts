import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, openDb, type Db } from '../src/db.ts';
import { pollBankDrop, runReconcile } from '../src/adapters/reconcile.ts';
import { emptyMonthState, renderStateMd, type GwsRunner, type GwsResult, type LedgerDocument } from '../src/adapters/state.ts';

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
});
