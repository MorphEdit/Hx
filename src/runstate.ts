// What a running `hx run` leaves on disk for other commands (status, pause) and for the next run:
//   .hx/live.json — the runner's pid and its sessions; a live.json whose pid is dead marks a crashed
//                   run, and its sessions are claims to hand back
//   .hx/pause     — "drain" (finish running sessions, claim nothing) or "now" (checkpoint and stop)
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RateLimit } from './agent.ts';

export interface LiveSession {
  key: string; // issue:<n> | prd:<n>
  number: number;
  kind: string; // impl | decompose | review
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

export function clearLive(stateDir: string): void {
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
