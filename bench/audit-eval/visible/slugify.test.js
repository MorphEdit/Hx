import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('slugify', () => {
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('C++ & Rust'), 'c-rust');
  assert.equal(slugify(''), '');
});
