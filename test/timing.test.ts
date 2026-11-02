// Test time per turn (src/timing.ts): the test-command matcher, the per-turn spans, failed runs, nearest-rank stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEST_PATTERNS, median, p90, testMatcher, turnTiming } from '../src/timing.ts';
import { DEFAULTS, testPatternsError } from '../src/config.ts';

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const START = T0, END = T0 + 100_000;
const isTest = testMatcher();
const use = (ts: number | undefined, ...cmds: [string, string][]) => ({ type: 'assistant', ...(ts === undefined ? {} : { timestamp: at(ts) }),
  message: { content: cmds.map(([id, command]) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })) } });
const result = (ts: number | undefined, id: string, content: unknown = 'ok', extra = {}) => ({ type: 'user', ...(ts === undefined ? {} : { timestamp: at(ts) }),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });

test('one test command: its span runs from the assistant timestamp to the matching tool_result timestamp', () => {
  assert.deepEqual(turnTiming([use(10, ['a', 'npm test']), result(25, 'a')], START, END, isTest), { testMs: 15_000, testRuns: 1, testFailedRuns: 0 });
});

test('two overlapping parallel test commands are merged', () => {
  const evs = [use(10, ['a', 'npm test'], ['b', 'node --test x']), result(30, 'a'), result(40, 'b')];
  assert.deepEqual(turnTiming(evs, START, END, isTest), { testMs: 30_000, testRuns: 2, testFailedRuns: 0 });
  // disjoint spans add up
  const two = [use(10, ['a', 'npm test']), result(20, 'a'), use(50, ['b', 'pytest']), result(55, 'b')];
  assert.equal(turnTiming(two, START, END, isTest).testMs, 15_000);
});

test('a non-test Bash command, or a test-looking command in another tool, is not counted', () => {
  const evs = [use(10, ['a', 'cat test/x.ts']), result(20, 'a'),
    { type: 'assistant', timestamp: at(10), message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { command: 'npm test' } }] } }, result(20, 'r')];
  assert.deepEqual(turnTiming(evs, START, END, isTest), { testMs: 0, testRuns: 0, testFailedRuns: 0 });
});

test('a test command with no result, or a result without a usable timestamp, ends at turnEnd and is not failed', () => {
  assert.deepEqual(turnTiming([use(90, ['a', 'npm test'])], START, END, isTest), { testMs: 10_000, testRuns: 1, testFailedRuns: 0 });
  assert.deepEqual(turnTiming([use(90, ['a', 'npm test']), result(undefined, 'a')], START, END, isTest), { testMs: 10_000, testRuns: 1, testFailedRuns: 0 });
});

test('spans are clipped to [turnStart, turnEnd]; testMs never exceeds the turn', () => {
  // the result after turnEnd, and an assistant event before turnStart
  assert.equal(turnTiming([use(95, ['a', 'npm test']), result(130, 'a')], START, END, isTest).testMs, 5_000);
  assert.equal(turnTiming([use(-20, ['a', 'npm test']), result(5, 'a')], START, END, isTest).testMs, 5_000);
  // entirely outside: 0 ms, still one run
  assert.deepEqual(turnTiming([use(-20, ['a', 'npm test']), result(-10, 'a')], START, END, isTest), { testMs: 0, testRuns: 1, testFailedRuns: 0 });
  assert.equal(turnTiming([use(-20, ['a', 'npm test']), result(200, 'a')], START, END, isTest).testMs, 100_000);
});

test('malformed lines and non-object events are skipped, never thrown on', () => {
  const evs = ['{not json', null, 42, [1], 'null', JSON.stringify(use(10, ['a', 'npm test'])), JSON.stringify(result(12, 'a'))];
  assert.deepEqual(turnTiming(evs, START, END, isTest), { testMs: 2_000, testRuns: 1, testFailedRuns: 0 });
  assert.deepEqual(turnTiming([{ type: 'assistant', timestamp: at(1), message: { content: 'x' } }, { type: 'user', message: null }], START, END, isTest),
    { testMs: 0, testRuns: 0, testFailedRuns: 0 });
});

test('an assistant event with a missing or unparseable timestamp: its tool_uses are not counted', () => {
  assert.deepEqual(turnTiming([use(undefined, ['a', 'npm test']), result(20, 'a', 'x', { is_error: true })], START, END, isTest), { testMs: 0, testRuns: 0, testFailedRuns: 0 });
  const bad = { ...use(10, ['a', 'npm test']), timestamp: 'yesterday' };
  assert.deepEqual(turnTiming([bad, result(20, 'a')], START, END, isTest), { testMs: 0, testRuns: 0, testFailedRuns: 0 });
});

test('testFailedRuns: is_error true and "Exit code N" (N non-zero) count; Exit code 0 and other text do not', () => {
  const evs = [use(10, ['a', 'npm test'], ['b', 'npm test'], ['c', 'npm test'], ['d', 'npm test'], ['e', 'npm test']),
    result(20, 'a', 'boom', { is_error: true }), result(20, 'b', 'Exit code 1\nfailed'), result(20, 'c', [{ type: 'text', text: 'Exit ' }, { type: 'text', text: 'code 2' }]),
    result(20, 'd', 'Exit code 0'), result(20, 'e', 'all passed, Exit code 1 later')];
  assert.deepEqual(turnTiming(evs, START, END, isTest), { testMs: 10_000, testRuns: 5, testFailedRuns: 3 });
});

test('every default pattern matches an example command; reading or grepping test files does not', () => {
  const examples = ['npm test', 'npm run test -- --x', 'node --test test/a.test.ts', 'pnpm test', 'yarn run test', 'bun test', 'npx vitest run',
    'npx jest', 'mocha spec', 'pytest -q', 'python -m pytest', 'python -m unittest discover', 'go test ./...', 'cargo test', 'vendor/bin/phpunit',
    'bundle exec rspec', 'dotnet test'];
  for (const p of DEFAULT_TEST_PATTERNS) {
    const re = new RegExp(p, 'i');
    assert.ok(examples.some((e) => re.test(e)), `no example for ${p}`);
  }
  for (const e of examples) assert.ok(isTest(e), e);
  assert.ok(isTest('cd app && NPM TEST'), 'case-insensitive, anywhere');
  for (const e of ['cat test/x.ts', 'grep -n test src/a.ts']) assert.equal(isTest(e), false, e);
});

test('the effective gate command matches as a trimmed literal; a testPatterns entry adds a match', () => {
  assert.equal(isTest('make check'), false);
  assert.ok(testMatcher([], '  make check (all)  ')('cd x && MAKE CHECK (all) -j4'));
  assert.equal(testMatcher([], 'make check (all)')('make check all'), false, 'regex characters are literal');
  assert.equal(testMatcher([], '   ')('anything'), false, 'blank adds nothing');
  assert.ok(testMatcher(['^just t\\b'])('JUST T unit'));
  assert.equal(testMatcher(['^just t\\b'])('just tidy'), false);
});

test('config: testPatterns defaults to []; an invalid regex is refused, naming the entry', () => {
  assert.deepEqual(DEFAULTS.testPatterns, []);
  assert.equal(testPatternsError(undefined), null);
  assert.equal(testPatternsError(['^just t\\b']), null);
  const e = testPatternsError(['ok', '(unclosed']);
  assert.match(e ?? '', /testPatterns: "\(unclosed" is not a valid regular expression/);
  assert.match(testPatternsError('npm') ?? '', /must be an array/);
});

test('median and p90 use the nearest-rank method; undefined for an empty list', () => {
  assert.equal(median([]), undefined);
  assert.equal(p90([]), undefined);
  assert.equal(median([7]), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5, 1, 4, 2, 3]), 5);
  assert.equal(p90([10, 20]), 20);
});
