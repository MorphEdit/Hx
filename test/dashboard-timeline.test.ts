// The Timeline in the dashboard state (#371, PRD #367): `timeline` from a fixture .hx/'s usage.jsonl, live.json's sessions,
// gate-runs.jsonl and run.log; `runner.testConcurrency` (null when live.json has none) and `runner.cpus`.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardState } from '../src/dashboard.ts';
import { DEFAULTS } from '../src/config.ts';

const ms = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();
const iso = (h: number, m = 0) => new Date(ms(h, m)).toISOString();
const NOW = ms(15);
const MIN = 60_000;
const u = { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 };

function fixture(extraLive: object) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-dtl-'));
  const stateDir = path.join(tmp, '.hx');
  mkdirSync(stateDir);
  const rec = (issue: number, role: string, sessionId: string, ts: string, durationMs: number) =>
    JSON.stringify({ ts, issue, role, sessionId, iteration: 1, model: 'm', ok: true, usage: u, costUsd: 0, durationMs, numTurns: 1 });
  writeFileSync(path.join(stateDir, 'usage.jsonl'), [
    rec(4, 'impl', 'a', iso(10, 30), 20 * MIN),
    rec(4, 'impl', 'a', iso(11), 25 * MIN),
    rec(5, 'impl', 'b', iso(8), 10 * MIN),                // before the 6 h window
  ].join('\n') + '\n');
  writeFileSync(path.join(stateDir, 'gate-runs.jsonl'), [
    JSON.stringify({ ts: iso(11, 30), sha: 'abc', ok: true, durationMs: 5 * MIN, timedOut: false }),
    JSON.stringify({ ts: iso(12, 30), sha: 'def', ok: false, durationMs: 5 * MIN, timedOut: false }),
  ].join('\n') + '\n');
  writeFileSync(path.join(stateDir, 'run.log'), [`${iso(13)} [#7] impl: T`, `${iso(13, 30)} [#7] audit 1/3: PR #9`].join('\n') + '\n');
  writeFileSync(path.join(stateDir, 'live.json'), JSON.stringify({ pid: process.pid, startedAt: iso(9), repo: 'me/app', workers: 3, draining: false,
    sessions: [{ key: 'issue:7', number: 7, kind: 'impl', title: 'T', since: iso(13), turn: 1, tokens: 0 }], ...extraLive }));
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') };
  return dashboardState({ root: tmp, stateDir, config } as any, () => ({}), NOW) as any;
}

test('dashboardState carries the timeline, runner.testConcurrency and runner.cpus', E2E, () => {
  const s = fixture({ testConcurrency: 2 });
  assert.deepEqual(s.timeline, {
    from: ms(9), to: NOW, lanes: [
      { worker: 'W1', bars: [
        { issue: 4, role: 'impl', startMs: ms(10, 10), endMs: ms(11) },
        { issue: 7, role: 'audit', startMs: ms(13), endMs: NOW, running: true }, // the live impl session at its audit stage
      ] },
      { worker: 'gate', bars: [
        { issue: null, role: 'gate', startMs: ms(11, 25), endMs: ms(11, 30), ok: true },
        { issue: null, role: 'gate', startMs: ms(12, 25), endMs: ms(12, 30), ok: false },
      ] },
    ],
  });
  assert.equal(s.runner.testConcurrency, 2);
  assert.equal(s.runner.cpus, os.availableParallelism());
  assert.ok(s.runner.cpus >= 1);
});

test('runner.testConcurrency is null when live.json has none', E2E, () => {
  assert.equal(fixture({}).runner.testConcurrency, null);
});
