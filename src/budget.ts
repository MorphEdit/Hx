// The budget gate (PRD #130). For now: usage-window readings, recorded to `<stateDir>/usage-readings.jsonl`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RateLimit } from './agent.ts';

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
