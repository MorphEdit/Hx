// bench/project-fixtures.mjs (PRD #439): a fixture name resolved to its paths, generator and manifest, the
// required-file check, the results paths and the reference size; and every project-benchmark script's --fixture:
// tally by default, an unknown name a usage error listing the fixtures, exit 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bench = path.join(root, 'bench');
const fx = await import(pathToFileURL(path.join(bench, 'project-fixtures.mjs')).href);
const results = await import(pathToFileURL(path.join(bench, 'project-results.mjs')).href);

const MANIFEST = { bin: 'demo', checkoutEnv: 'DEMO_CHECKOUT', coverageClearEnv: ['DEMO_FILE'], fuzzFile: 'demo.txt', fuzzFileEnv: 'DEMO_FILE', fuzzNowEnv: null };

/** A bench dir holding a tally fixture and the named fixtures, each complete unless `omit` names one of its files. */
function benchDir(names: string[] = [], omit: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-fx-'));
  const make = (fdir: string, generator: string, skip?: string) => {
    const files: Record<string, string> = { 'fixture.json': JSON.stringify(MANIFEST), 'brief.md': '# demo\n', 'hidden/a.test.mjs': '',
      'reference/src/x.js': 'a\n\n  b\n', 'reference/test/x.test.js': 'not counted\n', 'reference/package.json': '{}\n', 'template/package.json': '{}\n' };
    for (const [rel, body] of Object.entries(files)) {
      if (skip && (rel === skip || rel.startsWith(skip))) continue;
      mkdirSync(path.dirname(path.join(fdir, rel)), { recursive: true });
      writeFileSync(path.join(fdir, rel), body);
    }
    if (skip !== 'generator') writeFileSync(generator, 'export const DEFAULT_SEED = 1, DEFAULT_COUNT = 1;\nexport function generate() { return []; }\n');
  };
  make(path.join(dir, 'project'), path.join(dir, 'project-fuzz-gen.mjs'), omit.tally);
  for (const n of names) make(path.join(dir, 'fixtures', n), path.join(dir, 'fixtures', n, 'fuzz-gen.mjs'), omit[n]);
  return dir;
}

test('the fixtures: tally first, then bench/fixtures/<name> by name; the repo has tally and ledge', () => {
  assert.deepEqual(fx.fixtureNames(benchDir(['zeta', 'alpha'])), ['tally', 'alpha', 'zeta']);
  assert.deepEqual(fx.fixtureNames(), ['tally', 'ledge']);
});

test('tally resolves to bench/project and bench/project-fuzz-gen.mjs, its manifest the tally values', () => {
  const f = fx.resolveFixture();
  assert.equal(f.name, 'tally');
  assert.equal(f.dir, path.join(bench, 'project'));
  assert.equal(f.brief, path.join(bench, 'project', 'brief.md'));
  assert.equal(f.hidden, path.join(bench, 'project', 'hidden'));
  assert.equal(f.reference, path.join(bench, 'project', 'reference'));
  assert.equal(f.template, path.join(bench, 'project', 'template'));
  assert.equal(f.generator, path.join(bench, 'project-fuzz-gen.mjs'));
  assert.deepEqual(f.manifest, { bin: 'tally', checkoutEnv: 'TALLY_CHECKOUT', coverageClearEnv: ['TALLY_LOG', 'TALLY_NOW'],
    fuzzFile: 'tally.log', fuzzFileEnv: 'TALLY_LOG', fuzzNowEnv: 'TALLY_NOW' });
  assert.deepEqual(fx.resolveFixture('tally'), f);
});

test('another fixture resolves to bench/fixtures/<name>/ with its fuzz-gen.mjs', () => {
  const f = fx.resolveFixture('ledge');
  const dir = path.join(bench, 'fixtures', 'ledge');
  assert.deepEqual([f.dir, f.brief, f.generator], [dir, path.join(dir, 'brief.md'), path.join(dir, 'fuzz-gen.mjs')]);
  assert.equal(f.manifest.bin, 'ledge');
  assert.deepEqual(Object.keys(f.manifest).sort(), [...fx.MANIFEST_KEYS].sort());
});

test('an unknown fixture is a FixtureError listing the fixtures, exit code 2', () => {
  assert.throws(() => fx.resolveFixture('nope'), (e: any) => e instanceof fx.FixtureError && e.exitCode === 2
    && /unknown fixture "nope"/.test(e.message) && /fixtures: tally, ledge/.test(e.message));
  assert.throws(() => fx.checkFixtureName('nope'), /fixtures: tally, ledge/);
  assert.equal(fx.checkFixtureName(), 'tally');
});

test('a fixture missing a required file is a FixtureError naming the fixture and the file', () => {
  for (const [file, shown] of [['fixture.json', 'fixture.json'], ['brief.md', 'brief.md'], ['hidden', 'hidden/'], ['reference', 'reference/'],
    ['template', 'template/'], ['generator', 'fuzz-gen.mjs']]) {
    const dir = benchDir(['demo'], { demo: file });
    assert.throws(() => fx.resolveFixture('demo', { benchDir: dir }), (e: any) => e instanceof fx.FixtureError
      && e.message.startsWith(`fixture demo: missing ${shown} `), file);
  }
  // tally's generator is bench/project-fuzz-gen.mjs
  assert.throws(() => fx.resolveFixture('tally', { benchDir: benchDir([], { tally: 'generator' }) }), /fixture tally: missing project-fuzz-gen\.mjs/);
  assert.equal(fx.resolveFixture('demo', { benchDir: benchDir(['demo']) }).manifest.bin, 'demo');
});

test('a manifest without exactly its keys, or with a wrong type, is a FixtureError', () => {
  const dir = benchDir(['demo']);
  const file = path.join(dir, 'fixtures', 'demo', 'fixture.json');
  for (const bad of [{ ...MANIFEST, extra: 1 }, { ...MANIFEST, bin: '' }, { ...MANIFEST, coverageClearEnv: 'X' }, { ...MANIFEST, fuzzNowEnv: 3 }, []]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => fx.resolveFixture('demo', { benchDir: dir }), /fixture demo: fixture\.json/);
  }
  writeFileSync(file, '{ not json');
  assert.throws(() => fx.resolveFixture('demo', { benchDir: dir }), /does not parse/);
});

test("the reference size: non-blank lines of the reference's code files, test files and package.json left out; tally's is 237", () => {
  assert.equal(fx.referenceSize(path.join(benchDir(), 'project', 'reference')), 2);
  assert.equal(fx.referenceSize(path.join(bench, 'project', 'reference')), 237);
  const ledge = fx.referenceSize(path.join(bench, 'fixtures', 'ledge', 'reference'));
  assert.ok(ledge >= 1500 && ledge <= 2000, `ledge reference size ${ledge}`);
});

test('codeFiles and isTestFile are the coverage script\'s own', async () => {
  const cov = await import(pathToFileURL(path.join(bench, 'project-coverage.mjs')).href);
  assert.equal(cov.codeFiles, fx.codeFiles);
  assert.equal(cov.isTestFile, fx.isTestFile);
});

test('the results paths: tally in <results>/project, another fixture in <results>/fixtures/<name>/project', () => {
  assert.equal(fx.resultsDirOf('tally', '/r'), path.join('/r', 'project'));
  assert.equal(fx.resultsDirOf('ledge', '/r'), path.join('/r', 'fixtures', 'ledge', 'project'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-fxr-'));
  const put = (rel: string, body: object) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), JSON.stringify(body)); };
  put('project-chat.json', { arm: 'chat' });
  put('project/chat-202611100900-1.json', {});
  put('fixtures/ledge/project/hx1-202611100900-1.json', { fixture: 'ledge' });
  put('fixtures/ledge/project/chat-202611100900-1.json', { fixture: 'ledge' });
  const rel = (fs: string[]) => fs.map((f) => path.relative(dir, f).replaceAll('\\', '/'));
  assert.deepEqual(rel(results.resultFiles(dir)), ['project-chat.json', 'project/chat-202611100900-1.json']);
  assert.deepEqual(rel(results.resultFiles(dir, 'ledge')), ['fixtures/ledge/project/chat-202611100900-1.json', 'fixtures/ledge/project/hx1-202611100900-1.json']);
  // a fixture's files are new files (their directory is named project), read with arm, stamp and i
  const runs = results.loadRuns(results.resultFiles(dir, 'ledge'));
  assert.deepEqual(runs.map((r: any) => [r.arm, r.stamp, r.i]), [['chat', '202611100900', 1], ['hx1', '202611100900', 1]]);
  assert.deepEqual(results.resultFiles(path.join(dir, 'nothing'), 'ledge'), []);
});

test("a run's fixture is its fixture field, tally when absent", () => {
  assert.equal(fx.fixtureOf({}), 'tally');
  assert.equal(fx.fixtureOf(null), 'tally');
  assert.equal(fx.fixtureOf({ fixture: 'ledge' }), 'ledge');
});

test('takeFixtureArg: the flag and its value out of argv; given twice or with no value is null', () => {
  assert.deepEqual(fx.takeFixtureArg(['a', '--fixture', 'ledge', 'b']), { fixture: 'ledge', rest: ['a', 'b'] });
  assert.deepEqual(fx.takeFixtureArg(['a']), { fixture: undefined, rest: ['a'] });
  assert.equal(fx.takeFixtureArg(['--fixture']).fixture, null);
  assert.equal(fx.takeFixtureArg(['--fixture', '--runs']).fixture, null);
  assert.equal(fx.takeFixtureArg(['--fixture', 'a', '--fixture', 'b']).fixture, null);
});

/** A script run with no NODE_TEST* in its environment and no gh to call. */
function script(name: string, args: string[]) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) if (/^NODE_TEST/.test(k)) delete env[k];
  env.PATH = path.dirname(process.execPath);
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(bench, name), ...args], { cwd: root, encoding: 'utf8', env });
}

test('every project-benchmark script rejects an unknown fixture with the list of fixtures, exit 2, before anything else', () => {
  const runs: [string, string[]][] = [
    ['project.mjs', ['chat', '--fixture', 'nope']], ['project.mjs', ['hx1', '--fixture', 'nope', '--runs', '2']],
    ['project-grade.mjs', ['x', '--fixture', 'nope']], ['project-fuzz.mjs', ['x', '--fixture', 'nope']],
    ['project-coverage.mjs', ['x', '--fixture', 'nope']], ['project-review.mjs', ['--all', '--fixture', 'nope']],
    ['project-review.mjs', ['a.json', 'b.json', '--fixture', 'nope']], ['shiprule.mjs', ['--baseline', 'x', '--change', 'y', '--fixture', 'nope']],
    ['figures.mjs', ['--fixture', 'nope']], ['crossover.mjs', ['--fixtures', 'tally,nope']],
  ];
  for (const [name, args] of runs) {
    const r = script(name, args);
    assert.equal(r.status, 2, `${name} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /unknown fixture "nope"; fixtures: tally, ledge/, name);
  }
});

// PRD #446 (#447): the optional manifest keys, the two-phase fixture and the per-fixture caps

test('a manifest may add change, maxHours and maxUsd; a wrong type of any of them, or an unknown key, is a bad manifest', () => {
  assert.deepEqual(fx.OPTIONAL_MANIFEST_KEYS, ['change', 'maxHours', 'maxUsd']);
  assert.equal(fx.manifestProblem(MANIFEST), null);
  for (const ok of [{ change: 'change.md' }, { maxHours: 8 }, { maxUsd: 150.5 }, { change: 'c.md', maxHours: 0.5, maxUsd: 200 }])
    assert.equal(fx.manifestProblem({ ...MANIFEST, ...ok }), null, JSON.stringify(ok));
  for (const bad of [{ change: '' }, { change: 3 }, { change: null }, { change: ['c.md'] },
    { maxHours: 0 }, { maxHours: -1 }, { maxHours: '8' }, { maxHours: null }, { maxUsd: 0 }, { maxUsd: -5 }, { maxUsd: 'x' }, { maxUsd: true },
    { extra: 1 }, { change: 'c.md', other: 'x' }])
    assert.ok(fx.manifestProblem({ ...MANIFEST, ...bad }), JSON.stringify(bad));
  // JSON has no Infinity or NaN, but the check refuses them too
  assert.ok(fx.manifestProblem({ ...MANIFEST, maxHours: Infinity }));
  assert.ok(fx.manifestProblem({ ...MANIFEST, maxUsd: NaN }));
  // an optional key never stands in for a required one
  const { bin: _bin, ...noBin } = MANIFEST;
  assert.ok(fx.manifestProblem({ ...noBin, change: 'c.md' }));
  // through resolveFixture: a FixtureError naming fixture.json
  const dir = benchDir(['demo']);
  const file = path.join(dir, 'fixtures', 'demo', 'fixture.json');
  for (const bad of [{ change: '' }, { maxHours: 0 }, { maxUsd: -1 }, { maxHours: '4' }, { unknown: true }]) {
    writeFileSync(file, JSON.stringify({ ...MANIFEST, ...bad }));
    assert.throws(() => fx.resolveFixture('demo', { benchDir: dir }), (e: any) => e instanceof fx.FixtureError && e.exitCode === 2
      && /^fixture demo: fixture\.json: /.test(e.message), JSON.stringify(bad));
  }
  writeFileSync(file, JSON.stringify({ ...MANIFEST, maxHours: 8, maxUsd: 150 }));
  const f = fx.resolveFixture('demo', { benchDir: dir });
  assert.deepEqual([f.manifest.maxHours, f.manifest.maxUsd, 'change' in f, 'tags' in f], [8, 150, false, false]);
});

/** A bench dir with a two-phase fixture `demo`: its manifest names change.md; `files` says which of change.md and
 *  hidden/tags.json exist. */
function twoPhase(files: { change?: boolean; tags?: boolean } = { change: true, tags: true }) {
  const dir = benchDir(['demo']);
  const fdir = path.join(dir, 'fixtures', 'demo');
  writeFileSync(path.join(fdir, 'fixture.json'), JSON.stringify({ ...MANIFEST, change: 'change.md' }));
  if (files.change) writeFileSync(path.join(fdir, 'change.md'), '# change\n');
  if (files.tags) writeFileSync(path.join(fdir, 'hidden', 'tags.json'), '{}\n');
  return { dir, fdir };
}

test('a two-phase fixture resolves with its change file and hidden/tags.json; a single-phase one exactly as before', () => {
  const { dir, fdir } = twoPhase();
  const f = fx.resolveFixture('demo', { benchDir: dir });
  assert.equal(f.change, path.join(fdir, 'change.md'));
  assert.equal(f.tags, path.join(fdir, 'hidden', 'tags.json'));
  assert.equal(f.manifest.change, 'change.md');
  // tally and ledge: no change, no tags, the same keys as before
  for (const name of ['tally', 'ledge']) {
    const g = fx.resolveFixture(name);
    assert.deepEqual(Object.keys(g), ['name', 'dir', 'manifestFile', 'brief', 'hidden', 'reference', 'template', 'generator', 'manifest'], name);
    assert.deepEqual(Object.keys(g.manifest).sort(), [...fx.MANIFEST_KEYS].sort(), name);
  }
});

test('a two-phase fixture without its change file, or without hidden/tags.json, is a FixtureError with exit code 2', () => {
  for (const [files, shown] of [[{ tags: true }, 'change.md'], [{ change: true }, 'hidden/tags.json'], [{}, 'change.md']] as const) {
    const { dir } = twoPhase(files);
    assert.throws(() => fx.resolveFixture('demo', { benchDir: dir }), (e: any) => e instanceof fx.FixtureError && e.exitCode === 2
      && e.message.startsWith(`fixture demo: missing ${shown} `), shown);
  }
  // a directory where the change file should be is not a change file
  const { dir, fdir } = twoPhase({ tags: true });
  mkdirSync(path.join(fdir, 'change.md'));
  assert.throws(() => fx.resolveFixture('demo', { benchDir: dir }), /fixture demo: missing change\.md /);
});

test("runCaps: a flag, else the fixture's maxHours / maxUsd, else 4 h and $60", () => {
  assert.deepEqual(fx.DEFAULT_CAPS, { maxHours: 4, maxUsd: 60 });
  const big = { manifest: { ...MANIFEST, maxHours: 10, maxUsd: 200 } };
  assert.deepEqual(fx.runCaps(big), { maxHours: 10, maxUsd: 200 });
  assert.deepEqual(fx.runCaps(big, {}), { maxHours: 10, maxUsd: 200 });
  assert.deepEqual(fx.runCaps(big, { maxHours: 1 }), { maxHours: 1, maxUsd: 200 });
  assert.deepEqual(fx.runCaps(big, { maxUsd: 5 }), { maxHours: 10, maxUsd: 5 });
  assert.deepEqual(fx.runCaps(big, { maxHours: 2, maxUsd: 7 }), { maxHours: 2, maxUsd: 7 });
  assert.deepEqual(fx.runCaps({ manifest: { ...MANIFEST, maxUsd: 90 } }), { maxHours: 4, maxUsd: 90 });
  // tally and ledge set no caps: 4 h and $60, a flag still overrides
  for (const name of ['tally', 'ledge']) {
    assert.deepEqual(fx.runCaps(fx.resolveFixture(name)), { maxHours: 4, maxUsd: 60 }, name);
    assert.deepEqual(fx.runCaps(fx.resolveFixture(name), { maxHours: 0.5, maxUsd: 10 }), { maxHours: 0.5, maxUsd: 10 }, name);
  }
});

test('bench/project.mjs exits 2 on a two-phase fixture missing its change file or hidden/tags.json, before any gh call', () => {
  for (const [files, shown] of [[{ tags: true }, 'change.md'], [{ change: true }, 'hidden/tags.json']] as const) {
    // a copy of bench/ with the demo fixture, src/ linked in, so the real script resolves it
    const { dir } = twoPhase(files);
    for (const f of readdirSync(bench)) if (f.endsWith('.mjs')) copyFileSync(path.join(bench, f), path.join(dir, f));
    const top = mkdtempSync(path.join(os.tmpdir(), 'hx-fxcli-'));
    renameSync(dir, path.join(top, 'bench'));
    symlinkSync(path.join(root, 'src'), path.join(top, 'src'), 'junction');
    const env: Record<string, string> = { ...process.env, PATH: '' } as Record<string, string>;
    for (const k of Object.keys(env)) if (/^NODE_TEST/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(top, 'bench', 'project.mjs'), 'chat', '--fixture', 'demo'],
      { cwd: top, encoding: 'utf8', env });
    assert.equal(r.status, 2, `${shown}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^fixture demo: missing ${shown.replace('.', '\.')} `), shown);
  }
});

test('docs/benchmark.md documents the optional manifest keys, a two-phase fixture\'s files and tags format, and per-fixture caps', () => {
  const doc = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8');
  const at = doc.indexOf('### Fixtures and the crossover');
  assert.ok(at >= 0);
  const sec = doc.slice(at, doc.indexOf('**The size × arm table**', at));
  for (const s of ['`change`', '`maxHours`', '`maxUsd`', 'positive numbers', 'two-phase', '`hidden/tags.json`', '`hidden/cases.json`',
    '`"stable"`', '`"change"`', '`--max-hours`', '`--max-usd`', '4 h and $60', 'overrides'])
    assert.ok(sec.includes(s), s);
});
