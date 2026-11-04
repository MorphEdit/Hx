// `npm run test:profile`: a node --test reporter that records every test's file, name and duration, writes them
// (slowest first) to test-profile.json (HX_TEST_PROFILE moves it) and prints the 20 slowest. Suites are not tests:
// their time is their tests' time.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** One record per finished test (not per suite): its file relative to cwd, its name (a nested test's prefixed with
 *  its parents' names, ' > '), its duration in ms and whether it passed. */
export function collect(events, cwd = process.cwd()) {
  const tests = [];
  const parents = new Map(); // file → names of the suites/tests still open, by nesting
  for (const e of events) {
    const d = e.data ?? {};
    const key = d.file ?? '';
    if (e.type === 'test:start') { const p = parents.get(key) ?? []; p[d.nesting] = d.name; p.length = d.nesting + 1; parents.set(key, p); }
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    if (d.details?.type === 'suite') continue;
    const chain = (parents.get(key) ?? []).slice(0, d.nesting);
    tests.push({
      file: d.file ? path.relative(cwd, d.file).split(path.sep).join('/') : '',
      name: [...chain, d.name].join(' > '),
      ms: Math.round(d.details?.duration_ms ?? 0),
      ok: e.type === 'test:pass',
      ...(d.skip !== undefined && d.skip !== false ? { skip: true } : {}),
      ...(d.todo !== undefined && d.todo !== false ? { todo: true } : {}),
    });
  }
  return tests.sort((a, b) => b.ms - a.ms);
}

/** test-profile.json: the count, the summed time and every test, slowest first. */
export const profile = (tests) => ({ count: tests.length, totalMs: tests.reduce((s, t) => s + t.ms, 0), tests });

const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** The printed summary: the `n` slowest tests, one line each (seconds, file, name). */
export function slowest(tests, n = 20) {
  const top = tests.slice(0, n);
  const w = Math.max(0, ...top.map((t) => sec(t.ms).length));
  return [`${top.length} slowest of ${tests.length} tests (${sec(tests.reduce((s, t) => s + t.ms, 0))} summed):`,
    ...top.map((t) => `  ${sec(t.ms).padStart(w)}  ${t.file}  ${t.name}`)].join('\n') + '\n';
}

export default async function* reporter(source) {
  const events = [];
  for await (const e of source) if (/^test:(start|pass|fail)$/.test(e.type)) events.push(e);
  const tests = collect(events);
  const out = process.env.HX_TEST_PROFILE || 'test-profile.json';
  writeFileSync(out, JSON.stringify(profile(tests), null, 2) + '\n');
  yield `\n${slowest(tests)}wrote ${out}\n`;
}
