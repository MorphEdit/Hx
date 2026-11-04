// Test time in the dashboard Stats (PRD #182 D.11): the state JSON's last-24 h numbers and 14-day series from fixture
// usage records and gate lines.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardState, testTime } from '../src/dashboard.ts';
import { DEFAULTS } from '../src/config.ts';

const S = 1000, H = 3_600_000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
const rec = (ts: string, durationMs: number, t?: { testMs: number; testRuns: number }) => ({ ts, issue: 1, role: 'impl', sessionId: `s-${ts}`,
  iteration: 1, model: 'm', ok: true, usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs, numTurns: 1,
  ...(t ? { testMs: t.testMs, testRuns: t.testRuns, testFailedRuns: 0 } : {}) });
const gate = (ts: string, durationMs: number) => ({ ts, sha: 'abc', ok: true, durationMs, timedOut: false });

const recs = [
  rec('2026-10-06T23:00:00.000Z', 100 * S, { testMs: 90 * S, testRuns: 1 }), // older than the 14 days: excluded
  rec('2026-10-07T00:00:00.000Z', 100 * S, { testMs: 40 * S, testRuns: 2 }), // first day of the 14: 20 s per run
  rec('2026-10-10T08:00:00.000Z', 100 * S, { testMs: 30 * S, testRuns: 1 }),
  rec('2026-10-10T09:00:00.000Z', 100 * S, { testMs: 10 * S, testRuns: 1 }),
  rec('2026-10-10T10:00:00.000Z', 100 * S), // no test fields: unknown, not 0
  rec(at(NOW - 2 * H), 200 * S, { testMs: 50 * S, testRuns: 1 }), // last 24 h
  rec(at(NOW - 1 * H), 200 * S, { testMs: 30 * S, testRuns: 3 }), // last 24 h: 10 s per run
] as any[];
const gates = [
  gate('2026-10-05T12:00:00.000Z', 999 * S), // excluded
  gate('2026-10-12T12:00:00.000Z', 60 * S), // a day with gate data only
  gate(at(NOW - 3 * H), 40 * S),
  gate(at(NOW - 2 * H), 80 * S),
  gate(at(NOW - 1 * H), 120 * S),
];

test('testTime: the last-24 h numbers and the 14-day series; days without data have no point, older data is excluded', E2E, () => {
  const t = testTime(recs, gates, NOW);
  assert.deepEqual(t.last24h, { share: 80 / 400, testRunMedian: 10 * S, gateMedian: 80 * S, gateP90: 120 * S });
  assert.equal(t.days.from, '2026-10-07');
  assert.deepEqual(t.days.testRun, [
    { day: '2026-10-07', ms: 20 * S }, { day: '2026-10-10', ms: 10 * S }, { day: '2026-10-20', ms: 10 * S }]);
  assert.deepEqual(t.days.gate, [{ day: '2026-10-12', ms: 60 * S }, { day: '2026-10-20', ms: 80 * S }]);
});

test('testTime with no data: null numbers and empty series', E2E, () => {
  const t = testTime([], [], NOW);
  assert.deepEqual(t.last24h, { share: null, testRunMedian: null, gateMedian: null, gateP90: null });
  assert.deepEqual(t.days.testRun, []);
  assert.deepEqual(t.days.gate, []);
  // records outside the window: the 24 h numbers stay null, still in the 14 days
  const t2 = testTime([rec('2026-10-15T00:00:00.000Z', 10 * S, { testMs: 5 * S, testRuns: 1 })] as any, [], NOW);
  assert.equal(t2.last24h.share, null);
  assert.deepEqual(t2.days.testRun, [{ day: '2026-10-15', ms: 5 * S }]);
});

test('dashboardState: time comes from .hx/usage.jsonl and .hx/gate-runs.jsonl', E2E, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dtime-'));
  const dir = path.join(tmp, '.hx');
  mkdirSync(dir);
  const now = Date.now();
  writeFileSync(path.join(dir, 'usage.jsonl'), [rec(at(now - H), 100 * S, { testMs: 25 * S, testRuns: 1 }), rec(at(now - 20 * 86_400_000), 100 * S, { testMs: 9 * S, testRuns: 1 })]
    .map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'gate-runs.jsonl'), JSON.stringify(gate(at(now - H), 70 * S)) + '\n');
  const p = { root: tmp, stateDir: dir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') } };
  const s = JSON.parse(JSON.stringify(dashboardState(p as any, () => ({}))));
  assert.deepEqual(s.time.last24h, { share: 0.25, testRunMedian: 25 * S, gateMedian: 70 * S, gateP90: 70 * S });
  const today = at(now - H).slice(0, 10);
  assert.deepEqual(s.time.days.testRun, [{ day: today, ms: 25 * S }]);
  assert.deepEqual(s.time.days.gate, [{ day: today, ms: 70 * S }]);
});
