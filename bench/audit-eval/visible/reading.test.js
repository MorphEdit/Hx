import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingTime } from '../src/reading.js';

const words = (n) => Array.from({ length: n }, () => 'w').join(' ');

test('readingTime', () => {
  assert.equal(readingTime(words(200)), 1);
  assert.equal(readingTime(words(201)), 2);
  assert.equal(readingTime(words(250), 100), 3);
});
