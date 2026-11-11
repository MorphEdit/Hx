// The `sift` fixture (bench/fixtures/sift/, PRD #446): the large two-phase fixture of the crossover benchmark. Its
// brief and change are the spec its hidden suite, generator and references are written from. Until those land,
// `resolveFixture('sift')` throws for missing files, so this test reads the fixture's files directly.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-ignore: plain .mjs bench script
import { cases, grade } from '../bench/project-grade.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'bench', 'fixtures', 'sift');
const read = (rel: string) => readFileSync(path.join(dir, rel), 'utf8');
const manifest = JSON.parse(read('fixture.json'));
const brief = read('brief.md');
const change = read(manifest.change);
const AC = /^##\s+acceptance criteria\b/im;

test('the manifest: sift\'s names, its change file and its caps of 10 hours and $200', () => {
  assert.deepEqual(manifest, { bin: 'sift', checkoutEnv: 'SIFT_CHECKOUT', coverageClearEnv: ['SIFT_DB', 'SIFT_TODAY'], fuzzFile: 'db',
    fuzzFileEnv: 'SIFT_DB', fuzzNowEnv: 'SIFT_TODAY', change: 'change.md', maxHours: 10, maxUsd: 200 });
  assert.ok(existsSync(path.join(dir, manifest.change)), 'the change file exists');
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

const genFile = path.join(dir, 'fuzz-gen.mjs');
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
const hidden = path.join(dir, 'hidden');
const AREAS = ['cli', 'syntax', 'types', 'select', 'aggregates', 'joins', 'subqueries', 'functions', 'output', 'writes', 'script', 'library'];
// areas of the change's new features that have no home among the brief's
const CHANGE_AREAS = ['union'];
const names: string[] = cases(hidden);
const tags: Record<string, string> = JSON.parse(readFileSync(path.join(hidden, 'tags.json'), 'utf8'));
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

// reference-base (#456): the reference built from the brief alone. Its core (tables, parser, types, single-table
// SELECT, functions, output, CLI and library) passes every `stable` case of the areas below; the cases listed here
// need what the sibling issues build (writes and scripts), and they remove them. Grouping, joins and subqueries
// (#457) pass every `stable` case of their own areas.
const base = path.join(dir, 'reference-base');
const CORE_AREAS = ['cli', 'syntax', 'types', 'select', 'functions', 'output', 'library'];
const QUERY_AREAS = ['aggregates', 'joins', 'subqueries'];
// one grade of reference-base, shared by the tests below
let baseGrade: { failures: string[] } | undefined;
const gradeBase = () => (baseGrade ??= grade(base, { hidden, checkoutEnv: manifest.checkoutEnv }));
const CORE_PENDING = [
  'cli.test.mjs > an error creates, changes and deletes no file',
  'library.test.mjs > query of another statement returns its message and changes the file',
  'library.test.mjs > run is all or nothing: a failing statement throws and writes nothing',
  'library.test.mjs > run returns the result of every statement, in order',
  'output.test.mjs > a statement other than SELECT prints its one line in json',
  'output.test.mjs > a statement other than SELECT prints its one line in the table format',
];

test('reference-base: plain Node with no dependencies, laid out like the template', () => {
  const pkg = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/sift.js');
  assert.deepEqual(pkg.bin, { sift: 'bin/sift.js' });
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  for (const f of ['bin/sift.js', 'src/sift.js']) assert.ok(existsSync(path.join(base, f)), f);
  for (const f of readdirSync(path.join(base, 'src'))) {
    const src = readFileSync(path.join(base, 'src', f), 'utf8');
    for (const m of src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) assert.match(m[1], /^(node:|\.\/)/, `${f} imports ${m[1]}`);
  }
});

test('grading reference-base: every stable case of the core areas passes, but the named cases of the sibling features', E2E, () => {
  const core = names.filter((n) => tags[n] === 'stable' && CORE_AREAS.some((a) => n.startsWith(`${a}.test.mjs > `)));
  for (const n of CORE_PENDING) assert.ok(core.includes(n), `${n} is a stable case of the core areas`);
  const failed = new Set(gradeBase().failures);
  assert.deepEqual(core.filter((n) => failed.has(n) && !CORE_PENDING.includes(n)), []);
  assert.ok(core.length - CORE_PENDING.length >= 250, `${core.length - CORE_PENDING.length} core cases`);
});

test('grading reference-base: every stable case of aggregates, joins and subqueries passes', E2E, () => {
  const stable = names.filter((n) => tags[n] === 'stable' && QUERY_AREAS.some((a) => n.startsWith(`${a}.test.mjs > `)));
  assert.ok(stable.length >= 80, `${stable.length} stable cases of grouping, joins and subqueries`);
  const failed = new Set(gradeBase().failures);
  assert.deepEqual(stable.filter((n) => failed.has(n)), []);
});
