import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULTS, defaultWorktreeRoot, findProjectRoot, loadProject, saveConfig, STATE_DIR, type Config } from './config.ts';
import * as gh from './github.ts';
import { resolveCmd, runOk } from './exec.ts';
import { log, lookupTrusted, printPlan, readPlan, runPool } from './pool.ts';
import { killAllSessions } from './agent.ts';
import { clearPause, otherRunner, pidAlive, readLive, readPause, setPause } from './runstate.ts';
import { readGate } from './gate.ts';
import { filePrd } from './prd.ts';
import { grillArgs, grillPaths, grillPrompt, ideaFrom } from './grill.ts';
import { fmt, readUsage, summarize, totalTokens, type UsageRow } from './usage.ts';

const HELP = `usage: hx <command> [options]

  init                     set up hx in the current repo (.hx/config.json + GitHub labels)
  prd <file.md> [--title T] file a PRD issue from a markdown file (title: --title or its first '# ' line)
  grill [<idea.md> | "idea"] [--yes]
                           an interactive claude session interviews you into a PRD; on confirm
                           (or --yes) it is filed like hx prd
  run [options]            work the board until nothing is left, then exit
      --watch              keep running and pick up new / unblocked work
      --workers N          parallel sessions (default: config.workers)
      --issue N[,N...]     only these issues / PRDs
      --dry-run            show the board and what would run next, change nothing
  status                   the runner, its live sessions, usage limits, and the board
  pause [--now]            stop claiming new work; running sessions finish (--now: they commit,
                           push and leave a handoff note, then stop). Works on a running hx run.
  resume                   clear a pause; then hx run continues where it stopped
  usage [--by issue|role|model|day]   token usage recorded by hx
  help

Ctrl+C in hx run = pause --now for that run; Ctrl+C again force-quits (sessions are killed).

A PRD (label prd) goes gauntlet -> decompose -> building -> review -> security -> done. The gauntlet
(gauntlet, gauntletRounds) has a critic critique the PRD and a reviser rewrite it in rounds, then labels
it prd-hardened; it is decomposed into child issues and each child is implemented; the review may file
gap issues (prd-reviewed on sign-off); the security pass (security, securityRounds) checks the merged
work and may file security issues (security-reviewed when clean); then the PRD is closed.

An issue is picked up when it is open, labelled
ready-for-agent, not agent-working / agent-blocked, and every issue under its "## Blocked by"
heading is closed (a child also waits for its PRD's own "## Blocked by").`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init': return init();
    case 'prd': return prd(args);
    case 'grill': return grill(args);
    case 'run': return runCmd(args);
    case 'status': return status();
    case 'pause': return pause(args);
    case 'resume': return resume();
    case 'usage': return usage(args);
    case undefined: case 'help': case '-h': case '--help': console.log(HELP); return 0;
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); return 2;
  }
}

async function init(): Promise<number> {
  const root = (await runOk('git', ['rev-parse', '--show-toplevel'])).trim().replace(/\//g, path.sep);
  const existing = findProjectRoot(root) === root;
  const repo = await gh.repoSlug(root);
  const config: Config = existing ? loadProject(root).config
    : { ...DEFAULTS, repo, defaultBranch: await gh.defaultBranch(repo), worktreeRoot: defaultWorktreeRoot(root, repo) };
  saveConfig(path.join(root, STATE_DIR), config);

  // keep .hx/ out of git without touching the project's own .gitignore
  const exclude = path.join((await runOk('git', ['-C', root, 'rev-parse', '--git-common-dir'])).trim(), 'info', 'exclude');
  const abs = path.isAbsolute(exclude) ? exclude : path.join(root, exclude);
  if (!existsSync(abs) || !readFileSync(abs, 'utf8').split(/\r?\n/).includes(`/${STATE_DIR}/`)) appendFileSync(abs, `\n/${STATE_DIR}/\n`);

  const login = await gh.ghLogin().catch((e) => `?? (${e.message})`);
  const L = config.labels;
  await gh.ensureLabel(config.repo, L.ready, '0e8a16', 'hx: an agent may pick this up');
  await gh.ensureLabel(config.repo, L.working, 'fbca04', 'hx: an agent is working on this');
  await gh.ensureLabel(config.repo, L.blocked, 'd93f0b', 'hx: needs a human');
  await gh.ensureLabel(config.repo, L.prd, '5319e7', 'hx: a PRD, decomposed into child issues');
  await gh.ensureLabel(config.repo, L.reviewed, '1d76db', 'hx: PRD reviewed and signed off');
  await gh.ensureLabel(config.repo, L.hardened, 'c5def5', 'hx: PRD passed the gauntlet (critique and revision) and may be decomposed');
  await gh.ensureLabel(config.repo, L.secured, '0052cc', "hx: the security pass found nothing in the PRD's merged work");
  await gh.ensureLabel(config.repo, L.security, 'e99695', 'hx: a security issue filed by the security pass');
  await gh.ensureLabel(config.repo, L.gateFix, 'b60205', 'hx: fixes a red default branch (the only work claimed while it is red)');

  console.log(`${existing ? 'updated' : 'created'} ${path.join(root, STATE_DIR, 'config.json')}
  repo        ${config.repo} (base ${config.defaultBranch})
  workers     ${config.workers}   model ${config.model}   max ${config.maxIterations} turns/issue
  trusted     ${login} (+ config.trustedAuthors${config.trustedAuthors?.length ? `: ${config.trustedAuthors.join(', ')}` : ', none'}) — issues and PRDs by anyone else are skipped
  worktrees   ${config.worktreeRoot}
  labels      ${L.ready}, ${L.working}, ${L.blocked}, ${L.prd}, ${L.hardened}, ${L.reviewed}, ${L.secured}, ${L.security}

Next: file a PRD with  hx prd <file.md>  or label an issue '${L.ready}', then run  hx status  and  hx run`);
  return 0;
}

async function runCmd(args: string[]): Promise<number> {
  const p = loadProject();
  const workers = Number(flag(args, '--workers') ?? p.config.workers);
  if (!Number.isInteger(workers) || workers < 1) throw new Error('--workers must be a positive integer');
  const only = flag(args, '--issue')?.split(',').map((s) => Number(s.replace('#', '')));

  const ac = new AbortController();
  let presses = 0;
  process.on('SIGINT', () => {
    if (++presses === 1) { log('Ctrl+C — checkpointing running sessions and handing their issues back (Ctrl+C again to force quit)'); ac.abort(); }
    else { log('force quit — killing sessions; their worktrees keep the work'); killAllSessions(); process.exit(130); }
  });
  return runPool(p, { workers, only, watch: args.includes('--watch'), dryRun: args.includes('--dry-run'), signal: ac.signal });
}

async function prd(args: string[]): Promise<number> {
  const p = loadProject();
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--title');
  if (!file) throw new Error('usage: hx prd <file.md> [--title "..."]');
  const url = await filePrd(p.config, file, flag(args, '--title'));
  console.log(`filed ${url}\nhx run will decompose it into issues.`);
  return 0;
}

async function grill(args: string[]): Promise<number> {
  const p = loadProject();
  const c = p.config;
  // a fresh name: a PRD left from an earlier session in the same second must not be taken for this one's
  let t = Date.now(), paths = grillPaths(p.stateDir, new Date(t));
  while (existsSync(paths.prd) || existsSync(paths.promptFile)) paths = grillPaths(p.stateDir, new Date(t += 1000));
  mkdirSync(path.dirname(paths.prd), { recursive: true });
  const prompt = grillPrompt({ repo: c.repo, base: c.defaultBranch, idea: ideaFrom(args.find((a) => !a.startsWith('--'))), output: paths.prd },
    paths.promptFile);
  // the user talks to this session directly: inherited stdio, no shell
  await new Promise<void>((resolve, reject) => {
    const child = spawn(...resolveCmd(c.claudeBin, grillArgs(c, prompt)), { cwd: p.root, stdio: 'inherit' });
    child.on('error', reject).on('exit', () => resolve());
  });
  const text = existsSync(paths.prd) ? readFileSync(paths.prd, 'utf8') : '';
  if (!text.trim()) { console.log('no PRD written — nothing filed'); return 1; }
  console.log(`\n${text.trimEnd()}\n`);
  if (!args.includes('--yes') && !/^y(es)?$/i.test((await ask(`File this PRD on ${c.repo}? [y/N] `)).trim())) {
    console.log(`not filed. The PRD is in ${paths.prd} — edit it if you like and file it later with  hx prd <file>`);
    return 0;
  }
  const url = await filePrd(c, paths.prd);
  console.log(`filed ${url}\nhx run will decompose it into issues.`);
  return 0;
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

async function status(): Promise<number> {
  const p = loadProject();
  const c = p.config;

  // the runner
  const live = readLive(p.stateDir);
  const paused = readPause(p.stateDir);
  if (live && pidAlive(live.pid)) {
    console.log(`runner   running · pid ${live.pid} · up ${ago(live.startedAt)} · ${live.sessions.length}/${live.workers} worker(s) busy${live.draining ? ' · PAUSING' : ''}`);
    for (const s of live.sessions)
      console.log(`         #${String(s.number).padEnd(5)} ${s.kind.padEnd(9)} ${ago(s.since).padStart(7)}  turn ${s.turn}  ${fmt(s.tokens)} tok  ${s.title.slice(0, 50)}`);
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
  console.log(`model    ${c.model}${c.effort ? ` (${c.effort} effort)` : ''}\n`);

  // the board (only issues and PRDs opened by a trusted account are worked on)
  let trusted: Set<string>;
  try { trusted = await lookupTrusted(c); } catch (e: any) { console.error(`hx: ${e.message}`); return 2; }
  const pl = await readPlan(p, trusted);
  console.log(`${c.repo} — ${pl.prds.length} open PRD(s), ${pl.board.length} open '${c.labels.ready}' issue(s)\n`);
  printPlan(pl, c.repo);
  const recs = readUsage(p.stateDir);
  if (recs.length) {
    const all = summarize(recs, () => '')[0];
    console.log(`\ntokens so far: ${fmt(totalTokens(all.usage))} over ${all.sessions} session(s) — hx usage for details`);
  }
  return 0;
}

function usage(args: string[]): number {
  const p = loadProject();
  const by = flag(args, '--by') ?? 'issue';
  const recs = readUsage(p.stateDir);
  if (!recs.length) { console.log('no usage recorded yet'); return 0; }
  const keyOf = by === 'model' ? (r: any) => r.model : by === 'role' ? (r: any) => r.role ?? 'impl' : by === 'day' ? (r: any) => r.ts.slice(0, 10) : (r: any) => `#${r.issue}`;
  const rows = summarize(recs, keyOf);
  const all = summarize(recs, () => 'TOTAL')[0];
  const W = [12, 8, 6, 9, 10, 10, 8, 10];
  const cols = (cells: string[]) => cells.map((c, i) => (i ? c.padStart(W[i]) : c.padEnd(W[i]))).join(' ');
  const line = (r: UsageRow) => cols([r.key, String(r.sessions), String(r.turns), fmt(totalTokens(r.usage)),
    fmt(r.usage.cacheRead), fmt(r.usage.cacheWrite), fmt(r.usage.output), fmt(Math.round(totalTokens(r.usage) / r.turns))]);
  console.log(cols([`by ${by}`, 'sessions', 'turns', 'total', 'cache rd', 'cache wr', 'output', 'per turn']));
  for (const r of rows) console.log(line(r));
  console.log(line(all));
  return 0;
}
