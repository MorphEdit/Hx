// Own-test coverage for the project benchmark (bench/project-coverage.mjs, PRD #397): a checkout's own `npm test`
// under V8 coverage, counted over its source files. Fixture checkouts live in temp directories whose path holds a space.
import { alive, E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: a plain .mjs bench script
import { codeLines, count, coverage, isTestFile, testEnv } from '../bench/project-coverage.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'project-coverage.mjs');
const PKG = JSON.stringify({ name: 'fx', scripts: { test: 'node --test' } });

/** A fixture checkout in a fresh temp directory with a space in its path; `crlf` writes every file with CRLF. */
function checkout(files: Record<string, string>, crlf = false): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'hx cov ')), 'my checkout');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), crlf ? text.replace(/\n/g, '\r\n') : text);
  }
  return dir;
}
const cleanup = (dir: string) => rmSync(path.dirname(dir), { recursive: true, force: true });

// lib.cjs: size(5) and size(50) leave `s = 'huge'` never run and `s = 'big'` run once of the function's twice. V8
// reports those two blocks (the function's other blocks ran as often as it did): 2 branches, 1 covered. Its 11 lines
// are covered but for `s = 'huge';` and the `}` that closes that block: 9 of 11.
const LIB = `function size(n) {
  let s = 'small';
  if (n > 100) {
    s = 'huge';
  }
  if (n > 10) {
    s = 'big';
  }
  return s;
}
module.exports = { size };
`;
// bin/cli.mjs: 3 lines, all run, in the child process only
const CLI = `import lib from '../lib.cjs';

console.log(lib.size(5));
console.log(lib.size(50));
`;
// unused.mjs: 3 lines nothing loads
const UNUSED = `export function never() {
  return 1;
}
`;
const PROJECT = {
  'package.json': PKG,
  'lib.cjs': LIB,
  'bin/cli.mjs': CLI,
  'unused.mjs': UNUSED,
  // the test only spawns the CLI: lib.cjs and the CLI are never loaded in the test's own process
  'test/cli.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('cli', () => {
  assert.equal(execFileSync(process.execPath, ['bin/cli.mjs'], { encoding: 'utf8' }), 'small\\nbig\\n');
});
`,
  // a test file by name, outside test/: not a source file either
  'lib.test.mjs': `import { test } from 'node:test';\ntest('nothing', () => {});\n`,
  // never source files: node_modules and .hx
  'node_modules/dep/index.js': 'module.exports = 1;\n',
  '.hx/tool.mjs': 'export const a = 1;\n',
};
const EXPECTED = { tests: 'passed', lines: { covered: 12, total: 17 }, branches: { covered: 1, total: 2 } };

/** A test that writes its environment to env.json in the checkout. */
const ENV_TEST = `import { writeFileSync } from 'node:fs';\nwriteFileSync('env.json', JSON.stringify(process.env));\n`;
const envOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'env.json'), 'utf8'));
const tmpRoot = os.tmpdir().toLowerCase();
/** HOME, USERPROFILE and NODE_V8_COVERAGE were fresh temp directories, and both are gone now. */
function tempDirsGone(env: Record<string, string>) {
  assert.ok(env.HOME && env.NODE_V8_COVERAGE);
  assert.equal(env.USERPROFILE, env.HOME);
  assert.notEqual(env.HOME, env.NODE_V8_COVERAGE);
  for (const d of [env.HOME, env.NODE_V8_COVERAGE]) {
    assert.ok(d.toLowerCase().startsWith(tmpRoot), `${d} in the temp directory`);
    assert.equal(existsSync(d), false, `${d} removed`);
  }
}

test('the test files are the ones node --test picks up by default', () => {
  for (const f of ['a.test.js', 'a-test.mjs', 'a_test.cjs', 'test-a.js', 'test.mjs', 'test/a.js', 'src/test/deep/b.cjs',
    path.join('x', 'test', 'c.mjs')]) assert.equal(isTestFile(f), true, f);
  for (const f of ['lib.js', 'contest.js', 'tests/a.js', 'attest.mjs', 'testing.js', 'bin/tally.js']) assert.equal(isTestFile(f), false, f);
});

test('a line is one holding a non-whitespace character, at its first one; CRLF offsets are into the text as read', () => {
  assert.deepEqual(codeLines('a\n\n  b\n \t\n'), [0, 5]);
  assert.deepEqual(codeLines('a\r\n\r\n  b\r\n'), [0, 7]);
});

test('counting: the innermost range decides a line; a branch covered in any process is covered, and counted once', () => {
  const text = 'f(\n  x\n  y\n)\n'; // lines at 0, 5, 9, 11
  const fn = (ranges: [number, number, number][]) => ({ ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) });
  // process 1: y's block not run; process 2: x's block not run
  const p1 = [fn([[0, 13, 1], [9, 10, 0]])];
  const p2 = [fn([[0, 13, 1], [5, 6, 0]]), fn([[8, 11, 2], [9, 10, 2]])];
  assert.deepEqual(count([{ text, runs: [p1, p2] }]),
    { lines: { covered: 4, total: 4 }, branches: { covered: 1, total: 2 } });
  assert.deepEqual(count([{ text, runs: [p1] }]), { lines: { covered: 3, total: 4 }, branches: { covered: 0, total: 1 } });
  // a file no process loaded: every line uncovered
  assert.deepEqual(count([{ text, runs: [] }]), { lines: { covered: 0, total: 4 }, branches: { covered: 0, total: 0 } });
});

test("the own tests' environment: no NODE_TEST*, NODE_OPTIONS, TALLY_LOG or TALLY_NOW; a temp home; coverage on", () => {
  const env = testEnv('C:/cov', 'C:/home', { PATH: 'p', NODE_TEST_CONTEXT: 'child', NODE_OPTIONS: '--x', TALLY_LOG: 'l',
    tally_now: 'n', HOME: 'h', UserProfile: 'u', OTHER: 'o' });
  const merged = { ...{ PATH: 'p', NODE_TEST_CONTEXT: 'child', NODE_OPTIONS: '--x', TALLY_LOG: 'l', tally_now: 'n', HOME: 'h', UserProfile: 'u', OTHER: 'o' }, ...env };
  const kept = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  assert.deepEqual(kept, { PATH: 'p', OTHER: 'o', HOME: 'C:/home', USERPROFILE: 'C:/home', NODE_V8_COVERAGE: 'C:/cov' });
});

test('a passing suite: lines and branches counted through a spawned CLI, test files left out, an unloaded file uncovered; CRLF gives the same', E2E, async () => {
  for (const crlf of [false, true]) {
    const dir = checkout(PROJECT, crlf);
    try {
      assert.deepEqual(await coverage(dir), EXPECTED, crlf ? 'CRLF' : 'LF');
    } finally { cleanup(dir); }
  }
});

test('no test script, or a test script but no test file: none, n/a, n/a', E2E, async () => {
  const none = { tests: 'none', lines: 'n/a', branches: 'n/a' };
  for (const files of [
    { 'package.json': JSON.stringify({ name: 'fx' }), 'lib.cjs': LIB, 'test/a.test.mjs': ENV_TEST },
    { 'lib.cjs': LIB, 'test/a.test.mjs': ENV_TEST }, // no package.json
    { 'package.json': PKG, 'lib.cjs': LIB, 'bin/cli.mjs': CLI },
  ]) {
    const dir = checkout(files);
    try {
      assert.deepEqual(await coverage(dir), none);
      assert.equal(existsSync(path.join(dir, 'env.json')), false, 'npm test not run');
    } finally { cleanup(dir); }
  }
});

test('a failing suite: failed, n/a, n/a, and both temp directories removed', E2E, async () => {
  const dir = checkout({ 'package.json': PKG, 'lib.cjs': LIB,
    'test/a.test.mjs': `${ENV_TEST}import { test } from 'node:test';\ntest('fails', () => { throw new Error('no'); });\n` });
  try {
    assert.deepEqual(await coverage(dir), { tests: 'failed', lines: 'n/a', branches: 'n/a' });
    tempDirsGone(envOf(dir));
  } finally { cleanup(dir); }
});

test('a suite that never ends: killed at the time limit with the child it started, failed, n/a, n/a', E2E, async () => {
  const dir = checkout({ 'package.json': PKG, 'lib.cjs': LIB,
    'test/hang.test.mjs': `${ENV_TEST}import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('hangs', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync('pid.txt', String(child.pid));
  await new Promise(() => {});
});
` });
  try {
    // far above the few seconds the fixture needs to start its child; no upper bound on the call's time is asserted
    assert.deepEqual(await coverage(dir, { timeoutMs: 30_000 }), { tests: 'failed', lines: 'n/a', branches: 'n/a' });
    const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
    assert.ok(pid > 0);
    assert.equal(alive(pid), false, 'the child npm test started is killed');
    tempDirsGone(envOf(dir));
  } finally { cleanup(dir); }
});

test("the own tests run with a temp home, coverage on and no TALLY_LOG or TALLY_NOW, though the caller's environment sets both", E2E, async () => {
  const dir = checkout({ ...PROJECT, 'test/env.test.mjs': ENV_TEST });
  const saved = { TALLY_LOG: process.env.TALLY_LOG, TALLY_NOW: process.env.TALLY_NOW };
  process.env.TALLY_LOG = path.join(dir, 'real.log');
  process.env.TALLY_NOW = '2026-01-01T09:00';
  try {
    assert.deepEqual(await coverage(dir), EXPECTED);
    const env = envOf(dir);
    assert.equal('TALLY_LOG' in env, false);
    assert.equal('TALLY_NOW' in env, false);
    assert.notEqual(env.HOME.toLowerCase(), (process.env.HOME ?? '').toLowerCase());
    assert.notEqual(env.USERPROFILE.toLowerCase(), (process.env.USERPROFILE ?? '').toLowerCase());
    tempDirsGone(env);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    cleanup(dir);
  }
});

test('the CLI prints the result as JSON', E2E, () => {
  const dir = checkout({ 'package.json': JSON.stringify({ name: 'fx' }), 'lib.cjs': LIB });
  try {
    const r = spawnSync(process.execPath, [script, dir, '--timeout-ms', '60000'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { tests: 'none', lines: 'n/a', branches: 'n/a' });
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1, 'usage');
  } finally { cleanup(dir); }
});
