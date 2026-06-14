import cron from 'node-cron';
import { execFileSync, spawn } from 'node:child_process';
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

function checkAndUpdate(ref: string): void {
  git(['fetch', '--quiet', '--tags', 'origin', ref]);
  const local = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', 'FETCH_HEAD']);
  if (!updateNeeded(local, remote)) return;

  const short = remote.slice(0, 7);
  console.log(`[selfupdate] ${ref} moved ${local.slice(0, 7)} → ${short} — applying`);
  // Launch the updater as its OWN transient systemd unit. A plain detached child would live in
  // doppelganger.service's cgroup and get killed when update.sh restarts the service mid-`npm ci`;
  // --collect runs it independently and cleans the unit up on exit.
  const child = spawn(
    'systemd-run',
    [
      '--user',
      '--collect',
      `--unit=doppelganger-update-${short}`,
      path.join(repoDir, 'doppelganger', 'deploy', 'update.sh'),
      remote,
    ],
    { detached: true, stdio: 'ignore', cwd: repoDir },
  );
  child.unref();
}

/** Opt-in self-update: poll the followed ref on the internal scheduler (no OS cron). */
export function startSelfUpdate(): void {
  if (!config.selfUpdateEnabled) return;
  cron.schedule(config.selfUpdateCron, () => {
    try {
      checkAndUpdate(config.selfUpdateRef);
    } catch (err) {
      console.error('[selfupdate] check failed:', err);
    }
  });
  console.log(`[selfupdate] following "${config.selfUpdateRef}" @ "${config.selfUpdateCron}"`);
}
