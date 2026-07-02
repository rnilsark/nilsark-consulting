import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runFinanceCli } from '../src/finance-cli.ts';
import { emptyMonthState, renderStateMd, type BankTransaction, type GwsResult, type GwsRunner } from '../src/adapters/state.ts';

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });
const bank = (over: Partial<BankTransaction>): BankTransaction =>
  ({ date: '2026-06-10', description: '', amount: '-100.00', currency: 'SEK', matchedToFile: '', matchConfidence: 'unmatched', unmatchedReason: '', ...over });

/** Mock a single Drive month (June present, others empty) serving `md` and capturing the write. */
function mockJune(md: string) {
  const cap = { written: '' };
  const run: GwsRunner = (args, opts) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (args[2] === 'list') {
      if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
      if (p.includes('.doppelganger') && p.includes("'M6'")) return okR(JSON.stringify({ files: [{ id: 'DOPP6' }] }));
      if (p.includes('state.md') && p.includes("'DOPP6'")) return okR(JSON.stringify({ files: [{ id: 'SM6', headRevisionId: 'R6' }] }));
      return okR(JSON.stringify({ files: [] }));
    }
    if (args[2] === 'get' && p.includes('headRevisionId')) return okR(JSON.stringify({ headRevisionId: 'R6' }));
    if (args[2] === 'update') { cap.written = readFileSync(path.join(opts!.cwd!, args[args.indexOf('--upload') + 1]), 'utf8'); return okR('{}'); }
    return okR(JSON.stringify({ files: [] }));
  };
  return { run, download: () => md, cap };
}

test('finance-cli state: reads the live reconciliation for a month', () => {
  const m = mockJune(renderStateMd({ ...emptyMonthState('2026-06'), bank: [bank({ description: 'KF', amount: '-20000.00' })] }));
  const out = runFinanceCli(['state', '2026-06'], { filing: { run: m.run, download: m.download, rootFolderId: () => 'ROOT' }, today: '2026-07-03' });
  assert.match(out, /Avstämning 2026-06/);
  assert.match(out, /KF/);
});

test('finance-cli explain: tags an unmatched bank row and reports the change', () => {
  const m = mockJune(renderStateMd({ ...emptyMonthState('2026-06'), bank: [bank({ description: 'KF', amount: '-20000.00' })] }));
  const out = runFinanceCli(['explain', 'KF', 'överföring'], { filing: { run: m.run, download: m.download, rootFolderId: () => 'ROOT' }, today: '2026-07-03' });
  assert.match(out, /OK \(2026-06\)/);
  assert.match(m.cap.written, /KF \|[^\n]*\| överföring \|/);
});

test('finance-cli close: rejects a non-YYYY-MM month without touching Drive', () => {
  assert.match(runFinanceCli(['close', 'juni']), /FEL: ange månad/);
});

test('finance-cli: an unknown command lists the valid ones', () => {
  assert.match(runFinanceCli(['frobnicate']), /Okänt kommando/);
});
