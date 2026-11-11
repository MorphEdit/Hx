// Claude Code headless: `claude -p --output-format stream-json`.
import type { RateLimit, TurnOptions, TurnResult } from '../agent.ts';
import type { AgentCli, AgentTurn } from './types.ts';

// API statuses that no retry and no other issue can fix: bad request (e.g. model not supported), auth, not found
const FATAL_STATUS = new Set([400, 401, 403, 404]);

const LIMIT_TEXT = /usage limit|hit your [a-z]+ limit|limit reached|out of (usage )?credits/i;

/** The rate-limit info of a stream-json event, or null. Utilization is normalised to 0..1. */
export function rateLimitOf(ev: any): RateLimit | null {
  const i = ev?.type === 'rate_limit_event' ? ev.rate_limit_info : null;
  if (!i) return null;
  let u = typeof i.utilization === 'number' ? i.utilization : undefined;
  if (u !== undefined && u > 1) u /= 100;
  return { status: String(i.status ?? ''), utilization: u, resetsAt: i.resetsAt, type: i.rateLimitType };
}

/** The model with the most output tokens in a result's modelUsage (side calls may use a small model), or undefined. */
export function mainModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  let best: string | undefined;
  let most = -1;
  for (const [model, u] of Object.entries(modelUsage as Record<string, any>)) {
    const out = Number(u?.outputTokens ?? 0) || 0;
    if (out > most) { best = model; most = out; }
  }
  return best;
}

/** ship.mjs's default --test-timeout (minutes): one shell command of a worker must be able to run that long. */
export const SHIP_TEST_MINUTES = 45;
/** Claude Code's own timeout for a shell command that passes none (BASH_DEFAULT_TIMEOUT_MS unset). */
export const SHELL_DEFAULT_MS = 120_000;
/** Claude Code's own cap on one shell command's timeout (BASH_MAX_TIMEOUT_MS unset). */
const SHELL_CAP_MS = 600_000;

/**
 * The shell timeouts for a session. BASH_MAX_TIMEOUT_MS: ship's test timeout + 5 min, kept a minute below the turn
 * timeout (Claude Code caps one command at 10 min otherwise), so ship.mjs and the full suite can run when the worker
 * passes a long `timeout`. BASH_DEFAULT_TIMEOUT_MS is not raised (#443): a command without its own timeout ends at
 * Claude Code's 2 min, so a hung one costs minutes. A higher value already in `env` is kept for either.
 */
export function shellEnv(turnTimeoutMs: number, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const want = Math.min((SHIP_TEST_MINUTES + 5) * 60_000, turnTimeoutMs - 60_000);
  if (!(want > 0)) return {};
  const out: Record<string, string> = { BASH_MAX_TIMEOUT_MS: String(Math.max(want, Number(env.BASH_MAX_TIMEOUT_MS) || 0)) };
  if (Number(env.BASH_DEFAULT_TIMEOUT_MS) > SHELL_DEFAULT_MS) out.BASH_DEFAULT_TIMEOUT_MS = String(Number(env.BASH_DEFAULT_TIMEOUT_MS));
  return out;
}

function claudeTurn(o: TurnOptions): AgentTurn {
  const texts: string[] = [];
  let final = ''; // the result event's result, else the last text block
  const shell = shellEnv(o.timeoutMs);
  const maxMs = Number(shell.BASH_MAX_TIMEOUT_MS) || SHELL_CAP_MS;
  const defaultMs = Math.min(Number(shell.BASH_DEFAULT_TIMEOUT_MS) || SHELL_DEFAULT_MS, maxMs);
  // tool calls started and not answered yet: the longest each can run (its own `timeout`, else the default)
  const pending = new Map<string, number>();
  let gotResult = false;
  let rejectedLimit: { resetsAt?: number } | undefined;
  return {
    line(line, res) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      const rl = rateLimitOf(ev);
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'text' && c.text) { texts.push(c.text); final = c.text; }
          else if (c.type === 'tool_use' && c.id) pending.set(c.id, Math.min(Number(c.input?.timeout) || defaultMs, maxMs));
        }
      } else if (ev.type === 'user') {
        for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) if (c.type === 'tool_result') pending.delete(c.tool_use_id);
      } else if (rl?.status === 'rejected') {
        rejectedLimit = { resetsAt: rl.resetsAt };
      } else if (ev.type === 'result') {
        gotResult = true;
        const u = ev.usage ?? {};
        res.usage = { input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
        res.costUsd = ev.total_cost_usd ?? 0;
        const actual = mainModel(ev.modelUsage);
        if (actual) res.actualModel = actual;
        res.numTurns = ev.num_turns ?? 0;
        res.ok = !ev.is_error && ev.subtype === 'success';
        if (!res.ok) {
          res.error = `${ev.api_error_status ? `API ${ev.api_error_status}` : ev.subtype}: ${String(ev.result ?? '').slice(0, 500)}`;
          if (FATAL_STATUS.has(Number(ev.api_error_status))) res.fatal = true;
        }
        if (typeof ev.result === 'string' && ev.result) {
          final = ev.result;
          if (!texts.includes(ev.result)) texts.push(ev.result);
        }
      }
      return rl ? { event: ev, rateLimit: rl } : { event: ev };
    },
    // a shell command prints nothing on stdout until it ends: give the longest pending call its timeout (and a minute) before a stall
    waitMs: () => (pending.size ? Math.max(...pending.values()) + 60_000 : 0),
    finish(res, code, stderr) {
      res.text = texts.join('\n');
      res.final = final;
      if (!gotResult) {
        res.ok = false;
        res.error = res.stalled ? `stalled: no output for ${o.stallMs! / 60000} min`
          : res.timedOut ? `turn timed out after ${Math.round(o.timeoutMs / 60000)} min`
          : `claude exited ${code} with no result: ${stderr.trim().slice(-500)}`;
      }
      if (rejectedLimit || (!res.ok && LIMIT_TEXT.test(`${res.error ?? ''}\n${stderr}`))) res.limited = rejectedLimit ?? {};
    },
  };
}

export const claude: AgentCli = {
  name: 'claude',
  bin: (config) => process.env.HX_CLAUDE_BIN || config.claudeBin, // HX_CLAUDE_BIN: the tests' fake before .hx/config.json exists
  args: (o) => ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []), ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]), ...o.extraArgs],
  env: (o, parent) => shellEnv(o.timeoutMs, parent),
  turn: claudeTurn,
  // an interactive session the user talks to: none of the worker flags (-p, stream-json, bypassPermissions, the lean set)
  interactiveArgs: (model, effort, prompt) => ['--model', model, ...(effort ? ['--effort', effort] : []), prompt],
};
