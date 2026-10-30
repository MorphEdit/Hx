// Hidden acceptance tests for issue #6 (truncate). Never shown to the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.js';

test('#6 examples from the issue', () => {
  assert.equal(truncate('hello world', 20), 'hello world');
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('the quick brown fox', 12), 'the quick…');
  assert.equal(truncate('hello world', 8, '...'), 'hello...');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.throws(() => truncate('hi there', 2, '...'), RangeError);
});

test('#6 rules beyond the examples', () => {
  assert.equal(truncate('one two three four', 11), 'one two…');
  assert.equal(truncate('superlongword short', 8), 'superlo…');
  assert.equal(truncate('hello', 1), '…');
  assert.equal(truncate('a   b   c d', 7), 'a   b…');
});
