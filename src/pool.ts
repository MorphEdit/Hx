import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoWorkersConfigError, DEFAULTS, effectiveRtddBin, formatRoleModels, ghReservePctError, healthConfigError, labelSpecs, modelMatches, roleModel, roleModelMap, roleModelsError, testPatternsError, workerArgs, worktreeCopyError, type Config, type LabelSpec, type Project } from './config.ts';
import * as gh from './github.ts';
import type { Issue } from './github.ts';
import { hhmm, reserveState, type GhBudget } from './ghlimit.ts';
import { claimable, externalRefs, fenceFindings, isTrusted, issueKey, openQuestions, parseBlockedBy, parseParent, plan, prdKey, PROMISE_RE, refKey, render, TRIAGE_MARKER, triageVerdict, trustedSet, type Action, type Plan } from './state.ts';
import { addWorktree, auditWorktree, cleanStaleWorktrees, implWorktree, prdWorktree, removeWorktree, repairBrokenRefs, selfReviewWorktree, sweepWorktrees, triageWorktree, type AddedWorktree } from './worktree.ts';
import { emptyUsage, runGoal, runTurn, type GoalResult, type RateLimit } from './agent.ts';
import { clearSetupRecord, readSetupRecord, setupLine, setupNote, setupWorktree, writeSetupRecord, type SetupResult } from './setup.ts';
import { agentFor, type AgentCli } from './agents/index.ts';
import { clearLive, otherRunner, pidAlive, readLive, readPause, writeLive, type LiveSession, type LiveState } from './runstate.ts';
import { fmt, recordUsage, totalTokens } from './usage.ts';
import { testMatcher, turnTiming, type TurnTiming } from './timing.ts';
import { actionBudget, budgetFilter, newSkipLines, readBudget, readBudgetWindows, readingOf, recordReading, type Budget } from './budget.ts';
import { healthPass, renderResult } from './health.ts';
import { appendGateRun, gateIssueBody, gateIssueTitle, readGate, readGateRuns, remoteSha, runGate, slowGateWarning, writeGate, type GateResult } from './gate.ts';
import { run as runCmd } from './exec.ts';
import { dueRelease, release, releaseGate } from './release.ts';
import { acquireSlot, DEFAULT_FLEET_WORKERS, readGithubHold, readHold, releaseSlot, writeGithubHold, writeHold } from './fleet.ts';
import { checkGit, checkRelease, crashRollback, currentVersion, gateAtOld, handover, hxRoot, installKind, readSelfUpdate, restart, rollbackWatch, selfUpdateConfigError, sessionOutcome, short,
  updateSelfUpdate, watchEvent, watchGood, watchOpen, watchVerdict, writeSelfUpdate, type Check, type WatchEvent } from './selfupdate.ts';
import { findingBody, parseFindings, readSelfReview, selfReviewDecision, SELFREVIEW_PROMISE, writeSelfReview } from './selfreview.ts';
import { BAR_JUDGE_PROMISE, BAR_PROMISE, barCapComment, barLine, barMarker, barRound, barStatus, gapIssueBody, parseJudgeReply, pickMapping, readMapping, refDir, roundDir, writeMapping, type Side } from './bar.ts';
import { parseQualityBar } from './prd.ts';
import { cappedQuestion, cappedQuestionNote, IMPL_TOO_MANY_QUESTIONS, ownerAnswer, ownerAnswerNote, questionFromReply, TOO_MANY_QUESTIONS } from './question.ts';
import { HELD_STATUS, heldComment, mergeFailure, readHeld, setHeld } from './held.ts';
import { addBlockers, narrowedBody, narrowedComment, parseSizeReply, SIZE_FITS, SIZE_NARROWED, SIZE_SPLIT, withTrailers, type SizeChild } from './size.ts';
import { appendSkills, resolveSkills, rtddCheck, rtddEnv, SKILL_CHECKS, skillNames, skillsLogLine, type Skill } from './skills.ts';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
/** Tries in a row at one sha before a failing worktree setup turns the gate red. */
const SETUP_TRIES = 3;
/** How often a run reads the GitHub API budget (gh api rate_limit), at most. */
const GH_BUDGET_READ_MS = 60_000;
// the one-call commit → rebase → test → push → PR → merge → close routine (forward slashes: the agent's shell may be bash)
const SHIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ship.mjs').replace(/\\/g, '/');
// how agents read an issue: it prints only the comments by accounts in HX_TRUSTED
export const ISSUE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'issue.mjs').replace(/\\/g, '/');

/** The env every Claude session gets: HX_TRUSTED = the trusted set, which scripts/issue.mjs filters comments by. */
export function trustedEnv(trusted: Set<string>): { HX_TRUSTED: string } {
  return { HX_TRUSTED: [...trusted].join(',') };
}
export const REVIEW_MARKER = '<!-- hx-review -->';
export const HANDOFF_MARKER = '<!-- hx-handoff -->';
export const GAUNTLET_MARKER = '<!-- hx-gauntlet -->';
export const ORIGINAL_MARKER = '<!-- hx-prd-original -->';
export const SECURITY_MARKER = '<!-- hx-security -->';
export const BAR_MARKER = '<!-- hx-bar round=';
const firstLineIs = (marker: string) => (b: string) => b.trimStart().split(/\r?\n/, 1)[0].trim() === marker;

/** Review rounds that count against reviewRounds, from a PRD's trusted comment bodies in order: the
 *  `<!-- hx-review -->` comments after the latest one whose first line starts with `<!-- hx-bar round=`. */
export function reviewRoundsDone(bodies: string[]): number {
  let n = 0;
  for (const b of bodies) {
    if (b.trimStart().split(/\r?\n/, 1)[0].trim().startsWith(BAR_MARKER)) n = 0;
    else if (b.trimStart().startsWith(REVIEW_MARKER)) n++;
  }
  return n;
}

type SessionAction = Extract<Action, { kind: 'impl' | 'gauntlet' | 'decompose' | 'review' | 'security' | 'triage' | 'bar' }>;

export interface PoolOptions {
  workers: number;
  watch: boolean; // keep polling for new issues instead of exiting when the board is empty
  dryRun: boolean;
  only?: number[]; // issue or PRD numbers
  signal: AbortSignal;
}

/** Where `hx run` keeps its log: `<stateDir>/run.log` (one old file, `run.log.1`). */
export const runLogFile = (stateDir: string) => path.join(stateDir, 'run.log');

let runLog: { file: string; maxBytes: number } | null = null;

/** Also append every log() line to `file` (null = console only). */
export function setRunLog(file: string | null, maxBytes = 2 * 1024 * 1024): void {
  runLog = file ? { file, maxBytes } : null;
}

export function log(msg: string, issue?: number): void {
  const now = new Date();
  console.log(`${now.toTimeString().slice(0, 8)} ${issue ? `[#${issue}] ` : ''}${msg}`);
  if (!runLog) return;
  // `<ISO> [#<n>] <msg>` or `<ISO> <msg>` (the console line with an ISO time), one line per call; a write failure drops the line
  try {
    const { file, maxBytes } = runLog;
    mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch {}
    if (size > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, `${now.toISOString()} ${issue ? `[#${issue}] ` : ''}${msg.replace(/\r?\n|\r/g, ' ')}\n`);
  } catch {}
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// the colour and description of each label hx adds, set by ensureBoardLabels (a label relabel creates)
const labelSpecByName = new Map<string, LabelSpec>();

/** The labels of `add` that gh's error names as not found ("'bug-triaged' not found"). */
export function missingLabels(error: string, add: string[]): string[] {
  return add.filter((l) => error.includes(`'${l}' not found`));
}

/**
 * Make sure every label hx may add exists in the repo, creating the missing ones (a repo set up by an older
 * `hx init`). Idempotent: an existing label is left alone. A failed lookup is logged, never fatal.
 */
export async function ensureBoardLabels(c: Project['config']): Promise<string[]> {
  const specs = labelSpecs(c.labels);
  for (const s of specs) labelSpecByName.set(s.name, s);
  let have: Set<string>;
  try { have = await gh.listLabels(c.repo); } catch (e: any) {
    log(`could not list the labels of ${c.repo}: ${String(e?.message ?? e).trim().slice(0, 200)}`);
    return [];
  }
  const created: string[] = [];
  for (const s of specs) {
    if (have.has(s.name)) continue;
    await gh.ensureLabel(c.repo, s.name, s.color, s.description);
    created.push(s.name);
  }
  if (created.length) log(`created missing labels: ${created.join(', ')}`);
  return created;
}

/**
 * Swap labels on an issue (usually agent-working for another), retried: a failed edit that is swallowed
 * leaves the issue agent-working, and hx never claims it again. Still failing → a warning naming the issue.
 */
export async function relabel(repo: string, n: number, add: string[], remove: string[] = [], attempts = 3): Promise<boolean> {
  const wait = Number(process.env.HX_LABEL_RETRY_MS ?? 2000);
  let created = false;
  for (let i = 1; ; i++) {
    try { await gh.editLabels(repo, n, add, remove); return true; } catch (e: any) {
      // a label missing from the repo fails every try: create it and retry once, right away
      const missing = created ? [] : missingLabels(String(e?.message ?? e), add);
      if (missing.length) {
        created = true;
        for (const name of missing) {
          const spec = labelSpecByName.get(name) ?? { name, color: 'ededed', description: 'hx' };
          await gh.ensureLabel(repo, name, spec.color, spec.description);
          log(`created the missing label ${name}`, n);
        }
        i--;
        continue;
      }
      if (i >= attempts) {
        const what = [...add.map((l) => `+${l}`), ...remove.map((l) => `-${l}`)].join(' ');
        log(`WARNING: could not change the labels of #${n} (${what}) after ${attempts} tries: ${String(e?.message ?? e).trim().slice(0, 200)} — fix them by hand`, n);
        return false;
      }
      await pause(wait * i);
    }
  }
}

/**
 * The open PR for `branch`. A PR created moments ago can be missing from `gh pr list --head` for a while, so
 * the list is asked again with backoff (about 30 s in all), then `gh pr view <branch>` is the last try.
 */
export async function findOpenPr(repo: string, branch: string): Promise<number | null> {
  const unit = Number(process.env.HX_PR_RETRY_MS ?? 2000);
  for (const w of [1, 2, 4, 8]) {
    const pr = await gh.openPrFor(repo, branch);
    if (pr) return pr;
    await pause(w * unit);
  }
  return (await gh.openPrFor(repo, branch)) ?? (await gh.viewOpenPr(repo, branch));
}

/** How a session reports back to the pool while it runs. */
interface WorkContext {
  signal: AbortSignal; // aborted = stop now (Ctrl+C, pause --now): checkpoint and hand back
  started: (s: LiveSession) => void;
  progress: (key: string, turn: number, tokens: number) => void;
  rateLimit: (rl: RateLimit) => void;
  merged?: (testCommand?: string) => void; // a PR reached the default branch: the CI gate re-tests it
  mainGate?: () => Promise<{ last?: GateResult; fixIssue?: number }>; // the gate's result for the default branch as it is now (gate off: none)
  trusted: Set<string>; // this run's trusted set: only their comments count in hx's own logic; passed to every session as HX_TRUSTED
  login?: string; // hx's own gh login: only its comments count as size markers (no login: no size check)
  skills?: Record<string, Skill[]>; // role → the skills appended to its prompt, resolved once per run
  agent?: AgentCli; // the agent CLI sessions run on (config.agentCli), resolved once per run
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

/** Wait for `ms`, a stop, or the first of `others` — whichever comes first. The timer never outlives the wait:
 *  a 600 s poll left pending after a wake would keep the process alive after the pool returns. */
export async function waitAny(ms: number, signal: AbortSignal, others: Promise<unknown>[]): Promise<void> {
  const done = new AbortController();
  const stopped = () => done.abort();
  signal.addEventListener('abort', stopped, { once: true });
  try { await Promise.race([sleep(ms, done.signal), ...others]); } finally { signal.removeEventListener('abort', stopped); done.abort(); }
}

/** The trusted set for this run: the gh login + config.trustedAuthors. Throws if gh cannot tell the login. */
export async function lookupTrusted(c: Project['config']): Promise<Set<string>> {
  return trustedSet(await gh.ghLogin(), c.trustedAuthors ?? []);
}

/** The board as the pool sees it: every issue, with every blocker's state resolved. */
export async function readPlan(p: Project, trusted: Set<string>, busy: Set<string> = new Set()): Promise<Plan> {
  if (!trusted.size) throw new Error('no trusted authors: refusing to read the board without the author filter');
  const { repo, labels } = p.config;
  const [issues, own] = await Promise.all([gh.listIssues(repo), gh.allStates(repo)]);
  const states = new Map<string, 'OPEN' | 'CLOSED'>();
  for (const [n, s] of own) states.set(refKey({ repo, number: n }), s);
  for (const r of externalRefs(issues.filter((i) => i.state === 'OPEN'), repo)) {
    const s = await gh.issueState(r.repo, r.number);
    if (s) states.set(refKey(r), s);
  }
  const pl = plan(issues, repo, labels, states, busy, { ...p.config, trusted });
  // an audited PR held while the default branch is red (#301): claimable once the gate is green, shown as held
  const held = readHeld(p.stateDir);
  for (const r of pl.board) if (r.status === 'claimable' && held[r.number]) r.held = true;
  return pl;
}

/**
 * Each open needs-human issue with a trusted answer after its question: needs-human swapped for ready, logged.
 * Returns how many were relabelled. A failed read leaves that issue for the next poll.
 */
export async function answeredQuestions(p: Project, pl: Plan, trusted: Set<string>): Promise<number> {
  const { repo, labels: L } = p.config;
  let n = 0;
  for (const q of pl.questions) {
    const t = await gh.issueThread(repo, q.number).catch(() => null);
    if (!t || !ownerAnswer(t, trusted)) continue;
    if (await relabel(repo, q.number, [L.ready], [L.needsHuman])) { n++; log(`the owner answered — ${L.needsHuman} → ${L.ready}`, q.number); }
  }
  return n;
}

/** Adds each quality-bar PRD's round and last result (hx status, the dashboard): its trusted comments are
 *  fetched only for the PRDs whose body has the section, so a board without one costs no extra gh call. */
export async function readBar(p: Project, pl: Plan, trusted: Set<string>): Promise<Plan> {
  for (const r of pl.prds)
    if (r.qualityBar) r.bar = barStatus(await gh.commentBodies(p.config.repo, r.number, trusted), p.config.barRounds);
  return pl;
}

const target = (a: Action) => ('issue' in a ? a.issue : a.prd);
const keyOf = (a: SessionAction) => ('issue' in a ? issueKey(a.issue) : prdKey(a.prd));

const who = (author: string | undefined) => `@${author || 'ghost'}`;

/** Why a row is untrusted, for hx status / --dry-run: `(by @x) ` or `(parent #12 by @x) `. */
function untrustedNote(r: { author?: string; untrustedPrd?: { number: number; author: string } }): string {
  if (r.untrustedPrd) return `(parent #${r.untrustedPrd.number} by ${who(r.untrustedPrd.author)}) `;
  return r.author !== undefined ? `(by ${who(r.author)}) ` : '';
}

/** The run-log line for an untrusted ready issue or PRD (a child of an untrusted PRD gets none: the PRD's line covers it). */
export function skipLine(r: { number: number; author?: string }): string {
  return `#${r.number} skipped: opened by ${who(r.author)}, who is not trusted (add them to trustedAuthors to allow)`;
}

export function printPlan(pl: Plan, repo: string): void {
  const refs = (rs: { repo: string; number: number }[]) => rs.map((w) => (w.repo === repo ? '' : w.repo) + '#' + w.number).join(', ');
  for (const r of pl.prds)
    console.log(`  PRD #${String(r.number).padEnd(4)} ${r.status.padEnd(13)} ${untrustedNote(r)}${r.title.slice(0, 50)}  [${r.closed}/${r.open + r.closed} done]${r.waitingOn.length ? `  waits on ${refs(r.waitingOn)}` : ''}${r.bar ? `
             ${barLine(r.bar)}` : ''}`);
  if (pl.prds.length) console.log('');
  for (const r of pl.board)
    console.log(`  #${String(r.number).padEnd(8)} ${(r.held ? HELD_STATUS : r.status).padEnd(13)} ${untrustedNote(r)}${r.title.slice(0, 60)}${r.waitingOn.length ? `  waits on ${refs(r.waitingOn)}` : ''}`);
}

/** The --dry-run `next:` listing: each action with its forecast (`~7%`) when it has one, `(budget: skip)` when the gate would skip it. */
export function nextListing(actions: Action[], b: Budget, gate: boolean): string {
  return actions.map((a) => {
    const { pct, block } = actionBudget(a, b);
    return `${a.kind} #${target(a)}${pct !== undefined ? ` ~${Math.round(pct)}%` : ''}${gate && block ? ' (budget: skip)' : ''}`;
  }).join(', ');
}

export async function runPool(p: Project, o: PoolOptions): Promise<number> {
  // a rate-limited gh call waits and retries only inside this run (the wait signal is set after --dry-run returns)
  try { return await pool(p, o); } finally { gh.setGhWaitSignal(undefined); gh.onGhLimited(undefined); }
}

async function pool(p: Project, o: PoolOptions): Promise<number> {
  const c = p.config;
  // an unknown agentCli stops the run before anything reads the board
  const agent = agentFor(c.agentCli);
  setRunLog(runLogFile(p.stateDir));
  // a bad roleModels stops the run before anything reads or claims the board
  const badModels = roleModelsError(c.roleModels);
  if (badModels) { log(`STOPPED: ${badModels}`); return 2; }
  const badCopy = worktreeCopyError(c.worktreeCopy);
  if (badCopy) { log(`STOPPED: ${badCopy}`); return 2; }
  const badReserve = ghReservePctError(c.ghReservePct);
  if (badReserve) { log(`STOPPED: ${badReserve}`); return 2; }
  const badPatterns = testPatternsError(c.testPatterns);
  if (badPatterns) { log(`STOPPED: ${badPatterns}`); return 2; }
  const badHealth = healthConfigError(c);
  if (badHealth) { log(`STOPPED: ${badHealth}`); return 2; }
  const badSelfUpdate = selfUpdateConfigError(c);
  if (badSelfUpdate) { log(`STOPPED: ${badSelfUpdate}`); return 2; }
  const badAuto = autoWorkersConfigError(c);
  if (badAuto) { log(`STOPPED: ${badAuto}`); return 2; }
  // who may put work on the board: looked up once per run; without it nothing is read or claimed
  let trusted: Set<string>, login: string;
  try { login = await gh.ghLogin(); trusted = trustedSet(login, c.trustedAuthors ?? []); } catch (e: any) { log(`STOPPED: ${e.message}`); return 2; }
  if (o.dryRun) {
    const pl = await readPlan(p, trusted);
    printPlan(pl, c.repo);
    console.log(pl.actions.length ? `\nnext: ${nextListing(pl.actions.slice(0, o.workers + 5), readBudget(p.stateDir, c, new Date()), c.budgetGate)}` : '\nnothing to do');
    return 0;
  }
  // from here a rate-limited gh call waits out the limit and retries; Ctrl+C ends the wait
  gh.setGhWaitSignal(o.signal);
  // started by a self-update (#253): the old runner (idle, claiming nothing) hands its run lock over and exits once ready
  let ho = handover();
  const other = otherRunner(p.stateDir);
  if (other && other.pid !== ho?.from) { log(`hx is already running for this repo (pid ${other.pid}, since ${other.startedAt}). Use hx status / hx pause.`); return 3; }
  const pausedMode = readPause(p.stateDir);
  if (pausedMode) { log(`paused (${pausedMode}) — run  hx resume  first.`); return 3; }
  // the self-update (#253) is off under hx fleet run: the fleet owns its children
  const fleetChild = !!process.env.HX_FLEET_DIR || !!process.send;
  const runArgs = ['run', '--watch', '--workers', String(o.workers), ...(o.only?.length ? ['--issue', o.only.join(',')] : [])];
  // a runner a self-update started crashed (its run lock is left behind) inside its watch window (#316): back to the
  // old version and a runner on it before anything else; that runner hands the crashed run's issues back
  const prevRun = readLive(p.stateDir);
  if (o.watch && !fleetChild && prevRun && prevRun.pid !== process.pid && !pidAlive(prevRun.pid)) {
    const root = hxRoot();
    if (await crashRollback(p.stateDir, root, `the runner crashed (pid ${prevRun.pid})`, (l) => log(l))) {
      const r = await restart({ root, args: runArgs, cwd: p.root, stateDir: p.stateDir });
      if (r.ok) { log(`self-update: restarted — pid ${r.pid} took over`); return 0; }
      log(`self-update: the runner on the old version did not start (${r.reason}) — carrying on`);
    }
  }

  // skills: resolved once per run (rtdd only when its binary works and .rtdd/ is on origin)
  const skills = await resolveSkills(p.root, c.roleSkills ?? {}, c.skillMaxChars,
    { checks: { ...SKILL_CHECKS, rtdd: rtddCheck(p.root, c.defaultBranch, effectiveRtddBin(c)) } });
  for (const l of skills.lines) log(l);
  log(skillsLogLine(skills.byRole));
  const models = roleModelMap(c);
  const differ = formatRoleModels(models, c);
  if (differ) log(`models: ${differ}`);

  // Ctrl+C (o.signal) and `hx pause --now` both stop running sessions with a checkpoint
  const stop = new AbortController();
  o.signal.addEventListener('abort', () => stop.abort(), { once: true });
  gh.setGhWaitSignal(stop.signal);
  const live: LiveState = { pid: process.pid, startedAt: new Date().toISOString(), repo: c.repo, workers: o.workers, sessions: [], skills: skillNames(skills.byRole), models };
  let handedOff = false; // a self-update's new runner may own live.json now: this one writes it no more
  const save = () => { if (!handedOff) try { writeLive(p.stateDir, live); } catch {} };
  // HX_FLEET_DIR: every session also holds one of HX_FLEET_WORKERS file slots shared with the other runners
  const fleetDir = process.env.HX_FLEET_DIR || undefined;
  const fleetCap = Number(process.env.HX_FLEET_WORKERS) || DEFAULT_FLEET_WORKERS;
  // a gh call waiting out a rate limit: budget-low until the wait ends (no new claims, github-hold.json in a fleet)
  let ghWaitUntil = 0;
  let ghWaitLogged = 0; // the wait-until last logged: once per wait-until
  gh.onGhLimited((until) => {
    if (until > ghWaitUntil) {
      ghWaitUntil = until;
      if (!live.githubLow || until > live.githubLow.until) { live.githubLow = { until, reason: 'github rate limited' }; save(); }
      if (fleetDir) writeGithubHold(fleetDir, { until, reason: 'github rate limited', repo: c.repo });
    }
    if (until !== ghWaitLogged) { ghWaitLogged = until; log(`github rate limited — waiting until ${hhmm(until / 1000)}`); }
  });
  // processes left running in a worktree no session uses (#328): one line per directory with something killed
  const sweepLeftovers = async (skip: string[] = []) => {
    for (const x of await sweepWorktrees(c.worktreeRoot, skip).catch(() => [])) log(`health: killed ${x.killed} leftover process(es) in ${x.name}`);
  };
  // a crash mid-write can leave an hx branch ref full of NUL bytes: repair it before anything uses the branch
  await repairBrokenRefs(p.root, c.worktreeRoot, (m) => log(m)).catch((e) => log(`could not check branch refs: ${e.message}`));
  await ensureBoardLabels(c);
  await recoverStaleClaims(p);
  // no session runs yet: what a crashed or killed one left running in its worktree goes first (it holds the directory open)
  await sweepLeftovers();
  // a removal that failed last run (a file held open on Windows) left its directory behind; no session runs yet
  for (const d of await cleanStaleWorktrees(p.root, c.worktreeRoot).catch(() => [])) log(`removed leftover directory ${d}`);
  // budget-low: the GitHub API budget is below ghReservePct. Before `until` (ms epoch) nothing is claimed, engine steps
  // included, and the board is not read. Kept apart from the usage hold (live.pausedUntil): anything that learns the
  // budget is short calls githubLow(until, reason). shared: copied from github-hold.json, never written back.
  let ghLow: { until: number; reason: string; shared: boolean } | null = null;
  let ghLowLogged = 0; // the until last logged: the low line is written once per reset
  const ghLowActive = () => ghLow !== null && Date.now() < ghLow.until;
  const githubLowNow = () => ghLowActive() || Date.now() < ghWaitUntil;
  const githubLowLeft = () => Math.max(ghLowActive() ? ghLow!.until : 0, ghWaitUntil) - Date.now();
  const githubLow = (until: number, reason: string, shared = false) => {
    if (until <= Date.now() || (ghLowActive() && until <= ghLow!.until)) return;
    ghLow = { until, reason, shared }; live.githubLow = { until, reason }; save();
    if (fleetDir && !shared) writeGithubHold(fleetDir, { until, reason, repo: c.repo });
    if (until !== ghLowLogged) { ghLowLogged = until; log(`github budget low: ${reason} — no new claims until ${hhmm(until / 1000)}`); }
  };
  const sharedGithubHold = () => {
    const h = fleetDir ? readGithubHold(fleetDir) : null;
    if (h) githubLow(h.until, `shared hold from ${h.repo}: ${h.reason}`, true);
  };
  // the GitHub API budget: read now, then at most once a minute before a claim, and on every wake while budget-low.
  // A failed read keeps the last value, and a budget-low state until its `until`.
  let lastBudget: GhBudget | null = null;
  let budgetReadAt = 0;
  const readGithub = async () => {
    if (!ghLow && Date.now() - budgetReadAt < GH_BUDGET_READ_MS) return;
    budgetReadAt = Date.now();
    const b = await gh.rateLimit();
    if (!b) return;
    lastBudget = b; live.github = b; save();
    const r = reserveState(b, c.ghReservePct ?? DEFAULTS.ghReservePct);
    if (r.low) githubLow(r.until, `${r.bucket} ${r.remaining}/${r.limit}`);
    // the budget is back (reset, or raised early); a shared hold still in force is left to expire
    else if (ghLow && (!ghLow.shared || !ghLowActive())) {
      ghLow = null; live.githubLow = Date.now() < ghWaitUntil ? { until: ghWaitUntil, reason: 'github rate limited' } : undefined; save();
      log('github budget restored');
    }
  };
  await readGithub();
  save();

  let wake = () => {}; // set while the loop waits; called to wake it early

  // the watch window after a self-update (#316), kept by the runner whose version it watches. Its verdict: `good` once
  // it passes; a rollback stops the run as hx pause --now does, then the install goes back and a runner on it starts.
  const myVersion = o.watch && !fleetChild ? await currentVersion(hxRoot()).catch(() => '') : '';
  let rollbackWhy = '';
  const myWatch = () => { const w = readSelfUpdate(p.stateDir).watch; return myVersion && w?.to === myVersion ? w : undefined; };
  const watchedNow = () => watchOpen(myWatch(), Date.now());
  let crash: any; // what the main loop threw
  const watchCheck = () => {
    const w = myWatch();
    if (!w || rollbackWhy) return;
    const v = watchVerdict(w, Date.now(), c.selfUpdateFailLimit);
    if (v.kind === 'good') watchGood(p.stateDir, (l) => log(l));
    if (v.kind !== 'rollback') return;
    rollbackWhy = v.reason;
    if (live.sessions.length) log(`self-update: ${short(w.to)} misbehaves (${v.reason}) — checkpointing running sessions before the rollback`);
    stop.abort();
    wake();
  };
  const watchReport = (e: WatchEvent) => {
    if (!myWatch()) return;
    try { updateSelfUpdate(p.stateDir, (s) => { if (s.watch?.to === myVersion) s.watch = watchEvent(s.watch, e, Date.now()); }); } catch {}
    watchCheck();
  };

  // CI gate: test the default branch at start and after every merge; while it is red, claim only its fix
  const gs = readGate(p.stateDir);
  let gateRunning: Promise<void> | null = null;
  let gateAgain = false;
  let gateWarned = false;
  let gateSlowWarned = false;
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
      // a failed worktree setup is retried at once, up to SETUP_TRIES in a row at one sha (counted here only, never written)
      let setupSha = '', setupTries = 0;
      let lastSetup: SetupResult | undefined;
      const setup = { stateDir: p.stateDir, config: c, log: (m: string) => log(`gate: ${m}`),
        onSetup: (s: SetupResult) => { lastSetup = s; if (s.ok && s.command) log(`gate: ${setupLine(s, s.command)}`); } };
      do {
        gateAgain = false;
        if (o.signal.aborted) break;
        // Ctrl+C (o.signal) aborts the gate; `hx pause --now` (stop) does not
        const r = await runGate(p.root, c.worktreeRoot, c.defaultBranch, cmd, c.gateMinutes * 60_000, o.signal, setup).catch((e) => ({ sha: '', ok: true, command: cmd, output: String(e.message), at: new Date().toISOString(), error: true }));
        if ('aborted' in r && r.aborted) { await r.killed; break; } // discarded: no log, no gate.json, no fix issue; the tree is gone first
        if ('error' in r) { log(`gate: could not run (${r.output.slice(0, 160)}) — retried after the next merge`); continue; }
        if ('setupFailed' in r && r.setupFailed) {
          setupTries = r.sha === setupSha ? setupTries + 1 : 1;
          setupSha = r.sha;
          if (lastSetup) log(`gate: ${setupLine(lastSetup, r.command, { suffix: `try ${setupTries} of ${SETUP_TRIES}`, minutes: c.worktreeSetupMinutes })}`);
          // between tries gs.last, gate.json and live.gate keep the previous result
          if (setupTries < SETUP_TRIES) { gateAgain = true; continue; }
        } else {
          setupTries = 0;
          try {
            appendGateRun(p.stateDir, r);
            const slow = !gateSlowWarned && slowGateWarning(readGateRuns(p.stateDir), c.gateMinutes);
            if (slow) { log(slow); gateSlowWarned = true; }
          } catch (e: any) { log(`gate: recording the run failed: ${e.message}`); }
        }
        const wasRed = gateRed();
        gs.last = r;
        if (!r.ok && r.setupFailed) {
          log(`gate RED ✗ — the worktree setup \`${r.command}\` ${r.timedOut ? 'timed out' : 'fails'} on ${c.defaultBranch} at ${r.sha.slice(0, 7)} (${SETUP_TRIES} tries); claiming only its fix`);
          await fileGateIssue(r).catch((e) => log(`gate: filing the fix issue failed: ${e.message}`));
        } else if (!r.ok) {
          log(`gate RED ✗ — \`${cmd}\` ${r.timedOut ? 'timed out' : 'fails'} on ${c.defaultBranch} at ${r.sha.slice(0, 7)}; claiming only its fix`);
          await fileGateIssue(r).catch((e) => log(`gate: filing the fix issue failed: ${e.message}`));
        } else {
          log(wasRed ? `gate green ✓ again at ${r.sha.slice(0, 7)}` : `gate green ✓ at ${r.sha.slice(0, 7)}`);
          gs.fixIssue = undefined;
        }
        writeGate(p.stateDir, gs);
        showGate();
        // a watched self-update (#316): the first gate run at this runner's own sha; a red one is run again at the old sha
        const w = myWatch();
        if (w && !w.gate && r.sha === w.to && watchOpen(w, Date.now())) {
          if (r.ok) watchReport({ gate: 'green' });
          else {
            log(`self-update: the gate is red at ${short(w.to)} — running it at ${short(w.from)}`);
            const g = await runGate(p.root, c.worktreeRoot, c.defaultBranch, r.command, c.gateMinutes * 60_000, o.signal, setup, w.from)
              .catch((e) => ({ error: String(e.message) }));
            if ('error' in g) log(`self-update: the gate at ${short(w.from)} could not run (${g.error.slice(0, 160)})`);
            else if (!g.aborted) {
              const v = gateAtOld(r, g);
              log(v === 'bad' ? `self-update: the gate is ${g.ok ? 'green' : 'red on other tests'} at ${short(w.from)}`
                : `self-update: the same tests fail at ${short(w.from)} — ${c.defaultBranch} was red already, no rollback`);
              watchReport({ gate: v });
            }
          }
        }
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
  // a self-update's new runner is ready at its first poll, which waits for this gate: the old runner's 120 s are not the gate's
  const startGate = gateCheck();
  if (!ho) await startGate;

  // autoRelease (PRD #139 §D10): due or not is derived from origin's tags, the commits and GitHub on every check,
  // nothing stored. One check at a time, in the background: it never blocks claims; a failure is retried later.
  let releasing: Promise<boolean> | null = null;
  let releaseNoGate = false;
  let releaseLast = ''; // the lines of the last check that made no release: the same lines again are not logged
  // with gate on, only the run's gate: wait for a running one, start one when the recorded result is not for the head
  const releaseGateInRun = async (): Promise<GateResult | null> => {
    for (let i = 0; i < 3; i++) {
      if (gateRunning) await gateRunning;
      const head = await remoteSha(p.root, c.defaultBranch);
      if (gs.last && gs.last.sha === head) return gs.last;
      if (o.signal.aborted || i === 2) break;
      await gateCheck();
    }
    throw new Error(`no gate result for ${c.defaultBranch} at its head`);
  };
  const releaseCheck = (final = false): Promise<boolean> => {
    if (!c.autoRelease) return Promise.resolve(false);
    if (releasing) return releasing;
    releasing = (async () => {
      if (!gateCommand()) {
        if (!releaseNoGate) { log('release: no gate command known'); releaseNoGate = true; }
        return false;
      }
      const lines: string[] = [];
      const rlog = (m: string) => { if (!/^released v/.test(m)) lines.push(`release: ${m.split(/\r?\n/)[0]}`); };
      const flush = () => { const all = lines.join(' | '); if (all !== releaseLast || final) for (const l of lines) log(l); releaseLast = all; };
      let tag: string | undefined;
      try {
        const due = await dueRelease(p, c);
        if (!due.due) { if (final) log(`release: none due — ${due.why}`); return false; }
        const r = await release({ paths: p, config: c, bump: due.bump, yes: true, dryRun: false, inRun: true,
          gate: c.gate ? releaseGateInRun : releaseGate(p, c, rlog, o.signal), log: rlog, confirm: async () => true,
          planned: (t) => { tag = t; } });
        if (!r.released) { flush(); return false; }
        releaseLast = '';
        log(`released ${r.released} (${r.prds?.length ? `PRD ${r.prds.map((n) => `#${n}`).join(', ')}` : 'fixes'})`);
        return true;
      } catch (e: any) {
        releaseLast = '';
        log(`${tag ? `release ${tag}` : 'release'} failed: ${String(e.message).split(/\r?\n/)[0].slice(0, 300)}`);
        return false;
      }
    })().finally(() => { releasing = null; });
    return releasing;
  };

  // the health pass (PRD #194 §A): on an idle board, never during a hold or a low GitHub budget. Its lines go to the run log.
  let healthAt = -Infinity; // when the last pass ended (in memory: the first idle loop of a run may run one), so a slow pass still leaves healthEveryMinutes until the next
  let healthChanges = 0; // a plain run's passes in a row that changed something: bounded, so a repair that never sticks cannot loop
  const healthCheck = async (): Promise<boolean> => {
    healthAt = Date.now();
    try {
      // the worktrees with no live session; the gate's and the release's while they may run
      await sweepLeftovers([...live.sessions.flatMap((x) => ['i', 'a', 't', 'p'].map((k) => `${k}${x.number}`)),
        ...(gateRunning ? ['gate'] : []), ...(releasing ? ['r', 'gate'] : [])]);
      const r = await healthPass(p, {
        repairs: c.selfHeal,
        live: new Set(live.sessions.map((s) => s.number)),
        // one more gate run for a gate-fix issue; never a second while one runs, never without a command
        requestGate: () => { if (!c.gate || !gateCommand() || gateRunning) return false; void gateCheck(); return true; },
        closedGateFix: (n) => { if (gs.fixIssue === n) { gs.fixIssue = undefined; writeGate(p.stateDir, gs); showGate(); } },
        merged: (test) => ctx.merged(test), // a resumed audited PR: the gate and release checks as after any merge
      });
      for (const x of r.results) if (x.mark !== '✓') log(`health: ${renderResult(x)}`);
      log(r.line);
      // the self-review (§C): repairs on, and only after a pass that left the board as it was
      if (c.selfHeal && !r.changed && !stop.signal.aborted) return await selfReviewCheck();
      return r.changed;
    } catch (e: any) {
      log(`health: the pass failed — ${String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 200)}`);
      return false;
    } finally { healthAt = Date.now(); }
  };
  // the self-review (PRD #194 §C): .hx/selfreview.json holds the head last reviewed. Run from healthCheck and awaited,
  // so no claim, pass or second review starts while it runs. True when it filed issues (the board changed).
  const selfReviewCheck = async (): Promise<boolean> => {
    const git = (...a: string[]) => runCmd(process.env.HX_GIT_BIN || 'git', ['-C', p.root, ...a]);
    try {
      if ((await git('fetch', '-q', 'origin', c.defaultBranch)).code !== 0) return false;
      const head = (await git('rev-parse', `origin/${c.defaultBranch}`)).stdout.trim();
      if (!head) return false;
      const s = readSelfReview(p.stateDir);
      const ancestor = !!s && (await git('merge-base', '--is-ancestor', s.sha, head)).code === 0;
      const subjects = ancestor ? (await git('log', '--format=%s', `${s!.sha}..${head}`)).stdout.split(/\r?\n/).filter(Boolean) : [];
      const d = selfReviewDecision(s, { ancestor, commits: subjects.length, now: Date.now(), everyHours: c.selfReviewEveryHours });
      if (d.kind === 'record') {
        writeSelfReview(p.stateDir, { sha: head, at: new Date().toISOString() });
        log(`self-review: recorded ${head.slice(0, 7)} — the first review covers what merges after it`);
        return false;
      }
      if (d.kind !== 'review') return false;
      // the board is still empty: nothing claimable after the pass
      const pl = await readPlan(p, trusted, new Set(inFlight.keys()));
      if (inFlight.size || claimable(pl.actions, { only: o.only, gateRed: gateRed(), fixIssue: gs.fixIssue }).length) return false;
      const slot = fleetDir ? acquireSlot(fleetDir, fleetCap, { pid: process.pid, repo: c.repo, issue: 0 }) : null;
      if (fleetDir && slot === null) return false;
      const range = `${d.since}..${head}`;
      let r: GoalResult | null;
      try { r = await selfReview(p, ctx, { range, head, subjects }); }
      finally { if (fleetDir && slot !== null) releaseSlot(fleetDir, slot); live.sessions = live.sessions.filter((x) => x.key !== SELFREVIEW_KEY); save(); }
      if (r?.stopReason === 'limited') holdUntil(r.last?.limited?.resetsAt ? r.last.limited.resetsAt * 1000 : Date.now() + 30 * 60_000, 'usage limit reached');
      // a session that did not finish records nothing: the range is reviewed next time
      if (!r?.done) { log(`self-review: did not finish (${r?.stopReason ?? 'aborted'}) — the range is reviewed next time`); return false; }
      const filed: number[] = [];
      for (const f of parseFindings(r.last?.text ?? '', c.selfReviewMaxFindings)) {
        const url = await gh.createIssue(c.repo, f.title.slice(0, 200), findingBody(f, head), [c.labels.bug]);
        const n = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
        if (n) filed.push(n);
      }
      writeSelfReview(p.stateDir, { sha: head, at: new Date().toISOString() });
      log(filed.length ? `self-review: filed ${filed.length} finding(s) since ${d.since.slice(0, 7)} (${filed.map((n) => `#${n}`).join(', ')})`
        : `self-review: no findings since ${d.since.slice(0, 7)}`);
      return filed.length > 0;
    } catch (e: any) {
      log(`self-review: failed — ${String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 200)}`);
      return false;
    }
  };

  // the self-update (#253): on an idle --watch board, at most every selfUpdateMinutes. Not in hx fleet run: the fleet
  // owns its children (fleetChild). true: a new runner took over and this one exits.
  if (c.selfUpdate && o.watch && fleetChild) log('self-update: off under hx fleet run');
  let selfUpdateAt = -Infinity;
  let selfUpdateSkip = ''; // the skip reason last logged: once per reason
  const selfUpdateCheck = async (): Promise<boolean> => {
    selfUpdateAt = Date.now();
    const root = hxRoot(), kind = installKind(root);
    const s = readSelfUpdate(p.stateDir);
    const note = (line: string) => { log(line); s.last = { at: new Date().toISOString(), line }; try { writeSelfUpdate(p.stateDir, s); } catch {} };
    let ch: Check;
    try { ch = kind === 'git' ? await checkGit(root, s) : await checkRelease(root, s); }
    catch (e: any) { ch = { kind: 'skip', why: `could not check (${String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 200)})` }; }
    if (ch.kind === 'skip') { if (ch.why !== selfUpdateSkip) { selfUpdateSkip = ch.why; note(`self-update: skipped — ${ch.why}`); } return false; }
    selfUpdateSkip = '';
    // the fetch took time: a session, a claim or a pause since then wins
    if (ch.kind === 'none' || inFlight.size || live.sessions.length || live.draining || readPause(p.stateDir) || stop.signal.aborted) return false;
    note(`self-update: ${short(ch.from)}..${short(ch.to)} (${kind === 'git' ? `${ch.files} files` : 'release'})`);
    const rollback = async (reason: string) => {
      const err = await ch.rollback();
      s.bad = [...s.bad, ch.to];
      s.detached = kind === 'git' ? ch.from : undefined;
      note(`self-update: rolled back to ${short(ch.from)} (${reason}${err ? `; the rollback failed too: ${err}` : ''})`);
    };
    const failed = await ch.apply();
    if (failed) { await rollback(failed); return false; }
    handedOff = true;
    // the new runner's watch window (#316), recorded before it starts: it reads the window from its first poll
    s.watch = { from: ch.from, to: ch.to, until: new Date(Date.now() + c.selfUpdateWatchMinutes * 60_000).toISOString(), fails: 0, ...(ch.lockfile ? { lockfile: true } : {}) };
    try { writeSelfUpdate(p.stateDir, s); } catch {}
    const r = await restart({ root, args: runArgs, cwd: p.root, stateDir: p.stateDir });
    if (r.ok) {
      const line = `self-update: restarted — pid ${r.pid} took over`;
      log(line);
      // read again: the new runner may have written the file since
      try { updateSelfUpdate(p.stateDir, (x) => { x.detached = undefined; x.last = { at: new Date().toISOString(), line }; }); } catch {}
      return true;
    }
    handedOff = false;
    s.watch = undefined;
    save(); // the new runner may have written live.json before it died
    await rollback(r.reason);
    return false;
  };

  const inFlight = new Map<string, Promise<void>>();
  let idleLogged = false;
  const skipped = new Set<number>(); // untrusted issues / PRDs already logged this run
  const budgetLogged = new Set<string>(); // budget skips already logged: once per action per window reset
  let failures = 0;
  let engineRetries = 0;
  let fatal: string | undefined; // a setup error: stop claiming, let running sessions finish
  let restarted = false; // a self-update's new runner took over
  let finished = 0; // sessions ended so far: a plan read while one was ending is already stale
  // shared: a hold copied from hold.json, never written back. A hold of the runner's own goes to hold.json too.
  const holdUntil = (until: number, why: string, shared = false) => {
    if (until <= (live.pausedUntil ?? 0)) return;
    live.pausedUntil = until; live.pauseReason = why; save();
    if (fleetDir && !shared) writeHold(fleetDir, { until, reason: why, repo: c.repo });
    log(`${why} — no new claims until ${new Date(until).toLocaleTimeString()}`);
  };
  // live.budget: the usage windows as hx status shows them, refreshed on a new reading and on each loop pass
  const showBudget = () => {
    try { live.budget = { windows: readBudgetWindows(p.stateDir, c.budgetMinPairs, new Date()) }; } catch (e) { log(`could not read the budget: ${(e as Error).message}`); }
    save();
  };
  const sharedHold = () => {
    const h = fleetDir ? readHold(fleetDir) : null;
    if (h) holdUntil(h.until, `shared hold from ${h.repo}: ${h.reason}`, true);
  };
  const ctx: WorkContext = {
    signal: stop.signal,
    trusted,
    login,
    skills: skills.byRole,
    agent,
    started: (s) => { live.sessions.push(s); save(); },
    merged: (testCommand) => {
      if (testCommand && !gs.command) { gs.command = testCommand; writeGate(p.stateDir, gs); }
      void gateCheck();
      void releaseCheck();
    },
    // a result for an older commit says nothing of the base a PR was just rebased onto: that base is tested first
    mainGate: async () => {
      if (!c.gate) return {};
      if (gateRunning) await gateRunning;
      if (gateCommand() && (!gs.last || (await remoteSha(p.root, c.defaultBranch)) !== gs.last.sha)) await gateCheck();
      return { last: gs.last, fixIssue: gs.fixIssue };
    },
    progress: (key, turn, tokens) => { const s = live.sessions.find((x) => x.key === key); if (s) { s.turn = turn; s.tokens = tokens; save(); } },
    rateLimit: (rl) => {
      live.rateLimit = { ...rl, at: new Date().toISOString() }; save();
      const high = rl.utilization !== undefined ? rl.utilization >= c.usagePauseAt : rl.status === 'allowed_warning';
      if (high && rl.status !== 'rejected')
        holdUntil(rl.resetsAt ? rl.resetsAt * 1000 : Date.now() + 30 * 60_000,
          `usage ${rl.utilization !== undefined ? Math.round(rl.utilization * 100) + '%' : 'warning'} on the ${rl.type ?? 'current'} window`);
      // a usage-window reading for the budget gate; failing to record it never stops the run
      const reading = readingOf(rl, new Date());
      if (reading) try { if (recordReading(p.stateDir, reading)) showBudget(); } catch (e) { log(`could not record a usage reading: ${(e as Error).message}`); }
    },
  };
  const checkPause = () => {
    const m = readPause(p.stateDir);
    if (m && !live.draining) { live.draining = true; save(); log(m === 'now' ? 'pause --now: checkpointing running sessions…' : 'pause: finishing running sessions, claiming nothing new'); wake(); }
    if (m === 'now' && !stop.signal.aborted) stop.abort();
  };
  const watcher = setInterval(checkPause, 1000);
  // a filing command (hx bug, …) touches .hx/wake: re-read the board now instead of after pollSeconds.
  // Latched: a wake that lands while the loop is not waiting (reading the board, claiming) is not lost.
  const wakeFile = path.join(p.stateDir, 'wake');
  let wakePending = false;
  const onWake = (cur: Stats, prev: Stats) => {
    if (cur.mtimeMs === prev.mtimeMs || !cur.mtimeMs) return; // unchanged, or deleted: nothing to read
    try { checkPause(); } catch {} // a pause written with the wake wins: no claim
    wakePending = true; wake();
  };
  try { watchFile(wakeFile, { interval: 2000, persistent: false }, onWake); } catch {}

  log(`hx pool up — ${c.repo} · ${o.workers} worker(s) · model ${c.model}${c.effort ? ` (${c.effort} effort)` : ''} · max ${c.maxIterations} iterations/session`);
  try {
    while (!stop.signal.aborted && !fatal) {
      if (ho) { try { writeFileSync(ho.ready, String(process.pid)); } catch {} ho = null; await startGate; }
      watchCheck(); // the window passed (good), or a rollback is due
      if (stop.signal.aborted) break;
      let actions: Action[] = [];
      let stuck: number[] = []; // labelled agent-working with no live session: hx never claims them again
      const finishedBefore = finished;
      checkPause(); // the 1 s watcher may not have seen a pause written as a session ended: it must win over the next claim
      sharedHold(); // another fleet runner's usage hold
      sharedGithubHold(); // another fleet runner's GitHub budget-low state
      showBudget();
      await readGithub();
      const held = Date.now() < (live.pausedUntil ?? 0) || githubLowNow();
      let slotBlocked = false; // no fleet slot free: no more sessions this pass, look again within 5 s
      let budgetBlocked = false; // the budget gate skipped an action: wait for a reading or a reset instead of finishing
      if (!held && !live.draining) {
        try {
          let pl = await readPlan(p, trusted, new Set(inFlight.keys()));
          // an owner's answer turns a needs-human issue ready: read the board again so it can be claimed now
          if (await answeredQuestions(p, pl, trusted)) pl = await readPlan(p, trusted, new Set(inFlight.keys()));
          for (const r of [...pl.prds, ...pl.board])
            if (r.status === 'untrusted' && !r.untrustedPrd && !skipped.has(r.number)) { skipped.add(r.number); log(skipLine(r)); }
          stuck = pl.board.filter((r) => r.status === 'working' && !inFlight.has(issueKey(r.number))).map((r) => r.number);
          // someone may have fixed the base by hand: re-test when it moved. Not while the fix session runs: its
          // merge moves the base too, and it re-tests once the session hands back (green only after its DONE)
          const fixing = gs.fixIssue !== undefined && inFlight.has(issueKey(gs.fixIssue));
          if (gateRed() && !gateRunning && !fixing && gs.last && (await remoteSha(p.root, c.defaultBranch)) !== gs.last.sha) void gateCheck();
          actions = claimable(pl.actions, { only: o.only, gateRed: gateRed(), fixIssue: gs.fixIssue });
          if (c.budgetGate) {
            // the files are read once per pass; a skipped action is looked at again next pass
            const g = budgetFilter(actions, readBudget(p.stateDir, c, new Date()));
            actions = g.claim;
            budgetBlocked = g.skipped.length > 0;
            for (const l of newSkipLines(g.skipped, budgetLogged)) log(l);
          }
        } catch (e: any) {
          log(`board read failed, retrying next poll: ${e.message}`);
        }
      }

      for (const a of actions) {
        if (a.kind !== 'close-prd' && a.kind !== 'label-ready') sharedHold();
        sharedGithubHold();
        if (stop.signal.aborted || fatal || live.draining || Date.now() < (live.pausedUntil ?? 0) || githubLowNow()) break; // fatal may land during readPlan
        if (a.kind === 'close-prd' || a.kind === 'label-ready') { await engineStep(p, a).then(() => { if (a.kind === 'close-prd') void releaseCheck(); }).catch((e) => log(`${a.kind} failed: ${e.message}`, target(a))); continue; }
        if (inFlight.size >= o.workers || slotBlocked) continue; // engine steps further down still run
        const slot = fleetDir ? acquireSlot(fleetDir, fleetCap, { pid: process.pid, repo: c.repo, issue: target(a) }) : null;
        if (fleetDir && slot === null) { slotBlocked = true; continue; }
        idleLogged = false;
        const key = keyOf(a);
        const task = work(p, a, ctx).then((r) => {
          if (r?.stopReason === 'limited') {
            holdUntil(r.last?.limited?.resetsAt ? r.last.limited.resetsAt * 1000 : Date.now() + 30 * 60_000, 'usage limit reached');
          } else if (r?.stopReason === 'fatal') {
            fatal = r.last?.error ?? 'unknown setup error';
          } else if (r && !r.done && r.stopReason !== 'aborted' && r.promiseSeen !== 'alt') failures++; // a question is no failure
          watchReport({ session: sessionOutcome(r) });
        }).catch((e) => { failures++; log(`crashed: ${e.message}`, target(a)); watchReport({ session: 'error' }); })
          .finally(() => { if (fleetDir && slot !== null) releaseSlot(fleetDir, slot); inFlight.delete(key); live.sessions = live.sessions.filter((s) => s.key !== key); save(); finished++; });
        inFlight.set(key, task);
      }

      if (!inFlight.size && gateRunning) { await gateRunning; continue; } // its result decides what may run
      if (!inFlight.size && !slotBlocked) {
        if (live.draining) { log('paused — every session has finished'); break; }
        if (finished !== finishedBefore) continue; // the plan predates a session ending: read it again
        const limited = Date.now() < (live.pausedUntil ?? 0) || githubLowNow() || budgetBlocked;
        // an engine step (PRD closed, child labelled) may have unlocked work: re-read before giving up
        const engineOnly = !budgetBlocked && actions.length > 0 && actions.every((a) => a.kind === 'close-prd' || a.kind === 'label-ready');
        engineRetries = engineOnly ? engineRetries + 1 : 0;
        if (!o.watch && !limited && (!engineOnly || engineRetries > 3)) {
          if (c.autoRelease) {
            // one last attempt, after a running gate and release check
            if (gateRunning) await gateRunning;
            if (!(releasing && (await releasing))) await releaseCheck(true);
          }
          // one pass before the exit; one that changed the board (work unblocked, a gate run asked for) reads it again
          if (!stop.signal.aborted && await healthCheck() && ++healthChanges <= 3) continue;
          log('nothing left to do — done');
          if (stuck.length) log(`WARNING: still labelled ${c.labels.working} with no session running: ${stuck.map((n) => `#${n}`).join(', ')} — remove the label to let hx pick ${stuck.length > 1 ? 'them' : 'it'} up again`);
          break;
        }
        if (engineOnly) { await sleep(2000, stop.signal); continue; }
        // not while this runner's own watch window is open: its version is not known good yet
        if (o.watch && c.selfUpdate && !fleetChild && !gateRunning && !releasing && !myWatch() && Date.now() - selfUpdateAt >= c.selfUpdateMinutes * 60_000
          && await selfUpdateCheck()) { restarted = true; break; }
        if (o.watch) void releaseCheck();
        if (o.watch && !limited && !actions.length && Date.now() - healthAt >= c.healthEveryMinutes * 60_000 && await healthCheck()) continue;
        if (!idleLogged) { log(budgetBlocked ? 'budget: waiting for usage to leave room for the next session…' : githubLowNow() ? 'waiting for the GitHub API budget to reset…' : limited ? 'waiting for the usage limit to reset…' : 'board empty — watching for new issues'); idleLogged = true; }
      }
      // wake on the first finished task, a pause, or after a poll interval (new / unblocked issues, a limit reset)
      if (wakePending) { wakePending = false; continue; } // woken while not waiting: re-read the board now
      // a hold wakes at its end; budget-low alone polls half as often (each wake re-reads the budget)
      const holdLeft = (live.pausedUntil ?? 0) - Date.now();
      const ghLeft = githubLowNow() ? githubLowLeft() : 0;
      const every = (ghLeft > 0 && holdLeft <= 0 ? 2 : 1) * c.pollSeconds * 1000;
      const left = Math.min(...[holdLeft, ghLeft].filter((x) => x > 0));
      const pollMs = left < Infinity ? Math.max(1000, Math.min(every, left)) : every;
      const waitMs = slotBlocked ? Math.min(pollMs, 5000) : pollMs;
      await waitAny(waitMs, stop.signal, [new Promise<void>((r) => { wake = r; }), ...inFlight.values()]);
    }
    if (inFlight.size) { log(`stopping — waiting for ${inFlight.size} session(s) to hand back their issues…`); await Promise.allSettled(inFlight.values()); }
    if (releasing) await releasing; // never leave a release half pushed
  } catch (e: any) {
    crash = e;
    // inside this runner's own watch window a crash rolls it back (below): its sessions checkpoint first, as on hx pause --now
    if (watchedNow()) {
      log(`crashed: ${e?.message ?? e}`);
      stop.abort();
      if (inFlight.size) { log(`stopping — waiting for ${inFlight.size} session(s) to hand back their issues…`); await Promise.allSettled(inFlight.values()); }
      if (releasing) await releasing.catch(() => {});
    }
  } finally {
    clearInterval(watcher);
    unwatchFile(wakeFile, onWake);
    clearLive(p.stateDir, process.pid);
  }
  if (fatal) {
    log(`STOPPED: Claude rejected the setup — ${fatal.slice(0, 300)}`);
    log(`check config.model ('${c.model}'), claude --version, and that claude is logged in; no issue was labelled.`);
  }
  // a runner a self-update started exits non-zero inside its watch window (#316): it rolls itself back, since no
  // supervisor sees a run lock it cleared
  if (!rollbackWhy && (crash || fatal) && watchedNow())
    rollbackWhy = crash ? `the runner exited 1: ${String(crash?.message ?? crash).split(/\r?\n/)[0].slice(0, 160)}` : 'the runner exited 2: Claude rejected the setup';
  if (rollbackWhy) {
    // the running sessions have checkpointed and handed back: the install goes back, a runner on it takes over
    if (gateRunning) await gateRunning;
    const root = hxRoot();
    await rollbackWatch(p.stateDir, root, rollbackWhy, (l) => log(l));
    const r = await restart({ root, args: runArgs, cwd: p.root, stateDir: p.stateDir });
    if (r.ok) { log(`self-update: restarted — pid ${r.pid} took over`); return 0; }
    log(`self-update: the runner on the old version did not start (${r.reason})`);
    return 1;
  }
  if (crash) throw crash;
  if (restarted) return 0;
  if (fatal) return 2;
  return failures ? 1 : 0;
}

const SELFREVIEW_KEY = 'selfreview';

/**
 * One self-review session in a fresh read-only worktree on origin/<default> (`sr`, never touched by the leftover-worktree
 * check), removed when it ends. Shown in live.sessions as #0 `selfreview`; its turns go to usage.jsonl with role selfreview.
 * Null when it was stopped during the worktree setup. The caller takes it out of live.sessions.
 */
async function selfReview(p: Project, ctx: WorkContext, o: { range: string; head: string; subjects: string[] }): Promise<GoalResult | null> {
  const c = p.config;
  const role = 'selfreview';
  const short = o.range.replace(/[0-9a-f]{40}/g, (x) => x.slice(0, 7));
  log(`self-review: ${o.subjects.length} merge(s) in ${short}`);
  const wt = await addWorktree(p.root, c.worktreeRoot, selfReviewWorktree(c.defaultBranch));
  ctx.started({ key: SELFREVIEW_KEY, number: 0, kind: role, title: `self-review of ${short}`, since: new Date().toISOString(), turn: 0, tokens: 0 });
  try {
    let setupMsg = '';
    if (c.worktreeSetup || c.worktreeCopy?.length) {
      const s = await setupWorktree({ checkout: p.root, dir: wt.dir, name: 'sr', stateDir: p.stateDir, config: c, signal: ctx.signal, log: (m) => log(`self-review: ${m}`) });
      if (s?.aborted) return null;
      if (s?.command) log(`self-review: ${setupLine(s, s.command, { minutes: c.worktreeSetupMinutes })}`);
      const note = s ? setupNote(s.command, s) : '';
      setupMsg = note && `${note}\n`;
    }
    const v: Record<string, string | number> = { REPO: c.repo, BASE: c.defaultBranch, RANGE: o.range, MAX: c.selfReviewMaxFindings,
      TITLES: o.subjects.map((t) => `- ${t}`).join('\n'), SETUP_NOTE: setupMsg, PROMISE: SELFREVIEW_PROMISE,
      SUBJECT: `the self-review of ${o.range}: did you output every finding block?` };
    const agent = ctx.agent ?? agentFor(c.agentCli);
    const skills = ctx.skills?.[role] ?? [];
    const m = roleModel(c, role);
    const logDir = path.join(p.stateDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const eventLog = path.join(logDir, 'selfreview.jsonl');
    let tokens = 0;
    const turnEvents: unknown[] = []; // this turn's events, for its test time
    return await runGoal({
      agent, bin: agent.bin(c), cwd: wt.dir, model: m.model, effort: m.effort, extraArgs: workerArgs(c), timeoutMs: c.turnTimeoutMinutes * 60_000,
      stallMs: c.stallMinutes * 60_000, sweepRoot: c.worktreeRoot,
      prompt: appendSkills(render(readFileSync(path.join(PROMPTS, 'selfreview.md'), 'utf8'), v), skills, PROMPTS),
      continuePrompt: render(readFileSync(path.join(PROMPTS, 'continue.md'), 'utf8'), v),
      promise: SELFREVIEW_PROMISE, maxIterations: c.maxIterations, signal: ctx.signal,
      env: rtddEnv(trustedEnv(ctx.trusted), skills.some((s) => s.name === 'rtdd'), effectiveRtddBin(c)),
      onEvent: (ev) => { appendFileSync(eventLog, JSON.stringify(ev) + '\n'); turnEvents.push(ev); },
      onRateLimit: (rl) => ctx.rateLimit(rl),
      onTurn: (i, sessionId, t) => {
        tokens += totalTokens(t.usage);
        ctx.progress(SELFREVIEW_KEY, i, tokens);
        recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: 0, role, sessionId, iteration: i, model: m.model,
          ...(t.actualModel ? { actualModel: t.actualModel } : {}), ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns,
          ...testTiming(p, turnEvents.splice(0), t.durationMs) });
        log(`${role} turn ${i}: ${t.ok ? 'ok' : 'error'} · ${fmt(totalTokens(t.usage))} tokens (${fmt(t.usage.output)} out) · ${Math.round(t.durationMs / 1000)}s${t.error ? ` · ${t.error.slice(0, 160)}` : ''}`);
      },
    });
  } finally {
    await removeWorktree(p.root, wt.dir).catch(() => {});
  }
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
    await relabel(p.config.repo, s.number, [], [p.config.labels.working]);
    log(`recovered from a run that stopped unexpectedly (pid ${prev.pid}): released ${s.kind}`, s.number);
  }
}

/** Steps the engine does itself, no session: idempotent, retried every poll until GitHub agrees. */
async function engineStep(p: Project, a: Extract<Action, { kind: 'close-prd' | 'label-ready' }>): Promise<void> {
  const c = p.config;
  if (a.kind === 'close-prd') {
    await gh.closeIssue(c.repo, a.prd, a.secured
      ? 'All child issues are closed and the PRD passed review and the security pass — closed by hx.'
      : 'All child issues are closed and the PRD passed review — closed by hx.');
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
    round = reviewRoundsDone(await gh.commentBodies(c.repo, n, ctx.trusted)) + 1;
    if (round > c.reviewRounds) {
      await gh.comment(c.repo, n, `**hx:** ${c.reviewRounds} review rounds have run and the PRD is still not signed off. A human needs to look; add the \`${c.labels.reviewed}\` label to sign it off, or remove \`${c.labels.blocked}\` to allow more rounds after raising \`reviewRounds\`.`);
      await gh.editLabels(c.repo, n, [c.labels.blocked]);
      log(`review round cap (${c.reviewRounds}) reached — labelled ${c.labels.blocked}`, n);
      return undefined;
    }
  } else if (a.kind === 'gauntlet') {
    round = (await gh.commentBodies(c.repo, n, ctx.trusted)).filter(firstLineIs(GAUNTLET_MARKER)).length + 1;
  } else if (a.kind === 'security') {
    round = (await gh.commentBodies(c.repo, n, ctx.trusted)).filter(firstLineIs(SECURITY_MARKER)).length + 1;
    if (round > c.securityRounds) {
      await gh.comment(c.repo, n, `**hx:** ${c.securityRounds} security passes have run and each filed security issues. A human needs to look; add the \`${c.labels.secured}\` label to sign it off, or raise \`securityRounds\` and remove \`${c.labels.blocked}\` to allow more passes.`);
      await gh.editLabels(c.repo, n, [c.labels.blocked]);
      log(`security round cap (${c.securityRounds}) reached — labelled ${c.labels.blocked}`, n);
      return undefined;
    }
  } else if (a.kind === 'triage') {
    // a round is a trusted verdict comment, hx's FAILED marker included
    const done = (await gh.commentBodies(c.repo, n, ctx.trusted)).filter((b) => triageVerdict(b) !== null).length;
    if (done >= c.triageRounds) {
      await relabel(c.repo, n, [c.labels.blocked], [c.labels.working]);
      if (!(await gh.commentBodies(c.repo, n, ctx.trusted)).some((b) => b.trimStart().startsWith(TRIAGE_GAVE_UP))) {
        await gh.comment(c.repo, n, `${TRIAGE_GAVE_UP} after ${done} rounds — add ${c.labels.triaged} and ${c.labels.ready} to fix it anyway`);
        log(`triage: GAVE UP after ${done} rounds`, n);
      } else log(`triage: round cap reached — labelled ${c.labels.blocked}`, n);
      return undefined;
    }
    round = done + 1;
  } else if (a.kind === 'bar') {
    // a round is a trusted `<!-- hx-bar round=` comment: one by any other account never counts
    round = barRound(await gh.commentBodies(c.repo, n, ctx.trusted));
    if (round > c.barRounds) { // every round has run (barRounds lowered, or the label removed by hand): sign off
      await relabel(c.repo, n, [c.labels.barPassed]);
      log(`bar: ${c.barRounds} round(s) already ran — labelled ${c.labels.barPassed}`, n);
      return undefined;
    }
  }
  // what verify() compares a security session against: the security issues and verdicts already there
  const before = a.kind === 'security' ? await securitySnapshot(p, n, ctx.trusted) : undefined;

  await gh.editLabels(c.repo, n, [c.labels.working]);
  log(`${a.kind}${round ? ` (round ${round})` : ''}: ${title}`, n);
  let wt: AddedWorktree;
  try {
    wt = await addWorktree(p.root, c.worktreeRoot, a.kind === 'impl' ? implWorktree(n, c.defaultBranch)
      : a.kind === 'triage' ? triageWorktree(n, c.defaultBranch) : prdWorktree(n, c.defaultBranch));
  } catch (e: any) {
    await relabel(c.repo, n, [], [c.labels.working]);
    throw e;
  }
  const key = keyOf(a);
  ctx.started({ key, number: n, kind: a.kind, title, since: new Date().toISOString(), turn: 0, tokens: 0 });

  // an earlier session that was stopped left a handoff comment: give it to this one
  let resumeNote = '';
  if (a.kind === 'impl' && wt.resumed) {
    const handoff = (await gh.commentBodies(c.repo, n, ctx.trusted).catch(() => [] as string[])).filter((b) => b.trimStart().startsWith(HANDOFF_MARKER)).pop();
    resumeNote = `NOTE: this branch already has work from an earlier session — run \`git log origin/${c.defaultBranch}..HEAD\` and \`git status\` first and continue from there. ${RESUME_TESTS_NOTE}`
      + (handoff ? `\nThat session's handoff note:\n\n${handoff.replace(HANDOFF_MARKER, '').trim()}\n` : '');
  }

  // an answered owner question (needs-human): the question and the answer go to every impl session of the issue;
  // a question hx put back at the cap and the owner never answered: take the recommended choice (#332)
  const owner = a.kind === 'impl' ? await gh.issueThread(c.repo, n).then((t) => {
    const qa = ownerAnswer(t, ctx.trusted);
    return qa ? ownerAnswerNote(qa) : cappedQuestionNote(cappedQuestion(t, ctx.trusted));
  }, () => '') : '';

  const L = c.labels;
  const audited = a.kind === 'impl' && c.audit;
  // a bug issue (triaged or not, a PRD child too) gets a reproduce-first note in its impl and audit prompts
  const implLabels = a.kind === 'impl' ? await gh.issueLabels(c.repo, n).catch(() => [] as string[]) : [];
  const bug = implLabels.includes(L.bug);
  const vars: Record<string, string | number> = {
    REPO: c.repo, BASE: c.defaultBranch, TITLE: title, SHIP, ISSUE_SCRIPT,
    LABEL_READY: L.ready, LABEL_REVIEWED: L.reviewed, LABEL_SECURED: L.secured, LABEL_SECURITY: L.security, ROUND: round,
    ROUNDS: a.kind === 'gauntlet' ? c.gauntletRounds : a.kind === 'security' ? c.securityRounds : a.kind === 'triage' ? c.triageRounds : a.kind === 'bar' ? c.barRounds : c.reviewRounds,
    ISSUE: n, PRD: n, BRANCH: `issue/${n}`,
    EXISTING: a.kind === 'decompose' ? childList(a.children) : '', CHILDREN: a.kind === 'review' || a.kind === 'security' ? childList(a.children) : '',
    RESUMED: resumeNote,
    OWNER_ANSWER: owner ? `${owner}
` : '',
    SUBJECT: a.kind === 'impl' ? `issue #${n} (branch issue/${n}): look at \`git status\`, its PR (\`gh pr list -R ${c.repo} --head issue/${n}\`) and the issue`
      : a.kind === 'decompose' ? `PRD #${n}: list the issues you have filed for it so far`
      : a.kind === 'gauntlet' ? `gauntlet round ${round} of PRD #${n}`
      : a.kind === 'security' ? `security pass ${round} of PRD #${n}`
      : a.kind === 'bar' ? `quality bar round ${round} of PRD #${n}`
      : a.kind === 'triage' ? `triage round ${round} of issue #${n}: did you post the verdict comment?` : `the review of PRD #${n}`,
    // with an auditor the implementer stops at an open PR; hx merges once the audit passes
    SHIP_FLAGS: audited ? ' --no-merge' : '',
    SHIP_WHAT: audited ? ' (it does NOT merge: an independent auditor checks the PR first)' : ', squash-merges it, deletes the branch and closes the issue',
    SHIP_DONE: audited ? 'READY' : 'SHIPPED',
    SHIP_NOTE: audited ? 'Do not merge the PR or close the issue yourself.\n' : '',
    BUG_NOTE: bug ? `${IMPL_BUG_NOTE}\n` : '',
    SETUP_NOTE: '',
    LABEL_NEEDS_HUMAN: L.needsHuman,
    // counted as the prompt is rendered; hx enforces the cap again after the session (capQuestions)
    QUESTIONS_LEFT: a.kind === 'decompose'
      ? questionsLeftLine(openQuestions(await gh.listIssues(c.repo), L, c.repo, ctx.trusted).length, c.maxOpenQuestions) : '',
    // counted as the prompt is rendered; hx counts again when the session stops with a question (askOwner)
    QUESTION_NOTE: a.kind === 'impl'
      ? questionNote(openQuestions(await gh.listIssues(c.repo), L, c.repo, ctx.trusted).length, c.maxOpenQuestions) : '',
  };
  const logDir = path.join(p.stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const eventLog = path.join(logDir, `${a.kind === 'impl' ? 'issue' : a.kind}-${n}.jsonl`);
  let sessionTokens = 0;
  const env = trustedEnv(ctx.trusted);
  const agent = ctx.agent ?? agentFor(c.agentCli);
  /** One role session (a fresh Claude session with its Ralph loop), logged and counted. */
  const goal = (role: string, cwd: string, promptFile: string, promise: string, extra: Record<string, string | number> = {}, altPromise?: string) => {
    const v = { ...vars, ...extra, PROMISE: promise };
    // the role's skills go after the rendered prompt (never rendered themselves); the continue prompt gets none
    const skills = ctx.skills?.[role] ?? [];
    const m = roleModel(c, role);
    let mismatched = false;
    const turnEvents: unknown[] = []; // this turn's events, for its test time
    return runGoal({
      agent, bin: agent.bin(c), cwd, model: m.model, effort: m.effort, extraArgs: workerArgs(c), timeoutMs: c.turnTimeoutMinutes * 60_000,
      stallMs: c.stallMinutes * 60_000, sweepRoot: c.worktreeRoot,
      prompt: appendSkills(render(readFileSync(path.join(PROMPTS, promptFile), 'utf8'), v), skills, PROMPTS),
      continuePrompt: render(readFileSync(path.join(PROMPTS, 'continue.md'), 'utf8'), v),
      promise, altPromise, maxIterations: c.maxIterations, signal: ctx.signal,
      env: rtddEnv(env, skills.some((s) => s.name === 'rtdd'), effectiveRtddBin(c)),
      onEvent: (ev) => { appendFileSync(eventLog, JSON.stringify(ev) + '\n'); turnEvents.push(ev); },
      onRateLimit: (rl) => ctx.rateLimit(rl),
      onTurn: (i, sessionId, t) => {
        sessionTokens += totalTokens(t.usage);
        ctx.progress(key, i, sessionTokens);
        recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: n, role, sessionId, iteration: i, model: m.model,
          ...(t.actualModel ? { actualModel: t.actualModel } : {}), ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns,
          ...testTiming(p, turnEvents.splice(0), t.durationMs) });
        if (t.actualModel && !mismatched && !modelMatches(m.model, t.actualModel)) {
          mismatched = true; // once per session; the session goes on
          log(`model mismatch: ${role} asked ${m.model}, ran ${t.actualModel}`, n);
        }
        log(`${role} turn ${i}: ${t.ok ? 'ok' : 'error'} · ${fmt(totalTokens(t.usage))} tokens (${fmt(t.usage.output)} out) · ${Math.round(t.durationMs / 1000)}s${t.error ? ` · ${t.error.slice(0, 160)}` : ''}`, n);
      },
    });
  };
  log(`working in ${wt.dir}${wt.resumed ? ' (resuming earlier work)' : ''}`, n);

  const keepOnStop = a.kind === 'impl'; // only an implementation worktree can hold unpushed work
  const handBack = async (r: GoalResult, summary: string, keep = keepOnStop) => {
    // not a failure of the issue: hand it back untouched
    await relabel(c.repo, n, [], [L.working]);
    if (!keep) await removeWorktree(p.root, wt.dir);
    const what = { aborted: 'stopped', limited: 'paused by usage limit', fatal: `stopped by a setup error (${r.last?.error?.slice(0, 200)})` }[r.stopReason as 'aborted'];
    log(`${what} — released (${summary})${keep ? '; worktree kept' : ''}`, n);
    return r;
  };
  /**
   * where: the comment's line on where an impl's work is (default: on its branch if it was pushed).
   * `marker`: the comment's first line (a split that stopped partway: `<!-- hx-size split -->`, never sized again).
   */
  const fail = async (r: GoalResult, reason: string, summary: string, where?: string, marker?: string) => {
    await gh.comment(c.repo, n, `${marker ? `${marker}\n` : ''}**hx:** ${a.kind} stopped — ${reason} (${summary}).\n\nLast reply:\n\n${(r.last?.text ?? '').slice(-1500).replace(/^/gm, '> ')}\n\n${a.kind === 'impl' ? where ?? `Work is on branch \`issue/${n}\` if it was pushed. ` : ''}Remove the \`${L.blocked}\` label to let hx try again.`).catch(() => {});
    const labelled = await relabel(c.repo, n, [L.blocked], [L.working]);
    if (!keepOnStop) await removeWorktree(p.root, wt.dir);
    log(`${a.kind} FAILED ✗ — ${reason} (${summary}); ${labelled ? `labelled ${L.blocked}` : `NOT labelled ${L.blocked}`}${keepOnStop ? ', worktree kept' : ''}`, n);
    return { ...r, done: false };
  };
  /**
   * Copies and sets up a session worktree before its first turn (a reused impl worktree only when its last
   * setup did not succeed). Returns its {{SETUP_NOTE}} ('' unless the setup failed), or null when ctx.signal
   * stopped it: then nothing is recorded or logged. A record left by an earlier worktree of the same name is
   * removed first, so an interrupted setup leaves none and the next reuse sets the worktree up again.
   */
  const setup = async (w: AddedWorktree, name: string): Promise<string | null> => {
    if (!w.created && (readSetupRecord(p.stateDir, name)?.ok || (!c.worktreeSetup && !c.worktreeCopy?.length))) return '';
    clearSetupRecord(p.stateDir, name);
    const r = await setupWorktree({ checkout: p.root, dir: w.dir, name, stateDir: p.stateDir, config: c, signal: ctx.signal, log: (m) => log(m, n) });
    if (!r) return '';
    if (r.aborted) return null;
    writeSetupRecord(p.stateDir, name, r);
    if (r.command) log(setupLine(r, r.command, { minutes: c.worktreeSetupMinutes }), n);
    const note = setupNote(r.command, r);
    return note && `${note}\n`;
  };
  /** A session stopped during its worktree's setup, before its first turn. */
  const setupStopped = (): GoalResult => ({ done: false, sessionId: '', iterations: 0, usage: emptyUsage(), costUsd: 0, stopReason: 'aborted' });
  const setupMsg = await setup(wt, a.kind === 'impl' ? `i${n}` : a.kind === 'triage' ? `t${n}` : `p${n}`);
  if (setupMsg === null) return handBack(setupStopped(), 'during the worktree setup');
  if (a.kind === 'impl' || a.kind === 'triage') vars.SETUP_NOTE = setupMsg; // PRD roles get no note

  const stopped = (r: GoalResult) => r.stopReason === 'aborted' || r.stopReason === 'limited' || r.stopReason === 'fatal';
  const goalFailure = (r: GoalResult) => r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`;
  /** An implementer goal that failed on a timed-out last turn while #n is still open (#310); a closed #n was shipped. */
  const timedOutOpen = async (r: GoalResult) => (r.stopReason === 'error' || r.stopReason === 'max-iterations') && !!r.last?.timedOut
    && (await gh.issueState(c.repo, n)) === 'OPEN';
  /** A timed-out impl turn never leaves its WIP only on the local disk: the checkpoint turn, then hx's own commit and
   *  push of what it left, and a handoff note when the checkpoint wrote none; then the issue is narrowed (narrowTimedOut). */
  const saveTimedOut = async (r: GoalResult, summary: string) => {
    const notes = async () => (await gh.commentBodies(c.repo, n, ctx.trusted).catch(() => [] as string[])).filter((b) => b.trimStart().startsWith(HANDOFF_MARKER)).length;
    const before = await notes();
    await checkpoint(p, agent, n, 'impl', r.sessionId, wt.dir, vars, eventLog, env);
    const saved = await saveWip(wt.dir, n, c.defaultBranch);
    if (saved.committed) log(`timed out: hx committed the WIP (wip: checkpoint (#${n}))`, n);
    if (saved.error !== undefined) return fail(r, `the impl turn timed out (${goalFailure(r)}); the ${saved.step} of its WIP failed: ${saved.error}`, summary,
      `The ${saved.step} failed, so the WIP is only in the kept worktree \`${wt.dir}\`. `);
    if (saved.pushed) log(`timed out: hx pushed issue/${n}`, n);
    if ((await notes()) <= before) await gh.comment(c.repo, n, `${HANDOFF_MARKER}\n**hx:** the impl turn timed out and its checkpoint left no note; the work is on branch issue/${n}.`).catch(() => {});
    return narrowTimedOut(r, summary);
  };
  /**
   * The split after a timeout (PRD #300 §2 steps 2–6), once the WIP is pushed: a `size` session in mode after-timeout
   * narrows #n to what its WIP has nearly done and hx files the rest; #n is ready again and the next impl claim resumes
   * the kept worktree. Once only (a narrowed marker by hx's login); a failed session or a failed write ends in fail().
   */
  const narrowTimedOut = async (r: GoalResult, summary: string): Promise<GoalResult> => {
    const why = `the impl turn timed out (${goalFailure(r)})`;
    const where = `The WIP is on branch \`issue/${n}\`. `;
    const err = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
    // nothing was narrowed: the issue fails as before the split after a timeout, the reason in run.log
    const asToday = (cause: string) => { log(`not narrowed after the timeout: ${cause}`, n); return fail(r, why, summary, where); };
    if (!ctx.login) return asToday('no gh login to read the size markers by');
    let body: string, own: string[];
    try {
      [body, own] = await Promise.all([gh.issueBody(c.repo, n), gh.commentBodies(c.repo, n, new Set([ctx.login.toLowerCase()]))]);
    } catch (e) { return asToday(`could not read the issue: ${err(e)}`); }
    if (own.some(firstLineIs(SIZE_NARROWED))) return fail(r, 'the turn timed out again; this issue was already split once after a timeout', summary, where);
    const sizePromise = `SIZE ${n} DONE`;
    const s = await goal('decompose', wt.dir, 'size.md', sizePromise, { MODE: 'after-timeout' });
    const total = `${summary}; size: ${s.iterations} turn(s), ${fmt(totalTokens(s.usage))} tokens`;
    if (stopped(s)) return handBack(s, total);
    const reply = s.done ? parseSizeReply(s.last?.text ?? '', 'after-timeout', sizePromise) : null;
    if (reply?.shape !== 'narrow') return asToday(`the size session failed (${s.done ? 'the reply has no valid SIZE: narrow shape' : goalFailure(s)}; ${total})`);
    // the dependents are read before anything is filed: failing here writes nothing, so it counts as a failed session
    let dependents: { number: number; body: string }[];
    try { dependents = await readDependents(c.repo, n, ctx.trusted); } catch (e) {
      return asToday(`the size session failed (reading the dependents failed: ${err(e)})`);
    }
    // the rest of a PRD child stays that PRD's child
    const par = parseParent(body, c.repo);
    const parent = par && par.repo.toLowerCase() === c.repo.toLowerCase() ? par.number : n;
    const split = await fileSplit(c.repo, L.ready, reply.children, { parent, first: [n], dependents });
    const list = split.filed.map((k) => `#${k}`).join(', ');
    // a write failed partway: nothing more is written; the marker sends a later timeout to agent-blocked (no second split)
    const halt = (step: string, e: unknown) => fail(s, `the narrowing stopped at ${step}: ${err(e)}; filed ${list || 'none'}`, total, where, SIZE_NARROWED);
    if (split.failed) return halt(split.failed.step, split.failed.error);
    try { await gh.editBody(c.repo, n, narrowedBody(body, reply.scope, split.filed, c.turnTimeoutMinutes, c.repo)); } catch (e) { return halt(`the body edit of #${n}`, e); }
    try { await gh.comment(c.repo, n, narrowedComment(split.filed, body)); } catch (e) { return halt('the narrowed comment', e); }
    await relabel(c.repo, n, [], [L.working, L.blocked]);
    log(`split #${n} → ${list || 'none'} (narrowed after a timeout)`, n);
    return { ...s, done: true };
  };
  const promise = `${a.kind === 'impl' ? 'ISSUE' : a.kind.toUpperCase()} ${n} DONE`;
  // an impl session may stop with a question for the owner instead (not a completion: no verify, no PR, no audit)
  const askPromise = a.kind === 'impl' ? `NEEDS_HUMAN ${n}` : undefined;
  /** An impl session stopped with NEEDS_HUMAN: under the cap the question is posted and the issue waits on the owner;
   *  at it, the issue goes back to ready-for-agent. The worktree and branch are kept either way. */
  const askOwner = (r: GoalResult, summary: string) => oneAtATime(async () => {
    const open = openQuestions(await gh.listIssues(c.repo), L, c.repo, ctx.trusted).length;
    if (open >= c.maxOpenQuestions) {
      await gh.comment(c.repo, n, IMPL_TOO_MANY_QUESTIONS).catch(() => {});
      await relabel(c.repo, n, [L.ready], [L.working]);
      log(`asked a question, but ${open} of at most ${c.maxOpenQuestions} are open — not posted, back to ${L.ready} (${summary}); worktree kept`, n);
      return r;
    }
    // the question is the final message alone: the narration before it (tool calls, pushes) never reaches the owner
    // a question that cannot be posted fails the issue: released, the next session would only ask it again
    try { await gh.comment(c.repo, n, questionFromReply(r.last?.final || r.last?.text || '', PROMISE_RE(askPromise!))); } catch (e: any) {
      return fail(r, `the question for the owner could not be posted: ${String(e?.message ?? e).slice(0, 300)}`, summary);
    }
    await relabel(c.repo, n, [L.needsHuman], [L.ready, L.working]);
    log(`asked the owner a question — labelled ${L.needsHuman} (${open + 1} of at most ${c.maxOpenQuestions} open; ${summary}); worktree kept`, n);
    return r;
  });

  /**
   * The up-front size check (PRD #300 §1), in the new impl worktree before the impl session: null = implement the
   * issue now (it has a parent or a size marker by hx's login, it fits, or the check failed and counts as fits);
   * otherwise the result of a split, a stop (no marker, the fresh worktree removed) or a split that stopped partway.
   */
  const sizeUpFront = async (login: string): Promise<GoalResult | null> => {
    let body: string, own: string[];
    try {
      [body, own] = await Promise.all([gh.issueBody(c.repo, n), gh.commentBodies(c.repo, n, new Set([login.toLowerCase()]))]);
    } catch (e: any) { log(`size check skipped: could not read the issue (${String(e?.message ?? e).slice(0, 200)})`, n); return null; }
    if (parseParent(body, c.repo) || own.some((b) => [SIZE_FITS, SIZE_SPLIT, SIZE_NARROWED].some((m) => firstLineIs(m)(b)))) return null;
    const sizePromise = `SIZE ${n} DONE`;
    const r = await goal('decompose', wt.dir, 'size.md', sizePromise, { MODE: 'up-front' });
    const summary = `size check: ${r.iterations} turn(s), ${fmt(totalTokens(r.usage))} tokens`;
    if (stopped(r)) return handBack(r, summary, false);
    const fits = async (failed?: string) => {
      await gh.comment(c.repo, n, `${SIZE_FITS}
**hx:** ${failed ? `size check failed (${failed}); treated as fits.` : 'sized: fits one session.'}`)
        .catch((e) => log(`could not post the size marker: ${String(e?.message ?? e).slice(0, 200)}`, n));
      log(failed ? `size #${n}: check failed (${failed}); treated as fits` : `size #${n}: fits`, n);
      return null;
    };
    const reply = r.done ? parseSizeReply(r.last?.text ?? '', 'up-front', sizePromise) : null;
    if (!reply) return fits(r.done ? 'the reply has no valid SIZE shape'
      : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`);
    if (reply.shape !== 'split') return fits();
    // the dependents are read before anything is filed: failing here writes nothing, so it counts as a failed session
    let dependents: { number: number; body: string }[];
    try { dependents = await readDependents(c.repo, n, ctx.trusted); } catch (e: any) {
      return fits(`reading the dependents failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const split = await fileSplit(c.repo, L.ready, reply.children, { parent: n, first: [], dependents });
    const list = split.filed.map((k) => `#${k}`).join(', ');
    // a write failed partway: nothing more is written, a person finishes or undoes the split (the marker stops a re-size)
    const halt = (step: string, e: unknown) => fail(r, `the split stopped at ${step}: ${String((e as Error)?.message ?? e).slice(0, 300)}; filed ${list || 'none'}`, summary, undefined, SIZE_SPLIT);
    if (split.failed) return halt(split.failed.step, split.failed.error);
    try { await gh.comment(c.repo, n, `${SIZE_SPLIT}
**hx:** split into ${list} — each about one session; the work continues there.`); } catch (e) { return halt('the split comment', e); }
    try { await gh.closeIssue(c.repo, n, undefined, 'not planned'); } catch (e) { return halt(`closing #${n}`, e); }
    await relabel(c.repo, n, [], [L.working]);
    await removeWorktree(p.root, wt.dir);
    log(`split #${n} → ${list}`, n);
    return { ...r, done: true };
  };
  if (a.kind === 'impl' && c.sizeCheck && !wt.resumed && ctx.login && !implLabels.includes(L.bug) && !implLabels.includes(L.gateFix)) {
    const sized = await sizeUpFront(ctx.login);
    if (sized) return sized;
  }

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
        await relabel(c.repo, n, [L.hardened], [L.working]);
        log(`gauntlet round ${round}/${N}: PASS ✓ — labelled ${L.hardened} (${summary})`, n);
        return { ...cr, done: true };
      }
      log(`gauntlet round ${round}/${N}: FAIL ✗ — ${v.findings.split('\n')[0].slice(0, 140)}`, n);
      const before = await gh.issueBody(c.repo, n);
      // keep the body as it was before the first revision, once
      if (!(await gh.commentBodies(c.repo, n, ctx.trusted)).some(firstLineIs(ORIGINAL_MARKER)))
        await gh.comment(c.repo, n, `${ORIGINAL_MARKER}\n${before}`);
      const rwt = await addWorktree(p.root, c.worktreeRoot, prdWorktree(n, c.defaultBranch));
      reviseDir = rwt.dir;
      if ((await setup(rwt, `p${n}`)) === null) {
        await removeWorktree(p.root, rwt.dir);
        return handBack(setupStopped(), 'during the worktree setup');
      }
      const rr = await goal('revise', rwt.dir, 'revise.md', `REVISE ${n} DONE`, { FINDINGS: fenceFindings(v.findings) });
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
      await relabel(c.repo, n, last ? [L.hardened] : [], [L.working]);
      log(`gauntlet round ${round}/${N} done${last ? ` — round cap reached, labelled ${L.hardened}` : ''} (${summary})`, n);
      return { ...rr, done: true };
    } catch (e) {
      // every path ends with the claim released and no worktree left behind
      await relabel(c.repo, n, [], [L.working]);
      await removeWorktree(p.root, wt.dir);
      if (reviseDir) await removeWorktree(p.root, reviseDir);
      throw e;
    }
  }

  // triage: one session reproduces the bug and posts a verdict comment; hx acts on it
  if (a.kind === 'triage') {
    try {
      const r = await goal('triage', wt.dir, 'triage.md', promise);
      const summary = `${r.iterations} turn(s), ${fmt(totalTokens(r.usage))} tokens`;
      if (stopped(r)) return handBack(r, summary);
      await removeWorktree(p.root, wt.dir);
      const verdicts = (await gh.commentBodies(c.repo, n, ctx.trusted)).filter((b) => triageVerdict(b) !== null);
      const v = verdicts.length >= round ? triageVerdict(verdicts.at(-1)!) : null;
      if (v === 'REPRODUCED') {
        if (await relabel(c.repo, n, [L.triaged, L.ready], [L.working])) log(`triage: REPRODUCED ✓ (${summary})`, n);
        else log(`triage: REPRODUCED, but the labels could not be changed — label it ${L.triaged} + ${L.ready} by hand (${summary})`, n);
      } else if (v === 'NEEDS-INFO') {
        await relabel(c.repo, n, [L.blocked], [L.working]);
        log(`triage: NEEDS-INFO — waiting for the reporter (${summary})`, n);
      } else {
        // no verdict: hx's marker counts the round; the issue goes back to the board for the next one
        if (v !== 'FAILED') await gh.comment(c.repo, n, `${TRIAGE_MARKER}\nVERDICT: FAILED (the session ended without a verdict)`);
        await relabel(c.repo, n, [], [L.working]);
        log(`triage: FAILED (${r.done ? 'no verdict comment' : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`}; ${summary})`, n);
      }
      return { ...r, done: v === 'REPRODUCED' || v === 'NEEDS-INFO' };
    } catch (e) {
      await relabel(c.repo, n, [], [L.working]);
      await removeWorktree(p.root, wt.dir);
      throw e;
    }
  }

  // quality bar: one run session records ours and the reference into A/ and B/ (hx picks which is which),
  // then a fresh judge that sees only copies of A/ and B/ picks the better one; hx maps the winner and resolves
  if (a.kind === 'bar') {
    let judgeRoot = '';
    try {
      const N = c.barRounds;
      const qb = parseQualityBar(await gh.issueBody(c.repo, n));
      const product = qb?.product || 'the reference product';
      const dims = (qb?.dimensions ?? []).map((d) => `- ${d}`).join('\n') || '- (none named: judge the product as a whole)';
      const rDir = roundDir(p.stateDir, n, round);
      const picked = pickMapping();
      writeMapping(rDir, picked); // before the run session starts; it never sees which side is which
      const out = (s: Side) => path.join(rDir, picked.A === s ? 'A' : 'B');
      const ref = refDir(p.stateDir, n);
      mkdirSync(ref, { recursive: true });
      const rr = await goal('bar', wt.dir, 'bar.md', BAR_PROMISE, { PRODUCT: qb?.url ? `${product} (${qb.url})` : product,
        REF_DIR: ref, DIMENSIONS: dims, OURS_DIR: out('ours'), REF_OUT_DIR: out('ref') });
      await removeWorktree(p.root, wt.dir);
      const summary = () => `${fmt(sessionTokens)} tokens`;
      if (stopped(rr)) return handBack(rr, summary());
      const provision = /^PROVISION FAILED:\s*(.+)$/m.exec(rr.last?.text ?? '');
      if (provision) {
        const why = provision[1].trim();
        await gh.comment(c.repo, n, `**hx quality bar round ${round}/${N}: the reference could not be provisioned — signed off on the criteria**\n\n${product}: ${why}`);
        await relabel(c.repo, n, [L.barPassed], [L.working]);
        log(`bar round ${round}/${N}: provision failed — ${why.slice(0, 140)}; labelled ${L.barPassed} (${summary()})`, n);
        return { ...rr, done: true };
      }
      if (!rr.done) return fail(rr, rr.stopReason === 'max-iterations' ? `no completion after ${rr.iterations} turns` : `agent error: ${rr.last?.error ?? 'unknown'}`, summary());

      // the judge runs outside the repo on copies of A/ and B/: its prompt names no repo path and no .mapping
      judgeRoot = mkdtempSync(path.join(os.tmpdir(), `hx-bar-${n}-`));
      const jDir = path.join(judgeRoot, `r${round}`);
      for (const s of ['A', 'B']) cpSync(path.join(rDir, s), path.join(jDir, s), { recursive: true });
      let verdict: ReturnType<typeof parseJudgeReply> = null;
      let jr = rr;
      // a reply in another shape (or no promise) is a failed attempt: judged once more on the same recordings
      for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
        jr = await goal('bar', judgeRoot, 'bar-judge.md', BAR_JUDGE_PROMISE, { DIR_A: path.join(jDir, 'A'), DIR_B: path.join(jDir, 'B'), DIMENSIONS: dims });
        if (stopped(jr)) return handBack(jr, summary());
        verdict = parseJudgeReply(jr.done ? jr.last?.text ?? '' : '', BAR_JUDGE_PROMISE);
        if (!verdict) log(`bar round ${round}/${N}: judge attempt ${attempt} gave no valid verdict${attempt < 2 ? ' — judging again' : ''}`, n);
      }
      if (!verdict) {
        await gh.comment(c.repo, n, barMarker(round, 'no verdict', 'none named (the judge gave no valid reply in 2 attempts)', { rounds: N }));
        await relabel(c.repo, n, [L.barPassed], [L.working]);
        log(`bar round ${round}/${N}: no verdict — conceded, labelled ${L.barPassed} (${summary()})`, n);
        return { ...jr, done: true };
      }
      const m = readMapping(rDir) ?? picked;
      const { gap } = verdict;
      if (m[verdict.winner] === 'ours') {
        await gh.comment(c.repo, n, barMarker(round, 'won', gap, { rounds: N }));
        await relabel(c.repo, n, [L.barPassed], [L.working]);
        log(`bar round ${round}/${N}: won — labelled ${L.barPassed}; gap: ${gap.slice(0, 140)} (${summary()})`, n);
      } else if (round < N) {
        const url = await gh.createIssue(c.repo, `Quality bar gap (round ${round}): ${gap.slice(0, 80)}`, gapIssueBody(n, round, gap, product), [L.ready]);
        const gapIssue = Number(/(\d+)\s*$/.exec(url)?.[1]) || undefined;
        await gh.comment(c.repo, n, barMarker(round, 'lost', gap, { rounds: N, issue: gapIssue }));
        // the fix is reviewed again, and checked again when security is on, before the next round
        const drop = [L.reviewed, ...((await gh.issueLabels(c.repo, n)).includes(L.secured) ? [L.secured] : [])];
        await relabel(c.repo, n, [], [L.working, ...drop]);
        log(`bar round ${round}/${N}: lost — filed ${gapIssue ? `#${gapIssue}` : url}, removed ${drop.join(', ')}; gap: ${gap.slice(0, 140)} (${summary()})`, n);
      } else {
        await gh.comment(c.repo, n, barMarker(round, 'lost', gap, { rounds: N }));
        await gh.comment(c.repo, n, barCapComment(N, gap));
        await relabel(c.repo, n, [L.barPassed], [L.working]);
        log(`bar round ${round}/${N}: lost at the cap — labelled ${L.barPassed}, standing gap: ${gap.slice(0, 140)} (${summary()})`, n);
      }
      return { ...jr, done: true };
    } catch (e) {
      await relabel(c.repo, n, [], [L.working]);
      await removeWorktree(p.root, wt.dir);
      throw e;
    } finally {
      if (judgeRoot) rmSync(judgeRoot, { recursive: true, force: true });
    }
  }

  if (!audited) {
    const r = await goal(a.kind, wt.dir, `${a.kind}.md`, promise, {}, askPromise);
    const summary = `${r.iterations} turn(s), ${fmt(totalTokens(r.usage))} tokens`;
    if (r.promiseSeen === 'alt') return askOwner(r, summary);
    if (r.stopReason === 'aborted' && a.kind === 'impl' && r.iterations > 0) await checkpoint(p, agent, n, 'impl', r.sessionId, wt.dir, vars, eventLog, env);
    if (stopped(r)) return handBack(r, summary);
    if (a.kind === 'impl' && await timedOutOpen(r)) return saveTimedOut(r, summary);
    const why = await verify(p, a, n, ctx.trusted, before);
    if (!why) {
      // the pass filed security issues: once they are fixed the PRD is reviewed, then checked, again
      const filedNums = a.kind === 'security' ? [...(await securitySnapshot(p, n, ctx.trusted)).issues].filter((k) => !before?.issues.has(k)).sort((x, y) => x - y) : [];
      const filed = filedNums.length > 0;
      const drop = filed ? [L.reviewed, ...((await gh.issueLabels(c.repo, n)).includes(L.secured) ? [L.secured] : [])] : [];
      await relabel(c.repo, n, [], [L.working, ...drop]);
      if (a.kind === 'decompose') await capQuestions(p, n, ctx.trusted);
      if (filed) log(`security pass filed ${filedNums.map((k) => `#${k}`).join(', ')} — removed ${L.reviewed}`, n);
      await removeWorktree(p.root, wt.dir);
      log(`${a.kind} DONE ✓ (${summary})`, n);
      if (a.kind === 'impl') ctx.merged?.();
      return { ...r, done: true };
    }
    return fail(r, r.done ? why : goalFailure(r), summary);
  }

  // implement → independent audit → (hx merges | back to the implementer with the findings)
  let extra: Record<string, string | number> = {};
  // a PASS held while the default branch was red (#301): only its merge is retried, in the round it passed
  const held = readHeld(p.stateDir)[n];
  if (held) setHeld(p.stateDir, n, undefined);
  for (let attempt = held?.round ?? 1; ; attempt++) {
    let r: GoalResult, pr: number, v: { pass: boolean; findings: string }, summary: string;
    if (held && attempt === held.round) {
      r = { done: true, sessionId: '', iterations: 0, usage: emptyUsage(), costUsd: 0, stopReason: 'promise' };
      pr = held.pr;
      v = { pass: true, findings: '' };
      summary = `${fmt(sessionTokens)} tokens`;
      log(`${c.defaultBranch} is green: merging held PR #${pr} (audit ${attempt}/${c.auditRounds} PASS kept)`, n);
    } else {
      r = await goal('impl', wt.dir, 'impl.md', promise, extra, askPromise);
      summary = `${fmt(sessionTokens)} tokens so far`;
      if (r.promiseSeen === 'alt') return askOwner(r, summary);
      if (r.stopReason === 'aborted' && r.iterations > 0) await checkpoint(p, agent, n, 'impl', r.sessionId, wt.dir, vars, eventLog, env);
      if (stopped(r)) return handBack(r, summary);
      if (await timedOutOpen(r)) return saveTimedOut(r, summary);
      // the owner's answer left nothing to build: the implementer closed the issue with a comment, no PR
      // (asked first: findOpenPr waits ~30 s for a PR that is not there). A PR in any state rules it out: one the
      // implementer merged itself was never audited, and falls through to the no-open-PR failure below
      if (r.done && (await gh.issueState(c.repo, n)) === 'CLOSED' && !(await gh.hasAnyPrFor(c.repo, `issue/${n}`))) {
        await relabel(c.repo, n, [], [L.working]);
        await removeWorktree(p.root, wt.dir);
        log(`DONE ✓ closed without a PR (${summary})`, n);
        return { ...r, done: true };
      }
      const open = r.done ? await findOpenPr(c.repo, `issue/${n}`) : null;
      if (!open) return fail(r, r.done ? 'the implementer reported ready but no open PR for its branch exists'
        : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`, summary);
      pr = open;

      // the auditor works in its own fresh checkout of the pushed branch and never sees the implementer's session
      const awt = await addWorktree(p.root, c.worktreeRoot, auditWorktree(n));
      log(`audit ${attempt}/${c.auditRounds}: PR #${pr}`, n);
      const auditNote = await setup(awt, `a${n}`);
      if (auditNote === null) {
        await removeWorktree(p.root, awt.dir);
        return handBack(setupStopped(), 'during the audit worktree setup');
      }
      const ar = await goal('audit', awt.dir, 'audit.md', `AUDIT ${n} DONE`, { PR: pr, ROUND: attempt, ROUNDS: c.auditRounds,
        BUG_NOTE: bug ? `${AUDIT_BUG_NOTE}\n` : '', SETUP_NOTE: auditNote });
      await removeWorktree(p.root, awt.dir);
      summary = `${fmt(sessionTokens)} tokens`;
      if (stopped(ar)) return handBack(ar, summary);
      const verdict = auditVerdict(ar.done ? ar.last?.text ?? '' : '');
      if (!verdict) return fail(ar, ar.done ? 'the auditor gave no VERDICT line' : `audit did not complete: ${ar.last?.error ?? ar.stopReason}`, summary);
      v = verdict;
      await gh.comment(c.repo, n, `${AUDIT_MARKER}\n**hx audit ${attempt}/${c.auditRounds}: ${v.pass ? 'PASS ✓' : 'FAIL ✗'}** (PR #${pr})\n\n${v.findings}`).catch(() => {});
      log(`audit ${v.pass ? 'PASS ✓' : 'FAIL ✗'}${v.pass ? '' : ` — ${v.findings.split('\n')[0].slice(0, 140)}`}`, n);
    }

    let feedback: string, why: string;
    if (v.pass) {
      const m = await mergeAudited(wt.dir, c, c.gateCommand || readGate(p.stateDir).command || '');
      // the repo only took an auto-merge: it lands within moments, wait for it rather than fail
      if (!m.ok && /AUTO-MERGE set/.test(m.output)) m.ok = await waitClosed(c.repo, n, 10 * 60_000);
      if (m.ok && (await gh.issueState(c.repo, n)) === 'CLOSED') {
        const shipped = await shipInfo(wt.dir);
        await relabel(c.repo, n, [], [L.working]);
        await removeWorktree(p.root, wt.dir);
        log(`DONE ✓ audited and merged (${attempt} round(s), ${summary})`, n);
        ctx.merged?.(shipped?.test);
        return { ...r, done: true };
      }
      if (!m.retry) return fail(r, `merging the audited PR failed: ${m.output.slice(-300)}`, summary);
      // tests fail after the rebase: on a red default branch the PR is at fault only for a test that does not fail there
      const g: { last?: GateResult; fixIssue?: number } = m.code === 4 ? await (ctx.mainGate ? ctx.mainGate() : Promise.resolve(readGate(p.stateDir))) : {};
      const mf = m.code === 4 ? mergeFailure(m.output, g.last) : { held: false as const, notOnMain: [] };
      if (mf.held) {
        setHeld(p.stateDir, n, { pr, round: attempt, at: new Date().toISOString() });
        await gh.comment(c.repo, n, heldComment(c.defaultBranch, g.fixIssue, pr)).catch(() => {});
        await relabel(c.repo, n, [], [L.working]);
        log(`merge held: ${c.defaultBranch} is red${g.fixIssue ? ` (#${g.fixIssue})` : ''} and every failing test fails there too — PR #${pr} merges once it is green; no round counted (${summary})`, n);
        return { ...r, done: true };
      }
      const own = mf.notOnMain;
      feedback = `The audit passed, but merging failed after rebasing on the latest ${c.defaultBranch}:\n\n${m.output.slice(-1500)}\n\n`
        + (own.length ? `${c.defaultBranch} is red, but these failing tests do not fail there, so your branch broke them: ${own.join(', ')}.\n\n` : '')
        + `Fix that on your branch, then ship again with --no-merge. ${RESUME_TESTS_NOTE}`;
      why = `merge after audit failed (${m.code === 3 ? 'rebase conflict' : `tests fail after the rebase${own.length ? `; not failing on ${c.defaultBranch}: ${own.join(', ')}` : ''}`})`;
    } else {
      feedback = `An independent audit of PR #${pr} FAILED with these findings — fix every one (add a test for each), then ship again with --no-merge. ${RESUME_TESTS_NOTE}\n\n${v.findings}`;
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

/** The dependents of a split issue #n (PRD #300 §4): every open issue opened by a trusted account whose
 *  `## Blocked by` names #n in this repo. Never #n itself; refs to other repos are not followed. */
export async function readDependents(repo: string, n: number, trusted: Set<string>): Promise<{ number: number; body: string }[]> {
  return (await gh.listIssues(repo))
    .filter((i) => i.state === 'OPEN' && i.number !== n && isTrusted(i, trusted)
      && parseBlockedBy(i.body, repo).some((r) => r.repo.toLowerCase() === repo.toLowerCase() && r.number === n))
    .map((i) => ({ number: i.number, body: i.body }));
}

/**
 * The writes both size-split paths share: file the children in order (labelled `readyLabel` only, each blocked by
 * `o.first` and then its filed `blockedBy` siblings, parent `o.parent`), then add every filed number to each of
 * `o.dependents` (read by the caller before any filing). The first write that throws stops it: `failed` names it.
 */
export async function fileSplit(repo: string, readyLabel: string, children: SizeChild[],
  o: { parent: number; first: number[]; dependents: { number: number; body: string }[] }): Promise<{ filed: number[]; failed?: { step: string; error: string } }> {
  const filed: number[] = [];
  const stop = (step: string, e: unknown) => ({ filed, failed: { step, error: (e as Error)?.message ?? String(e) } });
  for (const [i, ch] of children.entries()) {
    try {
      const blockers = [...o.first, ...ch.blockedBy.map((k) => filed[k - 1]).filter((x) => x !== undefined)];
      const url = await gh.createIssue(repo, ch.title, withTrailers(ch.body, blockers, o.parent), [readyLabel]);
      const num = Number(/(\d+)\s*$/.exec(url)?.[1]);
      if (!num) throw new Error(`no issue number in "${url}"`);
      filed.push(num);
    } catch (e) { return stop(`filing child ${i + 1}`, e); }
  }
  for (const d of o.dependents) {
    try { await gh.editBody(repo, d.number, addBlockers(d.body, filed)); } catch (e) { return stop(`updating #${d.number}`, e); }
  }
  return { filed };
}

/** {{QUESTIONS_LEFT}} in the decompose prompt: how many `needs-human` issues it may still file. */
export function questionsLeftLine(open: number, cap: number): string {
  const left = Math.max(0, cap - open);
  return left > 0
    ? `You may still file ${left} such question issue(s) (${open} of at most ${cap} are open now); file fewer when you can.`
    : `The owner already has ${open} open question(s), the most allowed (${cap}): file none. Take the recommended choice instead and tell the implementer to note it under \`## Decisions made for you\`.`;
}

export { IMPL_TOO_MANY_QUESTIONS, TOO_MANY_QUESTIONS };

/** {{QUESTION_NOTE}} in the impl prompt: '' under the cap; at it, ask nothing and take the recommended choice. */
export function questionNote(open: number, cap: number): string {
  return open < cap ? '' : `NOTE: the owner already has ${open} open question(s), the most allowed (${cap}): do not ask one. Take the recommended choice yourself and note it in the PR body under \`## Decisions made for you\`.\n`;
}

let questionQueue: Promise<unknown> = Promise.resolve();
/**
 * Runs `fn` once every earlier call has settled: the impl NEEDS_HUMAN stop's "count → post → relabel" runs one at a
 * time in the runner, so two sessions that stop together cannot both pass at maxOpenQuestions − 1.
 */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = questionQueue.then(fn, fn);
  questionQueue = run.catch(() => {});
  return run;
}

/**
 * After a decompose session: past maxOpenQuestions open `needs-human` issues in the repo, PRD `n`'s newest
 * `needs-human` children (highest number first) become `ready-for-agent` until the count is at the cap.
 */
export async function capQuestions(p: Project, n: number, trusted: Set<string>): Promise<number[]> {
  const c = p.config, L = c.labels;
  const all = await gh.listIssues(c.repo);
  let open = openQuestions(all, L, c.repo, trusted).length;
  const mine = all.filter((i) => {
    const par = i.state === 'OPEN' && i.labels.includes(L.needsHuman) && isTrusted(i, trusted) ? parseParent(i.body, c.repo) : null;
    return !!par && par.repo.toLowerCase() === c.repo.toLowerCase() && par.number === n;
  }).map((i) => i.number).sort((x, y) => y - x);
  const swapped: number[] = [];
  for (const k of mine) {
    if (open <= c.maxOpenQuestions) break;
    await relabel(c.repo, k, [L.ready], [L.needsHuman]);
    await gh.comment(c.repo, k, TOO_MANY_QUESTIONS).catch(() => {});
    swapped.push(k);
    open--;
  }
  if (swapped.length) log(`too many open questions (cap ${c.maxOpenQuestions}): ${swapped.map((k) => `#${k}`).join(', ')} relabelled ${L.ready}`, n);
  return swapped;
}

export const AUDIT_MARKER = '<!-- hx-audit -->';
/** {{BUG_NOTE}} for an issue labelled `bug`: one text for the implementer, one for its auditor. */
export const IMPL_BUG_NOTE = 'This is a bug. Start from the triage comment if there is one and add its failing test (or a better one); otherwise write a test that reproduces the bug. See it fail, then fix the root cause. Do not only patch the symptom.';
export const AUDIT_BUG_NOTE = 'Check that a test reproduces the reported bug and fails without the fix (revert the fix locally to check), and that the fix addresses the root cause (the one named in the triage comment, if there is one).';
/** The test rule a resumed or returned implementer is given again: the full suite runs once, in ship.mjs (#223). */
export const RESUME_TESTS_NOTE = 'Run only the affected tests while you work; never the full test command before shipping (ship.mjs runs it after the rebase), and the full suite only after a ship.mjs exit 4, once before shipping again.';
export const TRIAGE_GAVE_UP = 'hx: triage gave up';
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

/**
 * hx's own save of a timed-out impl turn's WIP (#310), after its checkpoint: uncommitted changes are committed as
 * `wip: checkpoint (#n)`, and `issue/<n>` is pushed when HEAD has commits beyond `origin/<base>` that origin's
 * `issue/<n>` does not point at. Never a force push. error: git's own (trimmed) when the commit or the push failed.
 */
export async function saveWip(cwd: string, n: number, base: string): Promise<{ committed: boolean; pushed: boolean; error?: string; step?: 'commit' | 'push' }> {
  const git = (...a: string[]) => runCmd('git', ['-C', cwd, ...a]);
  const err = (x: { stdout: string; stderr: string }) => (x.stderr.trim() || x.stdout.trim()).replace(/\s*\n\s*/g, ' ').slice(-500);
  let committed = false;
  if ((await git('status', '--porcelain')).stdout.trim()) {
    await git('add', '-A');
    const cm = await git('commit', '-q', '-m', `wip: checkpoint (#${n})`);
    if (cm.code) return { committed, pushed: false, error: err(cm), step: 'commit' };
    committed = true;
  }
  if (!Number((await git('rev-list', '--count', `origin/${base}..HEAD`)).stdout.trim())) return { committed, pushed: false };
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  if ((await git('ls-remote', 'origin', `refs/heads/issue/${n}`)).stdout.split(/\s/)[0] === head) return { committed, pushed: false };
  const push = await git('push', '-u', 'origin', `issue/${n}`);
  return push.code ? { committed, pushed: false, error: err(push), step: 'push' } : { committed, pushed: true };
}

/** What the implementer's `ship --no-merge` recorded in its worktree (repo, base, test command, PR). */
export async function shipInfo(cwd: string): Promise<{ test?: string } | null> {
  const dir = (await runCmd('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
  try { return JSON.parse(readFileSync(path.join(dir, 'hx-ship.json'), 'utf8')); } catch { return null; }
}

/** Rebase, re-test, push and merge the audited branch (ship.mjs --resume, run by hx, not by an agent). */
export async function mergeAudited(cwd: string, c: Config, testCmd: string): Promise<{ ok: boolean; retry: boolean; code: number; output: string }> {
  // no hx-ship.json (a PR opened outside ship): ship rebuilds it from the branch's PR with this repo and test command
  const fallback = (await shipInfo(cwd)) ? [] : ['--repo', c.repo, '--base', c.defaultBranch, ...(testCmd ? ['--test', testCmd] : [])];
  return new Promise((resolve) => {
    execFile(process.execPath, [SHIP, '--resume', ...fallback], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      // 3 = rebase conflict, 4 = tests fail after the rebase: the implementer can fix those
      resolve({ ok: code === 0 && /SHIPPED #/.test(stdout), retry: code === 3 || code === 4, code, output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

/** A turn's test time for its UsageRecord: it ended now and ran durationMs; the gate command (config, else gate.json) counts as a test. */
function testTiming(p: Project, events: unknown[], durationMs: number): TurnTiming {
  const turnEnd = Date.now();
  const c = p.config;
  return turnTiming(events, turnEnd - durationMs, turnEnd, testMatcher(c.testPatterns, c.gateCommand || readGate(p.stateDir).command || ''));
}

/**
 * The run is stopping mid-session: resume the session once more and have it commit and push its
 * WIP and leave a handoff comment, so the next session picks up where this one stopped.
 */
async function checkpoint(p: Project, agent: AgentCli, n: number, role: string, sessionId: string, cwd: string, vars: Record<string, string | number>, eventLog: string,
  env: Record<string, string>): Promise<void> {
  const c = p.config;
  const m = roleModel(c, role); // the resumed session's model and effort
  log('checkpointing: committing WIP and writing a handoff note…', n);
  const turnEvents: unknown[] = []; // this turn's events, for its test time
  const t = await runTurn({ agent, bin: agent.bin(c), cwd, model: m.model, effort: m.effort, extraArgs: workerArgs(c),
    timeoutMs: c.checkpointMinutes * 60_000, stallMs: c.stallMinutes * 60_000, sweepRoot: c.worktreeRoot, sessionId, resume: true, env,
    prompt: render(readFileSync(path.join(PROMPTS, 'checkpoint.md'), 'utf8'), vars),
    onEvent: (ev) => { appendFileSync(eventLog, JSON.stringify(ev) + '\n'); turnEvents.push(ev); } });
  recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: n, role: 'checkpoint', sessionId, iteration: 0, model: m.model,
    ...(t.actualModel ? { actualModel: t.actualModel } : {}), ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns,
    ...testTiming(p, turnEvents.splice(0), t.durationMs) });
  log(t.ok ? `checkpoint saved (${fmt(totalTokens(t.usage))} tokens)` : `checkpoint failed: ${t.error?.slice(0, 160)} — the worktree still has the work`, n);
}

type SecuritySnapshot = { issues: Set<number>; comments: number };

/** PRD `n`'s open security issues and its security verdict comments, taken before a security session. */
async function securitySnapshot(p: Project, n: number, trusted: Set<string>): Promise<SecuritySnapshot> {
  const c = p.config;
  const [all, comments] = await Promise.all([gh.listIssues(c.repo), gh.commentBodies(c.repo, n, trusted)]);
  return { issues: new Set(openSecurityIssues(p, all, n, trusted)), comments: comments.filter(firstLineIs(SECURITY_MARKER)).length };
}

/** PRD `n`'s open security issues, counting only those a trusted account opened (same rule as plan()). */
const openSecurityIssues = (p: Project, all: Issue[], n: number, trusted: Set<string>) => all.filter((i) => {
  if (!isTrusted(i, trusted)) return false;
  const par = parseParent(i.body, p.config.repo);
  return i.state === 'OPEN' && i.labels.includes(p.config.labels.security)
    && !!par && par.repo.toLowerCase() === p.config.repo.toLowerCase() && par.number === n;
}).map((i) => i.number);

/** Did the session leave GitHub in the state its role promises? null = yes, else why not. */
async function verify(p: Project, a: SessionAction, n: number, trusted: Set<string>, before?: SecuritySnapshot): Promise<string | null> {
  const c = p.config;
  if (a.kind === 'impl') return (await gh.issueState(c.repo, n)) === 'CLOSED' ? null : 'the agent reported done but the issue is still open';
  const all = await gh.listIssues(c.repo);
  // only issues a trusted account opened count as the PRD's children (same rule as plan())
  const kids = all.filter((i) => {
    if (!isTrusted(i, trusted)) return false;
    const par = parseParent(i.body, c.repo);
    return par && par.repo.toLowerCase() === c.repo.toLowerCase() && par.number === n;
  });
  if (a.kind === 'decompose') return kids.length ? null : 'the agent reported done but filed no issue with `## Parent` #' + n;
  if (a.kind === 'security') {
    const secured = all.find((i) => i.number === n)?.labels.includes(c.labels.secured);
    const filed = openSecurityIssues(p, all, n, trusted).some((k) => !before?.issues.has(k));
    if (!secured && !filed) return `the security pass neither added \`${c.labels.secured}\` nor filed a \`${c.labels.security}\` issue with \`## Parent\` #${n}`;
    // the session owns the verdict comment: hx posts none of its own
    const posted = (await gh.commentBodies(c.repo, n, trusted)).filter(firstLineIs(SECURITY_MARKER)).length > (before?.comments ?? 0);
    return posted ? null : `the security pass posted no \`${SECURITY_MARKER}\` comment`;
  }
  const signedOff = all.find((i) => i.number === n)?.labels.includes(c.labels.reviewed);
  const gaps = kids.some((k) => k.state === 'OPEN');
  return signedOff || gaps ? null : `the review neither added \`${c.labels.reviewed}\` nor filed a gap issue`;
}
