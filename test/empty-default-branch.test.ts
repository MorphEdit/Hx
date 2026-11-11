// #442: gh reports no default branch for a repo with no commits; hx init must not save "defaultBranch": "" and
// hx doctor (hx run's startup gate) must flag an empty one, or hx run builds the ref origin/ and crash-loops.
// A session that crashes the same way every time is backed off, then labelled agent-blocked.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs'); // read when src/github.ts loads: before the imports below
const { DEFAULTS, labelSpecs } = await import('../src/config.ts');
const { checkDefaultBranch, exitCode } = await import('../src/doctor.ts');
const { addWorktree, implWorktree } = await import('../src/worktree.ts');
const { runPool, crashBackoffMs, CRASH_BLOCK_AFTER } = await import('../src/pool.ts');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-edb-'));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const FAKE_GH = path.join(here, 'fakes', 'gh.mjs');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const ALL_LABELS = labelSpecs(DEFAULTS.labels).map((l) => l.name);
const L = DEFAULTS.labels;

// the fake gh, except `gh repo view --json defaultBranchRef` answers an empty name, as GitHub does for an empty repo
const noBranchGh = path.join(tmp, 'gh-nobranch.mjs');
writeFileSync(noBranchGh, `import { cli } from ${JSON.stringify(pathToFileURL(FAKE_GH).href)};
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view' && a.includes('.defaultBranchRef.name')) process.stdout.write('\\n');
else cli();
`);

let n = 0;
/** A clone of a local bare origin; `push`: a first commit pushed to main (else origin has no commits). */
function clone(push: boolean) {
  const dir = path.join(tmp, `r${++n}`);
  mkdirSync(dir);
  const origin = path.join(dir, 'origin.git'), app = path.join(dir, 'app');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, app);
  if (push) {
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
    git(app, 'push', '-q', 'origin', 'HEAD:main');
  }
  return app;
}

function init(app: string) {
  const state = path.join(tmp, `board${n}.json`);
  writeFileSync(state, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  return spawnSync(process.execPath, [HX, 'init', '--yes'], { cwd: app, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: noBranchGh, HX_FAKE_STATE: state } });
}
const savedConfig = (app: string) => JSON.parse(readFileSync(path.join(app, '.hx', 'config.json'), 'utf8'));

test('hx init: gh names no default branch → the checked-out branch origin has (main) is saved', E2E, () => {
  const app = clone(true);
  const r = init(app);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(savedConfig(app).defaultBranch, 'main', r.stdout + r.stderr);
  assert.match(r.stdout, /\(base main\)/);
});

test('hx init: origin has no commits → refuses with the reason, no config written', E2E, () => {
  const app = clone(false);
  const r = init(app);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no commits yet; push a first commit, then run hx init again/);
  assert.ok(!existsSync(path.join(app, '.hx', 'config.json')));
});

test('hx init again: an existing config with "defaultBranch": "" is repaired', E2E, () => {
  const app = clone(true);
  mkdirSync(path.join(app, '.hx'));
  writeFileSync(path.join(app, '.hx', 'config.json'), JSON.stringify({ ...DEFAULTS, repo: 'me/app', defaultBranch: '', worktreeRoot: path.join(tmp, 'wt') }));
  const r = init(app);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(savedConfig(app).defaultBranch, 'main', r.stdout + r.stderr);
});

test('checkDefaultBranch: empty or blank → a required ✗ with the fix; a name → ✓', E2E, () => {
  for (const b of ['', '  ', undefined]) {
    const c = checkDefaultBranch(b);
    assert.equal(c.mark, '✗');
    assert.equal(c.required, true);
    assert.match(c.fix!, /set "defaultBranch": "main" in \.hx\/config\.json \(or push a first commit and run hx init again\)/);
    assert.equal(exitCode([c]), 1);
  }
  assert.deepEqual(checkDefaultBranch('main'), { mark: '✓', label: 'defaultBranch', detail: 'main', required: true });
});

test('hx doctor: an empty defaultBranch in .hx/config.json is a required ✗', E2E, () => {
  const dir = path.join(tmp, 'doc');
  mkdirSync(path.join(dir, '.hx'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.hx', 'config.json'), JSON.stringify({ repo: 'me/app', defaultBranch: '',
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), gateCommand: 'npm test' }));
  const state = path.join(tmp, 'board-doc.json');
  writeFileSync(state, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], labels: ALL_LABELS }));
  const r = spawnSync(process.execPath, [HX, 'doctor'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: state, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '23.6.0' } });
  assert.match(r.stdout, /^✗ defaultBranch — empty\n {4}fix: set "defaultBranch": "main"/m, r.stdout + r.stderr);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('addWorktree: an empty base is a clear error, not the ref origin/', E2E, async () => {
  const app = clone(true);
  await assert.rejects(addWorktree(app, path.join(tmp, 'wt-empty'), implWorktree(1, '')), /no base branch: defaultBranch is empty in \.hx\/config\.json/);
});

test('hx run: a session that crashes on every try is backed off, then labelled agent-blocked with the error', E2E, async () => {
  assert.deepEqual([1, 2, 3].map((k) => crashBackoffMs(k, {})), [60_000, 120_000, 240_000]);
  assert.equal(crashBackoffMs(2, { HX_CRASH_BACKOFF_MS: '5' }), 10);
  assert.equal(CRASH_BLOCK_AFTER, 3);

  const app = clone(true);
  const stateFile = path.join(tmp, 'board-run.json');
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [],
    issues: [{ number: 7, title: 'task', body: '', state: 'OPEN', labels: [L.ready] }] }));
  const env = { HX_FAKE_STATE: stateFile, HX_CRASH_BACKOFF_MS: '0' };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    const p = { root: app, stateDir: path.join(app, '.hx'), config: { ...DEFAULTS, repo: 'me/app', defaultBranch: '',
      worktreeRoot: path.join(tmp, 'wt-run'), claudeBin: path.join(here, 'fakes', 'claude.mjs'), pollSeconds: 1, audit: false, sizeCheck: false } };
    await pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal }));
  } finally {
    console.log = orig;
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.equal(lines.filter((l) => /\[#7\] crashed:/.test(l)).length, CRASH_BLOCK_AFTER, lines.join('\n'));
  assert.ok(lines.some((l) => /\[#7\] crashed 1 time\(s\) in a row — not claimed again for /.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /\[#7\] crashed 3 times in a row — labelled agent-blocked/.test(l)), lines.join('\n'));
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const issue = s.issues.find((i: any) => i.number === 7);
  assert.deepEqual(issue.labels.sort(), [L.blocked, L.ready].sort());
  const c = s.comments.filter((x: any) => x.issue === 7);
  assert.equal(c.length, 1);
  assert.match(c[0].body, /crashed 3 times in a row/);
  assert.match(c[0].body, /no base branch: defaultBranch is empty/);
});
