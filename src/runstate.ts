// What a running `hx run` leaves on disk for other commands (status, pause) and for the next run:
//   .hx/live.json — the runner's pid and its sessions; a live.json whose pid is dead marks a crashed
//                   run, and its sessions are claims to hand back
//   .hx/pause     — "drain" (finish running sessions, claim nothing) or "now" (checkpoint and stop)
//   .hx/wake      — the ISO time a filing command (hx prd, hx bug, hx grill, hx issue) last filed an issue
//   .hx/exit.json — how the last `hx run --watch` ended: its pid, exit code and reason (hx supervise reads it for a
//                   runner it is not the parent of, one a self-update started: #316; a dead runner with none died
//                   without a record: #472)
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RateLimit } from './agent.ts';
import type { BudgetWindow } from './budget.ts';
import type { GhBudget } from './ghlimit.ts';

export interface LiveSession {
  key: string; // issue:<n> | prd:<n>
  number: number;
  kind: string; // impl | gauntlet | decompose | review | security | triage | bar
  title: string;
  since: string; // ISO time the session started
  turn: number;
  tokens: number;
}

export interface LiveState {
  pid: number;
  startedAt: string;
  repo: string;
  workers: number;
  sessions: LiveSession[];
  pausedUntil?: number; // ms epoch: no claims before this (usage limit)
  pauseReason?: string;
  draining?: boolean;
  rateLimit?: RateLimit & { at: string };
  skills?: Record<string, string[]>; // role → names of the skills its prompt gets
  models?: Record<string, { model: string; effort: string }>; // every known role → the model and effort its sessions run with
  gate?: { ok: boolean; sha: string; at: string; fixIssue?: number };
  budget?: { windows: BudgetWindow[] }; // per usage window: utilization, resetsAt, pairs, usdPerPct once calibrated
  github?: GhBudget; // the GitHub API budget, read at start and at most once a minute
  githubLow?: { until: number; reason: string }; // ms epoch: budget-low (below ghReservePct), no claims before this
  // only while autoWorkers is on: the target session count (workers stays the ceiling), and the latest per-pass reading's
  // CPU busy % (whole number) and free memory (GB, one decimal); both absent before the first reading
  autoWorkers?: { target: number; cpuPct?: number; freeMemGB?: number };
  // the HX_TEST_CONCURRENCY this runner set last (a session, a gate run or a ship --resume); absent before one, or with testConcurrency 0
  testConcurrency?: number;
}

export type PauseMode = 'drain' | 'now';

const liveFile = (stateDir: string) => path.join(stateDir, 'live.json');
const pauseFile = (stateDir: string) => path.join(stateDir, 'pause');

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function readLive(stateDir: string): LiveState | null {
  try { return JSON.parse(readFileSync(liveFile(stateDir), 'utf8')); } catch { return null; }
}

export function writeLive(stateDir: string, s: LiveState): void {
  const f = liveFile(stateDir);
  writeFileSync(f + '.tmp', JSON.stringify(s, null, 2));
  renameSync(f + '.tmp', f);
}

/** Removes live.json; with `pid`, only while it is that runner's (a self-update's new runner may own it by now). */
export function clearLive(stateDir: string, pid?: number): void {
  if (pid !== undefined && readLive(stateDir)?.pid !== pid) return;
  rmSync(liveFile(stateDir), { force: true });
}

/** The state of another runner that is still alive, or null. */
export function otherRunner(stateDir: string): LiveState | null {
  const s = readLive(stateDir);
  return s && s.pid !== process.pid && pidAlive(s.pid) ? s : null;
}

export function readPause(stateDir: string): PauseMode | null {
  if (!existsSync(pauseFile(stateDir))) return null;
  return readFileSync(pauseFile(stateDir), 'utf8').trim() === 'now' ? 'now' : 'drain';
}

export function setPause(stateDir: string, mode: PauseMode): void {
  writeFileSync(pauseFile(stateDir), mode + '\n');
}

export function clearPause(stateDir: string): void {
  rmSync(pauseFile(stateDir), { force: true });
}

// reason: `exit` (it stopped by itself), a signal's name, `uncaught exception: …`, `unhandled rejection: …` or `error: …`
export interface RunExit { pid: number; code: number; at: string; reason?: string }

const exitFile = (stateDir: string) => path.join(stateDir, 'exit.json');

/** Records how the `hx run --watch` with `pid` ended; never throws. */
export function writeExit(stateDir: string, code: number, pid = process.pid, reason?: string): void {
  try { writeFileSync(exitFile(stateDir), JSON.stringify({ pid, code, at: new Date().toISOString(), ...(reason ? { reason } : {}) } satisfies RunExit)); } catch {}
}

/** What `pid` recorded as it ended, or null when the record is another runner's (or there is none). */
export function readExitRecord(stateDir: string, pid: number): RunExit | null {
  try {
    const e: RunExit = JSON.parse(readFileSync(exitFile(stateDir), 'utf8'));
    return e.pid === pid && typeof e.code === 'number' ? e : null;
  } catch { return null; }
}

/** The exit code `pid` recorded, or null when the record is another runner's (or there is none). */
export function readExit(stateDir: string, pid: number): number | null {
  return readExitRecord(stateDir, pid)?.code ?? null;
}

let consoleKept = false; // stdout and stderr errors are ignored from the first recordExits on

/** The signals that end a runner and that Node can see: Ctrl+C, a stop request, the console closing, Ctrl+Break (Windows). */
export const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;

/**
 * Makes this `hx run --watch` record how it ends (#472): exit.json (pid, code, reason) first, then one `log` line.
 * - an uncaught exception or an unhandled rejection: `crashed: …`, `onStop`, exit 1;
 * - SIGTERM, SIGHUP, SIGBREAK (those the platform has): `runner pid N stopped by <signal>`, `onStop`, exit 128 + its number;
 * - SIGINT: recorded only (code 130): the caller's own handler stops the run, and the signal stays in the final record;
 * - any other end (`end`, or a process.exit somewhere): `runner pid N stopped (exit <code>)`.
 * A console that went away (an error on stdout or stderr) no longer stops the runner, not even after `end`, whose
 * own line may be the write that fails. `end` writes the final record and removes the other handlers.
 */
export function recordExits(o: { stateDir: string; log: (line: string) => void; onStop?: () => void }): { end: (code: number, reason?: string) => void } {
  const pid = process.pid;
  let done = false, signal = '';
  const say = (line: string) => { try { o.log(line); } catch {} };
  const off: (() => void)[] = [];
  const on = (target: NodeJS.EventEmitter, event: string, fn: (...a: any[]) => void) => { target.on(event, fn); off.push(() => target.off(event, fn)); };
  const stop = (code: number, reason: string, line: string, err?: unknown) => {
    if (done) return;
    done = true;
    writeExit(o.stateDir, code, pid, reason); // before any console write: the console may be what failed
    say(line);
    if (err !== undefined) try { console.error(err); } catch {}
    try { o.onStop?.(); } catch {}
    process.exit(code);
  };
  const crash = (kind: string) => (e: unknown) => {
    const reason = `${kind}: ${e instanceof Error ? e.message : String(e)}`.replace(/\s+/g, ' ');
    stop(1, reason, `crashed: ${reason} — runner pid ${pid} exits 1`, e);
  };
  on(process, 'uncaughtException', crash('uncaught exception'));
  on(process, 'unhandledRejection', crash('unhandled rejection'));
  for (const sig of EXIT_SIGNALS) {
    const n = (os.constants.signals as Record<string, number | undefined>)[sig];
    if (n === undefined) continue;
    on(process, sig, sig === 'SIGINT'
      ? () => { if (!done) { signal = sig; writeExit(o.stateDir, 128 + n, pid, sig); } }
      : () => stop(128 + n, sig, `runner pid ${pid} stopped by ${sig}`));
  }
  if (!consoleKept) for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
  consoleKept = true;
  const end = (code: number, reason?: string) => {
    if (done) return;
    done = true;
    writeExit(o.stateDir, code, pid, reason ?? (signal || 'exit'));
    say(`runner pid ${pid} stopped (exit ${code}${signal ? ` after ${signal}` : ''})${reason ? ` — ${reason}` : ''}`);
    for (const f of off) f();
  };
  on(process, 'exit', (code: number) => end(code));
  return { end };
}

/** A runner that died without a record (#472): live.json names a pid that is not alive, and exit.json is not that pid's. */
export interface DeadRunner { pid: number; sessions: number; lastSeen: string | null }

/** null unless the last runner died without a record. lastSeen: the newer of run.log's last line and live.json's last write. */
export function diedWithoutRecord(stateDir: string): DeadRunner | null {
  const live = readLive(stateDir);
  if (!live || typeof live.pid !== 'number' || pidAlive(live.pid) || readExitRecord(stateDir, live.pid)) return null;
  let seen = 0;
  try { seen = statSync(liveFile(stateDir)).mtimeMs; } catch {}
  try {
    const last = readFileSync(path.join(stateDir, 'run.log'), 'utf8').trimEnd().split(/\r?\n/).pop() ?? '';
    const t = Date.parse(last.split(' ')[0]);
    if (t > seen) seen = t;
  } catch {}
  return { pid: live.pid, sessions: live.sessions?.length ?? 0, lastSeen: seen ? new Date(seen).toISOString() : null };
}

/** Marks that a filing command just filed an issue: <stateDir>/wake holds the current ISO time. */
export function writeWake(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'wake'), new Date().toISOString() + '\n');
}

/** The closing line of a filing command: what happens to the new issue next, and whether a runner will do it. */
export function nextLine(stateDir: string, lane: 'decompose' | 'triage' | 'issue'): string {
  const head = lane === 'triage' ? 'It will be triaged. ' : lane === 'decompose' ? 'It will be decomposed into issues. ' : '';
  const live = readLive(stateDir);
  const up = live && typeof live.pid === 'number' && pidAlive(live.pid) ? live : null;
  const paused = readPause(stateDir) !== null || !!up?.draining;
  if (up) return head + (paused ? `hx run (pid ${up.pid}) is pausing — run  hx resume  to continue.`
    : `hx run (pid ${up.pid}) will pick it up now.`);
  return head + (paused ? 'no hx run is running and hx is paused — run  hx resume, then  hx run --watch'
    : 'no hx run is running — start it with  hx run --watch');
}
