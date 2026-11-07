// The ship rule (PRD #397): is one set of project-benchmark runs (a change) no worse than another (the baseline)?
//   node bench/shiprule.mjs --baseline "<glob>" --change "<glob>"
// Each glob may match the files of several `--runs` calls; every file it matches is a run of that set. The script
// expands the globs itself (quote them: the Windows shell does not expand them, and a shell that does still works,
// as each flag takes every argument up to the next flag). Results are read only through bench/project-results.mjs.
//
// 1. each set has at least 5 runs; otherwise "not enough runs", no other check, exit 2 (not a FAIL);
// 2. the change's median hidden-test pass count (`passed`) is no lower than the baseline's;
// 3. the change's median fuzz class count is no higher than the baseline's;
// 4. no fuzz class key appears in the change that never appeared in any baseline run;
// 5. the change's blind-review mean (the mean of its runs' reviewScore) is at most 0.5 below the baseline's;
// 6. the change's median escaped defects are no higher than the baseline's.
// A run without a check's value is left out of that check; a check where either set has no such run FAILs with
// "no data". When the runs with `fuzz` do not all share one seed, count and generator hash, checks 3 and 4 FAIL
// with "not comparable". Median wall time, tokens and cost (runTokens / runCost) are printed as information only.
// Exit 0 on PASS (all of 2–6 pass), 1 on FAIL, 2 on not enough runs, more than one arm, or a usage error.
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuzzClassCount, fuzzKeys, fuzzParams, loadRuns, median, reviewScore, runCost, runTokens } from './project-results.mjs';

export const MIN_RUNS = 5;
export const MAX_REVIEW_DROP = 0.5;
// Floating-point slack, so a drop of exactly 0.5 (e.g. 7.3 → 6.8) is not read as 0.5000000000000004.
const EPS = 1e-9;

const has = (v) => v !== null && v !== undefined;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const plain = (v) => String(Math.round(v * 100) / 100);
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const signed = (v, fmt) => (v < 0 ? `-${fmt(-v)}` : `+${fmt(v)}`);
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const mtok = (n) => `${(n / 1e6).toFixed(2)}M`;
const usd = (c) => `$${c.toFixed(2)}`;

/** The runs of a set that have a number for `value`, and those numbers. */
const values = (runs, value) => runs.map((r) => value(r.result)).filter(isNum);

const basedOn = (b, c, bn, cn) => `based on ${b} of ${bn} baseline runs, ${c} of ${cn} change runs`;
const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

/** One numeric check: compare a statistic of the two sets with `ok(base, change)`. */
function numeric(n, label, baseline, change, value, stat, ok, extra = () => '') {
  const b = values(baseline, value);
  const c = values(change, value);
  const on = basedOn(b.length, c.length, baseline.length, change.length);
  if (!b.length || !c.length) return { pass: false, line: `${n}. ${label}: no data (${on}) FAIL` };
  const bs = stat(b);
  const cs = stat(c);
  const pass = ok(bs, cs);
  return { pass, line: `${n}. ${label}: baseline ${plain(bs)} → change ${plain(cs)}${extra(bs, cs)} (${on}) ${verdict(pass)}` };
}

/** The runs with `fuzz` in both sets share one seed, count and generator hash. */
function fuzzComparable(fuzzed) {
  const keys = new Set(fuzzed.map((r) => JSON.stringify(fuzzParams(r.result))));
  return keys.size <= 1;
}

/** Checks 3 and 4: fuzz class count and new class keys, over the runs that have `fuzz`. */
function fuzzChecks(baseline, change) {
  const bf = baseline.filter((r) => r.result?.fuzz);
  const cf = change.filter((r) => r.result?.fuzz);
  const on = basedOn(bf.length, cf.length, baseline.length, change.length);
  const label3 = '3. fuzz classes (median)';
  const label4 = '4. new fuzz classes';
  if (!bf.length || !cf.length) {
    return [{ pass: false, line: `${label3}: no data (${on}) FAIL` }, { pass: false, line: `${label4}: no data (${on}) FAIL` }];
  }
  if (!fuzzComparable([...bf, ...cf])) {
    const params = (runs) => [...new Set(runs.map((r) => {
      const p = fuzzParams(r.result);
      return `seed ${p.seed}, count ${p.count}, generator ${p.genHash}`;
    }))].join('; ');
    const why = `not comparable: baseline ${params(bf)} · change ${params(cf)}`;
    return [{ pass: false, line: `${label3}: ${why} (${on}) FAIL` }, { pass: false, line: `${label4}: ${why} (${on}) FAIL` }];
  }
  const check3 = numeric(3, 'fuzz classes (median)', baseline, change, fuzzClassCount, median, (b, c) => c <= b);
  const seen = new Set(bf.flatMap((r) => fuzzKeys(r.result)));
  const fresh = [...new Set(cf.flatMap((r) => fuzzKeys(r.result)))].filter((k) => !seen.has(k)).sort();
  const check4 = fresh.length
    ? { pass: false, line: `${label4}: ${fresh.length} new: ${fresh.join(', ')} (${on}) FAIL` }
    : { pass: true, line: `${label4}: none (${on}) PASS` };
  return [check3, check4];
}

/** One information line: the median of a value, baseline → change, and the difference. */
function info(label, baseline, change, value, fmt) {
  const b = median(values(baseline, value));
  const c = median(values(change, value));
  if (!has(b) || !has(c)) return `${label}: baseline ${has(b) ? fmt(b) : '–'} → change ${has(c) ? fmt(c) : '–'}`;
  return `${label}: baseline ${fmt(b)} → change ${fmt(c)} (${signed(c - b, fmt)})`;
}

/**
 * The ship rule over two sets of runs (as loadRuns returns them: { name, arm, result }).
 * Returns { lines, code }: the printed lines and the exit code (0 PASS, 1 FAIL, 2 not enough runs or mixed arms).
 */
export function shipRule(baselineRuns, changeRuns) {
  const arms = [...new Set([...baselineRuns, ...changeRuns].map((r) => r.arm))].sort();
  if (arms.length > 1) {
    const list = (runs) => [...new Set(runs.map((r) => r.arm))].sort().join(', ') || 'none';
    return {
      lines: [`more than one arm: baseline ${list(baselineRuns)} · change ${list(changeRuns)}; both sets must be runs of the same arm`],
      code: 2,
    };
  }
  const nb = baselineRuns.length;
  const nc = changeRuns.length;
  const head = `ship rule: arm ${arms[0] ?? '–'} · baseline ${nb} runs · change ${nc} runs`;
  if (nb < MIN_RUNS || nc < MIN_RUNS) {
    const missing = (n) => Math.max(0, MIN_RUNS - n);
    return {
      lines: [head, `1. not enough runs: ${MIN_RUNS} needed in each set; baseline has ${nb} (${missing(nb)} missing), change has ${nc} (${missing(nc)} missing)`],
      code: 2,
    };
  }
  const checks = [
    numeric(2, 'hidden tests passed (median)', baselineRuns, changeRuns, (r) => r?.passed, median, (b, c) => c >= b),
    ...fuzzChecks(baselineRuns, changeRuns),
    numeric(5, 'blind review (mean)', baselineRuns, changeRuns, reviewScore, mean,
      (b, c) => b - c <= MAX_REVIEW_DROP + EPS, (b, c) => `, drop ${plain(b - c)} (at most ${MAX_REVIEW_DROP})`),
    numeric(6, 'escaped defects (median)', baselineRuns, changeRuns, (r) => r?.escapedDefects, median, (b, c) => c <= b),
  ];
  const pass = checks.every((c) => c.pass);
  return {
    lines: [
      head,
      `1. enough runs: baseline ${nb}, change ${nc} (at least ${MIN_RUNS} each) PASS`,
      ...checks.map((c) => c.line),
      'information only (never turns a FAIL into a PASS):',
      `  ${info('wall time (median)', baselineRuns, changeRuns, (r) => r?.wallMs, mins)}`,
      `  ${info('tokens (median, with review halves)', baselineRuns, changeRuns, runTokens, mtok)}`,
      `  ${info('cost (median, with review halves)', baselineRuns, changeRuns, runCost, usd)}`,
      `verdict: ${verdict(pass)}`,
    ],
    code: pass ? 0 : 1,
  };
}

/** The files a glob matches (relative to cwd), as absolute paths, sorted; `\` read as `/` so a Windows path works. */
export function expand(pattern, cwd = process.cwd()) {
  return globSync(pattern.replaceAll('\\', '/'), { cwd }).map((f) => path.resolve(cwd, f)).sort();
}

/** --baseline and --change, each followed by one or more patterns (a shell that expands the glob gives several). */
export function parseArgs(argv) {
  const out = { baseline: [], change: [] };
  let at = null;
  for (const a of argv) {
    if (a === '--baseline' || a === '--change') at = a.slice(2);
    else if (at && !a.startsWith('--')) out[at].push(a);
    else return null;
  }
  return out.baseline.length && out.change.length ? out : null;
}

/** The CLI: { lines, code } for an argv, reading the files the globs match. */
export function main(argv) {
  const args = parseArgs(argv);
  if (!args) return { lines: ['usage: node bench/shiprule.mjs --baseline "<glob>" --change "<glob>"'], code: 2 };
  const files = (patterns) => [...new Set(patterns.flatMap((p) => expand(p)))].sort();
  try {
    return shipRule(loadRuns(files(args.baseline)), loadRuns(files(args.change)));
  } catch (e) {
    return { lines: [`error: ${e.message}`], code: 2 };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { lines, code } = main(process.argv.slice(2));
  console.log(lines.join('\n'));
  process.exit(code);
}
