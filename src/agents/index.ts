// The agent-CLI registry: config.agentCli names one of these.
import { claude } from './claude.ts';
import type { AgentCli } from './types.ts';

export type { AgentCli, AgentTurn } from './types.ts';

const agents = new Map<string, AgentCli>();

export function registerAgent(a: AgentCli): void {
  agents.set(a.name, a);
}

export function agentFor(name: string): AgentCli {
  const a = agents.get(name);
  if (!a) throw new Error(`unknown agentCli "${name}" — known: ${[...agents.keys()].join(', ')}`);
  return a;
}

registerAgent(claude);
