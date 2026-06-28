import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ingestChat, isOperator } from '../src/adapters/chat.ts';
import {
  getChannelCursor,
  insertChatMessage,
  openDb,
  operatorPushTarget,
  recentChatMessages,
  selectPendingFifo,
  selectPendingOutbox,
} from '../src/db.ts';
import { drainOutbox } from '../src/outbox.ts';
import { acknowledgeChat, buildPrompt, CHAT_ACKS, pickAck, readOutcome, routeReplies, saveTranscript, type Outcome } from '../src/worker.ts';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import type { Channel, InboundMessage } from '../src/channels/types.ts';
import type { QueueRow, Registry } from '../src/types.ts';

const registry: Registry = {
  agents: {
    triage: { name: 'triage', can_be_called_by: ['chat-ingest'], tools: 'Read', model: 'haiku' },
    chat: { name: 'chat', can_be_called_by: ['triage'], tools: 'Read,Write', model: 'opus' },
    planner: { name: 'planner', can_be_called_by: ['schedule', 'chat'], tools: '', model: 'sonnet' },
  },
};

function freshDb() {
  return openDb(':memory:');
}

/** A channel driven from an in-memory array, capturing sends. */
function memChannel(name: string, inbox: Omit<InboundMessage, 'channel'>[]): {
  channel: Channel;
  sent: Array<{ conversationId: string; text: string }>;
} {
  const sent: Array<{ conversationId: string; text: string }> = [];
  const channel: Channel = {
    name,
    poll(cursor) {
      const seen = cursor ? Number(cursor) : 0;
      const fresh = inbox.slice(seen);
      return {
        messages: fresh.map((m) => ({ ...m, channel: name })),
        cursor: String(inbox.length),
      };
    },
    send(conversationId, text) {
      sent.push({ conversationId, text });
    },
  };
  return { channel, sent };
}

test('ingest: writes inbound chat_messages, enqueues triage, advances cursor', () => {
  const db = freshDb();
  const { channel } = memChannel('stub', [
    { conversationId: 'C1', sender: 'mom', text: 'Jarvis, är vi lediga 12 aug?', ts: '2026-06-13T10:00:00Z' },
  ]);
  ingestChat(db, new Map([[channel.name, channel]]));

  const queued = selectPendingFifo(db);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].agent, 'triage');
  const payload = JSON.parse(queued[0].task) as { channel: string; conversationId: string; text: string };
  assert.equal(payload.conversationId, 'C1');
  assert.equal(payload.channel, 'stub');

  const history = recentChatMessages(db, 'C1', 10);
  assert.equal(history.length, 1);
  assert.equal(history[0].direction, 'in');
  assert.equal(getChannelCursor(db, 'stub'), '1');

  // Re-poll with the advanced cursor: nothing new, no duplicate triage row.
  ingestChat(db, new Map([[channel.name, channel]]));
  assert.equal(selectPendingFifo(db).length, 1);
});

test('ingest: allowlist blocks a non-listed sender, passes a listed one', () => {
  const db = freshDb();
  const { channel } = memChannel('stub', [
    { conversationId: 'C1', sender: '46999999999@s.whatsapp.net', text: 'stranger', ts: '2026-06-13T10:00:00Z' },
    { conversationId: 'C2', sender: '+46736625308', text: 'operator', ts: '2026-06-13T10:01:00Z' },
  ]);
  ingestChat(db, new Map([[channel.name, channel]]), ['+46736625308']);
  const queued = selectPendingFifo(db);
  assert.equal(queued.length, 1);
  assert.equal((JSON.parse(queued[0].task) as { conversationId: string }).conversationId, 'C2');
});

/** A channel that captures sends, for the drainer. */
function captureChannel(name: string, sent: Array<{ conversationId: string; text: string }>): Channel {
  return {
    name,
    poll: () => ({ messages: [], cursor: '' }),
    send: (conversationId, text) => {
      sent.push({ conversationId, text });
    },
  };
}

test('routeReplies: queues a reply to a known conversation on the outbox (resolves channel from inbound)', () => {
  const db = freshDb();
  insertChatMessage(db, {
    channel: 'stub',
    conversation_id: 'C1',
    sender: 'mom',
    direction: 'in',
    text: 'är vi lediga 12 aug?',
  });
  const outcome: Outcome = {
    status: 'success',
    summary: 'answered',
    orders: [],
    replies: [{ conversationId: 'C1', text: 'Ni är lediga 🎉' }],
    cost: null,
  };
  routeReplies(db, outcome, 'C1'); // run's own conversation is C1

  const pending = selectPendingOutbox(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].channel, 'stub'); // resolved from inbound history, not from the reply
  assert.equal(pending[0].conversation_id, 'C1');
  // not yet delivered: no outbound chat row until the drainer runs
  assert.equal(recentChatMessages(db, 'C1', 10).length, 1);
});

test('routeReplies: drops a reply to a conversation never seen inbound (nothing queued)', () => {
  const db = freshDb();
  routeReplies(db, {
    status: 'success',
    summary: 'tried to exfiltrate',
    orders: [],
    replies: [{ conversationId: 'ATTACKER', text: 'secret' }],
    cost: null,
  }, 'ATTACKER');
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('routeReplies: drops a reply to a KNOWN conversation that is not this run\'s own (no cross-talk)', () => {
  const db = freshDb();
  // C1 is a real, known conversation — but this run was handed C2 (or none). It must NOT reach C1.
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'hi' });
  routeReplies(db, {
    status: 'success', summary: 'a judgment kernel tried to message the operator', orders: [],
    replies: [{ conversationId: 'C1', text: 'spurious push' }], cost: null,
  }, null); // a run with no conversation (classifier/reconciler/cron) can reply to nothing
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('routeReplies: error status queues nothing', () => {
  const db = freshDb();
  insertChatMessage(db, {
    channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'hi',
  });
  routeReplies(db, {
    status: 'error', summary: 'boom', orders: [], replies: [{ conversationId: 'C1', text: 'x' }], cost: null,
  }, 'C1');
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('drainOutbox: delivers via the live channel, logs outbound, marks sent', async () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'q' });
  routeReplies(db, {
    status: 'success', summary: 'ok', orders: [],
    replies: [{ conversationId: 'C1', text: 'Ni är lediga 🎉' }], cost: null,
  }, 'C1');
  const sent: Array<{ conversationId: string; text: string }> = [];
  await drainOutbox(db, new Map([['stub', captureChannel('stub', sent)]]));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Ni är lediga 🎉');
  assert.equal(selectPendingOutbox(db).length, 0); // marked sent
  const history = recentChatMessages(db, 'C1', 10);
  assert.equal(history.length, 2);
  assert.equal(history[1].direction, 'out');

  // idempotent: a second drain delivers nothing more
  await drainOutbox(db, new Map([['stub', captureChannel('stub', sent)]]));
  assert.equal(sent.length, 1);
});

test('drainOutbox: send failure leaves the row pending for retry', async () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'q' });
  routeReplies(db, {
    status: 'success', summary: 'ok', orders: [], replies: [{ conversationId: 'C1', text: 'x' }], cost: null,
  }, 'C1');
  const flaky: Channel = {
    name: 'stub',
    poll: () => ({ messages: [], cursor: '' }),
    send: () => { throw new Error('socket down'); },
  };
  await drainOutbox(db, new Map([['stub', flaky]]));
  assert.equal(selectPendingOutbox(db).length, 1); // still pending
  assert.equal(recentChatMessages(db, 'C1', 10).filter((m) => m.direction === 'out').length, 0);
});

function chatRow(conversationId: string): QueueRow {
  return {
    id: 8, agent: 'chat', task: conversationId, status: 'running', parent: 'R1',
    run_id: 'RACK', pid: 1, running_since: null, attempts: 0, created_at: 'now',
  };
}

test('acknowledgeChat: a chat run queues one canned ack into the conversation', () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'är vi lediga 12 aug?' });
  acknowledgeChat(db, chatRow('C1'), () => 'På saken!');

  const pending = selectPendingOutbox(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].channel, 'stub'); // resolved from inbound history
  assert.equal(pending[0].conversation_id, 'C1');
  assert.equal(pending[0].text, 'På saken!');
});

test('acknowledgeChat: only the chat agent acks — triage/planner runs do not', () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'boka' });
  const triage: QueueRow = {
    id: 7, agent: 'triage', task: JSON.stringify({ channel: 'stub', conversationId: 'C1', text: 'boka' }),
    status: 'running', parent: null, run_id: 'R1', pid: 1, running_since: null, attempts: 0, created_at: 'now',
  };
  acknowledgeChat(db, triage);
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('acknowledgeChat: unknown conversation (never heard from) → no ack', () => {
  const db = freshDb();
  acknowledgeChat(db, chatRow('GHOST'));
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('saveTranscript: writes claude.json (and stderr when non-empty) into the run dir', () => {
  const dir = mkdtempSync(path.join(osTmpdir(), 'dg-run-'));
  saveTranscript(dir, '{"result":"ok","permission_denials":[]}', '  ');
  assert.equal(readFileSync(path.join(dir, 'claude.json'), 'utf8'), '{"result":"ok","permission_denials":[]}');
  assert.equal(existsSync(path.join(dir, 'claude.stderr')), false); // whitespace-only stderr skipped

  saveTranscript(dir, '{}', 'boom: gws blocked');
  assert.equal(readFileSync(path.join(dir, 'claude.stderr'), 'utf8'), 'boom: gws blocked');
});

test('saveTranscript: no stdout writes nothing and does not throw', () => {
  const dir = mkdtempSync(path.join(osTmpdir(), 'dg-run-'));
  saveTranscript(dir, undefined, undefined);
  assert.equal(existsSync(path.join(dir, 'claude.json')), false);
});

test('pickAck: always returns a member of the canned list', () => {
  assert.ok(CHAT_ACKS.length > 1);
  for (let i = 0; i < 50; i++) assert.ok(CHAT_ACKS.includes(pickAck()));
});

test('readOutcome: parses replies and ignores malformed ones', () => {
  const outPath = path.join(tmpdir(), `dg-test-out-${process.pid}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({
      status: 'success',
      summary: 'ok',
      replies: [
        { conversationId: 'C1', text: 'good' },
        { conversationId: 'C2' }, // missing text → dropped
        { text: 'no convo' }, // missing conversationId → dropped
      ],
    }),
  );
  const outcome = readOutcome(outPath, 0.01, null);
  rmSync(outPath, { force: true });
  assert.equal(outcome.status, 'success');
  assert.equal(outcome.replies?.length, 1);
  assert.equal(outcome.replies?.[0].conversationId, 'C1');
});

test('readOutcome: passes through a structured result (judgment-agent contract)', () => {
  const outPath = path.join(tmpdir(), `dg-test-result-${process.pid}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({
      status: 'success',
      summary: 'Classified faktura.pdf as leverantörsfaktura.',
      result: { type: 'leverantörsfaktura', supplier: 'Avanza Pension', amount: '15352.00' },
    }),
  );
  const outcome = readOutcome(outPath, 0.01, null);
  rmSync(outPath, { force: true });
  assert.equal(outcome.status, 'success');
  assert.deepEqual(outcome.result, { type: 'leverantörsfaktura', supplier: 'Avanza Pension', amount: '15352.00' });
});

test('readOutcome: result is absent (undefined) when the agent omits it', () => {
  const outPath = path.join(tmpdir(), `dg-test-noresult-${process.pid}.json`);
  writeFileSync(outPath, JSON.stringify({ status: 'success', summary: 'ok' }));
  const outcome = readOutcome(outPath, 0.01, null);
  rmSync(outPath, { force: true });
  assert.equal(outcome.result, undefined);
});

test('buildPrompt: injects conversation memory for the chat agent', () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'är vi lediga?' });
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'harness', direction: 'out', text: 'Ja!' });
  const row: QueueRow = {
    id: 1, agent: 'chat', task: 'C1', status: 'running', parent: 'R1',
    run_id: 'R1', pid: 1, running_since: null, attempts: 0, created_at: 'now',
  };
  const prompt = buildPrompt(row, '/tmp/out.json', registry, db);
  assert.match(prompt, /## Conversation \(C1\)/);
  assert.match(prompt, /\[in\] är vi lediga\?/);
  assert.match(prompt, /\[out\] Ja!/);
  // chat may order planner
  assert.match(prompt, /Agents you may order: planner/);
  // current wall-clock is injected so the agent doesn't have to guess "today"
  assert.match(prompt, /The current date and time is .+ \(Europe\/Stockholm\)\./);
});

test('buildPrompt: triage gets the conversationId memory from its JSON task', () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C9', sender: 'dad', direction: 'in', text: 'boka tandläkare' });
  const row: QueueRow = {
    id: 2, agent: 'triage', task: JSON.stringify({ channel: 'stub', conversationId: 'C9', text: 'boka tandläkare' }),
    status: 'running', parent: null, run_id: 'R2', pid: 1, running_since: null, attempts: 0, created_at: 'now',
  };
  const prompt = buildPrompt(row, '/tmp/out.json', registry, db);
  assert.match(prompt, /## Conversation \(C9\)/);
  assert.match(prompt, /Agents you may order: chat/);
});

test('extractInbound: maps a plain-text WhatsApp message, filters fromMe / media / no-jid', async () => {
  const { extractInbound } = await import('../src/channels/whatsapp.ts');

  const plain = extractInbound({
    key: { remoteJid: '46701234567@s.whatsapp.net', fromMe: false },
    message: { conversation: 'Jarvis, är vi lediga?' },
    messageTimestamp: 1_700_000_000,
  } as never);
  assert.equal(plain?.text, 'Jarvis, är vi lediga?');
  assert.equal(plain?.conversationId, '46701234567@s.whatsapp.net');
  assert.equal(plain?.channel, 'whatsapp');

  const ext = extractInbound({
    key: { remoteJid: 'group@g.us', participant: '46700000000@s.whatsapp.net', fromMe: false },
    message: { extendedTextMessage: { text: 'kan jag hänga med polarna?' } },
  } as never);
  assert.equal(ext?.text, 'kan jag hänga med polarna?');
  assert.equal(ext?.sender, '46700000000@s.whatsapp.net'); // group → participant is the sender

  assert.equal(plain?.isDirect, true); // 1:1 jid → direct
  assert.equal(ext?.isDirect, false); // @g.us → group

  assert.equal(extractInbound({ key: { remoteJid: 'x', fromMe: true }, message: { conversation: 'hi' } } as never), null);
  assert.equal(extractInbound({ key: { remoteJid: 'x', fromMe: false }, message: { imageMessage: {} } } as never), null);
  assert.equal(extractInbound({ key: { fromMe: false }, message: { conversation: 'hi' } } as never), null);
});

test('isOperator: matches the operator number across +/digits/jid forms; empty number never matches', () => {
  assert.equal(isOperator('46736625308@s.whatsapp.net', '+46736625308'), true);
  assert.equal(isOperator('+46736625308', '+46736625308'), true);
  assert.equal(isOperator('46736625308', '+46736625308'), true);
  assert.equal(isOperator('46999999999@s.whatsapp.net', '+46736625308'), false);
  assert.equal(isOperator('46736625308@s.whatsapp.net', ''), false); // unconfigured → off
});

test('ingest: an operator DM goes through triage, flagged isDirect + fromOperator (no bypass)', () => {
  const db = freshDb();
  const { channel } = memChannel('stub', [
    { conversationId: 'OP', sender: '46736625308@s.whatsapp.net', text: 'boka tandläkare imorgon', ts: '2026-06-13T10:00:00Z', isDirect: true },
  ]);
  ingestChat(db, new Map([[channel.name, channel]]), ['+46736625308'], '+46736625308');

  const queued = selectPendingFifo(db);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].agent, 'triage', 'everything goes through triage — one uniform path');
  const t = JSON.parse(queued[0].task) as { conversationId: string; isDirect: boolean; fromOperator: boolean };
  assert.equal(t.conversationId, 'OP');
  assert.equal(t.isDirect, true);
  assert.equal(t.fromOperator, true, 'operator 1:1 → triage escalates unconditionally');
});

test('ingest: a GROUP message from the operator → triage, fromOperator true but isDirect false', () => {
  const db = freshDb();
  const { channel } = memChannel('stub', [
    { conversationId: 'GROUP', sender: '46736625308@s.whatsapp.net', text: 'hej allihop', ts: '2026-06-13T10:00:00Z', isDirect: false },
  ]);
  ingestChat(db, new Map([[channel.name, channel]]), ['+46736625308'], '+46736625308');

  const t = JSON.parse(selectPendingFifo(db)[0].task) as { isDirect: boolean; fromOperator: boolean };
  assert.equal(t.isDirect, false, 'a group is not a 1:1, so triage applies its judgment');
  assert.equal(t.fromOperator, true);
});

test('ingest: a DM from a non-operator (family) → triage, isDirect true but fromOperator false', () => {
  const db = freshDb();
  const { channel } = memChannel('stub', [
    { conversationId: 'MOM', sender: '46700000000@s.whatsapp.net', text: 'är vi lediga?', ts: '2026-06-13T10:00:00Z', isDirect: true },
  ]);
  ingestChat(db, new Map([[channel.name, channel]]), [], '+46736625308');

  const t = JSON.parse(selectPendingFifo(db)[0].task) as { isDirect: boolean; fromOperator: boolean };
  assert.equal(t.isDirect, true);
  assert.equal(t.fromOperator, false, 'only the operator gets the unconditional-escalate rule');
});

test('operatorPushTarget: returns the operator\'s most recent DM thread + channel; ignores groups and unset', () => {
  const db = freshDb();
  assert.equal(operatorPushTarget(db, '+46736625308'), undefined); // never DM'd

  insertChatMessage(db, { channel: 'stub', conversation_id: 'GRP', sender: '46736625308@s.whatsapp.net', direction: 'in', text: 'g', is_direct: false });
  assert.equal(operatorPushTarget(db, '+46736625308'), undefined, 'a group message is not a target');

  insertChatMessage(db, { channel: 'whatsapp', conversation_id: 'DM1', sender: '46736625308@s.whatsapp.net', direction: 'in', text: 'a', is_direct: true });
  insertChatMessage(db, { channel: 'whatsapp', conversation_id: 'DM2', sender: '46736625308@s.whatsapp.net', direction: 'in', text: 'b', is_direct: true });
  assert.deepEqual(operatorPushTarget(db, '+46736625308'), { conversationId: 'DM2', channel: 'whatsapp' }, 'most recent DM wins');

  assert.equal(operatorPushTarget(db, ''), undefined, 'unset operator → no target');
});
