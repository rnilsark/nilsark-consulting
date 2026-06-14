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

test('registry: entrepreneur is reachable from the heartbeat cron and from chat', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.agents.entrepreneur.can_be_called_by, ['schedule', 'chat']);
  assert.equal(registry.agents['inbox-triage'], undefined, 'inbox-triage removed');
});
