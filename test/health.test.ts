// The health pass: the pure checks over a snapshot, the runner with real git (a local bare origin) and fake gh,
// and `hx health [--fix]` end to end.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-h-'));
const stateFile = path.join(tmp, 'board.json');
const ghLog = path.join(tmp, 'gh.log');
Object.assign(process.env, { HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_GH_LOG: ghLog });

const { DEFAULTS, healthConfigError } = await import('../src/config.ts');
const H = await import('../src/health.ts');
type Snap = import('../src/health.ts').HealthSnapshot;

const L = DEFAULTS.labels;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const issue = (number: number, state: 'OPEN' | 'CLOSED', labels: string[] = []) => ({ number, title: `t${number}`, body: '', state, labels, author: 'me' });

function snap(o: Partial<Snap> = {}): Snap {
  return { issues: [], openPrs: [], mergedPrs: [], comments: new Map(), live: new Set(), worktrees: [], gateRuns: [], health: {},
    headSha: 'abc', now: NOW, config: { stallMinutes: 15, labels: L }, env: null, ...o };
}

// ---- pure checks ----

test('stale PR: issue closed, or another merged PR from issue/<N> → close with a comment; a live issue is skipped', E2E, () => {
  const s = snap({
    issues: [issue(5, 'CLOSED'), issue(6, 'OPEN'), issue(7, 'OPEN'), issue(8, 'CLOSED')],
    openPrs: [{ number: 91, headRefName: 'issue/5' }, { number: 92, headRefName: 'issue/6' }, { number: 93, headRefName: 'issue/7' }, { number: 94, headRefName: 'issue/8' }],
    mergedPrs: [{ number: 80, headRefName: 'issue/6' }],
    live: new Set([8]),
  });
  const { results, actions } = H.stalePrCheck(s, new Set());
  assert.deepEqual(actions.map((a: any) => [a.kind, a.pr, a.comment]), [
    ['close-pr', 91, '**hx:** closing — issue #5 is closed'],
    ['close-pr', 92, '**hx:** closing — issue #6 already has merged PR #80'],
  ]);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.mark === '✗'));
  assert.deepEqual(H.stalePrCheck(snap(), new Set()).results, [{ mark: '✓', text: 'stale PRs — none' }]);
});

test('stuck label: first seen → record, young → wait, older than stallMinutes → remove agent-working only; gone → forget', E2E, () => {
  const issues = [issue(3, 'OPEN', [L.ready, L.working]), issue(4, 'OPEN', [L.working])];
  const first = H.stuckLabelCheck(snap({ issues, live: new Set([4]) }), new Set());
  assert.deepEqual(first.actions, [{ kind: 'first-seen', issue: 3, at: new Date(NOW).toISOString() }]);
  assert.equal(first.results[0].mark, '✗');
  const at = new Date(NOW).toISOString();
  const young = H.stuckLabelCheck(snap({ issues, now: NOW + 10 * 60_000, health: { stuck: { 3: at } }, live: new Set([4]) }), new Set());
  assert.deepEqual(young.actions, []);
  assert.equal(young.results[0].mark, '✗');
  const old = H.stuckLabelCheck(snap({ issues, now: NOW + 16 * 60_000, health: { stuck: { 3: at } }, live: new Set([4]) }), new Set());
  assert.deepEqual(old.actions.map((a: any) => [a.kind, a.issue, a.label]), [['remove-label', 3, L.working]]);
  const gone = H.stuckLabelCheck(snap({ issues: [issue(3, 'OPEN', [L.ready])], health: { stuck: { 3: at } } }), new Set());
  assert.deepEqual(gone.actions, [{ kind: 'forget-seen', issue: 3 }]);
  assert.equal(gone.results[0].mark, '✓');
});

test('leftover worktree: only i/a/t/p<N>, N not open, older than 24 h', E2E, () => {
  const old = NOW - 25 * HOUR;
  const s = snap({
    issues: [issue(71, 'CLOSED'), issue(72, 'CLOSED'), issue(73, 'OPEN'), issue(74, 'CLOSED')],
    worktrees: [{ name: 'i71', mtimeMs: old }, { name: 'i72', mtimeMs: NOW - HOUR }, { name: 'i73', mtimeMs: old }, { name: 'gate', mtimeMs: old },
      { name: 'r1', mtimeMs: old }, { name: 'a74', mtimeMs: old }, { name: 'p75', mtimeMs: old }, { name: 'x9', mtimeMs: old }],
  });
  const { actions } = H.leftoverWorktreeCheck(s, new Set());
  assert.deepEqual(actions.map((a: any) => a.name), ['i71', 'a74', 'p75']);
});

test('environment: a failing doctor check and disk below 5 GB are ✗, with no action', E2E, () => {
  const env = { checks: [{ mark: '✓' as const, label: 'git', required: true }, { mark: '✗' as const, label: 'gh logged in', detail: 'not logged in', fix: 'gh auth login', required: true },
    { mark: '?' as const, label: 'GitHub origin', required: true }], freeBytes: 2 * 1024 ** 3 };
  const r = H.environmentCheck(snap({ env }), new Set());
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.results.map((x) => x.mark), ['✗', '✗']);
  assert.match(r.results[0].text, /gh logged in — not logged in/);
  assert.match(r.results[1].text, /2\.0 GB free .*below 5 GB/);
  const ok = H.environmentCheck(snap({ env: { checks: [], freeBytes: 50 * 1024 ** 3 } }), new Set());
  assert.equal(ok.results[0].mark, '✓');
});

test('seen: an issue an earlier check acted on is not looked at by a later one', E2E, () => {
  const s = snap({
    issues: [issue(5, 'OPEN', [L.working]), issue(6, 'CLOSED')],
    openPrs: [{ number: 92, headRefName: 'issue/5' }, { number: 93, headRefName: 'issue/6' }],
    mergedPrs: [{ number: 80, headRefName: 'issue/5' }],
    worktrees: [{ name: 'i6', mtimeMs: NOW - 48 * HOUR }],
  });
  const { actions } = H.runChecks(s);
  assert.deepEqual(actions.map((a: any) => [a.kind, a.pr ?? a.issue ?? a.name]), [['close-pr', 92], ['close-pr', 93]]);
  // the order has named slots for the checks added later
  assert.deepEqual(H.CHECKS.map((c) => c.name), ['stale-pr', 'blocked-after-pass', 'gate-fix', 'transient-block', 'stuck-label', 'leftover-worktree', 'environment']);
});

test('healthLine: k ✓ always; ✗, fixed and filed only when above 0', E2E, () => {
  assert.equal(H.healthLine([{ mark: '✓', text: 'a' }, { mark: '✓', text: 'b' }, { mark: '✓', text: 'c' },
    { mark: 'fixed', text: 'x', fix: 'closed stale PR #91' }, { mark: 'fixed', text: 'y', fix: 'removed worktree i71' },
    { mark: 'filed', text: 'z', fix: '#200' }]), 'health: 3 ✓ · fixed 2 (closed stale PR #91, removed worktree i71) · filed 1 (#200)');
  assert.equal(H.healthLine([{ mark: '✓', text: 'a' }, { mark: '✗', text: 'b' }]), 'health: 1 ✓ · 1 ✗');
  assert.equal(H.healthLine([]), 'health: 0 ✓');
});

test('config: selfHeal and healthEveryMinutes defaults and validation', E2E, () => {
  assert.equal(DEFAULTS.selfHeal, true);
  assert.equal(DEFAULTS.healthEveryMinutes, 60);
  assert.equal(healthConfigError({ selfHeal: false, healthEveryMinutes: 30 }), null);
  assert.equal(healthConfigError({}), null);
  assert.match(healthConfigError({ selfHeal: 'yes' })!, /selfHeal/);
  assert.match(healthConfigError({ healthEveryMinutes: 0 })!, /healthEveryMinutes/);
  assert.match(healthConfigError({ healthEveryMinutes: '60' })!, /healthEveryMinutes/);
});

// ---- the runner and the CLI: real git, fake gh ----

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let k = 0;
function repo() {
  const dir = path.join(tmp, `r${++k}`);
  mkdirSync(dir);
  const origin = path.join(dir, 'origin.git'), root = path.join(dir, 'app'), wt = path.join(dir, 'wt');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, root);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir);
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wt, selfHeal: false };
  return { root, wt, stateDir, config, project: { root, stateDir, config } };
}
const addWt = (root: string, wt: string, name: string, branch: string, ageMs: number, now: number) => {
  git(root, 'worktree', 'add', '-q', '-b', branch, path.join(wt, name), 'main');
  const t = new Date(now - ageMs);
  utimesSync(path.join(wt, name), t, t);
};
const board = (o: any) => writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], ...o }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const okEnv = async () => ({ checks: [], freeBytes: 100 * 1024 ** 3 });
const writes = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').split('\n')
  .filter((l) => /^(pr close|issue edit|issue comment|issue close|issue create|pr merge)/.test(l));

function fixture(now: number) {
  const r = repo();
  board({
    issues: [issue(5, 'CLOSED'), issue(6, 'OPEN'), issue(71, 'CLOSED'), issue(72, 'CLOSED'), issue(73, 'OPEN'), issue(9, 'OPEN', [L.ready, L.working])],
    prs: [{ number: 91, head: 'issue/5', state: 'OPEN' }, { number: 92, head: 'issue/6', state: 'OPEN' }, { number: 80, head: 'issue/6', state: 'MERGED' },
      { number: 95, head: 'feature/x', state: 'OPEN' }],
  });
  addWt(r.root, r.wt, 'i71', 'issue/71', 48 * HOUR, now);
  addWt(r.root, r.wt, 'i72', 'issue/72', HOUR, now);
  addWt(r.root, r.wt, 'i73', 'issue/73', 48 * HOUR, now);
  addWt(r.root, r.wt, 'gate', 'hx/gate', 48 * HOUR, now);
  // a worktree whose directory is gone: only `git worktree prune` drops it
  addWt(r.root, r.wt, 'i80', 'issue/80', 0, now);
  rmSync(path.join(r.wt, 'i80'), { recursive: true, force: true });
  rmSync(ghLog, { force: true });
  return r;
}

test('healthPass --fix: closes stale PRs (branch kept), removes only old leftover worktrees, prunes; a second pass repairs nothing', E2E, async () => {
  const r = fixture(NOW);
  const pass = await H.healthPass(r.project as any, { repairs: true, now: NOW, env: okEnv, live: new Set() });
  const s = read();
  const pr = (n: number) => s.prs.find((p: any) => p.number === n);
  assert.equal(pr(91).state, 'CLOSED');
  assert.equal(pr(92).state, 'CLOSED');
  assert.equal(pr(95).state, 'OPEN');
  assert.ok(!s.prs.some((p: any) => p.deletedBranch));
  assert.ok(!readFileSync(ghLog, 'utf8').includes('--delete-branch'));
  assert.deepEqual(s.comments.filter((c: any) => c.pr).map((c: any) => [c.pr, c.body]), [
    [91, '**hx:** closing — issue #5 is closed'], [92, '**hx:** closing — issue #6 already has merged PR #80']]);
  assert.ok(!existsSync(path.join(r.wt, 'i71')));
  assert.equal(git(r.root, 'branch', '--list', 'issue/71'), 'issue/71');
  for (const n of ['i72', 'i73', 'gate']) assert.ok(existsSync(path.join(r.wt, n)), n);
  assert.ok(!git(r.root, 'worktree', 'list', '--porcelain').includes('i80'));
  assert.match(pass.line, /fixed 3 \(closed stale PR #91, closed stale PR #92, removed worktree i71\)/);
  assert.ok(pass.results.some((x) => x.mark === 'fixed' && /closed stale PR #91/.test(x.text)));
  // the stuck label was only recorded
  assert.deepEqual(s.issues.find((i: any) => i.number === 9).labels, [L.ready, L.working]);
  const h = H.readHealth(r.stateDir);
  assert.equal(h.stuck?.['9'], new Date(NOW).toISOString());
  assert.deepEqual(h.last, { at: new Date(NOW).toISOString(), line: pass.line });
  assert.equal(pass.code, 1);

  rmSync(ghLog, { force: true });
  const again = await H.healthPass(r.project as any, { repairs: true, now: NOW + 60_000, env: okEnv, live: new Set() });
  assert.deepEqual(writes(), []);
  assert.ok(!again.results.some((x) => x.mark === 'fixed'), again.line);
});

test('healthPass: stuck agent-working is recorded, waits, then is released after stallMinutes; the entry is dropped; a live issue is skipped', E2E, async () => {
  const r = repo();
  board({ issues: [issue(9, 'OPEN', [L.ready, L.working]), issue(10, 'OPEN', [L.working])] });
  // issue 10 is in a session of a live runner (this process)
  writeFileSync(path.join(r.stateDir, 'live.json'), JSON.stringify({ pid: process.pid, startedAt: '', repo: 'me/app', workers: 1,
    sessions: [{ key: 'issue:10', number: 10, kind: 'impl', title: '', since: '', turn: 1, tokens: 0 }] }));
  const pass = (now: number) => H.healthPass(r.project as any, { repairs: true, now, env: okEnv });
  const labels = (n: number) => read().issues.find((i: any) => i.number === n).labels;

  const p1 = await pass(NOW);
  assert.ok(p1.results.some((x) => x.mark === '✗' && /#9 agent-working/.test(x.text)));
  assert.ok(!p1.results.some((x) => /#10/.test(x.text)));
  assert.deepEqual(Object.keys(H.readHealth(r.stateDir).stuck ?? {}), ['9']);
  await pass(NOW + 10 * 60_000);
  assert.deepEqual(labels(9), [L.ready, L.working]);
  const p3 = await pass(NOW + 16 * 60_000);
  assert.deepEqual(labels(9), [L.ready]);
  assert.deepEqual(labels(10), [L.working]);
  assert.match(p3.line, /fixed 1 \(released #9\)/);
  assert.deepEqual(H.readHealth(r.stateDir).stuck, {});
  // a pass without the label keeps no entry
  const p4 = await pass(NOW + 17 * 60_000);
  assert.deepEqual(H.readHealth(r.stateDir).stuck, {});
  assert.equal(p4.code, 0, p4.line);
});

test('healthPass: a failing environment is ✗ and files nothing', E2E, async () => {
  const r = repo();
  board({ issues: [] });
  rmSync(ghLog, { force: true });
  const p = await H.healthPass(r.project as any, { repairs: true, now: NOW, live: new Set(),
    env: async () => ({ checks: [{ mark: '✗', label: 'git', detail: 'not installed', required: true }], freeBytes: 1024 ** 3 }) });
  assert.equal(p.results.filter((x) => x.mark === '✗').length, 2);
  assert.equal(p.code, 1);
  assert.deepEqual(writes(), []);
  assert.deepEqual(read().issues, []);
});

const hx = (cwd: string, ...a: string[]) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'health', ...a],
  { cwd, encoding: 'utf8', env: { ...process.env, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '23.6.0' } });

test('hx health reports only; hx health --fix repairs with selfHeal false', E2E, () => {
  const now = Date.now();
  const r = fixture(now);
  writeFileSync(path.join(r.stateDir, 'config.json'), JSON.stringify({ repo: 'me/app', defaultBranch: 'main', worktreeRoot: r.wt,
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), selfHeal: false }));
  const report = hx(r.root);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.match(report.stdout, /✗ stale PR #91 — issue #5 is closed — would close PR #91/);
  assert.match(report.stdout, /✗ leftover worktree i71 .*would remove i71/);
  assert.match(report.stdout, /^health: \d+ ✓ · \d+ ✗$/m);
  assert.deepEqual(writes(), []);
  assert.ok(existsSync(path.join(r.wt, 'i71')));
  assert.equal(read().prs.find((p: any) => p.number === 91).state, 'OPEN');
  assert.equal(H.readHealth(r.stateDir).last?.line, report.stdout.trim().split('\n').at(-1));
  assert.ok(H.readHealth(r.stateDir).stuck?.['9']); // first-seen times are recorded in both modes

  const fix = hx(r.root, '--fix');
  assert.match(fix.stdout, /fixed closed stale PR #91/);
  assert.match(fix.stdout, /fixed removed worktree i71/);
  assert.equal(read().prs.find((p: any) => p.number === 91).state, 'CLOSED');
  assert.ok(!existsSync(path.join(r.wt, 'i71')));
});

test('hx health is in the help', E2E, () => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /health \[--fix\]/);
});
