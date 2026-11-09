// #433: hx overlap counts only what an issue's worktree changed since it branched, not what landed on origin/<base> after.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');

test('hx overlap: a file changed only on origin/main after the worktree branched is not the issue\'s (#433)', E2E, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ovb-'));
  const origin = path.join(tmp, 'o.git'), root = path.join(tmp, 'r'), wt = path.join(tmp, 'wt'), i7 = path.join(wt, 'i7');
  const stateFile = path.join(tmp, 'board.json'), ghLog = path.join(tmp, 'gh.log');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init'); git(root, 'push', '-q', 'origin', 'HEAD:main');
  const exclude = path.join(root, '.git', 'info', 'exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wt });
  git(root, 'worktree', 'add', '-q', '-b', 'issue/7', i7, 'origin/main');
  writeFileSync(path.join(i7, 'mine.txt'), 'mine\n');
  git(i7, 'add', '-A'); git(i7, 'commit', '-q', '-m', 'work on 7');
  // an uncommitted change to a tracked file still counts as the issue's
  writeFileSync(path.join(i7, 'a.txt'), 'a changed\n');
  // another PR merges to main after #7 branched; hx run's fetch moves origin/main
  writeFileSync(path.join(root, 'other.txt'), 'other\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'other'); git(root, 'push', '-q', 'origin', 'HEAD:main');
  git(i7, 'fetch', '-q', 'origin', 'main');
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], labels: [], prs: [],
    issues: [{ number: 7, title: 'task 7', body: '', state: 'OPEN', labels: [DEFAULTS.labels.working], author: 'me' }] }));
  const hx = (...args: string[]) => {
    const r = spawnSync(process.execPath, [HX, 'overlap', ...args], { cwd: root, encoding: 'utf8',
      env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_GH_LOG: ghLog } });
    return { code: r.status, out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr };
  };
  let r = hx('mine.txt');
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'mine.txt: issue #7\n');
  r = hx('a.txt');
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'a.txt: issue #7\n');
  r = hx('other.txt');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out, 'no overlap\n');
});
