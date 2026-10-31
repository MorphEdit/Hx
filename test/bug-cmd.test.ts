// hx bug end to end: the real CLI (bin/hx.mjs) with fake gh files a bug issue, labelled bug only.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';

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
  assert.match(r.out, /hx run will triage it\./);
});

test('hx bug "text": the title is its first non-empty line, the body the text', E2E, () => {
  reset();
  const r = hx(['bug', '\nstatus hangs\nwhen the board is empty']);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues[0].title, 'status hangs');
  assert.equal(issues[0].body, '\nstatus hangs\nwhen the board is empty');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.bug]);
  assert.match(r.out, /issues\/1\nhx run will triage it\./);
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
