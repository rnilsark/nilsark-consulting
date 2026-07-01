import { spawnSync } from 'node:child_process';
import { config } from '../config.ts';
import { insertOutbox, lastDigestRunSuccess, operatorPushTarget, type Db } from '../db.ts';
import { lastDigestGateSkip, type GateLogEntry } from './digest.ts';

export type AuthPing = () => { ok: boolean; detail: string };

/** The last deliberate skip-gate decision — a recent one means the entrepreneur is healthily idle. */
export type LastGateSkip = () => GateLogEntry | null;

const defaultAuthPing: AuthPing = () => {
  const result = spawnSync('gws', ['gmail', 'users', 'getProfile', '--params', '{"userId":"me"}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (result.status !== 0 || /auth|token|unauthenticated/i.test(output)) {
    return { ok: false, detail: output.slice(0, 200) };
  }
  return { ok: true, detail: '' };
};

function pushAlert(db: Db, text: string): void {
  if (!config.operatorNumber) {
    console.log(`[health] alert (no operatorNumber configured): ${text}`);
    return;
  }
  const target = operatorPushTarget(db, config.operatorNumber);
  if (!target) {
    console.log(`[health] alert (operator has no direct-message thread yet): ${text}`);
    return;
  }
  insertOutbox(db, { channel: target.channel, conversation_id: target.conversationId, text });
}

export function runHealthcheck(
  db: Db,
  authPing: AuthPing = defaultAuthPing,
  lastGateSkip: LastGateSkip = lastDigestGateSkip,
): void {
  // The entrepreneur is healthy if it EITHER succeeded recently OR the skip-gate recently, deliberately
  // skipped (nothing actionable) — a skip is the gate working, not the agent stalling. So age the
  // newest of {last success, last gate-skip}. No baseline at all (fresh deploy) is not a failure.
  const last = lastDigestRunSuccess(db);
  const skip = lastGateSkip();
  const tsCandidates = [last?.ts, skip?.ts]
    .filter((t): t is string => typeof t === 'string')
    .map((t) => new Date(t).getTime())
    .filter((ms) => Number.isFinite(ms));
  if (tsCandidates.length > 0) {
    const ageHours = (Date.now() - Math.max(...tsCandidates)) / 3_600_000;
    if (ageHours > config.staleRunHours) {
      const h = Math.floor(ageHours);
      pushAlert(db, `[healthcheck] Finance run idle ${h}h — no successful run or deliberate skip (threshold: ${config.staleRunHours}h).`);
    }
  }

  const auth = authPing();
  if (!auth.ok) {
    pushAlert(db, `[healthcheck] gws auth ping failed: ${auth.detail}`);
  }
}
