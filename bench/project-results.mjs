// Project-benchmark results read as runs and sets (PRD #397). bench/figures.mjs, bench/project-review.mjs --all
// and bench/shiprule.mjs read results only through this module, so they agree on what a run, a set, a run's
// cost and a run's review score are. Pure apart from reading files: no gh, no claude.
//
// Where the files are:
// - old single files: bench/results/project-<arm>.json, one run each (a set of its own);
// - new files: bench/results/project/<arm>-<stamp>-<i>.json, run i of the set <arm> + <stamp>;
// - another fixture's files (PRD #439): bench/results/fixtures/<name>/project/<arm>-<stamp>-<i>.json, read as new files.
//
// The results file. Fields as bench/project.mjs writes them: arm, repo, model, effort, startedAt, maxHours,
// maxUsd, passed, failed, total, failures, wallMs, tokens (a number in old files, or
// { input, cacheWrite, cacheRead, output, total }), costUsd, sessions, issuesFiled, issuesClosed, auditFails,
// gateReds, escapedDefects, ended, capped. New fields, each optional (an old file has none of them):
// - fixture: the fixture's name (bench/project-fixtures.mjs); a file without it is a `tally` run;
// - nudges: for `chat`, how many times the session was sent the continue prompt after its first turn; null for Hx;
// - fuzz: { seed, count, genHash, timeLimitMs, divergences, classes, excluded: { count, examples }, examples }
//   classes maps a class key ("<feature> / <what differed>", or "no CLI") to its divergence count; a run's class
//   count is the number of keys of classes; examples maps a class key to its example cases.
// - coverage: { tests: 'passed' | 'failed' | 'none', lines: { covered, total } | 'n/a',
//   branches: { covered, total } | 'n/a' }
// - provenance: { claudeVersion, hxCommit, roles: { <role>: { model, effort, flags: string[] } } }
// - reviews: a list of { other, seed, verdicts, missing, score, basedOn, judges, tokens, costUsd }:
//   - other: the other run's results file name (base name);
//   - verdicts: [{ judge, order: 'AB' | 'BA', label: 'A' | 'B',
//     scores: { correctness, edgeCases, errorMessages, clarity, tests, docs }, value }] for this run's copy,
//     value the mean of its six scores;
//   - missing: [{ judge, order, reason }];
//   - score: the mean of verdicts[].value, or null; basedOn: how many verdicts it is based on;
//   - judges: { role: 'judge', model, effort, flags, claudeVersion };
//   - tokens ({ input, cacheWrite, cacheRead, output, total }) and costUsd: this run's half of the review's.
//   A run is reviewed once one of its reviews has a score; project-review.mjs writes no entry without a verdict.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FIXTURE, resultsDirOf } from './project-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const has = (v) => v !== null && v !== undefined;
const tokTotal = (t) => (has(t) && typeof t === 'object' ? t.total : t);

/** A fixture's results files, sorted: for `tally` the old single files resultsDir/project-*.json and every *.json in
 *  resultsDir/project/; for any other fixture every *.json in resultsDir/fixtures/<name>/project/. */
export function resultFiles(resultsDir = path.join(here, 'results'), fixture = DEFAULT_FIXTURE) {
  const tally = fixture === DEFAULT_FIXTURE;
  const old = tally && existsSync(resultsDir)
    ? readdirSync(resultsDir).filter((f) => /^project-.+\.json$/.test(f)).map((f) => path.join(resultsDir, f)) : [];
  const dir = resultsDirOf(fixture, resultsDir);
  const now = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : [];
  return [...old, ...now].sort();
}

/** An old single file (bench/results/project-<arm>.json): any file outside a directory named `project`. */
export const isOldFile = (file) => path.basename(path.dirname(file)) !== 'project';

/** A run read from an old single file named project-<arm>.json (loadRun gives an old file its name as its stamp). */
export const isOldRun = (run) => run.stamp === run.name && /^project-.+\.json$/.test(run.name ?? '');

/** A file in a directory named `project` is a new file (<arm>-<stamp>-<i>.json); any other is an old one. */
function loadRun(file) {
  const name = path.basename(file);
  let result;
  try { result = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${file}: not a results object`);
  if (isOldFile(file)) {
    // An old file is a set of its own: its file name is its stamp, which no new file's stamp can be.
    return { file, name, arm: result.arm ?? name.replace(/^project-|\.json$/g, ''), stamp: name, i: 1, result };
  }
  const m = /^(.+)-([^-]+)-(\d+)\.json$/.exec(name);
  if (!m) throw new Error(`${file}: not named <arm>-<stamp>-<i>.json`);
  return { file, name, arm: m[1], stamp: m[2], i: Number(m[3]), result };
}

/** Each file read as a run { file, name, arm, stamp, i, result }; a broken file throws naming it. */
export function loadRuns(files) {
  return files.map(loadRun);
}

const time = (s) => (has(s) ? Date.parse(s) : NaN);

/** Runs grouped by arm and stamp: [{ arm, stamp, start, runs }], runs sorted by i, start the earliest startedAt. */
export function sets(runs) {
  const by = new Map();
  for (const r of runs) {
    const key = JSON.stringify([r.arm, r.stamp]);
    if (!by.has(key)) by.set(key, { arm: r.arm, stamp: r.stamp, start: null, runs: [] });
    by.get(key).runs.push(r);
  }
  for (const s of by.values()) {
    s.runs.sort((a, b) => a.i - b.i);
    for (const r of s.runs) {
      const t = time(r.result.startedAt);
      if (!Number.isNaN(t) && (s.start === null || t < time(s.start))) s.start = r.result.startedAt;
    }
  }
  return [...by.values()];
}

/** The arm's set with the latest start, or null. A set with no start is older than any with one. */
export function newestSet(runs, arm) {
  let best = null;
  for (const s of sets(runs).filter((x) => x.arm === arm)) {
    const t = time(s.start);
    if (!best || (!Number.isNaN(t) && (Number.isNaN(time(best.start)) || t > time(best.start)))) best = s;
  }
  return best;
}

const reviews = (result) => (Array.isArray(result?.reviews) ? result.reviews : []);

/** The arm's own costUsd plus each review's half; null when the arm's own value is missing. */
export function runCost(result) {
  if (!has(result?.costUsd)) return null;
  return reviews(result).reduce((a, r) => a + (r.costUsd ?? 0), result.costUsd);
}

/** The arm's own token total plus each review's half; null when the arm's own value is missing. */
export function runTokens(result) {
  const own = tokTotal(result?.tokens);
  if (!has(own)) return null;
  return reviews(result).reduce((a, r) => a + (tokTotal(r.tokens) ?? 0), own);
}

const verdictValues = (result) => reviews(result).flatMap((r) => (Array.isArray(r.verdicts) ? r.verdicts : []))
  .map((v) => v?.value).filter((v) => typeof v === 'number');

/** The mean of every verdict's value over all the run's reviews; null with no review or no verdict. */
export function reviewScore(result) {
  const vs = verdictValues(result);
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

/** How many verdicts reviewScore is based on. */
export function reviewBasedOn(result) {
  return verdictValues(result).length;
}

export const fuzzDivergences = (result) => (result?.fuzz ? result.fuzz.divergences ?? null : null);
export const fuzzKeys = (result) => (result?.fuzz ? Object.keys(result.fuzz.classes ?? {}) : null);
export const fuzzClassCount = (result) => (result?.fuzz ? fuzzKeys(result).length : null);
export const fuzzParams = (result) => (result?.fuzz
  ? { seed: result.fuzz.seed ?? null, count: result.fuzz.count ?? null, genHash: result.fuzz.genHash ?? null }
  : null);

/** A two-phase run's first version (PRD #446): { passed, total } on the `stable` tests; null for a single-phase run. */
export function phase1Score(result) {
  const p = result?.phase1;
  return p && typeof p === 'object' && has(p.passed) && has(p.total) ? { passed: p.passed, total: p.total } : null;
}

/** A two-phase run's change phase: its `phases` entry named `change`; null when the run never reached it or has no
 *  `phases` (a single-phase run). */
export function changePhase(result) {
  const phases = Array.isArray(result?.phases) ? result.phases : [];
  return phases.find((ph) => ph?.name === 'change') ?? null;
}

/** covered / total × 100 for 'lines' or 'branches'; null for n/a, no coverage, or a total of 0. */
export function coveragePct(result, kind) {
  const c = result?.coverage?.[kind];
  if (!c || typeof c !== 'object' || !c.total || !has(c.covered)) return null;
  return (c.covered / c.total) * 100;
}

const present = (values) => values.filter(has);

/** The median of the values that are not null or undefined (the mean of the middle two for an even count); null when none. */
export function median(values) {
  const v = present(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** { min, max } of the values that are not null or undefined; null when none. */
export function range(values) {
  const v = present(values);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
}
