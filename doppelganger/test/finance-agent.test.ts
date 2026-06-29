import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry } from '../src/registry.ts';

// The credentialed `entrepreneur` LLM agent was dissolved — the finance heartbeat is now the
// deterministic TS `finance` orchestrator, and collection rides the intake/reconcile path.

test('registry: the entrepreneur agent is gone', () => {
  const registry = loadRegistry();
  assert.equal(registry.agents.entrepreneur, undefined);
});

test('registry: finance is a TS orchestrator (no model/tools) reachable from schedule + chat', () => {
  const registry = loadRegistry();
  const finance = registry.agents.finance;
  assert.ok(finance, 'finance agent is registered');
  assert.equal(finance.kind, 'orchestrator');
  assert.equal(finance.tools, '', 'no tools — it executes TS, not claude');
  assert.equal(finance.model, undefined, 'no model — there is no LLM run');
  assert.deepEqual(finance.can_be_called_by, ['schedule', 'chat']);
});

test('registry: the finance judgment kernels are reached only from their TS orchestrators', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.agents.classifier.can_be_called_by, ['intake']);
  assert.deepEqual(registry.agents.reconciler.can_be_called_by, ['reconcile']);
});

test('registry: the inbox gate orders the scoped orchestrators, never a credentialed finance LLM', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.agents.intake.can_be_called_by, ['inbox']);
  assert.deepEqual(registry.agents.reconcile.can_be_called_by, ['inbox']);
  // No finance agent is reachable from inbox — only the two scoped TS orchestrators are.
  for (const [name, a] of Object.entries(registry.agents)) {
    if (a.can_be_called_by.includes('inbox')) assert.ok(['intake', 'reconcile'].includes(name), `${name} should not be inbox-reachable`);
  }
});
