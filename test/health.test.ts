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

test('gate-fix: two green at the head → close; red last or no runs → ✓; otherwise → ask for a gate run', E2E, () => {
  const run = (sha: string, ok: boolean) => ({ ts: '', sha, ok, durationMs: 1, timedOut: false });
  const issues = [issue(50, 'OPEN', [L.gateFix]), issue(51, 'CLOSED', [L.gateFix]), issue(52, 'OPEN')];
  const check = (gateRuns: any[], o: Partial<Snap> = {}) => H.gateFixCheck(snap({ issues, gateRuns, headSha: 'head', ...o }), new Set());
  const two = check([run('old', false), run('head', true), run('head', true)]);
  assert.deepEqual(two.actions.map((a: any) => [a.kind, a.issue]), [['close-issue', 50]]);
  assert.match((two.actions[0] as any).comment, /^\*\*hx:\*\* closing as not planned — the last two gate runs are green at head/);
  for (const runs of [[], [run('head', false)], [run('head', true), run('head', false)], [run('old', true), run('old', true), run('old', false)]]) {
    const r = check(runs);
    assert.deepEqual(r.actions, [], JSON.stringify(runs));
    assert.deepEqual(r.results.map((x) => x.mark), ['✓']);
  }
  for (const runs of [[run('head', true)], [run('head', false), run('head', true)], [run('old', true), run('head', true)], [run('old', true), run('old', true)]]) {
    const r = check(runs);
    assert.deepEqual(r.actions.map((a: any) => [a.kind, a.issue]), [['request-gate', 50]], JSON.stringify(runs));
    assert.deepEqual(r.results.map((x) => [x.mark, x.text]), [['✗', 'gate-fix #50 — waiting for a second green gate run']]);
  }
  // a live gate-fix session is skipped; no gate-fix issue → ✓ none
  assert.deepEqual(check([run('head', true), run('head', true)], { live: new Set([50]) }).actions, []);
  assert.deepEqual(H.gateFixCheck(snap(), new Set()).results, [{ mark: '✓', text: 'gate-fix issues — none' }]);
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
  assert.deepEqual(H.CHECKS.map((c) => c.name), ['stale-pr', 'blocked-after-pass', 'gate-fix', 'transient-block', 'leftover-worktree', 'stuck-label', 'environment']);
});

test('order: leftover worktrees run before stuck labels (PRD §B), so the worktree check claims its issue first', E2E, () => {
  const s = snap({
    issues: [issue(3, 'CLOSED'), issue(4, 'OPEN', [L.working])],
    worktrees: [{ name: 'i3', mtimeMs: NOW - 48 * HOUR }],
    health: { stuck: { 3: new Date(NOW - HOUR).toISOString() } },
  });
  const r = H.runChecks(s);
  assert.deepEqual(r.actions.map((a: any) => `${a.kind}:${a.issue ?? a.name}`), ['remove-worktree:i3', 'first-seen:4']);
  const wt = r.results.findIndex((x) => /leftover worktree i3/.test(x.text));
  const st = r.results.findIndex((x) => /#4 /.test(x.text));
  assert.ok(wt >= 0 && st > wt, 'the leftover-worktree line comes before the stuck-label line');
});

test('stuck label: a first-seen time that is not a date is recorded again, not left at NaN', E2E, () => {
  const r = H.stuckLabelCheck(snap({ issues: [issue(3, 'OPEN', [L.working])], health: { stuck: { 3: 'garbage' } } }), new Set());
  assert.deepEqual(r.actions.map((a: any) => a.kind), ['first-seen']);
  assert.doesNotMatch(r.results[0].text, /NaN/);
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

// ---- blocked issues: resume after a passed audit, unblock transient errors, file health: issues (#237) ----

const AUDIT_PASS = (pr: number) => `<!-- hx-audit -->\n**hx audit 1/2: PASS ✓** (PR #${pr})\n\nall criteria met`;
const AUDIT_FAIL = (pr: number) => `<!-- hx-audit -->\n**hx audit 2/2: FAIL ✗** (PR #${pr})\n\nmissing test`;
const STOP = (reason: string) => `**hx:** impl stopped — ${reason} (12k tokens).\n\nLast reply:\n\n> working on it, API 529 earlier\n\nWork is on branch \`issue/7\` if it was pushed. Remove the \`agent-blocked\` label to let hx try again.`;
const blockedIssue = (n: number) => issue(n, 'OPEN', [L.blocked]);

test('blocked after PASS: MERGEABLE → resume, CONFLICTING → send back, UNKNOWN → wait; no PR or a failed last audit → not this check', E2E, () => {
  const s = snap({
    issues: [blockedIssue(1), blockedIssue(2), blockedIssue(3), blockedIssue(4), blockedIssue(5)],
    openPrs: [{ number: 11, headRefName: 'issue/1', mergeable: 'MERGEABLE' }, { number: 12, headRefName: 'issue/2', mergeable: 'CONFLICTING' },
      { number: 13, headRefName: 'issue/3', mergeable: 'UNKNOWN' }, { number: 15, headRefName: 'issue/5', mergeable: 'MERGEABLE' }],
    comments: new Map([[1, [AUDIT_PASS(11), STOP('merging the audited PR failed: boom')]], [2, [AUDIT_PASS(12)]], [3, [AUDIT_PASS(13)]],
      [4, [AUDIT_PASS(14)]], [5, [AUDIT_PASS(15), AUDIT_FAIL(15)]]]),
  });
  const seen = new Set<number>();
  const r = H.blockedAfterPassCheck(s, seen);
  assert.deepEqual(r.actions.map((a: any) => [a.kind, a.issue, a.pr]), [['resume', 1, 11], ['send-back', 2, undefined]]);
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every((x) => x.mark === '✗'));
  assert.match(r.results[2].text, /#3 .*PR #13 mergeable is UNKNOWN, waiting/);
  assert.deepEqual([...seen], [1, 2, 3]);
  assert.deepEqual(H.blockedAfterPassCheck(snap(), new Set()).results, [{ mark: '✓', text: 'blocked after a passed audit — none' }]);
});

test('blocked after PASS with a resume comment already: files one health: issue, never when its marker exists (open or closed)', E2E, () => {
  const base = { openPrs: [{ number: 11, headRefName: 'issue/1', mergeable: 'MERGEABLE' }],
    comments: new Map([[1, [AUDIT_PASS(11), `${H.RESUME_MARKER}\n**hx:** the audit passed, but …`, STOP('merging the audited PR failed: x')]]]) };
  const r = H.blockedAfterPassCheck(snap({ issues: [blockedIssue(1)], ...base }), new Set());
  assert.equal(r.actions.length, 1);
  const a: any = r.actions[0];
  assert.equal(a.kind, 'file');
  assert.equal(a.key, 'resume:1');
  assert.match(a.title, /^health: /);
  assert.ok(a.body.includes('<!-- hx:health resume:1 -->'));
  for (const state of ['OPEN', 'CLOSED'] as const) {
    const filed = { ...issue(40, state, [L.bug]), body: 'x\n<!-- hx:health resume:1 -->' };
    const again = H.blockedAfterPassCheck(snap({ issues: [blockedIssue(1), filed], ...base }), new Set());
    assert.deepEqual(again.actions, [], state);
    assert.equal(again.results[0].mark, '✗');
  }
});

test('transient: each pattern unblocks once with an unblock <time> comment; a failed merge, NEEDS-INFO and other reasons are no finding', E2E, () => {
  const reasons = ['stalled: no output for 15 min', 'agent error: turn timed out after 60 min', 'agent error: claude exited 1 with no result: x',
    'agent error: API 429: slow down', 'agent error: API 503: overloaded', 'agent error: Rate limit reached'];
  const issues = reasons.map((_, i) => blockedIssue(i + 1));
  const comments = new Map(reasons.map((r, i) => [i + 1, [STOP(r)]]));
  const r = H.transientBlockCheck(snap({ issues, comments }), new Set());
  assert.deepEqual(r.actions.map((a: any) => a.issue), [1, 2, 3, 4, 5, 6]);
  const a: any = r.actions[2];
  assert.equal(a.kind, 'unblock');
  assert.ok(a.comment.startsWith(`<!-- hx:health unblock ${new Date(NOW).toISOString()} -->\n`), a.comment);
  assert.match(a.comment, /claude exited 1 with no result/);
  assert.doesNotMatch(a.comment, /Last reply/);

  const quiet = H.transientBlockCheck(snap({
    issues: [blockedIssue(1), blockedIssue(2), blockedIssue(3), blockedIssue(4), blockedIssue(5)],
    comments: new Map([
      [1, [STOP('merging the audited PR failed: ship: tests failed — API rate limit exceeded')]],
      [2, ['NEEDS-INFO: which version?', '**hx:** triage: NEEDS-INFO']],
      [3, [STOP('still not passing after 2 audit round(s); last findings: x')]],
      [4, [STOP('the implementer reported ready but no open PR for its branch exists')]],
      [5, [STOP('stalled: no output for 15 min'), 'a human comment after it']],
    ]) }), new Set());
  assert.deepEqual(quiet, { results: [{ mark: '✓', text: 'blocked by a transient error — none' }], actions: [] });
});

test('transient: an unblock comment < 24 h old → ✗, nothing done or filed; > 24 h old → unblocked again', E2E, () => {
  const unblock = (h: number) => `<!-- hx:health unblock ${new Date(NOW - h * HOUR).toISOString()} -->\n**hx:** unblocked — x`;
  const young = H.transientBlockCheck(snap({ issues: [blockedIssue(3)], comments: new Map([[3, [STOP('stalled: no output'), unblock(23), STOP('claude exited 1 with no result')]]]) }), new Set());
  assert.deepEqual(young.actions, []);
  assert.equal(young.results[0].mark, '✗');
  const old = H.transientBlockCheck(snap({ issues: [blockedIssue(3)], comments: new Map([[3, [unblock(25), STOP('claude exited 1 with no result')]]]) }), new Set());
  assert.deepEqual(old.actions.map((a: any) => [a.kind, a.issue]), [['unblock', 3]]);
});

test('overlap: open PR + last audit PASS + a stalled stop → only blocked-after-PASS acts; no unblock', E2E, () => {
  const s = snap({ issues: [blockedIssue(7)], openPrs: [{ number: 17, headRefName: 'issue/7', mergeable: 'MERGEABLE' }],
    comments: new Map([[7, [AUDIT_PASS(17), STOP('stalled: no output for 15 min')]]]) });
  assert.deepEqual(H.runChecks(s).actions.map((a: any) => a.kind), ['resume']);
  // and the transient check on its own (no seen set) still leaves it alone
  assert.deepEqual(H.transientBlockCheck(s, new Set()).actions, []);
});

// the runner: real git for the branch and ship.mjs, the fake gh for the board
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const OK_TEST = 'node -e "process.exit(0)"';

/** issue/<n> pushed with one commit (a.txt), an open PR for it, the issue blocked after a passed audit. */
function blockedRepo(n: number, o: { mergeable?: string; test?: string; extra?: string[] } = {}) {
  const r = repo();
  (r.config as any).gateCommand = o.test ?? OK_TEST;
  git(r.root, 'checkout', '-q', '-b', `issue/${n}`);
  writeFileSync(path.join(r.root, 'a.txt'), 'mine\n');
  git(r.root, 'add', 'a.txt'); git(r.root, 'commit', '-q', '-m', 'feat: thing');
  git(r.root, 'push', '-q', 'origin', `HEAD:issue/${n}`);
  git(r.root, 'checkout', '-q', 'main');
  git(r.root, 'branch', '-q', '-D', `issue/${n}`);
  board({ issues: [{ ...blockedIssue(n), title: 'thing' }], prs: [{ number: 100 + n, head: `issue/${n}`, title: 'feat: thing', state: 'OPEN', mergeable: o.mergeable ?? 'MERGEABLE' }],
    comments: [AUDIT_PASS(100 + n), STOP('merging the audited PR failed: ship: git push failed'), ...(o.extra ?? [])].map((body) => ({ issue: n, body })) });
  rmSync(ghLog, { force: true });
  return r;
}
const fix = (r: ReturnType<typeof repo>, now = NOW, merged?: (t?: string) => void) =>
  H.healthPass(r.project as any, { repairs: true, now, env: okEnv, live: new Set(), merged });
const theIssue = (n: number) => read().issues.find((i: any) => i.number === n);
const commentsOn = (n: number) => read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body as string);

test('healthPass blocked after PASS, MERGEABLE, no ship state: rebuilt from the PR, merged, agent-blocked and the worktree removed', E2E, async () => {
  const r = blockedRepo(21);
  const tests: (string | undefined)[] = [];
  const p = await fix(r, NOW, (t) => tests.push(t));
  assert.ok(readFileSync(ghLog, 'utf8').includes('pr list -R me/app --head issue/21 --state open --json number,title,isCrossRepository'), 'ship rebuilt its state from the PR');
  const s = read();
  assert.equal(s.prs[0].state, 'MERGED');
  assert.equal(theIssue(21).state, 'CLOSED');
  assert.ok(!theIssue(21).labels.includes(L.blocked));
  assert.ok(!existsSync(path.join(r.wt, 'i21')));
  assert.deepEqual(tests, [OK_TEST]);
  assert.match(p.line, /fixed 1 \(merged PR #121 \(#21\)\)/);
});

test('healthPass blocked after PASS: CONFLICTING, ship exit 3 and exit 4 → back to ready-for-agent with a resume comment', E2E, async () => {
  const conflicting = blockedRepo(22, { mergeable: 'CONFLICTING' });
  await fix(conflicting);
  assert.deepEqual(theIssue(22).labels, [L.ready]);
  assert.equal(read().prs[0].state, 'OPEN');
  const c22 = commentsOn(22).at(-1)!;
  assert.ok(c22.startsWith(H.RESUME_MARKER), c22);
  assert.match(c22, /conflicts/);
  assert.doesNotMatch(c22, /Ship output/);

  const failing = blockedRepo(23, { test: 'node -e "console.log(23*1000+1); process.exit(1)"' });
  const p = await fix(failing);
  assert.deepEqual(theIssue(23).labels, [L.ready]);
  assert.equal(theIssue(23).state, 'OPEN');
  const c23 = commentsOn(23).at(-1)!;
  assert.ok(c23.startsWith(H.RESUME_MARKER));
  assert.match(c23, /tests fail/);
  assert.match(c23, /Ship output \(tail\)[\s\S]*23001/);
  assert.ok(existsSync(path.join(failing.wt, 'i23')), 'the worktree stays for the next impl session');
  assert.match(p.line, /sent #23 back to ready-for-agent \(ship exit 4\)/);

  const conflict = blockedRepo(24);
  writeFileSync(path.join(conflict.root, 'a.txt'), 'theirs\n');
  git(conflict.root, 'add', 'a.txt'); git(conflict.root, 'commit', '-q', '-m', 'other'); git(conflict.root, 'push', '-q', 'origin', 'HEAD:main');
  await fix(conflict);
  assert.deepEqual(theIssue(24).labels, [L.ready]);
  const c24 = commentsOn(24).at(-1)!;
  assert.ok(c24.startsWith(H.RESUME_MARKER));
  assert.match(c24, /conflicts with the base after a rebase[\s\S]*Ship output \(tail\)[\s\S]*rebase on origin\/main conflicts in: a\.txt/);
});

test('healthPass: blocked again after a resume comment files exactly one health: issue; never again, also once it is closed', E2E, async () => {
  const r = blockedRepo(25, { extra: [`${H.RESUME_MARKER}\n**hx:** the audit passed, but the tests fail after rebasing it.`, STOP('merging the audited PR failed: again')] });
  const p = await fix(r);
  const filed = read().issues.filter((i: any) => /^health: /.test(i.title));
  assert.equal(filed.length, 1);
  assert.deepEqual(filed[0].labels, [L.bug]);
  assert.ok(filed[0].body.includes('<!-- hx:health resume:25 -->'));
  assert.match(p.line, new RegExp(`filed 1 \\(#${filed[0].number}\\)`));
  assert.deepEqual(theIssue(25).labels, [L.blocked], 'not repaired again');
  assert.equal(read().prs[0].state, 'OPEN');

  rmSync(ghLog, { force: true });
  await fix(r, NOW + HOUR);
  assert.deepEqual(writes(), []);
  const s = read();
  s.issues.find((i: any) => i.number === filed[0].number).state = 'CLOSED';
  writeFileSync(stateFile, JSON.stringify(s));
  await fix(r, NOW + 2 * HOUR);
  assert.deepEqual(writes(), []);
});

test('healthPass: UNKNOWN mergeable and a NEEDS-INFO block change nothing; NEEDS-INFO is not reported', E2E, async () => {
  const r = blockedRepo(26, { mergeable: 'UNKNOWN' });
  const s = read();
  s.issues.push(blockedIssue(27));
  s.comments.push({ issue: 27, body: 'NEEDS-INFO: which version do you run?' });
  writeFileSync(stateFile, JSON.stringify(s));
  const p = await fix(r);
  assert.deepEqual(writes(), []);
  assert.ok(p.results.some((x) => x.mark === '✗' && /#26 .*UNKNOWN, waiting/.test(x.text)));
  assert.ok(!p.results.some((x) => /#27/.test(x.text)));
});

test('healthPass transient: unblocked once; blocked again < 24 h → left, nothing filed; > 24 h → unblocked again; other reasons untouched', E2E, async () => {
  const r = repo();
  board({ issues: [blockedIssue(30), blockedIssue(31)],
    comments: [{ issue: 30, body: STOP('agent error: claude exited 1 with no result: x') }, { issue: 31, body: STOP('no completion after 30 turns') }] });
  await fix(r);
  assert.deepEqual(theIssue(30).labels, []);
  assert.deepEqual(theIssue(31).labels, [L.blocked]);
  assert.equal(commentsOn(31).length, 1);
  const unblock = commentsOn(30).at(-1)!;
  assert.ok(unblock.startsWith(`<!-- hx:health unblock ${new Date(NOW).toISOString()} -->`), unblock);
  // the next session fails the same way
  const s = read();
  s.issues.find((i: any) => i.number === 30).labels = [L.blocked];
  s.comments.push({ issue: 30, body: STOP('agent error: claude exited 1 with no result: y') });
  writeFileSync(stateFile, JSON.stringify(s));
  rmSync(ghLog, { force: true });
  const p = await fix(r, NOW + 23 * HOUR);
  assert.deepEqual(writes(), []);
  assert.ok(p.results.some((x) => x.mark === '✗' && /#30 /.test(x.text)));
  await fix(r, NOW + 25 * HOUR);
  assert.deepEqual(theIssue(30).labels, []);
  assert.equal(commentsOn(30).filter((b) => b.startsWith('<!-- hx:health unblock')).length, 2);
  assert.ok(!read().issues.some((i: any) => /^health: /.test(i.title)));
});

test('healthPass without repairs: the blocked checks only report what they would do', E2E, async () => {
  const r = blockedRepo(32);
  const s = read();
  s.issues.push(blockedIssue(33), blockedIssue(34), blockedIssue(35));
  s.prs.push({ number: 134, head: 'issue/34', title: 'x', state: 'OPEN', mergeable: 'MERGEABLE' },
    { number: 135, head: 'issue/35', title: 'x', state: 'OPEN', mergeable: 'CONFLICTING' });
  s.comments.push({ issue: 33, body: STOP('stalled: no output for 15 min') }, { issue: 34, body: AUDIT_PASS(134) },
    { issue: 34, body: `${H.RESUME_MARKER}\nx` }, { issue: 35, body: AUDIT_PASS(135) });
  writeFileSync(stateFile, JSON.stringify(s));
  const before = read();
  const p = await H.healthPass(r.project as any, { repairs: false, now: NOW, env: okEnv, live: new Set() });
  assert.deepEqual(read(), before);
  assert.deepEqual(writes(), []);
  assert.ok(!existsSync(path.join(r.wt, 'i32')));
  const text = p.results.map((x) => x.text).join('\n');
  assert.match(text, /#32 .*would merge PR #132/);
  assert.match(text, /#33 .*would remove agent-blocked/);
  assert.match(text, /#34 .*would file a health: issue/);
  assert.match(text, /#35 .*would send it back to ready-for-agent/);
  assert.ok(!p.results.some((x) => x.mark === 'fixed' || x.mark === 'filed'));
});
