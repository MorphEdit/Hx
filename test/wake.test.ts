// The filing commands' wake file and closing line: nextLine for every runner/pause fixture, and writeWake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextLine, setPause, writeLive, writeWake, type LiveState } from '../src/runstate.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-wake-'));
const deadPid = spawnSync(process.execPath, ['-e', '']).pid!;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let n = 0;
function dir(live?: Partial<LiveState>, pause = false): string {
  const d = path.join(tmp, `s${n++}`);
  mkdirSync(d);
  if (live) writeLive(d, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'o/r', workers: 1, sessions: [], ...live });
  if (pause) setPause(d, 'drain');
  return d;
}

const D = 'It will be decomposed into issues. ';
const T = 'It will be triaged. ';
const PICK = `hx run (pid ${process.pid}) will pick it up now.`;
const PAUSING = `hx run (pid ${process.pid}) is pausing — run  hx resume  to continue.`;
const NONE = 'no hx run is running — start it with  hx run --watch';
const NONE_PAUSED = 'no hx run is running and hx is paused — run  hx resume, then  hx run --watch';

test('nextLine: live runner, no pause file → will pick it up now', () => {
  const d = dir({});
  assert.equal(nextLine(d, 'decompose'), D + PICK);
  assert.equal(nextLine(d, 'triage'), T + PICK);
});

test('nextLine: live runner plus a pause file → is pausing (drain or now)', () => {
  assert.equal(nextLine(dir({}, true), 'decompose'), D + PAUSING);
  const d = dir({});
  setPause(d, 'now');
  assert.equal(nextLine(d, 'triage'), T + PAUSING);
});

test('nextLine: live runner draining, no pause file → is pausing', () => {
  assert.equal(nextLine(dir({ draining: true }), 'decompose'), D + PAUSING);
});

test('nextLine: a pause file counts even when the runner says draining false', () => {
  assert.equal(nextLine(dir({ draining: false }, true), 'decompose'), D + PAUSING);
});

test('nextLine: a usage hold or a red gate does not change the line', () => {
  assert.equal(nextLine(dir({ pausedUntil: Date.now() + 3_600_000, pauseReason: 'usage' }), 'decompose'), D + PICK);
  assert.equal(nextLine(dir({ gate: { ok: false, sha: 'abc', at: new Date().toISOString() } }), 'triage'), T + PICK);
});

test('nextLine: dead pid or no live.json, no pause file → no hx run is running', () => {
  assert.equal(nextLine(dir({ pid: deadPid }), 'decompose'), D + NONE);
  assert.equal(nextLine(dir(), 'triage'), T + NONE);
});

test('nextLine: dead pid or no live.json plus a pause file → no runner and paused', () => {
  assert.equal(nextLine(dir({ pid: deadPid }, true), 'decompose'), D + NONE_PAUSED);
  assert.equal(nextLine(dir(undefined, true), 'triage'), T + NONE_PAUSED);
});

test('nextLine: a corrupt live.json is no runner', () => {
  const d = dir();
  writeFileSync(path.join(d, 'live.json'), '{not json');
  assert.equal(nextLine(d, 'decompose'), D + NONE);
});

test('writeWake writes <stateDir>/wake with the current ISO time; a second write overwrites it', () => {
  const d = dir();
  const before = Date.now();
  writeWake(d);
  const t = readFileSync(path.join(d, 'wake'), 'utf8').trim();
  assert.match(t, ISO);
  assert.ok(Date.parse(t) >= before - 1000 && Date.parse(t) <= Date.now());
  writeWake(d);
  assert.match(readFileSync(path.join(d, 'wake'), 'utf8').trim(), ISO);
});
