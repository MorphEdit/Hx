import { E2E, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hideWindow, runShell } from '../src/exec.ts';

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
  assert.ok(Date.now() - t0 < 5000, `resolved in ${Date.now() - t0} ms`);
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
