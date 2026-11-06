// npm test runs scripts/test.mjs (#349): node --test over the suite or over only the files given, at most
// HX_TEST_CONCURRENCY test files at once. A fake node (HX_NODE_BIN) records its argv and exits with a chosen code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SCRIPT = path.join(root, 'scripts', 'test.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tst-'));
const NODE = path.join(tmp, 'node.mjs');
writeFileSync(NODE, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HX_FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.HX_FAKE_EXIT ?? 0));
`);

let k = 0;
function run(args: string[], conc?: string, code = 0) {
  const out = path.join(tmp, `argv${k++}.json`);
  const env: NodeJS.ProcessEnv = { ...process.env, HX_NODE_BIN: NODE, HX_FAKE_ARGV: out, HX_FAKE_EXIT: String(code) };
  delete env.HX_TEST_CONCURRENCY;
  if (conc !== undefined) env.HX_TEST_CONCURRENCY = conc;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: r.status, argv: JSON.parse(readFileSync(out, 'utf8')) as string[] };
}
const HEAD = ['--test', '--disable-warning=ExperimentalWarning'];

test('HX_TEST_CONCURRENCY=3, no arguments: the whole suite, 3 files at a time', () => {
  assert.deepEqual(run([], '3').argv, [...HEAD, '--test-concurrency=3', 'test/**/*.test.ts']);
});

test('files given: passed through unchanged and in order, no default glob', () => {
  assert.deepEqual(run(['--test-reporter=spec', 'a.test.ts', 'b.test.ts']).argv,
    [...HEAD, '--test-reporter=spec', 'a.test.ts', 'b.test.ts']);
  assert.deepEqual(run(['b.test.ts', 'a.test.ts'], '2').argv, [...HEAD, '--test-concurrency=2', 'b.test.ts', 'a.test.ts']);
});

test('only options given: the default glob is added after them', () => {
  assert.deepEqual(run(['--test-reporter=spec']).argv, [...HEAD, '--test-reporter=spec', 'test/**/*.test.ts']);
});

test('HX_TEST_CONCURRENCY unset, empty, 0, abc, -2 or 1.5: no --test-concurrency', () => {
  for (const c of [undefined, '', '0', 'abc', '-2', '1.5']) {
    const a = run(['a.test.ts'], c).argv;
    assert.ok(!a.some((x) => x.startsWith('--test-concurrency')), `${c}: ${a.join(' ')}`);
    assert.deepEqual(a, [...HEAD, 'a.test.ts'], String(c));
  }
});

test('a --test-concurrency=2 argument wins over HX_TEST_CONCURRENCY=5', () => {
  const a = run(['--test-concurrency=2', 'a.test.ts'], '5').argv;
  assert.deepEqual(a.filter((x) => x.startsWith('--test-concurrency')), ['--test-concurrency=2']);
  assert.deepEqual(a, [...HEAD, '--test-concurrency=2', 'a.test.ts']);
});

test("the wrapper exits with node's exit code", () => {
  assert.equal(run([], undefined, 0).status, 0);
  assert.equal(run([], undefined, 7).status, 7);
});

test('npm test is the wrapper; with HX_TEST_CONCURRENCY unset it starts node as the old script did', () => {
  const s = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(s.test, 'node scripts/test.mjs');
  // the old script: node --test --disable-warning=ExperimentalWarning "test/**/*.test.ts"
  assert.deepEqual(run([]).argv, ['--test', '--disable-warning=ExperimentalWarning', 'test/**/*.test.ts']);
});

test("the wrapper's comment states what the NODE_OPTIONS check found", () => {
  assert.match(readFileSync(SCRIPT, 'utf8'), /--test-concurrency` in NODE_OPTIONS \("is not allowed in\n\/\/ NODE_OPTIONS"/);
});

test('the impl and audit prompts limit the agent\'s own test runs to HX_TEST_CONCURRENCY files', () => {
  for (const f of ['impl.md', 'audit.md']) {
    const p = readFileSync(path.join(root, 'prompts', f), 'utf8');
    assert.ok(p.includes('HX_TEST_CONCURRENCY'), f);
    assert.ok(p.includes('--test-concurrency=$HX_TEST_CONCURRENCY'), f);
    assert.ok(p.includes('npm test -- <files>'), f);
  }
});
