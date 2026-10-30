import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/tokenize.js';

test('tokenize', () => {
  assert.deepEqual(tokenize("Don't stop, believing!"), ["don't", 'stop', 'believing']);
  assert.deepEqual(tokenize('Hello, HELLO hello'), ['hello', 'hello', 'hello']);
  assert.deepEqual(tokenize(''), []);
});
