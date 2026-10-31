// The fleet: the repos one `hx fleet run` works, listed in <hx home>/.hx/fleet.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR } from './config.ts';

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
