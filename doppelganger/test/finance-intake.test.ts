import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insertEvent, insertQueue, openDb, type Db } from '../src/db.ts';
import { documentFromClassification, intakeDocument, normalizeAmount } from '../src/adapters/finance-intake.ts';

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
