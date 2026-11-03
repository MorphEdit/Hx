// hx run's startup gate (#211): the doctor checks (no label lookup) run before any board read or session; a
// required ✗ stops the run with exit 1 and the fix, a ? lets it start. Real git, fake gh and fake claude.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, labelSpecs, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-rdoc-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

let n = 0;
/** One `hx run` on a repo with one ready issue; authStatus goes to the fake gh, config over the defaults. */
function run(o: { authStatus?: string; config?: object } = {}) {
  const base = path.join(tmp, `r${++n}`);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git'), root = path.join(base, 'app');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, root);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(base, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...o.config });
  const board = path.join(base, 'board.json'), ghLog = path.join(base, 'gh.log'), times = path.join(base, 'times.jsonl');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], labels: labelSpecs(DEFAULTS.labels).map((l) => l.name),
    authStatus: o.authStatus, issues: [{ number: 1, title: 'task 1', body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] }] }));
  mkdirSync(path.join(base, 'sessions'));
  const r = spawnSync(process.execPath, [HX, 'run', '--workers', '1'], { cwd: root, encoding: 'utf8', env: { ...process.env,
    HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: board, HX_FAKE_DIR: path.join(base, 'sessions'), HX_FAKE_GH_LOG: ghLog,
    FAKE_CLAUDE_TIMES: times, HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'), HX_HOME: path.join(base, 'home') } });
  const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : [];
  const state = JSON.parse(readFileSync(board, 'utf8'));
  return { code: r.status, out: r.stdout + r.stderr, ghCalls, sessions: existsSync(times) ? readFileSync(times, 'utf8').trim().split('\n').length : 0,
    closed: state.issues.filter((i: any) => i.state === 'CLOSED').map((i: any) => i.number) };
}

test('hx run with gh logged out stops at startup: exit 1, gh auth login, no session, no board read', E2E, () => {
  const r = run({ authStatus: 'out' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ gh logged in — not logged in\n\s+fix: gh auth login/);
  assert.equal(r.sessions, 0, r.out);
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.ghCalls.filter((l) => /^(issue|label|pr) /.test(l)), [], 'no board read');
  assert.doesNotMatch(r.out, /hx pool up/);
});

test('hx run with a missing agent CLI binary stops at startup: exit 1 and the install fix', E2E, () => {
  const r = run({ config: { claudeBin: path.join(tmp, 'no-such-claude.mjs') } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ agent CLI \(.*no-such-claude\.mjs\) — not installed/);
  assert.match(r.out, /fix: (irm https:\/\/claude\.ai\/install\.ps1|curl -fsSL https:\/\/claude\.ai\/install\.sh|install Claude Code)/);
  assert.equal(r.sessions, 0, r.out);
  assert.deepEqual(r.closed, []);
});

test('hx run with gh auth status failing on the network (?) still starts and builds the issue', E2E, () => {
  const r = run({ authStatus: 'offline' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\? gh logged in — could not tell \(offline\?\)/);
  assert.match(r.out, /hx pool up/);
  assert.ok(r.sessions > 0, r.out);
  assert.deepEqual(r.closed, [1]);
});

test('hx run with every check passing prints no doctor lines and starts', E2E, () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /^[✗?–] /m);
  assert.deepEqual(r.closed, [1]);
});

test('hx run outside an hx project prints the .hx/config.json check with hx init and exits 1', E2E, () => {
  const dir = path.join(tmp, 'bare');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const board = path.join(tmp, 'bare-board.json');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const r = spawnSync(process.execPath, [HX, 'run'], { cwd: dir, encoding: 'utf8', env: { ...process.env,
    HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: board, HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs') } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /✗ \.hx\/config\.json — missing\n\s+fix: hx init/);
});
