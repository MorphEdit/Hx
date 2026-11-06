// Auto-scaled workers in hx run (#320, PRD #315): the target decided once per board read from an injected load reader
// and decision clock, the claim rule (the gate counted as one, the floor), live.json's autoWorkers field, the os
// sampler stopped when the run ends. End to end: real git (a local bare origin), fake gh and claude; the fake
// sessions are held (FAKE_CLAUDE_HOLD) until the test releases them. Passes are counted, never timed.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// isolate.ts turns autoWorkers off for every test; these tests inject their own load reader instead
delete process.env.HX_AUTO_WORKERS;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-aw-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readLive } = await import('../src/runstate.ts');
const { readUsage } = await import('../src/usage.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
/** A repo of its own (a local bare origin) for each test: what one test's sessions push never reaches the next. */
function repo(k: number) {
  const origin = path.join(tmp, `origin${k}.git`);
  const root = path.join(tmp, `app${k}`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  return root;
}
let stateDir = '';

const MIN = 60_000;
const tick = () => new Promise((r) => setTimeout(r, 50));
/** Wait for a condition (no time bound of its own: E2E.timeout is the backstop). */
// each wait also ends on a wrong claim, and fails when the run ends first: a broken claim rule fails at once, not at the timeout
async function until(what: () => boolean, run: Promise<unknown>) {
  let over = false;
  run.then(() => { over = true; }, () => { over = true; });
  while (!what()) { if (over) throw new Error('the run ended before the wait was over'); await tick(); }
}
const held = () => readdirSync(fakeDir).filter((f) => /^held-\d+$/.test(f)).length;
const workerLines = (lines: string[]) => lines.filter((l) => /workers: \d+ → \d+/.test(l));

let run = 0;
/** A fresh repo, board and session dir; issues with HOLD in the body run until the returned release() is called. */
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
const closed = () => JSON.parse(readFileSync(stateFile, 'utf8')).issues.filter((i: any) => i.state === 'CLOSED').length;

test('autoWorkers: a high reading steps 3 → 2 and holds the third claim; a low one held past scaleUpMinutes steps back up and claims it, no session stopped', E2E, async () => {
  const { p, lines, restore, release } = setup([{ number: 1 }, { number: 2 }, { number: 3 }]);
  let reading = { cpuPct: 95, freeMemGB: 32 };
  let reads = 0;
  let now = 1_000_000;
  const done = pooled((signal) => runPool(p, { workers: 3, watch: false, dryRun: false, signal,
    loadReader: () => { reads++; return reading; }, loadClock: () => now })).finally(restore);
  try {
    await until(() => held() >= 2, done);
    assert.ok(reads > 0, 'the reader is called once per board read');
    // further passes (each takes one reading) with the clock not moving: still two claims, one step down
    const r0 = reads;
    writeFileSync(path.join(stateDir, 'wake'), new Date().toISOString());
    await until(() => reads >= r0 + 2 || held() > 2, done);
    assert.equal(held(), 2, 'no third claim under high load');
    assert.equal(lines.filter((l) => /\] impl: /.test(l)).length, 2, lines.join('\n'));
    assert.deepEqual(workerLines(lines).map((l) => l.replace(/^\S+ /, '')), ['workers: 3 → 2 (cpu 95%, free 32.0 GB)']);
    const live = readLive(stateDir)!;
    assert.equal(live.sessions.length, 2, 'both sessions still running');
    assert.equal(live.workers, 3, 'live.workers stays the ceiling');
    assert.deepEqual(live.autoWorkers, { target: 2, cpuPct: 95, freeMemGB: 32 });

    // low load, the clock past scaleUpMinutes since the step down
    reading = { cpuPct: 10, freeMemGB: 32 };
    now += DEFAULTS.scaleUpMinutes * MIN + MIN;
    writeFileSync(path.join(stateDir, 'wake'), new Date(Date.now() + 1000).toISOString());
    await until(() => held() === 3, done);
    assert.deepEqual(workerLines(lines).map((l) => l.replace(/^\S+ /, '')), ['workers: 3 → 2 (cpu 95%, free 32.0 GB)', 'workers: 2 → 3 (cpu 10% for 6 min)']);
    await until(() => readLive(stateDir)?.sessions.length === 3, done);
    assert.equal(closed(), 0, 'the first two still run while the third is claimed');
    assert.equal(readLive(stateDir)!.autoWorkers?.target, 3);
  } finally { release(); }
  assert.equal(await done, 0, lines.join('\n'));
  assert.equal(closed(), 3);
  assert.equal(workerLines(lines).length, 2, 'no further change');
});

test('autoWorkers: false — the reader is never called, workers sessions claimed, no workers: line, no live.autoWorkers', E2E, async () => {
  const { p, lines, restore, release } = setup([{ number: 1 }, { number: 2 }, { number: 3 }], { autoWorkers: false });
  let reads = 0;
  const done = pooled((signal) => runPool(p, { workers: 3, watch: false, dryRun: false, signal,
    loadReader: () => { reads++; return { cpuPct: 99, freeMemGB: 0.5 }; }, loadClock: () => 0 })).finally(restore);
  try {
    await until(() => held() === 3, done);
    const live = readLive(stateDir)!;
    assert.equal(live.sessions.length, 3);
    assert.ok(!('autoWorkers' in live), JSON.stringify(live));
  } finally { release(); }
  assert.equal(await done, 0, lines.join('\n'));
  assert.equal(reads, 0, 'nothing sampled or read');
  assert.deepEqual(workerLines(lines), []);
  const u = readUsage(stateDir);
  assert.ok(u.length && u.every((r) => r.workersTarget === 3), `usage records carry the fixed count: ${JSON.stringify(u.map((r) => r.workersTarget))}`);
});

test('autoWorkers: usage.jsonl records carry the auto-scaled target when they are written, not the ceiling (#322)', E2E, async () => {
  const { p, lines, restore, release } = setup([{ number: 1 }]);
  let reads = 0;
  const done = pooled((signal) => runPool(p, { workers: 3, watch: false, dryRun: false, signal,
    loadReader: () => { reads++; return { cpuPct: 95, freeMemGB: 32 }; }, loadClock: () => 0 })).finally(restore);
  try {
    await until(() => held() === 1, done);
    assert.equal(readLive(stateDir)!.autoWorkers?.target, 2, lines.join('\n'));
  } finally { release(); }
  assert.equal(await done, 0, lines.join('\n'));
  const u = readUsage(stateDir).filter((r) => r.issue === 1);
  assert.ok(u.length, 'the session wrote usage records');
  for (const r of u) assert.equal(r.workersTarget, 2, JSON.stringify(r));
});

test('autoWorkers: live.json carries the target alone before the first reading; no reading leaves the target at the ceiling', E2E, async () => {
  const { p, lines, restore, release } = setup([{ number: 1 }, { number: 2 }]);
  let reads = 0;
  const done = pooled((signal) => runPool(p, { workers: 2, watch: false, dryRun: false, signal,
    loadReader: () => { reads++; return null; }, loadClock: () => 0 })).finally(restore);
  try {
    await until(() => held() === 2, done);
    assert.ok(reads >= 1);
    assert.deepEqual(readLive(stateDir)!.autoWorkers, { target: 2 });
  } finally { release(); }
  assert.equal(await done, 0, lines.join('\n'));
  assert.deepEqual(workerLines(lines), []);
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

for (const workers of [2, 1]) test(`autoWorkers: a running gate counts as one session (workers: ${workers}, idle reading → one session claimed${workers === 1 ? ', the floor' : ', not two'})`, E2E, async () => {
  // #1 merges and starts a gate run that waits; #2 and #3 become ready while it runs
  const { p, lines, restore, release } = setup([{ number: 1, body: '' }, { number: 2, body: 'HOLD\n\n## Blocked by\n#1' }, { number: 3, body: 'HOLD\n\n## Blocked by\n#1' }]);
  const gateRelease = path.join(tmp, `gate-release-${run}`), gateHeld = path.join(tmp, `gate-held-${run}`);
  // the fake session leaves the head's tree as it was: reuseTestedTrees off, so the gate re-runs it rather than reuse the first run (#352)
  p.config = { ...p.config, gate: true, gateCommand: gateScript(gateRelease, gateHeld), reuseTestedTrees: false };
  let reads = 0;
  const done = pooled((signal) => runPool(p, { workers, watch: false, dryRun: false, signal,
    loadReader: () => { reads++; return { cpuPct: 5, freeMemGB: 32 }; }, loadClock: () => 0 })).finally(restore);
  try {
    await until(() => existsSync(gateHeld) && held() >= 1, done);
    assert.ok(reads > 0, 'the reader is called once per board read');
    const r0 = reads;
    writeFileSync(path.join(stateDir, 'wake'), new Date().toISOString());
    await until(() => reads >= r0 + 2 || held() > 1, done);
    assert.equal(held(), 1, `the gate takes the second slot: ${lines.join('\n')}`);
    assert.equal(readLive(stateDir)!.sessions.length, 1);
  } finally { writeFileSync(gateRelease, ''); release(); }
  assert.equal(await done, 0, lines.join('\n'));
  assert.equal(closed(), 3);
  assert.deepEqual(workerLines(lines), [], 'an idle reading at the ceiling changes nothing');
});

test('autoWorkers: the os sampler runs on its own on an unrefed 5 s timer, stopped when the run ends (no pending timer)', E2E, async () => {
  const { p, lines, restore } = setup([]);
  // every 5 s interval the run starts, and whether it is cleared
  const made: { t: ReturnType<typeof setInterval>; cleared: boolean }[] = [];
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => { const t = set(fn, ms); if (ms === 5000) made.push({ t, cleared: false }); return t; }) as typeof setInterval;
  globalThis.clearInterval = ((t?: ReturnType<typeof setInterval>) => { for (const m of made) if (m.t === t) m.cleared = true; clear(t); }) as typeof clearInterval;
  let rc: number;
  try { rc = await pooled((signal) => runPool(p, { workers: 2, watch: false, dryRun: false, signal })).finally(restore); }
  finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
  assert.equal(rc!, 0, lines.join('\n'));
  assert.equal(made.length, 1, 'the sampler started (no reader injected)');
  assert.equal(made[0].t.hasRef(), false, 'unrefed: it never keeps the process alive');
  assert.ok(made[0].cleared, 'stopped when the run ends');
});
