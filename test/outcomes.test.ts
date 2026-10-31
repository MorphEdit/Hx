// parseOutcomes: run.log lines (PRD #37 §1 format) → the dashboard's outcome numbers (§5a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutcomes } from '../src/outcomes.ts';

const min = 60_000;
// a log tail that starts mid-line, as the dashboard may read it, and lines with and without `[#n] `
const fixture = [
  '0:00.000Z [#9] impl: truncated first line',
  '2026-10-31T10:00:00.000Z hx pool up — me/app · 3 worker(s)',
  '2026-10-31T10:00:00.000Z [#10] gauntlet (round 1): PRD title',
  '2026-10-31T10:05:00.000Z [#10] gauntlet round 1/3: FAIL ✗ — missing edge case',
  '2026-10-31T10:06:00.000Z [#10] gauntlet round 1/3 done (1m, 10k tokens)',
  '2026-10-31T10:07:00.000Z [#10] gauntlet round 2/3: PASS ✓ — labelled hardened (1m, 10k tokens)',
  '2026-10-31T11:00:00.000Z [#1] impl: first issue',
  '2026-10-31T11:10:00.000Z [#1] audit 1/3: PR #101',
  '2026-10-31T11:12:00.000Z [#1] audit FAIL ✗ — tests missing',
  '2026-10-31T11:13:00.000Z [#1] impl (round 2): first issue',
  '2026-10-31T11:25:00.000Z [#1] audit PASS ✓',
  '2026-10-31T11:30:00.000Z [#1] DONE ✓ audited and merged (2 round(s), 30m, 50k tokens)',
  '2026-10-31T11:00:00.000Z [#2] impl: second issue',
  '2026-10-31T11:05:00.000Z [#2] audit PASS ✓',
  '2026-10-31T11:10:00.000Z [#2] DONE ✓ audited and merged (1 round(s), 10m, 20k tokens)',
  '2026-10-31T12:00:00.000Z gate RED ✗ — `npm test` fails on main at abc1234; claiming only its fix',
  '2026-10-31T12:15:00.000Z gate green ✓ again at def5678',
  '2026-10-31T12:00:00.000Z [#3] impl: third issue',
  '2026-10-31T12:20:00.000Z [#3] audit FAIL ✗ — wrong output',
  '2026-10-31T12:21:00.000Z [#3] impl (round 2): third issue',
  '2026-10-31T13:00:00.000Z [#3] audit PASS ✓',
  '2026-10-31T13:00:00.000Z [#3] DONE ✓ audited and merged (2 round(s), 60m, 90k tokens)',
  '2026-10-31T13:00:00.000Z [#4] impl: unaudited issue',
  '2026-10-31T13:20:00.000Z [#4] impl DONE ✓ (20m, 30k tokens)',
  '2026-10-31T13:30:00.000Z [#20] review (round 1): PRD',
  '2026-10-31T13:40:00.000Z [#20] review DONE ✓ (10m, 5k tokens)',
  '2026-10-31T13:50:00.000Z [#20] security (round 1): PRD',
  '2026-10-31T13:55:00.000Z [#20] security pass filed issue(s) — removed prd-reviewed',
  '2026-10-31T14:00:00.000Z [#20] security DONE ✓ (10m, 5k tokens)',
  '2026-10-31T14:10:00.000Z [#20] security (round 2): PRD',
  '2026-10-31T14:20:00.000Z [#20] security DONE ✓ (10m, 5k tokens)',
  '2026-10-31T14:21:00.000Z [#20] security (round 3): PRD',
  '2026-10-31T14:22:00.000Z [#20] security pass filed #61, #62 — removed prd-reviewed',
  '2026-10-31T14:23:00.000Z [#20] security DONE ✓ (10m, 5k tokens)',
  '2026-10-31T14:30:00.000Z gate RED ✗ — `npm test` fails on main at 9999999; claiming only its fix',
  'not a log line',
  '',
];

test('parseOutcomes(fixture in the §1 format): every §5a count', () => {
  assert.deepEqual(parseOutcomes(fixture), {
    audit: { pass: 3, fail: 2, mergedIssues: 3, avgRounds: 5 / 3 },
    gauntlet: { rounds: 2, pass: 1, fail: 1 },
    security: { passes: 3, filed: 2 },
    gate: { red: 2, recovered: 1, openRed: true, redMs: [15 * min], avgRedMs: 15 * min },
    // #1 30m, #2 10m, #3 60m (audited), #4 20m (unaudited) → (20+30)/2; review/security DONE are not issue ends
    issues: { done: 4, medianMs: 25 * min },
    triage: { reproduced: 0, needsInfo: 0, failed: 0, gaveUp: 0 },
  });
});

test('the old `#n` / `-` form is not the §1 format: its messages are not matched', () => {
  const o = parseOutcomes(['2026-10-31T11:05:00.000Z #2 audit PASS ✓', '2026-10-31T12:00:00.000Z - gate RED ✗ x']);
  assert.equal(o.audit.pass, 0);
  assert.equal(o.gate.red, 0);
});

test('empty input: zeros and nulls, no throw', () => {
  const empty = {
    audit: { pass: 0, fail: 0, mergedIssues: 0, avgRounds: null },
    gauntlet: { rounds: 0, pass: 0, fail: 0 },
    security: { passes: 0, filed: 0 },
    gate: { red: 0, recovered: 0, openRed: false, redMs: [], avgRedMs: null },
    issues: { done: 0, medianMs: null },
    triage: { reproduced: 0, needsInfo: 0, failed: 0, gaveUp: 0 },
  };
  assert.deepEqual(parseOutcomes([]), empty);
  assert.deepEqual(parseOutcomes(['garbage', 'more', '2026-10-31 not iso [#1] audit PASS ✓']), empty);
});

test('gate: every RED counts, also one while red and one with an issue number; each pairs with the next green again', () => {
  const o = parseOutcomes([
    '2026-01-01T00:00:00.000Z gate RED ✗ a',
    '2026-01-01T00:05:00.000Z [#7] gate RED ✗ b',            // a second RED before green: counted, paired with the same green
    '2026-01-01T00:10:00.000Z gate green ✓ again at x',
    '2026-01-01T00:20:00.000Z gate green ✓ again at y',     // no RED pending: pairs with nothing
    '2026-01-01T00:30:00.000Z gate RED ✗ c',
    '2026-01-01T00:32:00.000Z gate green ✓ again at z',
  ]);
  assert.deepEqual(o.gate, { red: 3, recovered: 3, openRed: false, redMs: [10 * min, 5 * min, 2 * min], avgRedMs: 17 * min / 3 });
});

test('median of an odd count; a DONE with no impl start and a first green are not counted', () => {
  const o = parseOutcomes([
    '2026-01-01T00:00:00.000Z [#1] impl: a', '2026-01-01T00:01:00.000Z [#1] impl DONE ✓ (x)',
    '2026-01-01T00:00:00.000Z [#2] impl: b', '2026-01-01T00:05:00.000Z [#2] impl DONE ✓ (x)',
    '2026-01-01T00:00:00.000Z [#3] impl: c', '2026-01-01T00:09:00.000Z [#3] impl DONE ✓ (x)',
    '2026-01-01T00:09:00.000Z [#4] impl DONE ✓ (x)',
    '2026-01-01T00:00:00.000Z gate green ✓ at abc',
  ]);
  assert.deepEqual(o.issues, { done: 3, medianMs: 5 * min });
  assert.deepEqual(o.gate, { red: 0, recovered: 0, openRed: false, redMs: [], avgRedMs: null });
});

test('triage: the four outcome lines are counted, with or without [#n]; round cap reached is not a give-up', () => {
  const o = parseOutcomes([
    '2026-01-01T00:00:00.000Z [#5] triage: REPRODUCED ✓',
    '2026-01-01T00:01:00.000Z triage: REPRODUCED ✓',
    '2026-01-01T00:02:00.000Z [#6] triage: NEEDS-INFO — waiting for the reporter',
    '2026-01-01T00:03:00.000Z [#7] triage: FAILED',
    '2026-01-01T00:04:00.000Z [#8] triage: GAVE UP after 3 rounds',
    '2026-01-01T00:05:00.000Z triage: GAVE UP after 2 rounds',
    '2026-01-01T00:06:00.000Z [#9] triage: round cap reached — labelled agent-blocked',
    '2026-01-01T00:07:00.000Z [#9] triage: started',
    '2026-01-01T00:08:00.000Z [#9] impl: x',
    'triage: REPRODUCED ✓',                                   // no timestamp: skipped
  ]);
  assert.deepEqual(o.triage, { reproduced: 2, needsInfo: 1, failed: 1, gaveUp: 2 });
});
