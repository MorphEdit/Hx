import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordFreq } from '../src/freq.js';

test('wordFreq', () => {
  assert.deepEqual(wordFreq('b a b c a b'), [['b', 3], ['a', 2], ['c', 1]]);
  assert.deepEqual(wordFreq('b a b c a b', { top: 2 }), [['b', 3], ['a', 2]]);
});
