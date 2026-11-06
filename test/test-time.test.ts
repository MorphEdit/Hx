// Test time in hx usage (--by columns, --tests) and the time line in hx status (PRD #182 D.9, D.10): testSeries and
// timeWindow in src/timing.ts, and the commands run on fixture usage records and gate lines.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testSeries, timeWindow } from '../src/timing.ts';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tt-'));
const S = 1000, M = 60_000;

const rec = (ts: string, role: string, durationMs: number, t?: { testMs: number; testRuns: number }) => ({ ts, issue: 1, role, sessionId: `s-${ts}-${role}`,
  iteration: 1, model: 'm', ok: true, usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs, numTurns: 1,
  ...(t ? { testMs: t.testMs, testRuns: t.testRuns, testFailedRuns: 0 } : {}) });
const gate = (ts: string, durationMs: number) => ({ ts, sha: 'abc', ok: true, durationMs, timedOut: false });

function app(name: string, recs: any[], gates: any[]) {
  const root = path.join(tmp, name), sd = path.join(root, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  if (recs.length) writeFileSync(path.join(sd, 'usage.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  if (gates.length) writeFileSync(path.join(sd, 'gate-runs.jsonl'), gates.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return root;
}
function hx(cwd: string, ...args: string[]): string {
  const b = path.join(tmp, `board-${path.basename(cwd)}.json`);
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const cells = (out: string, key: string) => out.split(/\r?\n/).find((l) => l.split(/\s+/)[0] === key)?.trim().split(/\s+/) ?? [];

test('testSeries: median and p90 per UTC day, days without data left out, oldest first', E2E, () => {
  const recs = [
    rec('2026-11-03T23:30:00Z', 'impl', 10 * M, { testMs: 120 * S, testRuns: 2 }), // 60s per run
    rec('2026-11-03T01:00:00Z', 'impl', 10 * M, { testMs: 30 * S, testRuns: 1 }),
    rec('2026-11-03T02:00:00Z', 'impl', 10 * M, { testMs: 90 * S, testRuns: 1 }),
    rec('2026-11-03T03:00:00Z', 'impl', 10 * M, { testMs: 0, testRuns: 0 }), // no run: no duration
    rec('2026-11-02T10:00:00Z', 'impl', 10 * M), // old record: unknown
    rec('2026-11-05T10:00:00Z', 'impl', 10 * M, { testMs: 0, testRuns: 0 }), // a day with only empty runs: omitted
  ];
  const gates = [gate('2026-11-04T00:10:00Z', 100 * S), gate('2026-11-01T05:00:00Z', 200 * S), gate('2026-11-01T06:00:00Z', 400 * S)];
  assert.deepEqual(testSeries(recs as any, gates), [
    { day: '2026-11-01', testRunMedian: undefined, testRunP90: undefined, gateMedian: 200 * S, gateP90: 400 * S },
    { day: '2026-11-03', testRunMedian: 60 * S, testRunP90: 90 * S, gateMedian: undefined, gateP90: undefined },
    { day: '2026-11-04', testRunMedian: undefined, testRunP90: undefined, gateMedian: 100 * S, gateP90: 100 * S },
  ]);
  assert.deepEqual(testSeries([], []), []);
});

test('timeWindow: share over the records with testMs, median test run, gate median and p90; nothing outside the window', E2E, () => {
  const from = Date.parse('2026-11-03T00:00:00Z'), to = Date.parse('2026-11-04T00:00:00Z');
  const recs = [rec('2026-11-03T01:00:00Z', 'impl', 100 * S, { testMs: 30 * S, testRuns: 1 }), rec('2026-11-03T02:00:00Z', 'impl', 100 * S, { testMs: 10 * S, testRuns: 2 }),
    rec('2026-11-03T03:00:00Z', 'impl', 1000 * S), rec('2026-11-02T03:00:00Z', 'impl', 1 * S, { testMs: 1 * S, testRuns: 1 })];
  const gates = [gate('2026-11-03T05:00:00Z', 60 * S), gate('2026-11-03T06:00:00Z', 120 * S), gate('2026-11-04T06:00:00Z', 999 * S)];
  assert.deepEqual(timeWindow(recs as any, gates, from, to), { share: 0.2, testRunMedian: 5 * S, gateMedian: 60 * S, gateP90: 120 * S, hasData: true });
  assert.deepEqual(timeWindow([rec('2026-11-03T03:00:00Z', 'impl', 5 * S)] as any, [], from, to),
    { share: undefined, testRunMedian: undefined, gateMedian: undefined, gateP90: undefined, hasData: false });
});

test('hx usage --by role: test, test % and runs columns; a group of old records only shows -, not 0', E2E, () => {
  const root = app('by-role', [
    rec('2026-11-03T01:00:00Z', 'impl', 10 * M, { testMs: 2 * M, testRuns: 3 }),
    rec('2026-11-03T02:00:00Z', 'impl', 10 * M, { testMs: 3 * M, testRuns: 1 }),
    rec('2026-11-03T03:00:00Z', 'impl', 30 * M), // no testMs: not in the share
    rec('2026-11-03T04:00:00Z', 'review', 5 * M),
  ], []);
  const out = hx(root, 'usage', '--by', 'role');
  assert.deepEqual(cells(out, 'by').slice(-4), ['test', 'test', '%', 'runs'], out);
  assert.deepEqual(cells(out, 'impl').slice(-3), ['5m', '25%', '4'], out);
  assert.deepEqual(cells(out, 'review').slice(-3), ['-', '-', '-'], out);
  assert.deepEqual(cells(out, 'TOTAL').slice(-3), ['5m', '25%', '4'], out);
});

test('hx usage --tests: one row per UTC day, oldest first, - for a missing part', E2E, () => {
  const root = app('tests', [
    rec('2026-11-03T01:00:00Z', 'impl', 10 * M, { testMs: 30 * S, testRuns: 1 }),
    rec('2026-11-03T02:00:00Z', 'impl', 10 * M, { testMs: 90 * S, testRuns: 1 }),
    rec('2026-11-03T03:00:00Z', 'impl', 10 * M, { testMs: 240 * S, testRuns: 2 }),
    rec('2026-11-02T03:00:00Z', 'impl', 10 * M), // no data: day omitted
  ], [gate('2026-11-01T05:00:00Z', 200 * S), gate('2026-11-01T06:00:00Z', 400 * S), gate('2026-11-03T06:00:00Z', 65 * S)]);
  const rows = hx(root, 'usage', '--tests').split(/\r?\n/).filter((l) => /^\d{4}-/.test(l)).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rows, [['2026-11-01', '-', '-', '3m20s', '6m40s'], ['2026-11-03', '1m30s', '2m', '1m05s', '1m05s']]);
});

test('hx status: the time line over the last 24 h, - for a missing part, no line without data in the last 24 h', E2E, () => {
  const ago = (min: number) => new Date(Date.now() - min * M).toISOString();
  const old = ago(25 * 60);
  const full = app('status-full', [rec(ago(30), 'impl', 10 * M, { testMs: 4 * M, testRuns: 2 }), rec(old, 'impl', 10 * M, { testMs: 10 * M, testRuns: 1 })],
    [gate(ago(20), 185 * S), gate(ago(10), 280 * S), gate(old, 999 * S)]);
  assert.match(hx(full, 'status'), /^time {5}tests 40% of session time · median test run 2m · gate 3m05s \(p90 4m40s\)$/m);
  const noGate = app('status-nogate', [rec(ago(30), 'impl', 10 * M, { testMs: 130 * S, testRuns: 1 })], []);
  assert.match(hx(noGate, 'status'), /^time {5}tests 22% of session time · median test run 2m10s · gate - \(p90 -\)$/m);
  const onlyGate = app('status-gate', [rec(ago(30), 'impl', 10 * M)], [gate(ago(5), 60 * S)]);
  assert.match(hx(onlyGate, 'status'), /^time {5}tests - of session time · median test run - · gate 1m \(p90 1m\)$/m);
  const stale = app('status-stale', [rec(old, 'impl', 10 * M, { testMs: M, testRuns: 1 }), rec(ago(5), 'impl', 10 * M)], [gate(old, 60 * S)]);
  assert.doesNotMatch(hx(stale, 'status'), /^time /m);
});

test('reused gate lines (#352) are left out of the gate median and p90: timeWindow, testSeries, hx usage --tests, hx status', E2E, () => {
  const reused = (ts: string) => ({ ...gate(ts, 0), reused: true });
  const from = Date.parse('2026-11-03T00:00:00Z'), to = Date.parse('2026-11-04T00:00:00Z');
  const gates = [gate('2026-11-03T05:00:00Z', 60 * S), reused('2026-11-03T05:30:00Z'), reused('2026-11-03T05:40:00Z'), gate('2026-11-03T06:00:00Z', 120 * S)];
  assert.deepEqual(timeWindow([], gates, from, to), { share: undefined, testRunMedian: undefined, gateMedian: 60 * S, gateP90: 120 * S, hasData: true });
  assert.equal(timeWindow([], [reused('2026-11-03T05:30:00Z')], from, to).hasData, false, 'only reused lines: no gate data');
  assert.deepEqual(testSeries([], [...gates, reused('2026-11-02T01:00:00Z')]),
    [{ day: '2026-11-03', testRunMedian: undefined, testRunP90: undefined, gateMedian: 60 * S, gateP90: 120 * S }]);
  const root = app('tests-reused', [], [gate('2026-11-01T05:00:00Z', 200 * S), reused('2026-11-01T05:10:00Z'), reused('2026-11-01T05:20:00Z'), gate('2026-11-01T06:00:00Z', 400 * S)]);
  const rows = hx(root, 'usage', '--tests').split(/\r?\n/).filter((l) => /^\d{4}-/.test(l)).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rows, [['2026-11-01', '-', '-', '3m20s', '6m40s']]);
  const ago = (min: number) => new Date(Date.now() - min * M).toISOString();
  const st = app('status-reused', [rec(ago(30), 'impl', 10 * M)], [gate(ago(30), 185 * S), reused(ago(25)), reused(ago(15)), gate(ago(10), 280 * S)]);
  assert.match(hx(st, 'status'), /^time {5}.*gate 3m05s \(p90 4m40s\)$/m);
});
