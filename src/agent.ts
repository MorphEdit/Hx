// Drives Claude Code headless (`claude -p --output-format stream-json`) — no tmux, no screen scraping.
// The Ralph loop lives here: re-prompt the same session with --resume until the reply carries the
// completion promise or the iteration budget runs out.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { PROMISE_RE } from './state.ts';
import { resolveCmd } from './exec.ts';

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface TurnResult {
  ok: boolean; // the turn ran to a result without an error
  text: string; // everything the model said this turn
  usage: Usage;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  error?: string;
  limited?: { resetsAt?: number }; // usage limit hit — the pool should stop claiming
  fatal?: boolean; // the setup is wrong (unknown model, auth): every session would fail the same way
  timedOut?: boolean;
}

// API statuses that no retry and no other issue can fix: bad request (e.g. model not supported), auth, not found
const FATAL_STATUS = new Set([400, 401, 403, 404]);

export interface TurnOptions {
  bin: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  model: string;
  effort?: string;
  extraArgs: string[];
  timeoutMs: number;
  onEvent?: (ev: any) => void; // every raw stream-json line, for the per-issue log
  signal?: AbortSignal;
}

const LIMIT_TEXT = /usage limit|hit your [a-z]+ limit|limit reached|out of (usage )?credits/i;

export function emptyUsage(): Usage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

function killTree(pid: number | undefined, sync = false): void {
  if (!pid) return;
  // claude spawns shells and tools; kill the whole tree, not just claude.exe
  if (process.platform === 'win32') {
    if (sync) try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    else execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// Every claude process still running, so a force-quit can take them down instead of orphaning them.
const live = new Set<number>();

/** Kill every running claude session now (force quit). Synchronous: safe right before process.exit. */
export function killAllSessions(): void {
  for (const pid of live) killTree(pid, true);
  live.clear();
}

export interface RateLimit {
  status: string; // allowed | allowed_warning | rejected
  utilization?: number; // 0..1 when the CLI reports it
  resetsAt?: number; // unix seconds
  type?: string; // five_hour, seven_day, ...
}

/** The rate-limit info of a stream-json event, or null. Utilization is normalised to 0..1. */
export function rateLimitOf(ev: any): RateLimit | null {
  const i = ev?.type === 'rate_limit_event' ? ev.rate_limit_info : null;
  if (!i) return null;
  let u = typeof i.utilization === 'number' ? i.utilization : undefined;
  if (u !== undefined && u > 1) u /= 100;
  return { status: String(i.status ?? ''), utilization: u, resetsAt: i.resetsAt, type: i.rateLimitType };
}

export function runTurn(o: TurnOptions): Promise<TurnResult> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []), ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]), ...o.extraArgs];
  const started = Date.now();
  return new Promise((resolve) => {
    const [cmd, argv] = resolveCmd(o.bin, args);
    const child = spawn(cmd, argv, { cwd: o.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' });
    if (child.pid) live.add(child.pid);
    const res: TurnResult = { ok: false, text: '', usage: emptyUsage(), costUsd: 0, durationMs: 0, numTurns: 0 };
    const texts: string[] = [];
    let stderr = '';
    let gotResult = false;
    let rejectedLimit: { resetsAt?: number } | undefined;

    const timer = setTimeout(() => { res.timedOut = true; killTree(child.pid); }, o.timeoutMs);
    const onAbort = () => killTree(child.pid);
    o.signal?.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      o.onEvent?.(ev);
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) if (c.type === 'text' && c.text) texts.push(c.text);
      } else if (rateLimitOf(ev)?.status === 'rejected') {
        rejectedLimit = { resetsAt: rateLimitOf(ev)!.resetsAt };
      } else if (ev.type === 'result') {
        gotResult = true;
        const u = ev.usage ?? {};
        res.usage = { input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
        res.costUsd = ev.total_cost_usd ?? 0;
        res.numTurns = ev.num_turns ?? 0;
        res.ok = !ev.is_error && ev.subtype === 'success';
        if (!res.ok) {
          res.error = `${ev.api_error_status ? `API ${ev.api_error_status}` : ev.subtype}: ${String(ev.result ?? '').slice(0, 500)}`;
          if (FATAL_STATUS.has(Number(ev.api_error_status))) res.fatal = true;
        }
        if (typeof ev.result === 'string' && ev.result && !texts.includes(ev.result)) texts.push(ev.result);
      }
    });
    child.stderr!.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      if (child.pid) live.delete(child.pid);
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      res.durationMs = Date.now() - started;
      res.text = texts.join('\n');
      if (!gotResult) {
        res.ok = false;
        res.error = res.timedOut ? `turn timed out after ${Math.round(o.timeoutMs / 60000)} min`
          : `claude exited ${code} with no result: ${stderr.trim().slice(-500)}`;
      }
      if (rejectedLimit || (!res.ok && LIMIT_TEXT.test(`${res.error ?? ''}\n${stderr}`))) res.limited = rejectedLimit ?? {};
      resolve(res);
    });
    child.stdin!.end(o.prompt); // prompt via stdin: no Windows command-line length or quoting limits
  });
}

export interface GoalOptions extends Omit<TurnOptions, 'prompt' | 'sessionId' | 'resume'> {
  prompt: string;
  promise: string;
  maxIterations: number;
  continuePrompt: string;
  onTurn?: (iteration: number, sessionId: string, r: TurnResult) => void;
}

export interface GoalResult {
  done: boolean;
  sessionId: string;
  iterations: number;
  usage: Usage;
  costUsd: number;
  last?: TurnResult;
  stopReason: 'promise' | 'max-iterations' | 'error' | 'limited' | 'aborted' | 'fatal';
}

/** The Ralph loop: same session, re-prompted until the promise shows up. */
export async function runGoal(o: GoalOptions): Promise<GoalResult> {
  const sessionId = randomUUID();
  const promiseRe = PROMISE_RE(o.promise);
  const total = emptyUsage();
  let costUsd = 0;
  let last: TurnResult | undefined;
  let errors = 0;
  for (let i = 1; i <= o.maxIterations; i++) {
    if (o.signal?.aborted) return { done: false, sessionId, iterations: i - 1, usage: total, costUsd, last, stopReason: 'aborted' };
    last = await runTurn({ ...o, prompt: i === 1 ? o.prompt : o.continuePrompt, sessionId, resume: i > 1 });
    for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += last.usage[k];
    costUsd += last.costUsd;
    o.onTurn?.(i, sessionId, last);
    if (o.signal?.aborted) return { done: false, sessionId, iterations: i, usage: total, costUsd, last, stopReason: 'aborted' };
    if (last.limited) return { done: false, sessionId, iterations: i, usage: total, costUsd, last, stopReason: 'limited' };
    if (last.fatal) return { done: false, sessionId, iterations: i, usage: total, costUsd, last, stopReason: 'fatal' };
    if (promiseRe.test(last.text)) return { done: true, sessionId, iterations: i, usage: total, costUsd, last, stopReason: 'promise' };
    // A first turn that never started (bad flag, auth) cannot be resumed; two failed turns in a row is not transient.
    if (!last.ok && (i === 1 && last.numTurns === 0 || ++errors >= 2))
      return { done: false, sessionId, iterations: i, usage: total, costUsd, last, stopReason: 'error' };
    if (last.ok) errors = 0;
  }
  return { done: false, sessionId, iterations: o.maxIterations, usage: total, costUsd, last, stopReason: 'max-iterations' };
}
