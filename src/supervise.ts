// hx supervise: keeps `hx run --watch` up in one repo. It starts the runner as a child, restarts it after a crash with a
// backoff, and stops when a person stopped the runner (exit 0, .hx/pause). Its own state, for hx status and the dashboard:
//   .hx/supervise.json — the supervisor's pid, its child's pid, and the last `supervise:` line it logged
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pidAlive, readLive, readPause } from './runstate.ts';

/** Seconds before the 1st, 2nd, 3rd and every later restart. */
export const BACKOFF_SECONDS = [10, 30, 60, 300];

export interface SuperviseState {
  pid?: number; // the supervisor, while it runs
  startedAt?: string;
  childPid?: number;
  last?: { at: string; line: string }; // the last `supervise:` line, kept after the supervisor stops
}

export interface SuperviseOptions {
  stateDir: string;
  root: string; // the repo: the child's working directory
  entry: string; // bin/hx.mjs (a fake in the tests)
  args: string[]; // passed on after `run --watch`, e.g. ['--workers', '2']
  log: (line: string) => void; // gets every `supervise: …` line (the run log)
  backoffMs?: number[]; // default BACKOFF_SECONDS
  resetAfterMs?: number; // a run that stayed up this long resets the backoff (default 30 min)
  crashWindowMs?: number; // default 10 min
  maxCrashes?: number; // default 5
  pollMs?: number; // how often a pause or a foreign runner is checked (default 5 s)
  env?: NodeJS.ProcessEnv;
  // after a crash, before the restart: a self-update's open watch window rolls the install back (#316); true: rolled back
  rollback?: (reason: string) => Promise<boolean>;
}

const stateFile = (stateDir: string) => path.join(stateDir, 'supervise.json');

export function readSupervise(stateDir: string): SuperviseState {
  try { return JSON.parse(readFileSync(stateFile(stateDir), 'utf8')); } catch { return {}; }
}

function writeSupervise(stateDir: string, s: SuperviseState): void {
  const f = stateFile(stateDir);
  writeFileSync(f + '.tmp', JSON.stringify(s, null, 2));
  renameSync(f + '.tmp', f);
}

/** The pid of a live supervisor of this repo (not this process), or null. */
export function liveSupervisor(stateDir: string): number | null {
  const pid = readSupervise(stateDir).pid;
  return pid && pid !== process.pid && pidAlive(pid) ? pid : null;
}

/** The backoff before restart number `crashes` (1-based) since the last reset. */
export function backoffFor(crashes: number, backoffMs: number[]): number {
  return backoffMs[Math.min(Math.max(crashes, 1), backoffMs.length) - 1];
}

/** true when the crash times (ms) hold `max` within `windowMs` of the last one. */
export function tooManyCrashes(times: number[], max: number, windowMs: number): boolean {
  const last = times[times.length - 1];
  return times.filter((t) => last - t < windowMs).length >= max;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs until the runner is stopped by a person (0) or gives up after too many crashes (1); 3 when a supervisor already runs. */
export async function supervise(o: SuperviseOptions): Promise<number> {
  const backoffMs = o.backoffMs ?? BACKOFF_SECONDS.map((s) => s * 1000);
  const resetAfterMs = o.resetAfterMs ?? 30 * 60_000, windowMs = o.crashWindowMs ?? 10 * 60_000;
  const maxCrashes = o.maxCrashes ?? 5, pollMs = o.pollMs ?? 5000;
  const other = liveSupervisor(o.stateDir);
  if (other) { console.error(`hx supervise is already running for this repo (pid ${other})`); return 3; }
  const state: SuperviseState = { ...readSupervise(o.stateDir), pid: process.pid, startedAt: new Date().toISOString(), childPid: undefined };
  const say = (msg: string) => {
    const line = `supervise: ${msg}`;
    o.log(line);
    state.last = { at: new Date().toISOString(), line };
    writeSupervise(o.stateDir, state);
  };
  const save = () => writeSupervise(o.stateDir, state);
  save();
  const crashes: number[] = [];
  let streak = 0; // crashes since the last reset of the backoff
  try {
    for (;;) {
      // before each start: a pause or a runner this supervisor did not start keeps it waiting
      let saidPaused = false, saidForeign = false;
      for (;;) {
        if (readPause(o.stateDir)) {
          if (!saidPaused) { say('stopped: paused — waiting for hx resume'); saidPaused = true; }
        } else {
          const live = readLive(o.stateDir);
          if (!live || !pidAlive(live.pid)) break;
          if (!saidForeign) { say(`hx run is already running (pid ${live.pid}), not started by this supervisor — waiting`); saidForeign = true; }
        }
        await sleep(pollMs);
      }
      const startedAt = Date.now();
      const child = spawn(process.execPath, [o.entry, 'run', '--watch', ...o.args], { cwd: o.root, stdio: 'inherit', env: o.env ?? process.env, windowsHide: true });
      state.childPid = child.pid;
      say(`started hx run (pid ${child.pid})`);
      const code = await new Promise<number>((resolve) => {
        child.on('error', () => resolve(1));
        child.on('exit', (c, sig) => resolve(c ?? (sig ? 1 : 0)));
      });
      state.childPid = undefined;
      if (code === 0) {
        // a self-update hands the run lock to a new runner and exits 0: watch that one until it stops
        const next = readLive(o.stateDir);
        if (next && next.pid !== child.pid && pidAlive(next.pid)) {
          say(`runner exited 0 and handed over to pid ${next.pid} — watching it`);
          while (pidAlive(next.pid)) await sleep(pollMs);
          if (readLive(o.stateDir)?.pid !== next.pid) { say('runner stopped (exit 0) — not restarting'); return 0; }
          say(`runner pid ${next.pid} stopped without clearing its run lock`); // a crash
        } else { say('runner stopped (exit 0) — not restarting'); return 0; }
      }
      // inside a self-update's watch window the crashed version is rolled back first, so the restart runs the old one
      if (o.rollback) await o.rollback(code ? `the runner exited ${code}` : 'the runner stopped without clearing its run lock').catch(() => false);
      const at = Date.now();
      if (at - startedAt >= resetAfterMs) streak = 0;
      crashes.push(at);
      if (tooManyCrashes(crashes, maxCrashes, windowMs)) {
        say(`gave up after ${maxCrashes} crashes in ${Math.round(windowMs / 60_000)} min`);
        return 1;
      }
      const wait = backoffFor(++streak, backoffMs);
      say(`runner exited ${code || 1}, restart in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  } finally {
    state.pid = undefined; state.childPid = undefined;
    save();
  }
}
