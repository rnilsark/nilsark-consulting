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

// ---- payUrgency / composeTodo / composePush ---------------------------------

import { composePush, composeTodo, payUrgency, planFinanceRollup, type PeriodPlan } from '../src/adapters/finance-rollup.ts';
import { emptyMonthState, renderStateMd, type GwsRunner, type GwsResult } from '../src/adapters/state.ts';

test('payUrgency: overdue/≤2d → URGENT, ≤7d → SOON, else SCHEDULED', () => {
  assert.equal(payUrgency('2026-06-10', '2026-06-15'), 'URGENT');  // overdue
  assert.equal(payUrgency('2026-06-16', '2026-06-15'), 'URGENT');  // ≤2d
  assert.equal(payUrgency('2026-06-20', '2026-06-15'), 'SOON');    // ≤7d
  assert.equal(payUrgency('2026-07-30', '2026-06-15'), 'SCHEDULED');
});

function plan(p: Partial<PeriodPlan>): PeriodPlan {
  return { month: '2026-06', pay: [], anomalies: [], exportNeeded: false, approve: null, waiting: null, storedFingerprint: null, freshFingerprint: null, ...p };
}

test('composeTodo: groups by month with PAY (urgency-sorted), EXPORT, GODKÄNN, VÄNTAR', () => {
  const todo = composeTodo([
    plan({ month: '2026-05', exportNeeded: true, waiting: '2026-05: väntar på kontoutdrag' }),
    plan({
      month: '2026-06',
      pay: [doc({ supplier: 'Telia', amount: '1250', dueDate: '2026-06-25' }), doc({ supplier: 'Fortnox', amount: '450', dueDate: '2026-06-10' })],
      approve: { drafts: 6 },
      anomalies: [{ file: 'x', flag: '⚠ ny leverantör' }],
    }),
  ], '2026-06-15');
  assert.ok(todo.includes('## Ekonomi 2026-05'));
  assert.ok(todo.includes('EXPORTERA: kontoutdrag för 2026-05'));
  assert.ok(todo.includes('VÄNTAR: 2026-05'));
  assert.ok(todo.includes('GODKÄNN: 6 bokföringsutkast (⚠ ny leverantör)'));
  // Fortnox is overdue (URGENT) → must sort before Telia (SOON).
  assert.ok(todo.indexOf('Fortnox') < todo.indexOf('Telia'), 'urgent pay item first');
});

test('composePush: null when no fingerprint changed; summarizes only changed periods', () => {
  assert.equal(composePush([plan({ storedFingerprint: 'a', freshFingerprint: 'a' })], '2026-06-15'), null);
  const push = composePush([
    plan({ month: '2026-06', storedFingerprint: 'a', freshFingerprint: 'b', pay: [doc({ supplier: 'Fortnox', amount: '450', dueDate: '2026-06-10' })] }),
  ], '2026-06-15');
  assert.ok(push?.includes('Ekonomi 2026-06'));
  assert.ok(push?.includes('Fortnox 450 kr'));
  assert.ok(push?.includes('brådskande')); // overdue → urgent marker
});

// ---- planFinanceRollup (read-only orchestrator, mocked Drive) ---------------

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });

test('planFinanceRollup: reads this month, builds the PAY set + a changed fingerprint, writes nothing', () => {
  // One open current month with a single unpaid invoice, and no stored fingerprint → push fires.
  const stateMd = renderStateMd({
    ...emptyMonthState('2026-06'),
    documents: [doc({ file: 'inv.pdf', supplier: 'Fortnox', amount: '450', dueDate: '2026-06-20', paymentStatus: 'unpaid' })],
  });
  let wrote = false;
  const run: GwsRunner = (args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (args[2] === 'list') {
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes("name='2026-0'") || p.includes("name='2026-04'") || p.includes("name='2026-05'")) return okR(JSON.stringify({ files: [] }));
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    if (args[2] === 'update' || args[1] === '+upload') { wrote = true; return okR('{}'); }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const r = planFinanceRollup({
    today: '2026-06-15',
    run,
    download: () => stateMd,
    rootFolderId: () => 'ROOT',
    financeState: { run, download: () => JSON.stringify({ version: 2, periods: {} }), rootFolderId: () => 'ROOT' },
  });
  assert.equal(wrote, false, 'planFinanceRollup is read-only');
  assert.equal(r.periods.length, 1);
  assert.equal(r.periods[0].pay.length, 1);
  assert.notEqual(r.periods[0].freshFingerprint, r.periods[0].storedFingerprint); // null stored → changed
  assert.ok(r.push?.includes('Fortnox'));
  assert.deepEqual(Object.keys(r.notify['2026-06'].items), ['Fortnox|450|2026-06-20']);
});

test('planFinanceRollup: no drive root → empty plan, no throw', () => {
  const r = planFinanceRollup({ today: '2026-06-15', rootFolderId: () => null });
  assert.equal(r.periods.length, 0);
  assert.equal(r.push, null);
});

// ---- applyFinanceRollup (write path, mocked Drive) --------------------------

import { applyFinanceRollup } from '../src/adapters/finance-rollup.ts';
import { openDb } from '../src/db.ts';
import { readFileSync as rf } from 'node:fs';
import nodePath from 'node:path';

test('applyFinanceRollup: persists notify.items + fingerprint to state.json, uploads the todo, no throw', () => {
  const db = openDb(':memory:');
  const stateMd = renderStateMd({
    ...emptyMonthState('2026-06'),
    documents: [doc({ file: 'inv.pdf', supplier: 'Fortnox', amount: '450', dueDate: '2026-06-25', paymentStatus: 'unpaid' })],
  });
  const list = (p: string) => {
    if (p.includes("name='2026-06'")) return { files: [{ id: 'M6' }] };
    if (p.includes('.doppelganger')) return { files: [{ id: 'DOPP' }] };
    if (p.includes('state.md')) return { files: [{ id: 'SM', headRevisionId: 'R1' }] };
    if (p.includes('state.json')) return { files: [{ id: 'SJ' }] };
    return { files: [] }; // prior months + the day's todo file: not present
  };
  let stateJson = '';
  const run: GwsRunner = (args, opts) => {
    if (args[2] === 'list') return okR(JSON.stringify(list(args[args.indexOf('--params') + 1] ?? '')));
    if (args[2] === 'update' && args[args.indexOf('--upload') + 1] === 'state.json') { stateJson = rf(nodePath.join(opts!.cwd!, 'state.json'), 'utf8'); return okR('{}'); }
    if (args[2] === 'update' || args[1] === '+upload' || args[2] === 'get') return okR('{}');
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const r = applyFinanceRollup(db, {
    today: '2026-06-15',
    run,
    download: () => stateMd,
    rootFolderId: () => 'ROOT',
    financeState: { run, download: () => JSON.stringify({ version: 2, periods: {} }), rootFolderId: () => 'ROOT' },
  });
  assert.equal(r.periods, 1);
  assert.equal(r.closed, null); // no ready prior month
  assert.ok(stateJson.includes('Fortnox|450|2026-06-25'), 'the unpaid item is persisted to state.json');
  assert.ok(stateJson.includes('"version": 2'));
});

// ---- ackPayment (chat ack fast-path) ----------------------------------------

import { ackPayment } from '../src/adapters/finance-rollup.ts';

test('ackPayment: marks the named supplier acknowledged, recomputes fingerprint, persists', () => {
  const state = {
    version: 2,
    periods: {
      '2026-06': {
        export_status: 'pending',
        notify: {
          fingerprint: 'old',
          items: {
            'Fortnox|450|2026-06-25': { bucket: 'due_soon', acknowledged: false, last_notified: null, supplier: 'Fortnox', amount: '450', due_date: '2026-06-25' },
            'Telia|1250|2026-06-20': { bucket: 'due_soon', acknowledged: false, last_notified: null, supplier: 'Telia', amount: '1250', due_date: '2026-06-20' },
          },
        },
      },
    },
  };
  let written = '';
  const run: GwsRunner = (args, opts) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (args[2] === 'list') {
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'D' }] }));
      if (p.includes('state.json')) return okR(JSON.stringify({ files: [{ id: 'SJ' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    if (args[2] === 'update') { written = rf(nodePath.join(opts!.cwd!, 'state.json'), 'utf8'); return okR('{}'); }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const fsDeps = { run, download: () => JSON.stringify(state), rootFolderId: () => 'ROOT' };

  const r = ackPayment('fortnox', { financeState: fsDeps, today: '2026-06-15' });
  assert.equal(r.matched, 1);
  const out = JSON.parse(written) as typeof state;
  assert.equal(out.periods['2026-06'].notify.items['Fortnox|450|2026-06-25'].acknowledged, true);
  assert.equal(out.periods['2026-06'].notify.items['Telia|1250|2026-06-20'].acknowledged, false); // untouched
  assert.notEqual(out.periods['2026-06'].notify.fingerprint, 'old'); // recomputed (Fortnox drops from the set)
});

test('ackPayment: no match → reads but never writes, matched 0', () => {
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'D' }] }));
      if (p.includes('state.json')) return okR(JSON.stringify({ files: [{ id: 'SJ' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    throw new Error('must not write when there is no match'); // update/+upload would throw
  };
  const r = ackPayment('Nonexistent', { financeState: { run, download: () => JSON.stringify({ version: 2, periods: {} }), rootFolderId: () => 'ROOT' }, today: '2026-06-15' });
  assert.equal(r.matched, 0);
});
