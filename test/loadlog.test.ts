// The load history of hx run (#362, PRD #325): one line per minute of the injected load clock in .hx/load.jsonl, with
// the reading, the worker target, the live sessions and the gate; lines older than 7 days dropped at the runner's start;
// malformed lines skipped. End to end: real git (a local bare origin), fake gh and claude; the fake sessions are held
// (FAKE_CLAUDE_HOLD) until the test releases them. The clock is moved by the test, never waited for.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ll-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readLive } = await import('../src/runstate.ts');
const { appendLoadLine, loadFile, loadLineOf, pruneLoadLines, readLoadLines } = await import('../src/loadlog.ts');

const L = DEFAULTS.labels;
const MIN = 60_000, DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const line = (ts: number, x: Record<string, unknown> = {}) => ({ ts: new Date(ts).toISOString(), cpuPct: 50, freeMemGB: 8, target: 2, running: 1, gate: false, ...x });

test('readLoadLines: oldest first, malformed lines skipped, a missing file is none', E2E, () => {
  const dir = mkdtempSync(path.join(tmp, 'r-'));
  assert.deepEqual(readLoadLines(dir), []);
  writeFileSync(loadFile(dir), [JSON.stringify(line(T0)), '{not json', '', JSON.stringify({ ts: 'x', cpuPct: 1 }),
    JSON.stringify(line(T0 + MIN, { cpuPct: '50' })), JSON.stringify(line(T0 + MIN, { target: 1.5 })), JSON.stringify(line(T0 + MIN, { gate: 1 })),
    JSON.stringify(line(T0 + MIN, { ts: 'yesterday' })), JSON.stringify(line(T0 + 2 * MIN, { running: 3 })), 'null'].join('\n') + '\n');
  assert.deepEqual(readLoadLines(dir), [line(T0), line(T0 + 2 * MIN, { running: 3 })]);
  appendLoadLine(dir, line(T0 + 3 * MIN) as any);
  assert.equal(readLoadLines(dir).length, 3);
  assert.deepEqual(readLoadLines(dir).at(-1), line(T0 + 3 * MIN));
});

test('pruneLoadLines: drops the lines older than 7 days (and malformed ones), keeps the rest in order; an all-new file is not rewritten', E2E, () => {
  const dir = mkdtempSync(path.join(tmp, 'p-'));
  assert.equal(pruneLoadLines(dir, T0), 0, 'no file');
  const lines = [line(T0 - 8 * DAY), line(T0 - 7 * DAY - 1), line(T0 - 7 * DAY), line(T0 - DAY), line(T0)];
  writeFileSync(loadFile(dir), lines.map((l) => JSON.stringify(l)).join('\n') + '\ngarbage\n');
  assert.equal(pruneLoadLines(dir, T0), 3);
  assert.deepEqual(readLoadLines(dir), lines.slice(2));
  const text = readFileSync(loadFile(dir), 'utf8');
  assert.equal(pruneLoadLines(dir, T0), 0);
  assert.equal(readFileSync(loadFile(dir), 'utf8'), text);
});

test('loadLineOf: no reading → no line; the reading rounded to one decimal', E2E, () => {
  assert.equal(loadLineOf(T0, null, { target: 2, running: 1, gate: false }), null);
  assert.deepEqual(loadLineOf(T0, { cpuPct: 42.25, freeMemGB: 12.34 }, { target: 3, running: 2, gate: true }),
    { ts: '2026-11-06T10:00:00.000Z', cpuPct: 42.3, freeMemGB: 12.3, target: 3, running: 2, gate: true });
});

/** A repo of its own (a local bare origin) for each test. */
function repo(k: number) {
  const origin = path.join(tmp, `origin${k}.git`);
  const root = path.join(tmp, `app${k}`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  return root;
}
const tick = () => new Promise((r) => setTimeout(r, 50));
/** Wait for a condition (no time bound of its own: E2E.timeout is the backstop); fails when the run ends first. */
async function until(what: () => boolean, run: Promise<unknown>) {
  let over = false;
  run.then(() => { over = true; }, () => { over = true; });
  while (!what()) { if (over) throw new Error('the run ended before the wait was over'); await tick(); }
}
const held = () => readdirSync(fakeDir).filter((f) => /^held-\d+$/.test(f)).length;
let run = 0;
let stateDir = '';
function setup(issues: { number: number; body?: string }[], config: Record<string, unknown> = {}) {
  run++;
  rmSync(fakeDir, { recursive: true, force: true });
  mkdirSync(fakeDir);
  const root = repo(run);
  stateDir = path.join(root, '.hx');
  mkdirSync(stateDir, { recursive: true });
  const holdFile = path.join(tmp, `release-${run}`);
  process.env.FAKE_CLAUDE_HOLD = holdFile;
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: issues.map((i) =>
    ({ number: i.number, title: `task ${i.number}`, body: i.body ?? 'HOLD', state: 'OPEN', labels: [L.ready] })) }));
  const p = { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt${run}`),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, sizeCheck: false, gate: false,
    healthEveryMinutes: 600, ...config } };
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const restore = () => { console.log = orig; };
  return { p, lines, restore, release: () => writeFileSync(holdFile, '') };
}

test('hx run: one line per elapsed minute of the load clock, with the reading, the fixed target, the live sessions and no gate; a minute with no reading writes none', E2E, async () => {
  const { p, lines, restore, release } = setup([{ number: 1 }, { number: 2 }]);
  let now = T0;
  let reading: { cpuPct: number; freeMemGB: number } | null = { cpuPct: 42.25, freeMemGB: 12.34 };
  let reads = 0;
  // autoWorkers is off (isolate.ts): only the load history calls the reader
  const done = pooled((signal) => runPool(p, { workers: 2, watch: false, dryRun: false, signal,
    loadReader: () => { reads++; return reading; }, loadClock: () => now })).finally(restore);
  try {
    await until(() => held() === 2 && readLive(stateDir)?.sessions.length === 2, done);
    assert.equal(reads, 0, 'no minute has passed');
    assert.deepEqual(readLoadLines(stateDir), []);
    now += MIN;
    await until(() => readLoadLines(stateDir).length === 1, done);
    assert.deepEqual(readLoadLines(stateDir), [{ ts: new Date(T0 + MIN).toISOString(), cpuPct: 42.3, freeMemGB: 12.3, target: 2, running: 2, gate: false }]);
    // no reading this minute: no line
    reading = null;
    const r0 = reads;
    now += MIN;
    await until(() => reads > r0, done);
    assert.equal(readLoadLines(stateDir).length, 1);
    reading = { cpuPct: 90, freeMemGB: 2 };
    now += MIN;
    await until(() => readLoadLines(stateDir).length === 2, done);
    assert.deepEqual(readLoadLines(stateDir)[1], { ts: new Date(T0 + 3 * MIN).toISOString(), cpuPct: 90, freeMemGB: 2, target: 2, running: 2, gate: false });
  } finally { release(); }
  assert.equal(await done, 0, lines.join('\n'));
  assert.equal(readLoadLines(stateDir).length, 2, 'the clock did not move again: no further line');
});

// a gate command whose first run passes and whose later runs wait for <release> (writing <marker> as they start)
function gateScript(release: string, marker: string) {
  const f = path.join(tmp, `gate-${run}.mjs`);
  const count = path.join(tmp, `gate-${run}.n`);
  writeFileSync(f, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const n = existsSync(${JSON.stringify(count)}) ? Number(readFileSync(${JSON.stringify(count)}, 'utf8')) + 1 : 1;
writeFileSync(${JSON.stringify(count)}, String(n));
if (n > 1) { writeFileSync(${JSON.stringify(marker)}, ''); const t = setInterval(() => { if (existsSync(${JSON.stringify(release)})) clearInterval(t); }, 50); }
`);
  return `node "${f}"`;
}

test('hx run: a minute while the gate runs has gate: true, the auto-scaled target and the running sessions', E2E, async () => {
  // #1 merges and starts a gate run that waits; #2 and #3 become ready while it runs
  const { p, lines, restore, release } = setup([{ number: 1, body: '' }, { number: 2, body: 'HOLD\n\n## Blocked by\n#1' }, { number: 3, body: 'HOLD\n\n## Blocked by\n#1' }]);
  const gateRelease = path.join(tmp, `gate-release-${run}`), gateHeld = path.join(tmp, `gate-held-${run}`);
  p.config = { ...p.config, gate: true, gateCommand: gateScript(gateRelease, gateHeld) };
  let now = T0;
  const auto = process.env.HX_AUTO_WORKERS;
  delete process.env.HX_AUTO_WORKERS; // autoWorkers on: a high reading steps the target 3 → 2
  const done = pooled((signal) => runPool(p, { workers: 3, watch: false, dryRun: false, signal,
    loadReader: () => ({ cpuPct: 95, freeMemGB: 32 }), loadClock: () => now })).finally(() => { restore(); process.env.HX_AUTO_WORKERS = auto; });
  try {
    await until(() => existsSync(gateHeld) && held() === 1 && readLive(stateDir)?.sessions.length === 1, done);
    assert.equal(readLive(stateDir)!.autoWorkers?.target, 2, lines.join('\n'));
    now += MIN;
    await until(() => readLoadLines(stateDir).length === 1, done);
    assert.deepEqual(readLoadLines(stateDir), [{ ts: new Date(T0 + MIN).toISOString(), cpuPct: 95, freeMemGB: 32, target: 2, running: 1, gate: true }]);
  } finally { writeFileSync(gateRelease, ''); release(); }
  assert.equal(await done, 0, lines.join('\n'));
});

test('hx run: a load.jsonl with lines older and newer than 7 days keeps only the newer ones after the runner starts', E2E, async () => {
  const { p, lines, restore } = setup([]);
  const seeded = [line(T0 - 9 * DAY), line(T0 - 7 * DAY - MIN), line(T0 - 6 * DAY), line(T0 - MIN)];
  writeFileSync(loadFile(stateDir), seeded.map((l) => JSON.stringify(l) + '\n').join(''));
  const rc = await pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal,
    loadReader: () => ({ cpuPct: 1, freeMemGB: 1 }), loadClock: () => T0 })).finally(restore);
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(readLoadLines(stateDir), seeded.slice(2));
});

test('hx run: the os sampler runs for the load history with autoWorkers off too, stopped when the run ends', E2E, async () => {
  const { p, lines, restore } = setup([], { autoWorkers: false });
  const made: { t: ReturnType<typeof setInterval>; cleared: boolean }[] = [];
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => { const t = set(fn, ms); if (ms === 5000) made.push({ t, cleared: false }); return t; }) as typeof setInterval;
  globalThis.clearInterval = ((t?: ReturnType<typeof setInterval>) => { for (const m of made) if (m.t === t) m.cleared = true; clear(t); }) as typeof clearInterval;
  let rc: number;
  try { rc = await pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal })).finally(restore); }
  finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
  assert.equal(rc!, 0, lines.join('\n'));
  assert.equal(made.length, 1, 'the sampler started');
  assert.ok(made[0].cleared, 'stopped when the run ends');
});
