// The run log: every log() line also lands in <stateDir>/run.log while `hx run` has set it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, runLogFile, setRunLog } from '../src/pool.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-log-'));
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean);
let n = 0;
const dir = () => mkdtempSync(path.join(tmp, `d${n++}-`));

// console.log is captured so the tests stay quiet and can check log() still prints
let printed: string[] = [];
const orig = console.log;
const capture = () => { printed = []; console.log = (...a: unknown[]) => { printed.push(a.join(' ')); }; };
afterEach(() => { console.log = orig; setRunLog(null); });

test('runLogFile is <stateDir>/run.log', () => {
  assert.equal(runLogFile(path.join('x', '.hx')), path.join('x', '.hx', 'run.log'));
});

test('log() appends `<ISO> #<n> <msg>` and `<ISO> - <msg>`, one line per call', () => {
  const f = runLogFile(path.join(dir(), '.hx')); // the directory is created on the first line
  capture();
  setRunLog(f);
  log('x', 7);
  log('y');
  log('two\nlines\r\nhere', 3);
  assert.equal(printed.length, 3, 'still prints');
  const l = lines(f);
  assert.equal(l.length, 3);
  assert.match(l[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z #7 x$/);
  assert.match(l[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z - y$/);
  assert.match(l[2], /^\d{4}-\d\d-\d\dT[\d:.]+Z #3 two lines here$/);
  assert.ok(!Number.isNaN(Date.parse(l[0].split(' ')[0])));
});

test('unset: log() only prints', () => {
  const d = dir();
  capture();
  log('nothing written', 1);
  assert.equal(printed.length, 1);
  assert.deepEqual(readdirSync(d), []);
});

test('rotation: past maxBytes run.log becomes run.log.1, and only one old file is kept', () => {
  const d = dir();
  const f = path.join(d, 'run.log');
  capture();
  setRunLog(f, 200); // a padded line is 56 bytes: the 5th line rotates
  for (let i = 0; i < 4; i++) log(`first ${i} ${'.'.repeat(20)}`);
  log('second 0');
  assert.deepEqual(readdirSync(d).sort(), ['run.log', 'run.log.1']);
  assert.equal(lines(f + '.1').length, 4);
  assert.match(lines(f + '.1')[0], / - first 0 /);
  assert.deepEqual(lines(f).map((l) => l.replace(/^\S+ /, '')), ['- second 0']);
  for (let i = 1; i < 4; i++) log(`second ${i} ${'.'.repeat(20)}`);
  log('third 0');
  assert.deepEqual(readdirSync(d).sort(), ['run.log', 'run.log.1'], 'never more than two files');
  assert.ok(lines(f + '.1').every((l) => / - second /.test(l)), 'the second rotation replaced run.log.1');
  assert.deepEqual(lines(f).map((l) => l.replace(/^\S+ /, '')), ['- third 0']);
});

test('a path that cannot be written: log() does not throw and still prints', () => {
  const d = dir();
  const file = path.join(d, 'file');
  writeFileSync(file, 'a regular file');
  capture();
  setRunLog(path.join(file, 'run.log')); // the parent is a regular file
  assert.doesNotThrow(() => log('dropped', 2));
  setRunLog(d); // a directory: append fails
  assert.doesNotThrow(() => log('dropped too'));
  assert.equal(printed.length, 2);
  assert.ok(!existsSync(path.join(file, 'run.log')));
});
