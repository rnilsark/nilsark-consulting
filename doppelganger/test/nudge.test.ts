import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { bankStatementNudge } from '../src/adapters/nudge.ts';
import { type GwsRunner, type GwsResult } from '../src/adapters/state.ts';

const okR = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });

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
