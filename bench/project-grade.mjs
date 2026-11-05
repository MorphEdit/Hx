// node bench/project-grade.mjs <checkout>
// Runs the hidden suite of the project benchmark (bench/project/hidden/) against a checkout, from where it
// is: nothing is copied into the checkout. Prints { passed, failed, total, failures } as JSON.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HIDDEN = path.join(here, 'project', 'hidden');
const REPORTER = path.join(here, 'project-reporter.mjs');

/** The hidden suite's case names (what the reference reports): every grade is out of these. */
export const cases = (hidden = HIDDEN) => JSON.parse(readFileSync(path.join(hidden, 'cases.json'), 'utf8'));

/**
 * Grade `checkout`: one result per hidden case, named "<file> > <test>". The total is always the number of
 * cases in cases.json: a case that never reported (its test file's process ended early) is a failure.
 */
export function grade(checkout, { hidden = HIDDEN } = {}) {
  const files = readdirSync(hidden).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(hidden, f));
  const env = { ...process.env, TALLY_CHECKOUT: path.resolve(checkout) };
  // a grade run from inside a test (npm test) must not report to that runner
  for (const k of Object.keys(env)) if (/^NODE_(TEST|OPTIONS)/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4',
    `--test-reporter=${pathToFileURL(REPORTER).href}`, '--test-reporter-destination=stdout', ...files],
  { cwd: hidden, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) throw r.error;
  const passed = new Set(r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    .filter((x) => x.ok).map((x) => x.name));
  const expected = cases(hidden);
  const failures = expected.filter((name) => !passed.has(name));
  return { passed: expected.length - failures.length, failed: failures.length, total: expected.length, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = process.argv[2];
  if (!checkout) {
    console.error('usage: node bench/project-grade.mjs <checkout>');
    process.exit(1);
  }
  console.log(JSON.stringify(grade(checkout), null, 2));
}
