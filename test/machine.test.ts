// The Machine panel's pure analysis (#363, PRD #325): use, throughput by worker count, slowdown, the session time split
// and the recommendation, from fixed records and a fixed `now` — no real load, no sleeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseMachine, doneTimes, machineUse, period, recommend, sessionSplit, slowdown, throughput, type Group, type Use } from '../src/machine.ts';
import type { GateRun } from '../src/gate.ts';
import type { LoadLine } from '../src/loadlog.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();
const load = (t: number, target: number, cpuPct = 40, running = target): LoadLine => ({ ts: iso(t), cpuPct, freeMemGB: 8, target, running, gate: false });
const gate = (t: number, durationMs: number, ok = true): GateRun => ({ ts: iso(t), sha: 'abc', ok, durationMs, timedOut: false });
const done = (t: number, n = 1) => `${iso(t)} [#${n}] DONE ✓ audited and merged (1 round(s))`;

/** `count` hours ending before NOW, `start` hours back, each with three load lines at `targets` and `closed` DONE lines. */
function hours(start: number, count: number, targets: number[], closed: number) {
  const ls: LoadLine[] = [], log: string[] = [];
  for (let k = 0; k < count; k++) {
    const h = NOW - (start - k) * HOUR;
    targets.forEach((t, j) => ls.push(load(h + j * 10 * MIN, t)));
    for (let d = 0; d < closed; d++) log.push(done(h + 5 * MIN + d * MIN, 100 + k));
  }
  return { ls, log };
}

test('period: 24 h by default, days N up to 7', () => {
  assert.deepEqual(period(NOW), { from: NOW - DAY, to: NOW, days: 1 });
  assert.equal(period(NOW, 3).from, NOW - 3 * DAY);
  assert.equal(period(NOW, 30).days, 7);
  assert.equal(period(NOW, 0).days, 1);
});

test('doneTimes: the DONE lines outcomes.ts counts, nothing else', () => {
  const t = NOW - HOUR;
  const lines = [done(t, 1), `${iso(t + MIN)} [#2] impl DONE ✓ merged`, `${iso(t + 2 * MIN)} [#3] impl: started`,
    `${iso(t + 3 * MIN)} [#3] audit PASS ✓`, 'not a log line DONE ✓ audited and merged'];
  assert.deepEqual(doneTimes(lines), [t, t + MIN]);
});

test('use: the series of the period oldest first, average and p90 CPU; lines outside the period are left out', () => {
  const ls = [load(NOW - 2 * MIN, 2, 30), load(NOW - 3 * MIN, 3, 10), load(NOW - 2 * DAY, 1, 99), load(NOW - MIN, 2, 50)];
  for (let k = 0; k < 7; k++) ls.push(load(NOW - (10 + k) * MIN, 2, 20));
  const u = machineUse(ls, NOW - DAY, NOW);
  assert.equal(u.series.length, 10);
  assert.deepEqual(u.series.slice(-3).map((s) => [s.cpuPct, s.target, s.running]), [[10, 3, 3], [30, 2, 2], [50, 2, 2]]);
  assert.deepEqual(Object.keys(u.series[0]).sort(), ['cpuPct', 'freeMemGB', 'running', 'target', 'ts']);
  assert.equal(u.avgCpu, (30 + 10 + 50 + 7 * 20) / 10);
  assert.equal(u.p90Cpu, 30);
  assert.deepEqual(machineUse([], NOW - DAY, NOW), { series: [], avgCpu: undefined, p90Cpu: undefined });
});

test('throughput: clock hours grouped by the median target of their lines, issues per hour and hours behind each group', () => {
  const a = hours(20, 4, [1, 1, 2], 1);   // 4 h at median 1, 1 issue each
  const b = hours(15, 3, [2, 3, 2], 2);   // 3 h at median 2, 2 issues each
  const c = hours(10, 2, [3, 3, 3], 3);   // 2 h at median 3, 3 issues each
  const empty = hours(5, 1, [2, 2, 2], 0); // 1 more hour at median 2, nothing closed
  const old = hours(30, 2, [3, 3, 3], 5);  // before the period: ignored
  const ls = [...a.ls, ...b.ls, ...c.ls, ...empty.ls, ...old.ls], log = [...a.log, ...b.log, ...c.log, ...old.log];
  log.push(done(NOW - 7 * HOUR + 30 * MIN)); // an hour with no load lines: in no group
  const g = throughput(ls, doneTimes(log), NOW - DAY, NOW);
  assert.deepEqual(g, [
    { workers: 1, hours: 4, done: 4, perHour: 1, enough: true },
    { workers: 2, hours: 4, done: 6, perHour: 1.5, enough: true },
    { workers: 3, hours: 2, done: 6, perHour: 3, enough: false },
  ]);
});

test('throughput: "not enough data" for a group with 2 hours, not for one with 3', () => {
  const two = hours(10, 2, [2], 1), three = hours(5, 3, [3], 1);
  const g = throughput([...two.ls, ...three.ls], doneTimes([...two.log, ...three.log]), NOW - DAY, NOW);
  assert.deepEqual(g.map((x) => [x.workers, x.hours, x.enough]), [[2, 2, false], [3, 3, true]]);
});

test('slowdown: idle baseline is the p10 of green runs over the last 7 days; red and older runs are ignored', () => {
  const gs: GateRun[] = [];
  // 20 green runs (90, then 100 × 19) and the period's 2: p10 of the 22 is the 3rd, 100 — not the fastest run
  for (let k = 1; k <= 20; k++) gs.push(gate(NOW - 2 * DAY - k * HOUR, k === 1 ? 90 : 100));
  gs.push(gate(NOW - 3 * DAY, 10, false));   // red: not in the baseline
  gs.push(gate(NOW - 8 * DAY, 20));          // older than 7 days: not in the baseline
  gs.push(gate(NOW - 2 * HOUR, 270), gate(NOW - HOUR, 250, false), gate(NOW - 3 * HOUR, 300)); // the period: median 270
  const s = slowdown(gs, NOW - DAY, NOW, NOW);
  assert.equal(s.baselineMs, 100);
  assert.equal(s.medianMs, 270);
  assert.equal(s.factor, 2.7);
  assert.equal(s.text, 'tests run 2.7× slower than at idle');
});

test('slowdown: undefined with no green run, or no gate run in the period', () => {
  const red = slowdown([gate(NOW - HOUR, 100, false)], NOW - DAY, NOW, NOW);
  assert.equal(red.factor, undefined); assert.equal(red.text, undefined);
  const none = slowdown([gate(NOW - 3 * DAY, 100)], NOW - DAY, NOW, NOW);
  assert.equal(none.baselineMs, 100); assert.equal(none.medianMs, undefined);
  assert.equal(none.factor, undefined); assert.equal(none.text, undefined);
});

test('session split: per role the median share of session time in tests, and the rest', () => {
  const r = (role: string, durationMs: number, testMs?: number, ts = iso(NOW - HOUR)) => ({ ts, role, durationMs, testMs });
  const recs = [r('impl', 100, 80), r('impl', 100, 20), r('impl', 100, 50), r('review', 200, 50),
    r('review', 100), r('impl', 0, 0), r('impl', 100, 100, iso(NOW - 2 * DAY))]; // no testMs, no time, outside: left out
  const s = sessionSplit(recs, NOW - DAY, NOW);
  assert.deepEqual(s, [
    { role: 'impl', sessions: 3, testShare: 0.5, otherShare: 0.5 },
    { role: 'review', sessions: 1, testShare: 0.25, otherShare: 0.75 },
  ]);
});

// --- the recommendation ---------------------------------------------------------------------------------------------

const grp = (workers: number, hours: number, done: number): Group => ({ workers, hours, done, perHour: done / hours, enough: hours >= 3 });
const use = (lines: number, atCap: number, cpu: number, workers = 3): Use => ({
  series: Array.from({ length: lines }, (_, k) => ({ ts: iso(NOW - (k + 1) * MIN), cpuPct: cpu, freeMemGB: 8, target: k < atCap ? workers : workers - 1, running: 1 })),
  avgCpu: cpu, p90Cpu: cpu,
});
const slow = (factor?: number) => ({ factor });
const busy = use(10, 0, 90);

test('rule A: two worker counts with ≥ 6 h each and under 10% more per hour for the higher one', () => {
  const a = recommend([grp(2, 6, 60), grp(3, 6, 65)], busy, slow(3), 3);
  assert.equal(a.rule, 'A');
  assert.equal(a.text, '3 workers get about as much done as 2 here; set `workers` to 2');
  // just under 10% more fires; exactly 10% more does not
  assert.equal(recommend([grp(2, 10, 100), grp(3, 10, 109)], busy, slow(3), 3).rule, 'A');
  assert.equal(recommend([grp(2, 10, 100), grp(3, 10, 110)], busy, slow(3), 3).rule, 'fits');
  // 6 h each fires; under 6 h on either side does not
  assert.equal(recommend([grp(2, 5, 50), grp(3, 6, 50)], busy, slow(3), 3).rule, 'fits');
  assert.equal(recommend([grp(2, 6, 60), grp(3, 5, 50)], busy, slow(3), 3).rule, 'fits');
  // not adjacent counts: no rule A
  assert.equal(recommend([grp(1, 8, 80), grp(3, 8, 80)], busy, slow(3), 3).rule, 'fits');
  // the lowest N that does not help
  assert.equal(recommend([grp(1, 8, 40), grp(2, 8, 80), grp(3, 8, 82)], busy, slow(3), 3).text, '3 workers get about as much done as 2 here; set `workers` to 2');
});

test('rule B: target at workers ≥ 80% of the time, average CPU < 50% and slowdown < 1.5×', () => {
  const b = recommend([], use(10, 8, 49), slow(1.4), 3);
  assert.equal(b.rule, 'B');
  assert.equal(b.text, 'this machine has room; you could raise `workers` to 4');
  assert.equal(recommend([], use(100, 80, 49.9), slow(1.49), 3).rule, 'B');
  // just past each threshold
  assert.equal(recommend([], use(100, 79, 49.9), slow(1.49), 3).rule, 'fits');
  assert.equal(recommend([], use(100, 80, 50), slow(1.49), 3).rule, 'fits');
  assert.equal(recommend([], use(100, 80, 49.9), slow(1.5), 3).rule, 'fits');
  // unknown slowdown or no load lines: no rule B
  assert.equal(recommend([], use(100, 100, 10), slow(undefined), 3).rule, 'fits');
  assert.equal(recommend([], use(0, 0, 10), slow(1), 3).rule, 'fits');
});

test('fallback: the current setting fits this machine', () => {
  assert.deepEqual(recommend([grp(2, 8, 40), grp(3, 8, 80)], busy, slow(3), 3), { rule: 'fits', text: 'the current setting fits this machine' });
});

test('analyseMachine: every part over the period from the raw records', () => {
  const lo = hours(20, 6, [2], 10), hi = hours(12, 6, [3], 10);
  const gates = [gate(NOW - 3 * DAY, 100), gate(NOW - HOUR, 300)];
  const usage = [{ ts: iso(NOW - HOUR), role: 'impl', durationMs: 100, testMs: 80 }];
  const m = analyseMachine({ load: [...lo.ls, ...hi.ls], gates, log: [...lo.log, ...hi.log], usage, workers: 3, now: NOW });
  assert.equal(m.days, 1);
  assert.equal(m.from, iso(NOW - DAY));
  assert.equal(m.use.series.length, 12);
  assert.deepEqual(m.throughput.map((g) => [g.workers, g.hours, g.perHour]), [[2, 6, 10], [3, 6, 10]]);
  assert.equal(m.slowdown.text, 'tests run 3.0× slower than at idle');
  assert.deepEqual(m.sessions.map((s) => [s.role, s.testShare]), [['impl', 0.8]]);
  assert.deepEqual(m.recommendation, { rule: 'A', text: '3 workers get about as much done as 2 here; set `workers` to 2' });
  // days N widens the period
  assert.equal(analyseMachine({ load: [], gates: [], log: [], usage: [], workers: 3, now: NOW, days: 7 }).from, iso(NOW - 7 * DAY));
});
