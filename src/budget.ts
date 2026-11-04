// The budget gate (PRD #130): usage-window readings, recorded to `<stateDir>/usage-readings.jsonl`, the calibration (dollars per 1% of a window),
// the per-role forecast and the gate decision.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RateLimit } from './agent.ts';
import type { Action } from './state.ts';
import { readUsage, type UsageRecord } from './usage.ts';

/** One reading of a usage window, as the agent CLI reported it. */
export interface Reading {
  ts: string; // ISO time of receipt
  window: string; // five_hour, seven_day, ...
  utilization: number; // 0..1
  resetsAt: number; // unix seconds
}

export function readingsFile(stateDir: string): string {
  return path.join(stateDir, 'usage-readings.jsonl');
}

const isReading = (x: any): x is Reading => !!x && typeof x === 'object' && typeof x.ts === 'string' && typeof x.window === 'string'
  && typeof x.utilization === 'number' && typeof x.resetsAt === 'number';

/** Every well-formed reading in the file, in order; a missing file is []; bad lines are skipped. */
export function readReadings(stateDir: string): Reading[] {
  const f = readingsFile(stateDir);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { const x = JSON.parse(l); return isReading(x) ? [x] : []; } catch { return []; }
  });
}

/** A reading from a parsed rate-limit event, or null when it lacks a numeric utilization, a window type or a numeric resetsAt. */
export function readingOf(rl: RateLimit, now: Date): Reading | null {
  if (typeof rl.utilization !== 'number' || typeof rl.type !== 'string' || !rl.type || typeof rl.resetsAt !== 'number') return null;
  return { ts: now.toISOString(), window: rl.type, utilization: rl.utilization, resetsAt: rl.resetsAt };
}

/**
 * Append `r` unless the file's last reading of the same window has the same utilization and resetsAt.
 * Compared against the file every time, so it holds across restarts and concurrent sessions. Returns whether it appended.
 */
export function recordReading(stateDir: string, r: Reading): boolean {
  const last = readReadings(stateDir).findLast((x) => x.window === r.window);
  if (last && last.utilization === r.utilization && last.resetsAt === r.resetsAt) return false;
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(readingsFile(stateDir), JSON.stringify(r) + '\n');
  return true;
}

/** Nearest-rank percentile: the value at 1-based rank max(1, ceil(p/100 × n)) of the sorted values; undefined for none. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length))) - 1];
}

const byTs = (a: { ts: string }, b: { ts: string }) => Date.parse(a.ts) - Date.parse(b.ts);

/**
 * The window's latest reading by `ts`, or undefined when it has none. When its `resetsAt` is ≤ now the window has
 * reset: the reading comes back with utilization 0 and `expired: true` (the gate never blocks on an expired reading).
 */
export function currentReading(readings: Reading[], window: string, now: Date): (Reading & { expired?: boolean }) | undefined {
  const last = readings.filter((r) => r.window === window).sort(byTs).at(-1);
  if (!last) return undefined;
  return last.resetsAt * 1000 <= now.getTime() ? { ...last, utilization: 0, expired: true } : last;
}

/** One window's calibration: `usdPerPct` (p20 of the fits) only once `pairs >= minPairs`; absent means uncalibrated. */
export interface Calibration {
  window: string;
  fits: number[]; // dollars per 1% of the window, one per usable pair of readings
  pairs: number;
  usdPerPct?: number;
}

/**
 * Per window: consecutive readings (sorted by ts) with the same resetsAt and a rise in utilization make a pair; its cost is
 * the sum of costUsd of every usage record (all roles, checkpoint included) with first.ts < ts <= second.ts, and its fit is
 * cost / (rise × 100). Falls, equal readings, pairs across a reset and zero-cost pairs are skipped.
 */
export function calibrate(readings: Reading[], usage: UsageRecord[], minPairs: number): Calibration[] {
  const recs = usage.map((r) => ({ t: Date.parse(r.ts), cost: r.costUsd ?? 0 }));
  const windows = [...new Set(readings.map((r) => r.window))];
  return windows.map((window) => {
    const rs = readings.filter((r) => r.window === window).sort(byTs);
    const fits: number[] = [];
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1], b = rs[i];
      const rise = b.utilization - a.utilization;
      if (a.resetsAt !== b.resetsAt || rise <= 0) continue;
      const ta = Date.parse(a.ts), tb = Date.parse(b.ts);
      const cost = recs.reduce((s, r) => (r.t > ta && r.t <= tb ? s + r.cost : s), 0);
      if (cost > 0) fits.push(cost / (rise * 100));
    }
    const c: Calibration = { window, fits, pairs: fits.length };
    if (fits.length && fits.length >= minPairs) c.usdPerPct = percentile(fits, 20);
    return c;
  });
}

export interface Session { sessionId: string; role: string; costUsd: number }

/** Usage records grouped by sessionId, checkpoint records excluded: each session's role and total cost. */
export function sessions(usage: UsageRecord[]): Session[] {
  const m = new Map<string, Session>();
  for (const r of usage) {
    if (r.role === 'checkpoint') continue;
    const s = m.get(r.sessionId);
    if (s) s.costUsd += r.costUsd ?? 0;
    else m.set(r.sessionId, { sessionId: r.sessionId, role: r.role, costUsd: r.costUsd ?? 0 });
  }
  return [...m.values()];
}

/** p80 of the role's past session costs when it has ≥ 3; else p80 over every role's sessions when there are ≥ 3; else undefined. */
export function roleForecast(usage: UsageRecord[], role: string): number | undefined {
  const all = sessions(usage);
  const mine = all.filter((s) => s.role === role);
  if (mine.length >= 3) return percentile(mine.map((s) => s.costUsd), 80);
  if (all.length >= 3) return percentile(all.map((s) => s.costUsd), 80);
  return undefined;
}

/** The roles of the sessions an action starts in one round; [] for the engine-only steps. */
function actionRoles(a: Action, c: { audit: boolean }): string[] {
  if (a.kind === 'impl') return c.audit ? ['impl', 'audit'] : ['impl'];
  if (a.kind === 'gauntlet') return ['critic', 'revise'];
  if (a.kind === 'bar') return ['bar', 'bar']; // the run and the judge
  if (a.kind === 'close-prd' || a.kind === 'label-ready') return [];
  return [a.kind];
}

/** USD an action is forecast to cost: the sum of its sessions' role forecasts; undefined when any role has none, or for engine steps. */
export function actionForecast(a: Action, usage: UsageRecord[], c: { audit: boolean }): number | undefined {
  const roles = actionRoles(a, c);
  if (!roles.length) return undefined;
  let sum = 0;
  for (const role of roles) {
    const f = roleForecast(usage, role);
    if (f === undefined) return undefined;
    sum += f;
  }
  return sum;
}

/** A forecast in percent of a window: usd / usdPerPct. */
export const forecastPct = (usd: number, usdPerPct: number) => usd / usdPerPct;

export interface Block { window: string; needPct: number; usedPct: number; capPct: number; resetsAt: number }

/**
 * The first window (in calibration order) that blocks the action, or null. A window blocks when it is calibrated, has a
 * current unexpired reading and utilization×100 + forecast% > usagePauseAt×100. No forecast never blocks.
 */
export function gateDecision(forecastUsd: number | undefined, calibration: Calibration[], readings: Reading[], usagePauseAt: number, now: Date): Block | null {
  if (forecastUsd === undefined) return null;
  for (const c of calibration) {
    if (c.usdPerPct === undefined) continue;
    const r = currentReading(readings, c.window, now);
    if (!r || r.expired) continue;
    const needPct = forecastPct(forecastUsd, c.usdPerPct), usedPct = r.utilization * 100, capPct = usagePauseAt * 100;
    if (usedPct + needPct > capPct) return { window: c.window, needPct, usedPct, capPct, resetsAt: r.resetsAt };
  }
  return null;
}

/** What the gate decides an action by, read once per loop pass: the readings, the usage records and their calibration. */
export interface Budget { readings: Reading[]; usage: UsageRecord[]; calibration: Calibration[]; usagePauseAt: number; audit: boolean; now: Date }

/** The budget as of `now`, from `<stateDir>/usage-readings.jsonl` and `usage.jsonl`. */
export function readBudget(stateDir: string, c: { budgetMinPairs: number; usagePauseAt: number; audit: boolean }, now: Date): Budget {
  const readings = readReadings(stateDir), usage = readUsage(stateDir);
  return { readings, usage, calibration: calibrate(readings, usage, c.budgetMinPairs), usagePauseAt: c.usagePauseAt, audit: c.audit, now };
}

/**
 * An action's forecast in percent of the tightest calibrated window with a current reading (the one the forecast brings
 * closest to its cap; undefined when there is no forecast or no such window), and the window that blocks it, if any.
 */
export function actionBudget(a: Action, b: Budget): { pct?: number; block: Block | null } {
  const usd = actionForecast(a, b.usage, { audit: b.audit });
  if (usd === undefined) return { block: null };
  let pct: number | undefined, top = -Infinity;
  for (const c of b.calibration) {
    if (c.usdPerPct === undefined) continue;
    const r = currentReading(b.readings, c.window, b.now);
    if (!r) continue;
    const need = forecastPct(usd, c.usdPerPct);
    if (r.utilization * 100 + need > top) { top = r.utilization * 100 + need; pct = need; }
  }
  return { pct, block: gateDecision(usd, b.calibration, b.readings, b.usagePauseAt, b.now) };
}

/** The actions the gate lets through, in order (engine steps always), and the session actions it skips with their block. */
export function budgetFilter(actions: Action[], b: Budget): { claim: Action[]; skipped: { action: Action; block: Block }[] } {
  const claim: Action[] = [], skipped: { action: Action; block: Block }[] = [];
  for (const a of actions) {
    const block = a.kind === 'close-prd' || a.kind === 'label-ready' ? null : actionBudget(a, b).block;
    if (block) skipped.push({ action: a, block });
    else claim.push(a);
  }
  return { claim, skipped };
}

const actionTarget = (a: Action) => ('issue' in a ? a.issue : a.prd);

/** The skip is logged once per action per window reset: the key is the action, the window and that window's resetsAt. */
export const budgetSkipKey = (a: Action, b: Block) => `${a.kind}#${actionTarget(a)}|${b.window}|${b.resetsAt}`;

export function budgetSkipLine(a: Action, b: Block): string {
  return `budget: not starting #${actionTarget(a)} ${a.kind} — needs ~${Math.round(b.needPct)}% of ${b.window}, ${Math.round(b.usedPct)}% used, cap ${Math.round(b.capPct)}%`;
}

/** The skip lines not logged yet; their keys are added to `logged`. */
export function newSkipLines(skipped: { action: Action; block: Block }[], logged: Set<string>): string[] {
  return skipped.flatMap(({ action, block }) => {
    const k = budgetSkipKey(action, block);
    if (logged.has(k)) return [];
    logged.add(k);
    return [budgetSkipLine(action, block)];
  });
}

/** One usage window as `hx status`, live.json and the dashboard show it. */
export interface BudgetWindow { window: string; utilization: number; resetsAt: number; usdPerPct?: number; pairs: number }

/**
 * One entry per window with a reading (in calibration order): its current utilization (0 once resetsAt has passed),
 * resetsAt, the usable pairs and usdPerPct once calibrated.
 */
export function budgetWindows(readings: Reading[], usage: UsageRecord[], minPairs: number, now: Date): BudgetWindow[] {
  return calibrate(readings, usage, minPairs).flatMap((c) => {
    const r = currentReading(readings, c.window, now);
    if (!r) return [];
    const w: BudgetWindow = { window: c.window, utilization: r.utilization, resetsAt: r.resetsAt, pairs: c.pairs };
    if (c.usdPerPct !== undefined) w.usdPerPct = c.usdPerPct;
    return [w];
  });
}

/** The windows from `<stateDir>/usage-readings.jsonl` and `usage.jsonl`. */
export const readBudgetWindows = (stateDir: string, minPairs: number, now: Date) => budgetWindows(readReadings(stateDir), readUsage(stateDir), minPairs, now);

/** `budget five_hour: 85% used, $0.42 per 1% (n=12 pairs)` or `budget five_hour: 85% used, uncalibrated (n=2 pairs, needs 5)`. */
export function budgetLine(w: BudgetWindow, minPairs: number): string {
  const rate = w.usdPerPct !== undefined ? `$${w.usdPerPct.toFixed(2)} per 1% (n=${w.pairs} pairs)` : `uncalibrated (n=${w.pairs} pairs, needs ${minPairs})`;
  return `budget ${w.window}: ${Math.round(w.utilization * 100)}% used, ${rate}`;
}
