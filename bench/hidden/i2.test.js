// Hidden acceptance tests for issue #2 (wordFreq). Never shown to the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordFreq } from '../src/freq.js';

test('#2 examples from the issue', () => {
  assert.deepEqual(wordFreq('b a b c a b'), [['b', 3], ['a', 2], ['c', 1]]);
  assert.deepEqual(wordFreq('z y x'), [['x', 1], ['y', 1], ['z', 1]]);
  assert.deepEqual(wordFreq('b a b c a b', { top: 2 }), [['b', 3], ['a', 2]]);
});

test('#2 rules beyond the examples', () => {
  assert.deepEqual(wordFreq(''), []);
  assert.deepEqual(wordFreq('A a, B!'), [['a', 2], ['b', 1]]);
  assert.deepEqual(wordFreq('x y', { top: 10 }), [['x', 1], ['y', 1]]);
  assert.deepEqual(wordFreq('d c c d a'), [['c', 2], ['d', 2], ['a', 1]]);
});
