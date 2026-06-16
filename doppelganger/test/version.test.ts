import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVersion } from '../src/version.ts';

test('getVersion reports the repo HEAD as sha + date', () => {
  const v = getVersion();
  assert.equal(typeof v.sha, 'string');
  assert.ok(v.sha.length > 0, 'sha is non-empty');
  assert.equal(typeof v.date, 'string');
});

test('getVersion is cached (same object across calls)', () => {
  assert.equal(getVersion(), getVersion());
});
