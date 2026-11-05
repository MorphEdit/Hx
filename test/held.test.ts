// A held merge (#301): the failing-test parser, the hold decision, .hx/held.json, and `held (main red)` in hx status.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failingTests, heldComment, HELD_MARKER, HELD_STATUS, mergeFailure, readHeld, setHeld } from '../src/held.ts';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-held-'));
const L = DEFAULTS.labels;

const SPEC = `✔ ok one (0.1ms)
✖ X works (0.5886ms)
ℹ tests 2
ℹ fail 1

✖ failing tests:

test at a.test.mjs:2:1
✖ X works (0.5886ms)
  Error: a`;

test('failingTests: node spec and TAP, jest, pytest and go; no duplicates, the summary heading and TODO / SKIP left out', E2E, () => {
  assert.deepEqual(failingTests(SPEC), ['X works']);
  assert.deepEqual(failingTests('TAP version 13\n# Subtest: a\nnot ok 1 - a\n    not ok 1 - inner one\nok 2 - b\nnot ok 3 - c # TODO later\nnot ok 4 - d # SKIP'), ['a', 'inner one']);
  assert.deepEqual(failingTests('  ✕ adds (5 ms)\n  ✓ subtracts (1 ms)'), ['adds']);
  assert.deepEqual(failingTests('FAILED tests/test_a.py::test_one - AssertionError: x\nPASSED tests/test_a.py::test_two'), ['tests/test_a.py::test_one']);
  assert.deepEqual(failingTests('--- FAIL: TestParse (0.00s)\n--- PASS: TestOk (0.00s)'), ['TestParse']);
  assert.deepEqual(failingTests('Error: something broke\nexit 1'), [], 'no known shape: none');
});

const red = (output: string) => ({ sha: 'abc', ok: false, command: 'npm test', output, at: '2026-11-05T00:00:00Z' });

test('mergeFailure: held only when the gate is red and every failing test also fails on main', E2E, () => {
  assert.deepEqual(mergeFailure('ship: tests failed\n✖ X works (1ms)', red(SPEC)), { held: true });
  assert.deepEqual(mergeFailure('not ok 1 - X works\nnot ok 2 - Y', red(SPEC)), { held: false, notOnMain: ['Y'] });
  assert.deepEqual(mergeFailure('not ok 1 - Y', red(SPEC)), { held: false, notOnMain: ['Y'] });
  // nothing to compare: back to the implementer, nothing named
  assert.deepEqual(mergeFailure('exit 1', red(SPEC)), { held: false, notOnMain: [] });
  assert.deepEqual(mergeFailure('✖ X works (1ms)', { ...red(SPEC), ok: true }), { held: false, notOnMain: [] }, 'green main');
  assert.deepEqual(mergeFailure('✖ X works (1ms)', undefined), { held: false, notOnMain: [] }, 'no gate result');
  assert.deepEqual(mergeFailure('✖ X works (1ms)', { ...red(SPEC), setupFailed: true }), { held: false, notOnMain: [] }, 'a setup failure names no test');
});

test('.hx/held.json: set, read and cleared; an unreadable file reads as none', E2E, () => {
  const dir = path.join(tmp, 'state');
  mkdirSync(dir);
  assert.deepEqual(readHeld(dir), {});
  setHeld(dir, 7, { pr: 70, round: 1, at: 't' });
  setHeld(dir, 8, { pr: 80, round: 2, at: 't' });
  assert.deepEqual(readHeld(dir), { 7: { pr: 70, round: 1, at: 't' }, 8: { pr: 80, round: 2, at: 't' } });
  setHeld(dir, 7, undefined);
  assert.deepEqual(Object.keys(readHeld(dir)), ['8']);
  writeFileSync(path.join(dir, 'held.json'), '{nope');
  assert.deepEqual(readHeld(dir), {});
});

test('the held comment starts with its marker and names the gate-fix issue', E2E, () => {
  const b = heldComment('main', 288, 277);
  assert.ok(b.startsWith(`${HELD_MARKER}\n`));
  assert.match(b, /held: main is red \(#288\); merges once main is green/);
  assert.match(b, /PR #277/);
});

test(`hx status shows a held issue as ${HELD_STATUS}`, E2E, () => {
  const root = path.join(tmp, 'status'), sd = path.join(root, '.hx'), b = path.join(tmp, 'board-status.json');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-status') } as any);
  setHeld(sd, 3, { pr: 30, round: 1, at: new Date().toISOString() });
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [
    { number: 3, title: 'held task', body: 't', state: 'OPEN', labels: [L.ready] },
    { number: 4, title: 'plain task', body: 't', state: 'OPEN', labels: [L.ready] },
  ] }));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'status'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}#3 +held \(main red\) +held task$/m, r.stdout);
  assert.match(r.stdout, /^ {2}#4 +claimable +plain task$/m, r.stdout);
});
