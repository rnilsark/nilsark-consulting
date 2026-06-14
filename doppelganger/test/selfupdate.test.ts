import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateNeeded } from '../src/selfupdate.ts';

test('updateNeeded: false when shas match', () => {
  assert.equal(updateNeeded('abc123', 'abc123'), false);
});

test('updateNeeded: tolerates surrounding whitespace from git output', () => {
  assert.equal(updateNeeded('abc123\n', '  abc123 '), false);
});

test('updateNeeded: true when the followed ref moved', () => {
  assert.equal(updateNeeded('abc123', 'def456'), true);
});

test('updateNeeded: false when either sha is empty (treat as no-op, never restart blindly)', () => {
  assert.equal(updateNeeded('', 'def456'), false);
  assert.equal(updateNeeded('abc123', ''), false);
});
