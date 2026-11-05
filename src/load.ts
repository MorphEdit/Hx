// Machine load for auto-scaled workers (PRD #315): CPU busy % from os.cpus() snapshots, the 60 s reading, the
// target decision with its hysteresis, and the claim rule. Pure but for sampleLoad: no timers, the caller's clock.
import os from 'node:os';

/** One sample: when it was taken (ms), every core's times summed, and the free memory (bytes). */
export interface LoadSnapshot { at: number; total: number; idle: number; freeMem: number }

/** The fields of an os.cpus() entry the snapshot sums. */
export type CpuTimes = { times: { user: number; nice: number; sys: number; idle: number; irq: number } };

export interface LoadReading { cpuPct: number; freeMemGB: number }

const GB = 1024 ** 3;
const WINDOW_MS = 60_000; // the reading averages the intervals that ended in the last minute
const DOWN_EVERY_MS = 60_000; // a further step down waits this long after the last change

/** A snapshot from os.cpus()-shaped cores: total = user + nice + sys + idle + irq over every core. */
export function snapshotOf(at: number, cpus: CpuTimes[], freeMem: number): LoadSnapshot {
  let total = 0, idle = 0;
  for (const { times: t } of cpus) { total += t.user + t.nice + t.sys + t.idle + t.irq; idle += t.idle; }
  return { at, total, idle, freeMem };
}

/** This machine now. os.loadavg() is never used: it is always 0 on Windows. */
export function sampleLoad(at = Date.now()): LoadSnapshot {
  return snapshotOf(at, os.cpus(), os.freemem());
}

/** CPU busy % of the interval a → b over all cores: 100 × (Δtotal − Δidle) / Δtotal; 0 when no time passed (Δtotal ≤ 0). */
export function cpuBusyPct(a: LoadSnapshot, b: LoadSnapshot): number {
  const dTotal = b.total - a.total;
  if (dTotal <= 0) return 0;
  return (100 * (dTotal - (b.idle - a.idle))) / dTotal;
}

/** The mean CPU busy % of the intervals whose later snapshot is in the last 60 s of `now`, and the latest snapshot's
 *  free memory in GB; null before two snapshots exist or when no interval ended in the window. */
export function loadReading(snapshots: LoadSnapshot[], now: number): LoadReading | null {
  const pcts: number[] = [];
  for (let i = 1; i < snapshots.length; i++) if (snapshots[i].at >= now - WINDOW_MS) pcts.push(cpuBusyPct(snapshots[i - 1], snapshots[i]));
  if (!pcts.length) return null;
  return { cpuPct: pcts.reduce((s, p) => s + p, 0) / pcts.length, freeMemGB: snapshots[snapshots.length - 1].freeMem / GB };
}

export interface LoadSettings { ceiling: number; minWorkers: number; loadHighPct: number; loadLowPct: number; minFreeMemGB: number; scaleUpMinutes: number }

/** target: the session count claims follow. lastChange: the last step (or the start). changed: a step happened
 *  (the start does not count for the down rate). notLowAt: the last reading that was not low load (restarts the up wait). */
export interface TargetState { target: number; lastChange: number; changed: boolean; notLowAt: number | null }

/** The state at the runner's start: the target at the ceiling. */
export function initialTarget(ceiling: number, start: number): TargetState {
  return { target: ceiling, lastChange: start, changed: false, notLowAt: null };
}

/** One runner pass's decision: down by one on high load (at most once per 60 s after a change, never below the floor),
 *  up by one after scaleUpMinutes of low load (never above the ceiling). `line` only when the target changed. */
export function decideTarget(s: TargetState, r: LoadReading | null, now: number, o: LoadSettings): { state: TargetState; line?: string } {
  if (!r) return { state: s };
  const floor = Math.min(o.minWorkers, o.ceiling);
  const low = r.cpuPct <= o.loadLowPct && r.freeMemGB >= o.minFreeMemGB;
  const high = r.cpuPct >= o.loadHighPct || r.freeMemGB < o.minFreeMemGB;
  if (high && s.target > floor && (!s.changed || now - s.lastChange >= DOWN_EVERY_MS)) {
    const line = `workers: ${s.target} → ${s.target - 1} (cpu ${Math.round(r.cpuPct)}%, free ${r.freeMemGB.toFixed(1)} GB)`;
    return { state: { target: s.target - 1, lastChange: now, changed: true, notLowAt: now }, line };
  }
  if (!low) return { state: { ...s, notLowAt: now } };
  const from = Math.max(s.lastChange, s.notLowAt ?? -Infinity);
  if (s.target < o.ceiling && now - from >= o.scaleUpMinutes * 60_000) {
    const line = `workers: ${s.target} → ${s.target + 1} (cpu ${Math.round(r.cpuPct)}% for ${Math.floor((now - from) / 60_000)} min)`;
    return { state: { ...s, target: s.target + 1, lastChange: now, changed: true }, line };
  }
  return { state: s };
}

/** May one more session be claimed? Below the target counting the gate as one, or below the floor counting sessions only. */
export function mayClaim(o: { sessions: number; gateRunning: boolean; target: number; minWorkers: number; ceiling: number }): boolean {
  return o.sessions + (o.gateRunning ? 1 : 0) < o.target || o.sessions < Math.min(o.minWorkers, o.ceiling);
}

/** The snapshots a reading at `now` still needs: those in the last 60 s, and the one before them (the start of the first
 *  interval in the window). Older ones are dropped in place. */
export function keepWindow(snapshots: LoadSnapshot[], now: number): void {
  while (snapshots.length > 1 && snapshots[1].at < now - WINDOW_MS) snapshots.shift();
}

/** Samples this machine into `snapshots` now and every `everyMs` after, on an unref'd timer (it never keeps the process
 *  alive). Only stores: no threshold, no target. The caller stops it with clearInterval. */
export function startSampler(snapshots: LoadSnapshot[], clock: () => number = Date.now, everyMs = 5000, sample = sampleLoad): ReturnType<typeof setInterval> {
  const take = () => { const now = clock(); snapshots.push(sample(now)); keepWindow(snapshots, now); };
  take();
  const t = setInterval(take, everyMs);
  t.unref();
  return t;
}
