// The "Project benchmark" table in docs/benchmark.md, built from the runs bench/project-results.mjs reads
// (loadRuns: the old bench/results/project-<arm>.json files and every bench/results/project/<arm>-<stamp>-<i>.json).
// Pure: no I/O. bench/figures.mjs reads the files and writes docs/benchmark.md when the text changed.
//
// One row per arm, from that arm's newest set (newestSet), `chat` first, then the other arms by name:
// - every number is the median of the set's runs and, in brackets, the range (min–max); the brackets are left
//   out when every run has the same value. A run without a value (null, missing, `n/a`) is left out of that
//   cell; a cell with no value in any run shows – (n/a for coverage);
// - a pair cell (Hidden passed, Issues closed/filed, Coverage lines / branches) gives each part its own median
//   and range; Sessions is the total's median and range, then each role's median; Capped is the number of capped
//   runs (yes / no with n=1); Tokens and Cost are runTokens / runCost (the arm's own plus its review halves);
// - the n column says "single run, supports no claim" when the set has one run.
// Under the table, notes (inside the markers too):
// - fuzz not comparable: the table's runs with `fuzz` do not all share one seed, count and generator hash;
// - config differs: the Claude Code version, or a role's model, effort or flags (the judges' from the
//   `reviews` entries, as role `judge`), takes more than one value across the table's runs. The Hx commit
//   is not compared. A run with no `provenance` is named under "config not recorded".
import {
  coveragePct, fuzzClassCount, fuzzDivergences, fuzzParams, median, newestSet, range, reviewScore, runCost, runTokens,
} from './project-results.mjs';

export const START = '<!-- project-bench:start -->';
export const END = '<!-- project-bench:end -->';

/** A fixture's markers in docs/benchmark.md: tally's are START and END; any other fixture's
 *  `<!-- project-bench:<name>:start -->` and `<!-- project-bench:<name>:end -->`. */
export function markers(fixture = 'tally') {
  return fixture === 'tally' ? { start: START, end: END }
    : { start: `<!-- project-bench:${fixture}:start -->`, end: `<!-- project-bench:${fixture}:end -->` };
}

const DASH = '–';
const NA = 'n/a';
const has = (v) => v !== null && v !== undefined;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const plain = (v) => String(Math.round(v * 10) / 10);
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const mtok = (n) => `${(n / 1e6).toFixed(2)}M`;
const usd = (c) => `$${c.toFixed(2)}`;
const tenth = (v) => v.toFixed(1);
const pct = (v) => `${Math.round(v)}%`;

/** The median and, in brackets, the range of the values that are numbers; `empty` when none is. */
function stat(values, fmt = plain, empty = DASH) {
  const v = values.filter(isNum);
  if (!v.length) return empty;
  const m = fmt(median(v));
  const { min, max } = range(v);
  return min === max ? m : `${m} (${fmt(min)}–${fmt(max)})`;
}

/** A pair cell: each part its own stat; `empty` when neither part has a value. */
function pair(as, bs, fmt = plain, empty = DASH) {
  if (!as.some(isNum) && !bs.some(isNum)) return empty;
  return `${stat(as, fmt, empty)}/${stat(bs, fmt, empty)}`;
}

/** Total sessions (median and range) plus each role's median, e.g. `19 (17–22) (impl 6, review 3)`. */
function sessions(results) {
  const totals = [];
  const roles = [];
  const byRun = [];
  for (const r of results) {
    const s = r.sessions;
    if (isNum(s)) { totals.push(s); continue; }
    if (!has(s) || typeof s !== 'object') continue;
    const counts = Object.entries(s).filter(([, n]) => isNum(n));
    if (!counts.length) continue;
    for (const [role] of counts) if (!roles.includes(role)) roles.push(role);
    totals.push(counts.reduce((a, [, n]) => a + n, 0));
    byRun.push(Object.fromEntries(counts));
  }
  const total = stat(totals);
  if (total === DASH || !roles.length) return total;
  // A role a run with a per-role split did not start counts as 0 sessions of that role in that run.
  return `${total} (${roles.map((role) => `${role} ${plain(median(byRun.map((c) => c[role] ?? 0)))}`).join(', ')})`;
}

function capped(results) {
  const v = results.map((r) => r.capped).filter((c) => typeof c === 'boolean');
  if (!v.length) return DASH;
  if (results.length === 1) return v[0] ? 'yes' : 'no';
  return String(v.filter(Boolean).length);
}

const HEADER = ['Arm', 'n', 'Hidden passed', 'Fuzz divergences', 'Fuzz classes', 'Blind review',
  'Coverage lines/branches', 'Wall time', 'Tokens', 'Cost', 'Sessions', 'Issues closed/filed', 'Audit FAILs',
  'Gate reds', 'Escaped defects', 'Capped'];

function row(arm, set) {
  const rs = set.runs.map((r) => r.result);
  const of = (f) => rs.map(f);
  const n = rs.length;
  return [arm, n === 1 ? '1 (single run, supports no claim)' : String(n),
    pair(of((r) => r.passed), of((r) => r.total)),
    stat(of(fuzzDivergences)), stat(of(fuzzClassCount)), stat(of(reviewScore), tenth),
    pair(of((r) => coveragePct(r, 'lines')), of((r) => coveragePct(r, 'branches')), pct, NA),
    stat(of((r) => r.wallMs), mins), stat(of(runTokens), mtok), stat(of(runCost), usd),
    sessions(rs), pair(of((r) => r.issuesClosed), of((r) => r.issuesFiled)),
    stat(of((r) => r.auditFails)), stat(of((r) => r.gateReds)), stat(of((r) => r.escapedDefects)), capped(rs)];
}

const line = (cells) => `| ${cells.join(' | ')} |`;

/** Each arm's newest set, `chat` first, then the other arms by name: [{ arm, set }]. */
export function tableSets(runs) {
  const arms = [...new Set(runs.map((r) => r.arm))]
    .sort((a, b) => (a === 'chat' ? -1 : b === 'chat' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return arms.map((arm) => ({ arm, set: newestSet(runs, arm) }));
}

const runName = (run) => run.name.replace(/\.json$/, '');
const show = (v) => (has(v) && v !== '' ? `\`${v}\`` : 'none');

/** `value (run, run), value (run)` for a Map of value → run names, in first-seen order. */
const listValues = (values) => [...values].map(([v, names]) => `${show(v)} (${[...names].join(', ')})`).join(', ');

/** field → Map(value → Set(run name)), recording one value of one run. */
function record(fields, field, value, name) {
  if (!fields.has(field)) fields.set(field, new Map());
  const values = fields.get(field);
  const key = Array.isArray(value) ? value.join(' ') : has(value) ? String(value) : null;
  if (!values.has(key)) values.set(key, new Set());
  values.get(key).add(name);
}

function fuzzNote(runs) {
  const fields = new Map();
  for (const run of runs) {
    const p = fuzzParams(run.result);
    if (!p) continue;
    record(fields, 'seed', p.seed, runName(run));
    record(fields, 'count', p.count, runName(run));
    record(fields, 'generator hash', p.genHash, runName(run));
  }
  const differ = [...fields].filter(([, values]) => values.size > 1);
  if (!differ.length) return [];
  return [`- Fuzz not comparable: the runs do not share one seed, count and generator hash: ${
    differ.map(([field, values]) => `${field} ${listValues(values)}`).join('; ')}.`];
}

function configNotes(runs) {
  const fields = new Map();
  const missing = [];
  for (const run of runs) {
    const name = runName(run);
    const p = run.result.provenance;
    if (!p || typeof p !== 'object') missing.push(name);
    else {
      record(fields, 'Claude Code version', p.claudeVersion, name);
      for (const [role, c] of Object.entries(p.roles ?? {})) {
        for (const k of ['model', 'effort', 'flags']) record(fields, `${role} ${k}`, c?.[k], name);
      }
    }
    for (const review of Array.isArray(run.result.reviews) ? run.result.reviews : []) {
      const j = review?.judges;
      if (!j || typeof j !== 'object') continue;
      for (const k of ['model', 'effort', 'flags']) record(fields, `judge ${k}`, j[k], name);
      record(fields, 'judge Claude Code version', j.claudeVersion, name);
    }
  }
  const notes = [...fields].filter(([, values]) => values.size > 1)
    .map(([field, values]) => `- Config differs, ${field}: ${listValues(values)}.`);
  if (missing.length) notes.push(`- Config not recorded: ${missing.join(', ')}.`);
  return notes;
}

/** The notes under the table, one markdown list item each; [] when there is nothing to note. */
export function projectNotes(runs) {
  const shown = tableSets(runs).flatMap(({ set }) => set.runs);
  return [...fuzzNote(shown), ...configNotes(shown)];
}

/** The markdown table, one row per arm from its newest set, then the notes (if any) after a blank line. */
export function projectTable(runs) {
  const rows = tableSets(runs).map(({ arm, set }) => line(row(arm, set)));
  const table = [line(HEADER), line(HEADER.map(() => '---')), ...rows].join('\n');
  const notes = projectNotes(runs);
  return notes.length ? `${table}\n\n${notes.join('\n')}` : table;
}

/**
 * Replaces what is between the fixture's project-bench markers (tally's by default) with the table and its notes.
 * Returns the text unchanged when there are no runs or the markers are missing.
 */
export function updateReadme(readmeText, runs, fixture = 'tally') {
  if (!runs || !runs.length) return readmeText;
  const { start, end } = markers(fixture);
  const a = readmeText.indexOf(start);
  const b = a < 0 ? -1 : readmeText.indexOf(end, a + start.length);
  if (b < 0) return readmeText;
  const eol = readmeText.includes('\r\n') ? '\r\n' : '\n';
  const table = projectTable(runs).replace(/\n/g, eol);
  return `${readmeText.slice(0, a + start.length)}${eol}${table}${eol}${readmeText.slice(b)}`;
}
