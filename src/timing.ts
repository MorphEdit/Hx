/** How long a turn's test commands ran (pure, no I/O): the matcher, the per-turn sum and the stats over it. */

/** Case-insensitive, matched anywhere in a shell command. */
export const DEFAULT_TEST_PATTERNS = [
  String.raw`\bnpm (run )?test\b`,
  String.raw`\bnode --test\b`,
  String.raw`\b(pnpm|yarn|bun) (run )?test\b`,
  String.raw`\bnpx (vitest|jest|mocha)\b`,
  String.raw`\b(vitest|jest|mocha)\b`,
  String.raw`\bpytest\b`,
  String.raw`\bpython -m (pytest|unittest)\b`,
  String.raw`\bgo test\b`,
  String.raw`\bcargo test\b`,
  String.raw`\bphpunit\b`,
  String.raw`\brspec\b`,
  String.raw`\bdotnet test\b`,
];

/** The tools whose `input.command` is a shell command. */
export const SHELL_TOOLS = ['Bash'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is a shell command a test run: a default pattern, a config.testPatterns entry, or the effective gate command as a literal. */
export function testMatcher(testPatterns: string[] = [], gateCommand = ''): (command: string) => boolean {
  const res = [...DEFAULT_TEST_PATTERNS, ...testPatterns].map((p) => new RegExp(p, 'i'));
  const lit = gateCommand.trim();
  if (lit) res.push(new RegExp(escape(lit), 'i'));
  return (command) => res.some((r) => r.test(command));
}

/** Is a tool_use block a test command. */
export function isTestToolUse(block: any, isTest: (command: string) => boolean, shellTools: string[] = SHELL_TOOLS): boolean {
  return !!block && block.type === 'tool_use' && shellTools.includes(block.name)
    && typeof block.input?.command === 'string' && isTest(block.input.command);
}

export interface TurnTiming { testMs: number; testRuns: number; testFailedRuns: number }

const ms = (ts: unknown): number | undefined => {
  if (typeof ts !== 'string' && typeof ts !== 'number') return undefined;
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(t) ? t : undefined;
};

const blocks = (ev: any): any[] => (Array.isArray(ev?.message?.content) ? ev.message.content : []);

const resultText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '';

const failed = (r: any): boolean => {
  if (r.is_error === true) return true;
  const m = /^Exit code (-?\d+)/.exec(resultText(r.content));
  return !!m && Number(m[1]) !== 0;
};

/**
 * The test time of one turn from its events (parsed objects or raw JSON lines): spans from the tool_use's
 * assistant event to its tool_result's user event, clipped to [turnStart, turnEnd] and merged where they overlap.
 */
export function turnTiming(events: unknown[], turnStart: number, turnEnd: number, isTest: (command: string) => boolean, shellTools: string[] = SHELL_TOOLS): TurnTiming {
  const evs: any[] = [];
  for (const e of events) {
    let ev: unknown = e;
    if (typeof e === 'string') { try { ev = JSON.parse(e); } catch { continue; } }
    if (ev && typeof ev === 'object' && !Array.isArray(ev)) evs.push(ev);
  }
  const starts = new Map<string, number>(); // tool_use id → start
  const runs: { id: unknown; start: number }[] = [];
  for (const ev of evs) {
    if (ev.type !== 'assistant') continue;
    const t = ms(ev.timestamp);
    if (t === undefined) continue;
    for (const b of blocks(ev)) if (isTestToolUse(b, isTest, shellTools)) { runs.push({ id: b.id, start: t }); if (typeof b.id === 'string') starts.set(b.id, t); }
  }
  const results = new Map<string, { end?: number; failed: boolean }>();
  for (const ev of evs) {
    if (ev.type !== 'user') continue;
    for (const b of blocks(ev)) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || !starts.has(b.tool_use_id) || results.has(b.tool_use_id)) continue;
      results.set(b.tool_use_id, { end: ms(ev.timestamp), failed: failed(b) });
    }
  }
  const spans: [number, number][] = [];
  let testFailedRuns = 0;
  for (const r of runs) {
    const res = typeof r.id === 'string' ? results.get(r.id) : undefined;
    if (res?.failed) testFailedRuns++;
    const s = Math.max(r.start, turnStart), e = Math.min(res?.end ?? turnEnd, turnEnd);
    if (e > s) spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0, cur: [number, number] | null = null;
  for (const sp of spans) {
    if (cur && sp[0] <= cur[1]) cur[1] = Math.max(cur[1], sp[1]);
    else { if (cur) total += cur[1] - cur[0]; cur = [sp[0], sp[1]]; }
  }
  if (cur) total += cur[1] - cur[0];
  return { testMs: Math.round(total), testRuns: runs.length, testFailedRuns };
}

/** Nearest-rank percentile (p in 0..1); undefined for an empty list. */
function nearestRank(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(1, Math.ceil(p * s.length)) - 1];
}

export const median = (values: number[]) => nearestRank(values, 0.5);
export const p90 = (values: number[]) => nearestRank(values, 0.9);

/** The test-time fields of a usage record and a gate-runs line (structural, so timing.ts stays import-free). */
export interface TestRec { ts: string; durationMs: number; testMs?: number; testRuns?: number }
export interface GateRec { ts: string; durationMs: number }

const hasTest = (r: TestRec) => typeof r.testMs === 'number' && Number.isFinite(r.testMs);

/** Test-run durations: testMs / testRuns of each record with testRuns > 0. */
export const testRunDurations = (recs: TestRec[]) => recs.filter((r) => hasTest(r) && (r.testRuns ?? 0) > 0).map((r) => r.testMs! / r.testRuns!);

/** Totals over the records that have testMs; undefined when none has it (unknown, never 0). */
export function testTotals(recs: TestRec[]): { testMs: number; durationMs: number; testRuns: number } | undefined {
  const w = recs.filter(hasTest);
  if (!w.length) return undefined;
  return { testMs: w.reduce((s, r) => s + r.testMs!, 0), durationMs: w.reduce((s, r) => s + (r.durationMs ?? 0), 0), testRuns: w.reduce((s, r) => s + (r.testRuns ?? 0), 0) };
}

/** Sum of testMs / sum of durationMs (0..1); undefined when unknown or no session time. */
export function testShare(recs: TestRec[]): number | undefined {
  const t = testTotals(recs);
  return t && t.durationMs > 0 ? t.testMs / t.durationMs : undefined;
}

export interface TimeSummary { share?: number; testRunMedian?: number; gateMedian?: number; gateP90?: number; hasData: boolean }

/** Test share, median test run and gate median/p90 over the records and gate lines with `from <= ts < to`. */
export function timeWindow(recs: TestRec[], gates: GateRec[], from: number, to: number): TimeSummary {
  const inW = (ts: string) => { const t = Date.parse(ts); return t >= from && t < to; };
  const rs = recs.filter((r) => hasTest(r) && inW(r.ts));
  const gs = gates.filter((g) => inW(g.ts)).map((g) => g.durationMs);
  return { share: testShare(rs), testRunMedian: median(testRunDurations(rs)), gateMedian: median(gs), gateP90: p90(gs), hasData: rs.length > 0 || gs.length > 0 };
}

export interface TestDay { day: string; testRunMedian?: number; testRunP90?: number; gateMedian?: number; gateP90?: number }

/** One entry per UTC day of `ts`, oldest first; days with neither test-run nor gate data are left out. */
export function testSeries(recs: TestRec[], gates: GateRec[]): TestDay[] {
  const day = (ts: string) => { const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
  const runs = new Map<string, number[]>(), gd = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => { if (k) m.set(k, [...(m.get(k) ?? []), v]); };
  for (const r of recs) for (const v of testRunDurations([r])) push(runs, day(r.ts), v);
  for (const g of gates) push(gd, day(g.ts), g.durationMs);
  return [...new Set([...runs.keys(), ...gd.keys()])].sort().map((d) => {
    const t = runs.get(d) ?? [], g = gd.get(d) ?? [];
    return { day: d, testRunMedian: median(t), testRunP90: p90(t), gateMedian: median(g), gateP90: p90(g) };
  });
}
