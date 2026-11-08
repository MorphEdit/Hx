// The differential fuzz of the project benchmark (bench/project-fuzz.mjs, PRD #397): generated cases run against a
// checkout and against the reference, divergences sorted into root-cause classes. Fixture checkouts are copies of the
// reference with one behaviour changed, in temp directories whose path holds a space.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: a plain .mjs bench script
import { caseEnv, cliOf, differs, fault, fuzz, genHash } from '../bench/project-fuzz.mjs';
// @ts-ignore: a plain .mjs bench script
import { FEATURES, generate } from '../bench/project-fuzz-gen.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'bench', 'project-fuzz.mjs');
const reference = path.join(root, 'bench', 'project', 'reference');
// far above a node start on a loaded machine (#285), where the point is not a timeout
const LIMIT = 120_000;

const dirs: string[] = [];
/** A fresh directory whose path holds a space. */
function spaced(): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'hx fuzz ')), 'my checkout');
  mkdirSync(dir);
  dirs.push(path.dirname(dir));
  return dir;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A copy of the reference with `from` replaced by `to` in `file`. */
function patched(file: string, from: string, to: string): string {
  const dir = spaced();
  cpSync(reference, dir, { recursive: true });
  const f = path.join(dir, file);
  const text = readFileSync(f, 'utf8');
  assert.ok(text.includes(from), `${file} holds ${from}`);
  writeFileSync(f, text.replace(from, to));
  return dir;
}

/** A copy of the reference whose bin runs `pre` first (a module body: it may end the process) and then the reference. */
function wrapped(pre: string): string {
  const dir = spaced();
  cpSync(reference, dir, { recursive: true });
  writeFileSync(path.join(dir, 'bin', 'wrap.js'), `${pre}\nawait import('./tally.js');\n`);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, bin: { tally: 'bin/wrap.js' } }));
  return dir;
}

type Bytes = { base64: string; text: string } | null;
const raw = (b: Bytes) => (b === null ? null : Buffer.from(b.base64, 'base64'));
type Example = { case: { id: number; feature: string; args: string[]; log: Bytes }; env: { TALLY_NOW: string; logExisted: boolean };
  reference: any; arm: any; reason?: string };

/** Every example holds the case, its environment and both sides' results, as generated; at most 10, in case order. */
function checkExamples(examples: Example[], count: number, withArm = true) {
  const cases = generate({ count });
  assert.ok(examples.length > 0 && examples.length <= 10);
  const ids = examples.map((e) => e.case.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  for (const e of examples) {
    const c = cases[e.case.id];
    assert.equal(e.case.feature, c.feature);
    assert.deepEqual(e.case.args, c.args);
    assert.deepEqual(raw(e.case.log), c.log);
    assert.deepEqual(e.env, { TALLY_NOW: c.now, TALLY_LOG: 'tally.log', logExisted: c.log !== null });
    for (const side of withArm ? [e.reference, e.arm] : [e.reference]) {
      for (const k of ['stdout', 'stderr']) assert.equal(raw(side[k])!.toString('utf8'), side[k].text);
      assert.ok('status' in side && 'signal' in side && 'timedOut' in side && 'log' in side);
    }
  }
}

test('a CRLF bug reached by line-endings cases: one class, line-endings / …, with examples', E2E, async () => {
  // the log's lines lose only trailing spaces and tabs: a CR before the LF stays on the line
  const arm = patched('src/tally.js', String.raw`raw.replace(/\s+$/, '')`, String.raw`raw.replace(/[ \t]+$/, '')`);
  const r = await fuzz(arm, { count: 70, timeLimitMs: LIMIT });
  const keys = Object.keys(r.classes);
  assert.equal(keys.length, 1, JSON.stringify(r.classes));
  assert.match(keys[0], /^line-endings \/ /);
  assert.ok(r.divergences > 0);
  assert.equal(r.classes[keys[0]], r.divergences);
  checkExamples(r.examples[keys[0]], 70);
  assert.equal(r.excluded.count, 0);
});

test('a malformed TALLY_NOW that exits 2: exactly the one class bad-now / exit status', E2E, async () => {
  const arm = patched('bin/tally.js', 'time: ${v}`);', 'time: ${v}`, 2);');
  const r = await fuzz(arm, { count: 70, timeLimitMs: LIMIT });
  assert.deepEqual(Object.keys(r.classes), ['bad-now / exit status']);
  checkExamples(r.examples['bad-now / exit status'], 70);
});

test('7 minutes past a quarter rounding up: exactly the one class rounding / stdout; the same seed twice, the same result', E2E, async () => {
  const arm = patched('src/tally.js', 'Math.floor((m + 7) / 15)', 'Math.floor((m + 8) / 15)');
  const r = await fuzz(arm, { count: 70, timeLimitMs: LIMIT });
  assert.deepEqual(Object.keys(r.classes), ['rounding / stdout']);
  checkExamples(r.examples['rounding / stdout'], 70);
  // again, with a different pool size: the cases finish in another order, the result is the same
  assert.deepEqual(await fuzz(arm, { count: 70, timeLimitMs: LIMIT, concurrency: 3 }), r);
  assert.equal(r.seed, 1107);
  assert.equal(r.count, 70);
  assert.equal(r.timeLimitMs, LIMIT);
  assert.equal(r.genHash, genHash());
});

test('the reference against itself: 0 divergences, no class', E2E, async () => {
  const count = 40; // the first 39 cases reach every feature
  assert.deepEqual(new Set(generate({ count }).map((c: { feature: string }) => c.feature)), new Set([...FEATURES, 'plain']));
  const r = await fuzz(reference, { reference, count, timeLimitMs: LIMIT });
  assert.equal(r.divergences, 0);
  assert.deepEqual(r.classes, {});
  assert.deepEqual(r.examples, {});
  assert.deepEqual(r.excluded, { count: 0, examples: [] });
});

test('genHash is the SHA-256 of the generator with CRLF read as LF; another seed records itself', E2E, async () => {
  const gen = path.join(root, 'bench', 'project-fuzz-gen.mjs');
  const lf = readFileSync(gen, 'utf8').replace(/\r\n/g, '\n');
  const want = createHash('sha256').update(lf).digest('hex');
  assert.equal(genHash(), want);
  // the same source with CRLF endings hashes the same
  const crlf = path.join(spaced(), 'gen.mjs');
  writeFileSync(crlf, lf.replace(/\n/g, '\r\n'));
  assert.equal(genHash(crlf), want);
  const r = await fuzz(reference, { count: 2, seed: 42, timeLimitMs: 30_000 });
  assert.deepEqual([r.seed, r.count, r.timeLimitMs, r.genHash], [42, 2, 30_000, want]);
});

test('an arm that hangs: a … / timed out divergence', E2E, async () => {
  // it never exits on `csv`; ids 10, 12 and 13 of the first 14 cases run `csv`
  const count = 14;
  const csv = generate({ count }).filter((c: { args: string[] }) => c.args[0] === 'csv');
  assert.ok(csv.length > 0);
  const arm = wrapped(`if (process.argv[2] === 'csv') await new Promise(() => setInterval(() => {}, 1 << 30));`);
  const r = await fuzz(arm, { count, timeLimitMs: 10_000 });
  const timed = Object.keys(r.classes).filter((k) => k.endsWith(' / timed out'));
  assert.ok(timed.length > 0, JSON.stringify(r.classes));
  for (const k of timed) for (const e of r.examples[k]) assert.equal(e.arm.timedOut, true);
  const csvIds = new Set(csv.map((c: { id: number }) => c.id));
  const excluded = new Set(r.excluded.examples.map((e: Example) => e.case.id));
  for (const id of csvIds) if (!excluded.has(id)) {
    assert.ok(timed.some((k) => r.examples[k].some((e: Example) => e.case.id === id)), `case ${id} timed out`);
  }
});

test('a reference that crashes on some cases: those cases excluded and reported, never divergences', E2E, async () => {
  const count = 40;
  const crash = generate({ count }).filter((c: { args: string[] }) => c.args[0] === 'add' || c.args[0] === 'start');
  assert.ok(crash.length > 10);
  const ref = wrapped(`if (process.argv[2] === 'add' || process.argv[2] === 'start') throw new Error('boom');`);
  // the arm is the plain reference: it agrees with the fixture wherever the fixture does not crash
  const r = await fuzz(reference, { reference: ref, count, timeLimitMs: LIMIT });
  assert.equal(r.excluded.count, crash.length);
  assert.equal(r.divergences, 0);
  assert.deepEqual(r.classes, {});
  assert.deepEqual(r.excluded.examples.map((e: Example) => e.case.id), crash.slice(0, 10).map((c: { id: number }) => c.id));
  checkExamples(r.excluded.examples, count, false);
  for (const e of r.excluded.examples) {
    assert.equal(e.reason, 'crashed');
    assert.match(raw(e.reference.stderr)!.toString('utf8'), /^Node\.js v\d/m);
  }
});

test('an arm with no CLI: every case under the one class no CLI, at most 10 examples', E2E, async () => {
  const none = spaced(); // no package.json
  const missing = spaced();
  writeFileSync(path.join(missing, 'package.json'), JSON.stringify({ name: 'x', bin: { tally: 'bin/tally.js' } }));
  for (const arm of [none, missing]) {
    const r = await fuzz(arm, { count: 12, timeLimitMs: LIMIT });
    assert.deepEqual(r.classes, { 'no CLI': 12 });
    assert.equal(r.divergences, 12);
    assert.deepEqual(r.examples['no CLI'].map((e: Example) => e.case.id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(r.examples['no CLI'][0].arm, null);
  }
});

test('a reference with no CLI is an error', async () => {
  await assert.rejects(fuzz(reference, { reference: spaced(), count: 1 }), /no CLI/);
});

test('the CLI on a side: package.json bin (a string) or bin.tally, an existing file, resolved against the checkout', () => {
  const dir = spaced();
  const pkg = (bin: unknown) => writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ bin }));
  assert.equal(cliOf(dir), null);
  writeFileSync(path.join(dir, 'package.json'), '{ not json');
  assert.equal(cliOf(dir), null);
  mkdirSync(path.join(dir, 'cli'));
  writeFileSync(path.join(dir, 'cli', 'main.js'), '');
  pkg('cli/main.js');
  assert.equal(cliOf(dir), path.join(dir, 'cli', 'main.js'));
  pkg({ tally: './cli/main.js' });
  assert.equal(cliOf(dir), path.join(dir, 'cli', 'main.js'));
  pkg({ other: 'cli/main.js' });
  assert.equal(cliOf(dir), null);
  pkg({ tally: 'cli/gone.js' });
  assert.equal(cliOf(dir), null);
  pkg('cli'); // a directory
  assert.equal(cliOf(dir), null);
});

test('the reference crashed (Node\'s version line, a signal) or hung; exit 1 or 2 with a message is not a crash', () => {
  const r = (o: object) => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null, timedOut: false, log: null, ...o });
  assert.equal(fault(r({})), null);
  assert.equal(fault(r({ status: 1, stderr: Buffer.from('tally: not running\n') })), null);
  assert.equal(fault(r({ status: 2, stderr: Buffer.from('tally: tally.log: line 3: bad start time\n') })), null);
  assert.equal(fault(r({ status: 1, stderr: Buffer.from('file:///x.js:1\nthrow e\nError: boom\n    at x\n\nNode.js v24.12.0\n') })), 'crashed');
  assert.equal(fault(r({ status: null, signal: 'SIGKILL' })), 'crashed');
  assert.equal(fault(r({ status: null, signal: 'SIGKILL', timedOut: true })), 'hung');
});

test('what differed: the first of timed out, exit status, stderr (empty or not), stdout, log', () => {
  const r = (o: object = {}) => ({ stdout: Buffer.from('a'), stderr: Buffer.alloc(0), status: 0, signal: null, timedOut: false, log: Buffer.from('x\n'), ...o });
  assert.equal(differs(r(), r()), null);
  assert.equal(differs(r({ stderr: Buffer.from('warn') }), r({ stderr: Buffer.from('other') })), null);
  assert.equal(differs(r({ log: Buffer.from('y\n') }), r()), 'log');
  assert.equal(differs(r({ log: null }), r()), 'log');
  assert.equal(differs(r({ log: Buffer.alloc(0) }), r({ log: null })), 'log');
  assert.equal(differs(r({ stdout: Buffer.from('a\r\n'), log: null }), r()), 'stdout');
  // bytes compared as bytes: two invalid UTF-8 sequences that decode alike still differ
  assert.equal(differs(r({ stdout: Buffer.from([0xff]) }), r({ stdout: Buffer.from([0xfe]) })), 'stdout');
  assert.equal(differs(r({ stdout: Buffer.from('b'), stderr: Buffer.from('e') }), r()), 'stderr');
  assert.equal(differs(r({ status: 2, stdout: Buffer.from('b'), stderr: Buffer.from('e') }), r()), 'exit status');
  assert.equal(differs(r({ timedOut: true, status: null, signal: 'SIGKILL' }), r()), 'timed out');
});

test('a case\'s environment: its log, clock and home, the caller\'s rest without NODE_TEST* and NODE_OPTIONS', () => {
  const env = caseEnv('C:\\t mp\\case', '2024-03-04T09:00', {
    PATH: '/bin', NODE_OPTIONS: '--x', NODE_TEST_CONTEXT: 'child', node_options: '--y', TALLY_LOG: '/real/log',
    tally_now: 'now', Home: '/h', USERPROFILE: 'C:\\Users\\me', NODE_COMPILE_CACHE: '/c',
  });
  assert.deepEqual(env, {
    PATH: '/bin', NODE_COMPILE_CACHE: '/c',
    TALLY_LOG: 'tally.log', TALLY_NOW: '2024-03-04T09:00', HOME: 'C:\\t mp\\case', USERPROFILE: 'C:\\t mp\\case',
  });
});

test('each case runs in its own fresh temp directory with the case\'s log, clock and home, removed afterwards', E2E, async () => {
  // the arm prints what it saw; the reference prints something else, so every case diverges with the arm's output kept
  const arm = spaced();
  writeFileSync(path.join(arm, 'package.json'), JSON.stringify({ bin: 'see.mjs' }));
  writeFileSync(path.join(arm, 'see.mjs'), `import { existsSync, readFileSync } from 'node:fs';
const e = process.env, log = e.TALLY_LOG && existsSync(e.TALLY_LOG) ? readFileSync(e.TALLY_LOG).toString('base64') : null;
console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), log, logPath: e.TALLY_LOG, now: e.TALLY_NOW,
  home: e.HOME, profile: e.USERPROFILE, nodeOptions: e.NODE_OPTIONS ?? null, nodeTest: e.NODE_TEST_HX_FUZZ ?? null }));`);
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_TEST_HX_FUZZ: process.env.NODE_TEST_HX_FUZZ };
  process.env.NODE_OPTIONS = '--no-warnings';
  process.env.NODE_TEST_HX_FUZZ = '1';
  let r;
  try {
    r = await fuzz(arm, { count: 4, timeLimitMs: LIMIT });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const cases = generate({ count: 4 });
  const seen = Object.values(r.examples).flat().map((e: any) => ({ id: e.case.id, ...JSON.parse(raw(e.arm.stdout)!.toString('utf8')) }));
  assert.deepEqual(seen.map((s) => s.id).sort(), [0, 1, 2, 3]);
  const cwds = new Set();
  for (const s of seen) {
    const c = cases[s.id];
    assert.deepEqual(s.args, c.args);
    assert.equal(s.now, c.now);
    assert.equal(s.log, c.log === null ? null : c.log.toString('base64'));
    assert.equal(path.resolve(s.cwd, s.logPath), path.join(s.cwd, 'tally.log'));
    assert.equal(s.home, s.cwd);
    assert.equal(s.profile, s.cwd);
    assert.equal(s.nodeOptions, null);
    assert.equal(s.nodeTest, null);
    assert.equal(existsSync(s.cwd), false, 'the case directory is removed');
    cwds.add(s.cwd);
  }
  assert.equal(cwds.size, 4);
});

test('the CLI prints the fuzz field as JSON', E2E, () => {
  const arm = patched('src/tally.js', 'Math.floor((m + 7) / 15)', 'Math.floor((m + 8) / 15)');
  const p = spawnSync(process.execPath, [script, arm, '--reference', reference, '--seed', '1107', '--count', '5',
    '--time-limit-ms', String(LIMIT)], { encoding: 'utf8', windowsHide: true });
  assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout);
  assert.deepEqual([r.seed, r.count, r.timeLimitMs, r.genHash], [1107, 5, LIMIT, genHash()]);
  for (const k of ['divergences', 'classes', 'excluded', 'examples']) assert.ok(k in r);
  const bad = spawnSync(process.execPath, [script, arm, '--count', 'many'], { encoding: 'utf8', windowsHide: true });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: node bench\/project-fuzz\.mjs/);
});
