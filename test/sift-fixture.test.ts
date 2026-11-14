// The `sift` fixture (bench/fixtures/sift/, PRD #446): the large two-phase fixture of the crossover benchmark, resolved
// as any fixture is. Its brief and change are the spec its hidden suite, generator and references are written from;
// `reference/` builds both and passes every hidden case, `reference-base/` builds the brief alone; the reference fuzzed
// against itself shows 0 divergences; the sweep's rules are in the brief and the change.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-ignore: plain .mjs bench scripts
import { referenceSize, resolveFixture, runCaps } from '../bench/project-fixtures.mjs';
// @ts-ignore
import { cases, grade, gradeOptions, readTags, stableScore } from '../bench/project-grade.mjs';
// @ts-ignore
import { fuzz, genHash } from '../bench/project-fuzz.mjs';

const fixture = resolveFixture('sift');
const dir = fixture.dir;
const read = (rel: string) => readFileSync(path.join(dir, rel), 'utf8');
const manifest = fixture.manifest;
const brief = readFileSync(fixture.brief, 'utf8');
const change = readFileSync(fixture.change, 'utf8');
const AC = /^##\s+acceptance criteria\b/im;

test('the manifest: sift\'s names, its change file and its caps of 10 hours and $200', () => {
  assert.deepEqual(manifest, { bin: 'sift', checkoutEnv: 'SIFT_CHECKOUT', coverageClearEnv: ['SIFT_DB', 'SIFT_TODAY'], fuzzFile: 'db',
    fuzzFileEnv: 'SIFT_DB', fuzzNowEnv: 'SIFT_TODAY', change: 'change.md', maxHours: 10, maxUsd: 200 });
  assert.equal(fixture.change, path.join(dir, 'change.md'));
  assert.equal(fixture.tags, path.join(dir, 'hidden', 'tags.json'));
  for (const p of [fixture.change, fixture.tags, fixture.generator]) assert.ok(existsSync(p), p);
  assert.deepEqual(runCaps(fixture), { maxHours: 10, maxUsd: 200 });
  assert.deepEqual(runCaps(fixture, { maxHours: 2 }), { maxHours: 2, maxUsd: 200 });
});

// One size for the reference, by the count every project script uses: what the brief and change need, about
// 2,200 lines (the owner's choice on #459: no padding to the planned 5,000).
const REFERENCE_SIZE = [1800, 3000];

test('the reference: 1,800 to 3,000 lines by the reference-size count', () => {
  const size = referenceSize(fixture.reference);
  assert.ok(size >= REFERENCE_SIZE[0] && size <= REFERENCE_SIZE[1], `${size} lines`);
});

test('both references are plain Node with no dependencies, laid out like the template', () => {
  for (const ref of [fixture.reference, path.join(dir, 'reference-base')]) {
    const pkg = JSON.parse(readFileSync(path.join(ref, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, 'src/sift.js');
    assert.deepEqual(pkg.bin, { sift: 'bin/sift.js' });
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    for (const f of ['bin/sift.js', 'src/sift.js']) assert.ok(existsSync(path.join(ref, f)), f);
    for (const f of readdirSync(path.join(ref, 'src'))) {
      const src = readFileSync(path.join(ref, 'src', f), 'utf8');
      for (const m of src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) assert.match(m[1], /^(node:|\.\/)/, `${f} imports ${m[1]}`);
    }
  }
});

test('brief and change start with a # heading and have no ## Acceptance criteria section', () => {
  for (const [name, text] of [['brief.md', brief], ['change.md', change]]) {
    assert.match(text, /^# \S/, `${name} starts with a # heading`);
    assert.doesNotMatch(text, AC, `${name} has no acceptance criteria section`);
  }
  assert.equal(brief.split('\n')[0], '# sift');
});

test('the brief names the environment it reads: SIFT_DB unset or missing, and SIFT_TODAY', () => {
  for (const name of [manifest.fuzzFileEnv, manifest.fuzzNowEnv, ...manifest.coverageClearEnv]) assert.ok(brief.includes(`\`${name}\``), `the brief names ${name}`);
  assert.match(brief, /`SIFT_DB` is not set or is empty[^.]*exit 2/);
  assert.match(brief, /does not name an\s+existing directory[^.]*exit 2/);
  assert.match(brief, /`SIFT_TODAY` environment variable, a date written `YYYY-MM-DD`[^]*?if\s+it is not set, the computer's local date/);
});

test('the brief decides every exit code, one error-precedence list, stdout and stderr, and NULL in ORDER BY', () => {
  for (let code = 1; code <= 6; code++) assert.match(brief, new RegExp(`exit ${code}\\b`), `exit ${code}`);
  assert.match(brief, /^### Exit codes, and which error wins$/m);
  const list = brief.slice(brief.indexOf('### Exit codes, and which error wins'));
  const order = [1, 2, 3, 4, 5, 6].map((code) => list.indexOf(`exit ${code}:`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `the precedence list holds exit 1 to 6 in order: ${order}`);
  assert.match(brief, /Results go to stdout/);
  assert.match(brief, /one line on stderr/);
  assert.match(brief, /^### Row order$/m);
  assert.match(brief, /In `ORDER BY`, NULL comes before every other value/);
});

test('the brief covers every subsystem of the PRD', () => {
  for (const word of ['syntax error at line L, column C', 'three-valued logic', 'CAST(', 'DISTINCT', 'GROUP BY', 'HAVING', 'NULLS FIRST',
    'LIMIT', 'OFFSET', 'LEFT [OUTER] JOIN', 'IN (<select>)', 'scalar subquery', 'COUNT(*)', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'SUBSTR',
    'ROUND', 'ADD_MONTHS', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'DROP TABLE', 'atomically', 'sift run', 'all or nothing',
    '**`table`**', '**`csv`**', '**`json`**', '## Using it from Node', 'src/sift.js']) {
    assert.ok(brief.includes(word), `the brief states ${word}`);
  }
});

test('the change alters at least 4 behaviours of the brief and adds at least 2 features', () => {
  const [changes, added] = change.split(/^## What is new$/m);
  assert.ok(added, 'a "What is new" section');
  const altered = changes.split(/^### /m).slice(1);
  assert.ok(altered.length >= 4, `${altered.length} altered behaviours`);
  for (const a of altered) assert.match(a, /^- Was: /m, `"${a.split('\n')[0]}" says what the brief stated`);
  assert.ok(added.split(/^### /m).length - 1 >= 2, 'at least 2 new features');
  // each "Was:" quotes a rule the brief states
  assert.match(brief, /Integer `\/` divides and drops the remainder/);
  assert.match(brief, /Dividing by zero \(`\/` or `%`, integers or decimals\) is a run-time error \(exit 6\)/);
  assert.match(brief, /every other character stands for itself, and case matters/);
  assert.match(brief, /padded on the right with spaces/);
});

test('the template: an empty sift package with bin/sift.js, node --test and no dependencies, and a one-line README', () => {
  const pkg = JSON.parse(read('template/package.json'));
  assert.equal(pkg.name, 'sift');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/sift.js');
  assert.deepEqual(pkg.bin, { sift: 'bin/sift.js' });
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  const readme = read('template/README.md');
  assert.match(readme, /^# sift: \S.*\n$/);
  assert.equal(readme.trim().split('\n').length, 1);
});

// --- the fuzz generator (#454): directory cases written from the brief and the change only ---------------------------

const genFile = fixture.generator;
const gen = await import(pathToFileURL(genFile).href);
type DirCase = { id: number; feature: string; args: string[]; files: Record<string, Buffer> | null; now: string };
const all: DirCase[] = gen.generate();

test('the generator: seed 1107 and 1000 cases by default; the same seed gives the same cases, file bytes included', () => {
  assert.equal(gen.DEFAULT_SEED, 1107);
  assert.equal(gen.DEFAULT_COUNT, 1000);
  assert.equal(all.length, 1000);
  const a: DirCase[] = gen.generate({ count: 300 });
  const b: DirCase[] = gen.generate({ count: 300 });
  assert.deepEqual(a, b);
  const bytes = (cs: DirCase[]) => cs.map((c) => Object.entries(c.files ?? {}).map(([k, v]) => `${k}=${v.toString('hex')}`).join(';')).join('\n');
  assert.equal(bytes(a), bytes(b), 'the same file bytes');
  assert.deepEqual(gen.generate({ seed: 1107, count: 300 }), a, 'the default seed is 1107');
  assert.notDeepEqual(gen.generate({ seed: 7, count: 300 }), a, 'another seed differs');
  assert.deepEqual(gen.generate({ count: 150 }), a.slice(0, 150), 'case i depends only on the seed and i');
  assert.deepEqual(all.slice(0, 300), a);
});

// a path relative to the case directory with forward slashes only: no backslash, no leading `/`, no drive, no `.` or `..` segment, no trailing `/`
const BAD_REL_PATH = /\\|^\/|^[A-Za-z]:|(^|\/)\.\.?(\/|$)|\/$/;

test('the relative-path check rejects a backslash, a leading slash, a drive, a dot segment and a trailing slash', () => {
  for (const ok of ['db/select.csv', 'db/2019.csv', 'notes.txt', 'a/b/c.sql', 'db/.hidden.csv', 'db/x..csv']) assert.doesNotMatch(ok, BAD_REL_PATH, ok);
  for (const bad of ['db\\select.csv', '\\x.csv', '/db/2019.csv', '/abs', 'C:/x', 'c:x', 'db/../notes.txt', './x', 'db/./x', '..', 'db/']) assert.match(bad, BAD_REL_PATH, bad);
});

test('every case is a directory case: exactly five keys, files null or forward-slash relative paths to Buffers', () => {
  for (const [i, c] of all.entries()) {
    assert.deepEqual(Object.keys(c).sort(), ['args', 'feature', 'files', 'id', 'now'], `case ${i}`);
    assert.equal(c.id, i);
    assert.ok(Array.isArray(c.args) && c.args.every((x) => typeof x === 'string'), `case ${i} args`);
    assert.equal(typeof c.now, 'string', `case ${i} now`);
    assert.ok(c.feature === 'plain' || gen.FEATURES.includes(c.feature), c.feature);
    if (c.files === null) continue;
    assert.equal(Object.getPrototypeOf(c.files), Object.prototype, `case ${i} files is a plain object`);
    for (const [rel, b] of Object.entries(c.files)) {
      assert.ok(Buffer.isBuffer(b), `case ${i} ${rel} is a Buffer`);
      assert.doesNotMatch(rel, BAD_REL_PATH, `case ${i}: ${rel} is a forward-slash path relative to the case`);
    }
  }
  // tables live under the data directory the manifest names; a script for `sift run` lives outside it
  const paths = all.flatMap((c) => Object.keys(c.files ?? {}));
  assert.ok(paths.some((p) => new RegExp(`^${manifest.fuzzFile}/[a-z_][a-z0-9_]*\.csv$`).test(p)));
  assert.ok(all.some((c) => c.args[0] === 'run' && Object.hasOwn(c.files ?? {}, c.args.find((a, i) => i > 0 && !a.startsWith('--') && !['table', 'csv', 'json', 'markdown'].includes(a)) ?? '')));
  assert.ok(all.some((c) => c.files === null), 'some cases have no files at all');
});

test('every feature of FEATURES appears in the default cases, and the features name every subsystem', () => {
  assert.deepEqual(new Set(all.map((c) => c.feature)), new Set([...gen.FEATURES, 'plain']));
  for (const f of ['expressions', 'casts', 'coercion', 'three-valued', 'distinct', 'where', 'order-by', 'limit', 'aggregates', 'grouping', 'joins',
    'subqueries', 'text-functions', 'number-functions', 'date-functions', 'case', 'union', 'insert', 'update', 'delete', 'create-drop', 'scripts',
    'formats', 'csv-reading', 'table-errors', 'boundaries', 'syntax', 'type-errors', 'names', 'usage', 'environment', 'precedence']) {
    assert.ok(gen.FEATURES.includes(f), `a feature ${f}`);
  }
});

test('the cases reach NULLs, empty texts, quoting, line endings and boundary numbers and dates, every command and format', () => {
  const tables = all.flatMap((c) => Object.entries(c.files ?? {}).filter(([k]) => k.startsWith('db/') && k.endsWith('.csv')).map(([, b]) => b.toString('utf8')));
  const some = (re: RegExp, what: string) => assert.ok(tables.some((t) => re.test(t)), what);
  some(/,,|,\r?\n|^[^\n]*\n\r?\n/m, 'a NULL (an empty field)');
  some(/(^|,)""(,|\r?\n|$)/m, 'an empty text');
  some(/"[^"\n]*,[^"\n]*"/, 'a quoted field holding a comma');
  some(/"[^"]*""[^"]*"/, 'a doubled quote');
  some(/"[^"]*\n[^"]*"/, 'a line break inside quotes');
  some(/\r\n/, 'CRLF');
  some(/^\uFEFF/, 'a byte-order mark');
  for (const edge of ['9223372036854775807', '-9223372036854775808', '999999999999999999.999999', '0001-01-01', '9999-12-31', '2024-02-29']) some(new RegExp(edge.replace('.', '\.')), edge);
  const sql = all.flatMap((c) => [...c.args, ...Object.entries(c.files ?? {}).filter(([k]) => k.endsWith('.sql')).map(([, b]) => b.toString('utf8'))]).join('\n');
  for (const word of ['UNION', 'LEFT JOIN', 'GROUP BY', 'HAVING', 'DISTINCT', 'NULLS FIRST', 'NULLS LAST', 'LIMIT', 'OFFSET', 'IN (SELECT', 'CASE', 'COALESCE',
    'NULLIF', 'CAST(', 'LIKE', 'BETWEEN', 'IS NULL', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'IF NOT EXISTS', 'DROP TABLE', 'IF EXISTS', 'TODAY()',
    'ADD_MONTHS', 'SUBSTR', 'ROUND', 'WEEKDAY', 'AVG(', 'COUNT(*)']) assert.ok(sql.includes(word), `the SQL uses ${word}`);
  for (const cmd of ['query', 'run', 'tables', 'schema']) assert.ok(all.some((c) => c.args[0] === cmd), `a ${cmd} command`);
  for (const f of ['table', 'csv', 'json', 'markdown']) assert.ok(all.some((c) => c.args.join(' ').includes(`--format ${f}`)), `--format ${f}`);
  assert.ok(all.some((c) => !/^\d{4}-\d{2}-\d{2}$/.test(c.now)), 'a SIFT_TODAY that is not a date');
});

test('the generator is pure: it imports only node: modules, reads no clock and spawns nothing', () => {
  const src = readFileSync(genFile, 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const m of imports) assert.match(m, /^node:/);
  assert.doesNotMatch(src, /\bimport\(|require\(/);
  assert.doesNotMatch(src, /Date\.now|new Date\(|performance\.now|Math\.random|child_process|process\.(env|hrtime)/);
});

// The hidden suite (#453): one file per area, written from the brief and the change; tags.json splits its cases into
// `stable` (the same with or without the change) and `change` (added or altered by it), as each file marks them.
const hidden = fixture.hidden;
const AREAS = ['cli', 'syntax', 'types', 'select', 'aggregates', 'joins', 'subqueries', 'functions', 'output', 'writes', 'script', 'library'];
// areas of the change's new features that have no home among the brief's
const CHANGE_AREAS = ['union'];
const names: string[] = cases(hidden);
const tags: Record<string, string> = readTags(fixture.tags);
const suiteFiles = readdirSync(hidden).filter((f: string) => f.endsWith('.test.mjs')).sort();

test('the hidden suite: one file per area, and every area file has cases', () => {
  assert.deepEqual(suiteFiles, [...AREAS, ...CHANGE_AREAS].map((a) => `${a}.test.mjs`).sort());
  for (const f of suiteFiles) assert.ok(names.some((n) => n.startsWith(`${f} > `)), `no case in ${f}`);
});

test('cases.json: at least 400 unique names, each "<area file> > <test>"', () => {
  assert.ok(names.length >= 400, `${names.length} cases`);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  for (const n of names) assert.ok(suiteFiles.some((f) => n.startsWith(`${f} > `) && n.length > f.length + 3), n);
});

test('tags.json: its keys are exactly the case names, each stable or change, at least 80 change', () => {
  assert.deepEqual(Object.keys(tags).sort(), [...names].sort());
  for (const [n, tag] of Object.entries(tags)) assert.ok(tag === 'stable' || tag === 'change', `${n}: ${tag}`);
  const change = Object.values(tags).filter((t) => t === 'change').length;
  assert.ok(change >= 80, `${change} change cases`);
  for (const a of CHANGE_AREAS) assert.ok(names.filter((n) => n.startsWith(`${a}.test.mjs > `)).every((n) => tags[n] === 'change'), `every ${a} case is a change case`);
});

test('tags.json agrees with the files: a case written change(…) is change, one written test(…) stable', () => {
  const marked: Record<string, string> = {};
  for (const f of suiteFiles) {
    for (const m of readFileSync(path.join(hidden, f), 'utf8').matchAll(/^\s*(test|change)\((['"])((?:\\.|(?!\2)[^\\])*)\2,/gm)) {
      marked[`${f} > ${m[3].replace(/\\(.)/g, '$1')}`] = m[1] === 'change' ? 'change' : 'stable';
    }
  }
  assert.deepEqual(marked, tags);
});

test('the suite reads the checkout only from SIFT_CHECKOUT, with no fallback', () => {
  const helpers = readFileSync(path.join(hidden, 'helpers.mjs'), 'utf8');
  assert.match(helpers, /process\.env\.SIFT_CHECKOUT;/);
  for (const f of readdirSync(hidden).filter((x: string) => x.endsWith('.mjs'))) {
    const text = readFileSync(path.join(hidden, f), 'utf8');
    for (const m of text.matchAll(/\b[A-Z]+_CHECKOUT\b/g)) assert.equal(m[0], manifest.checkoutEnv, `${f} names ${m[0]}`);
    if (f !== 'helpers.mjs') assert.doesNotMatch(text, /_CHECKOUT|package\.json/, `${f} finds the checkout through helpers.mjs only`);
  }
});

test('grading the empty template fails every hidden case', E2E, () => {
  const r = grade(path.join(dir, 'template'), { hidden, checkoutEnv: manifest.checkoutEnv });
  assert.equal(r.total, names.length);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, r.total);
});

// A `change` case is one a brief-only build fails (#453). Every input outside the brief (a new format, a new option)
// is a usage error to a brief-only build; a checkout whose CLI answers every call with one passes exactly the cases
// that expect a usage error, and none of those may be a change case.
test('no change case passes against a CLI that answers every call with a usage error', E2E, (t) => {
  const stub = mkdtempSync(path.join(os.tmpdir(), 'sift-usage-'));
  t.after(() => rmSync(stub, { recursive: true, force: true }));
  mkdirSync(path.join(stub, 'bin'));
  mkdirSync(path.join(stub, 'src'));
  writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: 'sift', type: 'module', main: 'src/sift.js', bin: { sift: 'bin/sift.js' } }));
  writeFileSync(path.join(stub, 'bin', 'sift.js'), "process.stderr.write('error: usage\\n');\nprocess.exitCode = 1;\n");
  writeFileSync(path.join(stub, 'src', 'sift.js'), 'export {};\n');
  const r = grade(stub, { hidden, checkoutEnv: manifest.checkoutEnv });
  const failed = new Set(r.failures);
  const passed = names.filter((n) => !failed.has(n));
  assert.ok(passed.length > 0, 'the usage-error cases pass against it');
  assert.deepEqual(passed.filter((n) => tags[n] === 'change'), []);
});

// The references: `reference/` builds the brief and the change and passes every case; `reference-base/` (#456, #457,
// #458) builds the brief alone, so it passes every `stable` case of every area and fails (almost) every `change` one.
// #456's list of named exceptions is empty now: no area is left out.
const base = path.join(dir, 'reference-base');
// one grade of each reference, shared by the tests below
let refGrade: { passed: number; total: number; failures: string[] } | undefined;
let baseGrade: { failures: string[] } | undefined;
const gradeRef = () => (refGrade ??= grade(fixture.reference, gradeOptions(fixture)));
const gradeBase = () => (baseGrade ??= grade(base, gradeOptions(fixture)));

test('grading the reference: every one of at least 400 hidden cases passes, stable and change alike', E2E, () => {
  const r = gradeRef();
  assert.ok(names.length >= 400, `${names.length} hidden cases`);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  assert.deepEqual(r.failures, []);
  assert.equal(r.total, names.length);
  assert.equal(r.passed, r.total);
});

test('grading reference-base: every stable case of every area passes, and at least 90% of the change cases fail', E2E, () => {
  const failed = new Set(gradeBase().failures);
  for (const area of AREAS) {
    const stable = names.filter((n) => tags[n] === 'stable' && n.startsWith(`${area}.test.mjs > `));
    assert.ok(stable.length > 0, `stable cases of ${area}`);
    assert.deepEqual(stable.filter((n) => failed.has(n)), [], `${area}: every stable case passes`);
  }
  assert.deepEqual(names.filter((n) => tags[n] === 'stable' && failed.has(n)), []);
  const change = names.filter((n) => tags[n] === 'change');
  assert.ok(change.filter((n) => failed.has(n)).length >= 0.9 * change.length, 'reference-base fails at least 90% of the change cases');
  // the first version's score a two-phase run records: every stable case of the stable total
  const stable = stableScore(gradeBase(), tags);
  assert.equal(stable.passed, stable.total);
  assert.equal(stable.total, names.length - change.length);
});

// The fuzz: the first block of the generator (88 cases) reaches every feature; the reference against itself agrees
// on every case and none is excluded.
const BLOCK = 88;

test('the first block of cases reaches every feature', () => {
  assert.deepEqual(new Set(all.slice(0, BLOCK).map((c) => c.feature)), new Set([...gen.FEATURES, 'plain']));
});

test('the reference fuzzed against itself: 0 divergences, nothing excluded, the generator\'s hash recorded', E2E, async () => {
  const r = await fuzz(fixture.reference, { fixture, count: BLOCK, timeLimitMs: 120_000 });
  assert.equal(r.divergences, 0, JSON.stringify(r.classes));
  assert.deepEqual(r.classes, {});
  assert.deepEqual(r.excluded, { count: 0, examples: [] });
  assert.deepEqual([r.seed, r.count, r.genHash], [1107, BLOCK, genHash(fixture.generator)]);
});

test('a reference with one rule of the change undone diverges: NULLs sorted first again', E2E, async (t) => {
  const broken = mkdtempSync(path.join(os.tmpdir(), 'sift-broken-'));
  t.after(() => rmSync(broken, { recursive: true, force: true }));
  cpSync(fixture.reference, broken, { recursive: true });
  const file = path.join(broken, 'src', 'select.js');
  const src = readFileSync(file, 'utf8');
  const undone = src.replace("nulls === 'first' || (nulls === null && desc)", "nulls === 'first' || (nulls === null && !desc)");
  assert.notEqual(undone, src);
  writeFileSync(file, undone);
  const r = await fuzz(broken, { fixture, count: BLOCK, timeLimitMs: 120_000 });
  assert.ok(r.divergences > 0);
  // only the rows' order differs: what is printed, never the exit status or the files
  assert.ok(Object.keys(r.classes).every((k) => k.endsWith(' / stdout')), Object.keys(r.classes).join(', '));
});

// The sweep (#459): every hidden case and every fuzz feature was read against the brief and the change together;
// each behaviour they relied on that neither stated is stated now, and each new rule has a hidden case.
test('the sweep: the brief and the change state each behaviour the suite or the fuzz grades', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const b = flat(brief);
  for (const rule of [
    // CAST AS integer / Text (types.test.mjs, the fuzz's typeName and lexing)
    /`CAST\(<expression> AS <type>\)` turns a value into another type; the type is one of the five type names, in any case/,
    // LENGTH(123), YEAR('2024-01-01'), ROUND(1.5, 1.0) are exit 5 (functions.test.mjs, the fuzz's type-errors)
    /a function takes only those types and turns nothing into them \(`LENGTH\(123\)`, `ABS\('1'\)` and `YEAR\('2024-01-01'\)` are type errors\)/,
    // a NULL date compared with a text that is no date (the fuzz's comparisons of text columns with dates)
    /When either side is NULL, the comparison is NULL and nothing is turned into a date/,
    // sift tables, a_b before ab
    /sorted by their character codes \(so `a_b` comes before `ab`\)/,
    // what is worked out: HAVING, CASE, IN, UPDATE … WHERE
    /a group that `HAVING` drops never has its `SELECT` items or `ORDER BY` items worked out/,
    /`CASE` works out its conditions in order, stops at the first that is `TRUE`/,
    /`a IN \(x, y, …\)` works out `a` and then every item, left to right, before it compares/,
    /`UPDATE` works out a row's new values only when its `WHERE` keeps the row/,
  ]) assert.match(b, rule);
  // INSTR('Hello', 'h') is 0 and REPLACE is exact after the change too
  assert.match(flat(change), /`=`, `<>`, the ordering of texts, `DISTINCT`, `GROUP BY`, `UNION`, `INSTR` and `REPLACE` still compare texts exactly, case included/);
  const sweep = ['types.test.mjs > a NULL compared with a text that is not a date is NULL, not an error', 'types.test.mjs > IN works out every item before it compares',
    'functions.test.mjs > INSTR and REPLACE compare case exactly', 'functions.test.mjs > CASE stops at the first TRUE condition, or the first equal value',
    'aggregates.test.mjs > a group that HAVING drops never has its items or ORDER BY items worked out',
    'writes.test.mjs > UPDATE works out the new values only of the rows WHERE keeps',
    'cli.test.mjs > tables sorts the names by their character codes: digits, then _, then letters'];
  for (const n of sweep) assert.equal(tags[n], 'stable', n);
});

// The fuzz's boundaries (`SELECT i / 10 FROM bounds` with i = 9223372036854775807, exit 6) and the reference make each
// integer a decimal before it divides; an exact quotient would fit, so the brief and the change state the range check.
test('the sweep: an integer of 10^18 or more becoming a decimal is a run-time error, stated in the brief and the change', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  assert.match(flat(brief), /An integer of 10\^18 or more in size cannot become a decimal: that is a run-time error \(exit 6\) even when the result would fit \(`9223372036854775807 \/ 10\.0`/);
  assert.match(flat(change), /Both integers become decimals first, .* an integer of 10\^18 or more in size is a run-time error \(exit 6\) here too: `9223372036854775807 \/ 10` is an error/);
  assert.equal(tags['types.test.mjs > an integer of 10^18 or more cannot become a decimal, even when the result would fit'], 'stable');
  assert.equal(tags['types.test.mjs > two integers become decimals before they divide: an integer of 10^18 or more is a run-time error'], 'change');
});

// A failing statement or script leaves the data directory byte for byte as it was: every name, every file's bytes.
const baseLib = await import(pathToFileURL(path.join(base, 'src', 'sift.js')).href);
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[`${r}/`] = ''; walk(r); } else out[r] = readFileSync(path.join(root, r)).toString('hex');
    }
  };
  walk('');
  return out;
};

test('reference-base: a failing statement or script leaves the data directory byte for byte as it was', (t) => {
  const db = mkdtempSync(path.join(os.tmpdir(), 'sift-atomic-'));
  t.after(() => rmSync(db, { recursive: true, force: true }));
  // tables in a form sift would not write, a file that is not a table, a folder named like a table
  writeFileSync(path.join(db, 't.csv'), 'A:INTEGER,B:Text\r\n"1",x\r\n2,y');
  writeFileSync(path.join(db, 'u.csv'), '﻿a:integer\n1\n');
  writeFileSync(path.join(db, 'notes.txt'), 'keep\n');
  mkdirSync(path.join(db, 'v.csv'));
  const before = snapshot(db);
  const opts = { db, today: '2024-03-15' };
  const fails = (f: () => unknown, exitCode: number) => {
    assert.throws(f, (e: any) => e instanceof baseLib.SiftError && e.exitCode === exitCode);
    assert.deepEqual(snapshot(db), before);
  };
  // one statement: a run-time error in its last row
  fails(() => baseLib.query("INSERT INTO t VALUES (3, 'z'), (CAST('q' AS INTEGER), 'w')", opts), 6);
  fails(() => baseLib.query("UPDATE t SET a = CAST(b AS INTEGER) WHERE a = 2", opts), 6);
  // a script that changes, creates and drops tables, then fails: nothing is written, created or deleted
  fails(() => baseLib.run("INSERT INTO t VALUES (3, 'z'); UPDATE u SET a = 9; CREATE TABLE w (c DATE); DROP TABLE u; DELETE FROM t; SELECT 1 / 0", opts), 6);
  fails(() => baseLib.run('DELETE FROM t; SELECT nope FROM u', opts), 5);
  fails(() => baseLib.run('DROP TABLE u; SELECT * FROM u', opts), 4);
  // a script whose every statement succeeds but whose write cannot be made (a folder is where v.csv would go):
  // the tables it changed before are not written either
  fails(() => baseLib.run("INSERT INTO t VALUES (3, 'z'); DROP TABLE u; CREATE TABLE v (a INTEGER)", opts), 4);
  // and a script that succeeds writes every table it changed, in sift's form, with no temporary file left
  assert.deepEqual(baseLib.run("INSERT INTO t VALUES (3, 'z'); DROP TABLE u; CREATE TABLE w (c DATE)", opts),
    [{ message: 'inserted 1' }, { message: 'dropped u' }, { message: 'created w' }]);
  assert.deepEqual(readdirSync(db).sort(), ['notes.txt', 't.csv', 'v.csv', 'w.csv']);
  assert.equal(readFileSync(path.join(db, 't.csv'), 'utf8'), 'a:integer,b:text\n1,x\n2,y\n3,z\n');
  assert.equal(readFileSync(path.join(db, 'w.csv'), 'utf8'), 'c:date\n');
});

test('docs/benchmark.md documents sift: two phases, its size, its test counts, its tags, its fuzz and its caps', () => {
  const doc = readFileSync(path.join(path.dirname(dir), '..', '..', 'docs', 'benchmark.md'), 'utf8');
  assert.match(doc, /<!-- project-bench:sift:start -->\r?\n<!-- project-bench:sift:end -->/);
  const at = doc.indexOf('- **`sift`**');
  assert.ok(at > 0, 'a sift bullet under the fixtures');
  const bullet = doc.slice(at, doc.indexOf('\n- **', at + 1)).replace(/\s+/g, ' ');
  const changeCount = names.filter((n) => tags[n] === 'change').length;
  for (const fact of ['the first two-phase one', '`brief.md`', '`change.md`', '`reference-base/`', '`hidden/tags.json`', 'directory cases',
    `${gen.FEATURES.length} features`, 'seed 1107, 1000 cases', '0 divergences', '10 hours and $200',
    `${names.length} tests in ${suiteFiles.length} area files, ${changeCount} of them tagged \`change\` and the other ${names.length - changeCount} \`stable\``]) {
    assert.ok(bullet.includes(fact), `the sift bullet states: ${fact}`);
  }
  const size = referenceSize(fixture.reference);
  const stated = /`reference\/` builds both, about ([\d,]+) lines/.exec(bullet);
  assert.ok(stated, 'the reference size');
  assert.ok(Math.abs(Number(stated[1].replace(/,/g, '')) - size) <= 50, `about ${stated[1]} lines against ${size}`);
});
