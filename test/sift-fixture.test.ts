// The `sift` fixture (bench/fixtures/sift/, PRD #446): the large two-phase fixture of the crossover benchmark. Its
// brief and change are the spec its hidden suite, generator and references are written from. Until those land,
// `resolveFixture('sift')` throws for missing files, so this test reads the fixture's files directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
