// Hidden acceptance tests for issue #3 (slugify). Never shown to the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('#3 examples from the issue', () => {
  assert.equal(slugify('Héllo, Wörld!'), 'hello-world');
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('C++ & Rust'), 'c-rust');
  assert.equal(slugify(''), '');
});

test('#3 rules beyond the examples', () => {
  assert.equal(slugify('Ünïcödé--Test__x'), 'unicode-test-x');
  assert.equal(slugify('---'), '');
  assert.equal(slugify('123 ABC'), '123-abc');
});
