import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dutyOf, loadRegistry } from '../src/registry.ts';

// The duty layer: `entrepreneur` (and any other duty) is a first-class, typed role that OWNS a cluster
// of agents. Harness-general agents (comms: triage/chat; ingress) belong to no duty.

test('loadRegistry: parses the duties block with summaries + owned agents', () => {
  const { duties } = loadRegistry();
  assert.ok(duties.entrepreneur, 'entrepreneur duty exists');
  assert.match(duties.entrepreneur.summary, /finances/i);
  assert.deepEqual(duties.calendar.agents, ['planner']);
});

test('dutyOf: maps an agent to its owning duty, null for harness-general', () => {
  const registry = loadRegistry();
  assert.equal(dutyOf(registry, 'digest'), 'entrepreneur');
  assert.equal(dutyOf(registry, 'reconciler'), 'entrepreneur');
  assert.equal(dutyOf(registry, 'planner'), 'calendar');
  assert.equal(dutyOf(registry, 'chat'), null);   // comms — harness-general
  assert.equal(dutyOf(registry, 'triage'), null);
});

test('loadRegistry: a duty owning an unknown agent fails loud (no ghost role)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reg-'));
  const file = path.join(dir, 'registry.yaml');
  writeFileSync(file, [
    'agents:',
    '  planner:',
    '    can_be_called_by: [schedule]',
    '    tools: ""',
    'duties:',
    '  entrepreneur:',
    '    summary: x',
    '    agents: [planner, ghost]',
    '',
  ].join('\n'));
  try {
    assert.throws(() => loadRegistry(file), /unknown agent 'ghost'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
