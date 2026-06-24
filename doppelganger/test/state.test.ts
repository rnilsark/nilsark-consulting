import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeSummary,
  emptyMonthState,
  isAuthFailure,
  makeDriveDownloader,
  parseStateMd,
  readMonthState,
  renderStateMd,
  resolveStateFile,
  writeMonthState,
  type GwsResult,
  type GwsRunner,
  type MonthState,
} from '../src/adapters/state.ts';

const FIXTURE = readFileSync(path.join(import.meta.dirname, 'fixtures', 'state-2026-06.md'), 'utf8');

// ---- parse ------------------------------------------------------------------

test('parseStateMd: reads the real 2026-06 ledger', () => {
  const s = parseStateMd(FIXTURE);
  assert.equal(s.month, '2026-06');
  assert.equal(s.processed.length, 12);
  assert.equal(s.documents.length, 12);
  assert.equal(s.bank.length, 0);
  assert.equal(s.monthCloseSent, 'no');
  assert.equal(s.monthCloseDate, '');
});

test('parseStateMd: a document row maps every column by position', () => {
  const s = parseStateMd(FIXTURE);
  const avanza = s.documents.find((d) => d.supplier === 'Avanza Pension');
  assert.ok(avanza);
  assert.equal(avanza.type, 'leverantörsfaktura');
  assert.equal(avanza.amount, '15352.00'); // verbatim string — not reparsed
  assert.equal(avanza.currency, 'SEK');
  assert.equal(avanza.dueDate, '2026-06-30');
  assert.equal(avanza.ocrNumber, '2000214688234');
  assert.equal(avanza.bankAccount, 'BG 5274-7896');
  assert.equal(avanza.vatAmount, '0.00');
  assert.equal(avanza.paymentStatus, 'unpaid');
  assert.equal(avanza.fortnoxSent, 'no');
});

test('parseStateMd: blank cells survive as empty strings', () => {
  const s = parseStateMd(FIXTURE);
  const kundfaktura = s.documents.find((d) => d.type === 'kundfaktura');
  assert.ok(kundfaktura);
  assert.equal(kundfaktura.dueDate, ''); // genuinely blank in the source
  assert.equal(kundfaktura.ocrNumber, '');
  const skatt = s.documents.find((d) => d.type === 'skattekonto');
  assert.ok(skatt);
  assert.equal(skatt.vatAmount, ''); // blank, not "0"
});

test('parseStateMd: a supplier with parentheses is not split (no embedded pipe)', () => {
  const s = parseStateMd(FIXTURE);
  const v = s.documents.find((d) => d.file.startsWith('Verktygsboden'));
  assert.ok(v);
  assert.equal(v.supplier, 'Verktygsboden Erfilux AB (GörDetMedRW)');
});

// ---- summary ----------------------------------------------------------------

test('computeSummary: matches the agent-authored summary in the fixture', () => {
  const s = parseStateMd(FIXTURE);
  const sum = computeSummary(s);
  assert.equal(sum.documentsProcessed, 12);
  assert.equal(sum.leverantorsfakturor, 5);
  assert.equal(sum.kvitton, 5);
  assert.equal(sum.skattekonto, 1);
  assert.equal(sum.totalVat, '1680.62'); // input VAT only — kundfaktura excluded
  assert.equal(sum.unpaidInvoices, 6); // unpaid + overdue
});

// ---- round-trip -------------------------------------------------------------

test('round-trip: parse(render(parse(md))) deep-equals parse(md)', () => {
  const once = parseStateMd(FIXTURE);
  const twice = parseStateMd(renderStateMd(once));
  assert.deepEqual(twice, once);
});

test('round-trip: an empty month renders and re-parses cleanly', () => {
  const empty = emptyMonthState('2026-07');
  const back = parseStateMd(renderStateMd(empty));
  assert.deepEqual(back, empty);
});

// ---- migration (model → JSON) -----------------------------------------------

test('migration: model serializes to JSON and back losslessly', () => {
  const s = parseStateMd(FIXTURE);
  const json = JSON.stringify(s);
  const back = JSON.parse(json) as MonthState;
  assert.deepEqual(back, s);
  // and the JSON ledger re-renders to a state.md the agent could still read
  assert.deepEqual(parseStateMd(renderStateMd(back)), s);
});

// ---- Drive I/O (fake gws runner) --------------------------------------------

const ok = (stdout: string): GwsResult => ({ ok: true, stdout, detail: '' });
const fail = (detail: string): GwsResult => ({ ok: false, stdout: '', detail });

function scriptedRunner(steps: Array<(args: string[]) => GwsResult>): { run: GwsRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: GwsRunner = (args) => {
    calls.push(args);
    const step = steps[i++];
    if (!step) throw new Error(`unexpected gws call #${i}: ${args.join(' ')}`);
    return step(args);
  };
  return { run, calls };
}

test('resolveStateFile: returns ref when the file exists', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }))]);
  assert.deepEqual(resolveStateFile('FOLDER', run), { fileId: 'F1', headRev: 'R1' });
});

test('resolveStateFile: returns null when no file exists (first run)', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [] }))]);
  assert.equal(resolveStateFile('FOLDER', run), null);
});

test('resolveStateFile: throws on a gws error (never mistakes it for first-run)', () => {
  const { run } = scriptedRunner([() => fail('network down')]);
  assert.throws(() => resolveStateFile('FOLDER', run), /list failed/);
});

test('readMonthState: first run returns the empty template with null ref', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [] }))]);
  const res = readMonthState('2026-07', 'FOLDER', { run, download: () => 'unused' });
  assert.equal(res.ref, null);
  assert.deepEqual(res.state, emptyMonthState('2026-07'));
});

test('readMonthState: existing file is downloaded and parsed', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }))]);
  const res = readMonthState('2026-06', 'FOLDER', { run, download: () => FIXTURE });
  assert.deepEqual(res.ref, { fileId: 'F1', headRev: 'R1' });
  assert.equal(res.state.documents.length, 12);
});

test('writeMonthState: first-run create uses +upload, no collision check', () => {
  const { run, calls } = scriptedRunner([() => ok('{}')]);
  const out = writeMonthState(emptyMonthState('2026-07'), 'FOLDER', null, run);
  assert.deepEqual(out, { ok: true, created: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '+upload');
});

test('writeMonthState: head unchanged → re-check then update', () => {
  const steps = [
    () => ok(JSON.stringify({ headRevisionId: 'R1' })), // re-fetch matches read-time R1
    () => ok('{}'), // update
  ];
  const { run, calls } = scriptedRunner(steps);
  const out = writeMonthState(emptyMonthState('2026-06'), 'FOLDER', { fileId: 'F1', headRev: 'R1' }, run);
  assert.deepEqual(out, { ok: true, created: false });
  assert.equal(calls[1][2], 'update');
});

test('writeMonthState: head moved → collision, NO upload', () => {
  const { run, calls } = scriptedRunner([() => ok(JSON.stringify({ headRevisionId: 'R2' }))]);
  const out = writeMonthState(emptyMonthState('2026-06'), 'FOLDER', { fileId: 'F1', headRev: 'R1' }, run);
  assert.deepEqual(out, { ok: false, reason: 'collision' });
  assert.equal(calls.length, 1); // only the head re-fetch; never attempted the update
});

test('writeMonthState: upload failure surfaces as an error outcome', () => {
  const steps = [() => ok(JSON.stringify({ headRevisionId: 'R1' })), () => fail('quota exceeded')];
  const { run } = scriptedRunner(steps);
  const out = writeMonthState(emptyMonthState('2026-06'), 'FOLDER', { fileId: 'F1', headRev: 'R1' }, run);
  assert.deepEqual(out, { ok: false, reason: 'error', detail: 'quota exceeded' });
});

// ---- render shape (byte-level canonical form) -------------------------------

test('renderStateMd: empty month renders the pinned canonical bytes', () => {
  const expected = [
    '# State: 2026-07',
    '',
    '## Processed Gmail Messages',
    '| message_id | date | from | subject | attachment_filename | status |',
    '|---|---|---|---|---|---|',
    '',
    '## Documents',
    '| file | type | supplier | amount | currency | due_date | document_date | ocr_number | bank_account | vat_amount | drive_path | drive_file_id | payment_status | fortnox_sent |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    '',
    '## Bank Statement Transactions',
    '| date | description | amount | currency | matched_to_file | match_confidence |',
    '|---|---|---|---|---|---|',
    '',
    '## Month Summary',
    '- Documents processed: 0',
    '- Leverantörsfakturor: 0',
    '- Kvitton: 0',
    '- Skattekonto: 0',
    '- Total VAT: 0.00 SEK',
    '- Unpaid invoices: 0',
    '- Month-close sent: no',
    '- Month-close date:', // no trailing space when empty
    '',
  ].join('\n');
  assert.equal(renderStateMd(emptyMonthState('2026-07')), expected);
});

test('renderStateMd: no rendered line has trailing whitespace', () => {
  for (const line of renderStateMd(parseStateMd(FIXTURE)).split('\n')) {
    assert.equal(line, line.replace(/\s+$/, ''), `trailing whitespace on: ${JSON.stringify(line)}`);
  }
});

// ---- parser tolerance / edge cases ------------------------------------------

test('parseStateMd: missing "# State:" header → month is empty, rest still parses', () => {
  const md = FIXTURE.replace(/^# State:.*$/m, '');
  const s = parseStateMd(md);
  assert.equal(s.month, '');
  assert.equal(s.documents.length, 12); // tables still parse
});

test('parseStateMd: a short row pads missing trailing cells with empty strings', () => {
  const md = [
    '# State: 2026-09',
    '## Documents',
    '| file | type | supplier | amount | currency | due_date | document_date | ocr_number | bank_account | vat_amount | drive_path | drive_file_id | payment_status | fortnox_sent |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    '| short.pdf | kvitto | ACME |', // only 3 cells
  ].join('\n');
  const d = parseStateMd(md).documents[0];
  assert.equal(d.file, 'short.pdf');
  assert.equal(d.supplier, 'ACME');
  assert.equal(d.amount, ''); // missing → ''
  assert.equal(d.fortnoxSent, '');
});

test('parseStateMd: an over-long row drops the overflow cells', () => {
  const md = [
    '# State: 2026-09',
    '## Bank Statement Transactions',
    '| date | description | amount | currency | matched_to_file | match_confidence |',
    '|---|---|---|---|---|---|',
    '| 2026-09-01 | x | 1 | SEK | f.pdf | exact | EXTRA | JUNK |',
  ].join('\n');
  const b = parseStateMd(md).bank[0];
  assert.equal(b.matchConfidence, 'exact'); // 6th column; extras ignored
});

test('render+parse: a value containing a pipe or newline is sanitized in the view', () => {
  // The JSON model can hold a pipe/newline (e.g. an email subject); the markdown view must not let it
  // break the table. Render replaces them; the re-parsed view is the sanitized form (lossy by design).
  const s = emptyMonthState('2026-09');
  s.processed.push({
    messageId: 'm1', date: '2026-09-01', from: 'a@b.c',
    subject: 'Faktura | rad1\nrad2', attachmentFilename: 'f.pdf', status: 'classified',
  });
  const back = parseStateMd(renderStateMd(s));
  assert.equal(back.processed[0].subject, 'Faktura / rad1 rad2'); // pipe→/, newline→space
  assert.equal(back.processed.length, 1); // newline did NOT spawn a spurious row
});

// ---- computeSummary edges ---------------------------------------------------

test('computeSummary: zero documents → 0.00 VAT and 0 counts', () => {
  const sum = computeSummary(emptyMonthState('2026-09'));
  assert.equal(sum.totalVat, '0.00');
  assert.equal(sum.documentsProcessed, 0);
  assert.equal(sum.unpaidInvoices, 0);
});

test('computeSummary: paid and n/a are NOT counted as unpaid; overdue is', () => {
  const s = emptyMonthState('2026-09');
  const doc = (paymentStatus: string): MonthState['documents'][number] => ({
    file: 'f', type: 'leverantörsfaktura', supplier: 's', amount: '1', currency: 'SEK', dueDate: '',
    documentDate: '', ocrNumber: '', bankAccount: '', vatAmount: '', drivePath: '', driveFileId: '',
    paymentStatus, fortnoxSent: 'no',
  });
  s.documents.push(doc('paid'), doc('n/a'), doc('overdue'), doc('unpaid'));
  assert.equal(computeSummary(s).unpaidInvoices, 2); // overdue + unpaid only
});

// ---- error-path branches ----------------------------------------------------

test('resolveStateFile: throws on non-JSON stdout (never read as first-run)', () => {
  const { run } = scriptedRunner([() => ok('not json')]);
  assert.throws(() => resolveStateFile('FOLDER', run), /non-JSON/);
});

test('resolveStateFile: an id-less file row throws (not mistaken for first-run)', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [{ headRevisionId: 'R1' }] }))]);
  assert.throws(() => resolveStateFile('FOLDER', run), /no id/);
});

test('readMonthState: a download missing the header throws (corrupt/partial guard)', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }))]);
  assert.throws(
    () => readMonthState('2026-06', 'FOLDER', { run, download: () => '<html>error</html>' }),
    /corrupt\/partial/,
  );
});

test('readMonthState: a download error propagates (not swallowed into empty state)', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }))]);
  assert.throws(
    () => readMonthState('2026-06', 'FOLDER', { run, download: () => { throw new Error('download boom'); } }),
    /download boom/,
  );
});

test('readMonthState: default downloader is driven by the injected run (command construction)', () => {
  // Only `run` is injected (no `download`), so the real downloader runs — and its gws media-get must
  // go through the same scripted runner. The fake writes the fixture to the `-o` destination.
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') return ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }));
    if (args[2] === 'get') return ok(FIXTURE); // `files get --alt media` streams content to stdout
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const res = readMonthState('2026-06', 'FOLDER', { run });
  assert.equal(res.state.documents.length, 12);
});

test('writeMonthState: a non-JSON headRevisionId re-fetch is an error, never a silent write', () => {
  const { run, calls } = scriptedRunner([() => ok('garbage')]);
  const out = writeMonthState(emptyMonthState('2026-06'), 'FOLDER', { fileId: 'F1', headRev: 'R1' }, run);
  assert.deepEqual(out, { ok: false, reason: 'error', detail: 'headRevisionId fetch returned non-JSON' });
  assert.equal(calls.length, 1); // never attempted the update
});

test('writeMonthState: an empty current headRevisionId aborts (cannot verify)', () => {
  const { run, calls } = scriptedRunner([() => ok(JSON.stringify({ headRevisionId: '' }))]);
  const out = writeMonthState(emptyMonthState('2026-06'), 'FOLDER', { fileId: 'F1', headRev: 'R1' }, run);
  assert.deepEqual(out, { ok: false, reason: 'error', detail: 'cannot verify revision (empty headRevisionId)' });
  assert.equal(calls.length, 1);
});

test('writeMonthState: an auth failure THROWS (a dead credential must never look retryable)', () => {
  const { run } = scriptedRunner([() => fail('Request had invalid authentication credentials. token expired')]);
  assert.throws(
    () => writeMonthState(emptyMonthState('2026-07'), 'FOLDER', null, run),
    /auth failure/,
  );
});

test('isAuthFailure: matches credential keywords, ignores ordinary errors', () => {
  assert.equal(isAuthFailure('401 Unauthorized'), true);
  assert.equal(isAuthFailure('invalid token'), true);
  assert.equal(isAuthFailure('please login again'), true);
  assert.equal(isAuthFailure('Request had invalid authentication credentials'), true);
  assert.equal(isAuthFailure('UNAUTHENTICATED'), true);
  assert.equal(isAuthFailure('quota exceeded'), false);
  assert.equal(isAuthFailure('network timeout'), false);
});

test('isAuthFailure: matches Google OAuth error codes (underscores + word order)', () => {
  // These slipped through an earlier too-tight rewrite; they are the most common live-credential
  // failures, so a miss would make the write path treat a dead credential as retryable.
  assert.equal(isAuthFailure('invalid_grant'), true);
  assert.equal(isAuthFailure('invalid_token'), true);
  assert.equal(isAuthFailure('ACCESS_TOKEN_EXPIRED'), true);
  assert.equal(isAuthFailure('Token has been expired or revoked'), true);
  assert.equal(isAuthFailure('insufficient authentication scopes'), true);
  assert.equal(isAuthFailure('The credentials do not contain the necessary fields'), true);
});

test('isAuthFailure: does NOT false-positive on errors that merely contain the letters', () => {
  // These must stay retryable `error` outcomes on the write path, not throw.
  assert.equal(isAuthFailure('Failed to resolve host author-api.googleapis.com'), false);
  assert.equal(isAuthFailure('rateLimitExceeded for token bucket'), false);
  assert.equal(isAuthFailure('could not upload Faktura_login_2908.pdf: 503'), false);
  assert.equal(isAuthFailure('request to /authorize/refresh timed out'), false);
  assert.equal(isAuthFailure('backendError: tokenizer service unavailable'), false);
});

test('parseStateMd: a blank value after "# State:" does NOT capture the next line (guard intact)', () => {
  // Regression for the `\s*`→`[ \t]*` fix: a truncated download must yield month '' so the corrupt
  // guard fires — not capture "##" off the following line.
  const md = '# State:\n## Documents\n| file | type |\n|---|---|\n';
  assert.equal(parseStateMd(md).month, '');
});

test('readMonthState: a header-on-its-own-line truncation is still rejected as corrupt', () => {
  const { run } = scriptedRunner([() => ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }))]);
  assert.throws(
    () => readMonthState('2026-06', 'FOLDER', { run, download: () => '# State:\n## Documents\n' }),
    /corrupt\/partial/,
  );
});

test('makeDriveDownloader: reads the -o file when gws writes content there (markdown case)', () => {
  // gws for markdown returns a {bytes,saved_file} wrapper on stdout and writes content to the -o file.
  const run: GwsRunner = (args, opts) => {
    assert.ok(opts?.cwd, 'download must run with a cwd');
    const name = args[args.indexOf('-o') + 1];
    writeFileSync(path.join(opts.cwd, name), FIXTURE);
    return ok(JSON.stringify({ bytes: 5257, saved_file: name })); // wrapper, NOT the content
  };
  assert.equal(parseStateMd(makeDriveDownloader(run)('F1')).documents.length, 12);
});

test('readMonthState: a download gws failure (via the real downloader) propagates', () => {
  // Only `run` injected → exercises makeDriveDownloader's own res.ok===false throw branch.
  const run: GwsRunner = (args) => {
    if (args[2] === 'list') return ok(JSON.stringify({ files: [{ id: 'F1', headRevisionId: 'R1' }] }));
    if (args[2] === 'get') return fail('media 404');
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  assert.throws(() => readMonthState('2026-06', 'FOLDER', { run }), /download F1 failed: media 404/);
});

test('renderStateMd: a populated document row is byte-pinned (cell spacing + verbatim values)', () => {
  const rendered = renderStateMd(parseStateMd(FIXTURE));
  assert.ok(
    rendered.includes(
      '| Faktura_2908.pdf | leverantörsfaktura | Elwa AB | 2513.00 | SEK | 2026-06-14 | 2026-06-04 | 290866 | BG 5542-9468 | 502.50 | 2026-06/Leverantörsfakturor/ | 1IMyW-J7-O3WQ7tmKEAd2ta56O3XzVK5m | overdue | no |',
    ),
    'populated row format drifted',
  );
});

test('round-trip: a closed month (Month-close sent/date set) round-trips both fields', () => {
  const s = emptyMonthState('2026-05');
  s.monthCloseSent = 'yes';
  s.monthCloseDate = '2026-06-03';
  const rendered = renderStateMd(s);
  assert.ok(rendered.includes('- Month-close sent: yes'));
  assert.ok(rendered.includes('- Month-close date: 2026-06-03')); // leading space present when set
  assert.deepEqual(parseStateMd(rendered), s);
});
