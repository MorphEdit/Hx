#!/usr/bin/env node
// The size × arm table of the crossover benchmark (PRD #439): from what size of work does Hx match or beat one session?
//   node bench/crossover.mjs [--fixtures a,b]
// Reads the newest set of each arm of each fixture (all fixtures by default; bench/project-fixtures.mjs), through
// bench/project-results.mjs, and prints:
// - one row per fixture and arm, fixtures by reference size (smallest first, then by name), `chat` first, then the
//   other arms by name: the fixture, its reference size in lines, the arm, the number of runs (`(n<5)` under 5),
//   median hidden tests passed out of the total, median fuzz classes, blind-review mean, median escaped defects,
//   median wall time, median cost with review halves, median sessions, and median nudges for `chat`; for a two-phase
//   fixture (its manifest names `change`, PRD #446) two more columns: `phase1 <passed>/<total>`, the medians of the
//   first version's `stable` tests passed and total over the runs with a `phase1`, and `change <time>, <cost>`, the
//   median wall time and cost of the change phase (its `phases` entry `change`: `wallMs`, `costUsd`) over the runs that
//   reached it, `–` for each when none did. A results file with no `phases` / `phase1` reads as a single-phase run;
// - after each fixture's rows, one line per Hx arm against `chat` on that fixture: the ship rule's checks 2, 3, 5 and 6
//   (bench/shiprule.mjs qualityChecks) with `chat` as the baseline, each verdict shown, then whether it is no worse on
//   quality, then time and cost as ratios to `chat`. The `chat` runs keep only their reviews against that arm (a
//   review's `other` names the arm's run by its file name). When the arm or `chat` has fewer than 5 runs the line
//   reads `not enough runs` in place of the verdicts. No `chat` set: no comparison line;
// - a last line naming the crossover: the smallest fixture where an Hx arm with at least 5 runs, against a `chat` with
//   at least 5, is no worse on quality and faster than `chat`; or `no crossover in these fixtures`.
// An unknown fixture, or one missing a required file, is a usage error, exit 2. Pure apart from reading files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureError, fixtureNames, fixtureOf, referenceSize, resolveFixture } from './project-fixtures.mjs';
import { changePhase, fuzzClassCount, loadRuns, median, newestSet, resultFiles, phase1Score, reviewScore, runCost } from './project-results.mjs';
import { MIN_RUNS, qualityChecks } from './shiprule.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DASH = '–';
const QUALITY = [[2, 'hidden'], [3, 'fuzz classes'], [5, 'review'], [6, 'escaped']];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const plain = (v) => String(Math.round(v * 10) / 10);
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const usd = (c) => `$${c.toFixed(2)}`;
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const show = (v, fmt = plain) => (isNum(v) ? fmt(v) : DASH);

/** The arm of a results file name, read as project-results.mjs loadRun reads it: `<arm>-<stamp>-<i>.json`, or an old
 *  `project-<arm>.json`; null for any other name. */
export function armOfName(name) {
  const base = path.basename(String(name ?? ''));
  const m = /^(.+)-([^-]+)-(\d+)\.json$/.exec(base);
  if (m && !base.startsWith('project-')) return m[1];
  const old = /^project-(.+)\.json$/.exec(base);
  return old ? old[1] : m ? m[1] : null;
}

/** Copies of the `chat` runs whose `reviews` keep only the entries against a run of `arm`. */
export function reviewsAgainst(chatRuns, arm) {
  return chatRuns.map((r) => ({
    ...r,
    result: { ...r.result, reviews: (Array.isArray(r.result?.reviews) ? r.result.reviews : []).filter((v) => armOfName(v?.other) === arm) },
  }));
}

/** A run's total sessions: the number, or the sum of the per-role counts. */
function sessionTotal(result) {
  const s = result?.sessions;
  if (isNum(s)) return s;
  if (!s || typeof s !== 'object') return null;
  const counts = Object.values(s).filter(isNum);
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
}

const med = (runs, f) => median(runs.map((r) => f(r.result)).filter(isNum));

/** One row of the table; a two-phase fixture's has the first version's score and the change phase's time and cost. */
export function row(fixture, size, arm, runs, twoPhase = false) {
  const n = runs.length;
  const passed = med(runs, (r) => r?.passed);
  const total = med(runs, (r) => r?.total);
  return [
    `${fixture} ${size} lines`, arm, `n=${n}${n < MIN_RUNS ? ' (n<5)' : ''}`,
    `hidden ${show(passed)}/${show(total)}`,
    `fuzz classes ${show(med(runs, fuzzClassCount))}`,
    `review ${show(mean(runs.map((r) => reviewScore(r.result)).filter(isNum)), (v) => v.toFixed(1))}`,
    `escaped ${show(med(runs, (r) => r?.escapedDefects))}`,
    show(med(runs, (r) => r?.wallMs), mins),
    show(med(runs, runCost), usd),
    `${show(med(runs, sessionTotal))} sessions`,
    `nudges ${arm === 'chat' ? show(med(runs, (r) => r?.nudges)) : DASH}`,
    ...(twoPhase ? [
      `phase1 ${show(med(runs, (r) => phase1Score(r)?.passed))}/${show(med(runs, (r) => phase1Score(r)?.total))}`,
      `change ${show(med(runs, (r) => changePhase(r)?.wallMs), mins)}, ${show(med(runs, (r) => changePhase(r)?.costUsd), usd)}`,
    ] : []),
  ].join(' · ');
}

const ratio = (a, b) => (isNum(a) && isNum(b) && b > 0 ? a / b : null);

/** An Hx arm against `chat` on one fixture: { line, counts, noWorse, faster }. */
export function compare(arm, armRuns, chatRuns) {
  const chat = reviewsAgainst(chatRuns, arm);
  const time = ratio(med(armRuns, (r) => r?.wallMs), med(chat, (r) => r?.wallMs));
  const cost = ratio(med(armRuns, runCost), med(chat, runCost));
  const ratios = `time ×${show(time)}, cost ×${show(cost)}`;
  const counts = armRuns.length >= MIN_RUNS && chat.length >= MIN_RUNS;
  if (!counts) {
    return { line: `  ${arm} vs chat: not enough runs (${arm} ${armRuns.length}, chat ${chat.length}; ${MIN_RUNS} each needed) · ${ratios}`, counts, noWorse: false, faster: false };
  }
  const checks = qualityChecks(chat, armRuns);
  const verdicts = QUALITY.map(([n, label]) => `${n} ${label} ${checks.find((c) => c.n === n).pass ? 'PASS' : 'FAIL'}`);
  const noWorse = QUALITY.every(([n]) => checks.find((c) => c.n === n).pass);
  const faster = isNum(time) && time < 1;
  return {
    line: `  ${arm} vs chat: ${verdicts.join(' · ')}: ${noWorse ? 'no worse on quality' : 'worse on quality'} · ${ratios}`,
    counts, noWorse, faster,
  };
}

const armOrder = (a, b) => (a === 'chat' ? -1 : b === 'chat' ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** The table's lines over fixtures [{ name, size, runs, twoPhase }] (runs as loadRuns gives them, all of that fixture;
 *  twoPhase true when the manifest names `change`). */
export function crossoverLines(fixtures) {
  const sorted = [...fixtures].sort((a, b) => a.size - b.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = [];
  let crossover = null;
  for (const f of sorted) {
    const arms = [...new Set(f.runs.map((r) => r.arm))].sort(armOrder);
    if (!arms.length) { lines.push(`${f.name} ${f.size} lines: no runs`); continue; }
    const newest = Object.fromEntries(arms.map((arm) => [arm, newestSet(f.runs, arm).runs]));
    for (const arm of arms) lines.push(row(f.name, f.size, arm, newest[arm], !!f.twoPhase));
    if (!newest.chat) continue;
    const winners = [];
    for (const arm of arms.filter((a) => a !== 'chat')) {
      const c = compare(arm, newest[arm], newest.chat);
      lines.push(c.line);
      if (c.counts && c.noWorse && c.faster) winners.push(arm);
    }
    if (winners.length && !crossover) crossover = `crossover: ${f.name} (${f.size} lines): ${winners.join(', ')} no worse on quality and faster than chat`;
  }
  lines.push(crossover ?? 'crossover: no crossover in these fixtures');
  return lines;
}

/** The CLI: { lines, code } for an argv. `benchDir` holds the fixtures, `resultsDir` the results. */
export function main(argv, { benchDir = here, resultsDir = path.join(here, 'results') } = {}) {
  const usage = { lines: ['usage: node bench/crossover.mjs [--fixtures a,b]'], code: 2 };
  let names;
  if (argv.length === 0) names = fixtureNames(benchDir);
  else if (argv.length === 2 && argv[0] === '--fixtures' && argv[1].trim()) names = [...new Set(argv[1].split(',').map((s) => s.trim()))];
  else return usage;
  try {
    const fixtures = names.map((name) => {
      const f = resolveFixture(name, { benchDir });
      const runs = loadRuns(resultFiles(resultsDir, name)).filter((r) => fixtureOf(r.result) === name);
      return { name, size: referenceSize(f.reference), runs, twoPhase: f.change !== undefined };
    });
    return { lines: crossoverLines(fixtures), code: 0 };
  } catch (e) {
    if (e instanceof FixtureError) return { lines: [e.message], code: 2 };
    return { lines: [`error: ${e.message}`], code: 2 };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { lines, code } = main(process.argv.slice(2));
  (code ? console.error : console.log)(lines.join('\n'));
  process.exit(code);
}
