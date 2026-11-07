// node bench/project-coverage.mjs <checkout> [--timeout-ms N]
// Own-test coverage for the project benchmark (PRD #397): runs a checkout's own `npm test` under Node's built-in V8
// coverage (NODE_V8_COVERAGE, which every child process inherits) and counts the line and branch coverage of its
// source files. Prints { tests, lines, branches } as JSON.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShell } from '../src/exec.ts';

const CODE = /\.(js|mjs|cjs)$/i;
const SKIP = new Set(['.git', '.hx', 'node_modules']);
// what `node --test` picks up by default: *.test.*, *-test.*, *_test.*, test-*.*, test.*, and anything under test/
const TEST_NAME = /^((.*[.\-_])?test|test-.+)\.(js|mjs|cjs)$/i;

/** Every .js/.mjs/.cjs file of the checkout outside .git, .hx and node_modules, relative to it. */
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

/** A path in one form for comparing: the long name of an existing file (no 8.3 short names), case-folded on Windows. */
function key(p) {
  let r = path.resolve(p);
  try { r = realpathSync.native(r); } catch {}
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** The checkout path a V8 script url names (a file URL, or a plain path), or null (node:internal, evalmachine…). */
function urlPath(url) {
  if (url.startsWith('file:')) try { return fileURLToPath(url); } catch { return null; }
  return path.isAbsolute(url) ? url : null;
}

/** Each line holding a non-whitespace character: the offset of that first character in `text`. */
export function codeLines(text) {
  const out = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const i = line.search(/\S/);
    if (i >= 0) out.push(offset + i);
    offset += line.length + 1;
  }
  return out;
}

/** The count of the innermost range holding `offset` (the shortest; a later one wins a tie), or null. */
function countAt(ranges, offset) {
  let best = null;
  for (const r of ranges) {
    if (r.startOffset <= offset && offset < r.endOffset
      && (!best || r.endOffset - r.startOffset <= best.endOffset - best.startOffset)) best = r;
  }
  return best ? best.count : null;
}

/**
 * Count coverage over source files, each { text, runs }: runs holds the V8 `functions` list of each process that
 * loaded it (none: wholly uncovered). A line or branch covered in any process is covered.
 */
export function count(files) {
  const lines = { covered: 0, total: 0 }, branches = { covered: 0, total: 0 };
  for (const { text, runs } of files) {
    const starts = codeLines(text);
    lines.total += starts.length;
    const ranges = runs.map((fns) => fns.flatMap((f) => f.ranges));
    lines.covered += starts.filter((o) => ranges.some((rs) => (countAt(rs, o) ?? 0) > 0)).length;
    // a branch: every block range of a function after its first (the function itself); one per offsets pair
    const seen = new Map();
    for (const fns of runs) for (const f of fns) for (const r of f.ranges.slice(1)) {
      const k = `${r.startOffset}:${r.endOffset}`;
      seen.set(k, seen.get(k) || r.count > 0);
    }
    branches.total += seen.size;
    branches.covered += [...seen.values()].filter(Boolean).length;
  }
  return { lines, branches };
}

/** The `test` script of the checkout's package.json, or null (no readable package.json, no script). */
function testScript(checkout) {
  try {
    const s = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8'))?.scripts?.test;
    return typeof s === 'string' && s.trim() ? s : null;
  } catch { return null; }
}

/** The caller's environment for the own tests: no NODE_TEST* / NODE_OPTIONS / TALLY_LOG / TALLY_NOW, a temp home,
 *  coverage into `covDir`. A removed key is undefined (runShell spreads it over process.env; spawn drops it). */
export function testEnv(covDir, home, env = process.env) {
  const set = { NODE_V8_COVERAGE: covDir, HOME: home, USERPROFILE: home };
  const out = {};
  for (const k of Object.keys(env)) {
    const K = k.toUpperCase();
    if (/^NODE_(TEST|OPTIONS)/.test(K) || K === 'TALLY_LOG' || K === 'TALLY_NOW' || K in set) out[k] = undefined;
  }
  return Object.assign(out, set);
}

/** Every V8 coverage result in `dir`: one { url, functions } list per process. */
function readCoverage(dir) {
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  return names.flatMap((f) => {
    try { return [JSON.parse(readFileSync(path.join(dir, f), 'utf8')).result ?? []]; } catch { return []; }
  });
}

/**
 * Run `checkout`'s own `npm test` under V8 coverage and count the line and branch coverage of its source files.
 * Never throws for a failing or hanging suite: `failed` with `n/a` coverage.
 */
export async function coverage(checkout, { timeoutMs = 30 * 60_000 } = {}) {
  const none = (tests) => ({ tests, lines: 'n/a', branches: 'n/a' });
  const dir = path.resolve(checkout);
  const files = codeFiles(dir);
  if (!testScript(dir) || !files.some(isTestFile)) return none('none');
  const sources = files.filter((f) => !isTestFile(f));
  const covDir = mkdtempSync(path.join(os.tmpdir(), 'hx-cov-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'hx-cov-home-'));
  try {
    const r = await runShell('npm test', { cwd: dir, timeoutMs, env: testEnv(covDir, home) });
    if (r.code !== 0 || r.timedOut) return none('failed');
    // the text as V8 compiled it: Node drops a byte order mark first
    const byKey = new Map(sources.map((f) => [key(path.join(dir, f)),
      { text: readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''), runs: [] }]));
    const urlKeys = new Map();
    for (const scripts of readCoverage(covDir)) for (const s of scripts) {
      if (!urlKeys.has(s.url)) { const p = urlPath(s.url); urlKeys.set(s.url, p ? key(p) : null); }
      byKey.get(urlKeys.get(s.url))?.runs.push(s.functions ?? []);
    }
    return { tests: 'passed', ...count([...byKey.values()]) };
  } catch {
    return none('failed');
  } finally {
    for (const d of [covDir, home]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const t = args.indexOf('--timeout-ms');
  const timeoutMs = t >= 0 ? Number(args[t + 1]) : undefined;
  const checkout = args.find((a, i) => !a.startsWith('--') && (t < 0 || i !== t + 1));
  if (!checkout || (t >= 0 && !(timeoutMs > 0))) {
    console.error('usage: node bench/project-coverage.mjs <checkout> [--timeout-ms N]');
    process.exit(1);
  }
  console.log(JSON.stringify(await coverage(checkout, timeoutMs ? { timeoutMs } : {}), null, 2));
}
