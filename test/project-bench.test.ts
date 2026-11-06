// The project benchmark's fixture (bench/project/): the grader runs the hidden suite against a checkout.
// The reference passes every case, the empty template none; the brief documents all the suite relies on.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: a plain .mjs bench script
import { cases, grade, HIDDEN } from '../bench/project-grade.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'bench', 'project');
const brief = readFileSync(path.join(project, 'brief.md'), 'utf8');
const hiddenFiles = readdirSync(HIDDEN).filter((f) => f.endsWith('.mjs'));

const walk = (dir: string, rel = ''): string[] => readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(dir, path.join(rel, d.name)) : [path.join(rel, d.name)]));

test('grading the reference: every hidden case passes', E2E, () => {
  const r = grade(path.join(project, 'reference'));
  assert.ok(r.total >= 80, `${r.total} hidden cases`);
  assert.deepEqual(r.failures, []);
  assert.equal(r.failed, 0);
  assert.equal(r.passed, r.total);
  // cases.json lists the reference's cases, each once
  assert.equal(r.total, cases().length);
  assert.equal(new Set(cases()).size, cases().length, 'no duplicate names');
  assert.ok(cases().every((n: string) => / > /.test(n)));
});

test('the hidden suite has at least 80 cases, with cases in every area the brief covers', () => {
  const names: string[] = cases();
  assert.ok(names.length >= 80, `${names.length} hidden cases`);
  const areas: Record<string, RegExp> = {
    start: /^cli-track\.test\.mjs > start /,
    stop: /^cli-track\.test\.mjs > stop /,
    status: /^cli-track\.test\.mjs > status /,
    add: /^cli-track\.test\.mjs > add /,
    'day report': /^reports\.test\.mjs > day report: /,
    'week report': /^reports\.test\.mjs > week report: /,
    'project report': /^reports\.test\.mjs > project report: /,
    rounding: /^rounding\.test\.mjs > rounding: /,
    overlaps: /^overlaps\.test\.mjs > overlaps: /,
    CSV: /^csv\.test\.mjs > csv: /,
    'parse errors': /^parse-errors\.test\.mjs > /,
  };
  for (const [area, re] of Object.entries(areas)) assert.ok(names.some((n) => re.test(n)), `no hidden case for ${area}`);
  // the library side of reports, overlaps and CSV is covered too, not only the CLI
  for (const fn of ['dayReport', 'weekReport', 'projectReport', 'roundMinutes', 'findOverlaps', 'toCsv']) {
    assert.ok(hiddenFiles.some((f) => readFileSync(path.join(HIDDEN, f), 'utf8').includes(`lib.${fn}(`)), `no hidden case calls ${fn}`);
  }
});

/** The reference copied to a temp dir, with `files` overwritten; removed after `fn`. */
const brokenReference = (files: Record<string, string>, fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tally-broken-'));
  try {
    cpSync(path.join(project, 'reference'), dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(dir, rel), text);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

for (const [what, files] of Object.entries({
  'a bin with a syntax error': { 'bin/tally.js': 'this is not js(' },
  'a library with a syntax error (the bin imports it)': { 'src/tally.js': 'this is not js(' },
})) {
  test(`grading ${what}: no CLI case passes, not even the error paths`, E2E, () => {
    brokenReference(files, (dir) => {
      const r = grade(dir);
      assert.equal(r.total, cases().length);
      const cli = cases().filter((n: string) => n.startsWith('cli-track.test.mjs > '));
      assert.ok(cli.length > 0);
      for (const n of cli) assert.ok(r.failures.includes(n), `${n} passed with a CLI that cannot load`);
    });
  });
}

test('grading a library that ends the process on import: the total is still every case, the unreported ones failed', E2E, () => {
  brokenReference({ 'src/tally.js': 'process.exit(0);\n' }, (dir) => {
    const r = grade(dir);
    assert.equal(r.total, cases().length);
    assert.equal(r.passed + r.failed, r.total);
    assert.equal(r.failures.length, r.failed);
    assert.ok(r.passed < r.total / 2, `${r.passed} of ${r.total} passed`);
  });
});

test('grading the empty template: every hidden case fails, and the grader does not throw', E2E, () => {
  const r = grade(path.join(project, 'template'));
  assert.ok(r.total > 0);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, r.total);
  assert.equal(r.failures.length, r.total);
  assert.ok(r.failures.every((n: string) => / > /.test(n)), 'one failure per case, not per file');
});

test('the grader CLI prints the result as JSON', E2E, async () => {
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NODE_TEST/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, [path.join(root, 'bench', 'project-grade.mjs'), path.join(project, 'template')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['failed', 'failures', 'passed', 'total']);
  assert.equal(out.passed, 0);
});

test('every library function the hidden suite calls is named in the brief, under "Using it from Node"', () => {
  assert.match(brief, /^## Using it from Node$/m);
  const called = new Set<string>();
  for (const f of hiddenFiles) for (const m of readFileSync(path.join(HIDDEN, f), 'utf8').matchAll(/\blib\.(\w+)\b/g)) called.add(m[1]);
  assert.ok(called.size > 0, 'the hidden suite calls the library');
  const api = brief.slice(brief.indexOf('## Using it from Node'));
  for (const name of called) assert.match(api, new RegExp(`\`${name}\\(`), `${name} is documented`);
});

test('the brief names TALLY_NOW and none of the reference files', () => {
  assert.match(brief, /TALLY_NOW/);
  assert.doesNotMatch(brief, /^## Quality bar/m);
  for (const f of walk(path.join(project, 'reference'))) {
    for (const name of new Set([f.replace(/\\/g, '/'), path.basename(f)])) assert.ok(!brief.includes(name), `the brief names ${name}`);
  }
});

test('the template: package.json entries pointing at files that do not exist yet, a one-line README, nothing else', () => {
  const dir = path.join(project, 'template');
  assert.deepEqual(walk(dir).sort(), ['README.md', 'package.json']);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'tally');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.scripts, { test: 'node --test' });
  assert.ok(pkg.main && pkg.bin?.tally);
  assert.ok(!existsSync(path.join(dir, pkg.main)) && !existsSync(path.join(dir, pkg.bin.tally)));
  assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8').trim().split('\n').length, 1);
  const ref = JSON.parse(readFileSync(path.join(project, 'reference', 'package.json'), 'utf8'));
  assert.equal(ref.main, pkg.main);
  assert.equal(ref.bin.tally, pkg.bin.tally);
  assert.ok(!ref.dependencies && existsSync(path.join(project, 'reference', ref.main)) && existsSync(path.join(project, 'reference', ref.bin.tally)));
});

test('npm test never runs the hidden suite: it lives outside test/ and outside the test glob', () => {
  // npm test is scripts/test.mjs (#349), which adds the suite's glob when no file is given
  const script = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;
  assert.equal(script, 'node scripts/test.mjs');
  assert.match(readFileSync(path.join(root, 'scripts', 'test.mjs'), 'utf8'), /const SUITE = 'test\/\*\*\/\*\.test\.ts';/);
  assert.ok(hiddenFiles.length > 0);
  for (const f of walk(path.join(root, 'test'))) assert.ok(!hiddenFiles.includes(path.basename(f)), `${f} is a hidden file`);
  assert.ok(hiddenFiles.every((f) => !f.endsWith('.ts')));
});

test('the grader and the hidden suite never call gh or claude', () => {
  for (const f of [path.join(root, 'bench', 'project-grade.mjs'), path.join(root, 'bench', 'project-reporter.mjs'), ...hiddenFiles.map((f) => path.join(HIDDEN, f))]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /['"](gh|claude)['"]/, f);
  }
});
