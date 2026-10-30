import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Labels {
  ready: string;
  working: string;
  blocked: string;
  prd: string;
  reviewed: string;
}

export interface Config {
  repo: string; // owner/name
  defaultBranch: string;
  workers: number;
  model: string;
  effort: string; // claude --effort: low | medium | high | xhigh | max ('' = the CLI's default)
  maxIterations: number; // Ralph-loop turns per issue before giving up
  reviewRounds: number; // PRD reviews (each may file gap issues) before a human has to look
  usagePauseAt: number; // 0..1: claim nothing new once a usage window is this full, until it resets
  checkpointMinutes: number; // time a stopped session gets to commit, push and write its handoff
  turnTimeoutMinutes: number;
  pollSeconds: number;
  worktreeRoot: string; // keep it short: Windows MAX_PATH
  claudeBin: string;
  claudeArgs: string[]; // extra flags appended to every claude call
  labels: Labels;
}

export const DEFAULTS: Omit<Config, 'repo' | 'defaultBranch' | 'worktreeRoot'> = {
  workers: 2,
  model: 'claude-opus-5-5', // a full id: the `opus` alias may resolve to an older Opus
  effort: 'medium',
  maxIterations: 8,
  reviewRounds: 3,
  usagePauseAt: 0.9,
  checkpointMinutes: 10,
  turnTimeoutMinutes: 45,
  pollSeconds: 60,
  claudeBin: 'claude',
  claudeArgs: [],
  labels: { ready: 'ready-for-agent', working: 'agent-working', blocked: 'agent-blocked', prd: 'prd', reviewed: 'prd-reviewed' },
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

/** <drive>:\hx-wt\<repo-name> — short enough that node_modules inside a worktree stays under MAX_PATH. */
export function defaultWorktreeRoot(projectRoot: string, repo: string): string {
  return path.join(path.parse(projectRoot).root, 'hx-wt', repo.split('/')[1] ?? repo);
}
