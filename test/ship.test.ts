// scripts/ship.mjs against real git (a local bare origin) and the fake gh.
import { E2E, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIP = path.join(here, '..', 'scripts', 'ship.mjs');
const FAKE_GH = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ship-'));
  const origin = path.join(tmp, 'origin.git'), wt = path.join(tmp, 'wt'), other = path.join(tmp, 'other');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, wt);
  writeFileSync(path.join(wt, 'a.txt'), 'one\n');
  git(wt, 'add', '-A'); git(wt, ...gitId, 'commit', '-q', '-m', 'init'); git(wt, 'push', '-q', 'origin', 'HEAD:main');
  git(wt, 'checkout', '-q', '-b', 'issue/7');
  git(tmp, 'clone', '-q', origin, other);
  const board = path.join(tmp, 'board.json');
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: [{ number: 7, title: 't', body: '', state: 'OPEN', labels: [] }] }));
  return { tmp, origin, wt, other, board };
}

function ship(env: ReturnType<typeof setup>, testCmd: string) {
  return spawnSync(process.execPath, [SHIP, '--repo', 'me/app', '--base', 'main', '--issue', '7', '--title', 'feat: thing', '--test', testCmd], {
    cwd: env.wt, encoding: 'utf8',
    env: { ...process.env, HX_FAKE_STATE: env.board, HX_GH_BIN: FAKE_GH,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}
const remoteHeads = (env: ReturnType<typeof setup>) => git(env.tmp, 'ls-remote', '--heads', env.origin);
const board = (env: ReturnType<typeof setup>) => JSON.parse(readFileSync(env.board, 'utf8'));

test('ship: commits, rebases, tests, pushes, opens + merges the PR, deletes the branch, closes the issue', E2E, () => {
  const env = setup();
  // someone else merged meanwhile: ship must rebase onto it
  writeFileSync(path.join(env.other, 'b.txt'), 'theirs\n');
  git(env.other, 'add', '-A'); git(env.other, ...gitId, 'commit', '-q', '-m', 'other'); git(env.other, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(path.join(env.wt, 'c.txt'), 'mine\n');

  const r = ship(env, 'node -e "process.exit(0)"');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHIPPED #7 via PR #100/);
  const b = board(env);
  assert.equal(b.prs[0].state, 'MERGED');
  assert.equal(b.prs[0].head, 'issue/7');
  assert.equal(b.issues[0].state, 'CLOSED');
  assert.doesNotMatch(remoteHeads(env), /issue\/7/, 'remote branch deleted after the merge');
  assert.match(git(env.wt, 'log', '--format=%s', '-2'), /feat: thing \(closes #7\)\nother/, 'committed on top of the rebased base');
});

test('ship: failing tests stop it before anything is pushed', E2E, () => {
  const env = setup();
  writeFileSync(path.join(env.wt, 'c.txt'), 'mine\n');
  const r = ship(env, 'node -e "console.log(\'boom\'); process.exit(1)"');
  assert.equal(r.status, 4);
  assert.match(r.stderr, /tests failed[\s\S]*boom/);
  assert.doesNotMatch(remoteHeads(env), /issue\/7/);
  assert.equal(board(env).prs.length, 0);
});

test('ship: a rebase conflict is aborted and reported with the files', E2E, () => {
  const env = setup();
  writeFileSync(path.join(env.other, 'a.txt'), 'theirs\n');
  git(env.other, 'add', '-A'); git(env.other, ...gitId, 'commit', '-q', '-m', 'other'); git(env.other, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(path.join(env.wt, 'a.txt'), 'mine\n');
  const r = ship(env, 'node -e "process.exit(0)"');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /conflicts in: a\.txt/);
  assert.equal(git(env.wt, 'status', '--porcelain'), '', 'rebase aborted, tree clean');
  assert.equal(git(env.wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'issue/7');
});

// a test command that never ends, run through a shell like `npm test`; its node process records its pid.
// The timeouts below leave seconds for the shell and node to start under a loaded `npm test`: a shorter one
// kills the run before the pid is written (#15).
const hang = (pidFile: string) => `node -e "require('fs').writeFileSync('${pidFile.replace(/\\/g, '/')}', String(process.pid)); setInterval(() => {}, 1e3)"`;
const shipWith = (env: ReturnType<typeof setup>, extra: string[], extraEnv: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SHIP, ...extra], { cwd: env.wt, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HX_FAKE_STATE: env.board, HX_GH_BIN: FAKE_GH, ...extraEnv } });

test('ship: a test run past --test-timeout is killed with its whole tree and fails like a failing test', E2E, () => {
  const env = setup();
  writeFileSync(path.join(env.wt, 'c.txt'), 'mine\n');
  const pidFile = path.join(env.tmp, 'test.pid');
  const t0 = Date.now();
  const r = shipWith(env, ['--repo', 'me/app', '--base', 'main', '--issue', '7', '--title', 'feat: thing', '--test', hang(pidFile), '--test-timeout', '0.1']);
  assert.equal(r.status, 4, r.stderr);
  assert.ok(Date.now() - t0 < 30_000, 'ship gave up within seconds');
  assert.match(r.stderr, /ship: tests timed out after 0\.1 min/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the test process ${pid} is not left running`);
  assert.doesNotMatch(remoteHeads(env), /issue\/7/, 'nothing pushed');
  assert.equal(board(env).prs.length, 0);
});

test('ship: --test-timeout is remembered by --no-merge and reused by --resume; HX_SHIP_TEST_TIMEOUT_MS overrides it', E2E, () => {
  const env = setup();
  writeFileSync(path.join(env.wt, 'c.txt'), 'mine\n');
  const r = shipWith(env, ['--repo', 'me/app', '--base', 'main', '--issue', '7', '--title', 'feat: thing', '--test', 'node -e "process.exit(0)"',
    '--test-timeout', '0.1', '--no-merge']);
  assert.equal(r.status, 0, r.stderr);
  const stateFile = path.join(env.wt, '.git', 'hx-ship.json');
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved.testTimeout, 0.1);

  // the base's tests hang by the time hx resumes
  const pidFile = path.join(env.tmp, 'resume.pid');
  writeFileSync(stateFile, JSON.stringify({ ...saved, test: hang(pidFile) }));
  const again = shipWith(env, ['--resume']);
  assert.equal(again.status, 4, again.stderr);
  assert.match(again.stderr, /tests timed out after 0\.1 min/);
  assert.ok(!alive(Number(readFileSync(pidFile, 'utf8'))));

  const pidFile2 = path.join(env.tmp, 'env.pid');
  writeFileSync(stateFile, JSON.stringify({ ...saved, test: hang(pidFile2) }));
  const t0 = Date.now();
  const viaEnv = shipWith(env, ['--resume', '--test-timeout', '30'], { HX_SHIP_TEST_TIMEOUT_MS: '7200' });
  assert.equal(viaEnv.status, 4, viaEnv.stderr);
  assert.ok(Date.now() - t0 < 30_000);
  assert.match(viaEnv.stderr, /tests timed out after 0\.12 min/);
  assert.ok(!alive(Number(readFileSync(pidFile2, 'utf8'))));
});

test('ship: a bad --test-timeout is a usage error', E2E, () => {
  const env = setup();
  const r = shipWith(env, ['--repo', 'me/app', '--base', 'main', '--issue', '7', '--title', 'feat: thing', '--test', 'node -e "0"', '--test-timeout', 'soon']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--test-timeout <minutes>/);
});

test('ship: a fork PR from a branch of the same name is never taken or merged; ours merges at the tested commit', E2E, () => {
  const env = setup();
  // a stranger opened a PR from their fork's own `issue/7` before ship ran: `gh pr list --head` lists it too
  const b0 = board(env);
  b0.prs.push({ number: 99, head: 'issue/7', base: 'main', title: 'evil', state: 'OPEN', fork: true });
  writeFileSync(env.board, JSON.stringify(b0));
  writeFileSync(path.join(env.wt, 'c.txt'), 'mine\n');

  const r = ship(env, 'node -e "process.exit(0)"');
  assert.equal(r.status, 0, r.stderr);
  const b = board(env);
  assert.equal(b.prs.find((p: any) => p.number === 99).state, 'OPEN', 'the fork PR is untouched');
  const ours = b.prs.find((p: any) => p.number !== 99);
  assert.match(r.stdout, new RegExp(`SHIPPED #7 via PR #${ours.number}`));
  assert.equal(ours.state, 'MERGED');
  assert.equal(ours.mergedHead, git(env.wt, 'rev-parse', 'HEAD'), 'merged with --match-head-commit = the tested commit');
});
