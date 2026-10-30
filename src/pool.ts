import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './config.ts';
import * as gh from './github.ts';
import { board, externalRefs, refKey, render, type BoardRow } from './state.ts';
import { addWorktree, removeWorktree } from './worktree.ts';
import { runGoal, type GoalResult } from './agent.ts';
import { fmt, recordUsage, totalTokens } from './usage.ts';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export interface PoolOptions {
  workers: number;
  watch: boolean; // keep polling for new issues instead of exiting when the board is empty
  dryRun: boolean;
  only?: number[];
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

/** The board as the pool sees it: open ready issues, with every blocker's state resolved. */
export async function readBoard(p: Project, inFlight: Set<number> = new Set()): Promise<BoardRow[]> {
  const { repo, labels } = p.config;
  const [issues, own] = await Promise.all([gh.listOpenIssues(repo), gh.allStates(repo)]);
  const states = new Map<string, 'OPEN' | 'CLOSED'>();
  for (const [n, s] of own) states.set(refKey({ repo, number: n }), s);
  for (const r of externalRefs(issues, repo)) {
    const s = await gh.issueState(r.repo, r.number);
    if (s) states.set(refKey(r), s);
  }
  return board(issues, repo, labels, states, inFlight);
}

export async function runPool(p: Project, o: PoolOptions): Promise<number> {
  const c = p.config;
  const inFlight = new Map<number, Promise<void>>();
  let limitedUntil = 0;
  let idleLogged = false;
  let failures = 0;

  log(`hx pool up — ${c.repo} · ${o.workers} worker(s) · model ${c.model} · max ${c.maxIterations} iterations/issue`);
  while (!o.signal.aborted) {
    const now = Date.now();
    let claimable: BoardRow[] = [];
    if (now >= limitedUntil) {
      try {
        const rows = await readBoard(p, new Set(inFlight.keys()));
        claimable = rows.filter((r) => r.status === 'claimable' && (!o.only || o.only.includes(r.number)));
        if (o.dryRun) {
          for (const r of rows) log(`${r.status.padEnd(13)} ${r.title}${r.waitingOn.length ? `  (waits on ${r.waitingOn.map((w) => `${w.repo}#${w.number}`).join(', ')})` : ''}`, r.number);
          if (!rows.length) log(`no open issues labelled '${c.labels.ready}'`);
          return 0;
        }
      } catch (e: any) {
        log(`board read failed, retrying next poll: ${e.message}`);
      }
    }

    for (const row of claimable) {
      if (inFlight.size >= o.workers || o.signal.aborted) break;
      idleLogged = false;
      const task = work(p, row, o.signal).then((r) => {
        if (r?.stopReason === 'limited') {
          const reset = r.last?.limited?.resetsAt ? r.last.limited.resetsAt * 1000 : Date.now() + 30 * 60_000;
          limitedUntil = Math.max(limitedUntil, reset);
          log(`usage limit reached — no new claims until ${new Date(limitedUntil).toLocaleTimeString()}`);
        } else if (r && !r.done && r.stopReason !== 'aborted') failures++;
      }).catch((e) => { failures++; log(`crashed: ${e.message}`, row.number); })
        .finally(() => inFlight.delete(row.number));
      inFlight.set(row.number, task);
    }

    if (!inFlight.size) {
      const limited = Date.now() < limitedUntil;
      if (!o.watch && !limited) { log('nothing left to claim — done'); break; }
      if (!idleLogged) { log(limited ? 'waiting for the usage limit to reset…' : 'board empty — watching for new issues'); idleLogged = true; }
    }
    // wake on the first finished task, or after a poll interval to pick up new / unblocked issues
    await Promise.race([sleep(c.pollSeconds * 1000, o.signal), ...inFlight.values()]);
  }
  if (inFlight.size) { log(`stopping — waiting for ${inFlight.size} session(s) to release their issues…`); await Promise.allSettled(inFlight.values()); }
  return failures ? 1 : 0;
}

async function work(p: Project, row: BoardRow, signal: AbortSignal): Promise<GoalResult | undefined> {
  const c = p.config;
  const n = row.number;
  await gh.editLabels(c.repo, n, [c.labels.working]);
  log(`claimed: ${row.title}`, n);

  let wt: { dir: string; resumed: boolean };
  try {
    wt = await addWorktree(p.root, c.worktreeRoot, n, c.defaultBranch);
  } catch (e: any) {
    await gh.editLabels(c.repo, n, [], [c.labels.working]).catch(() => {});
    throw e;
  }
  const promise = `ISSUE ${n} DONE`;
  const vars = { REPO: c.repo, ISSUE: n, TITLE: row.title, BRANCH: `issue/${n}`, BASE: c.defaultBranch, PROMISE: promise,
    RESUMED: wt.resumed ? `NOTE: this branch already has work from an earlier session — run \`git log origin/${c.defaultBranch}..HEAD\` and \`git status\` first and continue from there.` : '' };
  const prompt = render(readFileSync(path.join(PROMPTS, 'impl.md'), 'utf8'), vars);
  const cont = render(readFileSync(path.join(PROMPTS, 'continue.md'), 'utf8'), vars);
  const logDir = path.join(p.stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const eventLog = path.join(logDir, `issue-${n}.jsonl`);
  log(`working in ${wt.dir}${wt.resumed ? ' (resuming earlier work)' : ''}`, n);

  const r = await runGoal({
    bin: c.claudeBin, cwd: wt.dir, model: c.model, extraArgs: c.claudeArgs, timeoutMs: c.turnTimeoutMinutes * 60_000,
    prompt, continuePrompt: cont, promise, maxIterations: c.maxIterations, signal,
    onEvent: (ev) => appendFileSync(eventLog, JSON.stringify(ev) + '\n'),
    onTurn: (i, sessionId, t) => {
      recordUsage(p.stateDir, { ts: new Date().toISOString(), issue: n, role: 'impl', sessionId, iteration: i, model: c.model,
        ok: t.ok, usage: t.usage, costUsd: t.costUsd, durationMs: t.durationMs, numTurns: t.numTurns });
      log(`turn ${i}: ${t.ok ? 'ok' : 'error'} · ${fmt(totalTokens(t.usage))} tokens (${fmt(t.usage.output)} out) · ${Math.round(t.durationMs / 1000)}s${t.error ? ` · ${t.error.slice(0, 160)}` : ''}`, n);
    },
  });

  const summary = `${r.iterations} turn(s), ${fmt(totalTokens(r.usage))} tokens`;
  if (r.stopReason === 'aborted' || r.stopReason === 'limited') {
    // not a failure of the issue: hand it back untouched, keep the worktree for the next run
    await gh.editLabels(c.repo, n, [], [c.labels.working]).catch(() => {});
    log(`${r.stopReason === 'aborted' ? 'stopped' : 'paused by usage limit'} — released (${summary}); worktree kept`, n);
    return r;
  }
  const closed = (await gh.issueState(c.repo, n)) === 'CLOSED';
  if (closed) {
    await gh.editLabels(c.repo, n, [], [c.labels.working]).catch(() => {});
    await removeWorktree(p.root, wt.dir);
    log(`DONE ✓ (${summary})`, n);
    return { ...r, done: true };
  }
  const why = r.done ? 'the agent reported done but the issue is still open'
    : r.stopReason === 'max-iterations' ? `no completion after ${r.iterations} turns` : `agent error: ${r.last?.error ?? 'unknown'}`;
  await gh.comment(c.repo, n, `**hx:** stopped — ${why} (${summary}).\n\nLast reply:\n\n${(r.last?.text ?? '').slice(-1500).replace(/^/gm, '> ')}\n\nWork is on branch \`issue/${n}\` if it was pushed. Remove the \`${c.labels.blocked}\` label to let hx try again.`).catch(() => {});
  await gh.editLabels(c.repo, n, [c.labels.blocked], [c.labels.working]).catch(() => {});
  log(`FAILED ✗ — ${why} (${summary}); labelled ${c.labels.blocked}, worktree kept`, n);
  return { ...r, done: false };
}
