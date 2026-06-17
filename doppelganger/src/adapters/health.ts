import { spawnSync } from 'node:child_process';
import { config } from '../config.ts';
import { inboundConversationChannel, insertOutbox, lastEntrepreneurSuccess, type Db } from '../db.ts';

export type AuthPing = () => { ok: boolean; detail: string };

const defaultAuthPing: AuthPing = () => {
  const result = spawnSync('gws', ['calendar', 'list', '--max-results=1'], {
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
  if (!config.operatorConversationId) {
    console.log(`[health] alert (no operatorConversationId configured): ${text}`);
    return;
  }
  const channel = inboundConversationChannel(db, config.operatorConversationId);
  if (!channel) {
    console.log(`[health] alert (no inbound channel history for operator): ${text}`);
    return;
  }
  insertOutbox(db, { channel, conversation_id: config.operatorConversationId, text });
}

export function runHealthcheck(db: Db, authPing: AuthPing = defaultAuthPing): void {
  const last = lastEntrepreneurSuccess(db);
  if (!last) {
    pushAlert(db, `[healthcheck] No successful entrepreneur run on record.`);
  } else {
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
