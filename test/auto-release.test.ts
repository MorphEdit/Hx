// autoRelease end to end (#187, PRD #139 §D10): hx run releases by itself. Real git with a local bare origin,
// fake gh and claude, and a fake gate command that records the sha it tested.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ar-'));
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readGate, writeGate } = await import('../src/gate.ts');
const { parseOutcomes } = await import('../src/outcomes.ts');

const fwd = (p: string) => p.replace(/\\/g, '/');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const gitAt = (date: string, cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).trim();

// the gate: appends the sha it tests to argv[2]; red while argv[3] exists
const gateScript = path.join(tmp, 'gate.mjs');
writeFileSync(gateScript, `import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
const [runs, red] = process.argv.slice(2);
appendFileSync(runs, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() + '\\n');
process.exit(existsSync(red) ? 1 : 0);
`);

const OLD = '2020-01-01T00:00:00Z';
const L = DEFAULTS.labels;

interface Fixture { dir: string; origin: string; w: string; p: any; board: string; runs: string; red: string }

/** origin with main at v0.1.0 (released on GitHub, tagged at `tagDate`), an hx checkout and a clone `w` for pushes. */
function fixture(o: { tagDate?: string; config?: object; issues?: object[]; gateCommand?: string } = {}): Fixture {
  const dir = mkdtempSync(path.join(tmp, 'f-'));
  const origin = path.join(dir, 'origin.git'), root = path.join(dir, 'app'), w = path.join(dir, 'w');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, w);
  writeFileSync(path.join(w, 'package.json'), '{\n  "name": "app",\n  "version": "0.1.0"\n}\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', 'feat: the start (#1)');
  gitAt(o.tagDate ?? OLD, w, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  git(w, 'push', '-q', '--follow-tags', 'origin', 'HEAD:main');
  git(dir, 'clone', '-q', origin, root);
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir);
  const exclude = path.join(root, '.git', 'info', 'exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
  const f = { dir, origin, w, board: path.join(dir, 'board.json'), runs: path.join(dir, 'runs'), red: path.join(dir, 'RED') } as Fixture;
  const gateCommand = o.gateCommand ?? `node "${fwd(gateScript)}" "${fwd(f.runs)}" "${fwd(f.red)}"`;
  f.p = { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(dir, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), pollSeconds: 1, roleSkills: {}, autoRelease: true, gateCommand, ...o.config } };
  writeFileSync(f.board, JSON.stringify({ comments: [], prs: [], issues: o.issues ?? [], releases: [{ tag: 'v0.1.0' }] }));
  return f;
}

function commit(f: Fixture, subject: string) {
  writeFileSync(path.join(f.w, `c${Math.random().toString(36).slice(2)}.txt`), subject + '\n');
  git(f.w, 'add', '-A');
  git(f.w, 'commit', '-q', '-m', subject);
  git(f.w, 'push', '-q', 'origin', 'HEAD:main');
}

/** A PRD the engine closes on the first pass: reviewed and secured, its only child closed. */
const donePrd = (n: number) => [
  { number: n, title: `PRD: Widgets ${n}`, body: '', state: 'OPEN', labels: [L.prd, L.reviewed, L.secured] },
  { number: n + 1, title: 'a child', body: `## Parent\n#${n}\n`, state: 'CLOSED', labels: [] },
];

async function hxRun(f: Fixture, board: object = {}) {
  process.env.HX_FAKE_STATE = f.board;
  if (Object.keys(board).length) writeFileSync(f.board, JSON.stringify({ ...JSON.parse(readFileSync(f.board, 'utf8')), ...board }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };
  const rc = await pooled((signal) => runPool(f.p, { workers: 1, watch: false, dryRun: false, signal }))
    .finally(() => { console.log = orig; });
  return { rc, out: lines.join('\n') };
}

const hasTag = (f: Fixture, t: string) => git(f.origin, 'tag', '-l', t) === t;
const releases = (f: Fixture): any[] => JSON.parse(readFileSync(f.board, 'utf8')).releases ?? [];
const gateRuns = (f: Fixture) => (existsSync(f.runs) ? readFileSync(f.runs, 'utf8').trim().split('\n').filter(Boolean) : []);
const runLog = (f: Fixture) => readFileSync(path.join(f.p.stateDir, 'run.log'), 'utf8');

test('autoRelease: a run in which a PRD closes releases a minor (PRD #n) on the run\'s own gate result: tag on origin, gh release created', E2E, async () => {
  const f = fixture({ issues: donePrd(3) });
  commit(f, 'feat: add a widget (closes #4) (#5)');
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /PRD closed ✓/);
  assert.match(r.out, /released v0\.2\.0 \(PRD #3\)/);
  assert.ok(hasTag(f, 'v0.2.0'));
  assert.deepEqual(releases(f).map((x) => x.tag), ['v0.1.0', 'v0.2.0']);
  assert.match(releases(f)[1].notes, /PRD #3: Widgets 3/);
  // gate on: the startup gate's recorded green result for the head is used, the release runs no gate of its own
  assert.equal(gateRuns(f).length, 1, r.out);
  assert.equal(readGate(f.p.stateDir).last?.ok, true);
  assert.match(r.out, /nothing left to do — done/);
  const o = parseOutcomes(runLog(f).split(String.fromCharCode(10)));
  assert.deepEqual(o.releases, { count: 1, latest: 'v0.2.0' });
});

test('autoRelease off (the default): the same run makes no release', E2E, async () => {
  assert.equal(DEFAULTS.autoRelease, false);
  assert.equal(DEFAULTS.autoReleasePatchHours, 24);
  const f = fixture({ issues: donePrd(3), config: { autoRelease: DEFAULTS.autoRelease } });
  commit(f, 'feat: add a widget (closes #4) (#5)');
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /PRD closed ✓/);
  assert.doesNotMatch(r.out, /releas/);
  assert.ok(!hasTag(f, 'v0.2.0'));
  assert.deepEqual(releases(f).map((x) => x.tag), ['v0.1.0']);
});

test('patch: a single fix(scope): commit and a tag older than autoReleasePatchHours → released (fixes); gate off: the release runs the gate, unrecorded', E2E, async () => {
  const f = fixture({ config: { gate: false } });
  commit(f, 'fix(parser): handle empty input (closes #7) (#8)');
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /released v0\.1\.1 \(fixes\)/);
  assert.ok(hasTag(f, 'v0.1.1'));
  assert.deepEqual(releases(f).map((x) => x.tag), ['v0.1.0', 'v0.1.1']);
  assert.equal(gateRuns(f).length, 1);
  assert.equal(readGate(f.p.stateDir).last, undefined, 'gate off: the release gate is not recorded');
});

test('patch: a tag newer than autoReleasePatchHours → no release, the reason logged', E2E, async () => {
  const f = fixture({ tagDate: new Date(Date.now() - 3_600_000).toISOString() });
  commit(f, 'fix: handle empty input (#8)');
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /release: none due — fixes merged, but v0\.1\.0 is less than 24 h old/);
  assert.doesNotMatch(r.out, /released v/);
  assert.ok(!hasTag(f, 'v0.1.1'));
});

test('patch: only feat: / docs: / other commits → no release', E2E, async () => {
  const f = fixture();
  commit(f, 'feat: add a widget (#5)');
  commit(f, 'docs: explain widgets (#6)');
  commit(f, 'chore: tidy (#9)');
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /release: none due — no PRD closed and no fix merged since v0\.1\.0/);
  assert.deepEqual(releases(f).map((x) => x.tag), ['v0.1.0']);
});

test('gate on and red for the head: no release, the run continues and finishes', E2E, async () => {
  // the gate's fix issue is already filed (and blocked), so the run has nothing to claim; a patch is due
  const f = fixture({ issues: [{ number: 99, title: 'Default branch is red', body: '', state: 'OPEN', labels: [L.gateFix, L.blocked] }] });
  commit(f, 'fix: handle empty input (#8)');
  writeFileSync(f.red, 'x');
  writeGate(f.p.stateDir, { fixIssue: 99 });
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /gate RED/);
  assert.match(r.out, /release: gate red on main .* not released/);
  assert.doesNotMatch(r.out, /released v/);
  assert.ok(!hasTag(f, 'v0.1.1'));
  assert.equal(gateRuns(f).length, 1, 'the recorded red result is used: no extra gate run');
  assert.match(r.out, /nothing left to do — done/);
});

test('a failing gh release create → release vX.Y.Z failed: logged, the run still finishes normally', E2E, async () => {
  const f = fixture({ issues: donePrd(3) });
  commit(f, 'feat: add a widget (#5)');
  const r = await hxRun(f, { releaseCreateFails: true });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /release v0\.2\.0 failed: /);
  assert.doesNotMatch(r.out, /released v/);
  assert.match(r.out, /nothing left to do — done/);
});

test('no gate command known → release: no gate command known, logged once, no release', E2E, async () => {
  const f = fixture({ issues: donePrd(3), gateCommand: '' });
  commit(f, 'feat: add a widget (#5)');
  const r = await hxRun(f);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.out.split('\n').filter((l) => /release: no gate command known/.test(l)).length, 1, r.out);
  assert.doesNotMatch(r.out, /released v/);
  assert.ok(!hasTag(f, 'v0.2.0'));
});
