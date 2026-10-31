// The fleet: the repos one `hx fleet run` works, listed in <hx home>/.hx/fleet.json.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR } from './config.ts';
import { pidAlive } from './runstate.ts';

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
