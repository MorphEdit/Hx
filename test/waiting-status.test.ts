// hx status leads with what waits on the owner: the open needs-human questions (PRD #286, #295).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ws-'));
const L = DEFAULTS.labels;

function status(name: string, issues: object[]): string {
  const root = path.join(tmp, name), sd = path.join(root, '.hx'), b = path.join(tmp, `board-${name}.json`);
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues }));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'status'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}

test('hx status: first line counts the open needs-human questions, then each one\'s number, title and URL; closed ones are not listed', E2E, () => {
  const out = status('two', [
    { number: 12, title: 'Which database?', body: 'q', state: 'OPEN', labels: [L.needsHuman] },
    { number: 5, title: 'Keep the old API?', body: 'q', state: 'OPEN', labels: [L.needsHuman, L.ready] },
    { number: 9, title: 'Answered already', body: 'q', state: 'CLOSED', labels: [L.needsHuman] },
    { number: 3, title: 'a task', body: 't', state: 'OPEN', labels: [L.ready] },
  ]);
  const lines = out.split(/\r?\n/);
  assert.equal(lines[0], 'waiting on you: 2 question(s)', out);
  assert.equal(lines[1], '  #5 Keep the old API? — https://github.com/me/app/issues/5');
  assert.equal(lines[2], '  #12 Which database? — https://github.com/me/app/issues/12');
  assert.ok(!out.includes('#9') && !out.includes('Answered already'), 'a closed question is not listed');
  assert.match(out, /^runner {3}not running$/m, 'the rest of hx status follows');
});

test('hx status with no open question: waiting on you: 0 question(s) first, no list', E2E, () => {
  const out = status('none', [{ number: 3, title: 'a task', body: 't', state: 'OPEN', labels: [L.ready] }]);
  const lines = out.split(/\r?\n/);
  assert.equal(lines[0], 'waiting on you: 0 question(s)', out);
  assert.equal(lines[1], '');
});
