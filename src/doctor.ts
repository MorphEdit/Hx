// hx doctor: the prerequisite checks (node, git, gh, the agent CLI, the repo's GitHub origin and .hx/), each with a
// one-line fix for this OS. The check functions are pure (command results and platform in, a Check out);
// doctor() gathers the results so hx run and hx start can reuse it.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS, effectiveRtddBin, labelSpecs, STATE_DIR, type Config, type Labels } from './config.ts';
import { agentFor } from './agents/index.ts';
import { hideWindow, inProcess, resolveCmd } from './exec.ts';
import { autoStartText, serviceId, taskName, taskState, type TaskState } from './service.ts';
import { nodeOk } from '../bin/node-check.mjs';

export type Mark = '✓' | '✗' | '–' | '?';
export interface Check { mark: Mark; label: string; detail?: string; fix?: string; required: boolean }

/** A command's result as doctor sees it: spawnFailed = the binary could not be started (not installed). */
export interface Probe { code: number; stdout: string; stderr: string; spawnFailed?: boolean; timedOut?: boolean }

export type Platform = NodeJS.Platform | string;

/** Node ≥ 23.6 (type stripping): the same rule bin/hx.mjs applies before loading any .ts. */
export { nodeOk };

const INSTALL: Record<'node' | 'git' | 'gh' | 'claude', { win32: string; darwin: string; linux: string }> = {
  node: { win32: 'winget install --id OpenJS.NodeJS', darwin: 'brew install node', linux: 'install Node ≥ 23.6: https://nodejs.org/en/download' },
  git: { win32: 'winget install --id Git.Git', darwin: 'brew install git gh', linux: 'install git: https://git-scm.com/downloads/linux' },
  gh: { win32: 'winget install --id GitHub.cli', darwin: 'brew install git gh', linux: 'install gh: https://github.com/cli/cli#installation' },
  claude: { win32: 'irm https://claude.ai/install.ps1 | iex   (PowerShell)', darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
    linux: 'install Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup' },
};

/** The install command (or link) for a tool on this OS; an OS hx does not know gets the linux text. */
export function installFix(tool: keyof typeof INSTALL, platform: Platform): string {
  const t = INSTALL[tool];
  return platform === 'win32' ? t.win32 : platform === 'darwin' ? t.darwin : t.linux;
}

const firstLine = (p: Probe) => (p.stdout || p.stderr).trim().split(/\r?\n/)[0]?.slice(0, 200) ?? '';

export function checkNode(version: string, platform: Platform): Check {
  const label = 'node ≥ 23.6';
  return nodeOk(version) ? { mark: '✓', label, detail: version, required: true }
    : { mark: '✗', label, detail: `${version} is too old`, fix: installFix('node', platform), required: true };
}

export function checkGit(p: Probe, platform: Platform): Check {
  const label = 'git';
  if (p.spawnFailed) return { mark: '✗', label, detail: 'not installed', fix: installFix('git', platform), required: true };
  if (p.timedOut) return { mark: '?', label, detail: 'git --version did not answer', fix: 'run  git --version  and check your git install', required: true };
  if (p.code !== 0) return { mark: '✗', label, detail: `git --version failed: ${firstLine(p)}`, fix: installFix('git', platform), required: true };
  return { mark: '✓', label, detail: p.stdout.trim().replace(/^git version\s*/i, ''), required: true };
}

const LOGGED_OUT = /not logged in|gh auth login|token .*(is )?invalid|authentication failed/i;

/** gh present and logged in, from the one call `gh auth status`. */
export function checkGh(p: Probe, platform: Platform): Check {
  const label = 'gh logged in';
  if (p.spawnFailed) return { mark: '✗', label, detail: 'gh is not installed', fix: installFix('gh', platform), required: true };
  const out = `${p.stdout}\n${p.stderr}`;
  if (p.code === 0 && !p.timedOut) {
    const account = /account\s+(\S+)/i.exec(out)?.[1] ?? /Logged in to \S+ as\s+(\S+)/i.exec(out)?.[1];
    return { mark: '✓', label, detail: account ? `as ${account}` : undefined, required: true };
  }
  if (!p.timedOut && LOGGED_OUT.test(out)) return { mark: '✗', label, detail: 'not logged in', fix: 'gh auth login', required: true };
  return { mark: '?', label, detail: `could not tell (offline?): ${p.timedOut ? 'gh auth status timed out' : firstLine(p)}`,
    fix: 'check the network, then run  gh auth status', required: true };
}

/** The agent CLI answers --version; whether it is logged in is the note checkAgentLogin gives. */
export function checkAgent(p: Probe, bin: string, platform: Platform): Check {
  const label = `agent CLI (${bin})`;
  if (p.spawnFailed) return { mark: '✗', label, detail: 'not installed', fix: installFix('claude', platform), required: true };
  if (p.timedOut) return { mark: '?', label, detail: `${bin} --version did not answer`, fix: `run  ${bin} --version  and check its install`, required: true };
  if (p.code !== 0) return { mark: '✗', label, detail: `--version failed: ${firstLine(p)}`, fix: installFix('claude', platform), required: true };
  return { mark: '✓', label, detail: firstLine(p), required: true };
}

export function checkAgentLogin(): Check {
  return { mark: '–', label: 'agent CLI login', detail: 'not checked', fix: 'if not logged in yet: run `claude`, then `/login`', required: false };
}

const REPO_NOT_FOUND = /no git remotes|none of the git remotes|not a git repository|could not resolve to a repository|not found/i;

/** The repo's GitHub origin, from `gh repo view --json nameWithOwner` (the call hx init uses). */
export function checkOrigin(p: Probe): Check {
  const label = 'GitHub origin';
  const slug = p.stdout.trim();
  if (p.code === 0 && !p.timedOut && slug) return { mark: '✓', label, detail: slug, required: true };
  if (!p.timedOut && !p.spawnFailed && REPO_NOT_FOUND.test(`${p.stdout}\n${p.stderr}`))
    return { mark: '✗', label, detail: 'no GitHub remote', fix: 'git remote add origin https://github.com/<owner>/<repo>.git', required: true };
  return { mark: '?', label, detail: `could not tell (offline?): ${p.timedOut ? 'gh repo view timed out' : firstLine(p)}`,
    fix: 'check the network, then run  gh repo view', required: true };
}

export function checkConfig(exists: boolean, configOptional = false): Check {
  const label = '.hx/config.json';
  if (exists) return { mark: '✓', label, required: true };
  return configOptional ? { mark: '–', label, detail: 'missing', fix: '`hx start` runs `hx init` next', required: false }
    : { mark: '✗', label, detail: 'missing', fix: 'hx init', required: true };
}

/** The board labels: `missing` = the label names GitHub does not have, or null when the lookup failed. */
export function checkLabels(missing: string[] | null): Check {
  const label = 'board labels';
  if (missing === null) return { mark: '?', label, detail: 'could not list the labels (offline?)', fix: 'check the network, then run  gh label list', required: false };
  if (!missing.length) return { mark: '✓', label, required: false };
  return { mark: '–', label, detail: `missing: ${missing.join(', ')}`, fix: '`hx run` creates it', required: false };
}

/** The base branch hx builds from (origin/<it>): empty when hx init ran on a GitHub repo with no commits yet (#442). */
export function checkDefaultBranch(defaultBranch: string | undefined): Check {
  const label = 'defaultBranch';
  const b = (defaultBranch ?? '').trim();
  return b ? { mark: '✓', label, detail: b, required: true }
    : { mark: '✗', label, detail: 'empty', fix: 'set "defaultBranch": "main" in .hx/config.json (or push a first commit and run hx init again)', required: true };
}

export function checkGate(gateCommand: string): Check {
  const label = 'gate command';
  return gateCommand.trim() ? { mark: '✓', label, detail: gateCommand, required: false }
    : { mark: '–', label, detail: 'not set', fix: 'learned from the first audited merge (or set gateCommand in .hx/config.json)', required: false };
}

/** rtdd is optional: shown as a note whether installed or not, never a failure. */
export function checkRtdd(installed: boolean): Check {
  return { mark: '–', label: 'rtdd (optional)', detail: installed ? 'installed' : 'not installed',
    fix: installed ? 'picks the tests a change needs: hx init --rtdd, then roleSkills rtdd'
      : 'adds test selection per change (roleSkills rtdd): https://github.com/VocanicZ/rtdd', required: false };
}

/** The `eol` rule .gitattributes must hold for hx's worktrees and diffs to stay LF. */
export const GITATTRIBUTES_LF = '* text=auto eol=lf';

/** True when a .gitattributes text has an uncommented line that sets `eol` (`eol=lf`, `eol=crlf`). */
export const hasEolRule = (text: string): boolean => text.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /\seol=\S/.test(` ${l}`));

/** Line endings, informational: `attributes` = the repo's .gitattributes (null = none), `autocrlf` = its core.autocrlf. */
export function checkEol(attributes: string | null, autocrlf: string): Check {
  const label = 'line endings';
  const issues: string[] = [], fixes: string[] = [];
  if (attributes === null || !hasEolRule(attributes)) {
    issues.push(attributes === null ? 'no .gitattributes' : 'no eol rule in .gitattributes');
    fixes.push(`add  ${GITATTRIBUTES_LF}  to .gitattributes (hx init offers it), then  git add --renormalize .  and commit`);
  }
  if (autocrlf.trim().toLowerCase() === 'true') {
    issues.push('core.autocrlf is true');
    fixes.push('git config core.autocrlf false   (this repo only; hx worktrees set it themselves)');
  }
  return issues.length ? { mark: '–', label, detail: issues.join(', '), fix: fixes.join('; '), required: false }
    : { mark: '✓', label, detail: 'LF', required: false };
}

/** autoStart: a note, never a failure. `task` = this repo's logon task (Windows), undefined off Windows. */
export function checkAutoStart(enabled: boolean, task: TaskState | undefined): Check {
  const detail = autoStartText(enabled, task ?? 'unit');
  return { mark: enabled && task === 'registered' ? '✓' : '–', label: 'autoStart', detail,
    fix: enabled ? 'hx run registers the task at its start' : 'set autoStart true in .hx/config.json to start hx at logon', required: false };
}

export function checkNoRepo(): Check {
  return { mark: '–', label: 'repo checks', detail: 'skipped: not inside a git repo', fix: 'run hx doctor in your repo', required: false };
}

/** 1 iff a required check is ✗; – and ? never give 1. */
export function exitCode(checks: Check[]): number {
  return checks.some((c) => c.required && c.mark === '✗') ? 1 : 0;
}

export function render(checks: Check[]): string {
  return checks.map((c) => `${c.mark} ${c.label}${c.detail ? ` — ${c.detail}` : ''}${c.mark !== '✓' && c.fix ? `\n    fix: ${c.fix}` : ''}`).join('\n');
}

export interface DoctorOptions {
  cwd?: string;
  platform?: Platform;
  configOptional?: boolean; // hx start: a missing .hx/config.json is a note (hx start runs hx init next)
  skipLabels?: boolean; // hx run: it creates the labels itself
  skipRtdd?: boolean; // the health pass: rtdd is optional (never ✗), and hx run checks it once per run itself
  skipAutoStart?: boolean; // hx run and the health pass: hx run checks the logon task itself at its start
  timeoutMs?: number;
}

/** Run a binary the way exec.ts does (a .mjs fake under node, no shell, the tests' fake gh in-process), telling a spawn
 *  failure from a failure. */
export async function probe(cmd: string, args: string[], cwd?: string, timeoutMs = 15_000): Promise<Probe> {
  if (/\.m?js$/i.test(cmd) && !existsSync(cmd)) return { code: 1, stdout: '', stderr: `${cmd}: not found`, spawnFailed: true };
  const fake = await inProcess(cmd, args, { cwd });
  if (fake) return fake;
  return new Promise((resolve) => {
    execFile(...resolveCmd(cmd, args), { cwd, timeout: timeoutMs, windowsHide: hideWindow(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err: any, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        if (typeof err.code === 'string' && /ENOENT|EACCES|EINVAL/.test(err.code)) return resolve({ code: 1, stdout: '', stderr: String(err.message), spawnFailed: true });
        resolve({ code: typeof err.code === 'number' ? err.code : 1, stdout: stdout ?? '', stderr: stderr || String(err.message), timedOut: !!err.killed });
      });
  });
}

function readConfig(root: string): Partial<Config> | null {
  const file = path.join(root, STATE_DIR, 'config.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

/** Gather every check's result: what hx doctor prints, and what hx run / hx start gate on. */
export async function doctor(opts: DoctorOptions = {}): Promise<{ checks: Check[]; code: number }> {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? process.cwd();
  const t = opts.timeoutMs;
  const GIT = process.env.HX_GIT_BIN || 'git', GH = process.env.HX_GH_BIN || 'gh';

  const top = await probe(GIT, ['rev-parse', '--show-toplevel'], cwd, t);
  const root = top.code === 0 && !top.spawnFailed ? top.stdout.trim() : null;
  const raw = root ? readConfig(root) : null;
  const config: Config = { ...DEFAULTS, ...(raw ?? {}), labels: { ...DEFAULTS.labels, ...(raw?.labels ?? {}) } } as Config;
  const bin = agentFor(config.agentCli).bin(config);

  const [git, auth, agent, rtdd] = await Promise.all([
    probe(GIT, ['--version'], cwd, t), probe(GH, ['auth', 'status'], cwd, t), probe(bin, ['--version'], cwd, t),
    opts.skipRtdd ? null : probe(effectiveRtddBin(config), ['--version'], cwd, t),
  ]);
  const checks: Check[] = [
    checkNode(process.env.HX_NODE_VERSION || process.versions.node, platform),
    checkGit(git, platform), checkGh(auth, platform), checkAgent(agent, bin, platform), checkAgentLogin(),
  ];
  if (!root) checks.push(checkNoRepo());
  else {
    const origin = await probe(GH, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root, t);
    const originCheck = checkOrigin(origin);
    checks.push(originCheck, checkConfig(raw !== null, opts.configOptional));
    if (!opts.skipLabels && originCheck.mark === '✓') checks.push(checkLabels(await missingLabels(GH, originCheck.detail!, config.labels, root, t)));
    if (raw !== null) checks.push(checkDefaultBranch(config.defaultBranch), checkGate(config.gateCommand ?? ''));
    if (raw !== null && !opts.skipAutoStart) {
      const enabled = config.autoStart === true;
      const task = platform !== 'win32' ? undefined : enabled ? await taskState(taskName(serviceId(config.repo ?? '', root)), root) : 'missing';
      checks.push(checkAutoStart(enabled, task));
    }
    const attrs = path.join(root, '.gitattributes');
    const autocrlf = await probe(GIT, ['config', '--get', 'core.autocrlf'], root, t);
    checks.push(checkEol(existsSync(attrs) ? readFileSync(attrs, 'utf8') : null, autocrlf.code === 0 ? autocrlf.stdout : ''));
  }
  if (rtdd) checks.push(checkRtdd(!rtdd.spawnFailed && rtdd.code === 0));
  return { checks, code: exitCode(checks) };
}

async function missingLabels(gh: string, repo: string, labels: Labels, cwd: string, t?: number): Promise<string[] | null> {
  const r = await probe(gh, ['label', 'list', '-R', repo, '--limit', '1000', '--json', 'name', '-q', '.[].name'], cwd, t);
  if (r.code !== 0) return null;
  const have = new Set(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return labelSpecs(labels).map((l) => l.name).filter((n) => !have.has(n));
}
