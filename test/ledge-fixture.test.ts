// The `ledge` fixture (bench/fixtures/ledge/, PRD #439): the medium fixture of the crossover benchmark. Its reference
// passes the whole hidden suite and shows 0 divergences fuzzed against itself; its brief states what the suite and the
// fuzz grade; its generator gives tally's case shape, deterministically; its template is an empty repo.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-ignore: plain .mjs bench scripts
import { resolveFixture, referenceSize } from '../bench/project-fixtures.mjs';
// @ts-ignore
import { cases, grade, gradeOptions } from '../bench/project-grade.mjs';
// @ts-ignore
import { fuzz, genHash, namesOf, caseEnv } from '../bench/project-fuzz.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolveFixture('ledge');
const brief = readFileSync(fixture.brief, 'utf8');
const gen = await import(pathToFileURL(fixture.generator).href);
const hiddenFiles = readdirSync(fixture.hidden).filter((f: string) => f.endsWith('.mjs'));

const walk = (dir: string, rel = ''): string[] => readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(dir, path.join(rel, d.name)) : [path.join(rel, d.name)]));

test('the manifest: the brief\'s names, bin ledge', () => {
  assert.deepEqual(fixture.manifest, { bin: 'ledge', checkoutEnv: 'LEDGE_CHECKOUT', coverageClearEnv: ['LEDGE_FILE', 'LEDGE_TODAY'],
    fuzzFile: 'ledger.journal', fuzzFileEnv: 'LEDGE_FILE', fuzzNowEnv: 'LEDGE_TODAY' });
  for (const name of ['LEDGE_FILE', 'LEDGE_TODAY', 'ledger.journal']) assert.ok(brief.includes(name), `the brief names ${name}`);
});

test('the reference: 1,500 to 2,000 lines by the reference-size count, plain Node with no dependencies', () => {
  const size = referenceSize(fixture.reference);
  assert.ok(size >= 1500 && size <= 2000, `${size} lines`);
  const pkg = JSON.parse(readFileSync(path.join(fixture.reference, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.bin.ledge, 'bin/ledge.js');
});

test('grading the reference: every one of at least 150 hidden cases passes', E2E, () => {
  const r = grade(fixture.reference, gradeOptions(fixture));
  const names: string[] = cases(fixture.hidden);
  assert.ok(names.length >= 150, `${names.length} hidden cases`);
  assert.deepEqual(r.failures, []);
  assert.equal(r.passed, r.total);
  assert.equal(r.total, names.length);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
});

test('grading the empty template: every hidden case fails', E2E, () => {
  const r = grade(fixture.template, gradeOptions(fixture));
  assert.equal(r.passed, 0);
  assert.equal(r.failed, r.total);
});

test('the hidden suite covers both subsystems, one file per area, and reads the checkout from LEDGE_CHECKOUT', () => {
  const names: string[] = cases(fixture.hidden);
  for (const area of ['journal-format', 'journal-errors', 'cli-usage', 'balance', 'register', 'report', 'print-export', 'writing', 'budget', 'import', 'library']) {
    assert.ok(names.some((n) => n.startsWith(`${area}.test.mjs > `)), `no hidden case for ${area}`);
  }
  assert.match(readFileSync(path.join(fixture.hidden, 'helpers.mjs'), 'utf8'), /process\.env\.LEDGE_CHECKOUT/);
});

test('every library function the hidden suite calls is named in the brief, under "Using it from Node"', () => {
  const called = new Set<string>();
  for (const f of hiddenFiles) for (const m of readFileSync(path.join(fixture.hidden, f), 'utf8').matchAll(/\blib\.(\w+)\b/g)) called.add(m[1]);
  assert.ok(called.size >= 8, [...called].join(', '));
  const api = brief.slice(brief.indexOf('## Using it from Node'));
  for (const name of called) assert.match(api, new RegExp(`\`${name}\\(`), `${name} is documented`);
});

test('the brief: no acceptance criteria; one precedence list; every exit code; orders, rounding, stdout and stderr', () => {
  assert.doesNotMatch(brief, /^## Acceptance criteria/m);
  assert.doesNotMatch(brief, /^## Quality bar/m);
  // one numbered precedence list, usage first, the command's own checks last, each with its exit code
  const list = brief.slice(brief.indexOf('### Exit codes, and which error wins'));
  assert.ok(list.length < brief.length, 'a section on exit codes and which error wins');
  const items = [...list.matchAll(/^(\d)\. \*\*([^*]+), exit (\d):\*\*/gm)].map((m) => [Number(m[1]), m[2], Number(m[3])]);
  assert.deepEqual(items, [[1, 'Usage', 1], [2, 'Environment', 2], [3, 'The journal', 3], [4, 'The other input files', 4],
    [5, "The command's own checks", 5]]);
  assert.match(list, /Exit `0` is success/);
  assert.match(brief, /Errors go to stderr only, never stdout/);
  assert.match(brief, /rounded to a whole\s+number, a half rounded up/);
  assert.match(brief, /never rounded/);
  for (const order of ['sorted by account, then currency', 'by date, then reading order', 'sorted by period, then currency', 'sorted by currency']) {
    assert.ok(brief.replace(/\s+/g, ' ').includes(order), `the brief states the order: ${order}`);
  }
});

test('the brief names none of the reference files', () => {
  for (const f of walk(fixture.reference)) {
    for (const name of new Set([f.replace(/\\/g, '/'), path.basename(f)])) {
      if (name === 'package.json') continue;
      assert.ok(!brief.includes(name), `the brief names ${name}`);
    }
  }
});

test('the template: package.json with the bin entry and node --test, a one-line README, nothing else', () => {
  assert.deepEqual(walk(fixture.template).sort(), ['README.md', 'package.json']);
  const pkg = JSON.parse(readFileSync(path.join(fixture.template, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'ledge');
  assert.deepEqual(pkg.scripts, { test: 'node --test' });
  assert.ok(pkg.main && pkg.bin?.ledge);
  assert.ok(!existsSync(path.join(fixture.template, pkg.main)) && !existsSync(path.join(fixture.template, pkg.bin.ledge)));
  assert.equal(readFileSync(path.join(fixture.template, 'README.md'), 'utf8').trim().split('\n').length, 1);
});

test("the generator: tally's exports and defaults, tally's case shape, the same cases for the same seed", () => {
  assert.equal(gen.DEFAULT_SEED, 1107);
  assert.equal(gen.DEFAULT_COUNT, 1000);
  const a = gen.generate({ count: 300 });
  assert.deepEqual(a, gen.generate({ count: 300 }));
  assert.notDeepEqual(a, gen.generate({ seed: 7, count: 300 }));
  assert.deepEqual(gen.generate({ count: 150 }), a.slice(0, 150), 'case i depends only on the seed and i');
  for (const c of a) {
    assert.deepEqual(Object.keys(c).sort(), ['args', 'feature', 'id', 'log', 'now']);
    assert.ok(Array.isArray(c.args) && c.args.every((x: unknown) => typeof x === 'string'));
    assert.ok(c.log === null || Buffer.isBuffer(c.log));
    assert.equal(typeof c.now, 'string');
    assert.ok(c.feature === 'plain' || gen.FEATURES.includes(c.feature), c.feature);
  }
  assert.deepEqual(new Set(gen.generate({ count: 100 }).map((c: { feature: string }) => c.feature)), new Set([...gen.FEATURES, 'plain']));
  // pure: only node: imports, no clock, nothing spawned
  const src = readFileSync(fixture.generator, 'utf8');
  for (const m of src.matchAll(/^import .* from '([^']+)';$/gm)) assert.match(m[1], /^node:/);
  assert.doesNotMatch(src, /Date\.now|new Date\(\)|child_process/);
});

test('the harness takes the data file and the two variables from the manifest', () => {
  const env = caseEnv('/case', '2024-03-15', { PATH: '/bin', LEDGE_FILE: '/real', TALLY_LOG: 'kept' }, namesOf(fixture.manifest));
  assert.deepEqual(env, { PATH: '/bin', TALLY_LOG: 'kept', LEDGE_FILE: 'ledger.journal', LEDGE_TODAY: '2024-03-15', HOME: '/case', USERPROFILE: '/case' });
  // a fixture whose product reads no clock gets no clock variable
  const noClock = caseEnv('/case', 'x', {}, namesOf({ ...fixture.manifest, fuzzNowEnv: null }));
  assert.deepEqual(noClock, { LEDGE_FILE: 'ledger.journal', HOME: '/case', USERPROFILE: '/case' });
});

test('the reference fuzzed against itself: 0 divergences, nothing excluded, the generator\'s hash recorded', E2E, async () => {
  const count = 100; // the first block of 100 reaches every feature
  const r = await fuzz(fixture.reference, { fixture, count, timeLimitMs: 120_000 });
  assert.equal(r.divergences, 0, JSON.stringify(r.classes));
  assert.deepEqual(r.classes, {});
  assert.deepEqual(r.excluded, { count: 0, examples: [] });
  assert.deepEqual([r.seed, r.count, r.genHash], [1107, count, genHash(fixture.generator)]);
});

test('a reference with one rule broken diverges, classed under the feature that reaches it', E2E, async () => {
  const { cpSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledge-broken-'));
  cpSync(fixture.reference, dir, { recursive: true });
  const file = path.join(dir, 'src', 'queries.js');
  // --sort amount in balance: smallest first instead of largest
  writeFileSync(file, readFileSync(file, 'utf8').replace('b.amount - a.amount || compareText(a.account', 'a.amount - b.amount || compareText(a.account'));
  const r = await fuzz(dir, { fixture, count: 100, timeLimitMs: 120_000 });
  assert.ok(r.divergences > 0);
  assert.ok(Object.keys(r.classes).every((k) => / \/ stdout$/.test(k)), Object.keys(r.classes).join(', '));
  assert.ok('depth-sort / stdout' in r.classes, Object.keys(r.classes).join(', '));
});

test('a behaviour the brief leaves open is not graded: a reference whose parseAmount("-0.00") is -0 passes every case', E2E, async () => {
  const { cpSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledge-minus0-'));
  cpSync(fixture.reference, dir, { recursive: true });
  const file = path.join(dir, 'src', 'amount.js');
  const src = readFileSync(file, 'utf8');
  const changed = src.replace(/if \(cents === 0\) \{\r?\n\s*return 0;\r?\n\s*\}\r?\n/, '');
  assert.notEqual(changed, src);
  writeFileSync(file, changed);
  const lib = await import(pathToFileURL(file).href);
  assert.equal(Object.is(lib.parseAmount('-0.00'), -0), true);
  const r = grade(dir, gradeOptions(fixture));
  assert.deepEqual(r.failures, []);
  assert.equal(r.passed, r.total);
});

test('what the suite grades beyond the precedence list, the brief states: transactions in reading order, a missing file named', () => {
  const flat = brief.replace(/\s+/g, ' ');
  assert.match(flat, /`transactions` are in reading order too, not sorted by date/);
  assert.match(flat, /cannot be read \(for `import`: the CSV file first, then the rules file\)\. The error names that file/);
  const library = readFileSync(path.join(fixture.hidden, 'library.test.mjs'), 'utf8');
  assert.ok(library.includes('parseJournal keeps reading order, not date order'));
  const imports = readFileSync(path.join(fixture.hidden, 'import.test.mjs'), 'utf8');
  assert.ok(imports.includes("both.stderr.includes('none.csv')"));
});

test('the sweep of every hidden case: the brief states each behaviour the suite or the fuzz grades', () => {
  const flat = brief.replace(/\s+/g, ' ');
  for (const rule of [
    // amounts: parseAmount('.50') throws, parseAmount('1.00 ') throws, formatAmount(5) is 0.05, 0000.05 prints 0.05
    /at least one digit before the point and exactly two decimals after it/, /no amount that starts at the point \(`\.50` is wrong\)/,
    /no leading zeros but the one `0` of an amount under `1\.00` \(`007\.50` is printed `7\.50`, five cents `0\.05`\)/,
    /throws an `Error` for text that is not exactly an amount \(whitespace around it included\)/,
    // the library's shapes: a transaction's line, the postings' order, balance(j) with no options, depth 2
    /`line` the number of its date line/, /the postings in their written order/, /`options` itself may be left out/, /`depth` is a number/,
    // print and add keep the written posting order
    /A transaction's postings keep the order they are written in, wherever ledge shows or writes them/,
    // a failed add on a missing journal leaves no file (the hidden suite and the fuzz's missing-journal feature)
    /on any error stdout is empty and no file is created or changed/,
    // journal errors: an undeclared account at the posting's line, a second name on an account line
    /a posting to an account not declared above it is an error at that posting's line/, /anything else after the name on that line is an error/,
    // import: `shop` is no duplicate of `Shop`
    /the same payee \(exactly, case included\)/,
    // --budget plans/b.txt, LEDGE_FILE books/mine.txt
    /A path in `LEDGE_FILE` or on the command line is relative to the current folder/,
  ]) assert.match(flat, rule);
  const library = readFileSync(path.join(fixture.hidden, 'library.test.mjs'), 'utf8');
  assert.ok(library.includes("'.50', '1.00 '"), 'parseAmount still grades .50 and a trailing space');
  // the round trip grades no CRLF inside a quoted field: the brief leaves open whether it comes back as CRLF
  const roundTrip = library.slice(library.indexOf("test('toCsv and parseCsv round-trip'"));
  assert.ok(roundTrip.length < library.length, 'the round-trip case is there');
  assert.doesNotMatch(roundTrip.slice(0, roundTrip.indexOf('\n  });')), /\\r\\n/);
});

test('a behaviour the brief leaves open is not graded: a reference that reads a quoted CRLF as LF passes every case', E2E, async () => {
  const { cpSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledge-crlf-'));
  cpSync(fixture.reference, dir, { recursive: true });
  const file = path.join(dir, 'src', 'csv.js');
  const src = readFileSync(file, 'utf8');
  const changed = src.replace(/export function readCsvRows\(text\) \{\r?\n/, (m) => `${m}  text = text.replaceAll('\\r\\n', '\\n');\n`);
  assert.notEqual(changed, src);
  writeFileSync(file, changed);
  const lib = await import(pathToFileURL(path.join(dir, 'src', 'ledge.js')).href);
  assert.deepEqual(lib.parseCsv('x,"a\r\nb"\n'), [['x', 'a\nb']]);
  const r = grade(dir, gradeOptions(fixture));
  assert.deepEqual(r.failures, []);
  assert.equal(r.passed, r.total);
});

test('docs/benchmark.md has the empty ledge markers', () => {
  const doc = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8');
  assert.match(doc, /<!-- project-bench:ledge:start -->\r?\n<!-- project-bench:ledge:end -->/);
});
