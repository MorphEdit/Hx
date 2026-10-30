// Hidden acceptance tests for issue #1 (tokenize). Never shown to the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/tokenize.js';

test('#1 examples from the issue', () => {
  assert.deepEqual(tokenize("Don't stop, believing!"), ["don't", 'stop', 'believing']);
  assert.deepEqual(tokenize('Hello, HELLO hello'), ['hello', 'hello', 'hello']);
  assert.deepEqual(tokenize("'quoted' words"), ['quoted', 'words']);
  assert.deepEqual(tokenize('café 42'), ['café', '42']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('  ,,, '), []);
});

test('#1 rules beyond the examples', () => {
  assert.deepEqual(tokenize("rock'n'roll"), ["rock'n'roll"]);
  assert.deepEqual(tokenize('Ünïcödé ÄÖ'), ['ünïcödé', 'äö']);
  assert.deepEqual(tokenize('a-b_c'), ['a', 'b', 'c']);
  assert.deepEqual(tokenize("'' ' x'"), ['x']);
});
