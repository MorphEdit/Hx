// src/tiers.ts: the tier thresholds, the rendered Tiers table and the tier-number regex (PRD #422).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_EST_DOLLARS, DIRECT_EST_MINUTES, DIRECT_MAX_CRITERIA, DIRECT_MAX_FILES, DIRECT_MAX_LINES, DIRECT_MAX_MINUTES,
  FLEET_EST_DOLLARS, FLEET_EST_MINUTES, FLEET_MIN_CRITERIA, tierNumberRegex, tierTable } from '../src/tiers.ts';

test('the five thresholds have the PRD\'s provisional values', () => {
  assert.equal(DIRECT_MAX_CRITERIA, 8);
  assert.equal(DIRECT_MAX_LINES, 500);
  assert.equal(DIRECT_MAX_FILES, 10);
  assert.equal(DIRECT_MAX_MINUTES, 45);
  assert.equal(FLEET_MIN_CRITERIA, 15);
});

test('tierTable(): a markdown table with every threshold from the constants, the three tiers and "provisional"', () => {
  const t = tierTable();
  assert.ok(t.startsWith('| Tier | When (provisional) | What happens |\n|---|---|---|\n'), t);
  for (const s of [`at most about ${DIRECT_MAX_CRITERIA} acceptance criteria`, `at most about ${DIRECT_MAX_LINES} changed lines`,
    `or ${DIRECT_MAX_FILES} files`, `under about ${DIRECT_MAX_MINUTES} min`, `more than about ${FLEET_MIN_CRITERIA} acceptance criteria`,
    '| **Direct** |', '| **One child** |', '| **Fleet** |', 'provisional']) assert.ok(t.includes(s), s);
  const rows = t.split('\n').filter((l) => l.startsWith('| **'));
  assert.deepEqual(rows.map((l) => l.split('|').length), [5, 5, 5]);
});

test('tierTable() ends with one line of rough estimates for the direct path and the fleet', () => {
  const last = tierTable().split('\n').at(-1)!;
  assert.match(last, /rough/i);
  assert.match(last, /scale with the size of the work/);
  for (const s of [`${DIRECT_EST_MINUTES} min`, `$${DIRECT_EST_DOLLARS.toFixed(2)}`, `${FLEET_EST_MINUTES} min`, `$${FLEET_EST_DOLLARS.toFixed(2)}`])
    assert.ok(last.includes(s), s);
  assert.ok(last.includes('direct') && last.includes('fleet'), last);
});

test('tierNumberRegex(): each of the five values as a standalone number, never inside a larger one', () => {
  const re = tierNumberRegex();
  const values = [DIRECT_MAX_CRITERIA, DIRECT_MAX_LINES, DIRECT_MAX_FILES, DIRECT_MAX_MINUTES, FLEET_MIN_CRITERIA];
  assert.equal(re.source, `\\b(${[...values].sort((a, b) => a - b).join('|')})\\b`);
  for (const n of values) {
    assert.ok(re.test(`about ${n} items`), String(n));
    assert.ok(re.test(String(n)), String(n));
  }
  for (const s of ['145', '4500', '80', '108', '150', '5000', '1015', 'v18', 'about 30 min', '9 files'])
    assert.ok(!re.test(s), s);
});
