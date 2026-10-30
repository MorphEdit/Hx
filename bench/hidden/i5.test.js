// Hidden acceptance tests for issue #5 (the CLI). Never shown to the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'textstat.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const dir = mkdtempSync(path.join(os.tmpdir(), 'textstat-'));
const file = (name, text) => { const f = path.join(dir, name); writeFileSync(f, text); return f; };
const nl = (s) => s.replace(/\r\n/g, '\n');

test('#5 freq', () => {
  const f = file('a.txt', 'b a b c a b');
  let r = run('freq', f);
  assert.equal(r.status, 0);
  assert.equal(nl(r.stdout), 'b 3\na 2\nc 1\n');
  r = run('freq', '--top', '1', f);
  assert.equal(r.status, 0);
  assert.equal(nl(r.stdout), 'b 3\n');
});

test('#5 slug', () => {
  const r = run('slug', 'Héllo', 'Wörld');
  assert.equal(r.status, 0);
  assert.equal(nl(r.stdout), 'hello-world\n');
});

test('#5 time', () => {
  const f = file('w.txt', Array.from({ length: 250 }, () => 'w').join(' '));
  let r = run('time', '--wpm', '100', f);
  assert.equal(r.status, 0);
  assert.equal(nl(r.stdout), '3 min\n');
  r = run('time', f);
  assert.equal(nl(r.stdout), '2 min\n');
});

test('#5 errors and exit codes', () => {
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /freq/);
  assert.match(r.stderr, /slug/);
  assert.match(r.stderr, /time/);
  r = run('nope');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0);
  r = run('freq', path.join(dir, 'missing.txt'));
  assert.equal(r.status, 2);
  assert.ok(r.stderr.length > 0);
});
