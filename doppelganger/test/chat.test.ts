import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ingestChat } from '../src/adapters/chat.ts';
import {
  getChannelCursor,
  insertChatMessage,
  openDb,
  recentChatMessages,
  selectPendingFifo,
  selectPendingOutbox,
} from '../src/db.ts';
import { drainOutbox } from '../src/outbox.ts';
import { buildPrompt, readOutcome, routeReplies, type Outcome } from '../src/worker.ts';
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
  routeReplies(db, outcome);

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
  });
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('routeReplies: error status queues nothing', () => {
  const db = freshDb();
  insertChatMessage(db, {
    channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'hi',
  });
  routeReplies(db, {
    status: 'error', summary: 'boom', orders: [], replies: [{ conversationId: 'C1', text: 'x' }], cost: null,
  });
  assert.equal(selectPendingOutbox(db).length, 0);
});

test('drainOutbox: delivers via the live channel, logs outbound, marks sent', async () => {
  const db = freshDb();
  insertChatMessage(db, { channel: 'stub', conversation_id: 'C1', sender: 'mom', direction: 'in', text: 'q' });
  routeReplies(db, {
    status: 'success', summary: 'ok', orders: [],
    replies: [{ conversationId: 'C1', text: 'Ni är lediga 🎉' }], cost: null,
  });
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
  });
  const flaky: Channel = {
    name: 'stub',
    poll: () => ({ messages: [], cursor: '' }),
    send: () => { throw new Error('socket down'); },
  };
  await drainOutbox(db, new Map([['stub', flaky]]));
  assert.equal(selectPendingOutbox(db).length, 1); // still pending
  assert.equal(recentChatMessages(db, 'C1', 10).filter((m) => m.direction === 'out').length, 0);
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

  assert.equal(extractInbound({ key: { remoteJid: 'x', fromMe: true }, message: { conversation: 'hi' } } as never), null);
  assert.equal(extractInbound({ key: { remoteJid: 'x', fromMe: false }, message: { imageMessage: {} } } as never), null);
  assert.equal(extractInbound({ key: { fromMe: false }, message: { conversation: 'hi' } } as never), null);
});
