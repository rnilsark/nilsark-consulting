import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE, project, windowSince } from '../src/projection.ts';
import type { Duty, EventRow } from '../src/types.ts';

let nextId = 0;

function ev(partial: Partial<EventRow>): EventRow {
  return {
    id: ++nextId,
    run_id: 'R',
    kind: 'started',
    ts: new Date().toISOString(),
    agent: 'planner',
    task: 'morning_brief',
    parent: null,
    status: null,
    cost: null,
    summary: null,
    ...partial,
  };
}

test('duty clusters come from the registry; comms is harness-general; agent.cluster is set', () => {
  const duties: Duty[] = [
    { name: 'entrepreneur', summary: 'books', agents: ['digest', 'reconciler'] },
  ];
  const events = [ev({ run_id: 'R1', agent: 'digest', kind: 'finished', status: 'success' })];
  const state = project(events, ['digest', 'reconciler', 'chat'], duties);

  assert.equal(state.agents.find((a) => a.name === 'digest')!.cluster, 'entrepreneur');
  assert.equal(state.agents.find((a) => a.name === 'chat')!.cluster, 'comms'); // harness-general, still clusters
  const ent = state.clusters.find((c) => c.name === 'entrepreneur')!;
  assert.deepEqual(ent.members.sort(), ['digest', 'reconciler']);
});

test('lone started → running agent, ACTIVE=1, active core spoke', () => {
  const events = [ev({ run_id: 'R1', kind: 'started' })];
  const state = project(events, ['planner']);

  const planner = state.agents.find((a) => a.name === 'planner')!;
  assert.equal(planner.status, 'running');
  assert.equal(planner.running, true);
  assert.equal(planner.task, 'morning_brief');
  assert.equal(state.stats.active, 1);

  const spoke = state.edges.find((e) => e.from === CORE && e.to === 'planner')!;
  assert.equal(spoke.active, true);
});

test('started + finished(success) → done state, cost in stats, history grows', () => {
  const events = [
    ev({ run_id: 'R1', kind: 'started' }),
    ev({ run_id: 'R1', kind: 'finished', status: 'success', cost: 0.54, summary: 'brief written' }),
    ev({ run_id: 'R2', kind: 'started' }),
    ev({ run_id: 'R2', kind: 'finished', status: 'success', cost: 0.21, summary: 'second brief' }),
  ];
  const state = project(events, ['planner']);

  const planner = state.agents.find((a) => a.name === 'planner')!;
  assert.equal(planner.status, 'done');
  assert.equal(planner.count, 2);
  assert.equal(planner.cost, 0.21);
  assert.equal(planner.summary, 'second brief');
  assert.deepEqual(planner.history, [0.54, 0.21]);
  assert.equal(state.stats.runs, 2);
  assert.equal(state.stats.cost, 0.75);
  assert.equal(state.stats.active, 0);

  const spoke = state.edges.find((e) => e.from === CORE && e.to === 'planner')!;
  assert.equal(spoke.active, false);
});

test('flagged / error / died map to the right status class', () => {
  const flagged = project(
    [ev({ run_id: 'F1', kind: 'started' }), ev({ run_id: 'F1', kind: 'finished', status: 'flagged', cost: 0.1 })],
    ['planner'],
  );
  assert.equal(flagged.agents[0].status, 'flagged');

  const errored = project(
    [ev({ run_id: 'E1', kind: 'started' }), ev({ run_id: 'E1', kind: 'finished', status: 'error', cost: 0.1 })],
    ['planner'],
  );
  assert.equal(errored.agents[0].status, 'error');

  const died = project(
    [ev({ run_id: 'D1', kind: 'started' }), ev({ run_id: 'D1', kind: 'died' })],
    ['planner'],
  );
  assert.equal(died.agents[0].status, 'error');
  assert.equal(died.agents[0].summary, 'worker died');
});

test('registered agent without events is idle', () => {
  const state = project([], ['planner']);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].status, 'idle');
  assert.equal(state.agents[0].count, 0);
});

test('agent present only in events (not registry) still appears', () => {
  const events = [ev({ agent: 'ghost', run_id: 'G1', kind: 'started' })];
  const state = project(events, ['planner']);
  const names = state.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ['ghost', 'planner']);
});

test('child run with parent run_id derives an agent→agent edge', () => {
  const events = [
    ev({ agent: 'cfo', run_id: 'P1', kind: 'started' }),
    ev({ agent: 'planner', run_id: 'C1', kind: 'started', parent: 'P1' }),
  ];
  const state = project(events, ['planner', 'cfo']);

  const delegate = state.edges.find((e) => e.from === 'cfo' && e.to === 'planner')!;
  assert.equal(delegate.active, true);
  assert.equal(state.stats.active, 2);

  // the delegated run is not top-level, so planner's core spoke stays inactive
  const spoke = state.edges.find((e) => e.from === CORE && e.to === 'planner')!;
  assert.equal(spoke.active, false);

  const feedRow = state.feed.find((r) => r.agent === 'planner')!;
  assert.equal(feedRow.delegated, true);
});

test('windowSince: 2h-old event falls outside hour but inside today', () => {
  const now = new Date('2026-06-12T12:00:00');
  const old = new Date(now.getTime() - 2 * 3600_000).toISOString();
  assert.ok(old < windowSince('hour', now));
  assert.ok(old >= windowSince('today', now));
  assert.ok(old >= windowSince('live', now));
});
