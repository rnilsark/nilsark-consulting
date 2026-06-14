import cron from 'node-cron';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config } from './config.ts';

// The repo root: this file is doppelganger/src/selfupdate.ts → ../.. is the repo.
const repoDir = path.join(import.meta.dirname, '..', '..');

/** True when the followed ref points at a commit other than the one we're running. */
export function updateNeeded(localSha: string, remoteSha: string): boolean {
  const l = localSha.trim();
  const r = remoteSha.trim();
  return l !== '' && r !== '' && l !== r;
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Read-only check: has the followed ref moved off the commit we're running? If so, bow out with a
 * graceful SIGTERM and let the service supervisor restart us. We deliberately DON'T touch the working
 * tree or deps here — the supervisor applies the update (deploy/update.sh) before the next process
 * starts (systemd ExecStartPre / macOS launchd start wrapper). Two payoffs: the runtime stays
 * OS-agnostic (git + SIGTERM only, no systemd/launchd), and `npm ci` never runs against a live
 * process.
 */
function checkForUpdate(ref: string): void {
  git(['fetch', '--quiet', '--tags', 'origin', ref]);
  const local = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', 'FETCH_HEAD']);
  if (!updateNeeded(local, remote)) return;
  console.log(
    `[selfupdate] ${ref} moved ${local.slice(0, 7)} → ${remote.slice(0, 7)} — exiting for supervisor to apply`,
  );
  process.kill(process.pid, 'SIGTERM'); // reuse index.ts' graceful shutdown; supervisor restarts us
}

/** Opt-in self-update: poll the followed ref on the internal scheduler (no OS cron). */
export function startSelfUpdate(): void {
  if (!config.selfUpdateEnabled) return;
  cron.schedule(config.selfUpdateCron, () => {
    try {
      checkForUpdate(config.selfUpdateRef);
    } catch (err) {
      console.error('[selfupdate] check failed:', err);
    }
  });
  console.log(
    `[selfupdate] following "${config.selfUpdateRef}" @ "${config.selfUpdateCron}" (supervisor applies on restart)`,
  );
}
