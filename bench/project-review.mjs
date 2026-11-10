// node bench/project-review.mjs <results-a> <results-b> [--fixture <name>]   review those two runs
// node bench/project-review.mjs --all [--fixture <name>]                     review every non-chat run with no scored review yet
// The blind review of two project-benchmark runs (PRD #397): each run's checkout is cloned from its results
// file's `repo`, copied without .git, .hx, node_modules and every name of Hx, Claude, an arm or an author, and
// shown to judge sessions as A and B, in both orders. Each judge scores both copies on the rubric of
// bench/project/review-prompt.md. One entry is appended to the `reviews` list of both results files (the shape
// bench/project-results.mjs documents); no other field of a results file is touched. A review in which every
// judge failed is no review: nothing is written, and --all tries that run again next time.
// Spends real usage: 6 judge sessions per pair by default.
// Fixtures (PRD #439): --fixture defaults to tally. --all reads that fixture's results only and skips the old single
// files (bench/results/project-<arm>.json), listing them. Two files: each file's fixture is its `fixture` field (tally
// when absent); two files of different fixtures, or of a fixture other than --fixture, are a usage error (exit 2)
// before any clone or judge session. The judges get that fixture's brief.md.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS, workerArgs } from '../src/config.ts';
import { run } from '../src/exec.ts';
import { DEFAULT_FIXTURE, FixtureError, fixtureOf, resolveFixture, takeFixtureArg } from './project-fixtures.mjs';
import { isOldRun, loadRuns, newestSet, resultFiles } from './project-results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SEED = 1107; // decides, per judge, which run's copy is A in its first order
export const CRITERIA = ['correctness', 'edgeCases', 'errorMessages', 'clarity', 'tests', 'docs'];
export const JUDGE_MODEL = 'claude-opus-5-5';
// the lean set with read-only tools: no Bash, Edit or Write
export const JUDGE_FLAGS = workerArgs({ ...DEFAULTS, leanWorkers: true, workerTools: ['Read', 'Glob', 'Grep'], claudeArgs: [] });
const FIXED_NAMES = ['hx', 'hx1', 'hx3', 'chat', 'claude', 'anthropic'];
const SKIP = new Set(['.git', '.hx', 'node_modules']);
const TOKEN_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'];
const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/** The names to hide for a checkout: the fixed ones, the owner and repo name of `repo`, and every author and
 *  committer name and email in its git log (none when it has no history). */
export function checkoutNames(dir, repo) {
  let log = '';
  try {
    log = execFileSync('git', ['log', '--all', '--format=%an%n%ae%n%cn%n%ce'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* not a repo, or no commit */ }
  const fromRepo = repo ? repo.split('/') : [];
  return [...new Set([...FIXED_NAMES, ...fromRepo, ...log.split('\n')].map((s) => s.trim()).filter(Boolean))];
}

/** A case-insensitive whole-word matcher for the names (a word is letters, digits and `_`). */
export function namesPattern(names) {
  const alts = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Copies src to dest without .git, .hx, node_modules and every file or directory whose name holds one of
 *  the names; in every other text file each name is replaced with [redacted]. A binary file (a NUL byte in
 *  its first 8000 bytes) is copied as it is; a symbolic link is not followed. */
export function anonymise(src, dest, names) {
  const re = namesPattern(names);
  const named = (n) => { re.lastIndex = 0; return re.test(n); };
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const d of readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(d.name) || named(d.name)) continue;
      const a = path.join(from, d.name), b = path.join(to, d.name);
      if (d.isDirectory()) walk(a, b);
      else if (d.isFile()) {
        const buf = readFileSync(a);
        if (isBinary(buf)) { writeFileSync(b, buf); continue; }
        const utf8 = buf.toString('utf8');
        const enc = Buffer.from(utf8, 'utf8').equals(buf) ? 'utf8' : 'latin1'; // invalid UTF-8 keeps its bytes
        writeFileSync(b, Buffer.from(buf.toString(enc).replace(re, '[redacted]'), enc));
      }
    }
  };
  walk(src, dest);
}

/** A small seeded PRNG (mulberry32): the same seed gives the same sequence on every machine. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** For each judge, whether run X's copy is A in its first order. */
export function firstOrders(seed, judges) {
  const r = prng(seed);
  return Array.from({ length: judges }, () => r() < 0.5);
}

/** The judges' prompt: bench/project/review-prompt.md with the brief in it. */
export function renderPrompt(brief, template = readFileSync(path.join(here, 'project', 'review-prompt.md'), 'utf8')) {
  return template.replace('{{BRIEF}}', () => brief.trimEnd());
}

/** The JSON objects in a text: every balanced {…} span that parses, outermost first. */
function jsonObjects(text) {
  const out = [];
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    let depth = 0, str = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { out.push(JSON.parse(text.slice(i, j + 1))); i = j; } catch { /* not JSON from here */ }
        break;
      }
    }
  }
  return out;
}

/** A judge's reply → { A: scores, B: scores } or { error }: every criterion an integer 0–10 for both copies. */
export function parseReply(text) {
  const objs = jsonObjects(String(text ?? '')).filter((o) => o && typeof o === 'object' && ('A' in o || 'B' in o));
  if (!objs.length) return { error: 'no JSON object with A and B in the reply' };
  const o = objs[objs.length - 1];
  const out = {};
  for (const label of ['A', 'B']) {
    const s = o[label];
    if (!s || typeof s !== 'object') return { error: `${label} missing` };
    out[label] = {};
    for (const c of CRITERIA) {
      if (!(c in s)) return { error: `${label}.${c} missing` };
      const v = s[c];
      if (!Number.isInteger(v) || v < 0 || v > 10) return { error: `${label}.${c} not an integer 0-10: ${JSON.stringify(v)}` };
      out[label][c] = v;
    }
  }
  return out;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const emptyTokens = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 });

/** The default judge runner: one Claude session in cwd, with only the flags given (the lean set, read-only). */
export async function claudeJudge({ prompt, cwd, model, effort, flags, bin = 'claude' }) {
  const r = await runGoal({
    bin, cwd, model, effort, extraArgs: flags, timeoutMs: 30 * 60_000, stallMs: DEFAULTS.stallMinutes * 60_000,
    prompt, promise: 'REVIEW DONE', continuePrompt: '', maxIterations: 1,
  });
  if (r.stopReason === 'limited') return { error: 'usage limit', usage: r.usage, costUsd: r.costUsd };
  if (!r.last?.ok) return { error: r.last?.error ?? r.stopReason, usage: r.usage, costUsd: r.costUsd };
  return { text: r.last.final ?? r.last.text, usage: r.usage, costUsd: r.costUsd };
}

/** `claude --version`, or null when it does not answer. */
export async function claudeVersion(bin = 'claude') {
  try {
    const p = await run(bin, ['--version']);
    return p.code === 0 ? p.stdout.trim() : null;
  } catch { return null; }
}

/**
 * Reviews checkout dirX against dirY. Each of `judges` judges sees the anonymised copies as A/B and again as B/A;
 * a reply that does not parse, or a judge error, is retried once, then that judge and order is missing for both.
 * → { seed, judges, x, y, tokens, costUsd }, x and y { verdicts, missing, score, basedOn }; tokens and costUsd
 * are the whole review's.
 */
export async function review(dirX, dirY, {
  judge = claudeJudge, judges = 3, seed = SEED, brief = readFileSync(path.join(here, 'project', 'brief.md'), 'utf8'),
  repoX, repoY, model = JUDGE_MODEL, effort = DEFAULTS.effort, version, log = () => {},
} = {}) {
  const names = [...new Set([...checkoutNames(dirX, repoX), ...checkoutNames(dirY, repoY)])];
  const flags = [...JUDGE_FLAGS];
  const prompt = renderPrompt(brief);
  const tokens = emptyTokens();
  let costUsd = 0;
  const side = () => ({ verdicts: [], missing: [], score: null, basedOn: 0 });
  const x = side(), y = side();
  // two working directories: one with X's copy as A, one with Y's copy as A
  const ws = { x: mkdtempSync(path.join(os.tmpdir(), 'hxr-')), y: mkdtempSync(path.join(os.tmpdir(), 'hxr-')) };
  try {
    for (const [first, a, b] of [['x', dirX, dirY], ['y', dirY, dirX]]) {
      writeFileSync(path.join(ws[first], 'brief.md'), brief);
      anonymise(a, path.join(ws[first], 'A'), names);
      anonymise(b, path.join(ws[first], 'B'), names);
    }
    const xFirst = firstOrders(seed, judges);
    for (let j = 1; j <= judges; j++) {
      for (const order of ['AB', 'BA']) {
        const xIsA = order === 'AB' ? xFirst[j - 1] : !xFirst[j - 1];
        let reason;
        for (let attempt = 1; attempt <= 2; attempt++) {
          let r;
          try { r = await judge({ prompt, cwd: xIsA ? ws.x : ws.y, model, effort, flags: [...flags] }); } catch (e) { r = { error: e?.message ?? String(e) }; }
          for (const k of TOKEN_KEYS) { const n = r?.usage?.[k] ?? 0; tokens[k] += n; tokens.total += n; }
          costUsd += r?.costUsd ?? 0;
          const p = r?.error ? { error: `judge error: ${r.error}` } : parseReply(r?.text);
          if (!p.error) {
            for (const [s, label] of [[x, xIsA ? 'A' : 'B'], [y, xIsA ? 'B' : 'A']]) {
              s.verdicts.push({ judge: j, order, label, scores: p[label], value: mean(CRITERIA.map((c) => p[label][c])) });
            }
            reason = null;
            break;
          }
          reason = p.error;
          log(`judge ${j} ${order} attempt ${attempt}: ${reason}`);
        }
        if (reason) for (const s of [x, y]) s.missing.push({ judge: j, order, reason });
      }
    }
  } finally {
    rm(ws.x); rm(ws.y);
  }
  for (const s of [x, y]) { s.score = mean(s.verdicts.map((v) => v.value)); s.basedOn = s.verdicts.length; }
  const claude = version === undefined ? await claudeVersion() : version;
  return { seed, judges: { role: 'judge', model, effort, flags, claudeVersion: claude }, x, y, tokens, costUsd };
}

/** The entry for one side of a review: its own verdicts and score, and half of the review's tokens and cost. */
export function reviewEntry(r, side, other) {
  const s = r[side];
  const tokens = Object.fromEntries(Object.entries(r.tokens).map(([k, v]) => [k, v / 2]));
  return { other, seed: r.seed, verdicts: s.verdicts, missing: s.missing, score: s.score, basedOn: s.basedOn, judges: r.judges, tokens, costUsd: r.costUsd / 2 };
}

/** Appends entry to the `reviews` list of a results file; every other field is written back as it was read. */
export function appendReview(file, entry) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  result.reviews = [...(Array.isArray(result.reviews) ? result.reviews : []), entry];
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
}

/** gh repo clone of the repo's default branch into dest. */
export function ghClone(repo, dest) {
  execFileSync('gh', ['repo', 'clone', repo, dest, '--', '-q'], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Reviews the runs of two results files: each checkout cloned into a fresh temp directory, removed after
 *  (also on failure); then one entry appended to each file. A review with no verdict (every judge failed) throws
 *  and writes nothing; its error has usageLimit set when every judge failed on a usage limit. */
export async function reviewRuns(fileA, fileB, { clone = ghClone, ...opts } = {}) {
  const [a, b] = [fileA, fileB].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  for (const [f, r] of [[fileA, a], [fileB, b]]) if (!r.repo) throw new Error(`${f}: no repo`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hxrc-'));
  try {
    const da = path.join(tmp, '1'), db = path.join(tmp, '2');
    clone(a.repo, da);
    clone(b.repo, db);
    const r = await review(da, db, { ...opts, repoX: a.repo, repoY: b.repo });
    if (r.x.basedOn === 0) {
      const reasons = [...new Set(r.x.missing.map((m) => m.reason))];
      throw Object.assign(new Error(`no verdict: every judge failed (${reasons.join('; ')})`),
        { usageLimit: reasons.length > 0 && reasons.every((m) => /usage limit/.test(m)) });
    }
    appendReview(fileA, reviewEntry(r, 'x', path.basename(fileB)));
    appendReview(fileB, reviewEntry(r, 'y', path.basename(fileA)));
    return r;
  } finally {
    rm(tmp);
  }
}

/** --all: every run of every non-chat arm with no scored review yet (an entry with no verdict does not count), paired
 *  with the chat run of the same i in the newest chat set; so a chat run gets one review per Hx arm. The old single
 *  files are skipped (nor is the newest chat set taken from them). → { pairs: [{ run, chat }], unmatched: [run],
 *  skipped: [run] } (runs as loadRuns gives them; skipped: the old files). */
export function pairRuns(allRuns) {
  const skipped = allRuns.filter(isOldRun);
  const runs = allRuns.filter((r) => !skipped.includes(r));
  const chat = newestSet(runs, 'chat');
  const pairs = [], unmatched = [];
  for (const run of runs) {
    if (run.arm === 'chat') continue;
    if (Array.isArray(run.result.reviews) && run.result.reviews.some((r) => typeof r?.score === 'number')) continue;
    const c = chat?.runs.find((r) => r.i === run.i);
    if (c) pairs.push({ run, chat: c }); else unmatched.push(run);
  }
  return { pairs, unmatched, skipped };
}

/** The fixture of two results files to review: both files' `fixture` (tally when absent) must be one fixture, and
 *  that fixture must be `fixture`. Throws a FixtureError otherwise, before anything is cloned or spent. */
export function pairFixture(fileA, fileB, fixture = DEFAULT_FIXTURE) {
  const [a, b] = [fileA, fileB].map((f) => fixtureOf(JSON.parse(readFileSync(f, 'utf8'))));
  if (a !== b) {
    throw new FixtureError(`different fixtures: ${path.basename(fileA)} is ${a}, ${path.basename(fileB)} is ${b}; review runs of one fixture`);
  }
  if (a !== fixture) throw new FixtureError(`the runs are of fixture ${a}, not ${fixture}: pass --fixture ${a}`);
  return a;
}

export const USAGE = 'usage: node bench/project-review.mjs <results-a> <results-b> [--fixture <name>] | --all [--fixture <name>]';

/**
 * The CLI's plan: { todo: [[fileA, fileB]], brief, skipped: [name], unmatched: [run] }. Throws a FixtureError (exit 2)
 * for an unknown fixture, a missing required file or files of the wrong fixture; returns null for the usage line.
 */
export function plan(argv, { resultsDir } = {}) {
  const { fixture: name, rest } = takeFixtureArg(argv);
  if (name === null) return null;
  const all = rest.length === 1 && rest[0] === '--all';
  const two = rest.length === 2 && !rest.some((a) => a.startsWith('--'));
  if (!all && !two) return null;
  const fixture = resolveFixture(name);
  const brief = readFileSync(fixture.brief, 'utf8');
  if (two) {
    pairFixture(rest[0], rest[1], fixture.name);
    return { todo: [rest], brief, skipped: [], unmatched: [] };
  }
  const runs = loadRuns(resultFiles(resultsDir, fixture.name)).filter((r) => fixtureOf(r.result) === fixture.name);
  const { pairs, unmatched, skipped } = pairRuns(runs);
  return { todo: pairs.map((p) => [p.chat.file, p.run.file]), brief, skipped: skipped.map((r) => r.name), unmatched };
}

const show = (f, r) => `${path.basename(f)} ${r.score === null ? '–' : r.score.toFixed(2)} (${r.basedOn} verdicts)`;

/** Reviews each [fileA, fileB] pair in turn: a pair that fails is logged and the next one goes on, except a usage
 *  limit, which stops the loop (every pair after it would fail the same way). → { reviewed, failed } */
export async function reviewPairs(todo, { run = reviewRuns, say = () => {}, ...opts } = {}) {
  let reviewed = 0, failed = 0;
  for (const [fa, fb] of todo) {
    say(`reviewing ${path.basename(fa)} against ${path.basename(fb)}`);
    let r;
    try {
      r = await run(fa, fb, { log: say, ...opts });
    } catch (e) {
      failed++;
      say(`failed ${path.basename(fa)} against ${path.basename(fb)}: ${e?.message ?? e}`);
      if (e?.usageLimit) { say('usage limit: stopping; run again later to review the rest'); break; }
      continue;
    }
    reviewed++;
    say(`${show(fa, r.x)} · ${show(fb, r.y)} · $${r.costUsd.toFixed(2)}`);
  }
  return { reviewed, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const say = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [project-review] ${m}`);
  let p;
  try { p = plan(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof FixtureError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
  if (!p) {
    console.error(USAGE);
    process.exit(1);
  }
  for (const name of p.skipped) say(`skipped ${name}: an old single file`);
  for (const u of p.unmatched) say(`skipped ${u.name}: no chat run ${u.i} in the newest chat set`);
  const { failed } = await reviewPairs(p.todo, { say, brief: p.brief });
  if (failed) process.exitCode = 1;
}
