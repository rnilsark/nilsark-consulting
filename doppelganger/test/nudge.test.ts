import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { bankStatementNudge, monthCloseNudge } from '../src/adapters/nudge.ts';
import { emptyMonthState, renderStateMd, type GwsRunner, type GwsResult } from '../src/adapters/state.ts';

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

// ---- monthCloseNudge --------------------------------------------------------

/** Drive deps serving a single month's state.md (`md`) — for the close nudge's monthCloseSent read. */
const driveDeps = (md: string) => ({
  run: ((args) => {
    const p = args[args.indexOf('--params') + 1] ?? '';
    if (p.includes("name='2026-06'")) return okR(JSON.stringify({ files: [{ id: 'M6' }] }));
    if (p.includes('.doppelganger')) return okR(JSON.stringify({ files: [{ id: 'D6' }] }));
    if (p.includes('state.md')) return okR(JSON.stringify({ files: [{ id: 'SM6' }] }));
    return okR(JSON.stringify({ files: [] }));
  }) as GwsRunner,
  download: () => md,
  rootFolderId: () => 'ROOT',
});

test('monthCloseNudge: last month reconciled + not closed → prompts to stäng, then dedups', () => {
  const db = openDb(':memory:');
  const fs = fsDeps(JSON.stringify({ version: 2, periods: { '2026-06': { export_status: 'reconciled' } } }));
  const md = renderStateMd(emptyMonthState('2026-06')); // Month-close sent: no
  const r1 = monthCloseNudge(db, { today: '2026-07-03', financeState: fs, drive: driveDeps(md) });
  assert.match(r1.detail, /2026-06/); // no push target in test → "would nudge"
  const r2 = monthCloseNudge(db, { today: '2026-07-04', financeState: fs, drive: driveDeps(md) });
  assert.match(r2.detail, /already nudged/);
});

test('monthCloseNudge: month already closed → no nudge', () => {
  const fs = fsDeps(JSON.stringify({ version: 2, periods: { '2026-06': { export_status: 'reconciled' } } }));
  const md = renderStateMd({ ...emptyMonthState('2026-06'), monthCloseSent: 'yes' });
  const r = monthCloseNudge(openDb(':memory:'), { today: '2026-07-03', financeState: fs, drive: driveDeps(md) });
  assert.equal(r.nudged, false);
  assert.match(r.detail, /already closed/);
});

test('monthCloseNudge: last month not reconciled → no nudge', () => {
  const fs = fsDeps(JSON.stringify({ version: 2, periods: { '2026-06': { export_status: 'pending' } } }));
  const r = monthCloseNudge(openDb(':memory:'), { today: '2026-07-03', financeState: fs, drive: driveDeps('') });
  assert.equal(r.nudged, false);
  assert.match(r.detail, /not reconciled/);
});
