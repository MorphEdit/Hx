// The agent-CLI seam: everything hx knows about one headless coding CLI (argv, output parsing, limits).
import type { Config } from '../config.ts';
import type { RateLimit, TurnOptions, TurnResult } from '../agent.ts';

export interface AgentCli {
  name: string; // 'claude'
  bin(config: Config): string; // the binary to spawn; claude: config.claudeBin
  args(o: TurnOptions): string[]; // argv for one headless turn
  turn(o: TurnOptions): AgentTurn; // fresh parser state for one turn
  interactiveArgs(model: string, effort: string | undefined, prompt: string): string[]; // for hx grill / hx issue
}

export interface AgentTurn {
  /** One stdout line: fill `res`; an `event` goes to the per-issue log, a `rateLimit` to the pool. */
  line(line: string, res: TurnResult): { event?: unknown; rateLimit?: RateLimit } | void;
  /** The process closed. runTurn has set durationMs, timedOut and stalled. */
  finish(res: TurnResult, code: number | null, stderr: string): void;
}
