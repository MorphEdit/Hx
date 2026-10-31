// Drives a headless agent CLI (Claude Code by default, see src/agents/) — no tmux, no screen scraping.
// The Ralph loop lives here: re-prompt the same session with --resume until the reply carries the
// completion promise or the iteration budget runs out.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { PROMISE_RE } from './state.ts';
import { killTree, resolveCmd } from './exec.ts';
import { claude } from './agents/claude.ts';
import type { AgentCli } from './agents/types.ts';

export { rateLimitOf } from './agents/claude.ts';

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
  stalled?: boolean; // killed after stallMs without a line on stdout
}

export interface TurnOptions {
  agent?: AgentCli; // the CLI driven (unset = claude); bin is still the exact binary spawned
  bin: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  model: string;
  effort?: string;
  extraArgs: string[];
  timeoutMs: number;
  stallMs?: number; // kill the turn after this long without a line on stdout (0 / unset = off)
  onEvent?: (ev: any) => void; // every event the agent parsed (claude: each stream-json line), for the per-issue log
  onRateLimit?: (rl: RateLimit) => void; // the agent reported its usage window
  signal?: AbortSignal;
  env?: Record<string, string>; // added to this process's env for the session (e.g. HX_TRUSTED)
}

export function emptyUsage(): Usage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
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

export function runTurn(o: TurnOptions): Promise<TurnResult> {
  const agent = o.agent ?? claude;
  const args = agent.args(o);
  const turn = agent.turn(o);
  const started = Date.now();
  return new Promise((resolve) => {
    const [cmd, argv] = resolveCmd(o.bin, args);
    const child = spawn(cmd, argv, { cwd: o.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', ...(o.env ? { env: { ...process.env, ...o.env } } : {}) });
    if (child.pid) live.add(child.pid);
    const res: TurnResult = { ok: false, text: '', usage: emptyUsage(), costUsd: 0, durationMs: 0, numTurns: 0 };
    let stderr = '';

    const timer = setTimeout(() => { res.timedOut = true; killTree(child.pid); }, o.timeoutMs);
    // a turn that stops printing (a stuck background command, a poll loop) is killed long before the timeout
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (!o.stallMs) return;
      clearTimeout(stall);
      stall = setTimeout(() => { res.stalled = true; killTree(child.pid); }, o.stallMs);
    };
    armStall();
    const onAbort = () => killTree(child.pid);
    o.signal?.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout! }).on('line', (line) => {
      armStall();
      const out = turn.line(line, res);
      if (!out) return;
      if (out.event !== undefined) o.onEvent?.(out.event);
      if (out.rateLimit) o.onRateLimit?.(out.rateLimit);
    });
    child.stderr!.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      if (child.pid) live.delete(child.pid);
      clearTimeout(timer);
      clearTimeout(stall);
      o.signal?.removeEventListener('abort', onAbort);
      res.durationMs = Date.now() - started;
      turn.finish(res, code, stderr);
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
