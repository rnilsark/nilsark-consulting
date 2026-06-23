import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Step 2 of the star-clusters plan: TypeScript owns the monthly finance ledger. The typed
// `MonthState` here is the SOURCE OF TRUTH; `state.md` is just a rendered view for the bookkeeper.
// The LLM re-parsing a human-formatted markdown table every run was the root smell — this module
// reads/writes the structured form and renders the markdown deterministically.
//
// Two invariants the agent's prose pinned and we must keep:
//   - Per-document `amount` / `vat_amount` are kept as VERBATIM STRINGS, never reparsed to a number
//     and reformatted. The skip-gate's docKey embeds the amount string; reformatting would drift the
//     fingerprint. Numbers are only ever summed for the (display-only) summary.
//   - Drive writes are guarded by the file's `headRevisionId`: capture it at read time, re-check it
//     immediately before upload, abort on mismatch (another writer raced us).

/** A row of the Processed-Gmail dedup table. `status` is free-form (classified / downloaded / skipped — …). */
export interface ProcessedMessage {
  messageId: string;
  date: string;
  from: string;
  subject: string;
  attachmentFilename: string;
  status: string;
}

/** A classified document row. `amount`/`vatAmount` stay verbatim strings (see module header). */
export interface LedgerDocument {
  file: string;
  type: string;
  supplier: string;
  amount: string;
  currency: string;
  dueDate: string;
  documentDate: string;
  ocrNumber: string;
  bankAccount: string;
  vatAmount: string;
  drivePath: string;
  driveFileId: string;
  paymentStatus: string;
  fortnoxSent: string;
}

/** A bank-statement transaction row and what it matched against. */
export interface BankTransaction {
  date: string;
  description: string;
  amount: string;
  currency: string;
  matchedToFile: string;
  matchConfidence: string;
}

/**
 * The whole month, normalized. Derived summary counts are NOT stored — they are recomputed on render
 * (so they can never drift from the rows). Only the two genuinely-stateful summary fields live here.
 */
export interface MonthState {
  month: string;
  processed: ProcessedMessage[];
  documents: LedgerDocument[];
  bank: BankTransaction[];
  monthCloseSent: string;
  monthCloseDate: string;
}

const PROCESSED_HEADERS = ['message_id', 'date', 'from', 'subject', 'attachment_filename', 'status'];
const DOCUMENT_HEADERS = [
  'file', 'type', 'supplier', 'amount', 'currency', 'due_date', 'document_date',
  'ocr_number', 'bank_account', 'vat_amount', 'drive_path', 'drive_file_id', 'payment_status', 'fortnox_sent',
];
const BANK_HEADERS = ['date', 'description', 'amount', 'currency', 'matched_to_file', 'match_confidence'];

/** An empty month, used as the first-run template. */
export function emptyMonthState(month: string): MonthState {
  return { month, processed: [], documents: [], bank: [], monthCloseSent: 'no', monthCloseDate: '' };
}

/**
 * A `gws` failure whose detail names a credential problem. Auth failures must STOP the caller — never
 * be treated as a transient/retryable error — the same rule the agent's CLAUDE.md auth guard enforces.
 * Read paths already throw on any failure; the write path uses this to throw on auth specifically
 * rather than collapsing it into a recoverable `error` outcome.
 */
// Matched against gws's RAW error text (filenames, hostnames and all), so these are anchored,
// credential-specific phrases — deliberately NOT the bare substrings the agent's prose guard uses.
// A loose includes('auth'|'token'|'login') false-positives on ordinary errors that merely contain
// those letters (a hostname `author-api…`, `token bucket exhausted`, a filename `..._login_….pdf`),
// and on the write path a false positive THROWS and loses the run's ledger update — so it must be tight.
// Separator-agnostic (`[ _-]?`) because Google's OAuth errors use underscores (`invalid_grant`,
// `invalid_token`, `ACCESS_TOKEN_EXPIRED`) while its prose messages use spaces (`Token has been
// expired or revoked`). `\blogin\b` stays word-bounded so an underscore filename (`..._login_...pdf`)
// does NOT match — `_` is a word char, so there's no boundary inside it.
const AUTH_PATTERNS = [
  /unauthenticated/,
  /unauthorized/,
  /invalid[ _-]?grant/,
  /invalid authentication/,
  /authentication (failed|required|error)/,
  /insufficient authentication/,
  /\bcredentials?\b/,
  /\blogin\b/,
  /\blog[ -]in\b/,
  /re-?authenticat/,
  /token[ _-]?(has[ _-]?)?(been[ _-]?)?(expired|revoked|invalid)/,
  /(expired|invalid|missing|revoked)[ _-]?(access|refresh|id)?[ _-]?token/,
];
export function isAuthFailure(detail: string): boolean {
  const d = detail.toLowerCase();
  return AUTH_PATTERNS.some((p) => p.test(d));
}

// ---- parse (markdown → model) ------------------------------------------------

/** Split one `| a | b |` table line into trimmed cells, dropping the leading/trailing empties. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const body = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  return body.split('|').map((c) => c.trim());
}

/** A separator row is all dashes (e.g. `|----|---|`). */
function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^-+$/.test(c));
}

/** Map a section's body rows to objects keyed by `headers` (positional; missing cells → ''). */
function parseTable(lines: string[], headers: string[]): string[][] {
  const rows = lines.filter((l) => l.trim().startsWith('|')).map(splitRow);
  const out: string[][] = [];
  for (const cells of rows) {
    if (isSeparator(cells)) continue;
    // Header row: first cell equals the first expected header. Skip it.
    if (cells[0] === headers[0]) continue;
    out.push(headers.map((_, i) => cells[i] ?? ''));
  }
  return out;
}

/** Carve the markdown into its `## ` sections. Returns the lines under each heading (heading dropped). */
function sections(md: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of md.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1];
      map.set(current, []);
      continue;
    }
    if (current !== null) map.get(current)!.push(line);
  }
  return map;
}

/** Parse a `- key: value` summary line's value for a given key prefix. */
function summaryValue(lines: string[], label: string): string {
  const prefix = `- ${label}:`;
  const line = lines.find((l) => l.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : '';
}

/** Parse a `state.md` document into the typed model. Tolerant: missing sections → empty. */
export function parseStateMd(md: string): MonthState {
  // `[ \t]*` (NOT `\s*`) so a blank value can't let the capture cross a newline and grab a token from
  // the next line — that would defeat readMonthState's corrupt/partial-download guard (month==='').
  const monthMatch = /^#[ \t]*State:[ \t]*(\S+)/m.exec(md);
  const month = monthMatch ? monthMatch[1] : '';
  const secs = sections(md);

  const processed = parseTable(secs.get('Processed Gmail Messages') ?? [], PROCESSED_HEADERS).map(
    (c) => ({ messageId: c[0], date: c[1], from: c[2], subject: c[3], attachmentFilename: c[4], status: c[5] }),
  );
  const documents = parseTable(secs.get('Documents') ?? [], DOCUMENT_HEADERS).map((c) => ({
    file: c[0], type: c[1], supplier: c[2], amount: c[3], currency: c[4], dueDate: c[5], documentDate: c[6],
    ocrNumber: c[7], bankAccount: c[8], vatAmount: c[9], drivePath: c[10], driveFileId: c[11],
    paymentStatus: c[12], fortnoxSent: c[13],
  }));
  const bank = parseTable(secs.get('Bank Statement Transactions') ?? [], BANK_HEADERS).map((c) => ({
    date: c[0], description: c[1], amount: c[2], currency: c[3], matchedToFile: c[4], matchConfidence: c[5],
  }));

  const summary = secs.get('Month Summary') ?? [];
  const monthCloseSent = summaryValue(summary, 'Month-close sent') || 'no';
  const monthCloseDate = summaryValue(summary, 'Month-close date');

  return { month, processed, documents, bank, monthCloseSent, monthCloseDate };
}

// ---- render (model → markdown view) ------------------------------------------

interface DerivedSummary {
  documentsProcessed: number;
  leverantorsfakturor: number;
  kvitton: number;
  skattekonto: number;
  totalVat: string;
  unpaidInvoices: number;
}

const PAYMENT_UNSETTLED = new Set(['unpaid', 'overdue']);

/**
 * Recompute the display summary from the rows. `totalVat` sums input VAT only — kundfaktura is output
 * VAT and is excluded (matches the agent's books). `unpaidInvoices` counts unsettled documents.
 */
export function computeSummary(state: MonthState): DerivedSummary {
  const byType = (t: string) => state.documents.filter((d) => d.type === t).length;
  const totalVat = state.documents
    .filter((d) => d.type !== 'kundfaktura')
    .reduce((sum, d) => sum + (Number.parseFloat(d.vatAmount) || 0), 0);
  return {
    documentsProcessed: state.documents.length,
    leverantorsfakturor: byType('leverantörsfaktura'),
    kvitton: byType('kvitto'),
    skattekonto: byType('skattekonto'),
    totalVat: totalVat.toFixed(2),
    unpaidInvoices: state.documents.filter((d) => PAYMENT_UNSETTLED.has(d.paymentStatus)).length,
  };
}

/**
 * Sanitize a verbatim value for the pipe/newline-delimited table VIEW: a literal `|` or newline would
 * corrupt the row. The JSON model keeps the original; only the rendered markdown substitutes them.
 * Real finance fields (supplier, amount, dates, OCR, account, filename) never contain these; the one
 * arbitrary-text field is an email subject, so this is defensive, not a normal path.
 */
function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '/');
}

function renderTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** Render the typed model back to the canonical `state.md` view (summary recomputed). */
export function renderStateMd(state: MonthState): string {
  const s = computeSummary(state);
  const processedRows = state.processed.map((p) => [p.messageId, p.date, p.from, p.subject, p.attachmentFilename, p.status]);
  const documentRows = state.documents.map((d) => [
    d.file, d.type, d.supplier, d.amount, d.currency, d.dueDate, d.documentDate, d.ocrNumber,
    d.bankAccount, d.vatAmount, d.drivePath, d.driveFileId, d.paymentStatus, d.fortnoxSent,
  ]);
  const bankRows = state.bank.map((b) => [b.date, b.description, b.amount, b.currency, b.matchedToFile, b.matchConfidence]);

  return [
    `# State: ${state.month}`,
    '',
    '## Processed Gmail Messages',
    renderTable(PROCESSED_HEADERS, processedRows),
    '',
    '## Documents',
    renderTable(DOCUMENT_HEADERS, documentRows),
    '',
    '## Bank Statement Transactions',
    renderTable(BANK_HEADERS, bankRows),
    '',
    '## Month Summary',
    `- Documents processed: ${s.documentsProcessed}`,
    `- Leverantörsfakturor: ${s.leverantorsfakturor}`,
    `- Kvitton: ${s.kvitton}`,
    `- Skattekonto: ${s.skattekonto}`,
    `- Total VAT: ${s.totalVat} SEK`,
    `- Unpaid invoices: ${s.unpaidInvoices}`,
    `- Month-close sent: ${state.monthCloseSent}`,
    `- Month-close date:${state.monthCloseDate ? ` ${state.monthCloseDate}` : ''}`,
    '',
  ].join('\n');
}

// ---- Drive I/O (injectable gws seam, collision-guarded) ----------------------

export interface GwsResult {
  ok: boolean;
  stdout: string;
  detail: string;
}

/**
 * Runs a `gws` subcommand and returns its stdout (or a failure detail). Injectable for tests.
 * `opts.cwd` matters for file I/O: `gws files get -o NAME` and `gws +upload NAME` only accept paths
 * INSIDE the current working directory (gws rejects an absolute/outside path), so the file callers run
 * with `cwd` set to a temp dir and pass a bare relative filename.
 */
export type GwsRunner = (args: string[], opts?: { cwd?: string }) => GwsResult;

export const defaultGwsRunner: GwsRunner = (args, opts) => {
  const res = spawnSync('gws', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd });
  if (res.error) return { ok: false, stdout: '', detail: res.error.message };
  if (res.status !== 0) {
    const output = ((res.stdout ?? '') + (res.stderr ?? '')).trim();
    // Never return an empty detail on a failure — fall back to the exit status so the failure is at
    // least diagnosable (and isAuthFailure has a non-empty string to inspect).
    const detail = output ? output.slice(0, 200) : `gws exited with status ${String(res.status)}`;
    return { ok: false, stdout: res.stdout ?? '', detail };
  }
  return { ok: true, stdout: res.stdout ?? '', detail: '' };
};

/** The Drive identity of a state.md file: its id and the revision we read (for the write guard). */
export interface StateFileRef {
  fileId: string;
  headRev: string;
}

/** List the state.md in `folderId`. Returns null when it doesn't exist yet (first run). */
export function resolveStateFile(folderId: string, run: GwsRunner = defaultGwsRunner): StateFileRef | null {
  const q = `name='state.md' and '${folderId}' in parents and trashed=false`;
  const params = JSON.stringify({ q, fields: 'files(id,headRevisionId)' });
  const res = run(['drive', 'files', 'list', '--params', params, '--format', 'json']);
  if (!res.ok) throw new Error(`[state] state.md list failed: ${res.detail}`);
  let files: Array<{ id?: string; headRevisionId?: string }>;
  try {
    files = (JSON.parse(res.stdout) as { files?: typeof files }).files ?? [];
  } catch {
    throw new Error('[state] state.md list returned non-JSON');
  }
  if (files.length === 0) return null; // genuinely first run — no state.md yet
  const f = files[0];
  // A present-but-id-less row is a malformed response, NOT first-run. Returning null here would make
  // the writer `+upload` a duplicate alongside the existing (real) file. Fail loud instead.
  if (!f.id) throw new Error('[state] state.md list returned a file with no id');
  return { fileId: f.id, headRev: f.headRevisionId ?? '' };
}

/** The bytes-download seam — fetch a Drive file's content as text. Injectable for tests. */
export type DriveDownloader = (fileId: string) => string;

/**
 * Build a downloader over a given gws runner. When stdout is piped (how the daemon runs gws), `gws
 * files get --alt media` streams the file CONTENT to stdout — no `-o`, no temp file, no cwd games
 * (an earlier `-o` version silently failed: gws rejects out-of-cwd paths and otherwise streams anyway,
 * which made the gate read null and fire every day).
 */
export function makeDriveDownloader(run: GwsRunner): DriveDownloader {
  return (fileId) => {
    const res = run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId, alt: 'media' })]);
    if (!res.ok) throw new Error(`[state] download ${fileId} failed: ${res.detail}`);
    return res.stdout;
  };
}

export const defaultDriveDownloader: DriveDownloader = makeDriveDownloader(defaultGwsRunner);

export interface ReadResult {
  state: MonthState;
  ref: StateFileRef | null;
}

/**
 * Read the month's state from Drive into the typed model. When state.md doesn't exist yet, returns
 * the empty template with `ref: null` (first run — the writer will create it). A downloaded file that
 * is missing the `# State:` header is treated as a corrupt/partial download and THROWS — never parsed
 * into a near-empty state, which a later write would then clobber the real ledger with.
 */
export function readMonthState(
  month: string,
  folderId: string,
  deps: { run?: GwsRunner; download?: DriveDownloader } = {},
): ReadResult {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const ref = resolveStateFile(folderId, run);
  if (ref === null) return { state: emptyMonthState(month), ref: null };
  const state = parseStateMd(download(ref.fileId));
  if (state.month === '') {
    throw new Error(`[state] downloaded state.md for ${month} has no "# State:" header — refusing to trust a corrupt/partial download`);
  }
  return { state, ref };
}

export type WriteOutcome =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'collision' }
  | { ok: false; reason: 'error'; detail: string };

/**
 * Render and write the month's state to Drive, guarded against a mid-air collision: before updating an
 * existing file, re-fetch its `headRevisionId` and abort if it moved since we read `ref`. A null `ref`
 * means first-run create (no guard — the file didn't exist). The collision guard is exactly the agent's
 * contract, now owned by code.
 */
export function writeMonthState(
  state: MonthState,
  folderId: string,
  ref: StateFileRef | null,
  run: GwsRunner = defaultGwsRunner,
): WriteOutcome {
  // A gws failure during a write is either auth (THROW — a dead credential must stop the caller, never
  // look retryable) or transient (return an `error` outcome the caller may retry/alert on).
  const onFailure = (detail: string): WriteOutcome => {
    if (isAuthFailure(detail)) throw new Error(`[state] gws auth failure during write: ${detail}`);
    return { ok: false, reason: 'error', detail };
  };

  const dir = mkdtempSync(path.join(tmpdir(), 'dg-state-'));
  // gws uploads only accept a path inside cwd, so write a bare-named file in `dir` and run gws there.
  const name = 'state.md';
  try {
    writeFileSync(path.join(dir, name), renderStateMd(state));

    if (ref === null) {
      const res = run([
        'drive', '+upload', name, '--parent', folderId, '--name', 'state.md', '--format', 'json',
      ], { cwd: dir });
      return res.ok ? { ok: true, created: true } : onFailure(res.detail);
    }

    const meta = run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId: ref.fileId, fields: 'headRevisionId' }), '--format', 'json']);
    if (!meta.ok) return onFailure(meta.detail);
    let currentHeadRev: string;
    try {
      currentHeadRev = (JSON.parse(meta.stdout) as { headRevisionId?: string }).headRevisionId ?? '';
    } catch {
      return { ok: false, reason: 'error', detail: 'headRevisionId fetch returned non-JSON' };
    }
    // The guard is only meaningful with two real revisions to compare. An empty revision on either
    // side means we cannot prove we aren't racing another writer — abort rather than silently write.
    if (!ref.headRev || !currentHeadRev) {
      return { ok: false, reason: 'error', detail: 'cannot verify revision (empty headRevisionId)' };
    }
    if (currentHeadRev !== ref.headRev) return { ok: false, reason: 'collision' };

    // NOTE residual TOCTOU: gws `files update` carries no server-side revision precondition, so a
    // writer that races between this re-check and the upload is not caught. The window is the same one
    // the agent's prose contract had — parity, not a regression. Single-writer-under-concurrency-cap
    // is what actually keeps this safe in practice.
    const res = run([
      'drive', 'files', 'update', '--params', JSON.stringify({ fileId: ref.fileId }),
      '--upload', name, '--upload-content-type', 'text/markdown',
    ], { cwd: dir });
    return res.ok ? { ok: true, created: false } : onFailure(res.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
