import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (...a) => spawnSync(process.execPath, ['bin/textstat.js', ...a], { encoding: 'utf8' });
const dir = mkdtempSync(path.join(os.tmpdir(), 'ts-'));

test('textstat CLI', () => {
  const f = path.join(dir, 'a.txt');
  writeFileSync(f, 'b a b c a b');
  assert.equal(run('freq', f).stdout.replace(/\r/g, ''), 'b 3\na 2\nc 1\n');
  assert.equal(run('slug', 'Hello', 'World').stdout.trim(), 'hello-world');
  writeFileSync(f, Array.from({ length: 250 }, () => 'w').join(' '));
  assert.equal(run('time', '--wpm', '100', f).stdout.trim(), '3 min');
  assert.equal(run('nope').status, 1);
});
