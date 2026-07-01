// Month-close, in TypeScript — the last procedure peeled off the entrepreneur. It prepares the
// bookkeeping handoff as Gmail DRAFTS (never sends): one draft per document type that still has
// unsent rows, each with that type's PDFs attached and a plain filename-list body. There is no
// judgment here — which types, which recipient, which subject are all deterministic — so it lives as
// code. The safety guards from the old skill are preserved exactly: `draftTestMode` (default on)
// routes every draft to the operator's own address with a `[TEST]` subject, a non-zero gws exit is
// treated as failure (a masked success would create duplicate drafts), and rows are marked
// `fortnox_sent = yes` ONLY after their draft is confirmed created.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DRIVE_FOLDER_MIME,
  findChildId,
  readDriveRootFolderId,
  readLedgerSettings,
  type LedgerSettings,
} from './ledger-store.ts';
import { downloadDriveFileToPath } from './reconcile.ts';
import {
  defaultGwsRunner,
  makeDriveDownloader,
  parseStateMd,
  resolveStateFile,
  writeMonthState,
  type DriveDownloader,
  type GwsRunner,
  type LedgerDocument,
  type MonthState,
} from './state.ts';

interface CloseType {
  type: string;
  folder: string;
  label: string;
  /** key into settings.fortnoxEmail.* for the non-test recipient. */
  key: string;
}

const CLOSE_TYPES: CloseType[] = [
  { type: 'kvitto', folder: 'Verifikationer', label: 'kvitton', key: 'verifikation' },
  { type: 'leverantörsfaktura', folder: 'Leverantörsfakturor', label: 'leverantörsfakturor', key: 'leverantorsfaktura' },
  { type: 'skattekonto', folder: 'Skattekonto', label: 'skattekonto', key: 'skattekonto' },
  { type: 'kundfaktura', folder: 'Kundfakturor', label: 'kundfakturor', key: 'kundfaktura' },
];

/** One per-type draft to create: the rows it covers, where to send it, and the subject. `skip` set
 *  with a reason means the draft can't be addressed (test mode with no myEmail) — reported, not
 *  attempted, and it blocks the close. A type that's intentionally not handed off (empty recipient
 *  config) is omitted from the plan entirely, not skipped. */
export interface DraftSpec {
  type: string;
  folder: string;
  label: string;
  files: LedgerDocument[];
  recipient: string;
  subject: string;
  skip: string | null;
}

/**
 * Which drafts a close would create, and to whom. Pure — the recipient gate (`draftTestMode`) and the
 * subject are deterministic. `fortnoxEmail` decides WHICH types are handed off to the bookkeeper: an
 * empty/missing entry means that type is intentionally not handed off (e.g. skattekonto) and is omitted
 * entirely — no draft, and it must NOT block the close. `draftTestMode` only reroutes the handed-off
 * types to the operator's own inbox (with a `[TEST]` subject). A type with no unsent rows is omitted too.
 */
export function closeDraftPlan(state: MonthState, settings: LedgerSettings): DraftSpec[] {
  const testMode = settings.draftTestMode !== false; // default ON (safe): drafts go to the operator
  const specs: DraftSpec[] = [];
  for (const ct of CLOSE_TYPES) {
    const files = state.documents.filter((d) => d.type === ct.type && d.fortnoxSent === 'no');
    if (files.length === 0) continue;
    const handoff = settings.fortnoxEmail?.[ct.key] ?? '';
    if (!handoff) continue; // not handed off to Fortnox → no draft, doesn't block the close
    let recipient = handoff;
    let skip: string | null = null;
    if (testMode) {
      recipient = settings.myEmail ?? '';
      if (!recipient) skip = 'no myEmail in settings';
    }
    const subject = `${testMode ? '[TEST] ' : ''}Nilsark Consulting AB — ${ct.label} — ${state.month}`;
    specs.push({ type: ct.type, folder: ct.folder, label: ct.label, files, recipient, subject, skip });
  }
  return specs;
}

export interface CloseDeps {
  run?: GwsRunner;
  download?: DriveDownloader;
  rootFolderId?: () => string | null;
  settings?: LedgerSettings;
}

export interface CloseResult {
  closed: boolean;
  draftsCreated: number;
  detail: string;
}

/** Create ONE draft with all of a type's PDFs attached. Returns true only on a clean (exit 0) create. */
function createDraft(spec: DraftSpec, dir: string, names: string[], run: GwsRunner): boolean {
  const args = ['gmail', '+send', '--draft', '--to', spec.recipient, '--subject', spec.subject, '--body', `Bifogade filer: ${names.join(', ')}`];
  for (const n of names) args.push('-a', n);
  return run(args, { cwd: dir }).ok; // a non-zero exit ⇒ failure ⇒ rows stay unsent (no duplicate drafts)
}

/**
 * Close `month`: per type with unsent rows, download its PDFs, create one Gmail draft, and on success
 * mark those rows `fortnox_sent = yes`. When every non-skipped type succeeded, set `Month-close sent:
 * yes` + the date. Writes state.md once at the end (collision-guarded). Best-effort: a missing recipient
 * or a failed draft leaves those rows unsent for the next run; never throws on a Drive/Gmail miss.
 */
export function runMonthClose(month: string, deps: CloseDeps = {}): CloseResult {
  const run = deps.run ?? defaultGwsRunner;
  const download = deps.download ?? makeDriveDownloader(run);
  const settings = deps.settings ?? readLedgerSettings();
  const rootId = (deps.rootFolderId ?? readDriveRootFolderId)();
  if (!rootId) return { closed: false, draftsCreated: 0, detail: 'no drive root folder id' };
  const monthId = findChildId(rootId, month, DRIVE_FOLDER_MIME, run);
  if (!monthId) return { closed: false, draftsCreated: 0, detail: `month folder ${month} not found` };
  const doppId = findChildId(monthId, '.doppelganger', DRIVE_FOLDER_MIME, run);
  if (!doppId) return { closed: false, draftsCreated: 0, detail: 'no .doppelganger folder' };
  const ref = resolveStateFile(doppId, run);
  if (!ref) return { closed: false, draftsCreated: 0, detail: `no state.md for ${month}` };
  let state = parseStateMd(download(ref.fileId));
  if (state.month === '') return { closed: false, draftsCreated: 0, detail: 'state.md unreadable' };

  const specs = closeDraftPlan(state, settings);
  if (specs.length === 0) return { closed: false, draftsCreated: 0, detail: 'nothing to close (no unsent rows)' };

  const sent = new Set<string>(); // files whose row should flip to fortnox_sent=yes
  let draftsCreated = 0;
  let allOk = true;
  const dir = mkdtempSync(path.join(tmpdir(), `dg-close-${month}-`));
  try {
    for (const spec of specs) {
      if (spec.skip) { allOk = false; continue; } // no recipient → leave for next run
      const names: string[] = [];
      for (const d of spec.files) {
        const dest = path.join(dir, d.file);
        const typeFolderId = findChildId(monthId, spec.folder, DRIVE_FOLDER_MIME, run);
        const fileId = d.driveFileId && d.driveFileId !== 'upload-failed'
          ? d.driveFileId
          : typeFolderId ? findChildId(typeFolderId, d.file, null, run) : null;
        if (fileId && downloadDriveFileToPath(fileId, dest, run)) names.push(d.file);
      }
      if (names.length === 0) { allOk = false; continue; } // couldn't fetch any PDF → don't draft an empty batch
      if (createDraft(spec, dir, names, run)) {
        draftsCreated++;
        for (const n of names) sent.add(n);
      } else {
        allOk = false;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const documents = state.documents.map((d) => (sent.has(d.file) ? { ...d, fortnoxSent: 'yes' } : d));
  const closed = allOk && draftsCreated > 0;
  state = {
    ...state,
    documents,
    monthCloseSent: closed ? 'yes' : state.monthCloseSent,
    monthCloseDate: closed ? new Date().toISOString().slice(0, 10) : state.monthCloseDate,
  };
  const w = writeMonthState(state, doppId, ref, run);
  if (!w.ok) return { closed: false, draftsCreated, detail: `state write ${w.reason}` };
  return { closed, draftsCreated, detail: closed ? `closed ${month}: ${draftsCreated} draft(s)` : `${draftsCreated} draft(s), ${month} left open` };
}
