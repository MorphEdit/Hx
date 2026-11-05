// Model mismatches made visible: parseOutcomes' modelMismatch, the dashboard's stats payload (and byModel on the
// model that ran), the hx status line, and the docs. Fake gh for hx status.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsText } from './docs-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-mm-'));
const { parseOutcomes } = await import('../src/outcomes.ts');
const { dashboardState } = await import('../src/dashboard.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { mismatchedSessions } = await import('../src/usage.ts');

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';
const u = (n: number) => ({ input: n, cacheWrite: 0, cacheRead: 0, output: 0 });
const rec = (sessionId: string, role: string, model: string, actualModel: string | undefined, tokens = 10, iteration = 1) =>
  ({ ts: '2026-10-01T10:00:00Z', issue: 1, role, sessionId, iteration, model, ...(actualModel ? { actualModel } : {}), ok: true,
    usage: u(tokens), costUsd: 0, durationMs: 100, numTurns: 1 });
const write = (dir: string, recs: object[]) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'usage.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

test('parseOutcomes: a session with two mismatched turns logs one line and counts 1; a log without one counts 0', E2E, () => {
  const log = [
    '2026-10-31T10:00:00.000Z [#5] impl: task',
    '2026-10-31T10:01:00.000Z [#5] model mismatch: impl asked claude-opus-5-5, ran claude-sonnet-5-5',
    '2026-10-31T10:30:00.000Z [#5] impl DONE ✓ (30m, 10k tokens)',
  ];
  assert.equal(parseOutcomes(log).modelMismatch, 1);
  assert.equal(parseOutcomes(log.filter((l) => !l.includes('mismatch'))).modelMismatch, 0);
  assert.equal(parseOutcomes([]).modelMismatch, 0);
});

test('mismatchedSessions: distinct sessions with a non-checkpoint turn whose actualModel fails modelMatches', E2E, () => {
  assert.equal(mismatchedSessions([rec('a', 'impl', OPUS, SONNET), rec('a', 'impl', OPUS, SONNET, 10, 2)] as any), 1);
  assert.equal(mismatchedSessions([rec('a', 'impl', OPUS, `${OPUS}-20261001`), rec('b', 'audit', 'opus', OPUS)] as any), 0, 'matching');
  assert.equal(mismatchedSessions([rec('c', 'checkpoint', OPUS, SONNET)] as any), 0, 'checkpoint only');
  assert.equal(mismatchedSessions([rec('d', 'impl', OPUS, undefined)] as any), 0, 'no actualModel');
  assert.equal(mismatchedSessions([rec('a', 'impl', OPUS, SONNET), rec('b', 'audit', OPUS, SONNET)] as any), 2);
});

test('dashboard stats payload: outcomes.modelMismatch, and byModel keyed on actualModel when present', E2E, () => {
  const sd = path.join(tmp, 'dash', '.hx');
  write(sd, [rec('a', 'impl', OPUS, SONNET, 10), rec('a', 'impl', OPUS, SONNET, 20, 2), rec('b', 'audit', OPUS, undefined, 5)]);
  writeFileSync(path.join(sd, 'run.log'), '2026-10-31T10:01:00.000Z [#1] model mismatch: impl asked claude-opus-5-5, ran claude-sonnet-5-5\n');
  const p = { root: path.dirname(sd), stateDir: sd, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main' } };
  const s = dashboardState(p as any, () => ({}) as any) as any;
  assert.equal(s.outcomes.modelMismatch, 1);
  const byModel = Object.fromEntries(s.usage.byModel.map((r: any) => [r.key, r.tokens]));
  assert.deepEqual(byModel, { [SONNET]: 30, [OPUS]: 5 });
});

test('hx status: one mismatched session (two turns) prints the line; matching, checkpoint-only or actualModel-less records do not', E2E, () => {
  const app = path.join(tmp, 'status-app');
  const sd = path.join(app, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') } as any);
  const b = path.join(tmp, 'board.json');
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const hx = () => {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8',
      env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  write(sd, [rec('a', 'impl', OPUS, SONNET), rec('a', 'impl', OPUS, SONNET, 10, 2)]);
  assert.match(hx(), /^model mismatch: 1 session\(s\) — see run\.log$/m);
  for (const [why, recs] of [
    ['matching', [rec('a', 'impl', OPUS, OPUS), rec('b', 'audit', OPUS, `${OPUS}-20261001`)]],
    ['checkpoint only', [rec('c', 'checkpoint', OPUS, SONNET)]],
    ['no actualModel', [rec('d', 'impl', OPUS, undefined)]],
  ] as const) {
    write(sd, recs as any);
    assert.doesNotMatch(hx(), /mismatch/, why);
  }
});

test('docs: README shows how to spot a mismatch; design.md records per-role models as opt-in with the mismatch guard', E2E, () => {
  const r = docsText();
  for (const w of ['model mismatch: <role> asked', 'model mismatch: N session(s) — see run.log', 'hx status', '**model mismatch** row']) assert.ok(r.includes(w), w);
  const d = readFileSync(path.join(here, '..', 'docs', 'design.md'), 'utf8');
  assert.match(d, /## Models per role/);
  for (const w of ['opt-in', 'benchmark', 'mismatch']) assert.ok(d.includes(w), w);
});
