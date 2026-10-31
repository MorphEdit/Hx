// hx bug end to end: the real CLI (bin/hx.mjs) with fake gh files a bug issue, labelled bug only.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { clearLive, writeLive } from '../src/runstate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-bug-'));
const stateFile = path.join(tmp, 'board.json');
const root = path.join(tmp, 'app');
mkdirSync(root);
saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main' });

const board = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const reset = () => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));

function hx(args: string[]) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('hx bug <file.md>: the "# " heading is the title, the file is the body, label bug only', E2E, () => {
  reset();
  const file = path.join(tmp, 'crash.md');
  const text = '# Crash on start\n\nSteps: run hx status.\n';
  writeFileSync(file, text);
  const r = hx(['bug', file]);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'Crash on start');
  assert.equal(issues[0].body, text);
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.bug]);
  assert.ok(!issues[0].labels.includes(DEFAULTS.labels.ready));
  assert.match(r.out, /https:\/\/github\.com\/me\/app\/issues\/1/);
  assert.match(r.out, /issues\/1\r?\nIt will be triaged\. no hx run is running — start it with {2}hx run --watch/);
  assert.match(readFileSync(path.join(root, '.hx', 'wake'), 'utf8').trim(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('hx bug with a live runner: <url>, then the triage lane and "will pick it up now"', E2E, () => {
  reset();
  writeLive(path.join(root, '.hx'), { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  try {
    const r = hx(['bug', 'it breaks']);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.replace(/\r\n/g, '\n').includes(
      `https://github.com/me/app/issues/1\nIt will be triaged. hx run (pid ${process.pid}) will pick it up now.\n`), r.out);
  } finally { clearLive(path.join(root, '.hx')); }
});

test('hx bug that files nothing writes no .hx/wake', E2E, () => {
  reset();
  rmSync(path.join(root, '.hx', 'wake'), { force: true });
  const r = hx(['bug', '   ']);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(board().issues.length, 0);
  assert.ok(!existsSync(path.join(root, '.hx', 'wake')));
});

test('hx bug "text": the title is its first non-empty line, the body the text', E2E, () => {
  reset();
  const r = hx(['bug', '\nstatus hangs\nwhen the board is empty']);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues[0].title, 'status hangs');
  assert.equal(issues[0].body, '\nstatus hangs\nwhen the board is empty');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.bug]);
  assert.match(r.out, /issues\/1\r?\nIt will be triaged\. /);
});

test('hx bug "text": a long first line is cut to 80 characters', E2E, () => {
  reset();
  const long = 'x'.repeat(100);
  assert.equal(hx(['bug', `${long}\nmore`]).code, 0);
  assert.equal(board().issues[0].title, 'x'.repeat(80));
});

test('hx bug --title overrides the heading and the first line', E2E, () => {
  reset();
  const file = path.join(tmp, 'h.md');
  writeFileSync(file, '# Heading\n\nbody\n');
  assert.equal(hx(['bug', file, '--title', 'Given']).code, 0);
  assert.equal(hx(['bug', '--title', 'Also given', 'first line']).code, 0);
  const { issues } = board();
  assert.equal(issues[0].title, 'Given');
  assert.equal(issues[1].title, 'Also given');
  assert.equal(issues[1].body, 'first line');
});

test('hx help lists bug', E2E, () => {
  const r = hx(['help']);
  assert.match(r.out, /^ {2}bug <file\.md \| "text">/m);
});
