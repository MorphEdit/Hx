// A state dir whose five_hour window is calibrated at $1 per 1% and currently `used` full: six readings rising 1% a
// minute to `used` (five pairs, each with $1 of checkpoint cost in between), and past sessions of $7 per review,
// $3 per impl and $1 per audit (three each, before the readings).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Reading } from '../src/budget.ts';
import type { UsageRecord } from '../src/usage.ts';

export function writeBudget(stateDir: string, o: { used: number; resetsAt: number; now?: Date }): void {
  const now = o.now ?? new Date();
  const at = (min: number) => new Date(now.getTime() - (60 - min) * 60_000).toISOString();
  const readings: Reading[] = [0, 1, 2, 3, 4, 5].map((i) => ({ ts: at(10 + i), window: 'five_hour', utilization: Math.round((o.used - (5 - i) / 100) * 100) / 100, resetsAt: o.resetsAt }));
  let n = 0;
  const rec = (min: number, role: string, costUsd: number): UsageRecord => ({
    ts: at(min), issue: 1, role, sessionId: `s${n++}`, iteration: 1, model: 'm', ok: true,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd, durationMs: 0, numTurns: 1,
  });
  const usage = [
    ...[1, 2, 3].map((m) => rec(m, 'review', 7)), ...[1, 2, 3].map((m) => rec(m, 'impl', 3)), ...[1, 2, 3].map((m) => rec(m, 'audit', 1)),
    ...[1, 2, 3, 4, 5].map((i) => rec(10 + i - 0.5, 'checkpoint', 1)),
  ];
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'usage-readings.jsonl'), readings.map((r) => JSON.stringify(r) + '\n').join(''));
  writeFileSync(path.join(stateDir, 'usage.jsonl'), usage.map((r) => JSON.stringify(r) + '\n').join(''));
}
