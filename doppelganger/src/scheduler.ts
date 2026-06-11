import cron from 'node-cron';
import { enqueue, jobs } from './adapters/schedule.ts';
import type { Db } from './db.ts';

/** Runs the adapters' polls in-process — no OS cron. */
export function startScheduler(db: Db): void {
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
}
