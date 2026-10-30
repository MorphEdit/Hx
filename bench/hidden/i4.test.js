// Hidden acceptance tests for issue #4 (readingTime). Never shown to the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingTime } from '../src/reading.js';

const words = (n) => Array.from({ length: n }, () => 'w').join(' ');

test('#4 examples from the issue', () => {
  assert.equal(readingTime(words(200)), 1);
  assert.equal(readingTime(words(201)), 2);
  assert.equal(readingTime(words(250), 100), 3);
  assert.throws(() => readingTime('hi', 0), RangeError);
});

test('#4 rules beyond the examples', () => {
  assert.equal(readingTime(''), 0);
  assert.equal(readingTime('hi'), 1);
  assert.equal(readingTime('hi, there! ,,,'), 1);
  assert.throws(() => readingTime('hi', -5), RangeError);
});
