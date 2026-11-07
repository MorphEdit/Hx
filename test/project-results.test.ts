// bench/project-results.mjs: project-benchmark results read as runs and sets, and the shared accessors.
// Fixture files are written to a temp dir; the repo's bench/results/ is only read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pr = await import(pathToFileURL(path.join(root, 'bench', 'project-results.mjs')).href);

function fixture(files: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-pr-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('resultFiles finds old and new files, sorted, and works with no project/ directory', () => {
  const dir = fixture({
    'project-hx3.json': { arm: 'hx3' }, 'project-chat.json': { arm: 'chat' }, 'chat.json': {}, 'hx1.json': {},
    'project/chat-202611070900-2.json': {}, 'project/chat-202611070900-1.json': {}, 'project/notes.txt': 'x',
  });
  assert.deepEqual(pr.resultFiles(dir).map((f: string) => path.relative(dir, f).replaceAll('\\', '/')), [
    'project-chat.json', 'project-hx3.json', 'project/chat-202611070900-1.json', 'project/chat-202611070900-2.json',
  ]);
  const bare = fixture({ 'project-chat.json': { arm: 'chat' } });
  assert.deepEqual(pr.resultFiles(bare).map((f: string) => path.basename(f)), ['project-chat.json']);
});

test('loadRuns parses arm, stamp and i from new names and reads an old file as i = 1 in a set of its own', () => {
  const dir = fixture({
    'project-chat.json': { arm: 'chat', startedAt: '2026-11-05T00:00:00Z' },
    'project/my-arm-202611070900-3.json': { arm: 'ignored' },
  });
  const runs = pr.loadRuns(pr.resultFiles(dir));
  assert.equal(runs.length, 2);
  const [old, now] = runs;
  assert.equal(old.name, 'project-chat.json');
  assert.equal(old.arm, 'chat');
  assert.equal(old.i, 1);
  assert.equal(old.stamp, 'project-chat.json');
  assert.equal(old.file, path.join(dir, 'project-chat.json'));
  assert.equal(old.result.startedAt, '2026-11-05T00:00:00Z');
  assert.equal(now.name, 'my-arm-202611070900-3.json');
  assert.equal(now.arm, 'my-arm');
  assert.equal(now.stamp, '202611070900');
  assert.equal(now.i, 3);
});

test('loadRuns throws an error naming a broken file', () => {
  const dir = fixture({ 'project/chat-202611070900-1.json': '{ not json' });
  const file = path.join(dir, 'project', 'chat-202611070900-1.json');
  assert.throws(() => pr.loadRuns([file]), (e: Error) => e.message.includes(file));
  assert.throws(() => pr.loadRuns([path.join(dir, 'project-gone.json')]), /project-gone\.json/);
  const badName = fixture({ 'project/chat.json': {} });
  assert.throws(() => pr.loadRuns(pr.resultFiles(badName)), /chat\.json/);
});

const run = (arm: string, stamp: string, i: number, startedAt?: string) => ({ file: `${arm}-${stamp}-${i}.json`, name: `${arm}-${stamp}-${i}.json`, arm, stamp, i, result: { arm, startedAt } });

test('sets groups by arm and stamp, sorts by i and takes the earliest startedAt as start', () => {
  const runs = [
    run('chat', 's1', 2, '2026-11-07T10:00:00Z'), run('hx3', 's1', 1, '2026-11-07T08:00:00Z'),
    run('chat', 's1', 1, '2026-11-07T09:00:00Z'), run('chat', 's2', 1, '2026-11-08T09:00:00Z'),
    run('chat', 's1', 3, '2026-11-07T11:00:00Z'),
  ];
  const got = pr.sets(runs);
  assert.equal(got.length, 3);
  const chat1 = got.find((s: any) => s.arm === 'chat' && s.stamp === 's1');
  assert.deepEqual(chat1.runs.map((r: any) => r.i), [1, 2, 3]);
  assert.equal(chat1.start, '2026-11-07T09:00:00Z');
  assert.equal(got.find((s: any) => s.arm === 'hx3').runs.length, 1);
  assert.equal(got.find((s: any) => s.stamp === 's2').start, '2026-11-08T09:00:00Z');
});

test('newestSet picks the latest start per arm; an old file is the newest when nothing newer exists', () => {
  const dir = fixture({
    'project-chat.json': { arm: 'chat', startedAt: '2026-11-05T00:00:00Z' },
    'project-hx3.json': { arm: 'hx3', startedAt: '2026-11-05T00:00:00Z' },
    'project/chat-a-1.json': { startedAt: '2026-11-06T00:00:00Z' },
    'project/chat-b-1.json': { startedAt: '2026-11-07T00:00:00Z' },
    'project/chat-b-2.json': { startedAt: '2026-11-07T01:00:00Z' },
    'project/hx3-c-1.json': { startedAt: '2026-11-04T00:00:00Z' },
  });
  const runs = pr.loadRuns(pr.resultFiles(dir));
  const chat = pr.newestSet(runs, 'chat');
  assert.equal(chat.stamp, 'b');
  assert.equal(chat.runs.length, 2);
  assert.equal(pr.newestSet(runs, 'hx3').stamp, 'project-hx3.json');
  assert.equal(pr.newestSet(runs, 'hx1'), null);
});

const review = (costUsd: number, tokens: unknown, values: number[]) => ({
  other: 'x.json', verdicts: values.map((value) => ({ judge: 1, order: 'AB', label: 'A', value })),
  missing: [{ judge: 2, order: 'BA', reason: 'no reply' }], costUsd, tokens,
});

test('runCost / runTokens add each review half, read number and object tokens, null without an own value', () => {
  assert.equal(pr.runCost({ costUsd: 2 }), 2);
  assert.equal(pr.runCost({ costUsd: 2, reviews: [review(0.5, null, [])] }), 2.5);
  assert.equal(pr.runCost({ costUsd: 2, reviews: [review(0.5, null, []), review(0.25, null, [])] }), 2.75);
  assert.equal(pr.runCost({ reviews: [review(0.5, null, [])] }), null);
  assert.equal(pr.runCost({ costUsd: null }), null);
  assert.equal(pr.runTokens({ tokens: 1000 }), 1000);
  assert.equal(pr.runTokens({ tokens: { input: 1, total: 1000 } }), 1000);
  assert.equal(pr.runTokens({ tokens: { total: 1000 }, reviews: [review(0, { total: 10 }, []), review(0, { total: 5 }, [])] }), 1015);
  assert.equal(pr.runTokens({ reviews: [review(0, { total: 10 }, [])] }), null);
  assert.equal(pr.runTokens({ tokens: { input: 1 } }), null);
});

test('reviewScore averages verdicts over all reviews and ignores missing ones; null with none', () => {
  const result = { reviews: [review(0, null, [4, 3]), review(0, null, [2])] };
  assert.equal(pr.reviewScore(result), 3);
  assert.equal(pr.reviewBasedOn(result), 3);
  assert.equal(pr.reviewScore({}), null);
  assert.equal(pr.reviewBasedOn({}), 0);
  assert.equal(pr.reviewScore({ reviews: [review(0, null, [])] }), null);
  assert.equal(pr.reviewBasedOn({ reviews: [review(0, null, [])] }), 0);
});

test('the fuzz accessors read fuzz and give null without it', () => {
  const result = { fuzz: { seed: 7, count: 500, genHash: 'abc', timeLimitMs: 5000, divergences: 12,
    classes: { 'spacing / stdout': 10, 'no CLI': 2 }, excluded: { count: 0, examples: [] }, examples: {} } };
  assert.equal(pr.fuzzDivergences(result), 12);
  assert.equal(pr.fuzzClassCount(result), 2);
  assert.deepEqual(pr.fuzzKeys(result), ['spacing / stdout', 'no CLI']);
  assert.deepEqual(pr.fuzzParams(result), { seed: 7, count: 500, genHash: 'abc' });
  for (const f of [pr.fuzzDivergences, pr.fuzzClassCount, pr.fuzzKeys, pr.fuzzParams]) assert.equal(f({}), null);
});

test('coveragePct gives covered / total × 100, null for n/a, no coverage or a 0 total', () => {
  const result = { coverage: { tests: 'passed', lines: { covered: 3, total: 4 }, branches: 'n/a' } };
  assert.equal(pr.coveragePct(result, 'lines'), 75);
  assert.equal(pr.coveragePct(result, 'branches'), null);
  assert.equal(pr.coveragePct({}, 'lines'), null);
  assert.equal(pr.coveragePct({ coverage: { lines: { covered: 0, total: 0 } } }, 'lines'), null);
});

test('median and range leave out null and undefined; null when none is left', () => {
  assert.equal(pr.median([3, 1, 2]), 2);
  assert.equal(pr.median([4, 1, 3, 2]), 2.5);
  assert.equal(pr.median([5, null, 1, undefined, 3]), 3);
  assert.equal(pr.median([null, undefined]), null);
  assert.equal(pr.median([]), null);
  assert.deepEqual(pr.range([3, null, 1, 2]), { min: 1, max: 3 });
  assert.equal(pr.range([null]), null);
});

test('the committed bench/results/project-chat.json and project-hx3.json load without error', () => {
  const files = pr.resultFiles(path.join(root, 'bench', 'results'));
  const names = files.map((f: string) => path.basename(f));
  assert.ok(names.includes('project-chat.json') && names.includes('project-hx3.json'));
  const runs = pr.loadRuns(files);
  for (const arm of ['chat', 'hx3']) {
    const s = pr.newestSet(runs, arm);
    assert.ok(s, arm);
    assert.ok(pr.runCost(s.runs[0].result) > 0);
    assert.ok(pr.runTokens(s.runs[0].result) > 0);
  }
});
