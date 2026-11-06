// hx usage --machine [--days N] (#364, PRD #325): the four Machine parts and the recommendation, from fixture files in
// a temp .hx/ (load.jsonl, gate-runs.jsonl, run.log, usage.jsonl), over the last 24 h or --days N (1..7).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { docsText } from './docs-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-um-'));
const S = 1000, M = 60_000, H = 60 * M, D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const jsonl = (xs: any[]) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

/** A repo with workers 3 and, relative to `now`: 12 clock hours in the last 24 h (6 at target 2, 6 at target 3, two
 *  issues closed in each), 2 hours at target 1 two days back; green gate runs of 100 s three days back and 270 s in the
 *  last 24 h; impl sessions with 80% of their time in tests. */
function app(name: string, now: number): string {
  const root = path.join(tmp, name), sd = path.join(root, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', workers: 3, worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  const h0 = Math.floor(now / H) * H;
  const load: any[] = [], log: string[] = [];
  const hour = (start: number, target: number, done: number) => {
    for (const m of [10, 20, 40]) load.push({ ts: iso(start + m * M), cpuPct: 60, freeMemGB: 8, target, running: target, gate: false });
    for (let i = 0; i < done; i++) log.push(`${iso(start + (30 + i) * M)} [#${load.length + i}] DONE ✓ audited and merged PR #1`);
  };
  for (let k = 1; k <= 12; k++) hour(h0 - k * H, k <= 6 ? 3 : 2, 2);
  for (let k = 0; k < 2; k++) hour(h0 - 2 * D - k * H, 1, 1);
  writeFileSync(path.join(sd, 'load.jsonl'), jsonl(load));
  writeFileSync(path.join(sd, 'run.log'), log.join('\n') + '\n');
  const gate = (t: number, durationMs: number) => ({ ts: iso(t), sha: 'abc', ok: true, durationMs, timedOut: false });
  writeFileSync(path.join(sd, 'gate-runs.jsonl'), jsonl([
    ...Array.from({ length: 10 }, (_, i) => gate(now - 3 * D + i * M - H, 100 * S)),
    ...Array.from({ length: 3 }, (_, i) => gate(now - 2 * H - i * M, 270 * S)),
  ]));
  const rec = (t: number) => ({ ts: iso(t), issue: 1, role: 'impl', sessionId: `s-${t}`, iteration: 1, model: 'm', ok: true,
    usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs: 10 * M, numTurns: 1, testMs: 8 * M, testRuns: 1, testFailedRuns: 0 });
  writeFileSync(path.join(sd, 'usage.jsonl'), jsonl([rec(now - 3 * H), rec(now - 4 * H)]));
  return root;
}
function hx(cwd: string, ...args: string[]) {
  const b = path.join(tmp, `board-${path.basename(cwd)}.json`);
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
}
const part = (out: string, title: string) => {
  const at = out.indexOf(title);
  assert.ok(at >= 0, `${title} in\n${out}`);
  const end = out.indexOf('\n\n', at);
  return out.slice(at, end < 0 ? undefined : end);
};
const row = (sec: string, key: string) => sec.split('\n').find((l) => l.trim().split(/\s+/)[0] === key)?.trim();

test('hx usage --machine: the four parts and the recommendation with its rule, over the last 24 h', E2E, () => {
  const root = app('day', Date.now());
  const r = hx(root, 'usage', '--machine');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout.replace(/\r\n/g, '\n');
  assert.match(out, /^Machine — last 24 h \(.* UTC\) · workers 3$/m);
  const use = part(out, '1. Use');
  assert.match(use, /CPU average 60% · p90 60%/);
  assert.equal(use.split('\n').filter((l) => /^\s+\d{4}-\d\d-\d\d \d\d:00 /.test(l)).length, 12, use);
  assert.match(use, /^\s+\d{4}-\d\d-\d\d \d\d:00\s+60%\s+8\.0 GB\s+3\s+3$/m);
  const tp = part(out, '2. Throughput by worker count');
  assert.equal(row(tp, '1'), undefined, 'the target-1 hours are two days back');
  assert.match(row(tp, '2')!, /^2\s+2\.00\s+6$/);
  assert.match(row(tp, '3')!, /^3\s+2\.00\s+6$/);
  assert.match(part(out, '3. Slowdown'), /tests run 2\.7× slower than at idle \(median gate 4m30s, idle baseline 1m40s\)/);
  const ses = part(out, '4. Where session time goes');
  assert.match(row(ses, 'impl')!, /^impl\s+2\s+80%\s+20%$/);
  assert.match(out, /^Recommendation: 3 workers get about as much done as 2 here; set `workers` to 2$/m);
  assert.match(out, /^\s+rule A: two worker counts each have at least 6 h of data/m);
});

test('hx usage --machine --days 3 widens the period', E2E, () => {
  const root = app('days3', Date.now());
  const r = hx(root, 'usage', '--machine', '--days', '3');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout.replace(/\r\n/g, '\n');
  assert.match(out, /^Machine — last 3 days \(/m);
  const use = part(out, '1. Use');
  assert.equal(use.split('\n').filter((l) => /^\s+\d{4}-\d\d-\d\d \d\d:00 /.test(l)).length, 14, use);
  // the two target-1 hours two days back now count, under 3 h: not enough data
  assert.match(row(part(out, '2. Throughput by worker count'), '1')!, /^1\s+not enough data\s+2$/);
  // the 100 s runs three days back are still outside; the median stays 270 s
  assert.match(part(out, '3. Slowdown'), /tests run 2\.7× slower/);
});

test('hx usage --machine: a missing or invalid --days is a usage error', E2E, () => {
  const root = app('bad', Date.now());
  for (const v of [[], ['0'], ['8'], ['x'], ['2.5'], ['-1']]) {
    const r = hx(root, 'usage', '--machine', '--days', ...v);
    assert.equal(r.status, 2, `--days ${v.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: hx usage --machine \[--days N\]  \(N: a whole number from 1 to 7/);
    assert.equal(r.stdout, '');
  }
});

test('hx usage --machine: an empty .hx/ prints a plain note in each part and "fits"', E2E, () => {
  const root = path.join(tmp, 'empty'), sd = path.join(root, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-empty') } as any);
  const r = hx(root, 'usage', '--machine');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const w of ['no load recorded in this period', 'no idle baseline yet', 'no session with test time recorded',
    'Recommendation: the current setting fits this machine', 'rule fits:']) assert.ok(r.stdout.includes(w), w);
});

test('hx help lists usage --machine [--days N] next to the other usage lines', () => {
  const h = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' }).stdout;
  assert.match(h, /usage --tests[^\n]*\n\s+usage --machine \[--days N\]/);
});

test('docs: Where the time goes says what each hx usage --machine number means', () => {
  const g = readFileSync(path.join(here, '..', 'docs', 'guide.md'), 'utf8');
  const at = g.indexOf('## Where the time goes');
  const sec = g.slice(at, g.indexOf('\n## ', at + 1));
  for (const w of ['hx usage --machine', '--days N', '.hx/load.jsonl', 'CPU average', 'CPU p90', 'free memory', 'target', 'running',
    'issues closed per hour', 'not enough data', 'idle baseline', 'p10', 'tests run 2.7× slower than at idle', 'outside tests',
    'rule A', 'rule B', 'fits', 'at least 6 hours', 'less than 10% more', '80%', 'below 50%', '1.5×']) assert.ok(sec.includes(w), w);
  assert.ok(docsText().includes('hx usage --machine [--days'), 'listed with the other usage commands');
});
