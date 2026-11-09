import { E2E, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { descendants, hideWindow, killTreeSwept, runShell } from '../src/exec.ts';

test('runShell: an abort kills the whole tree and resolves promptly with aborted set', E2E, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-x-'));
  const pidFile = path.join(tmp, 'child.pid');
  // the shell starts node, which starts a grandchild that sleeps: the abort must reach the grandchild too
  writeFileSync(path.join(tmp, 'tree.js'), `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setTimeout(() => {}, 60e3);
`);
  const ac = new AbortController();
  let abortedAt = 0;
  const poll = setInterval(() => { try { readFileSync(pidFile, 'utf8'); } catch { return; } clearInterval(poll); abortedAt = Date.now(); ac.abort(); }, 50);
  const r = await runShell('node tree.js', { cwd: tmp, timeoutMs: 60_000, signal: ac.signal }).finally(() => clearInterval(poll));
  assert.ok(abortedAt > 0, 'the command started');
  // a bound far below the 60 s grandchild, not a tight one: taskkill alone takes seconds on a loaded machine (#285)
  assert.ok(Date.now() - abortedAt < 20_000, `resolved ${Date.now() - abortedAt} ms after the abort`);
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.notEqual(r.code, 0);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the grandchild ${pid} is not left running`);
});

test('runShell killLater: an abort settles before the tree is killed; killed settles once it is gone (#283)', E2E, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-x-'));
  const pidFile = path.join(tmp, 'child.pid');
  writeFileSync(path.join(tmp, 'tree.js'), `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setTimeout(() => {}, 60e3);
`);
  const ac = new AbortController();
  const poll = setInterval(() => { try { readFileSync(pidFile, 'utf8'); } catch { return; } clearInterval(poll); ac.abort(); }, 50);
  const r = await runShell('node tree.js', { cwd: tmp, timeoutMs: 60_000, signal: ac.signal, killLater: true }).finally(() => clearInterval(poll));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(r.aborted, true);
  assert.ok(r.killed instanceof Promise, 'the kill is handed back to wait on');
  // taskkill is a process of its own: it has not run yet when the abort settles
  if (process.platform === 'win32') assert.ok(alive(pid), `the grandchild ${pid} is still being killed`);
  await r.killed;
  assert.ok(!alive(pid), `the grandchild ${pid} is not left running`);
});

test('runShell: a signal already aborted kills the command at once', E2E, async () => {
  const t0 = Date.now();
  const r = await runShell(`node -e "setTimeout(() => {}, 60e3)"`, { timeoutMs: 60_000, signal: AbortSignal.abort() });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 20_000, `resolved in ${Date.now() - t0} ms, not after the 60 s sleeper`);
});

test('runShell: a signal already aborted starts nothing, so no taskkill is waited on', async () => {
  const r = await runShell(`node -e "setTimeout(() => {}, 60e3)"`, { timeoutMs: 60_000, signal: AbortSignal.abort() });
  assert.equal(r.aborted, true);
  assert.equal(r.code, 130);
  assert.equal(r.pid, undefined, 'no process was spawned');
  await r.killed;
});

test('runShell: without an abort the result has no aborted flag', E2E, async () => {
  const r = await runShell(`node -e "process.exit(3)"`, { timeoutMs: 60_000, signal: new AbortController().signal });
  assert.equal(r.code, 3);
  assert.equal(r.aborted, undefined);
});

test('hideWindow: children get a hidden console of their own unless HX_SHARE_CONSOLE=1 (the tests) shares this one', () => {
  const saved = process.env.HX_SHARE_CONSOLE;
  try {
    delete process.env.HX_SHARE_CONSOLE;
    assert.equal(hideWindow(), true);
    process.env.HX_SHARE_CONSOLE = '0';
    assert.equal(hideWindow(), true);
    process.env.HX_SHARE_CONSOLE = '1';
    assert.equal(hideWindow(), false);
  } finally { if (saved === undefined) delete process.env.HX_SHARE_CONSOLE; else process.env.HX_SHARE_CONSOLE = saved; }
});

test('descendants: every depth by parent id, through a root that has exited; never the roots, a bystander or a self-parented pid', () => {
  const procs = [
    { pid: 2, ppid: 1, cmd: '' }, { pid: 3, ppid: 2, cmd: '' }, { pid: 4, ppid: 9, cmd: '' },
    { pid: 5, ppid: 4, cmd: '' }, { pid: 7, ppid: 6, cmd: '' }, { pid: 0, ppid: 0, cmd: '' },
  ];
  assert.deepEqual(descendants(procs, [1]), [2, 3]);
  assert.deepEqual(descendants(procs, [1, 9]), [2, 4, 3, 5]); // 9 is not listed (it exited): its child 4 still names it
  assert.deepEqual(descendants(procs, [0]), []);
  assert.deepEqual(descendants(procs, [8]), []);
});

test('killTreeSwept: kills the tree, then a process started while it was killed and its child, pass by pass; never a bystander', async () => {
  // the tree 1 → 2 → 3 at the time limit; after the tree kill, 4 (started by 3 meanwhile) runs; it then starts 5
  const listings = [
    [{ pid: 1, ppid: 0, cmd: '' }, { pid: 2, ppid: 1, cmd: '' }, { pid: 3, ppid: 2, cmd: '' }, { pid: 9, ppid: 8, cmd: '' }],
    [{ pid: 4, ppid: 3, cmd: '' }, { pid: 9, ppid: 8, cmd: '' }],
    [{ pid: 5, ppid: 4, cmd: '' }, { pid: 9, ppid: 8, cmd: '' }],
    [{ pid: 9, ppid: 8, cmd: '' }],
  ];
  const calls: string[] = [];
  const killed = await killTreeSwept(1, {
    list: async () => { calls.push('list'); return listings.shift() ?? []; },
    kill: async (pid) => { calls.push(`kill ${pid}`); },
  });
  assert.deepEqual(calls, ['list', 'kill 1', 'list', 'kill 4', 'list', 'kill 5', 'list']);
  assert.deepEqual(killed.sort(), [2, 3, 4, 5]);
});

test('killTreeSwept: at most `passes` sweeps after the tree kill, though new processes keep appearing', async () => {
  // each listing shows a new child of the last pid: 100 → 101 → 102 → …
  let n = 99;
  const calls: string[] = [];
  await killTreeSwept(100, {
    list: async () => { calls.push('list'); n++; return n === 100 ? [] : [{ pid: n, ppid: n - 1, cmd: '' }]; },
    kill: async (pid) => { calls.push(`kill ${pid}`); },
    passes: 2,
  });
  assert.deepEqual(calls, ['list', 'kill 100', 'list', 'kill 101', 'list', 'kill 102']);
});

test('runShell sweep: a time limit kills the whole tree, then settles with timedOut and 124', E2E, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-x-'));
  const pidFile = path.join(tmp, 'child.pid');
  writeFileSync(path.join(tmp, 'tree.js'), `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setTimeout(() => {}, 60e3);
`);
  // far above the second node needs to start its child on a loaded machine; the child must be written before the limit
  const r = await runShell('node tree.js', { cwd: tmp, timeoutMs: 8_000, sweep: true });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the grandchild ${pid} is not left running`);
});
