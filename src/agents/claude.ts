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

function claudeTurn(o: TurnOptions): AgentTurn {
  const texts: string[] = [];
  let gotResult = false;
  let rejectedLimit: { resetsAt?: number } | undefined;
  return {
    line(line, res) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      const rl = rateLimitOf(ev);
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) if (c.type === 'text' && c.text) texts.push(c.text);
      } else if (rl?.status === 'rejected') {
        rejectedLimit = { resetsAt: rl.resetsAt };
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
      return rl ? { event: ev, rateLimit: rl } : { event: ev };
    },
    finish(res, code, stderr) {
      res.text = texts.join('\n');
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
  bin: (config) => config.claudeBin,
  args: (o) => ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--model', o.model, ...(o.effort ? ['--effort', o.effort] : []), ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]), ...o.extraArgs],
  turn: claudeTurn,
  // an interactive session the user talks to: none of the worker flags (-p, stream-json, bypassPermissions, the lean set)
  interactiveArgs: (model, effort, prompt) => ['--model', model, ...(effort ? ['--effort', effort] : []), prompt],
};
