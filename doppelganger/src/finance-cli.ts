// The finance toolset the `chat` agent invokes directly (granted only in the operator's own thread —
// the worker gates it, never for untrusted/family chat). Each subcommand is thin glue over the same
// tested adapter functions the digest uses, so chat reads the LIVE ledger and acts, instead of
// reasoning over a frozen snapshot + its own chat log. Prints a short human line the agent relays.
//
//   state|review [month]                 read the live reconciliation for a month
//   mark-paid <supplier> [--link <text>] mark an invoice paid, optionally link a bank row
//   explain <bank-text> <reason>         tag an unmatched bank row as expected (KF = överföring …)
//   set-due <supplier> <YYYY-MM-DD>      fix a document's due date
//   close <month>                        close the month (drafts the Fortnox handoff) — explicit only

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLedgerCorrection, reviewReconcile } from './adapters/reconcile.ts';
import { runMonthClose } from './adapters/month-close.ts';
import type { FilingDeps } from './adapters/intake.ts';
import type { LedgerSettings } from './adapters/ledger-store.ts';

export interface FinanceCliDeps {
  filing?: FilingDeps;
  settings?: LedgerSettings;
  today?: string;
}

/** Split argv rest into positionals and `--flag value` pairs. */
function parseArgs(rest: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = rest[i + 1] ?? ''; i++; }
    else positional.push(a);
  }
  return { positional, flags };
}

/** Dispatch one CLI invocation to the adapter functions. Pure over `deps` (so it's testable without a
 *  real Drive). Returns the line to print. */
export function runFinanceCli(argv: string[], deps: FinanceCliDeps = {}): string {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const filing = deps.filing;
  const today = deps.today;

  switch (cmd) {
    case 'state':
    case 'review': {
      const rv = reviewReconcile(positional[0], { filing, today });
      return rv ? rv.summary : 'Ingen avstämning att visa än.';
    }
    case 'mark-paid': {
      const r = applyLedgerCorrection({ supplier: positional[0], setPaid: true, linkBankDescription: flags.link || undefined, month: flags.month || undefined }, { filing, today });
      return r.ok ? `OK — ${r.file ?? positional[0]} (${r.month}): ${r.detail}` : `FEL: ${r.detail}`;
    }
    case 'explain': {
      const r = applyLedgerCorrection({ explainBank: positional[0], explainReason: positional[1], month: flags.month || undefined }, { filing, today });
      return r.ok ? `OK (${r.month}): ${r.detail}` : `FEL: ${r.detail}`;
    }
    case 'set-due': {
      const r = applyLedgerCorrection({ supplier: positional[0], dueDate: positional[1], month: flags.month || undefined }, { filing, today });
      return r.ok ? `OK — ${r.file ?? positional[0]} (${r.month}): ${r.detail}` : `FEL: ${r.detail}`;
    }
    case 'close': {
      const month = positional[0];
      if (!/^\d{4}-\d{2}$/.test(month ?? '')) return 'FEL: ange månad som YYYY-MM';
      const r = runMonthClose(month, { run: filing?.run, download: filing?.download, rootFolderId: filing?.rootFolderId, settings: deps.settings });
      return r.closed ? `Stängde ${month} — ${r.draftsCreated} utkast skapade: ${r.detail}` : `Ej stängd: ${r.detail}`;
    }
    default:
      return `Okänt kommando "${cmd ?? ''}". Använd: state | mark-paid | explain | set-due | close`;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(runFinanceCli(process.argv.slice(2)) + '\n');
}
