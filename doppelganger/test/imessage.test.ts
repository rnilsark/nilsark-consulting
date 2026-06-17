import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractInbound, type BBMessage } from '../src/channels/imessage.ts';

const base: BBMessage = {
  guid: 'g1',
  text: 'hej',
  dateCreated: 1_700_000_000_000,
  isFromMe: false,
  handle: { address: '+46736625308' },
  chats: [{ guid: 'iMessage;-;+46736625308' }],
};

test('imessage: extracts a plain inbound text message', () => {
  const m = extractInbound(base);
  assert.deepEqual(m, {
    channel: 'imessage',
    conversationId: 'iMessage;-;+46736625308',
    sender: '+46736625308',
    text: 'hej',
    ts: new Date(1_700_000_000_000).toISOString(),
    isDirect: true, // ";-;" guid → 1:1
  });
});

test('imessage: skips own (isFromMe) messages', () => {
  assert.equal(extractInbound({ ...base, isFromMe: true }), null);
});

test('imessage: skips tapbacks/reactions (associatedMessageType set)', () => {
  assert.equal(extractInbound({ ...base, associatedMessageType: 'like' }), null);
});

test('imessage: skips empty / attachment-only / whitespace messages', () => {
  assert.equal(extractInbound({ ...base, text: null }), null);
  assert.equal(extractInbound({ ...base, text: '' }), null);
  assert.equal(extractInbound({ ...base, text: '   ' }), null);
});

test('imessage: missing chat guid → null', () => {
  assert.equal(extractInbound({ ...base, chats: [] }), null);
  assert.equal(extractInbound({ ...base, chats: null }), null);
});

test('imessage: group sender is the handle, conversation is the chat guid', () => {
  const m = extractInbound({
    ...base,
    handle: { address: 'mom@icloud.com' },
    chats: [{ guid: 'iMessage;+;chat123' }],
  });
  assert.equal(m?.sender, 'mom@icloud.com');
  assert.equal(m?.conversationId, 'iMessage;+;chat123');
  assert.equal(m?.isDirect, false); // ";+;" guid → group
});

test('imessage: 1:1 with no handle falls back to the chat guid as sender', () => {
  const m = extractInbound({ ...base, handle: null });
  assert.equal(m?.sender, 'iMessage;-;+46736625308');
});

test('imessage: missing dateCreated still parses (ts defaulted)', () => {
  const m = extractInbound({ ...base, dateCreated: undefined });
  assert.ok(m);
  assert.equal(typeof m?.ts, 'string');
});
