import { E2E, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShell } from '../src/exec.ts';

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
  assert.ok(Date.now() - abortedAt < 5000, `resolved ${Date.now() - abortedAt} ms after the abort`);
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.notEqual(r.code, 0);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the grandchild ${pid} is not left running`);
});

test('runShell: an abort does not block the event loop while the tree is killed', E2E, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-x-'));
  const pidFile = path.join(tmp, 'child.pid');
  writeFileSync(path.join(tmp, 'tree.js'), `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setTimeout(() => {}, 60e3);
`);
  const ac = new AbortController();
  let blocked = -1;
  const poll = setInterval(() => {
    try { readFileSync(pidFile, 'utf8'); } catch { return; }
    clearInterval(poll);
    const t0 = performance.now(); ac.abort(); blocked = performance.now() - t0;
  }, 50);
  const r = await runShell('node tree.js', { cwd: tmp, timeoutMs: 60_000, signal: ac.signal }).finally(() => clearInterval(poll));
  assert.equal(r.aborted, true);
  // a synchronous taskkill held the event loop for its whole run: seconds on a loaded machine (#89)
  assert.ok(blocked >= 0 && blocked < 60, `abort() blocked the event loop for ${Math.round(blocked)} ms`);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the grandchild ${pid} is not left running`);
});

test('runShell: a signal already aborted kills the command at once', E2E, async () => {
  const t0 = Date.now();
  const r = await runShell(`node -e "setTimeout(() => {}, 60e3)"`, { timeoutMs: 60_000, signal: AbortSignal.abort() });
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - t0 < 5000, `resolved in ${Date.now() - t0} ms`);
});

test('runShell: without an abort the result has no aborted flag', E2E, async () => {
  const r = await runShell(`node -e "process.exit(3)"`, { timeoutMs: 60_000, signal: new AbortController().signal });
  assert.equal(r.code, 3);
  assert.equal(r.aborted, undefined);
});
