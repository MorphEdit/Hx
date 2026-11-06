// src/controlroom.ts timelineFrom and workerOf (#371, PRD #367): sessions packed into worker lanes plus the gate lane,
// over the last 6 h. Times are built from local Date values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineFrom, workerOf, type Timeline } from '../src/controlroom.ts';

const ms = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();
const iso = (h: number, m = 0) => new Date(ms(h, m)).toISOString();
const NOW = ms(15);
const FROM = ms(9);
const MIN = 60_000;
// a usage record ending at h:m that ran `min` minutes
const rec = (issue: number, role: string, sessionId: string, h: number, m: number, min: number) =>
  ({ ts: iso(h, m), issue, role, sessionId, durationMs: min * MIN });
const bar = (issue: number | null, role: string, start: number, end: number) => ({ issue, role, startMs: start, endMs: end });
const lanes = (t: Timeline) => Object.fromEntries(t.lanes.map((l) => [l.worker, l.bars]));
const line = (h: number, m: number, n: number, msg: string) => `${iso(h, m)} [#${n}] ${msg}`;

test('a finished session: its records grouped by (issue, role, sessionId) into one bar', () => {
  const t = timelineFrom([
    rec(4, 'impl', 'a', 10, 30, 20),   // 10:10 → 10:30
    rec(4, 'impl', 'a', 11, 0, 25),    // 10:35 → 11:00
    rec(4, 'audit', 'a', 11, 20, 15),  // another role: its own bar, same lane
  ], [], [], [], NOW);
  assert.equal(t.from, FROM);
  assert.equal(t.to, NOW);
  assert.deepEqual(t.lanes, [
    { worker: 'W1', bars: [bar(4, 'impl', ms(10, 10), ms(11)), bar(4, 'audit', ms(11, 5), ms(11, 20))] },
    { worker: 'gate', bars: [] },
  ]);
});

test('a running session: from since, or from the end of the issue\'s latest finished bar after since; to now', () => {
  const sessions = [
    { number: 5, kind: 'review', since: iso(12) },
    { number: 6, kind: 'gauntlet', since: iso(12) },
  ];
  const usage = [
    rec(6, 'critic', 'c', 12, 30, 30),   // after since: the live bar starts at its end
    rec(6, 'revise', 'r', 13, 0, 20),    // the latest one after since
    rec(5, 'review', 'old', 11, 0, 30),  // before since: ignored
  ];
  const l = lanes(timelineFrom(usage, sessions, [], [], NOW));
  const live = Object.values(l).flat().filter((b) => b.running);
  assert.deepEqual(live, [
    { issue: 5, role: 'review', startMs: ms(12), endMs: NOW, running: true },
    { issue: 6, role: 'gauntlet', startMs: ms(13), endMs: NOW, running: true },
  ]);
});

test('a running impl session takes its stage from the log lines: impl, audit, merge', () => {
  const s = [{ number: 7, kind: 'impl', since: iso(14) }];
  const role = (lines: string[]) => timelineFrom([], s, [], lines, NOW).lanes[0].bars[0].role;
  const claim = line(14, 0, 7, 'impl: Add a thing');
  assert.equal(role([claim]), 'impl');
  assert.equal(role([claim, line(14, 10, 7, 'audit 1/3: PR #9')]), 'audit');
  assert.equal(role([claim, line(14, 10, 7, 'audit 1/3: PR #9'), line(14, 20, 7, 'audit PASS ✓ (1M tokens)')]), 'merge');
  assert.equal(role([claim, line(14, 10, 7, 'audit 1/3: PR #9'), line(14, 20, 7, 'audit FAIL ✗ (1M tokens)')]), 'impl');
});

test('the 6 h cut-off: a bar ending before from is dropped, one starting before from is clipped', () => {
  const t = timelineFrom([
    rec(1, 'impl', 'a', 8, 59, 30),    // ends before 09:00: dropped
    rec(2, 'impl', 'b', 9, 30, 60),    // 08:30 → 09:30: clipped to 09:00
  ], [{ number: 3, kind: 'triage', since: iso(7) }], [], [], NOW);
  assert.deepEqual(t.lanes, [
    { worker: 'W1', bars: [bar(2, 'impl', FROM, ms(9, 30))] },
    { worker: 'W2', bars: [{ ...bar(3, 'triage', FROM, NOW), running: true }] },
    { worker: 'gate', bars: [] },
  ]);
  // another window length
  assert.equal(timelineFrom([], [], [], [], NOW, 2).from, ms(13));
});

test('the lane rules: same issue kept in its lane, else the lowest free lane, else a new lane named W<n>', () => {
  const t = timelineFrom([
    rec(1, 'impl', 'a', 10, 30, 30),   // 10:00 → 10:30 W1
    rec(2, 'impl', 'b', 10, 50, 40),   // 10:10 → 10:50 W2 (W1 busy)
    rec(3, 'impl', 'c', 11, 0, 30),    // 10:30 → 11:00 W1 (free at 10:30, lowest)
    rec(2, 'audit', 'b', 11, 30, 30),  // 11:00 → 11:30 W2: its issue's lane, though W1 is free too
    rec(4, 'impl', 'd', 11, 30, 30),   // 11:00 → 11:30 W1: lowest free lane
    rec(5, 'impl', 'e', 11, 20, 15),   // 11:05 → 11:20 W3: all busy, a new lane
  ], [], [], [], NOW);
  assert.deepEqual(t.lanes.map((l) => [l.worker, l.bars.map((b) => `${b.issue} ${b.role}`)]), [
    ['W1', ['1 impl', '3 impl', '4 impl']],
    ['W2', ['2 impl', '2 audit']],
    ['W3', ['5 impl']],
    ['gate', []],
  ]);
});

test('bars with the same start go by issue; issue 0 (self-review) keeps its bar with issue null', () => {
  const t = timelineFrom([rec(9, 'impl', 'x', 11, 0, 60), rec(0, 'selfreview', 's', 11, 0, 60), rec(3, 'impl', 'y', 11, 0, 60)], [], [], [], NOW);
  assert.deepEqual(t.lanes.map((l) => l.bars.map((b) => b.issue)), [[null], [3], [9], []]);
  assert.equal(t.lanes[0].bars[0].role, 'selfreview');
});

test('the gate lane is last: one bar per run in the window, ok kept (green and RED)', () => {
  const t = timelineFrom([rec(4, 'impl', 'a', 10, 0, 30)], [], [
    { ts: iso(8, 0), ok: true, durationMs: 10 * MIN },   // before the window: dropped
    { ts: iso(9, 5), ok: true, durationMs: 10 * MIN },   // clipped
    { ts: iso(12, 0), ok: false, durationMs: 8 * MIN },
  ], [], NOW);
  assert.equal(t.lanes.at(-1)!.worker, 'gate');
  assert.deepEqual(t.lanes.at(-1)!.bars, [
    { issue: null, role: 'gate', startMs: FROM, endMs: ms(9, 5), ok: true },
    { issue: null, role: 'gate', startMs: ms(11, 52), endMs: ms(12), ok: false },
  ]);
});

test('workerOf: the lane of the running bar, else of the latest bar by end time, else —', () => {
  const t = timelineFrom([
    rec(1, 'impl', 'a', 10, 30, 30),   // 10:00 → 10:30 W1
    rec(2, 'impl', 'b', 10, 50, 40),   // 10:10 → 10:50 W2
    rec(3, 'impl', 'c', 11, 0, 40),    // 10:20 → 11:00 W3
    rec(1, 'audit', 'd', 12, 0, 30),   // 11:30 → 12:00 W2: W1 holds #4's running bar
  ], [{ number: 4, kind: 'review', since: iso(10, 40) }], [{ ts: iso(12), ok: true, durationMs: MIN }], [], NOW); // #4 from 10:40: W1
  assert.deepEqual(t.lanes.map((l) => [l.worker, l.bars.map((b) => b.issue)]), [['W1', [1, 4]], ['W2', [2, 1]], ['W3', [3]], ['gate', [null]]]);
  assert.equal(workerOf(t, 4), 'W1');   // its running bar
  assert.equal(workerOf(t, 1), 'W2');   // its latest bar, not its first
  assert.equal(workerOf(t, 3), 'W3');
  assert.equal(workerOf(t, 99), '—');
});
