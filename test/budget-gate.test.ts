// The budget gate (PRD #130 D): which actions a loop pass claims and which it skips, and the skip line logged once per window reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionBudget, budgetFilter, budgetSkipKey, budgetSkipLine, newSkipLines, readBudget, type Budget } from '../src/budget.ts';
import { DEFAULTS } from '../src/config.ts';
import { nextListing } from '../src/pool.ts';
import { claimable, type Action } from '../src/state.ts';
import { writeBudget } from './budget-fixture.ts';

const now = new Date();
const future = Math.floor(now.getTime() / 1000) + 3600;
const budget = (used: number, o: { resetsAt?: number; audit?: boolean; minPairs?: number } = {}): Budget => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-budget-'));
  writeBudget(dir, { used, resetsAt: o.resetsAt ?? future, now });
  return readBudget(dir, { budgetMinPairs: o.minPairs ?? DEFAULTS.budgetMinPairs, usagePauseAt: 0.9, audit: o.audit ?? false }, now);
};

const review: Action = { kind: 'review', prd: 5, title: 'p', children: [] };
const impl: Action = { kind: 'impl', issue: 12, title: 'i' };
const close: Action = { kind: 'close-prd', prd: 6 };
const label: Action = { kind: 'label-ready', issue: 13, prd: 6 };
const kinds = (as: Action[]) => as.map((a) => `${a.kind}#${'issue' in a ? a.issue : a.prd}`);
const REVIEW_SKIP = 'budget: not starting #5 review — needs ~7% of five_hour, 85% used, cap 90%';

test('budgetGate defaults to true', () => {
  assert.equal(DEFAULTS.budgetGate, true);
});

test('fixture: five_hour calibrated at $1 per 1%, current reading 85%', () => {
  const b = budget(0.85);
  assert.equal(b.calibration.length, 1);
  assert.equal(b.calibration[0].pairs, 5);
  assert.equal(Math.round(b.calibration[0].usdPerPct! * 1e6) / 1e6, 1);
  assert.equal(Math.round(actionBudget(review, b).pct!), 7);
  assert.equal(Math.round(actionBudget(impl, b).pct!), 3);
});

test('gate: at 85% with cap 90%, a 7% review is skipped and a 3% impl after it is claimed; engine steps never gated', () => {
  const b = budget(0.85);
  const { claim, skipped } = budgetFilter([review, close, impl, label], b);
  assert.deepEqual(kinds(claim), ['close-prd#6', 'impl#12', 'label-ready#13']);
  assert.deepEqual(kinds(skipped.map((s) => s.action)), ['review#5']);
  const bl = skipped[0].block;
  assert.deepEqual({ ...bl, needPct: Math.round(bl.needPct), usedPct: Math.round(bl.usedPct) },
    { window: 'five_hour', needPct: 7, usedPct: 85, capPct: 90, resetsAt: future });
  assert.equal(budgetSkipLine(review, bl), REVIEW_SKIP);
});

test('gate: every session kind is gated; an impl counts its audit when audit is on', () => {
  const all: Action[] = [impl, { kind: 'triage', issue: 2, title: '' }, { kind: 'gauntlet', prd: 3, title: '' },
    { kind: 'decompose', prd: 4, title: '', children: [] }, review, { kind: 'security', prd: 7, title: '', children: [] }];
  const b = budget(0.88); // impl 3% → 91% > 90%; the other roles fall back to the all-roles p80 ($7)
  assert.deepEqual(budgetFilter(all, b).claim, []);
  assert.equal(budgetFilter(all, b).skipped.length, all.length);
  const withAudit = budget(0.87, { audit: true }); // 87% + 4% > 90%
  assert.equal(Math.round(actionBudget(impl, withAudit).pct!), 4); // impl $3 + audit $1
  assert.deepEqual(kinds(budgetFilter([impl], withAudit).skipped.map((s) => s.action)), ['impl#12']);
  assert.deepEqual(kinds(budgetFilter([impl], budget(0.86)).claim), ['impl#12']); // audit off: 86% + 3%
});

test('gate: the skip line is logged once across loop passes and again once the window resets', () => {
  const logged = new Set<string>();
  const pass = (b: Budget) => newSkipLines(budgetFilter([review, impl], b).skipped, logged);
  assert.deepEqual(pass(budget(0.85)), [REVIEW_SKIP]);
  assert.deepEqual(pass(budget(0.85)), []);
  assert.deepEqual(pass(budget(0.85)), []);
  const reset = future + 18_000;
  assert.deepEqual(pass(budget(0.85, { resetsAt: reset })), [REVIEW_SKIP]);
  assert.deepEqual(pass(budget(0.85, { resetsAt: reset })), []);
  const bl = { window: 'five_hour', needPct: 7, usedPct: 85, capPct: 90, resetsAt: reset };
  assert.equal(budgetSkipKey(review, bl), `review#5|five_hour|${reset}`);
  assert.ok(logged.has(budgetSkipKey(review, bl)));
});

test('gate: a reading whose resetsAt has passed counts as 0%: the action is claimed', () => {
  const b = budget(0.85, { resetsAt: Math.floor(now.getTime() / 1000) - 1 });
  const { claim, skipped } = budgetFilter([review, impl], b);
  assert.deepEqual(kinds(claim), ['review#5', 'impl#12']);
  assert.deepEqual(skipped, []);
});

test('gate: an uncalibrated window or no forecast claims everything, as before', () => {
  const unc = budget(0.89, { minPairs: 6 });
  assert.equal(unc.calibration[0].usdPerPct, undefined);
  assert.deepEqual(kinds(budgetFilter([review, impl], unc).claim), ['review#5', 'impl#12']);
  assert.equal(actionBudget(review, unc).pct, undefined);
  const none: Budget = { ...budget(0.89), usage: [] };
  assert.deepEqual(kinds(budgetFilter([review, impl], none).claim), ['review#5', 'impl#12']);
  assert.equal(actionBudget(impl, none).pct, undefined);
});

test('gate: a CI gate fix (hx-gate-fix) impl is gated like any impl', () => {
  const fix: Action = { kind: 'impl', issue: 40, title: 'fix main' };
  const actions = claimable([impl, fix, review], { gateRed: true, fixIssue: 40 });
  assert.deepEqual(kinds(actions), ['impl#40']);
  assert.deepEqual(kinds(budgetFilter(actions, budget(0.88)).skipped.map((s) => s.action)), ['impl#40']);
  assert.deepEqual(kinds(budgetFilter(actions, budget(0.85)).claim), ['impl#40']);
});

test('nextListing: ~N% for an action with a forecast, (budget: skip) for a gated one, nothing without a forecast', () => {
  const b = budget(0.85);
  assert.equal(nextListing([review, impl, close], b, true), 'review #5 ~7% (budget: skip), impl #12 ~3%, close-prd #6');
  assert.equal(nextListing([review], b, false), 'review #5 ~7%'); // budgetGate off: no mark
  assert.equal(nextListing([review, impl], budget(0.85, { minPairs: 6 }), true), 'review #5, impl #12');
});

test('readBudget reads both files once; newSkipLines logs a skip once', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-budget-'));
  writeBudget(dir, { used: 0.85, resetsAt: future, now });
  const b = readBudget(dir, { budgetMinPairs: 5, usagePauseAt: 0.9, audit: true }, now);
  assert.deepEqual([b.readings.length, b.usage.length, b.audit, b.usagePauseAt, b.now], [6, 14, true, 0.9, now]);
  const empty = readBudget(path.join(dir, 'nope'), { budgetMinPairs: 5, usagePauseAt: 0.9, audit: false }, now);
  assert.deepEqual([empty.readings, empty.usage, empty.calibration], [[], [], []]);
  const logged = new Set<string>();
  const skipped = budgetFilter([review], b).skipped;
  assert.equal(newSkipLines(skipped, logged).length, 1);
  assert.deepEqual(newSkipLines(skipped, logged), []);
});
