import { config } from '../config.ts';
import { insertQueue, type Db } from '../db.ts';

export interface ScheduledJob {
  cron: string;
  agent: string;
  task: string;
}

/**
 * The timetable: what the schedule adapter puts on the queue UNCONDITIONALLY, and when. The finance
 * heartbeat is NOT here — it runs through the skip-gate (`ledger-store.ts`/`maybeEnqueueDigest`),
 * which enqueues a `digest` run only when work is (or might be) due.
 */
export const jobs: ScheduledJob[] = [
  { cron: config.morningBriefCron, agent: 'planner', task: 'morning_brief' },
];

export function enqueue(db: Db, job: ScheduledJob): void {
  insertQueue(db, { agent: job.agent, task: job.task, parent: null });
  console.log(`[schedule] enqueued ${job.agent}/${job.task}`);
}
