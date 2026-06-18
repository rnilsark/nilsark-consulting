import { spawnSync } from 'node:child_process';
import { config } from '../config.ts';
import { insertOutbox, lastEntrepreneurSuccess, operatorPushTarget, type Db } from '../db.ts';

export type AuthPing = () => { ok: boolean; detail: string };

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

export function runHealthcheck(db: Db, authPing: AuthPing = defaultAuthPing): void {
  // No success on record yet (fresh deploy, before the first scheduled run) is not a failure —
  // only an established baseline going stale is. Skip the staleness check until there's one to age.
  const last = lastEntrepreneurSuccess(db);
  if (last) {
    const ageMs = Date.now() - new Date(last.ts).getTime();
    const ageHours = ageMs / 3_600_000;
    if (ageHours > config.staleRunHours) {
      const h = Math.floor(ageHours);
      pushAlert(db, `[healthcheck] Entrepreneur last succeeded ${h}h ago (threshold: ${config.staleRunHours}h).`);
    }
  }

  const auth = authPing();
  if (!auth.ok) {
    pushAlert(db, `[healthcheck] gws auth ping failed: ${auth.detail}`);
  }
}
