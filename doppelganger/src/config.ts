import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const home =
  process.env.DOPPELGANGER_HOME ?? path.join(homedir(), '.local', 'share', 'doppelganger');

export const config = {
  /** Runtime state outside the repo: DB, out.json, briefs, tokens. */
  home,
  dbPath: path.join(home, 'doppelganger.db'),
  runsDir: path.join(home, 'runs'),
  briefsDir: path.join(home, 'briefs'),

  /** Private, non-repo agent config + context (settings.json, context.md). */
  agentSettingsDir: path.join(home, 'agents'),
  /** Shared context injected into every agent (opt-in; missing → skipped). */
  soulPath: path.join(home, 'soul.md'),

  dispatchIntervalMs: int(process.env.DOPPELGANGER_DISPATCH_INTERVAL_MS, 5000),
  maxAttempts: int(process.env.DOPPELGANGER_MAX_ATTEMPTS, 3),

  webPort: int(process.env.DOPPELGANGER_WEB_PORT, 4317),

  /** node-cron expression for the morning brief (local time). */
  morningBriefCron: process.env.DOPPELGANGER_MORNING_BRIEF_CRON ?? '0 7 * * *',

  claudeBin: process.env.DOPPELGANGER_CLAUDE_BIN ?? 'claude',
};

export function ensureDirs(): void {
  mkdirSync(config.runsDir, { recursive: true });
  mkdirSync(config.briefsDir, { recursive: true });
}
