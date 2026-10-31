// The fleet: the repos one `hx fleet run` works, listed in <hx home>/.hx/fleet.json.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject, STATE_DIR } from './config.ts';
import { otherRunner, pidAlive } from './runstate.ts';

export interface FleetRepo { root: string }
export interface Fleet { repos: FleetRepo[]; workers?: number }

export const DEFAULT_FLEET_WORKERS = 2;

/** os.homedir(), overridden by HX_HOME (tests point it at a temp dir). */
export function hxHome(): string {
  return process.env.HX_HOME || os.homedir();
}

export function fleetFile(): string {
  return path.join(hxHome(), STATE_DIR, 'fleet.json');
}

export function fleetDir(): string {
  return path.join(hxHome(), STATE_DIR, 'fleet');
}

export function readFleet(): Fleet {
  const f = fleetFile();
  if (!existsSync(f)) return { repos: [] };
  const raw = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
  return { ...raw, repos: Array.isArray(raw.repos) ? raw.repos : [] };
}

export function writeFleet(fleet: Fleet): void {
  mkdirSync(path.dirname(fleetFile()), { recursive: true });
  writeFileSync(fleetFile(), JSON.stringify(fleet, null, 2) + '\n');
}

/** Normalised absolute path for comparing roots: case-insensitive on Windows. */
export function sameRoot(a: string, b: string): boolean {
  const n = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

/** The fleet with root added (unchanged when it is already listed). */
export function addRepo(fleet: Fleet, root: string): Fleet {
  if (fleet.repos.some((r) => sameRoot(r.root, root))) return fleet;
  return { ...fleet, repos: [...fleet.repos, { root: path.resolve(root) }] };
}

export function removeRepo(fleet: Fleet, root: string): Fleet {
  return { ...fleet, repos: fleet.repos.filter((r) => !sameRoot(r.root, root)) };
}

export function fleetWorkers(fleet: Fleet): number {
  return fleet.workers ?? DEFAULT_FLEET_WORKERS;
}

// Slots: one shared worker cap across runners. A runner holds slot k while `<fleetDir>/slots/<k>.json` holds its pid.
export interface SlotOwner { pid: number; repo: string; issue: number }

const TAKEOVER_MAX_AGE_MS = 60_000;
const UNPARSABLE_GRACE_MS = 10_000;

export const slotsDir = (dir: string) => path.join(dir, 'slots');
const slotFile = (dir: string, k: number) => path.join(slotsDir(dir), `${k}.json`);

/** 'missing', 'held', or the id of a stale holder: its dead pid, or 'bad' (unparsable for over 10 s). */
function slotState(file: string): 'missing' | 'held' | { id: string } {
  let text: string;
  let mtime: number;
  try { mtime = statSync(file).mtimeMs; text = readFileSync(file, 'utf8'); } catch (e: any) { return e?.code === 'ENOENT' ? 'missing' : 'held'; }
  let pid: unknown;
  try { pid = JSON.parse(text).pid; } catch {}
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return pidAlive(pid) ? 'held' : { id: String(pid) };
  return Date.now() - mtime > UNPARSABLE_GRACE_MS ? { id: 'bad' } : 'held';
}

/** Create `<k>.json` exclusively and write the owner into it; false when it exists (or cannot be made). */
function create(file: string, o: SlotOwner): boolean {
  let fd: number;
  try { fd = openSync(file, 'wx'); } catch { return false; }
  try { writeSync(fd, JSON.stringify({ pid: o.pid, repo: o.repo, issue: o.issue, since: new Date().toISOString() })); } finally { closeSync(fd); }
  return true;
}

function dropOldMarkers(dir: string, k: number): void {
  let names: string[];
  try { names = readdirSync(slotsDir(dir)); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(`${k}.`) || !n.endsWith('.takeover')) continue;
    const f = path.join(slotsDir(dir), n);
    try { if (Date.now() - statSync(f).mtimeMs > TAKEOVER_MAX_AGE_MS) unlinkSync(f); } catch {}
  }
}

/** Take the first free slot k in 0..cap-1 (a stale one is taken over); null when every one is held. */
export function acquireSlot(dir: string, cap: number, o: SlotOwner): number | null {
  mkdirSync(slotsDir(dir), { recursive: true });
  for (let k = 0; k < cap; k++) {
    dropOldMarkers(dir, k);
    const file = slotFile(dir, k);
    if (create(file, o)) return k;
    const st = slotState(file);
    if (st === 'held') continue;
    if (st === 'missing') { if (create(file, o)) return k; continue; }
    // stale: only the holder of `<k>.<id>.takeover` may delete it, and only after re-reading it under the marker
    const marker = path.join(slotsDir(dir), `${k}.${st.id}.takeover`);
    try { closeSync(openSync(marker, 'wx')); } catch { continue; }
    try {
      const again = slotState(file);
      if (again !== 'missing' && again !== 'held' && again.id === st.id) {
        try { unlinkSync(file); } catch {}
        if (create(file, o)) return k;
      }
    } finally {
      try { unlinkSync(marker); } catch {}
    }
  }
  return null;
}

/** Give slot k back: delete `<k>.json` when it is still pid's. */
export function releaseSlot(dir: string, k: number, pid = process.pid): void {
  const file = slotFile(dir, k);
  try { if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file); } catch {}
}

// The shared usage hold: `<fleetDir>/hold.json` holds { until (ms epoch), reason, repo }; no runner claims before `until`.
export interface Hold { until: number; reason: string; repo: string }

export const holdFile = (dir: string) => path.join(dir, 'hold.json');

/** The hold in force: null when the file is missing, unparsable or already expired. */
export function readHold(dir: string, now = Date.now()): Hold | null {
  let h: any;
  try { h = JSON.parse(readFileSync(holdFile(dir), 'utf8')); } catch { return null; }
  if (!h || typeof h.until !== 'number' || !Number.isFinite(h.until) || h.until <= now) return null;
  return { until: h.until, reason: String(h.reason ?? ''), repo: String(h.repo ?? '') };
}

/** Write the hold unless the file already holds a later `until`; true when written. */
export function writeHold(dir: string, h: Hold): boolean {
  let cur: unknown;
  try { cur = JSON.parse(readFileSync(holdFile(dir), 'utf8')).until; } catch {}
  if (typeof cur === 'number' && cur >= h.until) return false;
  mkdirSync(dir, { recursive: true });
  const tmp = `${holdFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ until: h.until, reason: h.reason, repo: h.repo }));
  try { renameSync(tmp, holdFile(dir)); } catch { try { unlinkSync(tmp); } catch {} return false; }
  return true;
}

/** Slot files whose pid is alive (stale or unparsable files are not counted). */
export function slotsInUse(dir: string): number {
  let names: string[];
  try { names = readdirSync(slotsDir(dir)); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const pid = JSON.parse(readFileSync(path.join(slotsDir(dir), name), 'utf8')).pid;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pidAlive(pid)) n++;
    } catch {}
  }
  return n;
}

// hx fleet run: one `hx run` child per repo, sharing the cap through fleetDir() slots. Ctrl+C reaches the children
// only over IPC: a child is detached (its own console), and child.kill('SIGINT') would kill it outright on Windows.
export interface FleetRunOptions {
  workers?: number;                 // --workers N; else fleet.json workers, else 2
  watch?: boolean;
  entry?: string;                   // the cli script the children run (default: the one this process runs)
  env?: Record<string, string>;     // added to the children's environment
  print?: (line: string) => void;
}
export interface FleetRun { interrupt(): void; done: Promise<number> }

/** Print every line of a stream as `<prefix><line>`; a trailing partial line is printed when the stream ends. */
function pipeLines(stream: NodeJS.ReadableStream, prefix: string, print: (l: string) => void): Promise<void> {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (s: string) => {
    buf += s;
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const l of lines) print(prefix + l.replace(/\r$/, ''));
  });
  return new Promise((resolve) => stream.on('close', () => { if (buf) print(prefix + buf.replace(/\r$/, '')); buf = ''; resolve(); }));
}

export function startFleetRun(o: FleetRunOptions = {}): FleetRun {
  const print = o.print ?? ((l: string) => console.log(l));
  const fleet = readFleet();
  const cap = o.workers ?? fleetWorkers(fleet);
  const entry = o.entry ?? process.argv[1];
  const kids: ChildProcess[] = [];
  const exits: Promise<number>[] = [];
  for (const r of fleet.repos) {
    if (!existsSync(r.root)) { print(`[${r.root}] skipped: missing`); continue; }
    let p: ReturnType<typeof loadProject>;
    try { p = loadProject(r.root); } catch { print(`[${r.root}] skipped: no .hx/config.json`); continue; }
    const name = p.config.repo || r.root;
    const other = otherRunner(p.stateDir);
    if (other) { print(`[${name}] skipped: hx is already running (pid ${other.pid})`); continue; }
    const child = spawn(process.execPath, [entry, 'run', '--workers', String(cap), ...(o.watch ? ['--watch'] : [])], {
      cwd: p.root, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...o.env, HX_FLEET_DIR: fleetDir(), HX_FLEET_WORKERS: String(cap) },
    });
    kids.push(child);
    const streams = Promise.all([pipeLines(child.stdout!, `[${name}] `, print), pipeLines(child.stderr!, `[${name}] `, print)]);
    const exited = new Promise<number>((resolve) => {
      child.on('error', (e) => { print(`[${name}] could not start: ${e.message}`); resolve(1); });
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    exits.push(Promise.all([exited, streams]).then(([c]) => c));
  }
  let presses = 0;
  return {
    interrupt() {
      print(++presses === 1 ? 'Ctrl+C — asking every repo to checkpoint' : 'Ctrl+C again — force quit sent to every repo');
      for (const k of kids) if (k.exitCode === null && k.signalCode === null && k.connected) k.send({ type: 'interrupt' }, () => {});
    },
    done: Promise.all(exits).then((codes) => Math.max(0, ...codes)),
  };
}
