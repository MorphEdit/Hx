// test/repo-copy.ts: a git fixture built once and copied per test (#369).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyRepos, fwd } from './repo-copy.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

test('copyRepos: each copy is its own repo, its clone pushing to its own origin; a clone made with a backslash path throws', E2E, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-copy-'));
  const template = path.join(tmp, 't');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', path.join(template, 'origin.git'));
  git(tmp, 'clone', '-q', fwd(path.join(template, 'origin.git')), path.join(template, 'w'));
  writeFileSync(path.join(template, 'w', 'a.txt'), 'a\n');
  git(path.join(template, 'w'), 'add', '-A');
  git(path.join(template, 'w'), 'commit', '-q', '-m', 'start');
  git(path.join(template, 'w'), 'push', '-q', 'origin', 'HEAD:main');
  const start = git(path.join(template, 'origin.git'), 'rev-parse', 'main');

  const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
  copyRepos(template, a, ['w']);
  copyRepos(template, b, ['w']);
  assert.equal(git(path.join(a, 'w'), 'remote', 'get-url', 'origin'), fwd(path.join(a, 'origin.git')));
  writeFileSync(path.join(a, 'w', 'b.txt'), 'b\n');
  git(path.join(a, 'w'), 'add', '-A');
  git(path.join(a, 'w'), 'commit', '-q', '-m', 'in a');
  git(path.join(a, 'w'), 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(git(path.join(a, 'origin.git'), 'log', '-1', '--format=%s', 'main'), 'in a');
  assert.equal(git(path.join(b, 'origin.git'), 'rev-parse', 'main'), start, 'the other copy is untouched');
  assert.equal(git(path.join(template, 'origin.git'), 'rev-parse', 'main'), start, 'the template is untouched');

  git(tmp, 'clone', '-q', path.join(template, 'origin.git'), path.join(template, 'back'));
  if (process.platform === 'win32') assert.throws(() => copyRepos(template, path.join(tmp, 'c'), ['back']), /clone with fwd\(origin\)/);
});
