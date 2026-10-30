import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.js';

test('truncate', () => {
  assert.equal(truncate('hello world', 20), 'hello world');
  assert.equal(truncate('the quick brown fox', 12), 'the quick…');
  assert.equal(truncate('hello world', 8, '...'), 'hello...');
});
