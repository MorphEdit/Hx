import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerArgs, type Project } from './config.ts';
import * as gh from './github.ts';
import type { Issue } from './github.ts';
import { externalRefs, issueKey, parseParent, plan, prdKey, refKey, render, type Action, type Plan } from './state.ts';
import { addWorktree, auditWorktree, cleanStaleWorktrees, implWorktree, prdWorktree, removeWorktree } from './worktree.ts';
import { rateLimitOf, runGoal, runTurn, type GoalResult, type RateLimit } from './agent.ts';
import { clearLive, otherRunner, readLive, readPause, writeLive, type LiveSession, type LiveState } from './runstate.ts';
import { fmt, recordUsage, totalTokens } from './usage.ts';
import { gateIssueBody, gateIssueTitle, readGate, remoteSha, runGate, writeGate, type GateResult } from './gate.ts';
import { run as runCmd } from './exec.ts';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
// the one-call commit → rebase → test → push → PR → merge → close routine (forward slashes: the agent's shell may be bash)
const SHIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ship.mjs').replace(/\\/g, '/');
export const REVIEW_MARKER = '<!-- hx-review -->';
export const HANDOFF_MARKER = '<!-- hx-handoff -->';
export const GAUNTLET_MARKER = '<!-- hx-gauntlet -->';
export const ORIGINAL_MARKER = '<!-- hx-prd-original -->';
const firstLineIs = (marker: string) => (b: string) => b.trimStart().split(/\r?\n/, 1)[0].trim() === marker;

type SessionAction = Extract<Action, { kind: 'impl' | 'gauntlet' | 'decompose' | 'review' }>;

export interface PoolOptions {
  workers: number;
  watch: boolean; // keep polling for new issues instead of exiting when the board is empty
  dryRun: boolean;
  only?: number[]; // issue or PRD numbers
  signal: AbortSignal;
}

export function log(msg: string, issue?: number): void {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t} ${issue ? `[#${issue}] ` : ''}${msg}`);
}

/** How a session reports back to the pool while it runs. */
interface WorkContext {
  signal: AbortSignal; // aborted = stop now (Ctrl+C, pause --now): checkpoint and hand back
  started: (s: LiveSession) => void;
  progress: (key: string, turn: number, tokens: number) => void;
  rateLimit: (rl: RateLimit) => void;
  merged?: (testCommand?: string) => void; // a PR reached the default branch: the CI gate re-tests it
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

/** The board as the pool sees it: every issue, with every blocker's state resolved. */
export async function readPlan(p: Project, busy: Set<string> = new Set()): Promise<Plan> {
  const { repo, labels } = p.config;
  const [issues, own] = await Promise.all([gh.listIssues(repo), gh.allStates(repo)]);
  const states = new Map<string, 'OPEN' | 'CLOSED'>();
  for (const [n, s] of own) states.set(refKey({ repo, number: n }), s);
  for (const r of externalRefs(issues.filter((i) => i.state === 'OPEN'), repo)) {
    const s = await gh.issueState(r.repo, r.number);
    if (s) states.set(refKey(r), s);
  }
  return plan(issues, repo, labels, states, busy, p.config);
}

const target = (a: Action) => ('issue' in a ? a.issue : a.prd);
const keyOf = (a: SessionAction) => (a.kind === 'impl' ? issueKey(a.issue) : prdKey(a.prd));

export function printPlan(pl: Plan, repo: string): void {
  const refs = (rs: { repo: string; number: number }[]) => rs.map((w) => (w.repo === repo ? '' : w.repo) + '#' + w.number).join(', ');
  for (const r of pl.prds)
    console.log(`  PRD #${String(r.number).padEnd(4)} ${r.status.padEnd(13)} ${r.title.slice(0, 50)}  [${r.closed}/${r.open + r.closed} done]${r.waitingOn.length ? `  waits on ${refs(r.waitingOn)}` : ''}`);
  if (pl.prds.length) console.log('');
  for (const r of pl.board)
    console.log(`  #${String(r.number).padEnd(8)} ${r.status.padEnd(13)} ${r.title.slice(0, 60)}${r.waitingOn.length ? `  waits on ${refs(r.waitingOn)}` : ''}`);
}

export async function runPool(p: Project, o: PoolOptions): Promise<number> {
  const c = p.config;
  if (o.dryRun) {
    const pl = await readPlan(p);
    printPlan(pl, c.repo);
    console.log(pl.actions.length ? `\nnext: ${pl.actions.slice(0, o.workers + 5).map((a) => `${a.kind} #${target(a)}`).join(', ')}` : '\nnothing to do');
    return 0;
  }
  const other = otherRunner(p.stateDir);
  if (other) { log(`hx is already running for this repo (pid ${other.pid}, since ${other.startedAt}). Use hx status / hx pause.`); return 3; }
  const pausedMode = readPause(p.stateDir);
  if (pausedMode) { log(`paused (${pausedMode}) — run  hx resume  first.`); return 3; }

  // Ctrl+C (o.signal) and `hx pause --now` both stop running sessions with a checkpoint
  const stop = new AbortController();
  o.signal.addEventListener('abort', () => stop.abort(), { once: true });
  const live: LiveState = { pid: process.pid, startedAt: new Date().toISOString(), repo: c.repo, workers: o.workers, sessions: [] };
  const save = () => { try { writeLive(p.stateDir, live); } catch {} };
  await recoverStaleClaims(p);
  // a removal that failed last run (a file held open on Windows) left its directory behind; no session runs yet
  for (const d of await cleanStaleWorktrees(p.root, c.worktreeRoot).catch(() => [])) log(`removed leftover directory ${d}`);
  save();

  let wake = () => {}; // set while the loop waits; called to wake it early

  // CI gate: test the default branch at start and after every merge; while it is red, claim only its fix
  const gs = readGate(p.stateDir);
  let gateRunning: Promise<void> | null = null;
  let gateAgain = false;
  let gateWarned = false;
  const gateCommand = () => c.gateCommand || gs.command;
  const gateRed = () => c.gate && !!gs.last && !gs.last.ok;
  const showGate = () => { live.gate = gs.last ? { ok: gs.last.ok, sha: gs.last.sha, at: gs.last.at, fixIssue: gs.fixIssue } : undefined; save(); };
  const gateCheck = (): Promise<void> => {
    if (!c.gate) return Promise.resolve();
    const cmd = gateCommand();
    if (!cmd) {
      if (!gateWarned) { log('gate: no test command known yet (set gateCommand, or it is learned from the first audited merge)'); gateWarned = true; }
      return Promise.resolve();
    }
    if (gateRunning) { gateAgain = true; return gateRunning; }
    gateRunning = (async () => {
      do {
        gateAgain = false;
        const r = await runGate(p.root, c.worktreeRoot, c.defaultBranch, cmd).catch((e) => ({ sha: '', ok: true, command: cmd, output: String(e.message), at: new Date().toISOString(), error: true }));
        if ('error' in r) { log(`gate: could not run (${r.output.slice(0, 160)}) — retried after the next merge`); continue; }
        const wasRed = gateRed();
        gs.last = r;
        if (!r.ok) {
          log(`gate RED ✗ — \`${cmd}\` ${r.timedOut ? 'timed out' : 'fails'} on ${c.defaultBranch} at ${r.sha.slice(0, 7)}; claiming only its fix`);
          await fileGateIssue(r).catch((e) => log(`gate: filing the fix issue failed: ${e.message}`));
        } else {
          log(wasRed ? `gate green ✓ again at ${r.sha.slice(0, 7)}` : `gate green ✓ at ${r.sha.slice(0, 7)}`);
          gs.fixIssue = undefined;
        }
        writeGate(p.stateDir, gs);
        showGate();
      } while (gateAgain);
    })().finally(() => { gateRunning = null; wake(); });
    return gateRunning;
  };
  const fileGateIssue = async (r: GateResult) => {
    if (gs.fixIssue && (await gh.issueState(c.repo, gs.fixIssue)) === 'OPEN') return; // one fix issue per red
    const url = await gh.createIssue(c.repo, gateIssueTitle(c.defaultBranch, r), gateIssueBody(c.defaultBranch, r), [c.labels.ready, c.labels.gateFix]);
    gs.fixIssue = Number(/\/issues\/(\d+)/.exec(url)?.[1]) || undefined;
    log(`gate: filed #${gs.fixIssue} to fix ${c.defaultBranch}`);
  };
  await gateCheck();

  const inFlight = new Map<string, Promise<void>>();
  let idleLogged = false;
  let failures = 0;
  let engineRetries = 0;
  let fatal: string | undefined; // a setup error: stop claiming, let running sessions finish
  let finished = 0; // sessions ended so far: a plan read while one was ending is already stale
  const holdUntil = (until: number, why: string) => {
    if (until <= (live.pausedUntil ?? 0)) return;
    live.pausedUntil = until; live.pauseReason = why; save();
    log(`${why} — no new claims until ${new Date(until).toLocaleTimeString()}`);
  };
  const ctx: WorkContext = {
    signal: stop.signal,
    started: (s) => { live.sessions.push(s); save(); },
    merged: (testCommand) => {
      if (testCommand && !gs.command) { gs.command = testCommand; writeGate(p.stateDir, gs); }
      void gateCheck();
    },
    progress: (key, turn, tokens) => { const s = live.sessions.find((x) => x.key === key); if (s) { s.turn = turn; s.tokens = tokens; save(); } },
    rateLimit: (rl) => {
      live.rateLimit = { ...rl, at: new Date().toISOString() }; save();
      const high = rl.utilization !== undefined ? rl.utilization >= c.usagePauseAt : rl.status === 'allowed_warning';
      if (high && rl.status !== 'rejected')
        holdUntil(rl.resetsAt ? rl.resetsAt * 1000 : Date.now() + 30 * 60_000,
          `usage ${rl.utilization !== undefined ? Math.round(rl.utilization * 100) + '%' : 'warning'} on the ${rl.type ?? 'current'} window`);
    },
  };
  const watcher = setInterval(() => {
    const m = readPause(p.stateDir);
    if (m && !live.draining) { live.draining = true; save(); log(m === 'now' ? 'pause --now: checkpointing running sessions…' : 'pause: finishing running sessions, claiming nothing new'); wake(); }
    if (m === 'now' && !stop.signal.aborted) stop.abort();
  }, 1000);

  log(`hx pool up — ${c.repo} · ${o.workers} worker(s) · model ${c.model}${c.effort ? ` (${c.effort} effort)` : ''} · max ${c.maxIterations} iterations/session`);
  try {
    while (!stop.signal.aborted && !fatal) {
      let actions: Action[] = [];
      const finishedBefore = finished;
      const held = Date.now() < (live.pausedUntil ?? 0);
      if (!held && !live.draining) {
        try {
          const pl = await readPlan(p, new Set(inFlight.keys()));
          actions = pl.actions.filter((a) => !o.only || o.only.includes(target(a)));
          if (gateRed()) {
            // someone may have fixed the base by hand: re-test when it moved
            if (!gateRunning && gs.last && (await remoteSha(p.root, c.defaultBranch)) !== gs.last.sha) void gateCheck();
            actions = actions.filter((a) => a.kind === 'impl' && a.issue === gs.fixIssue);
          }
        } catch (e: any) {
          log(`board read failed, retrying next poll: ${e.message}`);
        }
      }

      for (const a of actions) {
        if (stop.signal.aborted || fatal || live.draining || Date.now() < (live.pausedUntil ?? 0)) break; // fatal may land during readPlan
        if (a.kind === 'close-prd' || a.kind === 'label-ready') { await engineStep(p, a).catch((e) => log(`${a.kind} failed: ${e.message}`, target(a))); continue; }
        if (inFlight.size >= o.workers) continue; // engine steps further down still run
        idleLogged = false;
        const key = keyOf(a);
        const task = work(p, a, ctx).then((r) => {
          if (r?.stopReason === 'limited') {
            holdUntil(r.last?.limited?.resetsAt ? r.last.limited.resetsAt * 1000 : Date.now() + 30 * 60_000, 'usage limit reached');
          } else if (r?.stopReason === 'fatal') {
            fatal = r.last?.error ?? 'unknown setup error';
          } else if (r && !r.done && r.stopReason !== 'aborted') failures++;
        }).catch((e) => { failures++; log(`crashed: ${e.message}`, target(a)); })
          .finally(() => { inFlight.delete(key); live.sessions = live.sessions.filter((s) => s.key !== key); save(); finished++; });
        inFlight.set(key, task);
      }

      if (!inFlight.size && gateRunning) { await gateRunning; continue; } // its result decides what may run
      if (!inFlight.size) {
        if (live.draining) { log('paused — every session has finished'); break; }
        if (finished !== finishedBefore) continue; // the plan predates a session ending: read it again
        const limited = Date.now() < (live.pausedUntil ?? 0);
        // an engine step (PRD closed, child labelled) may have unlocked work: re-read before giving up
        const engineOnly = actions.length > 0 && actions.every((a) => a.kind === 'close-prd' || a.kind === 'label-ready');
        engineRetries = engineOnly ? engineRetries + 1 : 0;
        if (!o.watch && !limited && (!engineOnly || engineRetries > 3)) { log('nothing left to do — done'); break; }
        if (engineOnly) { await sleep(2000, stop.signal); continue; }
        if (!idleLogged) { log(limited ? 'waiting for the usage limit to reset…' : 'board empty — watching for new issues'); idleLogged = true; }
      }
      // wake on the first finished task, a pause, or after a poll interval (new / unblocked issues, a limit reset)
      const holdLeft = (live.pausedUntil ?? 0) - Date.now();
      const waitMs = holdLeft > 0 ? Math.max(1000, Math.min(c.pollSeconds * 1000, holdLeft)) : c.pollSeconds * 1000;
      await Promise.race([sleep(waitMs, stop.signal), new Promise<void>((r) => { wake = r; }), ...inFlight.values()]);
    }
    if (inFlight.size) { log(`stopping — waiting for ${inFlight.size} session(s) to hand back their issues…`); await Promise.allSettled(inFlight.values()); }
  } finally {
    clearInterval(watcher);
    clearLive(p.stateDir);
  }
  if (fatal) {
    log(`STOPPED: Claude rejected the setup — ${fatal.slice(0, 300)}`);
    log(`check config.model ('${c.model}'), claude --version, and that claude is logged in; no issue was labelled.`);
    return 2;
  }
  return failures ? 1 : 0;
}

/**
 * A run that died (crash, closed terminal, killed process) leaves its claims behind: the
 * agent-working label on GitHub and its sessions in live.json. Hand them back so the board moves
 * again; implementation worktrees stay, so the next session continues the work.
 */
async function recoverStaleClaims(p: Project): Promise<void> {
  const prev = readLive(p.stateDir);
  if (!prev?.sessions?.length) return;
  for (const s of prev.sessions) {
    await gh.editLabels(p.config.repo, s.number, [], [p.config.labels.working]).catch(() => {});
    log(`recovered from a run that stopped unexpectedly (pid ${prev.pid}): released ${s.kind}`, s.number);
  }
}

/** Steps the engine does itself, no session: idempotent, retried every poll until GitHub agrees. */
async function engineStep(p: Project, a: Extract<Action, { kind: 'close-prd' | 'label-ready' }>): Promise<void> {
  const c = p.config;
  if (a.kind === 'close-prd') {
    await gh.closeIssue(c.repo, a.prd, 'All child issues are closed and the PRD passed review — closed by hx.');
    log('PRD closed ✓', a.prd);
  } else {
    await gh.editLabels(c.repo, a.issue, [c.labels.ready]);
    log(`labelled ${c.labels.ready} (child of PRD #${a.prd} without a label)`, a.issue);
  }
}

const childList = (kids: Issue[]) =>
  kids.length ? kids.map((k) => `- #${k.number} [${k.state.toLowerCase()}] ${k.title}`).join('\n') : '(none)';

async function work(p: Project, a: SessionAction, ctx: WorkContext): Promise<GoalResult | undefined> {
  const c = p.config;
  const n = target(a);
  const title = a.title;

  let round = 0;
  if (a.kind === 'review') {
    round = (await gh.commentBodies(c.repo, n)).filter((b) => b.trimStart().startsWith(REVIEW_MARKER)).length + 1;
    if (round > c.reviewRounds) {
      await gh.comment(c.repo, n, `**hx:** ${c.reviewRounds} review rounds have run and the PRD is still not signed off. A human needs to look; add the \`${c.labels.reviewed}\` label to sign it off, or remove \`${c.labels.blocked}\` to allow more rounds after raising \`reviewRounds\`.`);
      await gh.editLabels(c.repo, n, [c.labels.blocked]);
      log(`review round cap (${c.reviewRounds}) reached — labelled ${c.labels.blocked}`, n);
      return undefined;
    }
  } else if (a.kind === 'gauntlet') {
    round = (await gh.commentBodies(c.repo, n)).filter(firstLineIs(GAUNTLET_MARKER)).length + 1;
  }

  await gh.editLabels(c.repo, n, [c.labels.working]);
  log(`${a.kind}${round ? ` (round ${round})` : ''}: ${title}`, n);
  let wt: { dir: string; resumed: boolean };
  try {
    wt = await addWorktree(p.root, c.worktreeRoot, a.kind === 'impl' ? implWorktree(n, c.defaultBranch) : prdWorktree(n, c.defaultBranch));
  } catch (e: any) {
    await gh.editLabels(c.repo, n, [], [c.labels.working]).catch(() => {});
    throw e;
  }
  const key = keyOf(a);
  ctx.started({ key, number: n, kind: a.kind, title, since: new Date().toISOString(), turn: 0, tokens: 0 });

  // an earlier session that was stopped left a handoff comment: give it to this one
  let resumeNote = '';
  if (a.kind === 'impl' && wt.resumed) {
    const handoff = (await gh.commentBodies(c.repo, n).catch(() => [] as string[])).filter((b) => b.trimStart().startsWith(HANDOFF_MARKER)).pop();
    resumeNote = `NOTE: this branch already has work from an earlier session — run \`git log origin/${c.defaultBranch}..HEAD\` and \`git status\` first and continue from there.`
      + (handoff ? `\nThat session's handoff note:\n\n${handoff.replace(HANDOFF_MARKER, '').trim()}\n` : '');
  }

  const L = c.labels;
  const audited = a.kind === 'impl' && c.audit;
  const vars: Record<string, string | number> = {
    REPO: c.repo, BASE: c.defaultBranch, TITLE: title, SHIP,
    LABEL_READY: L.ready, LABEL_REVIEWED: L.reviewed, ROUND: round, ROUNDS: a.kind === 'gauntlet' ? c.gauntletRounds : c.reviewRounds,
    ISSUE: n, PRD: n, BRANCH: `issue/${n}`,
    EXISTING: a.kind === 'decompose' ? childList(a.children) : '', CHILDREN: a.kind === 'review' ? childList(a.children) : '',
    RESUMED: resumeNote,
    SUBJECT: a.kind === 'impl' ? `issue #${n} (branch issue/${n}): look at \`git status\`, its PR (\`gh pr list -R ${c.repo} --head issue/${n}\`) and the issue`
      : a.kind === 'decompose' ? `PRD #${n}: list the issues you have filed for it so far`
      : a.kind === 'gauntlet' ? `gauntlet round ${round} of PRD #${n}` : `the review of PRD #${n}`,
    // with an auditor the implementer stops at an open PR; hx merges once the audit passes
    SHIP_FLAGS: audited ? ' --no-merge' : '',
    SHIP_WHAT: audited ? ' (it does NOT merge: an independent auditor checks the PR first)' : ', squash-merges it, deletes the branch and closes the issue',
    SHIP_DONE: audited ? 'READY' : 'SHIPPED',
    SHIP_NOTE: audited ? 'Do not merge the PR or close the issue yourself.\n' : '',
  };
  const logDir = path.join(p.stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const eventLog = path.join(logDir, `${a.kind === 'impl' ? 'issue' : a.kind}-${n}.jsonl`);
  let sessionTokens = 0;
  /** One role session (a fresh Claude session with its Ralph loop), logged and counted. */
  const goal = (role: string, cwd: string, promptFile: string, promise: string, extra: Record<string, string | number> = {}) => {
    const v = { ...vars, ...extra, PROMISE: promise };
    return runGoal({
      bin: c.claudeBin, cwd, model: c.model, effort: c.effort, extraArgs: workerArgs(c), timeoutMs: c.turnTimeoutMinutes * 60_000,
      prompt: render(readFileSync(path.join(PROMPTS, promptFile), 'utf8'), v),
      continuePrompt: render(readFileSync(path.join(PROMPTS, 'continue.md'), 'utf8'), v),
      promise, maxIterations: c.maxIterations, signal: ctx.signal,
      onEvent: (ev) => {
        appendFileSync(eventLog, JSON.stringify(ev) + '\n');
        const rl = rateLimitOf(ev);
        if (rl) ctx.rateLimit(rl);
      },
      onTurn: (i, sessionId, t) => {
        sessionTokens += totalTokens(t.usage);
        ctx.progress(key, i, sessionTokens);
        recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: n, role, sessionId, iteration: i, model: c.model,
          ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns });
        log(`${role} turn ${i}: ${t.ok ? 'ok' : 'error'} · ${fmt(totalTokens(t.usage))} tokens (${fmt(t.usage.output)} out) · ${Math.round(t.durationMs / 1000)}s${t.error ? ` · ${t.error.slice(0, 160)}` : ''}`, n);
      },
    });
  };
  log(`working in ${wt.dir}${wt.resumed ? ' (resuming earlier work)' : ''}`, n);

  const keepOnStop = a.kind === 'impl'; // only an implementation worktree can hold unpushed work
  const handBack = async (r: GoalResult, summary: string) => {
    // not a failure of the issue: hand it back untouched
    await gh.editLabels(c.repo, n, [], [L.working]).catch(() => {});
    if (!keepOnStop) await removeWorktree(p.root, wt.dir);
    const what = { aborted: 'stopped', limited: 'paused by usage limit', fatal: `stopped by a setup error (${r.last?.error?.slice(0, 200)})` }[r.stopReason as 'aborted'];
    log(`${what} — released (${summary})${keepOnStop ? '; worktree kept' : ''}`, n);
    return r;
  };
  const fail = async (r: GoalResult, reason: string, summary: string) => {
    await gh.comment(c.repo, n, `**hx:** ${a.kind} stopped — ${reason} (${summary}).\n\nLast reply:\n\n${(r.last?.text ?? '').slice(-1500).replace(/^/gm, '> ')}\n\n${a.kind === 'impl' ? `Work is on branch \`issue/${n}\` if it was pushed. ` : ''}Remove the \`${L.blocked}\` label to let hx try again.`).catch(() => {});
    await gh.editLabels(c.repo, n, [L.blocked], [L.working]).catch(() => {});
    if (!keepOnStop) await removeWorktree(p.root, wt.dir);
    log(`${a.kind} FAILED ✗ — ${reason} (${summary}); labelled ${L.blocked}${keepOnStop ? ', worktree kept' : ''}`, n);
    return { ...r, done: false };
  };
  const stopped = (r: GoalResult) => r.stopReason === 'aborted' || r.stopReason === 'limited' || r.stopReason === 'fatal';
  const promise = `${a.kind === 'impl' ? 'ISSUE' : a.kind.toUpperCase()} ${n} DONE`;

  // gauntlet: one round = a critic in a fresh checkout; on FAIL a reviser rewrites the PRD body
  if (a.kind === 'gauntlet') {
    let reviseDir = '';
    try {
      const N = c.gauntletRounds;
      const cr = await goal('critic', wt.dir, 'critic.md', `CRITIC ${n} DONE`);
      await removeWorktree(p.root, wt.dir);
      let summary = `${fmt(sessionTokens)} tokens`;
      if (stopped(cr)) return handBack(cr, summary);
      const v = auditVerdict(cr.done ? cr.last?.text ?? '' : '');
      if (!v) return fail(cr, cr.done ? 'the critic gave no VERDICT line'
        : cr.stopReason === 'max-iterations' ? `no completion after ${cr.iterations} turns` : `agent error: ${cr.last?.error ?? 'unknown'}`, summary);
      if (v.pass) {
        await gh.comment(c.repo, n, `${GAUNTLET_MARKER}\n**hx gauntlet round ${round}/${N}: PASS ✓**\n\n${v.findings}`).catch(() => {});
        await gh.editLabels(c.repo, n, [L.hardened], [L.working]);
        log(`gauntlet round ${round}/${N}: PASS ✓ — labelled ${L.hardened} (${summary})`, n);
        return { ...cr, done: true };
      }
      log(`gauntlet round ${round}/${N}: FAIL ✗ — ${v.findings.split('\n')[0].slice(0, 140)}`, n);
      const before = await gh.issueBody(c.repo, n);
      // keep the body as it was before the first revision, once
      if (!(await gh.commentBodies(c.repo, n)).some(firstLineIs(ORIGINAL_MARKER)))
        await gh.comment(c.repo, n, `${ORIGINAL_MARKER}\n${before}`);
      const rwt = await addWorktree(p.root, c.worktreeRoot, prdWorktree(n, c.defaultBranch));
      reviseDir = rwt.dir;
      const rr = await goal('revise', rwt.dir, 'revise.md', `REVISE ${n} DONE`, { FINDINGS: v.findings });
      await removeWorktree(p.root, rwt.dir);
      summary = `${fmt(sessionTokens)} tokens`;
      if (stopped(rr)) return handBack(rr, summary);
      // a reviser that failed or changed nothing still uses up the round: the PRD must not stall here
      const unchanged = (await gh.issueBody(c.repo, n)) === before;
      if (!rr.done || unchanged)
        log(`reviser ${!rr.done ? `did not complete (${rr.last?.error ?? rr.stopReason})` : 'left the body unchanged'} — round ${round} counted, carrying on`, n);
      const note = !rr.done ? '\n\n_The reviser did not complete._' : unchanged ? '\n\n_The reviser left the body unchanged._' : '';
      await gh.comment(c.repo, n, `${GAUNTLET_MARKER}\n**hx gauntlet round ${round}/${N}: FAIL ✗ → revised**\n\n${v.findings}${note}`);
      const last = round >= N;
      await gh.editLabels(c.repo, n, last ? [L.hardened] : [], [L.working]);
      log(`gauntlet round ${round}/${N} done${last ? ` — round cap reached, labelled ${L.hardened}` : ''} (${summary})`, n);
      return { ...rr, done: true };
    } catch (e) {
      // every path ends with the claim released and no worktree left behind
      await gh.editLabels(c.repo, n, [], [L.working]).catch(() => {});
      await removeWorktree(p.root, wt.dir);
      if (reviseDir) await removeWorktree(p.root, reviseDir);
      throw e;
    }
  }

  if (!audited) {
    const r = await goal(a.kind, wt.dir, `${a.kind}.md`, promise);
    const summary = `${r.iterations} turn(s), ${fmt(totalTokens(r.usage))} tokens`;
    if (r.stopReason === 'aborted' && a.kind === 'impl' && r.iterations > 0) await checkpoint(p, n, r.sessionId, wt.dir, vars, eventLog);
    if (stopped(r)) return handBack(r, summary);
    const why = await verify(p, a, n);
    if (!why) {
      await gh.editLabels(c.repo, n, [], [L.working]).catch(() => {});
      await removeWorktree(p.root, wt.dir);
      log(`${a.kind} DONE ✓ (${summary})`, n);
      if (a.kind === 'impl') ctx.merged?.();
      return { ...r, done: true };
    }
    return fail(r, r.done ? why : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`, summary);
  }

  // implement → independent audit → (hx merges | back to the implementer with the findings)
  let extra: Record<string, string | number> = {};
  for (let attempt = 1; ; attempt++) {
    const r = await goal('impl', wt.dir, 'impl.md', promise, extra);
    let summary = `${fmt(sessionTokens)} tokens so far`;
    if (r.stopReason === 'aborted' && r.iterations > 0) await checkpoint(p, n, r.sessionId, wt.dir, vars, eventLog);
    if (stopped(r)) return handBack(r, summary);
    const pr = r.done ? await gh.openPrFor(c.repo, `issue/${n}`) : null;
    if (!pr) return fail(r, r.done ? 'the implementer reported ready but no open PR for its branch exists'
      : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`, summary);

    // the auditor works in its own fresh checkout of the pushed branch and never sees the implementer's session
    const awt = await addWorktree(p.root, c.worktreeRoot, auditWorktree(n));
    log(`audit ${attempt}/${c.auditRounds}: PR #${pr}`, n);
    const ar = await goal('audit', awt.dir, 'audit.md', `AUDIT ${n} DONE`, { PR: pr, ROUND: attempt, ROUNDS: c.auditRounds });
    await removeWorktree(p.root, awt.dir);
    summary = `${fmt(sessionTokens)} tokens`;
    if (stopped(ar)) return handBack(ar, summary);
    const v = auditVerdict(ar.done ? ar.last?.text ?? '' : '');
    if (!v) return fail(ar, ar.done ? 'the auditor gave no VERDICT line' : `audit did not complete: ${ar.last?.error ?? ar.stopReason}`, summary);
    await gh.comment(c.repo, n, `${AUDIT_MARKER}\n**hx audit ${attempt}/${c.auditRounds}: ${v.pass ? 'PASS ✓' : 'FAIL ✗'}** (PR #${pr})\n\n${v.findings}`).catch(() => {});
    log(`audit ${v.pass ? 'PASS ✓' : 'FAIL ✗'}${v.pass ? '' : ` — ${v.findings.split('\n')[0].slice(0, 140)}`}`, n);

    let feedback: string, why: string;
    if (v.pass) {
      const m = await mergeAudited(wt.dir);
      // the repo only took an auto-merge: it lands within moments, wait for it rather than fail
      if (!m.ok && /AUTO-MERGE set/.test(m.output)) m.ok = await waitClosed(c.repo, n, 10 * 60_000);
      if (m.ok && (await gh.issueState(c.repo, n)) === 'CLOSED') {
        const shipped = await shipInfo(wt.dir);
        await gh.editLabels(c.repo, n, [], [L.working]).catch(() => {});
        await removeWorktree(p.root, wt.dir);
        log(`DONE ✓ audited and merged (${attempt} round(s), ${summary})`, n);
        ctx.merged?.(shipped?.test);
        return { ...r, done: true };
      }
      if (!m.retry) return fail(r, `merging the audited PR failed: ${m.output.slice(-300)}`, summary);
      feedback = `The audit passed, but merging failed after rebasing on the latest ${c.defaultBranch}:\n\n${m.output.slice(-1500)}\n\nFix that on your branch, then ship again with --no-merge.`;
      why = `merge after audit failed (${m.code === 3 ? 'rebase conflict' : 'tests fail after the rebase'})`;
    } else {
      feedback = `An independent audit of PR #${pr} FAILED with these findings — fix every one (add a test for each), then ship again with --no-merge:\n\n${v.findings}`;
      why = 'audit failed';
    }
    if (attempt >= c.auditRounds) return fail(r, `still not passing after ${attempt} audit round(s); last findings: ${feedback.slice(0, 400)}`, summary);
    // say why the PR goes back, in the log and on the issue, so the extra round is not a mystery
    const back = `${why} — back to the implementer, round ${attempt + 1}/${c.auditRounds}`;
    log(back, n);
    await gh.comment(c.repo, n, `${RETRY_MARKER}\n**hx:** ${back} (PR #${pr})`).catch(() => {});
    extra = { RESUMED: `NOTE: this branch already has your earlier work (PR #${pr} is open).\n${feedback}\n` };
  }
}

export const AUDIT_MARKER = '<!-- hx-audit -->';
export const RETRY_MARKER = '<!-- hx-retry -->';

/** The auditor's verdict from its final message, or null when it gave none. */
export function auditVerdict(text: string): { pass: boolean; findings: string } | null {
  const m = /VERDICT:\s*\**\s*(PASS|FAIL)\b/i.exec(text);
  if (!m) return null;
  const f = /FINDINGS:\s*([\s\S]*?)(?:<promise>|$)/i.exec(text.slice(m.index));
  return { pass: m[1].toUpperCase() === 'PASS', findings: (f?.[1] ?? '').trim() || '(none given)' };
}

/** Poll until the issue is closed (an auto-merge landed), up to `ms`. */
async function waitClosed(repo: string, n: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10_000)))
    if ((await gh.issueState(repo, n)) === 'CLOSED') return true;
  return false;
}

/** What the implementer's `ship --no-merge` recorded in its worktree (repo, base, test command, PR). */
async function shipInfo(cwd: string): Promise<{ test?: string } | null> {
  const dir = (await runCmd('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
  try { return JSON.parse(readFileSync(path.join(dir, 'hx-ship.json'), 'utf8')); } catch { return null; }
}

/** Rebase, re-test, push and merge the audited branch (ship.mjs --resume, run by hx, not by an agent). */
function mergeAudited(cwd: string): Promise<{ ok: boolean; retry: boolean; code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SHIP, '--resume'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      // 3 = rebase conflict, 4 = tests fail after the rebase: the implementer can fix those
      resolve({ ok: code === 0 && /SHIPPED #/.test(stdout), retry: code === 3 || code === 4, code, output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

/**
 * The run is stopping mid-session: resume the session once more and have it commit and push its
 * WIP and leave a handoff comment, so the next session picks up where this one stopped.
 */
async function checkpoint(p: Project, n: number, sessionId: string, cwd: string, vars: Record<string, string | number>, eventLog: string): Promise<void> {
  const c = p.config;
  log('checkpointing: committing WIP and writing a handoff note…', n);
  const t = await runTurn({ bin: c.claudeBin, cwd, model: c.model, effort: c.effort, extraArgs: workerArgs(c),
    timeoutMs: c.checkpointMinutes * 60_000, sessionId, resume: true,
    prompt: render(readFileSync(path.join(PROMPTS, 'checkpoint.md'), 'utf8'), vars),
    onEvent: (ev) => appendFileSync(eventLog, JSON.stringify(ev) + '\n') });
  recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: n, role: 'checkpoint', sessionId, iteration: 0, model: c.model,
    ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns });
  log(t.ok ? `checkpoint saved (${fmt(totalTokens(t.usage))} tokens)` : `checkpoint failed: ${t.error?.slice(0, 160)} — the worktree still has the work`, n);
}

/** Did the session leave GitHub in the state its role promises? null = yes, else why not. */
async function verify(p: Project, a: SessionAction, n: number): Promise<string | null> {
  const c = p.config;
  if (a.kind === 'impl') return (await gh.issueState(c.repo, n)) === 'CLOSED' ? null : 'the agent reported done but the issue is still open';
  const all = await gh.listIssues(c.repo);
  const kids = all.filter((i) => {
    const par = parseParent(i.body, c.repo);
    return par && par.repo.toLowerCase() === c.repo.toLowerCase() && par.number === n;
  });
  if (a.kind === 'decompose') return kids.length ? null : 'the agent reported done but filed no issue with `## Parent` #' + n;
  const signedOff = all.find((i) => i.number === n)?.labels.includes(c.labels.reviewed);
  const gaps = kids.some((k) => k.state === 'OPEN');
  return signedOff || gaps ? null : `the review neither added \`${c.labels.reviewed}\` nor filed a gap issue`;
}
