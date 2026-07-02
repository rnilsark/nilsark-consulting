import { config } from '../config.ts';
import { getChannelCursor, insertOutbox, operatorPushTarget, setChannelCursor, type Db } from '../db.ts';
import {
  operatorToday,
  prevMonth,
  readLedgerState,
  readMonthState,
  type LedgerStoreDeps,
} from './ledger-store.ts';

// The month-start nudge: early each month, ask the operator once to drop last month's bank statement
// in the Drive folder — but only if it isn't reconciled yet and no statement has arrived.

export interface NudgeDeps {
  today?: string;
  financeState?: LedgerStoreDeps;
  /** Drive deps for reading a month's state.md (close-nudge only). */
  drive?: LedgerStoreDeps;
}

/**
 * Early each month, if LAST month isn't reconciled yet and no statement has arrived, push the operator
 * once: "drop last month's statement in the Drive folder." Human-in-loop only when actually needed.
 * Self-gating: only the first 7 days of the month, and deduped (one nudge per period, via
 * channel_state `banknudge`). Pushes nothing if there's no operator push target.
 */
export function bankStatementNudge(db: Db, deps: NudgeDeps = {}): { nudged: boolean; detail: string } {
  const today = deps.today ?? operatorToday();
  if (Number(today.slice(8, 10)) > 7) return { nudged: false, detail: 'not the start of the month' };
  const period = prevMonth(today);
  if (getChannelCursor(db, 'banknudge') === period) return { nudged: false, detail: `already nudged for ${period}` };

  const fs = readLedgerState(deps.financeState);
  if (fs?.periods?.[period]?.export_status === 'reconciled') {
    setChannelCursor(db, 'banknudge', period); // mark so we don't recheck all month
    return { nudged: false, detail: `${period} already reconciled` };
  }

  const target = config.operatorNumber ? operatorPushTarget(db, config.operatorNumber) : null;
  if (target) {
    insertOutbox(db, {
      channel: target.channel,
      conversation_id: target.conversationId,
      text: `Dags att stämma av ${period}. Ladda upp månadens kontoutdrag till Drive-mappen "${config.bankDropFolder}" så sköter jag resten.`,
    });
  }
  setChannelCursor(db, 'banknudge', period);
  return { nudged: !!target, detail: target ? `nudged for ${period}` : `would nudge for ${period} (no push target)` };
}

/**
 * Prompt the operator to close last month once it's READY — reconciled (state.json) but not yet closed
 * (state.md). The digest never auto-closes (a review-hold: the books are the operator's to sign off), so
 * this is the "it's reasonable to close now" nudge. One push per period (deduped via channel_state
 * `closenudge`); the operator acts with "stäng <mån>". Pushes nothing without an operator target.
 */
export function monthCloseNudge(db: Db, deps: NudgeDeps = {}): { nudged: boolean; detail: string } {
  const today = deps.today ?? operatorToday();
  const period = prevMonth(today);
  if (getChannelCursor(db, 'closenudge') === period) return { nudged: false, detail: `already nudged for ${period}` };

  if (readLedgerState(deps.financeState)?.periods?.[period]?.export_status !== 'reconciled') {
    return { nudged: false, detail: `${period} not reconciled yet` };
  }
  const state = readMonthState(period, deps.drive);
  if (!state) return { nudged: false, detail: `${period} state.md unreadable` };
  if (state.monthCloseSent === 'yes') {
    setChannelCursor(db, 'closenudge', period); // already closed → stop checking
    return { nudged: false, detail: `${period} already closed` };
  }

  const target = config.operatorNumber ? operatorPushTarget(db, config.operatorNumber) : null;
  if (target) {
    insertOutbox(db, {
      channel: target.channel,
      conversation_id: target.conversationId,
      text: `${period} är avstämt och redo att stängas. Säg "stäng ${period}" när du vill, så bokför jag och skapar Fortnox-utkasten.`,
    });
  }
  setChannelCursor(db, 'closenudge', period);
  return { nudged: !!target, detail: target ? `nudged for ${period}` : `would nudge for ${period} (no push target)` };
}
