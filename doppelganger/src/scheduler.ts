import cron from 'node-cron';
import { enqueue, jobs } from './adapters/schedule.ts';
import { runHealthcheck } from './adapters/health.ts';
import { ingestChat } from './adapters/chat.ts';
import { maybeEnqueueFinanceRun, operatorToday, shadowValidateMonth } from './adapters/finance.ts';
import { pollBankDrop } from './adapters/finance-intake.ts';
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
      maybeEnqueueFinanceRun(db); // gated enqueue — see finance.ts
      try {
        // step 2 shadow check (read-only): prove the TS ledger round-trips the live book
        const r = shadowValidateMonth(operatorToday().slice(0, 7));
        console.log(`[state-shadow] ${r.month} found=${r.found} clean=${r.clean} — ${r.detail}`);
      } catch (err) {
        console.error('[state-shadow] failed:', err);
      }
    } catch (err) {
      console.error('[scheduler] finance heartbeat gate failed:', err);
    }
  });
  console.log(`[scheduler] finance heartbeat gate @ "${config.financeHeartbeatCron}"`);

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
      const { enqueued } = pollBankDrop(db); // bank statements uploaded straight to Drive → reconcile
      if (enqueued > 0) console.log(`[bank-drop] enqueued ${enqueued} statement(s) → reconcile`);
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
