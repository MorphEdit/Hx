// The project benchmark's fixtures (PRD #439): one module resolves a fixture name to its paths, generator and
// manifest, checks its required files, says where its results go and counts its reference size, so every
// project-benchmark script agrees on them.
//
// - `tally` is the fixture at bench/project/ with bench/project-fuzz-gen.mjs as its generator; its files never move.
// - Every other fixture is bench/fixtures/<name>/, its generator <name>/fuzz-gen.mjs; the name is the directory name.
// - The required files: fixture.json (the manifest), brief.md, hidden/, reference/, template/ and the generator.
// - The manifest: { bin, checkoutEnv, coverageClearEnv, fuzzFile, fuzzFileEnv, fuzzNowEnv } (fuzzNowEnv may be null).
// - Results: tally's in <results>/project/ (and the old <results>/project-<arm>.json files); any other fixture's in
//   <results>/fixtures/<name>/project/. A results file's fixture is its `fixture` field, `tally` when absent.
// Pure apart from reading files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CODE = /\.(js|mjs|cjs)$/i;
const SKIP = new Set(['.git', '.hx', 'node_modules']);
// what `node --test` picks up by default: *.test.*, *-test.*, *_test.*, test-*.*, test.*, and anything under test/
const TEST_NAME = /^((.*[.\-_])?test|test-.+)\.(js|mjs|cjs)$/i;

/** Every .js/.mjs/.cjs file of a checkout outside .git, .hx and node_modules, relative to it (project-coverage.mjs's
 *  source files, and the reference size's). */
export function codeFiles(checkout, rel = '') {
  return readdirSync(path.join(checkout, rel), { withFileTypes: true }).flatMap((d) => {
    const p = path.join(rel, d.name);
    if (d.isDirectory()) return SKIP.has(d.name) ? [] : codeFiles(checkout, p);
    return d.isFile() && CODE.test(d.name) ? [p] : [];
  });
}

/** Whether a checkout-relative file is a test file by `node --test`'s default patterns. */
export function isTestFile(rel) {
  const parts = rel.split(/[\\/]/);
  return parts.slice(0, -1).includes('test') || TEST_NAME.test(parts[parts.length - 1]);
}

export const DEFAULT_FIXTURE = 'tally';
export const MANIFEST_KEYS = ['bin', 'checkoutEnv', 'coverageClearEnv', 'fuzzFile', 'fuzzFileEnv', 'fuzzNowEnv'];

/** A usage error: the scripts print its message and exit 2, before any repo is created or any usage is spent. */
export class FixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureError';
    this.exitCode = 2;
  }
}

/** The fixture names: `tally`, then every directory of <benchDir>/fixtures, sorted. */
export function fixtureNames(benchDir = here) {
  const dir = path.join(benchDir, 'fixtures');
  const more = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== DEFAULT_FIXTURE).map((d) => d.name).sort()
    : [];
  return [DEFAULT_FIXTURE, ...more];
}

/** A fixture's paths: { dir, manifestFile, brief, hidden, reference, template, generator }; nothing is checked. */
export function fixturePaths(name, benchDir = here) {
  const tally = name === DEFAULT_FIXTURE;
  const dir = tally ? path.join(benchDir, 'project') : path.join(benchDir, 'fixtures', name);
  return {
    dir,
    manifestFile: path.join(dir, 'fixture.json'),
    brief: path.join(dir, 'brief.md'),
    hidden: path.join(dir, 'hidden'),
    reference: path.join(dir, 'reference'),
    template: path.join(dir, 'template'),
    generator: tally ? path.join(benchDir, 'project-fuzz-gen.mjs') : path.join(dir, 'fuzz-gen.mjs'),
  };
}

const REQUIRED = [['fixture.json', 'manifestFile', 'file'], ['brief.md', 'brief', 'file'], ['hidden/', 'hidden', 'dir'],
  ['reference/', 'reference', 'dir'], ['template/', 'template', 'dir'], [null, 'generator', 'file']];

const isKind = (p, kind) => {
  try { const s = statSync(p); return kind === 'dir' ? s.isDirectory() : s.isFile(); } catch { return false; }
};

/** The manifest's own problem, or null: exactly the keys of MANIFEST_KEYS, each of its type. */
export function manifestProblem(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not a JSON object';
  const keys = Object.keys(m).sort();
  const want = [...MANIFEST_KEYS].sort();
  if (keys.join() !== want.join()) return `keys must be exactly ${MANIFEST_KEYS.join(', ')}`;
  for (const k of ['bin', 'checkoutEnv', 'fuzzFile', 'fuzzFileEnv']) if (typeof m[k] !== 'string' || !m[k]) return `${k} must be a non-empty string`;
  if (!Array.isArray(m.coverageClearEnv) || !m.coverageClearEnv.every((v) => typeof v === 'string' && v)) return 'coverageClearEnv must be an array of strings';
  if (m.fuzzNowEnv !== null && (typeof m.fuzzNowEnv !== 'string' || !m.fuzzNowEnv)) return 'fuzzNowEnv must be a string or null';
  return null;
}

/** `name` when it names a fixture (the default when undefined); a FixtureError listing the fixtures otherwise. The check
 *  of the scripts that read only results (figures, shiprule, crossover): they need none of the fixture's files. */
export function checkFixtureName(name = DEFAULT_FIXTURE, { benchDir = here } = {}) {
  const names = fixtureNames(benchDir);
  if (typeof name !== 'string' || !names.includes(name)) throw new FixtureError(`unknown fixture "${name}"; fixtures: ${names.join(', ')}`);
  return name;
}

/**
 * The fixture `name` resolved: { name, ...fixturePaths, manifest }. Throws a FixtureError for an unknown name
 * (listing the fixtures), a missing required file (naming the fixture and the file) or a bad manifest.
 */
export function resolveFixture(name = DEFAULT_FIXTURE, { benchDir = here } = {}) {
  checkFixtureName(name, { benchDir });
  const p = fixturePaths(name, benchDir);
  for (const [label, key, kind] of REQUIRED) {
    if (!isKind(p[key], kind)) {
      const what = label ?? path.relative(name === DEFAULT_FIXTURE ? benchDir : p.dir, p[key]).replaceAll('\\', '/');
      throw new FixtureError(`fixture ${name}: missing ${what} (${p[key]})`);
    }
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(p.manifestFile, 'utf8')); } catch (e) {
    throw new FixtureError(`fixture ${name}: fixture.json does not parse: ${e.message}`);
  }
  const bad = manifestProblem(manifest);
  if (bad) throw new FixtureError(`fixture ${name}: fixture.json: ${bad}`);
  return { name, ...p, manifest };
}

/** A results object's fixture: its `fixture` field, `tally` when absent. */
export const fixtureOf = (result) => (typeof result?.fixture === 'string' && result.fixture ? result.fixture : DEFAULT_FIXTURE);

/** Where a fixture's new results files go: <results>/project for tally, <results>/fixtures/<name>/project otherwise. */
export function resultsDirOf(name, resultsRoot = path.join(here, 'results')) {
  return name === DEFAULT_FIXTURE ? path.join(resultsRoot, 'project') : path.join(resultsRoot, 'fixtures', name, 'project');
}

/** The reference size: the non-blank lines of the reference's code files (project-coverage's codeFiles), test files
 *  (isTestFile) left out. */
export function referenceSize(referenceDir) {
  return codeFiles(referenceDir).filter((f) => !isTestFile(f))
    .reduce((n, f) => n + readFileSync(path.join(referenceDir, f), 'utf8').split('\n').filter((l) => /\S/.test(l)).length, 0);
}

/**
 * `--fixture <name>` taken out of argv: { fixture, rest }. `fixture` is undefined when the flag is not given, and
 * null when it is given twice or with no value (a usage error for the caller).
 */
export function takeFixtureArg(argv) {
  const rest = [];
  let fixture;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--fixture') { rest.push(argv[i]); continue; }
    const v = argv[i + 1];
    fixture = fixture !== undefined || v === undefined || v.startsWith('--') || !v.trim() ? null : v;
    i++;
  }
  return { fixture, rest };
}
