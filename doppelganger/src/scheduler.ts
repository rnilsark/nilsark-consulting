import cron from 'node-cron';
import { enqueue, jobs } from './adapters/schedule.ts';
import { ingestChat } from './adapters/chat.ts';
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

  if (channels.size > 0) {
    cron.schedule(config.chatPollCron, async () => {
      try {
        ingestChat(db, channels); // inbound: drain socket buffers → triage
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
