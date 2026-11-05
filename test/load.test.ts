// Auto-scaled workers (#319, PRD #315): src/load.ts (CPU %, the 60 s reading, the target decision, the claim rule),
// the autoWorkers config keys and their validation, and hx run stopping on a bad one. Fixed numbers and times only.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-load-'));
const stateFile = path.join(tmp, 'board.json');
const ghLog = path.join(tmp, 'gh.log');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_GH_LOG = ghLog;

const { cpuBusyPct, decideTarget, initialTarget, loadReading, mayClaim, snapshotOf } = await import('../src/load.ts');
const { autoWorkersConfigError, DEFAULTS } = await import('../src/config.ts');
const { runPool } = await import('../src/pool.ts');

const GB = 1024 ** 3;
const core = (user: number, sys: number, idle: number, nice = 0, irq = 0) => ({ times: { user, nice, sys, idle, irq } });
// a snapshot whose totals grow by 100 per second, `busy` of them busy, over the interval since `prev`
const snap = (at: number, prev: { total: number; idle: number } | null, busy: number, freeGB = 8) => {
  const t = (prev?.total ?? 0) + 100, i = (prev?.idle ?? 0) + (100 - busy);
  return { at, total: t, idle: i, freeMem: freeGB * GB };
};
const series = (start: number, stepMs: number, busy: number[], freeGB = 8) => {
  const out: ReturnType<typeof snap>[] = [snap(start, null, 0, freeGB)];
  busy.forEach((b, k) => out.push(snap(start + (k + 1) * stepMs, out[out.length - 1], b, freeGB)));
  return out;
};

test('cpuBusyPct: (Δtotal − Δidle) / Δtotal over every core; user + nice + sys + idle + irq; Δtotal 0 → 0', () => {
  const a = snapshotOf(0, [core(100, 50, 850), core(200, 0, 800), core(0, 0, 1000, 0, 0), core(10, 10, 970, 5, 5)], 16 * GB);
  assert.equal(a.total, 4000);
  assert.equal(a.idle, 3620);
  assert.equal(a.freeMem, 16 * GB);
  // Δ per core: busy 300/idle 700, busy 100/idle 900, busy 0/idle 1000, busy 200 (nice and irq included)/idle 800
  const b = snapshotOf(5000, [core(300, 150, 1550), core(300, 0, 1700), core(0, 0, 2000), core(100, 50, 1770, 35, 45)], 15 * GB);
  assert.equal(cpuBusyPct(a, b), 15); // 600 busy of 4000
  assert.equal(cpuBusyPct(a, a), 0);
});

test('loadReading: null with 0 or 1 snapshot, a partial window averages what is there, old intervals are left out', () => {
  assert.equal(loadReading([], 1000), null);
  assert.equal(loadReading([snap(0, null, 0)], 1000), null);
  // 3 snapshots over 10 s: two intervals, 40% and 80%
  const s3 = series(0, 5000, [40, 80], 7.9);
  assert.deepEqual(loadReading(s3, 10_000), { cpuPct: 60, freeMemGB: 7.9 });
  // 0 s … 100 s every 20 s: intervals ending at 20 s (older than 60 s at now = 100 s: left out), 40, 60, 80, 100
  const s = series(0, 20_000, [100, 100, 10, 20, 30]);
  assert.equal(loadReading(s, 100_000)!.cpuPct, 40, 'the interval ending exactly 60 s ago counts');
  assert.equal(loadReading(s, 100_001)!.cpuPct, 20);
  assert.equal(loadReading(s, 130_000)!.cpuPct, 25);
  assert.equal(loadReading(s, 200_000), null, 'no interval ended in the last 60 s');
  // free memory is the latest snapshot's, bytes / 1024³
  const m = [{ at: 0, total: 0, idle: 0, freeMem: 4 * GB }, { at: 5000, total: 100, idle: 50, freeMem: 1.5 * GB }];
  assert.deepEqual(loadReading(m, 5000), { cpuPct: 50, freeMemGB: 1.5 });
});

const SET = { ceiling: 3, minWorkers: 1, loadHighPct: 85, loadLowPct: 60, minFreeMemGB: 2, scaleUpMinutes: 5 };
const R = (cpuPct: number, freeMemGB = 8) => ({ cpuPct, freeMemGB });
const MIN = 60_000;

test('decideTarget: starts at the ceiling; down at CPU ≥ high at the first reading, with the line', () => {
  const s0 = initialTarget(3, 0);
  assert.equal(s0.target, 3);
  const d = decideTarget(s0, R(91.4, 7.94), 5000, SET);
  assert.equal(d.state.target, 2);
  assert.equal(d.line, 'workers: 3 → 2 (cpu 91%, free 7.9 GB)');
  assert.equal(decideTarget(s0, R(85), 5000, SET).state.target, 2, 'exactly at loadHighPct is high');
});

test('decideTarget: down on low memory alone; minFreeMemGB 0 turns the memory check off', () => {
  const d = decideTarget(initialTarget(3, 0), R(10, 1.5), 5000, SET);
  assert.equal(d.state.target, 2);
  assert.equal(d.line, 'workers: 3 → 2 (cpu 10%, free 1.5 GB)');
  assert.equal(decideTarget(initialTarget(3, 0), R(10, 0), 5000, { ...SET, minFreeMemGB: 0 }).line, undefined);
});

test('decideTarget: no second step down within 60 s of a change, one after', () => {
  let s = decideTarget(initialTarget(3, 0), R(95), 5000, SET).state;
  const inside = decideTarget(s, R(95), 5000 + MIN - 1, SET);
  assert.equal(inside.state.target, 2);
  assert.equal(inside.line, undefined);
  s = inside.state;
  const after = decideTarget(s, R(95), 5000 + MIN, SET);
  assert.equal(after.state.target, 1);
  assert.equal(after.line, 'workers: 2 → 1 (cpu 95%, free 8.0 GB)');
});

test('decideTarget: between the thresholds changes nothing; null reading changes nothing', () => {
  const s = initialTarget(3, 0);
  for (const cpu of [61, 70, 84.9]) { const d = decideTarget(s, R(cpu), 10 * MIN, SET); assert.equal(d.state.target, 3); assert.equal(d.line, undefined); }
  const down = decideTarget(s, R(90), 5000, SET).state;
  const n = decideTarget(down, null, 20 * MIN, SET);
  assert.deepEqual(n.state, down);
  assert.equal(n.line, undefined);
});

test('decideTarget: up only after scaleUpMinutes of low readings since the last change, with the line', () => {
  let s = decideTarget(initialTarget(3, 0), R(90), 0, SET).state; // 2 at t = 0
  for (const t of [1, 2, 3, 4]) { const d = decideTarget(s, R(52), t * MIN, SET); assert.equal(d.line, undefined, `t=${t}`); s = d.state; }
  assert.equal(decideTarget(s, R(52), 5 * MIN - 1, SET).line, undefined);
  const up = decideTarget(s, R(52.4), 5 * MIN + 30_000, SET);
  assert.equal(up.state.target, 3);
  assert.equal(up.line, 'workers: 2 → 3 (cpu 52% for 5 min)');
  assert.equal(decideTarget(s, R(60), 5 * MIN, SET).state.target, 3, 'exactly at loadLowPct is low');
  // low CPU but too little free memory is not low load
  assert.equal(decideTarget(s, R(10, 1.9), 5 * MIN, SET).state.target, 1, 'low memory is high load: a step down instead');
});

test('decideTarget: the runner start counts as a change for the up wait', () => {
  const s0 = { ...initialTarget(3, 0), target: 2 }; // e.g. a target below the ceiling right at the start
  assert.equal(decideTarget(s0, R(10), 5 * MIN - 1, SET).line, undefined);
  assert.equal(decideTarget(s0, R(10), 5 * MIN, SET).line, 'workers: 2 → 3 (cpu 10% for 5 min)');
});

test('decideTarget: a between-thresholds reading restarts the up wait from its own time', () => {
  let s = decideTarget(initialTarget(3, 0), R(90), 0, SET).state; // 2 at t = 0
  s = decideTarget(s, R(50), 3 * MIN, SET).state;
  s = decideTarget(s, R(70), 4 * MIN, SET).state; // between: the wait starts again at 4 min
  assert.equal(s.target, 2);
  for (const t of [5, 6, 7, 8]) { const d = decideTarget(s, R(50), t * MIN, SET); assert.equal(d.line, undefined, `t=${t}`); s = d.state; }
  assert.equal(decideTarget(s, R(50), 9 * MIN - 1, SET).line, undefined);
  assert.equal(decideTarget(s, R(50), 9 * MIN, SET).line, 'workers: 2 → 3 (cpu 50% for 5 min)');
  // a high reading that cannot step down (inside 60 s of a change) restarts the wait too
  let h = decideTarget(initialTarget(3, 0), R(90), 0, SET).state;
  h = decideTarget(h, R(90), 30_000, SET).state;
  assert.equal(h.target, 2);
  assert.equal(decideTarget(h, R(50), 5 * MIN, SET).line, undefined);
  assert.equal(decideTarget(h, R(50), 5 * MIN + 30_000, SET).line, 'workers: 2 → 3 (cpu 50% for 5 min)');
});

test('decideTarget: never below the floor nor above the ceiling', () => {
  const atFloor = { ...initialTarget(3, 0), target: 1 };
  const hi = decideTarget(atFloor, R(99), 10 * MIN, SET);
  assert.equal(hi.state.target, 1);
  assert.equal(hi.line, undefined);
  const atCeiling = initialTarget(3, 0);
  const lo = decideTarget(atCeiling, R(5), 60 * MIN, SET);
  assert.equal(lo.state.target, 3);
  assert.equal(lo.line, undefined);
  const floor2 = decideTarget({ ...initialTarget(3, 0), target: 2 }, R(99), 10 * MIN, { ...SET, minWorkers: 2 });
  assert.equal(floor2.state.target, 2);
  assert.equal(floor2.line, undefined);
});

test('decideTarget: a ceiling below minWorkers clamps the floor to the ceiling, no error', () => {
  const s = initialTarget(1, 0);
  const d = decideTarget(s, R(99), 5000, { ...SET, ceiling: 1, minWorkers: 2 });
  assert.equal(d.state.target, 1);
  assert.equal(d.line, undefined);
  const two = decideTarget(initialTarget(2, 0), R(99), 5000, { ...SET, ceiling: 2, minWorkers: 3 });
  assert.equal(two.state.target, 2, 'floor = min(3, 2) = 2');
});

test('mayClaim: the gate counts as one; the floor counts sessions only; the floor clamped to the ceiling', () => {
  assert.equal(mayClaim({ sessions: 1, gateRunning: true, target: 2, minWorkers: 1, ceiling: 2 }), false);
  assert.equal(mayClaim({ sessions: 1, gateRunning: false, target: 2, minWorkers: 1, ceiling: 2 }), true);
  assert.equal(mayClaim({ sessions: 0, gateRunning: true, target: 1, minWorkers: 1, ceiling: 2 }), true);
  assert.equal(mayClaim({ sessions: 1, gateRunning: true, target: 1, minWorkers: 1, ceiling: 2 }), false);
  assert.equal(mayClaim({ sessions: 1, gateRunning: true, target: 1, minWorkers: 2, ceiling: 2 }), true);
  assert.equal(mayClaim({ sessions: 1, gateRunning: false, target: 1, minWorkers: 3, ceiling: 1 }), false, 'floor min(3, 1) = 1');
  assert.equal(mayClaim({ sessions: 0, gateRunning: true, target: 0, minWorkers: 3, ceiling: 1 }), true);
});

test('config: the autoWorkers keys and their defaults', () => {
  assert.deepEqual([DEFAULTS.minWorkers, DEFAULTS.autoWorkers, DEFAULTS.loadHighPct, DEFAULTS.loadLowPct, DEFAULTS.minFreeMemGB, DEFAULTS.scaleUpMinutes],
    [1, true, 85, 60, 2, 5]);
});

test('autoWorkersConfigError: accepts the defaults, minFreeMemGB 0 and every key unset', () => {
  assert.equal(autoWorkersConfigError(DEFAULTS), null);
  assert.equal(autoWorkersConfigError({ ...DEFAULTS, autoWorkers: false }), null);
  assert.equal(autoWorkersConfigError({ ...DEFAULTS, minFreeMemGB: 0 }), null);
  assert.equal(autoWorkersConfigError({}), null);
  assert.equal(autoWorkersConfigError({ workers: 3, minWorkers: 3 }), null);
  assert.equal(autoWorkersConfigError({ loadLowPct: 0, loadHighPct: 100 }), null);
});

test('autoWorkersConfigError: rejects each bad value with its key, whatever autoWorkers is', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ workers: 2, minWorkers: 3 }, /^minWorkers: 3 must not be above workers \(2\)$/],
    [{ minWorkers: 0 }, /^minWorkers: 0 must be a whole number, 1 or more$/],
    [{ minWorkers: -1 }, /^minWorkers: -1 must be a whole number/],
    [{ minWorkers: 1.5 }, /^minWorkers: 1\.5 must be a whole number/],
    [{ minWorkers: '2' }, /^minWorkers: "2" must be a whole number/],
    [{ loadHighPct: -1 }, /^loadHighPct: -1 must be a number from 0 to 100$/],
    [{ loadHighPct: 101 }, /^loadHighPct: 101 must be a number from 0 to 100$/],
    [{ loadHighPct: '85' }, /^loadHighPct: "85" must be a number from 0 to 100$/],
    [{ loadLowPct: -5 }, /^loadLowPct: -5 must be a number from 0 to 100$/],
    [{ loadLowPct: 100.5 }, /^loadLowPct: 100\.5 must be a number/],
    [{ loadLowPct: null }, /^loadLowPct: null must be a number/],
    [{ loadLowPct: 85, loadHighPct: 85 }, /^loadLowPct: 85 must be below loadHighPct \(85\)$/],
    [{ loadLowPct: 90, loadHighPct: 85 }, /^loadLowPct: 90 must be below loadHighPct \(85\)$/],
    [{ minFreeMemGB: -1 }, /^minFreeMemGB: -1 must be a number of GB, 0 or more/],
    [{ minFreeMemGB: '2' }, /^minFreeMemGB: "2" must be a number/],
    [{ scaleUpMinutes: 0 }, /^scaleUpMinutes: 0 must be a number of minutes above 0$/],
    [{ scaleUpMinutes: -2 }, /^scaleUpMinutes: -2 must be/],
    [{ scaleUpMinutes: '5' }, /^scaleUpMinutes: "5" must be/],
    [{ autoWorkers: 'yes' }, /^autoWorkers: "yes" must be true or false$/],
    [{ autoWorkers: 1 }, /^autoWorkers: 1 must be true or false$/],
  ];
  for (const [c, re] of bad) for (const auto of [true, false]) {
    const cfg = { ...DEFAULTS, ...(c.autoWorkers === undefined ? { autoWorkers: auto } : {}), ...c };
    assert.match(autoWorkersConfigError(cfg) ?? '', re, JSON.stringify(cfg));
  }
});

test('hx run with a bad autoWorkers key logs STOPPED and exits 2 before reading the board', E2E, async () => {
  const root = path.join(tmp, 'app'), stateDir = path.join(root, '.hx');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [{ number: 1, title: 't', body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] }] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };
  let rc: number;
  try {
    rc = await pooled((signal) => runPool({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
      claudeBin: path.join(here, 'fakes', 'claude.mjs'), roleSkills: {}, workers: 2, minWorkers: 3 } }, { workers: 1, watch: false, dryRun: false, signal }));
  } finally { console.log = orig; }
  assert.equal(rc, 2);
  assert.ok(lines.some((l) => l.includes('STOPPED: minWorkers: 3 must not be above workers (2)')), lines.join('\n'));
  let calls = '';
  try { calls = readFileSync(ghLog, 'utf8'); } catch {}
  assert.equal(calls, '', 'no gh call: the board was not read');
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).issues[0].labels, [DEFAULTS.labels.ready], 'not claimed');
});
