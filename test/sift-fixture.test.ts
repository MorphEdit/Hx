// The `sift` fixture (bench/fixtures/sift/, PRD #446): the large two-phase fixture of the crossover benchmark. Its
// brief and change are the spec its hidden suite, generator and references are written from. Until those land,
// `resolveFixture('sift')` throws for missing files, so this test reads the fixture's files directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      assert.doesNotMatch(rel, /\|^\/|^[A-Za-z]:|(^|\/)\.\.?(\/|$)|\/$/, `case ${i}: ${rel} is a forward-slash path relative to the case`);
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
