// scripts/ship.mjs against real git (a local bare origin) and the fake gh.
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

test('ship: commits, rebases, tests, pushes, opens + merges the PR, deletes the branch, closes the issue', () => {
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

test('ship: failing tests stop it before anything is pushed', () => {
  const env = setup();
  writeFileSync(path.join(env.wt, 'c.txt'), 'mine\n');
  const r = ship(env, 'node -e "console.log(\'boom\'); process.exit(1)"');
  assert.equal(r.status, 4);
  assert.match(r.stderr, /tests failed[\s\S]*boom/);
  assert.doesNotMatch(remoteHeads(env), /issue\/7/);
  assert.equal(board(env).prs.length, 0);
});

test('ship: a rebase conflict is aborted and reported with the files', () => {
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
