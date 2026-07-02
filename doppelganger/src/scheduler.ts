import cron from 'node-cron';
import { enqueue, jobs } from './adapters/schedule.ts';
import { runHealthcheck } from './adapters/health.ts';
import { ingestChat } from './adapters/chat.ts';
import { maybeEnqueueDigest } from './adapters/digest.ts';
import { operatorToday, shadowValidateMonth } from './adapters/ledger-store.ts';
import { pollBankDrop } from './adapters/reconcile.ts';
import { sweepFinanceInbox } from './adapters/sweep.ts';
import { bankStatementNudge, monthCloseNudge } from './adapters/nudge.ts';
import { ingestInbox } from './adapters/inbox.ts';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { drainOutbox } from './outbox.ts';
import type { Channel } from './channels/types.ts';

/** Runs the adapters' polls in-process — no OS cron. Channels are owned by the main process. */
export function startScheduler(db: Db, channels: Map<string, Channel>): void {
  for (const job of jobs) {
    cron.schedule(job.cron, () => {
      try {
        enqueue(db, job);
      } catch (err) {
        console.error(`[scheduler] enqueue failed for ${job.agent}/${job.task}:`, err);
      }
    });
    console.log(`[scheduler] ${job.agent}/${job.task} @ "${job.cron}"`);
  }

  cron.schedule(config.healthcheckCron, () => {
    try {
      runHealthcheck(db);
    } catch (err) {
      console.error('[scheduler] healthcheck failed:', err);
    }
  });
  console.log(`[scheduler] healthcheck @ "${config.healthcheckCron}"`);

  cron.schedule(config.financeHeartbeatCron, () => {
    try {
      try {
        const s = sweepFinanceInbox(db); // daily collect backstop: enqueue inbox rows for any mail the cursor poll missed
        if (s.enqueued > 0) console.log(`[intake-sweep] ${s.enqueued} message(s) → inbox`);
      } catch (err) {
        console.error('[intake-sweep] failed:', err);
      }
      maybeEnqueueDigest(db); // gated enqueue — see ledger-store.ts
      try {
        // step 2 shadow check (read-only): prove the TS ledger round-trips the live book
        const r = shadowValidateMonth(operatorToday().slice(0, 7));
        console.log(`[state-shadow] ${r.month} found=${r.found} clean=${r.clean} — ${r.detail}`);
      } catch (err) {
        console.error('[state-shadow] failed:', err);
      }
      try {
        const n = bankStatementNudge(db); // early-month: ask for last month's statement if unreconciled
        if (n.nudged) console.log(`[bank-nudge] ${n.detail}`);
      } catch (err) {
        console.error('[bank-nudge] failed:', err);
      }
      try {
        const c = monthCloseNudge(db); // last month reconciled but not closed → prompt to "stäng"
        if (c.nudged) console.log(`[close-nudge] ${c.detail}`);
      } catch (err) {
        console.error('[close-nudge] failed:', err);
      }
    } catch (err) {
      console.error('[scheduler] digest heartbeat gate failed:', err);
    }
  });
  console.log(`[scheduler] digest heartbeat gate @ "${config.financeHeartbeatCron}"`);

  cron.schedule(config.inboxPollCron, () => {
    try {
      ingestInbox(db, config.inboxSenders); // event-driven intake: enqueue metadata-only `inbox` rows for new finance mail
    } catch (err) {
      console.error('[scheduler] inbox ingest failed:', err);
    }
  });
  console.log(`[scheduler] inbox ingest @ "${config.inboxPollCron}"`);

  cron.schedule(config.bankDropCron, () => {
    try {
      const { enqueued } = pollBankDrop(db); // bank statements uploaded straight to Drive → statement
      if (enqueued > 0) console.log(`[bank-drop] enqueued ${enqueued} statement(s) → statement`);
    } catch (err) {
      console.error('[scheduler] bank-drop poll failed:', err);
    }
  });
  console.log(`[scheduler] bank-drop poll @ "${config.bankDropCron}"`);

  if (channels.size > 0) {
    cron.schedule(config.chatPollCron, async () => {
      try {
        ingestChat(db, channels, config.allowedSenders, config.operatorNumber); // inbound: allowlist-gated → operator DMs to chat, rest to triage
      } catch (err) {
        console.error('[scheduler] chat ingest failed:', err);
      }
      try {
        await drainOutbox(db, channels); // outbound: deliver queued replies
      } catch (err) {
        console.error('[scheduler] outbox drain failed:', err);
      }
    });
    console.log(`[scheduler] chat ingest+drain [${[...channels.keys()].join(', ')}] @ "${config.chatPollCron}"`);
  }
}
