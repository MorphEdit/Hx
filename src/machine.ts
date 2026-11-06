// The Machine panel's analysis (#363, PRD #325): from the records passed in — .hx/load.jsonl lines, .hx/gate-runs.jsonl
// lines, run.log lines and usage records — the use of the machine, the issues closed per hour by worker count, how much
// slower the gate runs than at idle, the test share of session time per role, and the one-line recommendation. Pure: no I/O.
import type { GateRun } from './gate.ts';
import type { LoadLine } from './loadlog.ts';
import { median } from './timing.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const MAX_DAYS = 7;
export const MIN_GROUP_HOURS = 3;   // a throughput group with fewer hours shows "not enough data"
export const RULE_A_HOURS = 6;      // rule A: both worker counts have at least this many hours

/** Nearest-rank percentile (p in 0..1), as timing.ts computes it; undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(1, Math.ceil(p * s.length)) - 1];
}

/** The period: the last `days` × 24 h before `now` (days 1..7, default 1). */
export function period(now: number, days = 1): { from: number; to: number; days: number } {
  const d = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : 1)));
  return { from: now - d * DAY, to: now, days: d };
}

const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:\[#\d+\] )?(.*)$/;

/** The times of the run.log lines that close an issue, as outcomes.ts counts them: `DONE ✓ audited and merged…` / `impl DONE ✓`. */
export function doneTimes(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m || !(m[2].startsWith('DONE ✓ audited and merged') || m[2].startsWith('impl DONE ✓'))) continue;
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

const within = (t: number, from: number, to: number) => t >= from && t < to;

export interface Use {
  series: { ts: string; cpuPct: number; freeMemGB: number; target: number; running: number }[];
  avgCpu?: number; p90Cpu?: number;
}

/** The load lines of [from, to), oldest first, and the average and p90 of their CPU. */
export function machineUse(load: LoadLine[], from: number, to: number): Use {
  const ls = load.filter((l) => within(Date.parse(l.ts), from, to)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const cpu = ls.map((l) => l.cpuPct);
  return {
    series: ls.map(({ ts, cpuPct, freeMemGB, target, running }) => ({ ts, cpuPct, freeMemGB, target, running })),
    avgCpu: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : undefined,
    p90Cpu: percentile(cpu, 0.9),
  };
}

/** One worker count: the clock hours whose median target it was, the issues closed in them, issues per hour. */
export interface Group { workers: number; hours: number; done: number; perHour: number; enough: boolean }

/** The clock hours of [from, to) with load lines, grouped by the median target of each hour's lines, lowest first. */
export function throughput(load: LoadLine[], done: number[], from: number, to: number): Group[] {
  const hours = new Map<number, number[]>();
  for (const l of load) {
    const t = Date.parse(l.ts);
    if (!within(t, from, to)) continue;
    const h = Math.floor(t / HOUR) * HOUR;
    hours.set(h, [...(hours.get(h) ?? []), l.target]);
  }
  const closed = new Map<number, number>();
  for (const t of done) if (within(t, from, to)) { const h = Math.floor(t / HOUR) * HOUR; closed.set(h, (closed.get(h) ?? 0) + 1); }
  const groups = new Map<number, { hours: number; done: number }>();
  for (const [h, targets] of hours) {
    const w = median(targets)!;
    const g = groups.get(w) ?? { hours: 0, done: 0 };
    g.hours++; g.done += closed.get(h) ?? 0;
    groups.set(w, g);
  }
  return [...groups].sort((a, b) => a[0] - b[0])
    .map(([w, g]) => ({ workers: w, hours: g.hours, done: g.done, perHour: g.done / g.hours, enough: g.hours >= MIN_GROUP_HOURS }));
}

export interface Slowdown { baselineMs?: number; medianMs?: number; factor?: number; text?: string }

/** The idle baseline (p10 of green gate runs over the 7 days before `now`), the median gate run of [from, to) and their
 *  ratio; factor and text are undefined with no green run, no run in the period or a zero baseline. */
export function slowdown(gates: GateRun[], from: number, to: number, now: number): Slowdown {
  const baselineMs = percentile(gates.filter((g) => g.ok && within(Date.parse(g.ts), now - MAX_DAYS * DAY, now)).map((g) => g.durationMs), 0.1);
  const medianMs = median(gates.filter((g) => within(Date.parse(g.ts), from, to)).map((g) => g.durationMs));
  if (baselineMs === undefined || medianMs === undefined || !(baselineMs > 0)) return { baselineMs, medianMs };
  const factor = medianMs / baselineMs;
  return { baselineMs, medianMs, factor, text: `tests run ${factor.toFixed(1)}× slower than at idle` };
}

export interface SessionRec { ts: string; role: string; durationMs: number; testMs?: number }
export interface RoleSplit { role: string; sessions: number; testShare: number; otherShare: number }

/** Per role (by name), the median over its records of [from, to) of testMs / durationMs, and the rest. */
export function sessionSplit(recs: SessionRec[], from: number, to: number): RoleSplit[] {
  const by = new Map<string, number[]>();
  for (const r of recs) {
    if (!within(Date.parse(r.ts), from, to) || typeof r.testMs !== 'number' || !Number.isFinite(r.testMs) || !(r.durationMs > 0)) continue;
    by.set(r.role, [...(by.get(r.role) ?? []), Math.min(1, r.testMs / r.durationMs)]);
  }
  return [...by].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([role, shares]) => { const s = median(shares)!; return { role, sessions: shares.length, testShare: s, otherShare: 1 - s }; });
}

export interface Recommendation { rule: 'A' | 'B' | 'fits'; text: string }

/**
 * Rule A: two worker counts N−1 and N each have ≥ 6 h, and N closes less than 10% more per hour (the lowest such N).
 * Rule B: the target was at `workers` for ≥ 80% of the load lines, the average CPU is < 50% and the slowdown < 1.5×.
 * Otherwise the setting fits.
 */
export function recommend(groups: Group[], use: Use, slow: Slowdown, workers: number): Recommendation {
  const by = new Map(groups.map((g) => [g.workers, g]));
  for (const hi of groups) {
    const lo = by.get(hi.workers - 1);
    if (!lo || lo.hours < RULE_A_HOURS || hi.hours < RULE_A_HOURS) continue;
    // hi.done/hi.hours < 1.1 × lo.done/lo.hours, in integers so exactly 10% more does not fire
    if (hi.done * lo.hours * 10 < lo.done * hi.hours * 11) {
      const n = hi.workers;
      return { rule: 'A', text: `${n} workers get about as much done as ${n - 1} here; set \`workers\` to ${n - 1}` };
    }
  }
  const lines = use.series.length, atCap = use.series.filter((l) => l.target >= workers).length;
  if (lines > 0 && atCap * 5 >= lines * 4 && use.avgCpu !== undefined && use.avgCpu < 50 && slow.factor !== undefined && slow.factor < 1.5)
    return { rule: 'B', text: `this machine has room; you could raise \`workers\` to ${workers + 1}` };
  return { rule: 'fits', text: 'the current setting fits this machine' };
}

export interface MachineInput {
  load: LoadLine[]; gates: GateRun[]; log: string[]; usage: SessionRec[];
  workers: number; now: number; days?: number;
}

export interface Machine {
  from: string; to: string; days: number;
  use: Use; throughput: Group[]; slowdown: Slowdown; sessions: RoleSplit[]; recommendation: Recommendation;
}

/** Everything the Machine panel shows over the period. */
export function analyseMachine(i: MachineInput): Machine {
  const p = period(i.now, i.days);
  const use = machineUse(i.load, p.from, p.to);
  const groups = throughput(i.load, doneTimes(i.log), p.from, p.to);
  const slow = slowdown(i.gates, p.from, p.to, i.now);
  return {
    from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString(), days: p.days,
    use, throughput: groups, slowdown: slow, sessions: sessionSplit(i.usage, p.from, p.to),
    recommendation: recommend(groups, use, slow, i.workers),
  };
}
