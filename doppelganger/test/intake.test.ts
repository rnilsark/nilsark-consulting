import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, openDb, type Db } from '../src/db.ts';
import { documentFromClassification, fileDocument, intakeDocument, normalizeAmount, resolveWritableMonth } from '../src/adapters/intake.ts';
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
      if (p.includes("name='Faktura_2908.pdf'")) return okR(JSON.stringify({ files: [] })); // not yet uploaded → +upload path
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

test('fileDocument: a same-named file already in the folder is reused, never re-uploaded (no dup)', () => {
  const STATE_MD = renderStateMd(emptyMonthState('2026-06'));
  let written = '';
  let uploads = 0;
  const run: GwsRunner = (args, opts) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'MONTH' }] }));
      if (p.includes("name='Leverantörsfakturor'")) return okR(JSON.stringify({ files: [{ id: 'TYPE' }] }));
      if (p.includes("name='Faktura_2908.pdf'")) return okR(JSON.stringify({ files: [{ id: 'EXISTINGPDF' }] })); // already uploaded
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      throw new Error(`unexpected list: ${p}`);
    }
    if (args[1] === '+upload') { uploads += 1; return okR(JSON.stringify({ id: 'NEWPDF' })); }
    if (args[2] === 'get') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes('headRevisionId')) return okR(JSON.stringify({ headRevisionId: 'R1' }));
      if (args.includes('-o')) { writeFileSync(path.join(opts!.cwd!, 'download'), STATE_MD); return okR(''); }
    }
    if (args[2] === 'update') { written = readFileSync(path.join(opts!.cwd!, 'state.md'), 'utf8'); return okR('{}'); }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };

  const doc = documentFromClassification('Faktura_2908.pdf', '2026-06', { type: 'leverantörsfaktura', supplier: 'Elwa AB', amount: '2 513,00', document_date: '2026-06-04' });
  const proc = { messageId: 'm9', date: '2026-06-04', from: 'Elwa', subject: 'Faktura 2908', attachmentFilename: 'Faktura_2908.pdf', status: 'classified' };

  const r = fileDocument('2026-06', '/tmp/x/Faktura_2908.pdf', proc, doc, { run, rootFolderId: () => 'ROOT' });

  assert.equal(r.ok, true, r.detail);
  assert.equal(uploads, 0, '+upload must NOT be called when the file already exists');
  assert.equal(r.driveFileId, 'EXISTINGPDF', 'reuses the existing file id, not a new upload');
  assert.ok(written.includes('EXISTINGPDF'), 'the existing id is stamped into the ledger');
});

test('fileDocument: missing month/type/.doppelganger folders are scaffolded, then filing succeeds', () => {
  const STATE_MD = renderStateMd(emptyMonthState('2026-08'));
  const created: string[] = [];
  let written = '';
  const run: GwsRunner = (args, opts) => {
    if (args[2] === 'list') return okR(JSON.stringify({ files: [] })); // nothing exists yet → create paths
    if (args[2] === 'create') {
      const j = JSON.parse(args[args.indexOf('--json') + 1] ?? '{}') as { name?: string };
      created.push(j.name ?? '');
      return okR(JSON.stringify({ id: `NEW_${j.name}` }));
    }
    if (args[1] === '+upload') {
      if (args[args.indexOf('--name') + 1] === 'state.md') { written = readFileSync(path.join(opts!.cwd!, 'state.md'), 'utf8'); return okR(JSON.stringify({ id: 'SMID' })); }
      return okR(JSON.stringify({ id: 'PDFID' }));
    }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const doc = documentFromClassification('x.pdf', '2026-08', { type: 'kvitto', amount: '1,00', document_date: '2026-08-02' });
  const proc = { messageId: 'm', date: '', from: '', subject: '', attachmentFilename: 'x.pdf', status: 'classified' };
  const r = fileDocument('2026-08', '/tmp/x.pdf', proc, doc, { run, rootFolderId: () => 'ROOT' });
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(created, ['2026-08', 'Verifikationer', '.doppelganger'], 'scaffolds month, type folder, .doppelganger');
  assert.ok(written.includes('x.pdf'), 'the row was written into the (new) state.md');
});

// ---- resolveWritableMonth (closed/legacy fallback) --------------------------

test('resolveWritableMonth: home month == current → used as-is, no Drive calls', () => {
  const run: GwsRunner = () => { throw new Error('must not touch Drive'); };
  assert.equal(resolveWritableMonth('2026-07', '2026-07', { run, rootFolderId: () => 'ROOT' }), '2026-07');
});

test('resolveWritableMonth: a fresh (non-existent) home month is used as-is (fileDocument scaffolds it)', () => {
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') return okR(JSON.stringify({ files: [] })); // month folder not found
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  assert.equal(resolveWritableMonth('2026-08', '2026-09', { run, rootFolderId: () => 'ROOT' }), '2026-08');
});

test('resolveWritableMonth: a legacy .nilsark home month diverts to the current month', () => {
  const run: GwsRunner = (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='2026-05'")) return okR(JSON.stringify({ files: [{ id: 'M5' }] }));
    if (p.includes("name='.nilsark'")) return okR(JSON.stringify({ files: [{ id: 'NIL' }] }));
    throw new Error(`unexpected: ${p}`);
  };
  assert.equal(resolveWritableMonth('2026-05', '2026-07', { run, rootFolderId: () => 'ROOT' }), '2026-07');
});

test('resolveWritableMonth: a closed .doppelganger home month diverts; an open one is kept', () => {
  const mk = (closed: boolean): GwsRunner => (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
    if (p.includes("name='.nilsark'")) return okR(JSON.stringify({ files: [] }));
    if (p.includes("name='.doppelganger'")) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
    if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
    throw new Error(`unexpected: ${p}`);
  };
  const closedMd = renderStateMd({ ...emptyMonthState('2026-06'), monthCloseSent: 'yes' });
  const openMd = renderStateMd(emptyMonthState('2026-06'));
  assert.equal(resolveWritableMonth('2026-06', '2026-07', { run: mk(true), download: () => closedMd, rootFolderId: () => 'ROOT' }), '2026-07');
  assert.equal(resolveWritableMonth('2026-06', '2026-07', { run: mk(false), download: () => openMd, rootFolderId: () => 'ROOT' }), '2026-06');
});
