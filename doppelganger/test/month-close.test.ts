import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { closeDraftPlan, runMonthClose } from '../src/adapters/month-close.ts';
import { emptyMonthState, renderStateMd, type GwsRunner, type GwsResult, type LedgerDocument, type MonthState } from '../src/adapters/state.ts';

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });

function doc(p: Partial<LedgerDocument> = {}): LedgerDocument {
  return {
    file: 'k.pdf', type: 'kvitto', supplier: 'SL', amount: '430', currency: 'SEK', dueDate: '', documentDate: '2026-06-02',
    ocrNumber: '', bankAccount: '', vatAmount: '0', drivePath: '2026-06/Verifikationer/', driveFileId: 'PDF1', paymentStatus: 'n/a', fortnoxSent: 'no', ...p,
  };
}
function ms(documents: LedgerDocument[]): MonthState {
  return { ...emptyMonthState('2026-06'), documents };
}

// ---- closeDraftPlan (pure recipient/subject routing) ------------------------

test('closeDraftPlan: test mode → drafts to myEmail with a [TEST] subject, only types with unsent rows', () => {
  const specs = closeDraftPlan(
    ms([doc(), doc({ file: 'l.pdf', type: 'leverantörsfaktura', fortnoxSent: 'yes' })]),
    { draftTestMode: true, myEmail: 'me@x.se', fortnoxEmail: { verifikation: 'v@bok.se' } },
  );
  assert.equal(specs.length, 1); // only kvitto has unsent rows
  assert.equal(specs[0].recipient, 'me@x.se'); // test mode reroutes the handed-off type to the operator
  assert.equal(specs[0].subject, '[TEST] Nilsark Consulting AB — kvitton — 2026-06');
  assert.equal(specs[0].skip, null);
});

test('closeDraftPlan: live mode routes by fortnoxEmail.*, and OMITS a type with no address (not handed off)', () => {
  const state = ms([doc(), doc({ file: 'l.pdf', type: 'leverantörsfaktura' })]);
  const specs = closeDraftPlan(state, { draftTestMode: false, fortnoxEmail: { verifikation: 'kvitto@bok.se' } });
  const kvitto = specs.find((s) => s.type === 'kvitto')!;
  assert.equal(kvitto.recipient, 'kvitto@bok.se');
  assert.equal(kvitto.subject, 'Nilsark Consulting AB — kvitton — 2026-06');
  assert.equal(specs.find((s) => s.type === 'leverantörsfaktura'), undefined); // no address → omitted, not drafted
});

test('closeDraftPlan: an empty recipient omits the type (no draft) without blocking the close', () => {
  const state = ms([doc(), doc({ file: 's.pdf', type: 'skattekonto', drivePath: '2026-06/Skattekonto/' })]);
  const specs = closeDraftPlan(state, { draftTestMode: false, fortnoxEmail: { verifikation: 'v@bok.se', skattekonto: '' } });
  assert.deepEqual(specs.map((s) => s.type), ['kvitto']); // skattekonto intentionally not handed off → omitted
  assert.ok(specs.every((s) => s.skip === null)); // nothing left to block the close
});

test('closeDraftPlan: default (no draftTestMode set) is test mode — the safe default', () => {
  const specs = closeDraftPlan(ms([doc()]), { myEmail: 'me@x.se', fortnoxEmail: { verifikation: 'v@bok.se' } });
  assert.ok(specs[0].subject.startsWith('[TEST]'));
  assert.equal(specs[0].recipient, 'me@x.se');
});

// ---- runMonthClose (mocked gws) ---------------------------------------------

test('runMonthClose: drafts the kvitto batch, marks rows sent, sets Month-close sent', () => {
  const STATE_MD = renderStateMd(ms([doc()]));
  let written = '';
  let draftToldTo = '';
  const run: GwsRunner = (args, opts) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes("name='Verifikationer'")) return okR(JSON.stringify({ files: [{ id: 'VERIF' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    if (args[1] === '+send' && args.includes('--draft')) { draftToldTo = args[args.indexOf('--to') + 1] ?? ''; return okR(JSON.stringify({ id: 'draft1' })); }
    if (args[2] === 'get') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes('headRevisionId')) return okR(JSON.stringify({ headRevisionId: 'R1' })); // write-guard re-check
      if (args.includes('-o')) { writeFileSync(path.join(opts!.cwd!, args[args.indexOf('-o') + 1]), '%PDF-1'); return okR(''); }
    }
    if (args[2] === 'update') { written = readFileSync(path.join(opts!.cwd!, 'state.md'), 'utf8'); return okR('{}'); }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const r = runMonthClose('2026-06', { run, download: () => STATE_MD, rootFolderId: () => 'ROOT', settings: { draftTestMode: true, myEmail: 'me@x.se', fortnoxEmail: { verifikation: 'v@bok.se' } } });
  assert.equal(r.closed, true, r.detail);
  assert.equal(r.draftsCreated, 1);
  assert.equal(draftToldTo, 'me@x.se'); // test-mode recipient
  assert.ok(written.includes('Month-close sent: yes'));
  assert.match(written, /\| k\.pdf \|[^\n]*\| yes \|/); // the row's fortnox_sent flipped to yes
});

test('runMonthClose: nothing unsent → no draft, month stays open', () => {
  const STATE_MD = renderStateMd(ms([doc({ fortnoxSent: 'yes' })]));
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') {
      const p = args[args.indexOf('--params') + 1] ?? '';
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'DOPP' }] }));
      if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM', headRevisionId: 'R1' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const r = runMonthClose('2026-06', { run, download: () => STATE_MD, rootFolderId: () => 'ROOT', settings: { myEmail: 'me@x.se' } });
  assert.equal(r.closed, false);
  assert.equal(r.draftsCreated, 0);
  assert.match(r.detail, /nothing to close/);
});
