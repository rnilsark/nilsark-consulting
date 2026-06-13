import { config } from '../config.ts';
import { insertQueue, type Db } from '../db.ts';

export interface ScheduledJob {
  cron: string;
  agent: string;
  task: string;
}

/** The timetable: what the schedule adapter puts on the queue, and when. */
export const jobs: ScheduledJob[] = [
  { cron: config.morningBriefCron, agent: 'planner', task: 'morning_brief' },
  { cron: config.financeHeartbeatCron, agent: 'entrepreneur', task: 'heartbeat' },
];

export function enqueue(db: Db, job: ScheduledJob): void {
  insertQueue(db, { agent: job.agent, task: job.task, parent: null });
  console.log(`[schedule] enqueued ${job.agent}/${job.task}`);
}
