import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestConcurrency } from './concurrency.ts';

export interface Labels {
  ready: string;
  working: string;
  blocked: string;
  prd: string;
  reviewed: string;
  hardened: string; // the gauntlet is done with a PRD: it may be decomposed
  secured: string; // the security pass found nothing in a reviewed PRD's merged work: it may close
  security: string; // an issue the security pass filed
  barPassed: string; // the PRD's quality bar is settled (won, conceded or capped): it may close
  gateFix: string;
  bug: string; // a bug report: triaged (reproduced) before it is built, and built before other work
  triaged: string; // a triage session reproduced the bug
  needsHuman: string; // waiting on the owner's answer: never claimed, even with `ready`
}

export interface LabelSpec { name: string; color: string; description: string }

/** Every label hx may add, with the colour and description `hx init` and `hx run` create it with. */
export function labelSpecs(L: Labels): LabelSpec[] {
  return [
    { name: L.ready, color: '0e8a16', description: 'hx: an agent may pick this up' },
    { name: L.working, color: 'fbca04', description: 'hx: an agent is working on this' },
    { name: L.blocked, color: 'd93f0b', description: 'hx: needs a human' },
    { name: L.prd, color: '5319e7', description: 'hx: a PRD, decomposed into child issues' },
    { name: L.reviewed, color: '1d76db', description: 'hx: PRD reviewed and signed off' },
    { name: L.hardened, color: 'c5def5', description: 'hx: PRD passed the gauntlet (critique and revision) and may be decomposed' },
    { name: L.secured, color: '0052cc', description: "hx: the security pass found nothing in the PRD's merged work" },
    { name: L.barPassed, color: '0e8a16', description: "hx: the PRD's quality bar is settled: it may close" },
    { name: L.security, color: 'e99695', description: 'hx: a security issue filed by the security pass' },
    { name: L.gateFix, color: 'b60205', description: 'hx: fixes a red default branch (the only work claimed while it is red)' },
    { name: L.bug, color: 'd73a4a', description: 'hx: a bug, triaged (reproduced) before it is built, then built first' },
    { name: L.triaged, color: 'f9d0c4', description: 'hx: a triage session reproduced the bug: it may be built' },
    { name: L.needsHuman, color: 'ff9f1c', description: "hx: waiting on the owner's answer" },
  ];
}

export interface Config {
  repo: string; // owner/name
  defaultBranch: string;
  workers: number; // the most sessions at once (with autoWorkers: the ceiling)
  minWorkers: number; // the floor: claims always go up to this many sessions (unless a pause, red gate, usage hold, GitHub budget or fleet slot holds them)
  autoWorkers: boolean; // workers is a ceiling and the session count follows machine load; false = a fixed count
  loadHighPct: number; // CPU busy % at or above which the target steps down
  loadLowPct: number; // CPU busy % at or below which (with enough free memory) the target may step back up
  minFreeMemGB: number; // free memory below this (GB) counts as high load; 0 = no memory check
  scaleUpMinutes: number; // minutes of low load before one step up
  model: string;
  effort: string; // claude --effort: low | medium | high | xhigh | max ('' = the CLI's default)
  maxIterations: number; // Ralph-loop turns per issue before giving up
  maxOpenQuestions: number; // open needs-human issues at once (the owner's questions)
  sizeCheck: boolean; // a single issue (no parent, not a bug or gate fix) is sized by one session before its first impl session, and split when too big
  gauntlet: boolean; // critique and revise a PRD in rounds before it is decomposed
  gauntletRounds: number; // critic → reviser rounds before the PRD is decomposed anyway
  reviewRounds: number; // PRD reviews (each may file gap issues) before a human has to look
  barRounds: number; // quality-bar rounds (each lost one files a gap issue) before the PRD is signed off with the gap standing
  security: boolean; // a security pass checks a reviewed PRD's merged work before the PRD closes
  securityRounds: number; // security passes (each may file security issues) before a human has to look
  bugTriage: boolean; // a bug issue is triaged (reproduced) before it may be claimed
  triageRounds: number; // triage sessions on a bug before a human has to look
  audit: boolean; // an independent auditor session checks every implementation PR before hx merges it
  auditRounds: number; // implement → audit attempts before the issue goes to a human
  mergeRounds: number; // merge-fix rounds after an audit PASS (a rebase conflict, tests failing after the rebase) before the issue goes to a human
  gate: boolean; // test the default branch after every merge; while red, claim only the fix
  gateCommand: string; // the gate's test command ('' = learned from the first audited merge)
  reuseTestedTrees: boolean; // hx sets HX_TESTED_TREES (.hx/tested-trees.jsonl) for sessions and its ship --resume, and the gate records its runs there: a tree that already passed is not tested again (the gate: while green, within 2 h)
  testConcurrency: TestConcurrency; // HX_TEST_CONCURRENCY for every session, gate run and ship --resume: "auto" = max(1, floor((cpus - 1) / n)), N = N, 0 = not set
  testPatterns: string[]; // regexes (case-insensitive) that mark a worker's shell command as a test run, on top of the defaults in src/timing.ts
  gateMinutes: number; // the gate's test run is killed (with its tree) after this long and counts as red
  autoRelease: boolean; // hx run releases by itself: minor when a PRD closed since the last tag, patch for fixes
  autoReleasePatchHours: number; // a patch release is due once the last tag is older than this and a fix merged since
  usagePauseAt: number; // 0..1: claim nothing new once a usage window is this full, until it resets
  budgetGate: boolean; // before claiming a session, skip it when its forecast would take a calibrated usage window past usagePauseAt
  ghReservePct: number; // 0..1: claim nothing new while the GitHub API core or graphql budget has less than this share left (0 = off)
  budgetMinPairs: number; // usable reading pairs a usage window needs before its dollars-per-1% rate is trusted (calibrated)
  checkpointMinutes: number; // time a stopped session gets to commit, push and write its handoff
  turnTimeoutMinutes: number;
  stallMinutes: number; // a turn with no stdout for this long is killed (0 = off)
  pollSeconds: number;
  selfHeal: boolean; // hx run runs a health pass every healthEveryMinutes and applies its repairs (hx health --fix always repairs)
  healthEveryMinutes: number; // minutes between hx run's health passes
  selfReviewEveryHours: number; // hours between self-review sessions (a health pass in hx run on an idle board, selfHeal on)
  selfReviewMaxFindings: number; // findings of a self-review filed as bug issues; the rest are dropped
  selfUpdate: boolean; // hx run --watch updates its own hx install when idle and restarts itself (rolled back if the new code does not start)
  selfUpdateMinutes: number; // minutes between self-update checks
  autoStart: boolean; // hx run keeps this repo's logon task (hx service install) in step: registered when true, removed when false
  selfUpdateWatchMinutes: number; // minutes the new runner is watched after a self-update: a crash, failing sessions or a red gate at its sha roll it back
  selfUpdateFailLimit: number; // sessions in a row ending with an agent or hx error that roll a watched self-update back
  worktreeRoot: string; // keep it short: Windows MAX_PATH
  agentCli: string; // the agent CLI workers and hx grill / hx issue run (src/agents): claude
  claudeBin: string; // the claude adapter's binary
  claudeArgs: string[]; // extra flags appended to every claude call
  // Lean workers: no MCP servers, skills, slash commands or user-level settings/plugins, and only these
  // built-in tools. A worker's base context drops from ~44K to ~8K tokens per call (measured).
  leanWorkers: boolean;
  workerTools: string[];
  trustedAuthors: string[]; // accounts besides the gh login whose issues and PRDs hx works on
  // role (impl, audit, decompose, review, critic, revise, security, triage, selfreview) → skills appended to its prompt; {} = none
  roleSkills: Record<string, string[]>;
  // role → its own model and/or effort (unset = the top-level model / effort); {} = every role on the defaults
  roleModels: Record<string, { model?: string; effort?: string }>;
  skillMaxChars: number; // a skill whose stripped SKILL.md body is longer is skipped
  rtddBin: string; // HX_RTDD_BIN overrides it (see effectiveRtddBin)
  worktreeSetup: string; // a shell command run in each new worktree, e.g. `npm ci` ('' = none)
  worktreeSetupMinutes: number; // the setup command is killed (with its tree) after this long
  worktreeCopy: string[]; // untracked paths (relative to the repo root) copied from the checkout into each new worktree
  labels: Labels;
}

export const DEFAULTS: Omit<Config, 'repo' | 'defaultBranch' | 'worktreeRoot'> = {
  workers: 2,
  minWorkers: 1,
  autoWorkers: true,
  loadHighPct: 85,
  loadLowPct: 60,
  minFreeMemGB: 2,
  scaleUpMinutes: 5,
  model: 'claude-opus-5-5', // a full id: the `opus` alias may resolve to an older Opus
  effort: 'medium',
  maxIterations: 8,
  maxOpenQuestions: 3,
  sizeCheck: true,
  gauntlet: true,
  gauntletRounds: 2,
  reviewRounds: 3,
  barRounds: 3,
  security: true,
  securityRounds: 2,
  bugTriage: true,
  triageRounds: 2,
  audit: true,
  auditRounds: 3,
  mergeRounds: 3,
  gate: true,
  gateCommand: '',
  gateMinutes: 45,
  testConcurrency: 'auto',
  reuseTestedTrees: true,
  testPatterns: [],
  autoRelease: false,
  autoReleasePatchHours: 24,
  usagePauseAt: 0.9,
  budgetGate: true,
  ghReservePct: 0.2,
  budgetMinPairs: 5,
  checkpointMinutes: 10,
  turnTimeoutMinutes: 60, // above ship's 45-min test timeout + 5: the worker's shell may wait on it
  stallMinutes: 15,
  pollSeconds: 60,
  selfHeal: true,
  healthEveryMinutes: 60,
  selfReviewEveryHours: 12,
  selfReviewMaxFindings: 5,
  selfUpdate: false,
  selfUpdateMinutes: 15,
  autoStart: false,
  selfUpdateWatchMinutes: 30,
  selfUpdateFailLimit: 3,
  agentCli: 'claude',
  claudeBin: 'claude',
  claudeArgs: [],
  leanWorkers: true,
  workerTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
  trustedAuthors: [],
  roleSkills: { impl: ['rtdd'], audit: ['rtdd'] },
  roleModels: {},
  skillMaxChars: 12000,
  rtddBin: 'rtdd',
  worktreeSetup: '',
  worktreeSetupMinutes: 10,
  worktreeCopy: [],
  labels: { ready: 'ready-for-agent', working: 'agent-working', blocked: 'agent-blocked', prd: 'prd', reviewed: 'prd-reviewed', hardened: 'prd-hardened', secured: 'security-reviewed', security: 'security', barPassed: 'quality-bar-passed', gateFix: 'hx-gate-fix', bug: 'bug', triaged: 'bug-triaged', needsHuman: 'needs-human' },
};

/** The roles a session runs as: the keys roleModels accepts. */
export const ROLES = ['impl', 'audit', 'triage', 'decompose', 'critic', 'revise', 'review', 'security', 'selfreview', 'bar'] as const;
/** A role's effort when its roleModels entry sets none (else the top-level effort). */
const ROLE_EFFORT: Record<string, string> = { bar: 'high' };
/** claude --effort values a role may set (the top-level effort is not checked). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface RoleModel { model: string; effort: string }

/** The model and effort a role's sessions run with: its roleModels entry, else the top-level model / effort
 *  (bar: effort high). */
export function roleModel(c: Pick<Config, 'model' | 'effort' | 'roleModels'>, role: string): RoleModel {
  const r = c.roleModels?.[role];
  return { model: r?.model ?? c.model, effort: r?.effort ?? ROLE_EFFORT[role] ?? c.effort };
}

/** Did a turn that asked for `asked` run on it? Same id, a dated id of it (`<asked>-20261001`), or a bare alias's family. */
export function modelMatches(asked: string, actual: string): boolean {
  if (actual === asked || actual.startsWith(`${asked}-`)) return true;
  return ['opus', 'sonnet', 'haiku'].includes(asked) && actual.includes(asked);
}

/** Every known role → its resolved model and effort. */
export function roleModelMap(c: Pick<Config, 'model' | 'effort' | 'roleModels'>): Record<string, RoleModel> {
  return Object.fromEntries(ROLES.map((r) => [r, roleModel(c, r)]));
}

/** `impl claude-sonnet-5-5/medium, audit …` for the roles whose model or effort differs from the role's defaults; '' when none do. */
export function formatRoleModels(map: Record<string, RoleModel>, def: { model: string; effort: string }): string {
  return Object.entries(map).filter(([r, m]) => { const d = roleModel({ ...def, roleModels: {} }, r); return m.model !== d.model || m.effort !== d.effort; })
    .map(([r, m]) => `${r} ${m.model}/${m.effort}`).join(', ');
}

/** What is wrong with config.roleModels, or null when it is valid. */
export function roleModelsError(roleModels: unknown): string | null {
  if (roleModels === undefined) return null;
  if (typeof roleModels !== 'object' || roleModels === null || Array.isArray(roleModels)) return 'roleModels: must be an object of role → { model, effort }';
  for (const [role, v] of Object.entries(roleModels as Record<string, unknown>)) {
    if (!(ROLES as readonly string[]).includes(role)) return `roleModels: unknown role "${role}" — known: ${ROLES.join(', ')}`;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return `roleModels.${role}: must be an object like { "model": "...", "effort": "high" }`;
    const { model, effort } = v as { model?: unknown; effort?: unknown };
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) return `roleModels.${role}.model: must be a non-empty string (omit it to use the top-level model)`;
    if (effort !== undefined && !(EFFORTS as readonly unknown[]).includes(effort))
      return `roleModels.${role}.effort: ${JSON.stringify(effort)} is not one of ${EFFORTS.join(', ')} (omit it to use the top-level effort)`;
  }
  return null;
}

/** What is wrong with config.ghReservePct (a share 0..1), or null when it is valid. */
export function ghReservePctError(pct: unknown): string | null {
  if (pct === undefined) return null;
  if (typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 1) return null;
  return `ghReservePct: ${JSON.stringify(pct)} must be a number from 0 to 1 (0 turns the GitHub budget reserve off)`;
}

/** What is wrong with config.selfHeal, healthEveryMinutes, selfReviewEveryHours or selfReviewMaxFindings, or null when all are valid. */
export function healthConfigError(c: { selfHeal?: unknown; healthEveryMinutes?: unknown; selfReviewEveryHours?: unknown; selfReviewMaxFindings?: unknown }): string | null {
  if (c.selfHeal !== undefined && typeof c.selfHeal !== 'boolean') return `selfHeal: ${JSON.stringify(c.selfHeal)} must be true or false`;
  const m = c.healthEveryMinutes;
  if (m !== undefined && !(typeof m === 'number' && Number.isFinite(m) && m > 0)) return `healthEveryMinutes: ${JSON.stringify(m)} must be a number of minutes above 0`;
  const h = c.selfReviewEveryHours;
  if (h !== undefined && !(typeof h === 'number' && Number.isFinite(h) && h >= 0)) return `selfReviewEveryHours: ${JSON.stringify(h)} must be a number of hours, 0 or more`;
  const f = c.selfReviewMaxFindings;
  if (f !== undefined && !(typeof f === 'number' && Number.isInteger(f) && f >= 1)) return `selfReviewMaxFindings: ${JSON.stringify(f)} must be a whole number, 1 or more`;
  return null;
}

/** What is wrong with config.autoWorkers, minWorkers, loadHighPct, loadLowPct, minFreeMemGB or scaleUpMinutes, or null when all
 *  are valid. Checked whatever autoWorkers is; a key left unset is fine. */
export function autoWorkersConfigError(c: { workers?: unknown; autoWorkers?: unknown; minWorkers?: unknown; loadHighPct?: unknown; loadLowPct?: unknown; minFreeMemGB?: unknown; scaleUpMinutes?: unknown }): string | null {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (c.autoWorkers !== undefined && typeof c.autoWorkers !== 'boolean') return `autoWorkers: ${JSON.stringify(c.autoWorkers)} must be true or false`;
  const m = c.minWorkers;
  if (m !== undefined) {
    if (!(typeof m === 'number' && Number.isInteger(m) && m >= 1)) return `minWorkers: ${JSON.stringify(m)} must be a whole number, 1 or more`;
    if (num(c.workers) && m > c.workers) return `minWorkers: ${m} must not be above workers (${c.workers})`;
  }
  for (const k of ['loadHighPct', 'loadLowPct'] as const) {
    const v = c[k];
    if (v !== undefined && !(num(v) && v >= 0 && v <= 100)) return `${k}: ${JSON.stringify(v)} must be a number from 0 to 100`;
  }
  if (num(c.loadLowPct) && num(c.loadHighPct) && c.loadLowPct >= c.loadHighPct) return `loadLowPct: ${c.loadLowPct} must be below loadHighPct (${c.loadHighPct})`;
  const g = c.minFreeMemGB;
  if (g !== undefined && !(num(g) && g >= 0)) return `minFreeMemGB: ${JSON.stringify(g)} must be a number of GB, 0 or more (0 turns the memory check off)`;
  const u = c.scaleUpMinutes;
  if (u !== undefined && !(num(u) && u > 0)) return `scaleUpMinutes: ${JSON.stringify(u)} must be a number of minutes above 0`;
  return null;
}

/** What is wrong with config.worktreeCopy, or null when it is valid: plain relative paths inside the repo only. */
export function worktreeCopyError(worktreeCopy: unknown): string | null {
  if (worktreeCopy === undefined) return null;
  if (!Array.isArray(worktreeCopy) || worktreeCopy.some((e) => typeof e !== 'string')) return 'worktreeCopy: must be an array of paths relative to the repo root';
  for (const e of worktreeCopy as string[]) {
    const q = JSON.stringify(e);
    if (!e.trim()) return `worktreeCopy: ${q} must be a non-empty path`;
    if (path.posix.isAbsolute(e) || path.win32.isAbsolute(e) || /^[a-z]:/i.test(e)) return `worktreeCopy: ${q} must be a path relative to the repo root`;
    if (e.split(/[\\/]/).includes('..')) return `worktreeCopy: ${q} must be a path inside the repo (no "..")`;
    if (/[*?[\]{}]/.test(e)) return `worktreeCopy: ${q} must be a plain path (no glob characters)`;
  }
  return null;
}

/** What is wrong with config.testPatterns, or null when it is valid. */
export function testPatternsError(patterns: unknown): string | null {
  if (patterns === undefined) return null;
  if (!Array.isArray(patterns) || patterns.some((e) => typeof e !== 'string')) return 'testPatterns: must be an array of regular expressions (strings)';
  for (const e of patterns as string[]) {
    try { new RegExp(e, 'i'); } catch (err: any) { return `testPatterns: ${JSON.stringify(e)} is not a valid regular expression (${err.message})`; }
  }
  return null;
}

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

/** Writes config as given: a key left out (e.g. worktreeSetup not yet set) stays out of the file. */
export function saveConfig(stateDir: string, config: Partial<Config>): void {
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
