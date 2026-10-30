// parseOutcomes: run.log text → the dashboard's outcome numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutcomes } from '../src/outcomes.ts';

const min = 60_000;
// CRLF line ends and a log tail that starts mid-line, as the dashboard may read it
const fixture = [
  '0:00.000Z #9 impl: truncated first line',
  '2026-10-31T10:00:00.000Z - hx run: 3 workers',
  '2026-10-31T10:00:00.000Z #10 gauntlet (round 1): PRD title',
  '2026-10-31T10:05:00.000Z #10 gauntlet round 1/3: FAIL ✗ — missing edge case',
  '2026-10-31T10:06:00.000Z #10 gauntlet round 1/3 done (1m, 10k tokens)',
  '2026-10-31T10:07:00.000Z #10 gauntlet round 2/3: PASS ✓ — labelled hardened (1m, 10k tokens)',
  '2026-10-31T11:00:00.000Z #1 impl: first issue',
  '2026-10-31T11:10:00.000Z #1 audit 1/3: PR #101',
  '2026-10-31T11:12:00.000Z #1 audit FAIL ✗ — tests missing',
  '2026-10-31T11:13:00.000Z #1 impl (round 2): first issue',
  '2026-10-31T11:25:00.000Z #1 audit PASS ✓',
  '2026-10-31T11:30:00.000Z #1 DONE ✓ audited and merged (2 round(s), 30m, 50k tokens)',
  '2026-10-31T11:00:00.000Z #2 impl: second issue',
  '2026-10-31T11:05:00.000Z #2 audit PASS ✓',
  '2026-10-31T11:10:00.000Z #2 DONE ✓ audited and merged (1 round(s), 10m, 20k tokens)',
  '2026-10-31T12:00:00.000Z - gate RED ✗ — `npm test` fails on main at abc1234; claiming only its fix',
  '2026-10-31T12:15:00.000Z - gate green ✓ again at def5678',
  '2026-10-31T12:00:00.000Z #3 impl: third issue',
  '2026-10-31T12:20:00.000Z #3 audit FAIL ✗ — wrong output',
  '2026-10-31T12:21:00.000Z #3 impl (round 2): third issue',
  '2026-10-31T13:00:00.000Z #3 audit PASS ✓',
  '2026-10-31T13:00:00.000Z #3 DONE ✓ audited and merged (2 round(s), 60m, 90k tokens)',
  '2026-10-31T13:00:00.000Z #4 impl: unaudited issue',
  '2026-10-31T13:20:00.000Z #4 impl DONE ✓ (20m, 30k tokens)',
  '2026-10-31T13:30:00.000Z #20 review (round 1): PRD',
  '2026-10-31T13:40:00.000Z #20 review DONE ✓ (10m, 5k tokens)',
  '2026-10-31T13:50:00.000Z #20 security (round 1): PRD',
  '2026-10-31T13:55:00.000Z #20 security pass filed #22, #21 — removed reviewed',
  '2026-10-31T14:00:00.000Z #20 security DONE ✓ (10m, 5k tokens)',
  '2026-10-31T14:30:00.000Z - gate RED ✗ — `npm test` fails on main at 9999999; claiming only its fix',
  'not a log line',
  '',
].join('\r\n');

test('parseOutcomes(fixture): every field', () => {
  assert.deepEqual(parseOutcomes(fixture), {
    audit: { pass: 3, fail: 2, mergedIssues: 3, avgRounds: 5 / 3 },
    gauntlet: { rounds: 2, pass: 1, fail: 1 },
    security: { passes: 1, filed: [21, 22] },
    gate: { red: 2, recovered: 1, openRed: true, redMs: [15 * min], avgRedMs: 15 * min },
    // #1 30m, #2 10m, #3 60m (audited), #4 20m (unaudited) → (20+30)/2; review/security DONE are not issue ends
    issues: { done: 4, medianMs: 25 * min },
  });
});

test('empty input: zeros and nulls, no throw', () => {
  const empty = {
    audit: { pass: 0, fail: 0, mergedIssues: 0, avgRounds: null },
    gauntlet: { rounds: 0, pass: 0, fail: 0 },
    security: { passes: 0, filed: [] },
    gate: { red: 0, recovered: 0, openRed: false, redMs: [], avgRedMs: null },
    issues: { done: 0, medianMs: null },
  };
  assert.deepEqual(parseOutcomes(''), empty);
  assert.deepEqual(parseOutcomes('garbage\r\nmore'), empty);
});

test('median of an odd count; a DONE with no impl start and a first green are not counted', () => {
  const o = parseOutcomes([
    '2026-01-01T00:00:00.000Z #1 impl: a', '2026-01-01T00:01:00.000Z #1 impl DONE ✓ (x)',
    '2026-01-01T00:00:00.000Z #2 impl: b', '2026-01-01T00:05:00.000Z #2 impl DONE ✓ (x)',
    '2026-01-01T00:00:00.000Z #3 impl: c', '2026-01-01T00:09:00.000Z #3 impl DONE ✓ (x)',
    '2026-01-01T00:09:00.000Z #4 impl DONE ✓ (x)',
    '2026-01-01T00:00:00.000Z - gate green ✓ at abc',
  ].join('\n'));
  assert.deepEqual(o.issues, { done: 3, medianMs: 5 * min });
  assert.deepEqual(o.gate, { red: 0, recovered: 0, openRed: false, redMs: [], avgRedMs: null });
});
