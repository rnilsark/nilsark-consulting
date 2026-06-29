import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionableDocs, markOverdue, scanAnomalies, updateNotify } from '../src/adapters/finance-rollup.ts';
import { computeFingerprint } from '../src/adapters/finance.ts';
import type { LedgerDocument, MonthState } from '../src/adapters/state.ts';

const EMPTY_HASH = 'e3b0c44298fc1c14'; // sha256("") first 16 hex — the no-actionable-items fingerprint

function doc(p: Partial<LedgerDocument> = {}): LedgerDocument {
  return {
    file: 'f.pdf', type: 'leverantörsfaktura', supplier: 'Fortnox', amount: '450', currency: 'SEK',
    dueDate: '2026-06-30', documentDate: '2026-06-01', ocrNumber: '123', bankAccount: 'BG 1-2',
    vatAmount: '90', drivePath: '', driveFileId: '', paymentStatus: 'unpaid', fortnoxSent: 'no', ...p,
  };
}
function ms(documents: LedgerDocument[]): MonthState {
  return { month: '2026-06', processed: [], documents, bank: [], monthCloseSent: 'no', monthCloseDate: '' };
}

// ---- markOverdue ------------------------------------------------------------

test('markOverdue: a past-due unpaid invoice becomes overdue; future + non-invoices untouched', () => {
  const state = ms([
    doc({ file: 'past.pdf', dueDate: '2026-06-01' }),     // due passed → overdue
    doc({ file: 'future.pdf', dueDate: '2026-06-30' }),   // still due later → stays unpaid
    doc({ file: 'kvitto.pdf', type: 'kvitto', paymentStatus: 'n/a', dueDate: '2026-06-01' }), // not payable
  ]);
  const out = markOverdue(state, '2026-06-15');
  assert.equal(out.documents.find((d) => d.file === 'past.pdf')?.paymentStatus, 'overdue');
  assert.equal(out.documents.find((d) => d.file === 'future.pdf')?.paymentStatus, 'unpaid');
  assert.equal(out.documents.find((d) => d.file === 'kvitto.pdf')?.paymentStatus, 'n/a');
});

test('markOverdue: no change → returns the same reference (no needless write)', () => {
  const state = ms([doc({ dueDate: '2026-06-30' })]);
  assert.equal(markOverdue(state, '2026-06-15'), state);
});

// ---- actionableDocs ---------------------------------------------------------

test('actionableDocs: only unpaid/overdue leverantörsfakturor + skattekonto', () => {
  const state = ms([
    doc({ file: 'a.pdf', paymentStatus: 'unpaid' }),
    doc({ file: 'b.pdf', paymentStatus: 'overdue' }),
    doc({ file: 'c.pdf', paymentStatus: 'paid' }),
    doc({ file: 'd.pdf', type: 'kvitto', paymentStatus: 'n/a' }),
    doc({ file: 'e.pdf', type: 'skattekonto', paymentStatus: 'unpaid' }),
    doc({ file: 'f.pdf', type: 'kundfaktura', paymentStatus: 'unpaid' }),
  ]);
  assert.deepEqual(actionableDocs(state).map((d) => d.file).sort(), ['a.pdf', 'b.pdf', 'e.pdf']);
});

// ---- updateNotify -----------------------------------------------------------

test('updateNotify: a brand-new item is added unacked; fingerprint matches the gate recompute', () => {
  const { items, fingerprint } = updateNotify({}, [doc({ supplier: 'Telia', amount: '1250', dueDate: '2026-06-18' })], 'pending', '2026-06-15');
  const key = 'Telia|1250|2026-06-18';
  assert.equal(items[key]?.acknowledged, false);
  assert.equal(items[key]?.bucket, 'due_soon');
  assert.equal(fingerprint, computeFingerprint(items, '2026-06-15')); // never drifts from the gate
  assert.notEqual(fingerprint, EMPTY_HASH);
});

test('updateNotify: empty actionable set → empty-string fingerprint', () => {
  const { items, fingerprint } = updateNotify({}, [], 'reconciled', '2026-06-15');
  assert.deepEqual(items, {});
  assert.equal(fingerprint, EMPTY_HASH);
});

test('updateNotify: an item still actionable keeps its ack + last_notified', () => {
  const prev = { 'Fortnox|450|2026-06-30': { bucket: 'due_soon', acknowledged: true, last_notified: '2026-06-10', supplier: 'Fortnox', amount: '450', due_date: '2026-06-30' } };
  const { items } = updateNotify(prev, [doc({ dueDate: '2026-06-30' })], 'pending', '2026-06-25');
  assert.equal(items['Fortnox|450|2026-06-30']?.acknowledged, true);
  assert.equal(items['Fortnox|450|2026-06-30']?.last_notified, '2026-06-10');
});

test('updateNotify: due_soon→overdue crossing re-fires (clears ack) when the statement has confirmed', () => {
  const prev = { 'Fortnox|450|2026-06-14': { bucket: 'due_soon', acknowledged: true, last_notified: '2026-06-10', supplier: 'Fortnox', amount: '450', due_date: '2026-06-14' } };
  const { items } = updateNotify(prev, [doc({ dueDate: '2026-06-14' })], 'reconciled', '2026-06-20'); // now overdue, export confirmed
  assert.equal(items['Fortnox|450|2026-06-14']?.acknowledged, false); // re-surfaced
  assert.equal(items['Fortnox|450|2026-06-14']?.last_notified, null);
});

test('updateNotify: bank blind spot — keep ack across the crossing while the statement is unconfirmed', () => {
  const prev = { 'Fortnox|450|2026-06-14': { bucket: 'due_soon', acknowledged: true, last_notified: '2026-06-10', supplier: 'Fortnox', amount: '450', due_date: '2026-06-14' } };
  const { items } = updateNotify(prev, [doc({ dueDate: '2026-06-14' })], 'pending', '2026-06-20'); // overdue but unconfirmed
  assert.equal(items['Fortnox|450|2026-06-14']?.acknowledged, true); // trust the operator until the statement arrives
});

test('updateNotify: a no-longer-actionable item is dropped from notify.items', () => {
  const prev = { 'Old|99|2026-05-01': { bucket: 'overdue', acknowledged: false, last_notified: null, supplier: 'Old', amount: '99', due_date: '2026-05-01' } };
  const { items } = updateNotify(prev, [], 'reconciled', '2026-06-15');
  assert.equal(items['Old|99|2026-05-01'], undefined);
});

// ---- scanAnomalies ----------------------------------------------------------

test('scanAnomalies: each rule fires on its trigger', () => {
  const state = ms([
    doc({ file: 'new.pdf', supplier: 'Kasai', amount: '500', vatAmount: '100' }), // new supplier (rate 100/400=25% ok)
    doc({ file: 'big.pdf', supplier: 'Fortnox', amount: '14200', vatAmount: '2840' }), // >10k (rate 25% ok)
    doc({ file: 'noref.pdf', supplier: 'Fortnox', amount: '300', vatAmount: '60', ocrNumber: '', bankAccount: '' }), // no OCR/BG
    doc({ file: 'vat.pdf', supplier: 'Fortnox', amount: '1000', vatAmount: '170' }), // 170/830 ≈ 20.5% → odd VAT
    doc({ file: 'eur.pdf', supplier: 'Fortnox', amount: '90', vatAmount: '18', currency: 'EUR' }),
  ]);
  const flags = scanAnomalies(state, new Set(['Fortnox']));
  const has = (file: string, frag: string) => flags.some((f) => f.file === file && f.flag.includes(frag));
  assert.ok(has('new.pdf', 'ny leverantör'));
  assert.ok(has('big.pdf', '> 10k'));
  assert.ok(has('noref.pdf', 'OCR/bankgiro'));
  assert.ok(has('vat.pdf', 'avvikande moms'));
  assert.ok(has('eur.pdf', 'valuta EUR'));
  assert.ok(!has('new.pdf', 'avvikande moms'), 'a clean 25% VAT row is not flagged');
});

test('scanAnomalies: same supplier+amount twice → both flagged as duplicates', () => {
  const state = ms([
    doc({ file: 'x1.pdf', supplier: 'Fortnox', amount: '450' }),
    doc({ file: 'x2.pdf', supplier: 'Fortnox', amount: '450' }),
  ]);
  const dups = scanAnomalies(state, new Set(['Fortnox'])).filter((f) => f.flag.includes('dubblett'));
  assert.deepEqual(dups.map((f) => f.file).sort(), ['x1.pdf', 'x2.pdf']);
});
