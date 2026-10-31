// test/isolate.ts: what a live `hx run` or the user's git setup leaves in the environment never reaches the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('isolate: HX_* / FAKE_* / GIT_DIR from the caller are dropped, git gets an empty global config', () => {
  const code = `await import(${JSON.stringify(pathToFileURL(path.join(here, 'isolate.ts')).href)});
    console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HX_|FAKE_|GIT_)/.test(k)))));`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: 'real-gh', HX_SHIP_TEST_TIMEOUT_MS: '1', FAKE_CLAUDE_DELAY_MS: '99999', GIT_DIR: 'C:/elsewhere/.git' } });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(env).filter((k) => /^(HX_|FAKE_)/.test(k)), []);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(env.GIT_CONFIG_GLOBAL);
});

test('every end-to-end test file (fake gh / claude, ship.mjs, runPool) imports isolate.ts first and gives each test() E2E', () => {
  const e2e = readdirSync(here).filter((f) => f.endsWith('.test.ts') && f !== 'isolate.test.ts')
    .map((f) => ({ f, src: readFileSync(path.join(here, f), 'utf8') }))
    .filter(({ src }) => /fakes|ship\.mjs|runPool/.test(src));
  assert.ok(e2e.some(({ f }) => f === 'cleanup.test.ts'), e2e.map(({ f }) => f).join());
  for (const { f, src } of e2e) {
    const firstImport = src.split(/\r?\n/).find((l) => /^import /.test(l));
    assert.match(firstImport ?? '', /from '\.\/isolate\.ts'/, `${f}: isolate.ts is not the first import`);
    const tests = src.split(/\r?\n/).filter((l) => /^test\(/.test(l));
    assert.ok(tests.length > 0, f);
    for (const t of tests) assert.match(t, /, E2E, /, `${f}: no E2E timeout: ${t}`);
  }
});

test('every runPool in a test runs through pooled(), so it stops when its test ends', () => {
  const calls = readdirSync(here).filter((f) => f.endsWith('.test.ts'))
    .flatMap((f) => readFileSync(path.join(here, f), 'utf8').split(/\r?\n/).filter((l) => /\brunPool\(/.test(l)).map((l) => ({ f, l })));
  assert.ok(calls.length >= 15, `${calls.length}`);
  for (const { f, l } of calls) assert.match(l, /pooled\(\(signal\) => runPool\(/, `${f}: ${l.trim()}`);
});

test('pooled: a test that times out stops its pool before the next test starts; a passing test is left alone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-iso-'));
  const isolate = JSON.stringify(pathToFileURL(path.join(here, 'isolate.ts')).href);
  // a "pool" that runs until its signal aborts, then takes 300 ms to wind down (a checkpoint turn)
  writeFileSync(path.join(dir, 'cascade.test.ts'), `import { E2E, pooled } from ${isolate};
import { test } from 'node:test';
let state = 'idle';
const pool = (signal: AbortSignal) => new Promise<void>((r) => {
  state = 'running';
  signal.addEventListener('abort', () => setTimeout(() => { state = 'stopped'; r(); }, 300), { once: true });
});
test('slow', { timeout: 200 }, async () => { await pooled(pool); });
test('next', E2E, () => { console.log('NEXT SAW ' + state); });
test('own signal', E2E, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await pooled(pool, ac.signal);
  console.log('OWN ' + state);
});
test('passes', E2E, async () => {
  let seen = '';
  await pooled(async (signal) => { await new Promise((r) => setTimeout(r, 50)); seen = String(signal.aborted); });
  console.log('PASSING ABORTED ' + seen);
});
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a node --test of its own, not a child of this one
  const r = spawnSync(process.execPath, ['--test', '--disable-warning=ExperimentalWarning', path.join(dir, 'cascade.test.ts')], { encoding: 'utf8', env });
  const out = r.stdout + r.stderr;
  assert.match(out, /✖ slow/, out);
  assert.match(out, /NEXT SAW stopped/, out);
  assert.match(out, /OWN stopped/, out);
  assert.match(out, /PASSING ABORTED false/, out);
  assert.match(out, /ℹ pass 3/, out);
});

test('deadPid is a pid no process can have, not an exited one Windows may already have handed out again', () => {
  const code = `const { deadPid } = await import(${JSON.stringify(pathToFileURL(path.join(here, 'isolate.ts')).href)});
    const p = deadPid(); let alive = true; try { process.kill(p, 0); } catch (e) { alive = e.code === 'EPERM'; }
    console.log(JSON.stringify({ p, alive }));`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8' });
  const { p, alive } = JSON.parse(r.stdout.trim().split('\n').pop()!);
  assert.equal(alive, false);
  assert.ok(p > 2 ** 22, `pid ${p} is in the range the OS hands out`);
  assert.equal(p % 4, 0, 'Windows ignores the low two bits of a pid');
});
