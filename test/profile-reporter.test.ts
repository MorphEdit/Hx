// npm run test:profile: the reporter writes test-profile.json (file, name, duration per test, slowest first) and
// prints the 20 slowest. Its pure parts on made-up events, then the real reporter over a small test file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const reporter = path.join(here, 'profile-reporter.mjs');
const { collect, profile, slowest } = await import(pathToFileURL(reporter).href);

const ev = (type: string, data: any) => ({ type, data });
test('collect: one record per test (not per suite), its file relative to cwd, its suites in its name, slowest first', () => {
  const cwd = path.resolve('/r');
  const f = path.join(cwd, 'test', 'a.test.ts');
  const tests = collect([
    ev('test:start', { file: f, nesting: 0, name: 'suite' }),
    ev('test:start', { file: f, nesting: 1, name: 'fast' }),
    ev('test:pass', { file: f, nesting: 1, name: 'fast', details: { duration_ms: 1.4 } }),
    ev('test:start', { file: f, nesting: 1, name: 'slow' }),
    ev('test:fail', { file: f, nesting: 1, name: 'slow', details: { duration_ms: 2500.6 } }),
    ev('test:pass', { file: f, nesting: 0, name: 'suite', details: { duration_ms: 2502, type: 'suite' } }),
    ev('test:start', { file: f, nesting: 0, name: 'top' }),
    ev('test:pass', { file: f, nesting: 0, name: 'top', skip: true, details: { duration_ms: 0 } }),
  ], cwd);
  assert.deepEqual(tests, [
    { file: 'test/a.test.ts', name: 'suite > slow', ms: 2501, ok: false },
    { file: 'test/a.test.ts', name: 'suite > fast', ms: 1, ok: true },
    { file: 'test/a.test.ts', name: 'top', ms: 0, ok: true, skip: true },
  ]);
  assert.deepEqual(profile(tests), { count: 3, totalMs: 2502, tests });
});

test('slowest: a header with the count and summed time, then the n slowest, one line each', () => {
  const tests = Array.from({ length: 25 }, (_, i) => ({ file: 'test/x.test.ts', name: `t${i}`, ms: (25 - i) * 1000, ok: true }));
  const lines = slowest(tests).trimEnd().split('\n');
  assert.equal(lines[0], '20 slowest of 25 tests (325.0 s summed):');
  assert.equal(lines.length, 21);
  assert.equal(lines[1], '  25.0 s  test/x.test.ts  t0');
  assert.equal(lines[20], '   6.0 s  test/x.test.ts  t19');
  assert.equal(slowest(tests, 2).trimEnd().split('\n').length, 3);
});

test('the reporter under node --test writes test-profile.json and prints the slowest', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-prof-'));
  writeFileSync(path.join(tmp, 'a.test.mjs'), `import { test } from 'node:test';
test('quick', () => {});
test('slower', async () => { await new Promise((r) => setTimeout(r, 120)); });
`);
  // NODE_TEST_CONTEXT unset: inside a test, a child node --test would report to this runner instead of its reporters
  const r = spawnSync(process.execPath, ['--test', `--test-reporter=${pathToFileURL(reporter).href}`, '--test-reporter-destination=stdout', 'a.test.mjs'],
    { cwd: tmp, encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), HX_TEST_PROFILE: '' } });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(readFileSync(path.join(tmp, 'test-profile.json'), 'utf8'));
  assert.equal(p.count, 2);
  assert.deepEqual(p.tests.map((t: any) => [t.file, t.name, t.ok]), [['a.test.mjs', 'slower', true], ['a.test.mjs', 'quick', true]]);
  assert.ok(p.tests[0].ms >= 100 && Number.isInteger(p.tests[0].ms), String(p.tests[0].ms));
  assert.equal(p.totalMs, p.tests[0].ms + p.tests[1].ms);
  assert.match(r.stdout, /2 slowest of 2 tests \([\d.]+ s summed\):\n +[\d.]+ s  a\.test\.mjs  slower\n +[\d.]+ s  a\.test\.mjs  quick\n/);
  assert.match(r.stdout, /wrote test-profile\.json/);
});

test('npm run test:profile runs the whole suite with the spec reporter and this one', () => {
  const s = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).scripts;
  assert.match(s['test:profile'], /--test-reporter=spec .*--test-reporter=\.\/test\/profile-reporter\.mjs/);
  assert.ok(s['test:profile'].includes('"test/**/*.test.ts"'));
});
