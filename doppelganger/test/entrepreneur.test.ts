import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';

test('registry: entrepreneur may draft but never bare-send, and has no broad Bash', () => {
  const registry = loadRegistry();
  const ent = registry.agents.entrepreneur;
  assert.ok(ent, 'entrepreneur agent is registered');
  const tools = ent.tools.split(',');
  assert.ok(tools.includes('Bash(gws gmail +send --draft:*)'), 'has the draft form');
  assert.ok(!tools.includes('Bash(gws gmail +send:*)'), 'no bare send');
  assert.ok(!tools.includes('Bash(gws gmail +send)'), 'no bare send (no-glob)');
  assert.ok(!tools.includes('Bash'), 'no standalone broad Bash');
});

test('registry: entrepreneur is reachable from the heartbeat cron, from chat, and from the inbox gate', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.agents.entrepreneur.can_be_called_by, ['schedule', 'chat', 'inbox']);
  assert.equal(registry.agents['inbox-triage'], undefined, 'inbox-triage removed');
});

test('registry: inbox is an untrusted-text gate — only the inbox-ingest adapter may call it, no domain tools', () => {
  const registry = loadRegistry();
  const inbox = registry.agents.inbox;
  assert.ok(inbox, 'inbox agent is registered');
  assert.deepEqual(inbox.can_be_called_by, ['inbox-ingest']);
  assert.equal(inbox.tools, 'Read,Write', 'gate only: no gws/Drive/Fortnox creds');
  assert.equal(inbox.model, 'haiku');
});
