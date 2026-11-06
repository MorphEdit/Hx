// The Machine panel in the dashboard state (#365, PRD #325): the `machine` field built from fixture .hx/ files —
// load.jsonl, gate-runs.jsonl, run.log and usage.jsonl — over the last 24 h before a fixed `now`.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardState } from '../src/dashboard.ts';
import { DEFAULTS } from '../src/config.ts';

const S = 1000, MIN = 60_000, H = 3_600_000, DAY = 24 * H;
const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function fixture() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dmach-'));
  const stateDir = path.join(tmp, '.hx');
  mkdirSync(stateDir);
  // 4 hours at target 2 (CPU 30, 2 issues closed each), then 2 hours at target 3 (CPU 90, 1 closed each); one line 2 days back
  const load: object[] = [{ ts: iso(NOW - 2 * DAY), cpuPct: 5, freeMemGB: 1, target: 1, running: 0, gate: false }];
  const log: string[] = [`${iso(NOW - 2 * DAY)} [#1] DONE ✓ audited and merged (1 round(s))`];
  for (let k = 0; k < 6; k++) {
    const h = NOW - (6 - k) * H, target = k < 4 ? 2 : 3;
    for (let j = 0; j < 3; j++) load.push({ ts: iso(h + j * 10 * MIN), cpuPct: target === 2 ? 30 : 90, freeMemGB: 8 - k, target, running: target - 1, gate: j === 1 });
    for (let d = 0; d < (target === 2 ? 2 : 1); d++) log.push(`${iso(h + (5 + d) * MIN)} [#${10 + k}] DONE ✓ audited and merged (1 round(s))`);
  }
  writeFileSync(path.join(stateDir, 'load.jsonl'), jsonl(load));
  writeFileSync(path.join(stateDir, 'run.log'), log.join('\n') + '\n');
  // the idle baseline: nine green 60 s runs 3 days back; the period: three 150 s runs and a reused one (left out)
  const gate = (t: number, durationMs: number, reused = false) => ({ ts: iso(t), sha: 'abc', ok: true, durationMs, timedOut: false, ...(reused ? { reused: true } : {}) });
  writeFileSync(path.join(stateDir, 'gate-runs.jsonl'), jsonl([
    ...Array.from({ length: 9 }, (_, i) => gate(NOW - 3 * DAY + i * MIN, 60 * S)),
    gate(NOW - 5 * H, 150 * S), gate(NOW - 3 * H, 150 * S), gate(NOW - 2 * H, 0, true), gate(NOW - H, 150 * S),
  ]));
  const rec = (t: number, role: string, testMs?: number) => ({ ts: iso(t), issue: 1, role, sessionId: `s${t}`, iteration: 1, model: 'm', ok: true,
    usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs: 100 * S, numTurns: 1,
    ...(testMs === undefined ? {} : { testMs, testRuns: 1, testFailedRuns: 0 }) });
  writeFileSync(path.join(stateDir, 'usage.jsonl'), jsonl([
    rec(NOW - 2 * DAY, 'impl', 100 * S), // outside the 24 h
    rec(NOW - 3 * H, 'impl', 20 * S), rec(NOW - 2 * H, 'impl', 50 * S), rec(NOW - H, 'impl', 80 * S),
    rec(NOW - H, 'audit', 10 * S), rec(NOW - H, 'review'), // no testMs: unknown, left out
  ]));
  return { root: tmp, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), workers: 3 } };
}

test('dashboardState carries machine: use with avg and p90 CPU, throughput groups, slowdown, the role split and the recommendation', E2E, () => {
  const m = (dashboardState(fixture() as any, () => ({}), NOW) as any).machine;
  assert.equal(m.from, iso(NOW - DAY));
  assert.equal(m.to, iso(NOW));
  assert.equal(m.days, 1);

  // use: the 18 lines of the period, oldest first, with the target and running workers on the same lines
  assert.equal(m.use.series.length, 18);
  assert.deepEqual(m.use.series[0], { ts: iso(NOW - 6 * H), cpuPct: 30, freeMemGB: 8, target: 2, running: 1 });
  assert.deepEqual(m.use.series.at(-1), { ts: iso(NOW - H + 20 * MIN), cpuPct: 90, freeMemGB: 3, target: 3, running: 2 });
  assert.equal(m.use.avgCpu, 50);
  assert.equal(m.use.p90Cpu, 90);

  // throughput: 2 workers over 4 h, enough; 3 workers over 2 h: not enough data
  assert.deepEqual(m.throughput, [
    { workers: 2, hours: 4, done: 8, perHour: 2, enough: true },
    { workers: 3, hours: 2, done: 2, perHour: 1, enough: false },
  ]);

  assert.deepEqual(m.slowdown, { baselineMs: 60 * S, medianMs: 150 * S, factor: 2.5, text: 'tests run 2.5× slower than at idle' });

  assert.deepEqual(m.sessions, [
    { role: 'audit', sessions: 1, testShare: 0.1, otherShare: 0.9 },
    { role: 'impl', sessions: 3, testShare: 0.5, otherShare: 0.5 },
  ]);

  assert.deepEqual(m.recommendation, { rule: 'fits', text: 'the current setting fits this machine' });
});

test('dashboardState machine: no history gives empty parts and the fits rule; workers comes from the config with no runner', E2E, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dmach-'));
  const stateDir = path.join(tmp, '.hx');
  mkdirSync(stateDir);
  const p = { root: tmp, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), workers: 1 } };
  const m = (dashboardState(p as any, () => ({}), NOW) as any).machine;
  assert.deepEqual(m.use, { series: [], avgCpu: undefined, p90Cpu: undefined });
  assert.deepEqual(m.throughput, []);
  assert.equal(m.slowdown.text, undefined);
  assert.deepEqual(m.sessions, []);
  assert.equal(m.recommendation.rule, 'fits');

  // rule B uses config.workers: the target at 1 the whole time, CPU 20%, gates at their idle speed
  writeFileSync(path.join(stateDir, 'load.jsonl'), jsonl(Array.from({ length: 10 }, (_, i) =>
    ({ ts: iso(NOW - (i + 1) * 10 * MIN), cpuPct: 20, freeMemGB: 8, target: 1, running: 1, gate: false }))));
  writeFileSync(path.join(stateDir, 'gate-runs.jsonl'), jsonl([NOW - 2 * H, NOW - H].map((t) => ({ ts: iso(t), sha: 'a', ok: true, durationMs: 60 * S, timedOut: false }))));
  const r = (dashboardState(p as any, () => ({}), NOW) as any).machine.recommendation;
  assert.deepEqual(r, { rule: 'B', text: 'this machine has room; you could raise `workers` to 2' });
});
