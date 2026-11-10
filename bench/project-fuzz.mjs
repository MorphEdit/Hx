// node bench/project-fuzz.mjs <checkout> [--fixture <name>] [--reference <dir>] [--seed N] [--count N] [--time-limit-ms N]
// The differential fuzz of the project benchmark (PRD #397): runs the cases of a fixture's generator (tally's:
// bench/project-fuzz-gen.mjs) against a checkout's CLI and against the reference's, compares the two sides byte for
// byte and sorts every divergence into a root-cause class `<feature> / <what differed>`. Prints the results file's
// `fuzz` field as JSON. The data file's name and the two variables each case sets come from the fixture's manifest
// (PRD #439); tally's are tally.log, TALLY_LOG and TALLY_NOW, so its fuzz runs as it always has.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FixtureError, resolveFixture, takeFixtureArg } from './project-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GENERATOR = path.join(here, 'project-fuzz-gen.mjs');
export const DEFAULT_REFERENCE = path.join(here, 'project', 'reference');
const EXAMPLES = 10;
// the log's name in each case's directory, passed relative to it (the working directory): both sides see the same
// TALLY_LOG text, so a CLI that prints its log's path prints the same bytes on both sides and in every run
const LOG = 'tally.log';
/** tally's names: the data file, the variable naming it, the variable holding the case's clock, the CLI's bin. */
export const TALLY_NAMES = { file: LOG, fileEnv: 'TALLY_LOG', nowEnv: 'TALLY_NOW', bin: 'tally' };
/** The harness's names from a fixture's manifest. */
export const namesOf = (manifest) => ({ file: manifest.fuzzFile, fileEnv: manifest.fuzzFileEnv, nowEnv: manifest.fuzzNowEnv, bin: manifest.bin });

/** SHA-256 (hex) of the generator's source with CRLF read as LF: a checkout's line endings do not change it. */
export function genHash(file = GENERATOR) {
  const lf = Buffer.from(readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(lf).digest('hex');
}

/** The CLI file of a checkout: package.json `bin` (a string) or `bin.<name>`, resolved against it; null if none. */
export function cliOf(dir, name = TALLY_NAMES.bin) {
  try {
    const p = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const rel = typeof p?.bin === 'string' ? p.bin : p?.bin?.[name];
    if (typeof rel !== 'string' || !rel) return null;
    const file = path.resolve(dir, rel);
    return existsSync(file) && statSync(file).isFile() ? file : null;
  } catch { return null; }
}

/** A case's environment: the caller's, without NODE_TEST* / NODE_OPTIONS, with the case's log, clock and home
 *  (no clock variable when `names.nowEnv` is null). */
export function caseEnv(dir, now, env = process.env, names = TALLY_NAMES) {
  const set = { [names.fileEnv]: names.file, ...(names.nowEnv ? { [names.nowEnv]: now } : {}), HOME: dir, USERPROFILE: dir };
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const K = k.toUpperCase();
    if (!/^NODE_(TEST|OPTIONS)/.test(K) && !(K in set)) out[k] = v;
  }
  return Object.assign(out, set);
}

/** Run one case on one side, in a fresh temp directory removed afterwards. Never throws. */
export async function runSide(cli, c, timeLimitMs, names = TALLY_NAMES) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-fuzz-'));
  try {
    if (c.log !== null) writeFileSync(path.join(dir, names.file), c.log);
    const r = await new Promise((resolve) => {
      const out = [], err = [];
      let timedOut = false, child;
      try {
        child = spawn(process.execPath, [cli, ...c.args], {
          cwd: dir, env: caseEnv(dir, c.now, process.env, names), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (e) {
        resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(String(e?.message ?? e)), status: null, signal: null, timedOut, error: true });
        return;
      }
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeLimitMs);
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => err.push(b));
      let spawnError = null;
      child.on('error', (e) => { spawnError = e; });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        const stderr = Buffer.concat(err);
        resolve({
          stdout: Buffer.concat(out), stderr: spawnError ? Buffer.concat([stderr, Buffer.from(spawnError.message)]) : stderr,
          status, signal, timedOut, error: !!spawnError,
        });
      });
    });
    const file = path.join(dir, names.file);
    return { ...r, log: existsSync(file) ? readFileSync(file) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Why the reference's result cannot be compared: `hung` (the time limit), `crashed` (Node's uncaught-error
 *  version line, a signal, or no process at all), else null. Exit 1 or 2 with an ordinary message is no crash. */
export function fault(ref) {
  if (ref.timedOut) return 'hung';
  if (ref.signal || ref.error || /^Node\.js v\d/m.test(ref.stderr.toString('latin1'))) return 'crashed';
  return null;
}

const sameBytes = (a, b) => (a === null || b === null ? a === b : a.equals(b));

/** What differed between the arm and the reference, the first of: timed out, exit status, stderr (empty or not),
 *  stdout, log; null when they agree. */
export function differs(arm, ref) {
  if (arm.timedOut) return 'timed out';
  if (arm.status !== ref.status) return 'exit status';
  if ((arm.stderr.length === 0) !== (ref.stderr.length === 0)) return 'stderr';
  if (!sameBytes(arm.stdout, ref.stdout)) return 'stdout';
  if (!sameBytes(arm.log, ref.log)) return 'log';
  return null;
}

/** Bytes as stored: base64 (round-trips) with a UTF-8 preview beside it; null stays null (no log file). */
const bytes = (b) => (b === null ? null : { base64: b.toString('base64'), text: b.toString('utf8') });
const side = (r) => r && {
  stdout: bytes(r.stdout), stderr: bytes(r.stderr), status: r.status, signal: r.signal, timedOut: r.timedOut, log: bytes(r.log),
};
function example(c, ref, arm, names = TALLY_NAMES) {
  return {
    case: { id: c.id, feature: c.feature, args: c.args, log: bytes(c.log) },
    env: { ...(names.nowEnv ? { [names.nowEnv]: c.now } : {}), [names.fileEnv]: names.file, logExisted: c.log !== null },
    reference: side(ref), arm: side(arm),
  };
}

/** Run `fn` over `items` at most `n` at a time; the results in item order, whatever order they finish in. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/**
 * Fuzz `checkout` against `reference`: every generated case on both sides, compared and classed. Throws when the
 * reference has no CLI. A case the reference crashed or hung on is excluded, never counted against the arm.
 * `fixture` (a resolved fixture, bench/project-fixtures.mjs) gives the generator, the default reference and the
 * names; without it, tally's.
 */
export async function fuzz(checkout, {
  fixture, reference = fixture ? fixture.reference : DEFAULT_REFERENCE, seed, count, timeLimitMs = 5000,
  concurrency = Math.max(1, Math.min(8, os.availableParallelism())),
} = {}) {
  const generator = fixture ? fixture.generator : GENERATOR;
  const names = fixture ? namesOf(fixture.manifest) : TALLY_NAMES;
  const gen = await import(pathToFileURL(generator).href);
  seed ??= gen.DEFAULT_SEED;
  count ??= gen.DEFAULT_COUNT;
  const refCli = cliOf(path.resolve(reference), names.bin);
  if (!refCli) throw new Error(`the reference ${reference} has no CLI (package.json bin or bin.${names.bin})`);
  const armCli = cliOf(path.resolve(checkout), names.bin);
  const runs = await pool(gen.generate({ seed, count }), concurrency, async (c) => {
    const ref = await runSide(refCli, c, timeLimitMs, names);
    const why = fault(ref);
    if (why) return { c, ref, excluded: why };
    if (!armCli) return { c, ref, arm: null, cls: 'no CLI' };
    const arm = await runSide(armCli, c, timeLimitMs, names);
    const what = differs(arm, ref);
    return { c, ref, arm, cls: what && `${c.feature} / ${what}` };
  });
  const result = {
    seed, count, genHash: genHash(generator), timeLimitMs, divergences: 0, classes: {}, excluded: { count: 0, examples: [] }, examples: {},
  };
  for (const r of runs) {
    if (r.excluded) {
      if (result.excluded.count++ < EXAMPLES) result.excluded.examples.push({ reason: r.excluded, ...example(r.c, r.ref, null, names) });
    } else if (r.cls) {
      result.divergences++;
      result.classes[r.cls] = (result.classes[r.cls] ?? 0) + 1;
      const list = (result.examples[r.cls] ??= []);
      if (list.length < EXAMPLES) list.push(example(r.c, r.ref, r.arm, names));
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { fixture: name, rest: args } = takeFixtureArg(process.argv.slice(2));
  const flags = { '--reference': 'reference', '--seed': 'seed', '--count': 'count', '--time-limit-ms': 'timeLimitMs' };
  const opts = {};
  let checkout, bad = false;
  for (let i = 0; i < args.length; i++) {
    const k = flags[args[i]];
    if (k) {
      const v = args[++i];
      if (v === undefined) bad = true;
      else if (k === 'reference') opts.reference = v;
      else if (/^\d+$/.test(v) && (k === 'seed' || Number(v) > 0)) opts[k] = Number(v);
      else bad = true;
    } else if (!args[i].startsWith('--') && checkout === undefined) checkout = args[i];
    else bad = true;
  }
  if (!checkout || bad || name === null) {
    console.error('usage: node bench/project-fuzz.mjs <checkout> [--fixture <name>] [--reference <dir>] [--seed N] [--count N] [--time-limit-ms N]');
    process.exit(1);
  }
  try { opts.fixture = resolveFixture(name); } catch (e) {
    if (!(e instanceof FixtureError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
  console.log(JSON.stringify(await fuzz(checkout, opts), null, 2));
}
