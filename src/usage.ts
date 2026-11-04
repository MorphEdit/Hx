import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Usage } from './agent.ts';
import { modelMatches } from './config.ts';
import { testTotals } from './timing.ts';

/** One line per Claude turn: the raw material for `hx usage` and for later token optimisation. */
export interface UsageRecord {
  ts: string;
  issue: number;
  role: string; // impl (phase 1); decompose/review later
  sessionId: string;
  iteration: number;
  model: string; // the model asked for
  actualModel?: string; // the model that ran the turn, when the CLI reported it
  ok: boolean;
  usage: Usage;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  testMs?: number; // wall time the turn's test commands ran (overlaps merged); see src/timing.ts
  testRuns?: number;
  testFailedRuns?: number;
}

export function usageFile(stateDir: string): string {
  return path.join(stateDir, 'usage.jsonl');
}

export function recordUsage(stateDir: string, rec: UsageRecord): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(usageFile(stateDir), JSON.stringify(rec) + '\n');
}

export function readUsage(stateDir: string): UsageRecord[] {
  const f = usageFile(stateDir);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/** Sessions with a non-checkpoint turn whose reported model is not the one asked for (records without `actualModel` never count). */
export function mismatchedSessions(recs: UsageRecord[]): number {
  return new Set(recs.filter((r) => r.role !== 'checkpoint' && r.actualModel && !modelMatches(r.model, r.actualModel)).map((r) => r.sessionId)).size;
}

/** The local date (machine time zone) of an ISO timestamp, `YYYY-MM-DD`: how usage is grouped by day. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const totalTokens = (u: Usage) => u.input + u.cacheWrite + u.cacheRead + u.output;

export function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export interface UsageRow {
  key: string;
  turns: number;
  sessions: number;
  usage: Usage;
  costUsd: number;
  test?: { testMs: number; durationMs: number; testRuns: number }; // over the records with testMs; absent when none has it
}

export function summarize(recs: UsageRecord[], keyOf: (r: UsageRecord) => string): UsageRow[] {
  const rows = new Map<string, UsageRow & { ids: Set<string>; recs: UsageRecord[] }>();
  for (const r of recs) {
    const k = keyOf(r);
    let row = rows.get(k);
    if (!row) rows.set(k, row = { key: k, turns: 0, sessions: 0, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, ids: new Set(), recs: [] });
    row.recs.push(r);
    row.turns++;
    row.ids.add(r.sessionId);
    for (const f of Object.keys(row.usage) as (keyof Usage)[]) row.usage[f] += r.usage[f] ?? 0;
    row.costUsd += r.costUsd ?? 0;
  }
  return [...rows.values()].map(({ ids, recs: rs, ...r }) => {
    const test = testTotals(rs);
    return { ...r, sessions: ids.size, ...(test ? { test } : {}) };
  });
}
