import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, defaultWorktreeRoot, healthConfigError, effectiveRtddBin, findProjectRoot, formatRoleModels, labelSpecs, loadProject, saveConfig, STATE_DIR, type Config } from './config.ts';
import * as gh from './github.ts';
import { resolveCmd, run, runOk } from './exec.ts';
import { log, lookupTrusted, printPlan, readPlan, runPool, trustedEnv } from './pool.ts';
import { killAllSessions } from './agent.ts';
import { clearPause, nextLine, otherRunner, pidAlive, readLive, readPause, setPause, writeWake } from './runstate.ts';
import { fmtDuration, readGate, readGateRuns } from './gate.ts';
import { testSeries, timeWindow, type TimeSummary } from './timing.ts';
import { release, releaseGate, type BumpKind } from './release.ts';
import { budgetLine, readBudgetWindows } from './budget.ts';
import { githubLine } from './ghlimit.ts';
import { DEFAULT_PORT, serveDashboard, serveFleetDashboard } from './dashboard.ts';
import { fileBug, filePrd } from './prd.ts';
import { agentFor } from './agents/index.ts';
import { ideaFrom, sessionPaths, sessionPrompt } from './grill.ts';
import { formatSkills, installSkill } from './skills.ts';
import { doctor, render } from './doctor.ts';
import { healthPass, renderResult } from './health.ts';
import { addRepo, type Fleet, fleetDir, fleetFile, fleetWorkers, readFleet, readGithubHold, readHold, readRepos, registerRepo, removeRepo, sameRoot, slotsInUse, startFleetRun, writeFleet, writeRepos } from './fleet.ts';
import { change, compare, parseTime, SMALL_SAMPLE, type Period } from './compare.ts';
import { fmt, localDay, mismatchedSessions, readUsage, summarize, totalTokens, type UsageRow } from './usage.ts';

const HELP = `usage: hx <command> [options]

  start ["idea" | idea.md] [--workers N] [--yes]
                           everything to get going, in this repo: doctor, init (if .hx/config.json is
                           missing), grill the idea into a PRD (without one: skipped when the board has
                           an open PRD or ready issue, else it asks), the dry-run plan, then
                           hx run --watch (--yes: answer yes to every question)
  init [--rtdd]            set up hx in the current repo (.hx/config.json + GitHub labels); --rtdd also
                           runs rtdd init in the repo root (commit .rtdd/ yourself)
  prd <file.md> [--title T] file a PRD issue from a markdown file (title: --title or its first '# ' line)
  bug <file.md | "text"> [--title T]
                           file a bug issue (label bug); hx run triages it
  grill [<idea.md> | "idea"] [--yes]
                           an interactive claude session interviews you into a PRD; on confirm
                           (or --yes) it is filed like hx prd
  issue [<idea.md> | "idea"] [--bug] [--yes] [--title T]
                           a shorter interactive session grills one small task into one issue; on
                           confirm (or --yes) it is filed ready-for-agent (--bug: label bug only)
  issue --file <file.md> [--bug] [--title T]
                           file an existing issue file the same way, without a session
  run [options]            work the board until nothing is left, then exit
      --watch              keep running and pick up new / unblocked work; hx issue, prd, bug and
                           grill wake it within seconds (.hx/wake)
      --workers N          parallel sessions (default: config.workers)
      --issue N[,N...]     only these issues / PRDs
      --dry-run            show the board and what would run next, change nothing
  release [patch|minor|major] [--dry-run] [--yes]
                           tag the next version on a green default branch: bump package.json, push the
                           tag, write notes from the merged PRs and closed PRDs, create the GitHub release
                           (autoRelease: hx run releases by itself, minor per closed PRD, patch for fixes)
  status                   the runner, its live sessions, usage limits, and the board
  pause [--now]            stop claiming new work; running sessions finish (--now: they commit,
                           push and leave a handoff note, then stop). Works on a running hx run.
  resume                   clear a pause; then hx run continues where it stopped
  usage [--by issue|role|model|day]   token usage and test time recorded by hx
  usage --tests            per UTC day: median and p90 test-run and gate duration
  usage --compare <time> [--from <time>]
                           the runs before and after <time> (ISO or "YYYY-MM-DD HH:MM") side by side: per role
                           from usage.jsonl, audits, closed issues, stops and retries from hx's own GitHub
                           comments, each with its change (--from: drop older runs)
  dashboard [--port N] [--open]
                           a read-only page on http://127.0.0.1:${DEFAULT_PORT}/ (localhost only): the runner,
                           sessions, gate, usage by PRD/role/model/day, run log and the board (--open: browser)
  dashboard --fleet [--port N] [--open]
                           one page over every hx repo on this machine (~/.hx/fleet.json and repos.json),
                           each repo's own dashboard under /repo/<k>/; needs no repo of its own
  fleet add [<path>]       add the hx repo containing <path> (default: here) to the fleet (~/.hx/fleet.json)
  fleet remove <path>      remove that repo from the fleet (its .hx/ is untouched)
  fleet forget <path>      drop that repo from ~/.hx/repos.json (every repo hx init / hx run has seen)
  fleet list               the fleet's repos: root, repo and whether the root still exists
  fleet workers <n>        the fleet's worker cap (default 2), read by the next hx fleet run
  fleet status             hx status for every repo in the fleet, then the slots in use and the shared hold
  fleet dashboard [--port N] [--open]   the same as hx dashboard --fleet
  fleet run [--workers N] [--watch]
                           one hx run per fleet repo (output prefixed [owner/name]), sharing one worker
                           cap (--workers, else fleet workers); Ctrl+C asks every repo to checkpoint
  install-skill            write the /hx Claude Code skill to ~/.claude/skills/hx/SKILL.md (HX_SKILLS_HOME
                           instead of ~), replacing any copy there: ask Claude Code to build with hx
  doctor                   check the prerequisites (node, git, gh and its login, the agent CLI, the repo's
                           GitHub origin, .hx/config.json, labels, gate, rtdd), each with a fix for this OS;
                           exit 1 when a required one fails
  health [--fix]           one health pass: stale PRs from issue/<N> branches, leftover worktrees, stuck
                           agent-working labels, the environment (doctor checks, free disk); reports what it
                           would do (--fix: repairs, even with selfHeal off); exit 1 while a ✗ remains
  update [--force]         install the latest hx release (npm install -g github:MorphEdit/Hx#<tag>), check it runs,
                           run hx doctor; --force replaces an npm link of a checkout
  help
  --version                print hx's version (from its package.json)

Ctrl+C in hx run = pause --now for that run; Ctrl+C again force-quits (sessions are killed).

A PRD (label prd) goes gauntlet -> decompose -> building -> review -> security -> done. The gauntlet
(gauntlet, gauntletRounds) has a critic critique the PRD and a reviser rewrite it in rounds, then labels
it prd-hardened; it is decomposed into child issues and each child is implemented; the review may file
gap issues (prd-reviewed on sign-off); the security pass (security, securityRounds) checks the merged
work and may file security issues (security-reviewed when clean); then the PRD is closed.

An issue is picked up when it is open, labelled
ready-for-agent, not agent-working / agent-blocked, and every issue under its "## Blocked by"
heading is closed (a child also waits for its PRD's own "## Blocked by"). Only issues and PRDs opened
by a trusted account (the gh login plus trustedAuthors) are worked on; the rest show as untrusted.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

// hx's own version: the package.json next to src/, wherever hx is installed.
export function hxVersion(): string {
  return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'start': return start(args);
    case 'init': return init(args);
    case 'prd': return prd(args);
    case 'bug': return bug(args);
    case 'grill': return grill(args);
    case 'issue': return issue(args);
    case 'run': return runCmd(args);
    case 'release': return releaseCmd(args);
    case 'status': return status();
    case 'pause': return pause(args);
    case 'resume': return resume();
    case 'usage': return usage(args);
    case 'dashboard': return dashboard(args);
    case 'doctor': return doctorCmd();
    case 'health': return healthCmd(args);
    case 'update': return (await import('../bin/install.mjs')).install(args, { update: true });
    case 'fleet': return args[0] === 'dashboard' ? fleetDashboard(args.slice(1)) : args[0] === 'run' ? fleetRun(args.slice(1)) : args[0] === 'forget' ? fleetForget(args[1]) : fleet(args);
    case 'install-skill': console.log(installSkill()); return 0;
    case undefined: case 'help': case '-h': case '--help': console.log(HELP); return 0;
    case '--version': case '-v': console.log(hxVersion()); return 0;
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); return 2;
  }
}

/** `hx health [--fix]`: one health pass, each check's line, then the summary line. */
async function healthCmd(args: string[]): Promise<number> {
  const p = loadProject();
  const bad = healthConfigError(p.config);
  if (bad) { console.error(bad); return 2; }
  const r = await healthPass(p, { repairs: args.includes('--fix') });
  for (const x of r.results) console.log(renderResult(x));
  console.log(r.line);
  return r.code;
}

async function doctorCmd(): Promise<number> {
  const { checks, code } = await doctor();
  console.log(render(checks));
  return code;
}

/** `hx start`: doctor → init → PRD (grill) → the dry-run plan → hx run --watch, each step skipped when already done. */
async function start(args: string[]): Promise<number> {
  const yes = args.includes('--yes');
  const workersArg = flag(args, '--workers');
  let idea = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--workers');

  // 1. doctor: never skipped; a missing .hx/config.json is a note, since init comes next
  const doc = await doctor({ configOptional: true });
  console.log(render(doc.checks));
  if (doc.code !== 0) { console.log('\nhx start stopped: fix the ✗ above, then run hx start again'); return doc.code; }

  // 2. init
  const top = (await runOk('git', ['rev-parse', '--show-toplevel'])).trim().replace(/\//g, path.sep);
  if (existsSync(path.join(top, STATE_DIR, 'config.json'))) console.log('\ninit: already done');
  else {
    console.log('\ninit: no .hx/config.json — running hx init');
    const code = await init([]);
    if (code !== 0) return code;
  }
  const p = loadProject(top);

  // 3. PRD: an idea is always grilled; without one, an open PRD or ready issue on the board means done
  if (idea === undefined) {
    let trusted: Set<string>;
    try { trusted = await lookupTrusted(p.config); } catch (e: any) { console.error(`hx: ${e.message}`); return 2; }
    const L = p.config.labels;
    const work = (await gh.listIssues(p.config.repo)).filter((i) => i.state === 'OPEN' && trusted.has(i.author)
      && (i.labels.includes(L.prd) || i.labels.includes(L.ready)));
    if (work.length) console.log(`\nPRD: already done (${work.map((i) => `#${i.number}`).join(', ')} on the board)`);
    else {
      idea = (await ask('\nWhat should hx build? ')).trim();
      if (!idea) { console.log('nothing to build — hx start stopped'); return 1; }
    }
  }
  if (idea !== undefined) {
    console.log('\nPRD: grilling the idea');
    const r = await interview(yes ? [idea, '--yes'] : [idea], GRILL);
    if (r.code !== 0 || !r.filed) return r.code;
  }

  // 4. plan
  const workers = Number(workersArg ?? p.config.workers);
  if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers must be a positive integer');
  console.log('\nplan:');
  const planCode = await runPool(p, { workers, watch: false, dryRun: true, signal: new AbortController().signal });
  if (planCode !== 0) return planCode;
  if (!yes && /^n(o)?$/i.test((await ask(`\nStart ${workers} worker(s) now? [Y/n] `)).trim())) {
    console.log('not started — run  hx run --watch  when you are ready');
    return 0;
  }

  // 5. run
  console.log(`\nrun: hx run --watch --workers ${workers}`);
  return runCmd(['--watch', '--workers', String(workers)]);
}

/** hx run's startup gate: the doctor checks without the label lookup (hx run creates the labels). A required ✗
 *  prints the non-✓ lines with their fixes and stops; a ? is printed and the run starts. */
async function startupChecks(cwd?: string): Promise<boolean> {
  const { checks, code } = await doctor({ cwd, skipLabels: true });
  if (code !== 0) { console.error(`hx run: a required check failed (hx doctor shows them all)
${render(checks.filter((c) => c.mark !== '✓'))}`); return false; }
  const unsure = checks.filter((c) => c.mark === '?');
  if (unsure.length) console.log(render(unsure));
  return true;
}

async function init(args: string[]): Promise<number> {
  const root = (await runOk('git', ['rev-parse', '--show-toplevel'])).trim().replace(/\//g, path.sep);
  const existing = findProjectRoot(root) === root;
  const repo = await gh.repoSlug(root);
  const config: Config = existing ? loadProject(root).config
    : { ...DEFAULTS, repo, defaultBranch: await gh.defaultBranch(repo), worktreeRoot: defaultWorktreeRoot(root, repo) };
  // a key absent from the file is "not set": detect it; a present key ('' and [] included) is left alone
  const raw = existing ? readRawConfig(root) : {};
  const notes: string[] = [];
  const saved: Partial<Config> = { ...config };
  if (!('worktreeSetup' in raw)) {
    const found = detectSetup(root);
    if (found) {
      config.worktreeSetup = saved.worktreeSetup = found.command;
      notes.push(`worktree setup: ${found.command} (from ${found.lockfile}) — change worktreeSetup in .hx/config.json`);
    } else {
      delete saved.worktreeSetup;
      notes.push('worktree setup: no lockfile found — set worktreeSetup in .hx/config.json to run a command in each new worktree, e.g. "worktreeSetup": "npm ci"');
    }
  }
  if (!('worktreeCopy' in raw)) {
    const copy = await detectCopy(root);
    if (copy) {
      config.worktreeCopy = saved.worktreeCopy = copy;
      notes.push(`worktree copy: ${copy.join(', ')} (git-ignored) is copied into each new worktree — change worktreeCopy in .hx/config.json`);
    } else delete saved.worktreeCopy;
  }
  saveConfig(path.join(root, STATE_DIR), saved);
  registerRepo(root, config.repo);
  for (const n of notes) console.log(n);

  // keep .hx/ out of git without touching the project's own .gitignore
  const exclude = path.join((await runOk('git', ['-C', root, 'rev-parse', '--git-common-dir'])).trim(), 'info', 'exclude');
  const abs = path.isAbsolute(exclude) ? exclude : path.join(root, exclude);
  if (!existsSync(abs) || !readFileSync(abs, 'utf8').split(/\r?\n/).includes(`/${STATE_DIR}/`)) appendFileSync(abs, `\n/${STATE_DIR}/\n`);

  const login = await gh.ghLogin().catch((e) => `?? (${e.message})`);
  const L = config.labels;
  for (const l of labelSpecs(L)) await gh.ensureLabel(config.repo, l.name, l.color, l.description);

  console.log(`${existing ? 'updated' : 'created'} ${path.join(root, STATE_DIR, 'config.json')}
  repo        ${config.repo} (base ${config.defaultBranch})
  workers     ${config.workers}   model ${config.model}   max ${config.maxIterations} turns/issue
  trusted     ${login} (+ config.trustedAuthors${config.trustedAuthors?.length ? `: ${config.trustedAuthors.join(', ')}` : ', none'}) — issues and PRDs by anyone else are skipped
  worktrees   ${config.worktreeRoot}
  labels      ${L.ready}, ${L.working}, ${L.blocked}, ${L.prd}, ${L.hardened}, ${L.reviewed}, ${L.secured}, ${L.security}, ${L.bug}, ${L.triaged}

Next: file a PRD with  hx prd <file.md>  or label an issue '${L.ready}', then run  hx status  and  hx run`);
  return initRtdd(root, effectiveRtddBin(config), args.includes('--rtdd'));
}

/** The lockfiles hx init looks for in the repo root, in order, and the setup command each one implies. */
export const SETUP_LOCKFILES: readonly (readonly [lockfile: string, command: string])[] = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['composer.lock', 'composer install --no-interaction'],
  ['poetry.lock', 'poetry install'],
  ['uv.lock', 'uv sync'],
  ['Gemfile.lock', 'bundle install'],
  ['go.sum', 'go mod download'],
  ['Cargo.lock', 'cargo fetch'],
];

/** The worktree setup command implied by the first lockfile in the repo root, or null when there is none. */
export function detectSetup(root: string): { command: string; lockfile: string } | null {
  for (const [lockfile, command] of SETUP_LOCKFILES) if (existsSync(path.join(root, lockfile))) return { command, lockfile };
  return null;
}

/** ['.env'] when the repo root has a git-ignored .env (worth copying into each worktree), else null. */
export async function detectCopy(root: string): Promise<string[] | null> {
  if (!existsSync(path.join(root, '.env'))) return null;
  return (await run('git', ['-C', root, 'check-ignore', '-q', '.env'])).code === 0 ? ['.env'] : null;
}

/** .hx/config.json as written (BOM stripped, no defaults merged), to tell a key not set from one set to empty. */
function readRawConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, STATE_DIR, 'config.json'), 'utf8').replace(/^﻿/, ''));
}

/** hx init --rtdd runs `rtdd init` in the repo root (not committed); without it, a hint when rtdd is
 *  installed and the working tree has no .rtdd/config.yaml. */
async function initRtdd(root: string, bin: string, setup: boolean): Promise<number> {
  if (setup) {
    const r = await run(bin, ['init'], { cwd: root });
    if (r.code === 0) { console.log(`rtdd        ${bin} init done in ${root} — commit .rtdd/`); return 0; }
    console.error(`rtdd init failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    return 1;
  }
  if (existsSync(path.join(root, '.rtdd', 'config.yaml'))) return 0;
  if ((await run(bin, ['--version'], { cwd: root })).code !== 0) return 0;
  console.log(`
rtdd is installed but this repo has no .rtdd/config.yaml: run  hx init --rtdd  (or  rtdd init), then commit .rtdd/`);
  return 0;
}

async function runCmd(args: string[]): Promise<number> {
  // no .hx/config.json: the doctor lines say so (with the fix) before loadProject's error
  if (!findProjectRoot(process.cwd()) && !(await startupChecks())) return 1;
  const p = loadProject();
  agentFor(p.config.agentCli); // an unknown agentCli stops here, before any board read
  if (!(await startupChecks(p.root))) return 1;
  const workers = Number(flag(args, '--workers') ?? p.config.workers);
  if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers must be a positive integer');
  const only = flag(args, '--issue')?.split(',').map((s) => Number(s.replace('#', '')));

  const ac = new AbortController();
  let presses = 0;
  const press = () => {
    if (++presses === 1) { log('Ctrl+C — checkpointing running sessions and handing their issues back (Ctrl+C again to force quit)'); ac.abort(); }
    else { log('force quit — killing sessions; their worktrees keep the work'); killAllSessions(); process.exit(130); }
  };
  registerRepo(p.root, p.config.repo);
  process.on('SIGINT', press);
  // started by hx fleet run: its Ctrl+C arrives as an IPC message; the channel never keeps us alive, and the fleet dying does not stop us
  if (process.send) {
    process.on('message', (m: any) => { if (m?.type === 'interrupt') press(); });
    process.on('disconnect', () => {});
    (process.channel as any)?.unref?.();
  }
  return runPool(p, { workers, only, watch: args.includes('--watch'), dryRun: args.includes('--dry-run'), signal: ac.signal });
}

async function prd(args: string[]): Promise<number> {
  const p = loadProject();
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--title');
  if (!file) throw new Error('usage: hx prd <file.md> [--title "..."]');
  const url = await filePrd(p.config, file, flag(args, '--title'));
  writeWake(p.stateDir);
  console.log(`filed ${url}\n${nextLine(p.stateDir, 'decompose')}`);
  return 0;
}

async function bug(args: string[]): Promise<number> {
  const p = loadProject();
  const arg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--title');
  if (!arg) throw new Error('usage: hx bug <file.md | "text"> [--title "..."]');
  const url = await fileBug(p.config, arg, flag(args, '--title'));
  writeWake(p.stateDir);
  console.log(`${url}\n${nextLine(p.stateDir, 'triage')}`);
  return 0;
}

/** What `hx grill` and `hx issue` differ in. */
interface Interview {
  role: 'grill' | 'issue';
  dir: string;      // under the state dir
  noun: string;     // 'PRD' / 'issue'
  later: string;    // how to file it later
  file: (c: Config, out: string) => Promise<string>;
  lane: 'decompose' | 'triage' | 'issue';
}

/**
 * Run an interactive session that writes one markdown file, show it, ask, and file it.
 * Shared by `hx grill` and `hx issue`.
 */
async function interview(args: string[], iv: Interview): Promise<{ code: number; filed: boolean }> {
  const p = loadProject();
  const c = p.config;
  const agent = agentFor(c.agentCli);
  // the session reads issues with scripts/issue.mjs, which needs the trusted set
  let trusted: Set<string>;
  try { trusted = await lookupTrusted(c); } catch (e: any) { console.error(`hx: ${e.message}`); return { code: 2, filed: false }; }
  // a fresh name: a file left from an earlier session in the same second must not be taken for this one's
  let t = Date.now(), paths = sessionPaths(p.stateDir, iv.dir, iv.role, new Date(t));
  while (existsSync(paths.out) || existsSync(paths.promptFile)) paths = sessionPaths(p.stateDir, iv.dir, iv.role, new Date(t += 1000));
  mkdirSync(path.dirname(paths.out), { recursive: true });
  const idea = ideaFrom(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--title'));
  const prompt = sessionPrompt(iv.role, { repo: c.repo, base: c.defaultBranch, idea, output: paths.out }, paths.promptFile);
  // the user talks to this session directly: inherited stdio, no shell
  await new Promise<void>((resolve, reject) => {
    const child = spawn(...resolveCmd(agent.bin(c), agent.interactiveArgs(c.model, c.effort, prompt)), { cwd: p.root, stdio: 'inherit',
      env: { ...process.env, ...trustedEnv(trusted) } });
    child.on('error', reject).on('exit', () => resolve());
  });
  const text = existsSync(paths.out) ? readFileSync(paths.out, 'utf8') : '';
  if (!text.trim()) { console.log(`no ${iv.noun} written — nothing filed`); return { code: 1, filed: false }; }
  console.log(`
${text.trimEnd()}
`);
  if (!args.includes('--yes') && !/^y(es)?$/i.test((await ask(`File this ${iv.noun} on ${c.repo}? [y/N] `)).trim())) {
    console.log(`not filed. The ${iv.noun} is in ${paths.out} — edit it if you like and file it later with  ${iv.later}`);
    return { code: 0, filed: false };
  }
  const url = await iv.file(c, paths.out);
  writeWake(p.stateDir);
  console.log(`filed ${url}
${nextLine(p.stateDir, iv.lane)}`);
  return { code: 0, filed: true };
}

const GRILL: Interview = { role: 'grill', dir: 'prds', noun: 'PRD', later: 'hx prd <file>', lane: 'decompose',
  file: (c, out) => filePrd(c, out) };

async function grill(args: string[]): Promise<number> {
  return (await interview(args, GRILL)).code;
}

/** `hx issue`: grill one small task into one issue (or `--file` an existing one) and file it ready-for-agent, or with --bug as a bug. */
async function issue(args: string[]): Promise<number> {
  const bugLane = args.includes('--bug');
  const title = flag(args, '--title');
  const file = (c: Config, f: string) => filePrd(c, f, title, [bugLane ? c.labels.bug : c.labels.ready]);
  const lane = bugLane ? 'triage' : 'issue';
  const existing = flag(args, '--file');
  if (existing !== undefined) {
    const p = loadProject();
    const url = await file(p.config, existing);
    writeWake(p.stateDir);
    console.log(`filed ${url}
${nextLine(p.stateDir, lane)}`);
    return 0;
  }
  return (await interview(args, { role: 'issue', dir: 'issues', noun: 'issue', later: `hx issue --file <file>${bugLane ? ' --bug' : ''}`, lane, file })).code;
}

/** One line from stdin ('' when stdin closes first). */
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer = '';
    rl.once('line', (l) => { answer = l; rl.close(); });
    rl.once('close', () => resolve(answer));
    rl.setPrompt(question);
    rl.prompt();
  });
}

async function releaseCmd(args: string[]): Promise<number> {
  const p = loadProject();
  const kind = args.find((a) => !a.startsWith('--'));
  if (kind !== undefined && !['patch', 'minor', 'major'].includes(kind)) throw new Error('usage: hx release [patch|minor|major] [--dry-run] [--yes]');
  const out = (m: string) => console.log(m);
  const r = await release({ paths: p, config: p.config, bump: kind as BumpKind | undefined, yes: args.includes('--yes'), dryRun: args.includes('--dry-run'),
    gate: releaseGate(p, p.config, out), log: out, confirm: async (q) => /^(y|yes)$/i.test((await ask(q)).trim()) });
  return r.code;
}

function pause(args: string[]): number {
  const p = loadProject();
  const mode = args.includes('--now') ? 'now' : 'drain';
  setPause(p.stateDir, mode);
  const runner = otherRunner(p.stateDir);
  console.log(runner
    ? mode === 'now'
      ? `pausing run ${runner.pid}: its sessions commit, push and leave a handoff note, then stop.`
      : `pausing run ${runner.pid}: it claims nothing new and stops once its ${runner.sessions.length} session(s) finish.`
    : 'paused: no hx run is active; hx run will refuse to start until  hx resume.');
  return 0;
}

function resume(): number {
  const p = loadProject();
  const was = readPause(p.stateDir);
  clearPause(p.stateDir);
  console.log(was ? `resumed (was paused: ${was}). Run  hx run  to continue where it stopped.` : 'not paused.');
  return 0;
}

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
};

/** o.github false: no github line (hx fleet status prints it once for every repo). */
async function status(p = loadProject(), o: { github?: boolean } = {}): Promise<number> {
  const c = p.config;

  // the runner
  const live = readLive(p.stateDir);
  const paused = readPause(p.stateDir);
  if (live && pidAlive(live.pid)) {
    console.log(`runner   running · pid ${live.pid} · up ${ago(live.startedAt)} · ${live.sessions.length}/${live.workers} worker(s) busy${live.draining ? ' · PAUSING' : ''}`);
    for (const s of live.sessions)
      console.log(`         #${String(s.number).padEnd(5)} ${s.kind.padEnd(9)} ${ago(s.since).padStart(7)}  turn ${s.turn}  ${fmt(s.tokens)} tok  ${s.title.slice(0, 50)}`);
    if (live.skills) console.log(`skills   ${formatSkills(live.skills)}`);
    const models = live.models ? formatRoleModels(live.models, c) : '';
    if (models) console.log(`models   ${models}`);
    if (live.pausedUntil && live.pausedUntil > Date.now())
      console.log(`         no new claims until ${new Date(live.pausedUntil).toLocaleTimeString()} (${live.pauseReason})`);
    if (live.rateLimit) {
      const rl = live.rateLimit;
      console.log(`usage    ${rl.type ?? 'window'}: ${rl.utilization !== undefined ? Math.round(rl.utilization * 100) + '% used, ' : ''}${rl.status}${rl.resetsAt ? `, resets ${new Date(rl.resetsAt * 1000).toLocaleString()}` : ''}`);
    }
  } else if (live?.sessions.length) {
    console.log(`runner   not running — the last run (pid ${live.pid}) stopped unexpectedly with ${live.sessions.length} session(s); hx run hands them back`);
  } else {
    console.log('runner   not running');
  }
  const gate = readGate(p.stateDir).last;
  if (c.gate && gate) console.log(`gate     ${gate.ok ? 'green' : 'RED'} at ${gate.sha.slice(0, 7)} (${gate.command})${gate.ok ? '' : ' — only its fix issue is claimed'}`);
  if (paused) console.log(`paused   ${paused} — hx resume to clear`);
  if (c.worktreeSetup) console.log(`setup    ${c.worktreeSetup} (timeout ${c.worktreeSetupMinutes} min)`);
  if (c.worktreeCopy?.length) console.log(`copy     ${c.worktreeCopy.join(', ')}`);
  // from the files, so it shows whether or not a runner is up
  for (const w of readBudgetWindows(p.stateDir, c.budgetMinPairs, new Date())) console.log(budgetLine(w, c.budgetMinPairs));
  // its own read, runner or not; a failed read prints nothing
  const ghb = o.github === false ? null : await gh.rateLimit();
  if (ghb) console.log(githubLine(ghb));
  console.log(`model    ${c.model}${c.effort ? ` (${c.effort} effort)` : ''}\n`);

  // the board (only issues and PRDs opened by a trusted account are worked on)
  let trusted: Set<string>;
  try { trusted = await lookupTrusted(c); } catch (e: any) { console.error(`hx: ${e.message}`); return 2; }
  const pl = await readPlan(p, trusted);
  console.log(`${c.repo} — ${pl.prds.length} open PRD(s), ${pl.board.length} open '${c.labels.ready}' issue(s)\n`);
  printPlan(pl, c.repo);
  const recs = readUsage(p.stateDir);
  const tl = timeLine(timeWindow(recs, readGateRuns(p.stateDir), Date.now() - 86_400_000, Infinity));
  if (tl) console.log(`
${tl}`);
  if (recs.length) {
    const all = summarize(recs, () => '')[0];
    console.log(`\ntokens so far: ${fmt(totalTokens(all.usage))} over ${all.sessions} session(s) — hx usage for details`);
    const mm = mismatchedSessions(recs);
    if (mm) console.log(`model mismatch: ${mm} session(s) — see run.log`);
  }
  return 0;
}

const dur = (ms?: number) => (ms === undefined ? '-' : fmtDuration(ms));

/** The hx status time line for a window; undefined when it holds no data. */
export function timeLine(s: TimeSummary): string | undefined {
  if (!s.hasData) return undefined;
  const share = s.share === undefined ? '-' : `${Math.round(s.share * 100)}%`;
  return `time     tests ${share} of session time · median test run ${dur(s.testRunMedian)} · gate ${dur(s.gateMedian)} (p90 ${dur(s.gateP90)})`;
}

function usage(args: string[]): number | Promise<number> {
  const p = loadProject();
  if (args.includes('--compare')) return usageCompare(p, args);
  const by = flag(args, '--by') ?? 'issue';
  const recs = readUsage(p.stateDir);
  if (args.includes('--tests')) {
    const days = testSeries(recs, readGateRuns(p.stateDir));
    if (!days.length) { console.log('no test time recorded yet'); return 0; }
    const TW = [10, 12, 12, 12, 12];
    const tcols = (cells: string[]) => cells.map((c, i) => (i ? c.padStart(TW[i]) : c.padEnd(TW[i]))).join(' ');
    console.log(tcols(['day (UTC)', 'test median', 'test p90', 'gate median', 'gate p90']));
    for (const d of days) console.log(tcols([d.day, dur(d.testRunMedian), dur(d.testRunP90), dur(d.gateMedian), dur(d.gateP90)]));
    return 0;
  }
  if (!recs.length) { console.log('no usage recorded yet'); return 0; }
  const keyOf = by === 'model' ? (r: any) => r.actualModel ?? r.model : by === 'role' ? (r: any) => r.role ?? 'impl' : by === 'day' ? (r: any) => localDay(r.ts) : (r: any) => `#${r.issue}`;
  const rows = summarize(recs, keyOf);
  const all = summarize(recs, () => 'TOTAL')[0];
  const W = [12, 8, 6, 9, 10, 10, 8, 10, 8, 6, 5];
  const cols = (cells: string[]) => cells.map((c, i) => (i ? c.padStart(W[i]) : c.padEnd(W[i]))).join(' ');
  // test time: '-' for a group with no record that has it (unknown, not 0)
  const test = (r: UsageRow) => !r.test ? ['-', '-', '-']
    : [fmtDuration(r.test.testMs), r.test.durationMs > 0 ? `${Math.round((r.test.testMs / r.test.durationMs) * 100)}%` : '-', String(r.test.testRuns)];
  const line = (r: UsageRow) => cols([r.key, String(r.sessions), String(r.turns), fmt(totalTokens(r.usage)),
    fmt(r.usage.cacheRead), fmt(r.usage.cacheWrite), fmt(r.usage.output), fmt(Math.round(totalTokens(r.usage) / r.turns)), ...test(r)]);
  console.log(cols([`by ${by}`, 'sessions', 'turns', 'total', 'cache rd', 'cache wr', 'output', 'per turn', 'test', 'test %', 'runs']));
  for (const r of rows) console.log(line(r));
  console.log(line(all));
  return 0;
}

async function usageCompare(p: ReturnType<typeof loadProject>, args: string[]): Promise<number> {
  const time = (name: string) => {
    const v = flag(args, name);
    if (v === undefined) return { t: undefined };
    const t = parseTime(v);
    if (t === undefined) console.error(`hx: ${name} "${v}" is not a time — use an ISO time (2026-11-04T09:00:00Z) or "YYYY-MM-DD HH:MM" (local time)`);
    return { t, bad: t === undefined };
  };
  const at = time('--compare'), from = time('--from');
  if (at.bad || from.bad || at.t === undefined) return 1;
  if (from.t !== undefined && from.t >= at.t) { console.error('hx: --from must be before --compare'); return 1; }
  const trusted = await lookupTrusted(p.config);
  const issues = await gh.issuesWithComments(p.config.repo);
  const { before, after } = compare(readUsage(p.stateDir), issues, { at: at.t, from: from.t, trusted, labels: p.config.labels });
  printCompare(before, after);
  return 0;
}

function printCompare(b: Period, a: Period): void {
  const when = (t?: number) => (t === undefined ? '' : `${localDay(new Date(t).toISOString())} ${new Date(t).toTimeString().slice(0, 5)}`);
  const W = [24, 12, 12, 9];
  const row = (cells: string[]) => console.log(cells.map((c, i) => (i ? c.padStart(W[i]) : c.padEnd(W[i]))).join(' '));
  const money = (n?: number) => (n === undefined ? '-' : `$${n.toFixed(2)}`);
  const num = (n?: number) => (n === undefined ? '-' : fmt(Math.round(n)));
  const pct = (n?: number) => (n === undefined ? '-' : `${Math.round(n * 100)}%`);
  type Line = [string, number | undefined, number | undefined, (n?: number) => string, 'count' | 'pct' | 'share'];
  const lines = (ls: Line[]) => { for (const [k, x, y, f, kind] of ls) row([`  ${k}`, f(x), f(y), change(x, y, kind)]); };
  console.log(`before  ${b.from === undefined ? 'the first run' : when(b.from)} → ${when(b.to)} · ${b.hours.toFixed(1)} h of runs`);
  console.log(`after   ${when(a.from)} → now · ${a.hours.toFixed(1)} h of runs`);
  for (const [name, p] of [['before', b], ['after', a]] as const)
    if (p.smallSample) console.log(`note: ${p.closed} closed issue(s) ${name} the change (fewer than ${SMALL_SAMPLE}) — small sample`);
  const roles = [...new Set([...b.roles, ...a.roles].map((r) => r.role))].sort();
  for (const role of roles) {
    const x = b.roles.find((r) => r.role === role), y = a.roles.find((r) => r.role === role);
    console.log('');
    row([role, 'before', 'after', 'change']);
    lines([
      ['sessions', x?.sessions ?? 0, y?.sessions ?? 0, String, 'count'],
      ['median duration', x?.medianDurationMs, y?.medianDurationMs, dur, 'pct'],
      ['median outside tests', x?.medianOutsideTestsMs, y?.medianOutsideTestsMs, dur, 'pct'],
      ['median tokens', x?.medianTokens, y?.medianTokens, num, 'pct'],
      ['median output', x?.medianOutput, y?.medianOutput, num, 'pct'],
      ['cost/session', x?.costPerSession, y?.costPerSession, money, 'pct'],
      ['failed sessions', x?.failed ?? 0, y?.failed ?? 0, String, 'count'],
    ]);
  }
  console.log('');
  row(['board', 'before', 'after', 'change']);
  lines([
    ['hours of runs', b.hours, a.hours, (n) => (n === undefined ? '-' : n.toFixed(1)), 'pct'],
    ['issues closed', b.closed, a.closed, String, 'count'],
    ['tokens/closed issue', b.tokensPerClosed, a.tokensPerClosed, num, 'pct'],
    ['cost/closed issue', b.costPerClosed, a.costPerClosed, money, 'pct'],
    ['audits PASS', b.auditPass, a.auditPass, String, 'count'],
    ['audits FAIL', b.auditFail, a.auditFail, String, 'count'],
    ['audit FAIL share', b.failShare, a.failShare, pct, 'share'],
    ['first-round FAILs', b.firstRoundFails, a.firstRoundFails, String, 'count'],
    ['gate-fix issues', b.gateFixOpened, a.gateFixOpened, String, 'count'],
    ['stops: timed out', b.stops.timedOut, a.stops.timedOut, String, 'count'],
    ['stops: not mergeable', b.stops.conflict, a.stops.conflict, String, 'count'],
    ['stops: audit rounds', b.stops.auditRounds, a.stops.auditRounds, String, 'count'],
    ['stops: other', b.stops.other, a.stops.other, String, 'count'],
    ['rebase test retries', b.rebaseTestRetries, a.rebaseTestRetries, String, 'count'],
  ]);
}

async function fleetStatus(f: Fleet): Promise<number> {
  let rc = 0;
  for (const r of f.repos) {
    let p: ReturnType<typeof loadProject> | undefined;
    try { p = loadProject(r.root); } catch { /* missing root or no config */ }
    console.log(`== ${p?.config.repo || '?'} (${r.root})`);
    if (!existsSync(r.root) || !p) { console.log('missing'); console.log(''); rc ||= 1; continue; }
    try { rc = (await status(p, { github: false })) || rc; } catch (e: any) { console.error(`hx: ${e.message}`); rc ||= 1; }
    console.log('');
  }
  // one account, one budget: printed once, not per repo
  const ghb = await gh.rateLimit();
  if (ghb) console.log(githubLine(ghb));
  const hold = readHold(fleetDir());
  const ghHold = readGithubHold(fleetDir());
  console.log(`fleet    ${slotsInUse(fleetDir())}/${fleetWorkers(f)} slot(s) in use`
    + (hold ? ` · hold until ${new Date(hold.until).toLocaleString()} (${hold.reason}, ${hold.repo})` : '')
    + (ghHold ? ` · github hold until ${new Date(ghHold.until).toLocaleString()} (${ghHold.reason}, ${ghHold.repo})` : ''));
  return rc;
}

async function fleet(args: string[]): Promise<number> {
  const [sub, arg] = args;
  const f = readFleet();
  switch (sub) {
    case 'add': {
      const from = path.resolve(arg ?? process.cwd());
      const root = findProjectRoot(from);
      if (!root) { console.error(`no .hx/config.json in ${from} or above: run hx init there first`); return 1; }
      if (f.repos.some((r) => sameRoot(r.root, root))) { console.log(`already in the fleet: ${root}`); return 0; }
      writeFleet(addRepo(f, root));
      console.log(`added ${root} to the fleet (${fleetFile()})`);
      return 0;
    }
    case 'remove': {
      if (!arg) { console.error('usage: hx fleet remove <path>'); return 2; }
      const abs = path.resolve(arg);
      const inside = findProjectRoot(abs);
      const root = f.repos.find((r) => sameRoot(r.root, abs)) ?? (inside ? f.repos.find((r) => sameRoot(r.root, inside)) : undefined);
      if (!root) { console.error(`not in the fleet: ${abs}`); return 1; }
      writeFleet(removeRepo(f, root.root));
      console.log(`removed ${root.root} from the fleet`);
      return 0;
    }
    case 'list': {
      if (!f.repos.length) { console.log('the fleet is empty: add a repo with  hx fleet add <path>'); return 0; }
      for (const r of f.repos) {
        const exists = existsSync(r.root);
        let repo = '?';
        try { repo = loadProject(r.root).config.repo || '?'; } catch { /* missing root or no config */ }
        console.log(`${r.root}  ${repo}  ${exists ? 'ok' : 'missing'}`);
      }
      console.log(`workers: ${fleetWorkers(f)}`);
      return 0;
    }
    case 'workers': {
      const n = Number(arg);
      if (!arg || !Number.isInteger(n) || n < 1) { console.error('usage: hx fleet workers <n>  (n: a positive integer)'); return 2; }
      writeFleet({ ...f, workers: n });
      console.log(`fleet workers: ${n} (read by the next hx fleet run)`);
      return 0;
    }
    case 'status': return fleetStatus(f);
    default: console.error('usage: hx fleet add [<path>] | remove <path> | forget <path> | list | workers <n> | status | run [--workers N] [--watch] | dashboard [--port N] [--open]'); return 2;
  }
}

/** hx fleet forget: drop a repo from repos.json (resolved like hx fleet remove); fleet.json is never touched. */
function fleetForget(arg: string | undefined): number {
  if (!arg) { console.error('usage: hx fleet forget <path>'); return 2; }
  const abs = path.resolve(arg);
  const list = readRepos();
  const inside = findProjectRoot(abs);
  const at = (root: string) => list?.repos.find((r) => typeof r?.root === 'string' && sameRoot(r.root, root));
  const entry = at(abs) ?? (inside ? at(inside) : undefined);
  if (!list || !entry) { console.error(`not in repos.json: ${abs}`); return 1; }
  writeRepos({ ...list, repos: list.repos.filter((r) => r !== entry) });
  console.log(`forgot ${entry.root}`);
  let inFleet = false;
  try { inFleet = readFleet().repos.some((r) => sameRoot(r.root, entry.root)); } catch { /* an unreadable fleet.json */ }
  if (inFleet) console.log(`it stays listed while it is in the fleet (hx fleet remove ${entry.root} to drop it)`);
  return 0;
}

async function fleetRun(args: string[]): Promise<number> {
  const w = flag(args, '--workers');
  const workers = w === undefined ? undefined : Number(w);
  if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) throw new Error('--workers must be a positive integer');
  const run = startFleetRun({ workers, watch: args.includes('--watch') });
  process.on('SIGINT', () => run.interrupt());
  return await run.done;
}

function dashboardPort(args: string[]): number {
  const port = Number(flag(args, '--port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number (0-65535)');
  return port;
}

async function dashboard(args: string[]): Promise<number> {
  if (args.includes('--fleet')) return fleetDashboard(args.filter((a) => a !== '--fleet'));
  const p = loadProject();
  const d = await serveDashboard(p, { port: dashboardPort(args), open: args.includes('--open') });
  console.log(`hx dashboard on ${d.url} (read-only, localhost only) — Ctrl+C to stop`);
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  await d.close();
  return 0;
}

/** hx dashboard --fleet / hx fleet dashboard: every known repo; needs no repo of its own. */
async function fleetDashboard(args: string[]): Promise<number> {
  const d = await serveFleetDashboard({ port: dashboardPort(args), open: args.includes('--open') });
  console.log(`hx fleet dashboard on ${d.url} (read-only, localhost only) — Ctrl+C to stop`);
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  await d.close();
  return 0;
}
