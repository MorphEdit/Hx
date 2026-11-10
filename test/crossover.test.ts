// bench/crossover.mjs (PRD #439): the size × arm table, the per-arm comparison lines and the crossover line, from
// hand-written results files in a temp results dir and fixtures of known reference sizes in a temp bench dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cx = await import(pathToFileURL(path.join(root, 'bench', 'crossover.mjs')).href);

const FUZZ = { seed: 1107, count: 1000, genHash: 'g' };

/** A bench dir with a fixture per name, its reference `size` non-blank lines of code (tally at project/). */
function benchDir(sizes: Record<string, number>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-cx-'));
  const manifest = { bin: 'x', checkoutEnv: 'X', coverageClearEnv: [], fuzzFile: 'f', fuzzFileEnv: 'F', fuzzNowEnv: null };
  for (const [name, size] of Object.entries(sizes)) {
    const fdir = name === 'tally' ? path.join(dir, 'project') : path.join(dir, 'fixtures', name);
    for (const sub of ['hidden', 'reference/src', 'template']) mkdirSync(path.join(fdir, sub), { recursive: true });
    writeFileSync(path.join(fdir, 'fixture.json'), JSON.stringify(manifest));
    writeFileSync(path.join(fdir, 'brief.md'), `# ${name}\n`);
    writeFileSync(path.join(fdir, 'reference', 'src', 'x.js'), Array.from({ length: size }, (_, i) => `line ${i}\n\n`).join(''));
    writeFileSync(name === 'tally' ? path.join(dir, 'project-fuzz-gen.mjs') : path.join(fdir, 'fuzz-gen.mjs'), 'export const DEFAULT_SEED = 1;\n');
  }
  return dir;
}

type Run = Record<string, unknown>;
/** A results object: 100/100 hidden, 2 fuzz classes, escaped 0, `min` minutes, $`usd`, 4 sessions; `score` per review. */
function result(o: { arm: string; min?: number; usd?: number; passed?: number; classes?: number; reviews?: [string, number][]; nudges?: number | null; fixture?: string }) {
  const classes = Object.fromEntries(Array.from({ length: o.classes ?? 2 }, (_, i) => [`f${i} / stdout`, 1]));
  return {
    ...(o.fixture ? { fixture: o.fixture } : {}), arm: o.arm, passed: o.passed ?? 100, failed: 100 - (o.passed ?? 100), total: 100,
    escapedDefects: 0, wallMs: (o.min ?? 10) * 60_000, costUsd: o.usd ?? 1, sessions: o.arm === 'chat' ? { chat: 1 } : { impl: 3, review: 1 },
    nudges: o.arm === 'chat' ? (o.nudges ?? 2) : null, fuzz: { ...FUZZ, divergences: o.classes ?? 2, classes },
    reviews: (o.reviews ?? []).map(([other, score]) => ({ other, score, verdicts: [{ value: score }], costUsd: 0.5 })),
    startedAt: '2026-11-10T00:00:00Z',
  };
}

/** Writes n runs of an arm's set into the fixture's results dir; `each(i)` gives each run's fields. */
function put(results: string, fixture: string, arm: string, n: number, each: (i: number) => Partial<Parameters<typeof result>[0]>, stamp = '202611100000') {
  const dir = fixture === 'tally' ? path.join(results, 'project') : path.join(results, 'fixtures', fixture, 'project');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    writeFileSync(path.join(dir, `${arm}-${stamp}-${i}.json`), JSON.stringify(result({ arm, fixture: fixture === 'tally' ? undefined : fixture, ...each(i) })));
  }
}

/**
 * tally (5 lines): chat 5; hx1 3 runs, faster and as good (n<5: no crossover); hx3 5, slower.
 * alpha (20 lines): chat 5, each reviewed against hx1 (9) and hx3 (7); hx1 5, faster, review 7 (worse than 9);
 *   hx3 5, faster, review 7 (as good as 7): the crossover.
 * beta (20 lines, after alpha by name): chat 5; hx3 5, faster but more fuzz classes: no worse fails.
 * gamma (30 lines): chat 5; hx3 5 faster and as good: a crossover too, but not the smallest.
 */
function scene() {
  const bench = benchDir({ tally: 5, gamma: 30, beta: 20, alpha: 20 });
  const results = mkdtempSync(path.join(os.tmpdir(), 'hx-cxr-'));
  const S = '202611100000';
  put(results, 'tally', 'chat', 5, (i) => ({ min: 4, usd: 2, reviews: [[`hx3-${S}-${i}.json`, 7]], nudges: i }));
  put(results, 'tally', 'hx1', 3, () => ({ min: 2, usd: 3 }));
  put(results, 'tally', 'hx3', 5, (i) => ({ min: 30, usd: 9, reviews: [[`chat-${S}-${i}.json`, 7]] }));
  put(results, 'alpha', 'chat', 5, (i) => ({ min: 40, usd: 2, reviews: [[`hx1-${S}-${i}.json`, 9], [`hx3-${S}-${i}.json`, 7]] }));
  put(results, 'alpha', 'hx1', 5, (i) => ({ min: 20, usd: 4, reviews: [[`chat-${S}-${i}.json`, 7]] }));
  put(results, 'alpha', 'hx3', 5, (i) => ({ min: 30, usd: 6, reviews: [[`chat-${S}-${i}.json`, 7]] }));
  put(results, 'beta', 'chat', 5, (i) => ({ min: 40, reviews: [[`hx3-${S}-${i}.json`, 7]] }));
  put(results, 'beta', 'hx3', 5, (i) => ({ min: 20, classes: 5, reviews: [[`chat-${S}-${i}.json`, 7]] }));
  put(results, 'gamma', 'chat', 5, (i) => ({ min: 40, reviews: [[`hx3-${S}-${i}.json`, 7]] }));
  put(results, 'gamma', 'hx3', 5, (i) => ({ min: 20, reviews: [[`chat-${S}-${i}.json`, 7]] }));
  return { bench, results };
}

test('the table: fixtures by reference size then name, chat first, every column; the comparisons and the crossover', () => {
  const { bench, results } = scene();
  const out = cx.main([], { benchDir: bench, resultsDir: results });
  assert.equal(out.code, 0, out.lines.join('\n'));
  const L = out.lines;
  // rows: fixture size, arm, n
  const rows = L.filter((l: string) => !l.startsWith('  ') && !l.startsWith('crossover:')).map((l: string) => l.split(' · ').slice(0, 3).join(' · '));
  assert.deepEqual(rows, [
    'tally 5 lines · chat · n=5', 'tally 5 lines · hx1 · n=3 (n<5)', 'tally 5 lines · hx3 · n=5',
    'alpha 20 lines · chat · n=5', 'alpha 20 lines · hx1 · n=5', 'alpha 20 lines · hx3 · n=5',
    'beta 20 lines · chat · n=5', 'beta 20 lines · hx3 · n=5',
    'gamma 30 lines · chat · n=5', 'gamma 30 lines · hx3 · n=5',
  ]);
  // every column of a chat row and of an Hx row
  assert.equal(L[0], 'tally 5 lines · chat · n=5 · hidden 100/100 · fuzz classes 2 · review 7.0 · escaped 0 · 4.0 min · $2.50 · 1 sessions · nudges 3');
  assert.equal(L.find((l: string) => l.startsWith('alpha 20 lines · hx3')),
    'alpha 20 lines · hx3 · n=5 · hidden 100/100 · fuzz classes 2 · review 7.0 · escaped 0 · 30.0 min · $6.50 · 4 sessions · nudges –');
  // the chat row's own review mean uses all its reviews (9 and 7)
  assert.match(L.find((l: string) => l.startsWith('alpha 20 lines · chat'))!, / · review 8\.0 · /);
  // the last line: the smallest fixture where an Hx arm with enough runs is no worse and faster
  assert.equal(L.at(-1), 'crossover: alpha (20 lines): hx3 no worse on quality and faster than chat');
});

test('the order is by reference size, then by name among fixtures of one size, whatever order they come in', () => {
  const order = (L: string[]) => L.filter((l) => !l.startsWith('crossover:')).map((l) => l.split(' ').slice(0, 2).join(' '));
  const want = ['bbb 10', 'ccc 10', 'zed 10', 'aaa 40', 'tally 50'];
  const given = [['aaa', 40], ['zed', 10], ['tally', 50], ['ccc', 10], ['bbb', 10]].map(([name, size]) => ({ name, size, runs: [] }));
  assert.deepEqual(order(cx.crossoverLines(given)), want);
  assert.deepEqual(order(cx.crossoverLines([...given].reverse())), want);
  // through the CLI: no flag (names come sorted by name) and a flag in another order
  const bench = benchDir({ tally: 50, aaa: 40, zed: 10, ccc: 10, bbb: 10 });
  const results = mkdtempSync(path.join(os.tmpdir(), 'hx-cxr-'));
  for (const argv of [[], ['--fixtures', 'zed,ccc,tally,bbb,aaa']]) {
    const out = cx.main(argv, { benchDir: bench, resultsDir: results });
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.deepEqual(order(out.lines), want, argv.join(' '));
  }
});

test('each comparison counts only the chat reviews against that arm', () => {
  const { bench, results } = scene();
  const L: string[] = cx.main(['--fixtures', 'alpha'], { benchDir: bench, resultsDir: results }).lines;
  // hx1 against chat's reviews vs hx1 (9): a drop of 2, FAIL; hx3 against chat's reviews vs hx3 (7): PASS
  assert.equal(L.find((l) => l.startsWith('  hx1 vs chat')),
    '  hx1 vs chat: 2 hidden PASS · 3 fuzz classes PASS · 5 review FAIL · 6 escaped PASS: worse on quality · time ×0.5, cost ×1.8');
  assert.equal(L.find((l) => l.startsWith('  hx3 vs chat')),
    '  hx3 vs chat: 2 hidden PASS · 3 fuzz classes PASS · 5 review PASS · 6 escaped PASS: no worse on quality · time ×0.8, cost ×2.6');
  // cost with review halves: chat $2 + its one review half against that arm ($0.50); hx1 $4 and hx3 $6, each + $0.50
  assert.equal(L.at(-1), 'crossover: alpha (20 lines): hx3 no worse on quality and faster than chat');
});

test('an arm with fewer than 5 runs: marked (n<5), not enough runs, never the crossover; the other arms unmarked', () => {
  const { bench, results } = scene();
  const L: string[] = cx.main(['--fixtures', 'tally'], { benchDir: bench, resultsDir: results }).lines;
  assert.ok(L.some((l) => l.startsWith('tally 5 lines · hx1 · n=3 (n<5) · ')));
  assert.ok(L.some((l) => l.startsWith('tally 5 lines · hx3 · n=5 · ')));
  assert.ok(L.some((l) => l.startsWith('tally 5 lines · chat · n=5 · ')));
  assert.equal(L.find((l) => l.startsWith('  hx1 vs chat')), '  hx1 vs chat: not enough runs (hx1 3, chat 5; 5 each needed) · time ×0.5, cost ×1.5');
  assert.match(L.find((l) => l.startsWith('  hx3 vs chat'))!, /: no worse on quality · time ×7\.5, cost ×3\.8$/);
  assert.equal(L.at(-1), 'crossover: no crossover in these fixtures');
});

test('a fixture with no crossover: an arm that is faster but worse on quality', () => {
  const { bench, results } = scene();
  const L: string[] = cx.main(['--fixtures', 'beta'], { benchDir: bench, resultsDir: results }).lines;
  assert.match(L.find((l) => l.startsWith('  hx3 vs chat'))!, /3 fuzz classes FAIL .*: worse on quality · time ×0\.5/);
  assert.equal(L.at(-1), 'crossover: no crossover in these fixtures');
});

test('a chat with fewer than 5 runs leaves every Hx arm on not enough runs; no chat: rows only, no comparison', () => {
  const bench = benchDir({ tally: 5 });
  const results = mkdtempSync(path.join(os.tmpdir(), 'hx-cxr-'));
  put(results, 'tally', 'chat', 4, () => ({ min: 40 }));
  put(results, 'tally', 'hx3', 5, () => ({ min: 1 }));
  let L: string[] = cx.main([], { benchDir: bench, resultsDir: results }).lines;
  assert.ok(L.some((l) => l.startsWith('tally 5 lines · chat · n=4 (n<5)')));
  assert.ok(L.some((l) => l.startsWith('tally 5 lines · hx3 · n=5 · ')));
  assert.match(L.find((l) => l.startsWith('  hx3 vs chat'))!, /not enough runs \(hx3 5, chat 4; 5 each needed\)/);
  assert.equal(L.at(-1), 'crossover: no crossover in these fixtures');
  const solo = mkdtempSync(path.join(os.tmpdir(), 'hx-cxr-'));
  put(solo, 'tally', 'hx3', 5, () => ({}));
  L = cx.main([], { benchDir: bench, resultsDir: solo }).lines;
  assert.deepEqual(L.map((l) => l.split(' · ')[0] + (l.startsWith('  ') ? ' cmp' : '')), ['tally 5 lines', 'crossover: no crossover in these fixtures']);
});

test('the newest set of each arm; runs of another fixture in the directory are not counted', () => {
  const bench = benchDir({ tally: 5 });
  const results = mkdtempSync(path.join(os.tmpdir(), 'hx-cxr-'));
  put(results, 'tally', 'chat', 5, () => ({ min: 10 }), '202611010000');
  put(results, 'tally', 'chat', 2, () => ({ min: 10 }), '202611090000');
  // a file in tally's directory claiming another fixture is read as that fixture's, not tally's
  writeFileSync(path.join(results, 'project', 'hx3-202611090000-1.json'), JSON.stringify(result({ arm: 'hx3', fixture: 'ledge' })));
  for (const i of [1, 2]) {
    writeFileSync(path.join(results, 'project', `chat-202611090000-${i}.json`), JSON.stringify({ ...result({ arm: 'chat' }), startedAt: '2026-11-11T00:00:00Z' }));
  }
  const L: string[] = cx.main([], { benchDir: bench, resultsDir: results }).lines;
  assert.deepEqual(L.map((l) => l.split(' · ').slice(0, 3).join(' · ')), ['tally 5 lines · chat · n=2 (n<5)', 'crossover: no crossover in these fixtures']);
});

test('armOfName reads a results file name as project-results does; reviewsAgainst keeps one arm\'s reviews', () => {
  assert.equal(cx.armOfName('hx3-202611100000-2.json'), 'hx3');
  assert.equal(cx.armOfName('my-arm-202611100000-2.json'), 'my-arm');
  assert.equal(cx.armOfName('project-hx3.json'), 'hx3');
  assert.equal(cx.armOfName('notes.txt'), null);
  const chat = [{ name: 'c', arm: 'chat', result: { reviews: [{ other: 'hx1-s-1.json', score: 9 }, { other: 'hx3-s-1.json', score: 7 }] } }];
  assert.deepEqual(cx.reviewsAgainst(chat, 'hx3')[0].result.reviews, [{ other: 'hx3-s-1.json', score: 7 }]);
  assert.equal(chat[0].result.reviews.length, 2, 'the runs themselves are not changed');
});

test('the CLI: an unknown fixture or a bad flag is exit 2; the real fixtures print a table', () => {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) if (/^NODE_TEST/.test(k)) delete env[k];
  const run = (args: string[]) => spawnSync(process.execPath, [path.join(root, 'bench', 'crossover.mjs'), ...args], { encoding: 'utf8', env });
  const bad = run(['--fixtures', 'nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown fixture "nope"; fixtures: tally, ledge/);
  assert.equal(run(['--fixtures']).status, 2);
  assert.equal(run(['--other']).status, 2);
  const ok = run([]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^tally 237 lines · /m);
  assert.match(ok.stdout, /^crossover: /m);
});
