import { config } from '../config.ts';
import { getChannelCursor, insertOutbox, operatorPushTarget, setChannelCursor, type Db } from '../db.ts';
import {
  operatorToday,
  prevMonth,
  readFinanceStateFromDrive,
  type DriveStateDeps,
} from './finance.ts';

// The month-start nudge: early each month, ask the operator once to drop last month's bank statement
// in the Drive folder — but only if it isn't reconciled yet and no statement has arrived.

export interface NudgeDeps {
  today?: string;
  financeState?: DriveStateDeps;
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

  const fs = readFinanceStateFromDrive(deps.financeState);
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
