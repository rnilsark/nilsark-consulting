import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowed } from '../src/adapters/chat.ts';

test('allowlist: empty list is open (no filter)', () => {
  assert.equal(isAllowed('46736625308@s.whatsapp.net', 'x@lid', []), true);
});

test('allowlist: a number entry matches +, bare digits, and the @s.whatsapp.net jid', () => {
  const list = ['+46736625308'];
  assert.equal(isAllowed('46736625308@s.whatsapp.net', 'c', list), true);
  assert.equal(isAllowed('+46736625308', 'c', list), true);
  assert.equal(isAllowed('46999999999@s.whatsapp.net', 'c', list), false);
});

test('allowlist: a jid/lid entry matches the sender OR the conversation exactly', () => {
  const list = ['134694737825981@lid'];
  assert.equal(isAllowed('unknown@lid', '134694737825981@lid', list), true); // conversation match (DM)
  assert.equal(isAllowed('134694737825981@lid', 'c', list), true); // sender match
  assert.equal(isAllowed('other@lid', 'other2@lid', list), false);
});