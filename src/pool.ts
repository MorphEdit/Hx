import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './config.ts';
import * as gh from './github.ts';
import type { Issue } from './github.ts';
import { externalRefs, issueKey, parseParent, plan, prdKey, refKey, render, type Action, type Plan } from './state.ts';
import { addWorktree, implWorktree, prdWorktree, removeWorktree } from './worktree.ts';
import { runGoal, type GoalResult } from './agent.ts';
import { fmt, recordUsage, totalTokens } from './usage.ts';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
export const REVIEW_MARKER = '<!-- hx-review -->';

type SessionAction = Extract<Action, { kind: 'impl' | 'decompose' | 'review' }>;

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
  return plan(issues, repo, labels, states, busy);
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
  const inFlight = new Map<string, Promise<void>>();
  let limitedUntil = 0;
  let idleLogged = false;
  let failures = 0;
  let engineRetries = 0;
  let fatal: string | undefined; // a setup error: stop claiming, let running sessions finish

  log(`hx pool up — ${c.repo} · ${o.workers} worker(s) · model ${c.model}${c.effort ? ` (${c.effort} effort)` : ''} · max ${c.maxIterations} iterations/session`);
  let finished = 0; // sessions ended so far: a plan read while one was ending is already stale
  while (!o.signal.aborted && !fatal) {
    let actions: Action[] = [];
    const finishedBefore = finished;
    if (Date.now() >= limitedUntil) {
      try {
        const pl = await readPlan(p, new Set(inFlight.keys()));
        if (o.dryRun) {
          printPlan(pl, c.repo);
          console.log(pl.actions.length ? `\nnext: ${pl.actions.slice(0, o.workers + 5).map((a) => `${a.kind} #${target(a)}`).join(', ')}` : '\nnothing to do');
          return 0;
        }
        actions = pl.actions.filter((a) => !o.only || o.only.includes(target(a)));
      } catch (e: any) {
        log(`board read failed, retrying next poll: ${e.message}`);
      }
    }

    for (const a of actions) {
      if (o.signal.aborted) break;
      if (a.kind === 'close-prd' || a.kind === 'label-ready') { await engineStep(p, a).catch((e) => log(`${a.kind} failed: ${e.message}`, target(a))); continue; }
      if (inFlight.size >= o.workers) continue; // engine steps further down still run
      idleLogged = false;
      const key = keyOf(a);
      const task = work(p, a, o.signal).then((r) => {
        if (r?.stopReason === 'limited') {
          const reset = r.last?.limited?.resetsAt ? r.last.limited.resetsAt * 1000 : Date.now() + 30 * 60_000;
          limitedUntil = Math.max(limitedUntil, reset);
          log(`usage limit reached — no new claims until ${new Date(limitedUntil).toLocaleTimeString()}`);
        } else if (r?.stopReason === 'fatal') {
          fatal = r.last?.error ?? 'unknown setup error';
        } else if (r && !r.done && r.stopReason !== 'aborted') failures++;
      }).catch((e) => { failures++; log(`crashed: ${e.message}`, target(a)); })
        .finally(() => { inFlight.delete(key); finished++; });
      inFlight.set(key, task);
    }

    if (!inFlight.size) {
      if (finished !== finishedBefore) continue; // the plan predates a session ending: read it again
      const limited = Date.now() < limitedUntil;
      // an engine step (PRD closed, child labelled) may have unlocked work: re-read before giving up
      const engineOnly = actions.length > 0 && actions.every((a) => a.kind === 'close-prd' || a.kind === 'label-ready');
      engineRetries = engineOnly ? engineRetries + 1 : 0;
      if (!o.watch && !limited && (!engineOnly || engineRetries > 3)) { log('nothing left to do — done'); break; }
      if (engineOnly) { await sleep(2000, o.signal); continue; }
      if (!idleLogged) { log(limited ? 'waiting for the usage limit to reset…' : 'board empty — watching for new issues'); idleLogged = true; }
    }
    // wake on the first finished task, or after a poll interval to pick up new / unblocked issues
    await Promise.race([sleep(c.pollSeconds * 1000, o.signal), ...inFlight.values()]);
  }
  if (inFlight.size) { log(`stopping — waiting for ${inFlight.size} session(s) to release their issues…`); await Promise.allSettled(inFlight.values()); }
  if (fatal) {
    log(`STOPPED: Claude rejected the setup — ${fatal.slice(0, 300)}`);
    log(`check config.model ('${c.model}'), claude --version, and that claude is logged in; no issue was labelled.`);
    return 2;
  }
  return failures ? 1 : 0;
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

async function work(p: Project, a: SessionAction, signal: AbortSignal): Promise<GoalResult | undefined> {
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

  const promise = `${a.kind === 'impl' ? 'ISSUE' : a.kind.toUpperCase()} ${n} DONE`;
  const L = c.labels;
  const vars: Record<string, string | number> = {
    REPO: c.repo, BASE: c.defaultBranch, PROMISE: promise, TITLE: title,
    LABEL_READY: L.ready, LABEL_REVIEWED: L.reviewed, ROUND: round, ROUNDS: c.reviewRounds,
    ISSUE: n, PRD: n, BRANCH: `issue/${n}`,
    EXISTING: a.kind === 'decompose' ? childList(a.children) : '', CHILDREN: a.kind === 'review' ? childList(a.children) : '',
    RESUMED: wt.resumed ? `NOTE: this branch already has work from an earlier session — run \`git log origin/${c.defaultBranch}..HEAD\` and \`git status\` first and continue from there.` : '',
    SUBJECT: a.kind === 'impl' ? `issue #${n} (branch issue/${n}): look at \`git status\`, its PR (\`gh pr list -R ${c.repo} --head issue/${n}\`) and the issue`
      : a.kind === 'decompose' ? `PRD #${n}: list the issues you have filed for it so far` : `the review of PRD #${n}`,
  };
  const prompt = render(readFileSync(path.join(PROMPTS, `${a.kind}.md`), 'utf8'), vars);
  const cont = render(readFileSync(path.join(PROMPTS, 'continue.md'), 'utf8'), vars);
  const logDir = path.join(p.stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const eventLog = path.join(logDir, `${a.kind === 'impl' ? 'issue' : a.kind}-${n}.jsonl`);
  log(`working in ${wt.dir}${wt.resumed ? ' (resuming earlier work)' : ''}`, n);

  const r = await runGoal({
    bin: c.claudeBin, cwd: wt.dir, model: c.model, effort: c.effort, extraArgs: c.claudeArgs, timeoutMs: c.turnTimeoutMinutes * 60_000,
    prompt, continuePrompt: cont, promise, maxIterations: c.maxIterations, signal,
    onEvent: (ev) => appendFileSync(eventLog, JSON.stringify(ev) + '\n'),
    onTurn: (i, sessionId, t) => {
      recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: n, role: a.kind, sessionId, iteration: i, model: c.model,
        ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns });
      log(`turn ${i}: ${t.ok ? 'ok' : 'error'} · ${fmt(totalTokens(t.usage))} tokens (${fmt(t.usage.output)} out) · ${Math.round(t.durationMs / 1000)}s${t.error ? ` · ${t.error.slice(0, 160)}` : ''}`, n);
    },
  });

  const keepOnStop = a.kind === 'impl'; // only an implementation worktree can hold unpushed work
  const summary = `${r.iterations} turn(s), ${fmt(totalTokens(r.usage))} tokens`;
  if (r.stopReason === 'aborted' || r.stopReason === 'limited' || r.stopReason === 'fatal') {
    // not a failure of the issue: hand it back untouched
    await gh.editLabels(c.repo, n, [], [L.working]).catch(() => {});
    if (!keepOnStop) await removeWorktree(p.root, wt.dir);
    const what = { aborted: 'stopped', limited: 'paused by usage limit', fatal: `stopped by a setup error (${r.last?.error?.slice(0, 200)})` }[r.stopReason];
    log(`${what} — released (${summary})${keepOnStop ? '; worktree kept' : ''}`, n);
    return r;
  }

  const why = await verify(p, a, n);
  if (!why) {
    await gh.editLabels(c.repo, n, [], [L.working]).catch(() => {});
    await removeWorktree(p.root, wt.dir);
    log(`${a.kind} DONE ✓ (${summary})`, n);
    return { ...r, done: true };
  }
  const reason = r.done ? why : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`;
  await gh.comment(c.repo, n, `**hx:** ${a.kind} stopped — ${reason} (${summary}).\n\nLast reply:\n\n${(r.last?.text ?? '').slice(-1500).replace(/^/gm, '> ')}\n\n${a.kind === 'impl' ? `Work is on branch \`issue/${n}\` if it was pushed. ` : ''}Remove the \`${L.blocked}\` label to let hx try again.`).catch(() => {});
  await gh.editLabels(c.repo, n, [L.blocked], [L.working]).catch(() => {});
  if (!keepOnStop) await removeWorktree(p.root, wt.dir);
  log(`${a.kind} FAILED ✗ — ${reason} (${summary}); labelled ${L.blocked}${keepOnStop ? ', worktree kept' : ''}`, n);
  return { ...r, done: false };
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
