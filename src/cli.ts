import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS, defaultWorktreeRoot, findProjectRoot, loadProject, saveConfig, STATE_DIR, type Config } from './config.ts';
import * as gh from './github.ts';
import { runOk } from './exec.ts';
import { log, printPlan, readPlan, runPool } from './pool.ts';
import { killAllSessions } from './agent.ts';
import { clearPause, otherRunner, pidAlive, readLive, readPause, setPause } from './runstate.ts';
import { fmt, readUsage, summarize, totalTokens, type UsageRow } from './usage.ts';

const HELP = `usage: hx <command> [options]

  init                     set up hx in the current repo (.hx/config.json + GitHub labels)
  prd <file.md> [--title T] file a PRD issue from a markdown file (title: --title or its first '# ' line)
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

A PRD (label prd) is decomposed into child issues, each child is implemented, then the PRD is
reviewed (which may file gap issues) and closed. An issue is picked up when it is open, labelled
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

  const L = config.labels;
  await gh.ensureLabel(config.repo, L.ready, '0e8a16', 'hx: an agent may pick this up');
  await gh.ensureLabel(config.repo, L.working, 'fbca04', 'hx: an agent is working on this');
  await gh.ensureLabel(config.repo, L.blocked, 'd93f0b', 'hx: needs a human');
  await gh.ensureLabel(config.repo, L.prd, '5319e7', 'hx: a PRD, decomposed into child issues');
  await gh.ensureLabel(config.repo, L.reviewed, '1d76db', 'hx: PRD reviewed and signed off');

  console.log(`${existing ? 'updated' : 'created'} ${path.join(root, STATE_DIR, 'config.json')}
  repo        ${config.repo} (base ${config.defaultBranch})
  workers     ${config.workers}   model ${config.model}   max ${config.maxIterations} turns/issue
  worktrees   ${config.worktreeRoot}
  labels      ${L.ready}, ${L.working}, ${L.blocked}, ${L.prd}, ${L.reviewed}

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
  let body = readFileSync(file, 'utf8');
  let title = flag(args, '--title');
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (!title && h1) { title = h1[1]; body = body.replace(h1[0], '').trimStart(); }
  if (!title) throw new Error('no title: pass --title or start the file with a "# Title" line');
  const url = await gh.createIssue(p.config.repo, title, body, [p.config.labels.prd]);
  console.log(`filed ${url}\nhx run will decompose it into issues.`);
  return 0;
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
  if (paused) console.log(`paused   ${paused} — hx resume to clear`);
  console.log(`model    ${c.model}${c.effort ? ` (${c.effort} effort)` : ''}\n`);

  // the board
  const pl = await readPlan(p);
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
