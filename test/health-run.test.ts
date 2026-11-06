// The health pass inside `hx run` (PRD #194 §A, #238): when it runs (idle --watch every healthEveryMinutes, once
// before a plain run exits, never while busy or held), selfHeal off, and the gate-fix check with the runner's gate.
// Real git (a local bare origin per test), fake gh and fake claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-hr-'));
const stateFile = path.join(tmp, 'board.json');
Object.assign(process.env, { HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'),
  HX_FAKE_STATE: stateFile, HX_FAKE_DIR: path.join(tmp, 'sessions') });
mkdirSync(process.env.HX_FAKE_DIR!);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readGate } = await import('../src/gate.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const issue = (number: number, state: 'OPEN' | 'CLOSED', labels: string[] = []) => ({ number, title: `task ${number}`, body: '', state, labels, author: 'me' });
const board = (o: any) => writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], ...o }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const GREEN = 'node -e "process.exit(0)"', RED = 'node -e "process.exit(1)"';

let k = 0;
function repo(extra: object = {}) {
  const dir = path.join(tmp, `r${++k}`);
  mkdirSync(dir);
  const origin = path.join(dir, 'origin.git'), root = path.join(dir, 'app');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, root);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir);
  const exclude = path.join(root, '.git', 'info', 'exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(dir, 'wt'), claudeBin: path.join(here, 'fakes', 'claude.mjs'),
    maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...extra };
  return { root, stateDir, config, head: git(root, 'rev-parse', 'HEAD') };
}
type Repo = ReturnType<typeof repo>;
const runLog = (r: Repo) => { try { return readFileSync(path.join(r.stateDir, 'run.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const passes = (r: Repo) => runLog(r).filter((l) => /\shealth: \d+ ✓/.test(l));
const gateRuns = (r: Repo) => { try { return readFileSync(path.join(r.stateDir, 'gate-runs.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const writeRuns = (r: Repo, runs: { sha: string; ok: boolean }[]) => writeFileSync(path.join(r.stateDir, 'gate-runs.jsonl'),
  runs.map((x, i) => JSON.stringify({ ts: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 60_000).toISOString(), ...x, durationMs: 1000, timedOut: false }) + '\n').join(''));

// 5 min: only a hang fails here (#285, option 3); one impl session ran past 60 s beside busy workers (#313)
async function until(cond: () => boolean, ms = 300_000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 100)); }
}
const plain = (r: Repo) => pooled((signal) => runPool(r, { workers: 1, watch: false, dryRun: false, signal }));
/** hx run --watch until `stopWhen` holds (then stopped), returning the run log. */
async function watch(r: Repo, stopWhen: () => boolean, ms = 300_000) {
  const ac = new AbortController();
  const run = pooled((signal) => runPool(r, { workers: 1, watch: true, dryRun: false, signal }), ac.signal);
  try { await until(stopWhen, ms); } finally { ac.abort(); await run; }
  return runLog(r);
}

test('--watch, empty board: one pass on the first idle loop, none again within healthEveryMinutes', E2E, async () => {
  const r = repo({ healthEveryMinutes: 60 });
  board({});
  const idleSince = { n: 0 };
  await watch(r, () => passes(r).length > 0 && ++idleSince.n > 40); // ~4 s more of 1 s polls after the first pass
  assert.equal(passes(r).length, 1, runLog(r).join('\n'));
  assert.ok(runLog(r).some((l) => /board empty — watching/.test(l)));
});

test('--watch, empty board: once healthEveryMinutes has passed, the next idle loop runs another pass', E2E, async () => {
  const r = repo({ healthEveryMinutes: 0.05 }); // 3 s
  board({});
  await watch(r, () => passes(r).length >= 2);
  const at = passes(r).slice(0, 2).map((l) => Date.parse(l.split(' ')[0]));
  assert.ok(at[1] - at[0] >= 3000, `the second pass came ${at[1] - at[0]} ms after the first`);
});

test('--watch: healthEveryMinutes counts from the end of the last pass, so a slow first pass does not bring the second forward', E2E, async () => {
  const r = repo({ healthEveryMinutes: 0.05 }); // 3 s
  board({ slowNext: { match: '--state merged', ms: 2500 } }); // the first pass reads the merged PRs for 2.5 s
  await watch(r, () => passes(r).length >= 2);
  const at = passes(r).slice(0, 2).map((l) => Date.parse(l.split(' ')[0]));
  assert.ok(at[1] - at[0] >= 3000, `the second pass came ${at[1] - at[0]} ms after the first`);
});

test('no pass while there is a claimable issue or a running session: the first pass comes after the session ends', E2E, async () => {
  const r = repo({ healthEveryMinutes: 0.001 });
  board({ issues: [issue(1, 'OPEN', [L.ready])] });
  const lines = await watch(r, () => read().issues[0].state === 'CLOSED' && passes(r).length > 0);
  const done = lines.findIndex((l) => /\[#1\] impl DONE/.test(l));
  const first = lines.findIndex((l) => /\shealth: \d+ ✓/.test(l));
  assert.ok(done >= 0 && first > done, lines.join('\n'));
});

test('no pass during a usage hold (a shared fleet hold included)', E2E, async () => {
  const r = repo({ healthEveryMinutes: 0.001 });
  board({});
  const fleet = path.join(tmp, `fleet${k}`);
  mkdirSync(fleet);
  writeFileSync(path.join(fleet, 'hold.json'), JSON.stringify({ until: Date.now() + 3_600_000, reason: 'usage 95%', repo: 'me/other' }));
  process.env.HX_FLEET_DIR = fleet;
  try {
    const n = { polls: 0 };
    const lines = await watch(r, () => runLog(r).some((l) => /waiting for the usage limit to reset/.test(l)) && ++n.polls > 30);
    assert.deepEqual(passes(r), [], lines.join('\n'));
  } finally { delete process.env.HX_FLEET_DIR; }
});

test('a plain hx run runs one pass just before it exits', E2E, async () => {
  const r = repo();
  board({ issues: [issue(1, 'OPEN', [L.ready])] });
  assert.equal(await plain(r), 0);
  const lines = runLog(r);
  assert.equal(passes(r).length, 1, lines.join('\n'));
  const pass = lines.findIndex((l) => /\shealth: \d+ ✓/.test(l));
  const done = lines.findIndex((l) => /nothing left to do — done/.test(l));
  assert.ok(lines.findIndex((l) => /\[#1\] impl DONE/.test(l)) < pass && pass < done, lines.join('\n'));
});

test('the pass in hx run never calls rtdd (optional, never ✗): a run without rtdd set up never runs the binary', E2E, async () => {
  const r = repo();
  board({});
  const rtddLog = path.join(tmp, `rtdd${k}.log`);
  process.env.HX_FAKE_RTDD_LOG = rtddLog;
  try { assert.equal(await plain(r), 0); } finally { delete process.env.HX_FAKE_RTDD_LOG; }
  assert.equal(passes(r).length, 1);
  assert.ok(!existsSync(rtddLog), 'the fake rtdd was never called');
});

test('selfHeal false in hx run: a stale PR is reported (with what would be done) and not closed', E2E, async () => {
  const r = repo({ selfHeal: false });
  board({ issues: [issue(5, 'CLOSED')], prs: [{ number: 91, head: 'issue/5', state: 'OPEN' }] });
  assert.equal(await plain(r), 0);
  assert.equal(read().prs[0].state, 'OPEN');
  assert.ok(runLog(r).some((l) => /health: ✗ stale PR #91 — issue #5 is closed — would close PR #91/.test(l)), runLog(r).join('\n'));
  assert.equal(passes(r).length, 1);
});

test('selfHeal true in hx run: the stale PR is closed, its fixed line is in the run log, and the board is read again', E2E, async () => {
  const r = repo();
  board({ issues: [issue(5, 'CLOSED')], prs: [{ number: 91, head: 'issue/5', state: 'OPEN' }] });
  assert.equal(await plain(r), 0);
  assert.equal(read().prs[0].state, 'CLOSED');
  assert.ok(runLog(r).some((l) => /health: fixed closed stale PR #91/.test(l)));
  assert.equal(passes(r).length, 2, 'a pass that changed something is followed by another before the run exits');
});

// ---- gate-fix: the pool's start-up gate run adds one line, so each case seeds the lines before it ----

test('gate-fix: two green runs at the head → closed as not planned with a comment', E2E, async () => {
  const r = repo({ gate: true, gateCommand: GREEN });
  writeRuns(r, [{ sha: r.head, ok: true }]); // + the start-up run: two green at the head
  writeFileSync(path.join(r.stateDir, 'gate.json'), JSON.stringify({ fixIssue: 50 }));
  board({ issues: [issue(50, 'OPEN', [L.gateFix])] });
  assert.equal(await plain(r), 0);
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.equal(s.issues[0].stateReason, 'NOT_PLANNED');
  assert.match(s.comments.find((c: any) => c.issue === 50).body, /last two gate runs are green at/);
  assert.equal(readGate(r.stateDir).fixIssue, undefined);
  assert.ok(runLog(r).some((l) => /health: fixed closed gate-fix #50/.test(l)));
});

test('gate-fix: one green run at the head → not closed; hx run asks its gate for one more run (a new gate-runs line)', E2E, async () => {
  const r = repo({ gate: true, gateCommand: GREEN, healthEveryMinutes: 60 });
  writeRuns(r, [{ sha: r.head, ok: false }]); // + the start-up run: red then green
  board({ issues: [issue(50, 'OPEN', [L.gateFix])] });
  await watch(r, () => gateRuns(r) >= 3);
  assert.equal(read().issues[0].state, 'OPEN');
  assert.ok(runLog(r).some((l) => /health: ✗ gate-fix #50 — waiting for a second green gate run — gate run requested/.test(l)), runLog(r).join('\n'));
  assert.equal(passes(r).length, 1, 'the next pass, an hour later, decides');
});

test('gate-fix: two green runs at an older sha are the same as one; a plain run then closes it on the next pass', E2E, async () => {
  const r = repo({ gate: true, gateCommand: GREEN });
  writeRuns(r, [{ sha: 'a'.repeat(40), ok: true }, { sha: 'a'.repeat(40), ok: true }]); // + the start-up run at the head
  board({ issues: [issue(50, 'OPEN', [L.gateFix])] });
  assert.equal(await plain(r), 0);
  assert.equal(gateRuns(r), 4, 'start-up + one requested');
  const lines = runLog(r);
  const asked = lines.findIndex((l) => /gate-fix #50 — waiting for a second green gate run — gate run requested/.test(l));
  const closed = lines.findIndex((l) => /health: fixed closed gate-fix #50/.test(l));
  assert.ok(asked >= 0 && closed > asked, lines.join('\n'));
  assert.equal(read().issues[0].stateReason, 'NOT_PLANNED');
});

test('gate-fix: the last run red → left open, no gate run asked for', E2E, async () => {
  const r = repo({ gate: true, gateCommand: RED, healthEveryMinutes: 60 });
  writeFileSync(path.join(r.stateDir, 'gate.json'), JSON.stringify({ fixIssue: 50 })); // the red start-up run files nothing new
  board({ issues: [issue(50, 'OPEN', [L.gateFix])] });
  const n = { polls: 0 };
  await watch(r, () => passes(r).length > 0 && ++n.polls > 30);
  assert.equal(read().issues[0].state, 'OPEN');
  assert.equal(gateRuns(r), 1, 'only the start-up run');
  assert.ok(!runLog(r).some((l) => /gate run requested/.test(l)));
  assert.ok(!runLog(r).some((l) => /health: ✗ gate-fix/.test(l)));
});

const hx = (cwd: string, ...a: string[]) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'health', ...a],
  { cwd, encoding: 'utf8', env: { ...process.env, HX_NODE_VERSION: '23.6.0' } });

test('hx health, one green run at the head: ✗ waiting for a second green gate run, and no gate run (with --fix too)', E2E, () => {
  const r = repo();
  writeFileSync(path.join(r.stateDir, 'config.json'), JSON.stringify({ repo: 'me/app', defaultBranch: 'main', worktreeRoot: r.config.worktreeRoot,
    claudeBin: r.config.claudeBin, gateCommand: GREEN }));
  writeRuns(r, [{ sha: r.head, ok: false }, { sha: r.head, ok: true }]);
  board({ issues: [issue(50, 'OPEN', [L.gateFix])] });
  for (const args of [[], ['--fix']]) {
    const out = hx(r.root, ...args);
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^✗ gate-fix #50 — waiting for a second green gate run$/m);
    assert.equal(gateRuns(r), 2);
    assert.ok(!existsSync(path.join(r.config.worktreeRoot, 'gate')));
    assert.equal(read().issues[0].state, 'OPEN');
  }
});

test('hx health --fix, two green runs at the head: closes the gate-fix issue and clears it from gate.json', E2E, () => {
  const r = repo();
  writeFileSync(path.join(r.stateDir, 'config.json'), JSON.stringify({ repo: 'me/app', defaultBranch: 'main', worktreeRoot: r.config.worktreeRoot,
    claudeBin: r.config.claudeBin }));
  writeFileSync(path.join(r.stateDir, 'gate.json'), JSON.stringify({ fixIssue: 50, command: GREEN }));
  writeRuns(r, [{ sha: r.head, ok: true }, { sha: r.head, ok: true }]);
  board({ issues: [issue(50, 'OPEN', [L.gateFix])] });
  const report = hx(r.root);
  assert.match(report.stdout, /✗ gate-fix #50 open — the last two gate runs are green at .* — would close #50 as not planned/);
  assert.equal(read().issues[0].state, 'OPEN');
  const fix = hx(r.root, '--fix');
  assert.match(fix.stdout, /fixed closed gate-fix #50/);
  assert.equal(read().issues[0].stateReason, 'NOT_PLANNED');
  assert.deepEqual(readGate(r.stateDir), { command: GREEN });
});

// ---- a reused green at the head (#352): the pass asks for one full run, which never reuses ----

test('a reused start-up gate at the head: the pass asks for a gate run, which runs the full suite despite the 1-min-old passing record', E2E, async () => {
  const marks = path.join(tmp, `marks-${k + 1}`);
  const counting = `node -e "require('fs').appendFileSync('${marks.replace(/\\/g, '/')}', 'x')"`;
  const r = repo({ gate: true, gateCommand: counting });
  const tree = git(r.root, 'rev-parse', 'HEAD^{tree}');
  writeFileSync(path.join(r.stateDir, 'gate.json'), JSON.stringify({ last: { sha: r.head, ok: true, command: counting, output: '', at: new Date().toISOString() } }));
  writeFileSync(path.join(r.stateDir, 'tested-trees.jsonl'), JSON.stringify({ tree, command: counting, ok: true, at: new Date(Date.now() - 60_000).toISOString() }) + '\n');
  board({});
  assert.equal(await plain(r), 0);
  const runs = readFileSync(path.join(r.stateDir, 'gate-runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(runs.map((x) => [x.sha, x.ok, !!x.reused]), [[r.head, true, true], [r.head, true, false]], runLog(r).join('\n'));
  assert.equal(readFileSync(marks, 'utf8'), 'x', 'the requested run ran the test command once');
  const lines = runLog(r);
  const reused = lines.findIndex((l) => /\(tree already tested\)/.test(l));
  const asked = lines.findIndex((l) => l.includes(`health: ✗ gate green at ${r.head.slice(0, 7)} reused a tested tree — waiting for a full gate run — gate run requested`));
  assert.ok(reused >= 0 && asked > reused, lines.join('\n'));
  assert.equal(readFileSync(path.join(r.stateDir, 'tested-trees.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2, 'the full run is recorded');
});

test('hx health with a reused green at the head: ✗ reported, no gate run (with --fix too)', E2E, () => {
  const r = repo();
  writeFileSync(path.join(r.stateDir, 'config.json'), JSON.stringify({ repo: 'me/app', defaultBranch: 'main', worktreeRoot: r.config.worktreeRoot,
    claudeBin: r.config.claudeBin, gateCommand: GREEN }));
  writeFileSync(path.join(r.stateDir, 'gate-runs.jsonl'), JSON.stringify({ ts: new Date().toISOString(), sha: r.head, ok: true, durationMs: 0, timedOut: false, reused: true }) + '\n');
  board({});
  for (const args of [[], ['--fix']]) {
    const out = hx(r.root, ...args);
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, new RegExp(`^✗ gate green at ${r.head.slice(0, 7)} reused a tested tree — waiting for a full gate run$`, 'm'));
    assert.equal(gateRuns(r), 1);
  }
});
