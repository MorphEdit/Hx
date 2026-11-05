// Budget calibration, the per-role forecast and the gate decision (PRD #130 B, C): pure functions over readings and usage records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionForecast, calibrate, currentReading, forecastPct, gateDecision, percentile, roleForecast, sessions, type Reading } from '../src/budget.ts';
import { DEFAULTS } from '../src/config.ts';
import type { UsageRecord } from '../src/usage.ts';
import { docsText } from './docs-text.ts';

const t = (min: number) => new Date(Date.UTC(2026, 10, 2, 10, min)).toISOString();
const rd = (min: number, utilization: number, resetsAt = 9_999_999_999, window = 'five_hour'): Reading => ({ ts: t(min), window, utilization, resetsAt });
let seq = 0;
const u = (min: number, costUsd: number, role = 'impl', sessionId = `s${seq++}`): UsageRecord => ({
  ts: t(min), issue: 1, role, sessionId, iteration: 1, model: 'm', ok: true,
  usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd, durationMs: 0, numTurns: 1,
});

test('percentile: nearest rank, empty is undefined', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 20), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 80), 4);
  assert.equal(percentile([1, 2, 3], 80), 3);
  assert.equal(percentile([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 20), 3); // rank ceil(2.4) = 3
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([7], 0), 7); // rank max(1, 0)
});

test('currentReading: the latest reading of the window by ts; a passed resetsAt counts as 0% and expired', () => {
  const now = new Date(t(30));
  const future = Math.floor(now.getTime() / 1000) + 3600, past = Math.floor(now.getTime() / 1000) - 1;
  const rs = [rd(20, 0.5, future), rd(10, 0.9, future), rd(25, 0.3, future, 'seven_day')];
  assert.deepEqual(currentReading(rs, 'five_hour', now), rd(20, 0.5, future));
  assert.equal(currentReading(rs, 'nope', now), undefined);
  const exp = currentReading([rd(20, 0.85, past)], 'five_hour', now)!;
  assert.equal(exp.utilization, 0);
  assert.equal(exp.expired, true);
  const atNow = currentReading([rd(20, 0.85, Math.floor(now.getTime() / 1000))], 'five_hour', now)!;
  assert.equal(atNow.expired, true); // resetsAt <= now
});

// Fixture: five_hour rises 10→20→40→45, falls to 30, rises to 35 within one reset; then a new reset.
const R = [
  rd(0, 0.10), rd(10, 0.20), rd(20, 0.40), rd(30, 0.45), rd(40, 0.30), rd(50, 0.35),
  rd(60, 0.40, 1), // a different resetsAt: the pair 50→60 is not used
  rd(70, 0.50, 1), // 60→70 is a rise with no cost in between: skipped
];
const U = [
  u(0, 100), // at the first reading's ts: not in (0, 10]
  u(5, 1), u(10, 1), // (0,10]: 2 → 2/10 = 0.2 per %
  u(15, 2), u(20, 0.5, 'checkpoint'), u(20, 1.5), // (10,20]: 4, checkpoint included → 4/20 = 0.2
  u(25, 0.5), // (20,30]: 0.5/5 = 0.1
  u(35, 9), // (30,40]: a fall: skipped
  u(45, 2), // (40,50]: 2/5 = 0.4
  u(55, 50), // (50,60]: across a reset: skipped
];

test('calibrate: fits per rise, cost of every record in (first.ts, second.ts], p20 once calibrated', () => {
  const shuffled = [R[3], R[0], R[7], R[5], R[1], R[6], R[2], R[4]]; // sorted by ts before pairing
  const [c] = calibrate(shuffled, U, 3);
  assert.equal(c.window, 'five_hour');
  assert.deepEqual(c.fits.map((f) => +f.toFixed(6)), [0.2, 0.2, 0.1, 0.4]);
  assert.equal(c.pairs, 4);
  assert.equal(+c.usdPerPct!.toFixed(6), 0.1); // p20 of [0.1, 0.2, 0.2, 0.4] = rank 1
});

test('calibrate: uncalibrated below minPairs (no usdPerPct, pairs reported); one entry per window', () => {
  const [c] = calibrate(R, U, 5);
  assert.equal(c.pairs, 4);
  assert.equal('usdPerPct' in c, false);
  const both = calibrate([...R, rd(0, 0.1, 5, 'seven_day'), rd(10, 0.2, 5, 'seven_day')], U, 1);
  assert.deepEqual(both.map((x) => x.window).sort(), ['five_hour', 'seven_day']);
  assert.equal(both.find((x) => x.window === 'seven_day')!.pairs, 1);
  assert.equal(DEFAULTS.budgetMinPairs, 5);
});

test('calibrate: checkpoint records count in the pair cost', () => {
  const [c] = calibrate([rd(0, 0.1), rd(10, 0.2)], [u(5, 3, 'checkpoint')], 1);
  assert.deepEqual(c.fits.map((f) => +f.toFixed(6)), [0.3]);
});

test('sessions: grouped by sessionId, checkpoint excluded, cost summed', () => {
  const s = sessions([u(1, 1, 'impl', 'a'), u(2, 2, 'impl', 'a'), u(3, 5, 'checkpoint', 'a'), u(4, 4, 'audit', 'b'), u(5, 7, 'checkpoint', 'c')]);
  assert.deepEqual(s.sort((x, y) => x.sessionId.localeCompare(y.sessionId)), [
    { sessionId: 'a', role: 'impl', costUsd: 3 }, { sessionId: 'b', role: 'audit', costUsd: 4 },
  ]);
});

const sess = (role: string, ...costs: number[]) => costs.map((c) => u(0, c, role));

test('roleForecast: p80 per role; all roles when the role has < 3; undefined under 3 in total', () => {
  const usage = [...sess('impl', 1, 2, 3, 4, 5), ...sess('audit', 10, 20), u(0, 1000, 'checkpoint')];
  assert.equal(roleForecast(usage, 'impl'), 4);
  assert.equal(roleForecast(usage, 'audit'), 10); // p80 of [1,2,3,4,5,10,20] = rank 6 → 10 (checkpoint excluded)
  assert.equal(roleForecast(sess('audit', 10, 20), 'audit'), undefined);
  assert.equal(roleForecast([], 'impl'), undefined);
});

test('actionForecast: impl (+ audit), gauntlet = critic + revise, single roles, engine steps undefined', () => {
  const usage = [...sess('impl', 1, 2, 3), ...sess('audit', 10, 10, 10), ...sess('critic', 4, 4, 4), ...sess('revise', 5, 5, 5),
    ...sess('triage', 6, 6, 6), ...sess('decompose', 7, 7, 7), ...sess('review', 8, 8, 8), ...sess('security', 9, 9, 9)];
  const impl = { kind: 'impl', issue: 1, title: 'x' } as const;
  assert.equal(actionForecast(impl, usage, { audit: true }), 13);
  assert.equal(actionForecast(impl, usage, { audit: false }), 3);
  assert.equal(actionForecast({ kind: 'gauntlet', prd: 1, title: 'x' }, usage, { audit: true }), 9);
  assert.equal(actionForecast({ kind: 'triage', issue: 1, title: 'x' }, usage, { audit: true }), 6);
  assert.equal(actionForecast({ kind: 'decompose', prd: 1, title: 'x', children: [] }, usage, { audit: true }), 7);
  assert.equal(actionForecast({ kind: 'review', prd: 1, title: 'x', children: [] }, usage, { audit: true }), 8);
  assert.equal(actionForecast({ kind: 'security', prd: 1, title: 'x', children: [] }, usage, { audit: true }), 9);
  assert.equal(actionForecast({ kind: 'close-prd', prd: 1 }, usage, { audit: true }), undefined);
  assert.equal(actionForecast({ kind: 'label-ready', issue: 1, prd: 1 }, usage, { audit: true }), undefined);
  assert.equal(actionForecast(impl, sess('impl', 1, 2), { audit: false }), undefined); // no forecast
});

test('forecastPct is usd / usdPerPct', () => {
  assert.equal(forecastPct(7, 0.5), 14);
});

test('gateDecision: blocks when used + forecast > cap on a calibrated window with a current reading', () => {
  const now = new Date(t(30));
  const future = Math.floor(now.getTime() / 1000) + 3600, past = Math.floor(now.getTime() / 1000) - 60;
  const cal = [{ window: 'five_hour', fits: [0.5], pairs: 5, usdPerPct: 0.5 }];
  const readings = [rd(10, 0.85, future)];
  const b = gateDecision(3.5, cal, readings, 0.9, now)!; // 3.5 / 0.5 = 7%
  assert.equal(b.window, 'five_hour');
  assert.ok(Math.abs(b.needPct - 7) < 1e-9);
  assert.ok(Math.abs(b.usedPct - 85) < 1e-9);
  assert.ok(Math.abs(b.capPct - 90) < 1e-9);
  assert.equal(b.resetsAt, future);
  assert.equal(gateDecision(1.5, cal, readings, 0.9, now), null); // 3%
  assert.equal(gateDecision(3.5, cal, [rd(10, 0.85, past)], 0.9, now), null); // reset passed
  assert.equal(gateDecision(3.5, [{ window: 'five_hour', fits: [0.5], pairs: 1 }], readings, 0.9, now), null); // uncalibrated
  assert.equal(gateDecision(undefined, cal, readings, 0.9, now), null); // no forecast
  assert.equal(gateDecision(3.5, cal, [rd(10, 0.85, future, 'seven_day')], 0.9, now), null); // no current reading
  const two = [{ window: 'seven_day', fits: [1], pairs: 5, usdPerPct: 1 }, ...cal];
  assert.equal(gateDecision(3.5, two, [...readings, rd(10, 0.5, future, 'seven_day')], 0.9, now)!.window, 'five_hour'); // first that blocks
});

test('README config table has the budgetMinPairs row with its default', () => {
  const readme = docsText();
  assert.ok(readme.split('\n').some((l) => l.startsWith(`| \`budgetMinPairs\` | ${DEFAULTS.budgetMinPairs} |`)));
});
