import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import { render } from './state.ts';
import { ISSUE_SCRIPT } from './pool.ts';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** Above this a prompt goes through a file: Windows caps a command line at ~32K, and argv quoting adds more. */
export const INLINE_PROMPT_MAX = 6000;

/**
 * argv for an interactive `claude` session the user talks to: model, effort, the prompt. Deliberately none of
 * the worker flags (-p, stream-json, bypassPermissions, the lean set) — the user's own settings and tools apply.
 */
export function grillArgs(config: Pick<Config, 'model' | 'effort'>, prompt: string): string[] {
  return ['--model', config.model, ...(config.effort ? ['--effort', config.effort] : []), prompt];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** <stateDir>/<dir>/<yyyymmdd-hhmmss>-<suffix>.md and its .prompt.md, stamped in local time. */
export function sessionPaths(stateDir: string, dir: string, suffix: string, now: Date = new Date()): { out: string; promptFile: string } {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const d = path.join(stateDir, dir);
  return { out: path.join(d, `${stamp}-${suffix}.md`), promptFile: path.join(d, `${stamp}-${suffix}.prompt.md`) };
}

/** <stateDir>/prds/<yyyymmdd-hhmmss>-grill.md and its .prompt.md, stamped in local time. */
export function grillPaths(stateDir: string, now: Date = new Date()): { prd: string; promptFile: string } {
  const p = sessionPaths(stateDir, 'prds', 'grill', now);
  return { prd: p.out, promptFile: p.promptFile };
}

/** <stateDir>/issues/<yyyymmdd-hhmmss>-issue.md and its .prompt.md, stamped in local time. */
export function issuePaths(stateDir: string, now: Date = new Date()): { out: string; promptFile: string } {
  return sessionPaths(stateDir, 'issues', 'issue', now);
}

export interface GrillVars {
  repo: string;
  base: string;
  idea: string;
  output: string; // where Claude writes the PRD (or the issue)
}

/** An interactive session's prompt (`grill` or `issue`): the rendered prompts/<name>.md inline, or — when too long — a pointer to it written to promptFile. */
export function sessionPrompt(name: 'grill' | 'issue', vars: GrillVars, promptFile: string): string {
  const text = render(readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8'),
    { REPO: vars.repo, BASE: vars.base, IDEA: vars.idea, OUTPUT: vars.output, ISSUE_SCRIPT });
  if (text.length <= INLINE_PROMPT_MAX) return text;
  mkdirSync(path.dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, text);
  return `Role: ${name}
Read ${promptFile} first and follow it: it holds your full instructions and the idea.`;
}

/** The grill session's prompt: see sessionPrompt. */
export function grillPrompt(vars: GrillVars, promptFile: string): string {
  return sessionPrompt('grill', vars, promptFile);
}

/** `hx grill [idea]`: a path to an existing file → its content; other text → the text; none → ''. */
export function ideaFrom(arg?: string): string {
  if (arg === undefined) return '';
  if (existsSync(arg) && statSync(arg).isFile()) return readFileSync(arg, 'utf8');
  return arg;
}
