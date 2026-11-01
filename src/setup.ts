// The worktree setup step: copy the untracked local files a fresh worktree lacks (config.worktreeCopy), keep
// them out of git, then run config.worktreeSetup (e.g. `npm ci`) in it. Sessions and the gate call it.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { run, runOk, runShell } from './exec.ts';

const GIT = process.env.HX_GIT_BIN || 'git';
const TAIL_LINES = 20;

export interface SetupResult {
  ok: boolean; // exit 0 and not timed out
  exit: number;
  timedOut: boolean;
  aborted: boolean;
  tail: string; // the last 20 output lines
  command: string;
  ms: number;
}

export interface SetupRecord { command: string; ok: boolean; exit: number; timedOut: boolean; tail: string; at: string }

export interface SetupOptions {
  checkout: string; // the main checkout: worktreeCopy entries are read from it
  dir: string; // the new worktree
  name: string; // the worktree's name (i12, gate…): names logs/setup-<name>.log
  stateDir: string;
  config: Pick<Config, 'worktreeSetup' | 'worktreeSetupMinutes' | 'worktreeCopy'>;
  signal?: AbortSignal;
  log: (msg: string) => void;
}

/** `.env` → `/.env`, `config\local\` → `/config/local`: an anchored info/exclude line. */
const excludeLine = (entry: string) => '/' + path.posix.normalize(entry.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');

const lastLines = (s: string, n: number) => s.replace(/\s+$/, '').split(/\r?\n/).slice(-n).join('\n');

/**
 * Copies the worktreeCopy entries into `dir`, then runs worktreeSetup there. Returns undefined when there
 * was nothing to do (no command and nothing copied). Writes the command's output to logs/setup-<name>.log,
 * never a record: the caller decides what to keep.
 */
export async function setupWorktree(o: SetupOptions): Promise<SetupResult | undefined> {
  const t0 = Date.now();
  const copied: string[] = [];
  for (const entry of o.config.worktreeCopy ?? []) {
    const src = path.join(o.checkout, entry);
    if (!existsSync(src)) continue;
    const tracked = await run(GIT, ['-C', o.checkout, 'ls-files', '--', entry]);
    if (tracked.stdout.trim()) { o.log(`setup: skipped ${entry} (tracked by git)`); continue; }
    const dst = path.join(o.dir, entry);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
    copied.push(entry);
  }
  if (copied.length) {
    // resolved first (it awaits); the read, check and append below are synchronous, so parallel setups never add a line twice
    const common = (await runOk(GIT, ['-C', o.checkout, 'rev-parse', '--git-common-dir'])).trim();
    const exclude = path.join(path.resolve(o.checkout, common), 'info', 'exclude');
    mkdirSync(path.dirname(exclude), { recursive: true });
    for (const entry of copied) {
      const line = excludeLine(entry);
      const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (text.split(/\r?\n/).includes(line)) continue;
      appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
    }
  }

  const command = o.config.worktreeSetup ?? '';
  if (!command) return copied.length ? { ok: true, exit: 0, timedOut: false, aborted: false, tail: '', command, ms: Date.now() - t0 } : undefined;
  if (o.signal?.aborted) return { ok: false, exit: 130, timedOut: false, aborted: true, tail: '', command, ms: Date.now() - t0 };
  const res = await runShell(command, { cwd: o.dir, timeoutMs: o.config.worktreeSetupMinutes * 60_000, signal: o.signal });
  const tail = lastLines(res.output, TAIL_LINES);
  if (res.aborted) return { ok: false, exit: res.code, timedOut: false, aborted: true, tail, command, ms: Date.now() - t0 };
  mkdirSync(path.join(o.stateDir, 'logs'), { recursive: true });
  writeFileSync(path.join(o.stateDir, 'logs', `setup-${o.name}.log`), res.output);
  return { ok: res.code === 0 && !res.timedOut, exit: res.code, timedOut: res.timedOut, aborted: false, tail, command, ms: Date.now() - t0 };
}

/**
 * The run-log text of a setup, without the `[#n]` / `gate:` prefix: `setup: <cmd> (<s>s)`, or
 * `setup FAILED (exit <code>): <tail>` / `setup FAILED (timed out after <m> min): <tail>`. `suffix` goes
 * inside the parentheses (`try 2 of 3`); `minutes` is the configured limit (default: the time it ran).
 */
export function setupLine(r: SetupResult, cmd: string, o: { suffix?: string; minutes?: number } = {}): string {
  const extra = o.suffix ? `, ${o.suffix}` : '';
  if (r.ok) return `setup: ${cmd} (${Math.round(r.ms / 1000)}s${extra})`;
  const why = r.timedOut ? `timed out after ${o.minutes ?? Math.round(r.ms / 60_000)} min` : `exit ${r.exit}`;
  const tail = r.tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' | ').slice(-500);
  return `setup FAILED (${why}${extra}): ${tail}`;
}

const recordFile = (stateDir: string, name: string) => path.join(stateDir, 'logs', `setup-${name}.json`);

export function writeSetupRecord(stateDir: string, name: string, r: SetupResult): void {
  mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const rec: SetupRecord = { command: r.command, ok: r.ok, exit: r.exit, timedOut: r.timedOut, tail: r.tail, at: new Date().toISOString() };
  writeFileSync(recordFile(stateDir, name), JSON.stringify(rec, null, 2) + '\n');
}

/** Removes the record of worktree `name` (if any), so a setup that never finishes leaves none behind. */
export function clearSetupRecord(stateDir: string, name: string): void {
  rmSync(recordFile(stateDir, name), { force: true });
}

/** The last setup of worktree `name`, or undefined when there is none (or it cannot be read). */
export function readSetupRecord(stateDir: string, name: string): SetupRecord | undefined {
  try { return JSON.parse(readFileSync(recordFile(stateDir, name), 'utf8')); } catch { return undefined; }
}

/** What a session's prompt is told about its worktree's setup: '' unless it failed. */
export function setupNote(cmd: string, r: Pick<SetupResult, 'ok' | 'tail'> | undefined): string {
  if (!r || r.ok) return '';
  let fence = '```';
  while (r.tail.includes(fence)) fence += '`'; // output holding a fence cannot close this one
  return `The worktree setup command \`${cmd}\` failed; its output is below. Fix the environment first if the failure blocks you, and say so in your handoff.\n\n${fence}\n${r.tail}\n${fence}`;
}
