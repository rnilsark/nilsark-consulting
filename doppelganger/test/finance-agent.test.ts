import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';

// `entrepreneur` is a DUTY the doppelgänger carries (running the company's books), not a single agent:
// it owns the finance pipeline (inbox/intake/classifier/statement/reconciler/digest). The heartbeat is
// the deterministic TS `digest` orchestrator; collection rides the intake/statement path.

test('registry: entrepreneur is a duty owning the finance pipeline, not an agent', () => {
  const registry = loadRegistry();
  assert.equal(registry.agents.entrepreneur, undefined); // not an agent
  assert.deepEqual(
    registry.duties.entrepreneur.agents,
    ['inbox', 'intake', 'classifier', 'statement', 'reconciler', 'digest'],
  );
});

test('registry: digest is a TS orchestrator (no model/tools) reachable from schedule + chat', () => {
  const registry = loadRegistry();
  const digest = registry.agents.digest;
  assert.ok(digest, 'digest agent is registered');
  assert.equal(digest.kind, 'orchestrator');
  assert.equal(digest.tools, '', 'no tools — it executes TS, not claude');
  assert.equal(digest.model, undefined, 'no model — there is no LLM run');
  assert.deepEqual(digest.can_be_called_by, ['schedule', 'chat']);
});

test('registry: the finance judgment kernels are reached only from their TS orchestrators', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.agents.classifier.can_be_called_by, ['intake']);
  assert.deepEqual(registry.agents.reconciler.can_be_called_by, ['statement']);
});

test('registry: the inbox gate orders the scoped orchestrators, never a credentialed finance LLM', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.agents.intake.can_be_called_by, ['inbox']);
  assert.deepEqual(registry.agents.statement.can_be_called_by, ['inbox']);
  // No finance agent is reachable from inbox — only the two scoped TS orchestrators are.
  for (const [name, a] of Object.entries(registry.agents)) {
    if (a.can_be_called_by.includes('inbox')) assert.ok(['intake', 'statement'].includes(name), `${name} should not be inbox-reachable`);
  }
});
