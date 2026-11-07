// bench/shiprule.mjs: the ship rule over two sets of project-benchmark runs. The pure shipRule is tested on fixture
// runs; the CLI on fixture files in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'bench', 'shiprule.mjs');
const sr = await import(pathToFileURL(script).href);
const pr = await import(pathToFileURL(path.join(root, 'bench', 'project-results.mjs')).href);

const FUZZ = { seed: 1107, count: 1000, genHash: 'abc' };

/** One review entry whose single verdict has `score`, with a review half of `tokens` and `costUsd`. */
const review = (score: number, tokens = 0, costUsd = 0) => ({
  other: 'chat-1-1.json', verdicts: [{ judge: 1, order: 'AB', label: 'A', value: score }], missing: [], score, basedOn: 1,
  tokens: { total: tokens }, costUsd,
});

/** A results object: 149 passed, the classes given, review score 7, no escaped defects, 60 min, 10M tokens, $20. */
function result(o: Record<string, unknown> = {}) {
  const { classes = { 'line-endings / log': 2 }, score = 7, fuzz = FUZZ, ...rest } = o as any;
  return {
    arm: 'hx3', passed: 149, failed: 0, total: 149, escapedDefects: 0, wallMs: 3_600_000, tokens: { total: 10_000_000 },
    costUsd: 20,
    fuzz: fuzz && { ...fuzz, divergences: Object.values(classes).reduce((a: number, b: any) => a + b, 0), classes },
    reviews: score === null ? undefined : [review(score)],
    ...rest,
  };
}

/** n runs of one set; `each(i)` overrides fields of run i (1-based). */
function set(stamp: string, each: (i: number) => Record<string, unknown> = () => ({}), n = 5, arm = 'hx3') {
  return Array.from({ length: n }, (_, k) => ({ name: `${arm}-${stamp}-${k + 1}.json`, arm, stamp, i: k + 1, result: result({ arm, ...each(k + 1) }) }));
}

const line = (out: { lines: string[] }, n: number) => out.lines.find((l) => l.startsWith(`${n}. `)) ?? '';
const passes = (out: { lines: string[] }, n: number) => / PASS$/.test(line(out, n));

test('a pass: every check PASS, exit 0', () => {
  const out = sr.shipRule(set('1'), set('2'));
  assert.equal(out.code, 0, out.lines.join('\n'));
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(passes(out, n), `check ${n}: ${line(out, n)}`);
  assert.equal(out.lines.at(-1), 'verdict: PASS');
  assert.match(line(out, 2), /baseline 149 → change 149 \(based on 5 of 5 baseline runs, 5 of 5 change runs\)/);
});

const failsAlone = (n: number, change: ReturnType<typeof set>) => {
  const out = sr.shipRule(set('1'), change);
  assert.equal(out.code, 1, out.lines.join('\n'));
  for (const k of [1, 2, 3, 4, 5, 6]) assert.equal(passes(out, k), k !== n, `check ${k}: ${line(out, k)}`);
  assert.match(line(out, n), / FAIL$/);
  assert.equal(out.lines.at(-1), 'verdict: FAIL');
  return out;
};

test('check 2 fails on its own: a lower median hidden-test pass count', () => {
  const out = failsAlone(2, set('2', () => ({ passed: 148 })));
  assert.match(line(out, 2), /baseline 149 → change 148/);
});

test('check 3 fails on its own: a higher median fuzz class count, with no new key', () => {
  // The baseline runs between them saw both keys; each change run shows both.
  const base = set('1', (i) => ({ classes: i === 1 ? { 'a / log': 1, 'b / stdout': 1 } : { 'a / log': 1 } }));
  const change = set('2', () => ({ classes: { 'a / log': 1, 'b / stdout': 1 } }));
  const out = sr.shipRule(base, change);
  assert.equal(out.code, 1);
  for (const k of [1, 2, 3, 4, 5, 6]) assert.equal(passes(out, k), k !== 3, `check ${k}: ${line(out, k)}`);
  assert.match(line(out, 3), /baseline 1 → change 2/);
});

test('check 4 fails on its own: a new class key, printed, with the same class count', () => {
  const out = failsAlone(4, set('2', (i) => ({ classes: i === 1 ? { 'bad-now / exit status': 1 } : { 'line-endings / log': 2 } })));
  assert.match(line(out, 4), /bad-now \/ exit status/);
});

test('check 5 fails on its own: the blind-review mean dropped by more than 0.5', () => {
  const out = failsAlone(5, set('2', () => ({ score: 6 })));
  assert.match(line(out, 5), /baseline 7 → change 6, drop 1/);
});

test('check 6 fails on its own: higher median escaped defects', () => {
  const out = failsAlone(6, set('2', () => ({ escapedDefects: 1 })));
  assert.match(line(out, 6), /baseline 0 → change 1/);
});

test('check 1: 4 runs in one set prints "not enough runs" and how many are missing, no other check, exit 2', () => {
  for (const [b, c] of [[set('1', undefined, 4), set('2')], [set('1'), set('2', undefined, 4)]]) {
    const out = sr.shipRule(b, c);
    assert.equal(out.code, 2);
    const text = out.lines.join('\n');
    assert.match(text, /not enough runs/);
    assert.match(text, /has 4 \(1 missing\)/);
    assert.match(text, /has 5 \(0 missing\)/);
    for (const n of [2, 3, 4, 5, 6]) assert.equal(line(out, n), '', `no check ${n}`);
    assert.doesNotMatch(text, /PASS|FAIL|verdict/);
  }
  const none = sr.shipRule([], set('2'));
  assert.equal(none.code, 2);
  assert.match(none.lines.join('\n'), /baseline has 0 \(5 missing\)/);
});

test('a cheaper, faster change that fails a check still FAILs, with the speed and cost lines printed', () => {
  const change = set('2', () => ({ passed: 140, wallMs: 1_800_000, tokens: { total: 5_000_000 }, costUsd: 10 }));
  const out = sr.shipRule(set('1'), change);
  assert.equal(out.code, 1);
  assert.equal(out.lines.at(-1), 'verdict: FAIL');
  const text = out.lines.join('\n');
  assert.match(text, /wall time \(median\): baseline 60\.0 min → change 30\.0 min \(-30\.0 min\)/);
  assert.match(text, /tokens \(median, with review halves\): baseline 10\.00M → change 5\.00M \(-5\.00M\)/);
  assert.match(text, /cost \(median, with review halves\): baseline \$20\.00 → change \$10\.00 \(-\$10\.00\)/);
});

test('tokens and cost include the review halves', () => {
  const change = set('2', () => ({ reviews: [review(7, 1_000_000, 2)] }));
  const text = sr.shipRule(set('1'), change).lines.join('\n');
  assert.match(text, /tokens \(median, with review halves\): baseline 10\.00M → change 11\.00M \(\+1\.00M\)/);
  assert.match(text, /cost \(median, with review halves\): baseline \$20\.00 → change \$22\.00 \(\+\$2\.00\)/);
});

test('a run without a value is left out of that check, which says how many runs it is based on', () => {
  // Change runs 1 and 2 were never reviewed and have escapedDefects null; their low values would otherwise fail.
  const change = set('2', (i) => (i <= 2 ? { score: null, escapedDefects: null } : {}));
  const out = sr.shipRule(set('1'), change);
  assert.equal(out.code, 0, out.lines.join('\n'));
  assert.match(line(out, 5), /based on 5 of 5 baseline runs, 3 of 5 change runs\) PASS$/);
  assert.match(line(out, 6), /based on 5 of 5 baseline runs, 3 of 5 change runs\) PASS$/);
  // An old file without fuzz is left out of checks 3 and 4.
  const old = sr.shipRule(set('1', (i) => (i === 1 ? { fuzz: null } : {})), set('2'));
  assert.equal(old.code, 0);
  assert.match(line(old, 3), /4 of 5 baseline runs, 5 of 5 change runs\) PASS$/);
  assert.match(line(old, 4), /4 of 5 baseline runs, 5 of 5 change runs\) PASS$/);
});

test('a check where one set has no value FAILs with "no data"', () => {
  const out = sr.shipRule(set('1'), set('2', () => ({ score: null, escapedDefects: null, fuzz: null })));
  assert.equal(out.code, 1);
  for (const n of [3, 4, 5, 6]) assert.match(line(out, n), /no data .* FAIL$/, `check ${n}`);
  assert.match(line(out, 5), /5 of 5 baseline runs, 0 of 5 change runs/);
  assert.ok(passes(out, 2));
  const base = sr.shipRule(set('1', () => ({ passed: null })), set('2'));
  assert.match(line(base, 2), /no data .* FAIL$/);
});

test('a differing generator hash between the sets FAILs checks 3 and 4 with "not comparable"', () => {
  const out = sr.shipRule(set('1'), set('2', () => ({ fuzz: { ...FUZZ, genHash: 'def' } })));
  assert.equal(out.code, 1);
  for (const n of [3, 4]) assert.match(line(out, n), /not comparable.* FAIL$/, `check ${n}`);
  for (const n of [1, 2, 5, 6]) assert.ok(passes(out, n), `check ${n}`);
  // A differing seed or count inside one set is not comparable either.
  const seed = sr.shipRule(set('1', (i) => (i === 1 ? { fuzz: { ...FUZZ, seed: 1 } } : {})), set('2'));
  assert.match(line(seed, 3), /not comparable/);
});

test('check 5 at exactly 0.5 below the baseline passes; just past 0.5 fails', () => {
  const at = sr.shipRule(set('1', () => ({ score: 7.3 })), set('2', () => ({ score: 6.8 })));
  assert.ok(passes(at, 5), line(at, 5));
  assert.equal(at.code, 0);
  const past = sr.shipRule(set('1', () => ({ score: 7.3 })), set('2', () => ({ score: 6.79 })));
  assert.match(line(past, 5), / FAIL$/);
  assert.equal(past.code, 1);
  // The mean over the runs' scores, not their median.
  const mean = sr.shipRule(set('1'), set('2', (i) => ({ score: i === 1 ? 2 : 7.5 })));
  assert.match(line(mean, 5), /change 6.4/);
});

test('runs of more than one arm across the two sets: an error, exit 2', () => {
  const out = sr.shipRule(set('1'), set('2', undefined, 5, 'chat'));
  assert.equal(out.code, 2);
  assert.match(out.lines.join('\n'), /more than one arm: baseline hx3 · change chat/);
});

function files(dir: string, prefix: string, runs: ReturnType<typeof set>) {
  mkdirSync(path.join(dir, 'project'), { recursive: true });
  for (const r of runs) writeFileSync(path.join(dir, 'project', `${prefix}-${r.stamp}-${r.i}.json`), JSON.stringify(r.result));
}

const cli = (args: string[], cwd = root) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd });

test('the CLI: globs over a temp dir give the same result as the pure function, and the exit codes come through', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-ship-'));
  // The baseline glob matches two --runs calls (stamps 100 and 101); the change is one call.
  files(dir, 'hx3', [...set('100', undefined, 3), ...set('101', undefined, 2)]);
  files(dir, 'hx3', set('200', () => ({ passed: 140 })));
  files(dir, 'hx3', set('300'));
  const base = path.join(dir, 'project', 'hx3-10[01]-*.json');
  const run = (change: string, cwd = root, b = base) => {
    const r = cli(['--baseline', b, '--change', change], cwd);
    const pure = sr.shipRule(pr.loadRuns(sr.expand(b, cwd)), pr.loadRuns(sr.expand(change, cwd)));
    assert.equal(r.stdout, pure.lines.join('\n') + '\n');
    assert.equal(r.status, pure.code);
    return r;
  };
  assert.equal(run(path.join(dir, 'project', 'hx3-300-*.json')).status, 0);
  assert.equal(run(path.join(dir, 'project', 'hx3-200-*.json')).status, 1);
  // Relative, forward-slash globs from another working directory.
  assert.equal(run('project/hx3-300-*.json', dir, 'project/hx3-10?-*.json').status, 0);
  // A glob that matches nothing: not enough runs.
  const none = run(path.join(dir, 'project', 'nothing-*.json'));
  assert.equal(none.status, 2);
  assert.match(none.stdout, /not enough runs/);
  // A shell that expands the glob itself passes several files after one flag.
  const expanded = cli(['--baseline', ...sr.expand(base), '--change', ...sr.expand(path.join(dir, 'project', 'hx3-300-*.json'))]);
  assert.equal(expanded.status, 0, expanded.stdout + expanded.stderr);
  // Usage errors and mixed arms exit 2.
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['--baseline', base]).status, 2);
  files(dir, 'chat', set('400', undefined, 5, 'chat'));
  const mixed = cli(['--baseline', base, '--change', path.join(dir, 'project', 'chat-400-*.json')]);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stdout, /more than one arm/);
  // A broken results file is an error naming it.
  writeFileSync(path.join(dir, 'project', 'hx3-500-1.json'), '{ not json');
  const broken = cli(['--baseline', base, '--change', path.join(dir, 'project', 'hx3-500-*.json')]);
  assert.equal(broken.status, 2);
  assert.match(broken.stdout, /error: .*hx3-500-1\.json/);
});
