// The running build identity: short commit SHA + commit date of the repo HEAD.
// Surfaced in /api/state so the dashboard can show which code is live — handy on
// its own, and a direct readout of whether a self-update actually landed.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Repo root: src/version.ts → ../.. is the repo (same convention as selfupdate.ts).
const repoDir = path.join(import.meta.dirname, '..', '..');

export interface Version {
  sha: string;
  date: string;
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
}

let cached: Version | undefined;

/**
 * Cached for the life of the process: a self-update SIGTERMs us and the supervisor
 * starts a fresh process on the new code, so a process-lifetime cache is always
 * accurate. Git failures degrade to "unknown" — the dashboard must render regardless.
 */
export function getVersion(): Version {
  if (cached) return cached;
  try {
    cached = {
      sha: git(['rev-parse', '--short', 'HEAD']),
      date: git(['show', '-s', '--format=%cd', '--date=short', 'HEAD']),
    };
  } catch {
    cached = { sha: 'unknown', date: '' };
  }
  return cached;
}
