// The load history of `hx run` (#362, PRD #325): one line per minute in .hx/load.jsonl — the CPU reading of the
// #315 sampler, the worker target, the live sessions and whether a gate run is in progress. Lines older than 7 days
// are dropped at the runner's start.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One minute of `hx run`: `ts` ISO, `target` the worker target, `running` the live sessions, `gate` a gate run in progress. */
export interface LoadLine { ts: string; cpuPct: number; freeMemGB: number; target: number; running: number; gate: boolean }

export const KEEP_MS = 7 * 24 * 60 * 60_000;
export const loadFile = (stateDir: string) => path.join(stateDir, 'load.jsonl');

/** Appends one line; a write failure drops it (the history never stops the run). */
export function appendLoadLine(stateDir: string, line: LoadLine): void {
  try { appendFileSync(loadFile(stateDir), JSON.stringify(line) + '\n'); } catch {}
}

const isLine = (r: any): r is LoadLine => !!r && typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts))
  && Number.isFinite(r.cpuPct) && Number.isFinite(r.freeMemGB) && Number.isInteger(r.target) && Number.isInteger(r.running)
  && typeof r.gate === 'boolean';

/** The lines oldest first (file order); malformed lines are skipped, a missing file is none. */
export function readLoadLines(stateDir: string): LoadLine[] {
  let text = '';
  try { text = readFileSync(loadFile(stateDir), 'utf8'); } catch { return []; }
  const out: LoadLine[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (isLine(r)) out.push(r); } catch {}
  }
  return out;
}

/** Rewrites the file without the lines older than 7 days before `now` (ms), and without malformed ones; returns how many
 *  were dropped. An unchanged file is not rewritten. */
export function pruneLoadLines(stateDir: string, now: number): number {
  let text = '';
  try { text = readFileSync(loadFile(stateDir), 'utf8'); } catch { return 0; }
  const all = text.split('\n').filter((l) => l.trim()).length;
  const keep = readLoadLines(stateDir).filter((l) => Date.parse(l.ts) >= now - KEEP_MS);
  if (keep.length === all) return 0;
  try { writeFileSync(loadFile(stateDir), keep.map((l) => JSON.stringify(l) + '\n').join('')); } catch { return 0; }
  return all - keep.length;
}

/** The minute's line from a reading (null: no line), rounded to one decimal. */
export function loadLineOf(at: number, r: { cpuPct: number; freeMemGB: number } | null, o: { target: number; running: number; gate: boolean }): LoadLine | null {
  if (!r) return null;
  const d1 = (x: number) => Math.round(x * 10) / 10;
  return { ts: new Date(at).toISOString(), cpuPct: d1(r.cpuPct), freeMemGB: d1(r.freeMemGB), target: o.target, running: o.running, gate: o.gate };
}
