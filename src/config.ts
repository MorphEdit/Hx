import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Labels {
  ready: string;
  working: string;
  blocked: string;
  prd: string;
  reviewed: string;
  hardened: string; // the gauntlet is done with a PRD: it may be decomposed
  secured: string; // the security pass found nothing in a reviewed PRD's merged work: it may close
  security: string; // an issue the security pass filed
  gateFix: string;
  bug: string; // a bug report: triaged (reproduced) before it is built, and built before other work
  triaged: string; // a triage session reproduced the bug
}

export interface Config {
  repo: string; // owner/name
  defaultBranch: string;
  workers: number;
  model: string;
  effort: string; // claude --effort: low | medium | high | xhigh | max ('' = the CLI's default)
  maxIterations: number; // Ralph-loop turns per issue before giving up
  gauntlet: boolean; // critique and revise a PRD in rounds before it is decomposed
  gauntletRounds: number; // critic → reviser rounds before the PRD is decomposed anyway
  reviewRounds: number; // PRD reviews (each may file gap issues) before a human has to look
  security: boolean; // a security pass checks a reviewed PRD's merged work before the PRD closes
  securityRounds: number; // security passes (each may file security issues) before a human has to look
  bugTriage: boolean; // a bug issue is triaged (reproduced) before it may be claimed
  triageRounds: number; // triage sessions on a bug before a human has to look
  audit: boolean; // an independent auditor session checks every implementation PR before hx merges it
  auditRounds: number; // implement → audit attempts before the issue goes to a human
  gate: boolean; // test the default branch after every merge; while red, claim only the fix
  gateCommand: string; // the gate's test command ('' = learned from the first audited merge)
  usagePauseAt: number; // 0..1: claim nothing new once a usage window is this full, until it resets
  checkpointMinutes: number; // time a stopped session gets to commit, push and write its handoff
  turnTimeoutMinutes: number;
  stallMinutes: number; // a turn with no stdout for this long is killed (0 = off)
  pollSeconds: number;
  worktreeRoot: string; // keep it short: Windows MAX_PATH
  claudeBin: string;
  claudeArgs: string[]; // extra flags appended to every claude call
  // Lean workers: no MCP servers, skills, slash commands or user-level settings/plugins, and only these
  // built-in tools. A worker's base context drops from ~44K to ~8K tokens per call (measured).
  leanWorkers: boolean;
  workerTools: string[];
  trustedAuthors: string[]; // accounts besides the gh login whose issues and PRDs hx works on
  // role (impl, audit, decompose, review, critic, revise, security, triage) → skills appended to its prompt; {} = none
  roleSkills: Record<string, string[]>;
  skillMaxChars: number; // a skill whose stripped SKILL.md body is longer is skipped
  rtddBin: string; // HX_RTDD_BIN overrides it (see effectiveRtddBin)
  labels: Labels;
}

export const DEFAULTS: Omit<Config, 'repo' | 'defaultBranch' | 'worktreeRoot'> = {
  workers: 2,
  model: 'claude-opus-5-5', // a full id: the `opus` alias may resolve to an older Opus
  effort: 'medium',
  maxIterations: 8,
  gauntlet: true,
  gauntletRounds: 2,
  reviewRounds: 3,
  security: true,
  securityRounds: 2,
  bugTriage: true,
  triageRounds: 2,
  audit: true,
  auditRounds: 3,
  gate: true,
  gateCommand: '',
  usagePauseAt: 0.9,
  checkpointMinutes: 10,
  turnTimeoutMinutes: 45,
  stallMinutes: 15,
  pollSeconds: 60,
  claudeBin: 'claude',
  claudeArgs: [],
  leanWorkers: true,
  workerTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
  trustedAuthors: [],
  roleSkills: { impl: ['rtdd'], audit: ['rtdd'] },
  skillMaxChars: 12000,
  rtddBin: 'rtdd',
  labels: { ready: 'ready-for-agent', working: 'agent-working', blocked: 'agent-blocked', prd: 'prd', reviewed: 'prd-reviewed', hardened: 'prd-hardened', secured: 'security-reviewed', security: 'security', gateFix: 'hx-gate-fix', bug: 'bug', triaged: 'bug-triaged' },
};

export interface Project {
  root: string; // the repo checkout hx was initialised in
  stateDir: string; // <root>/.hx
  config: Config;
}

export const STATE_DIR = '.hx';

/** Walk up from `from` for a .hx/config.json, like git finds .git. */
export function findProjectRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, STATE_DIR, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadProject(from: string = process.cwd()): Project {
  const root = findProjectRoot(from);
  if (!root) throw new Error("not inside an hx project (no .hx/config.json here or above). Run 'hx init' in the repo root.");
  const stateDir = path.join(root, STATE_DIR);
  // strip a BOM: Notepad and PowerShell 5 add one when saving UTF-8
  const raw = JSON.parse(readFileSync(path.join(stateDir, 'config.json'), 'utf8').replace(/^﻿/, ''));
  const config: Config = { ...DEFAULTS, ...raw, labels: { ...DEFAULTS.labels, ...(raw.labels ?? {}) } };
  return { root, stateDir, config };
}

export function saveConfig(stateDir: string, config: Config): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

/** The rtdd command hx runs: HX_RTDD_BIN when set and non-empty (like HX_GH_BIN for gh), else config.rtddBin. */
export function effectiveRtddBin(c: Pick<Config, 'rtddBin'>): string {
  return process.env.HX_RTDD_BIN || c.rtddBin;
}

/** Every flag a worker session gets on top of hx's own: the lean-worker set, then config.claudeArgs. */
export function workerArgs(c: Config): string[] {
  const lean = c.leanWorkers
    ? ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local',
       ...(c.workerTools.length ? ['--tools', ...c.workerTools] : [])]
    : [];
  return [...lean, ...c.claudeArgs];
}

/** <drive>:\hx-wt\<repo-name> — short enough that node_modules inside a worktree stays under MAX_PATH. */
export function defaultWorktreeRoot(projectRoot: string, repo: string): string {
  return path.join(path.parse(projectRoot).root, 'hx-wt', repo.split('/')[1] ?? repo);
}
