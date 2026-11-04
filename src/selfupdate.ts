// The self-update of a watching runner (#253): when hx's own install has newer code, an idle `hx run --watch`
// moves the install forward, starts a new runner with the same arguments and exits once that one is ready; a new
// runner that exits early or is never ready is rolled back and its version is not tried again.
//   .hx/selfupdate.json — the last self-update line, the versions that failed, a rollback's detached sha
//   .hx/selfupdate-ready — written by the new runner when its first poll begins (HX_SELFUPDATE_READY names it)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hideWindow, killTree, run } from './exec.ts';
// plain JS: the release lookup and the npm call `hx update` uses
import { latestTag, npmInstall, REPO } from '../bin/install.mjs';

export interface SelfUpdateState {
  last?: { at: string; line: string };
  bad: string[]; // shas (git checkout) or tags (release install) whose runner did not start: never tried again
  detached?: string; // the sha a rollback left the checkout at (detached): still counts as on the default branch
}

export const selfUpdateFile = (stateDir: string) => path.join(stateDir, 'selfupdate.json');
export const readyFile = (stateDir: string) => path.join(stateDir, 'selfupdate-ready');
export const READY_MS = 120_000;

/** The hx install this runner's code came from (HX_SELF_ROOT overrides it: the tests' temp checkout). */
export const hxRoot = () => process.env.HX_SELF_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A clone (an `npm link` of a checkout) or a release `npm install -g`. */
export const installKind = (root: string): 'git' | 'release' => existsSync(path.join(root, '.git')) ? 'git' : 'release';

/** A changed path a running runner holds in memory; prompts/ (read fresh for each session) and docs are not. */
export const isCode = (f: string) => /^(src|bin|scripts)\//.test(f) || ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(f);
export const isLockfile = (f: string) => f === 'package-lock.json' || f === 'npm-shrinkwrap.json';

export function readSelfUpdate(stateDir: string): SelfUpdateState {
  try {
    const s = JSON.parse(readFileSync(selfUpdateFile(stateDir), 'utf8'));
    return { ...s, bad: Array.isArray(s?.bad) ? s.bad.filter((x: unknown) => typeof x === 'string') : [] };
  } catch { return { bad: [] }; }
}

export function writeSelfUpdate(stateDir: string, s: SelfUpdateState): void {
  writeFileSync(selfUpdateFile(stateDir), JSON.stringify(s, null, 2) + '\n');
}

/** What is wrong with config.selfUpdate or selfUpdateMinutes, or null when both are valid. */
export function selfUpdateConfigError(c: { selfUpdate?: unknown; selfUpdateMinutes?: unknown }): string | null {
  if (c.selfUpdate !== undefined && typeof c.selfUpdate !== 'boolean') return `selfUpdate: ${JSON.stringify(c.selfUpdate)} must be true or false`;
  const m = c.selfUpdateMinutes;
  if (m !== undefined && !(typeof m === 'number' && Number.isFinite(m) && m > 0)) return `selfUpdateMinutes: ${JSON.stringify(m)} must be a number of minutes above 0`;
  return null;
}

/** Is release tag `tag` (vX.Y.Z) newer than `version` (X.Y.Z)? */
export function newerTag(version: string, tag: string): boolean {
  const n = (s: string) => s.replace(/^v/, '').split('.').map(Number);
  const a = n(version), b = n(tag);
  for (let i = 0; i < 3; i++) if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  return false;
}

/** What one check found. `skip`: logged once per reason; `none`: nothing to do (up to date, prompts only, a bad version). */
export type Check =
  | { kind: 'none' }
  | { kind: 'skip'; why: string }
  | { kind: 'update'; from: string; to: string; files: number; lockfile: boolean; apply: () => Promise<string | null>; rollback: () => Promise<string | null> };

const gitIn = (root: string) => async (...a: string[]) => {
  const r = await run(process.env.HX_GIT_BIN || 'git', ['-C', root, ...a]);
  if (r.code !== 0) throw new Error(`git ${a[0]}: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0]}`);
  return r.stdout.trim();
};

/** npm ci in the checkout (HX_NPM_BIN overrides npm): an error line, or null. */
async function npmCi(root: string): Promise<string | null> {
  const r = await npmInstall(['ci'], process.env, root);
  return r.code === 0 ? null : `npm ci failed (exit ${r.code})`;
}

/** A git-checkout install: fetch, then is origin/<default> ahead with code in the diff, and may the checkout move? */
export async function checkGit(root: string, s: SelfUpdateState): Promise<Check> {
  const git = gitIn(root);
  await git('fetch', '-q', 'origin');
  const def = (await git('rev-parse', '--abbrev-ref', 'origin/HEAD').catch(() => 'origin/main')).replace(/^origin\//, '');
  const from = await git('rev-parse', 'HEAD');
  const to = await git('rev-parse', `origin/${def}`);
  if (from === to || s.bad.includes(to)) return { kind: 'none' };
  if (!(await git('merge-base', '--is-ancestor', from, to).then(() => true, () => false))) return { kind: 'skip', why: `the hx checkout ${root} has commits that are not on origin/${def}` };
  const files = (await git('diff', '--name-only', from, to)).split(/\r?\n/).filter(Boolean);
  if (!files.some(isCode)) return { kind: 'none' };
  if (await git('status', '--porcelain')) return { kind: 'skip', why: `the hx checkout ${root} has local changes` };
  const branch = await git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => '');
  const rolledBack = !branch && s.detached === from;
  if (branch !== def && !rolledBack) return { kind: 'skip', why: `the hx checkout ${root} is on ${branch || 'a detached HEAD'}, not ${def}` };
  const lockfile = files.some(isLockfile);
  return {
    kind: 'update', from, to, files: files.length, lockfile,
    apply: async () => {
      try {
        if (rolledBack) await git('checkout', '-q', def);
        await git('merge', '--ff-only', '-q', `origin/${def}`);
      } catch (e: any) { return e.message; }
      return lockfile ? npmCi(root) : null;
    },
    rollback: async () => {
      try { await git('checkout', '-q', '--detach', from); } catch (e: any) { return e.message; }
      return lockfile ? npmCi(root) : null;
    },
  };
}

/** A release install: the same lookup and install as `hx update`. */
export async function checkRelease(root: string, s: SelfUpdateState): Promise<Check> {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const tag = await latestTag(process.env);
  if (!tag || !newerTag(version, tag) || s.bad.includes(tag)) return { kind: 'none' };
  const install = async (ref: string) => {
    const r = await npmInstall(['install', '-g', `github:${REPO}#${ref}`], process.env);
    return r.code === 0 ? null : `npm install -g github:${REPO}#${ref} failed (exit ${r.code})`;
  };
  return { kind: 'update', from: `v${version}`, to: tag, files: 0, lockfile: false, apply: () => install(tag), rollback: () => install(`v${version}`) };
}

export const short = (v: string) => /^[0-9a-f]{40}$/.test(v) ? v.slice(0, 7) : v;

/**
 * Start the new runner (`node <hx>/bin/hx.mjs <args>`, detached so it outlives this process) and wait for its ready
 * marker. ok: it is ready and runs on; else the reason, and the child (if still alive) has been killed.
 */
export async function restart(o: { root: string; args: string[]; cwd: string; stateDir: string; timeoutMs?: number }):
  Promise<{ ok: true; pid: number } | { ok: false; reason: string }> {
  const marker = readyFile(o.stateDir);
  rmSync(marker, { force: true });
  const timeoutMs = o.timeoutMs ?? READY_MS;
  // detached: it has no console of its own to share, so its children hide theirs (HX_SHARE_CONSOLE is not passed on)
  const env: NodeJS.ProcessEnv = { ...process.env, HX_SELFUPDATE_READY: marker, HX_SELFUPDATE_FROM: String(process.pid) };
  delete env.HX_SHARE_CONSOLE;
  const child = spawn(process.execPath, [path.join(o.root, 'bin', 'hx.mjs'), ...o.args], {
    cwd: o.cwd, detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: hideWindow(), env,
  });
  let exited: string | null = null;
  child.on('exit', (code, sig) => { exited = `exited with code ${code ?? sig} before it was ready`; });
  child.on('error', (e) => { exited = `could not start: ${e.message}`; });
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(marker)) { rmSync(marker, { force: true }); child.unref(); return { ok: true, pid: child.pid! }; }
    if (exited) return { ok: false, reason: exited };
    if (Date.now() > end) { killTree(child.pid, true); return { ok: false, reason: `not ready after ${Math.round(timeoutMs / 1000)} s` }; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** In a runner a self-update started: the old runner's pid (its run lock is taken over) and the marker to write. */
export function handover(): { from: number; ready: string } | null {
  const from = Number(process.env.HX_SELFUPDATE_FROM), ready = process.env.HX_SELFUPDATE_READY;
  delete process.env.HX_SELFUPDATE_FROM; delete process.env.HX_SELFUPDATE_READY; // never passed on to sessions
  return from && ready ? { from, ready } : null;
}
