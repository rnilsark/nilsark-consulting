import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  loadAgentContext,
  loadAgentSettings,
  loadSoul,
  scaffoldAgentSettings,
} from '../src/settings.ts';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'dg-settings-'));
}

test('loadAgentSettings: missing file → {}', () => {
  assert.deepEqual(loadAgentSettings('planner', tmp()), {});
});

test('loadAgentSettings: parses an on-disk settings.json', () => {
  const base = tmp();
  mkdirSync(path.join(base, 'planner'), { recursive: true });
  writeFileSync(path.join(base, 'planner', 'settings.json'), '{"workCalendar":"w@x"}');
  assert.deepEqual(loadAgentSettings('planner', base), { workCalendar: 'w@x' });
});

test('loadAgentSettings: invalid JSON fails loud', () => {
  const base = tmp();
  mkdirSync(path.join(base, 'planner'), { recursive: true });
  writeFileSync(path.join(base, 'planner', 'settings.json'), '{ not json');
  assert.throws(() => loadAgentSettings('planner', base));
});

test('loadAgentContext / loadSoul: missing → empty, present → trimmed', () => {
  const base = tmp();
  assert.equal(loadAgentContext('planner', base), '');
  mkdirSync(path.join(base, 'planner'), { recursive: true });
  writeFileSync(path.join(base, 'planner', 'context.md'), '\n# Ctx\n');
  assert.equal(loadAgentContext('planner', base), '# Ctx');

  const soulPath = path.join(tmp(), 'soul.md');
  assert.equal(loadSoul(soulPath), '');
  writeFileSync(soulPath, '  L = Linnea  ');
  assert.equal(loadSoul(soulPath), 'L = Linnea');
});

test('scaffoldAgentSettings: copies example once, idempotent', () => {
  const base = tmp();
  const exampleBase = tmp();
  mkdirSync(path.join(exampleBase, 'planner'), { recursive: true });
  writeFileSync(path.join(exampleBase, 'planner', 'settings.example.json'), '{"workCalendar":"you@x"}');

  // agent with no example is skipped; planner gets scaffolded
  assert.deepEqual(scaffoldAgentSettings(['planner', 'ghost'], base, exampleBase), ['planner']);
  assert.deepEqual(loadAgentSettings('planner', base), { workCalendar: 'you@x' });

  // second run: already exists → nothing created
  assert.deepEqual(scaffoldAgentSettings(['planner', 'ghost'], base, exampleBase), []);
});
