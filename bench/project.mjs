#!/usr/bin/env node
// Project benchmark: one end-user brief (bench/project/brief.md) built end to end, two ways.
//   chat — one Claude session gets the brief and works until it says it is done
//   hx3  — the brief filed with `hx prd`, then `hx run --watch --workers 3` until the PRD closes
// Both run with Hx's lean flags: the chat session gets `workerArgs` of the default config, and `hx run` gives every
// session `workerArgs` of the arm's config. Each run stops at --max-hours or --max-usd, whichever comes first. Then a
// fresh clone of the default branch is graded by the hidden suite (bench/project-grade.mjs).
//
//   node bench/project.mjs <chat|hx3> [--runs N] [--max-hours 4] [--max-usd 60]
// One stamp per call; runs i = 1…N in a row, each with its own private GitHub repo <owner>/hx-project-<arm>-<stamp>-<i>
// (owner from `gh`), work directory, worktree root, grade clone and caps. Each run's result, with its provenance (the
// Claude Code version, the Hx commit, each role's model, effort and flags), goes to
// bench/results/project/<arm>-<stamp>-<i>.json. A run that throws is logged and the next one starts; the call then
// exits 1 naming the failed runs. Costs real usage.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS, loadProject } from '../src/config.ts';
import { resolveCmd } from '../src/exec.ts';
import { grade } from './project-grade.mjs';
import { USAGE, auditFails, capCheck, chatSession, escapedDefects, gateReds, parseArgs, parseJsonl, provenanceRoles, sessionsByRole, setupRepo, usageTotals } from './project-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const WORKERS = { chat: 1, hx3: 3 };
const RESULTS = path.join(here, 'results', 'project');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const json = (cmd, args, opts) => JSON.parse(sh(cmd, args, opts));
const hx = (args, opts = {}) => sh(process.execPath, ['--disable-warning=ExperimentalWarning', HX, ...args], opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 60_000;
const briefFile = path.join(here, 'project', 'brief.md');

/** `YYYYMMDDhhmm` (UTC): one per call. */
export const makeStamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:T]/g, '');

/** The trimmed output of `<bin> --version` (a .mjs bin runs under node, as hx spawns it). */
export function claudeVersion(bin = 'claude') {
  const [cmd, args] = resolveCmd(bin, ['--version']);
  return sh(cmd, args).trim();
}

/** `git rev-parse HEAD` of the Hx checkout running the benchmark. */
export function hxCommit(dir = path.join(here, '..')) {
  return sh('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
}

// 1. a fresh repo from the template, `hx init`, and the benchmark's own edits to .hx/config.json
function setup(ctx) {
  mkdirSync(ctx.work, { recursive: true });
  setupRepo(ctx.work);
  sh('gh', ['repo', 'create', ctx.repo, '--private', '--source', ctx.work, '--push'], { cwd: ctx.work });
  ctx.log(`created ${ctx.repo} in ${ctx.work}`);
  hx(['init'], { cwd: ctx.work });
  const cfgFile = path.join(ctx.work, '.hx', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.workers = WORKERS[ctx.arm];
  cfg.worktreeRoot = ctx.worktreeRoot;
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
}

// 2. run the arm until it is done, capped or ends early: { usage, ended, t0, t1 }
/** The `chat` arm: one session (chatSession's model, effort and lean flags) on the brief, resumed until it says done. */
export async function chatArm(ctx, { run = runGoal, bin = 'claude', session = chatSession() } = {}) {
  const { log, maxHours, maxUsd } = ctx;
  const brief = readFileSync(briefFile, 'utf8');
  const PROMISE = 'PROJECT DONE';
  const prompt = `${brief.trimEnd()}\n\n---\nBuild this in the current directory, a git repo whose default branch is \`main\` `
    + `(remote: ${ctx.repo}). Commit and push to \`main\` as you go: only what is pushed counts. `
    + `When the project is finished and pushed, output exactly:\n<promise>${PROMISE}</promise>\n`;
  const continuePrompt = `Continue building the project from the brief. Commit and push to \`main\` as you go. `
    + `When it is finished and pushed, output exactly:\n<promise>${PROMISE}</promise>`;
  const eventLog = path.join(ctx.work, '.hx', 'chat.jsonl');
  const usage = [];
  const ac = new AbortController();
  let costUsd = 0, capped = false, t1;
  const check = () => {
    if (ac.signal.aborted || capCheck({ elapsedMs: Date.now() - t0, costUsd, maxHours, maxUsd }) === 'continue') return;
    capped = true; t1 = Date.now();
    log(`cap reached ($${costUsd.toFixed(2)}, ${Math.round((t1 - t0) / 60_000)} min): stopping`);
    ac.abort();
  };
  const t0 = Date.now();
  const timer = setInterval(check, TICK);
  let r;
  try {
    r = await run({
      bin, cwd: ctx.work, model: session.model, effort: session.effort, extraArgs: session.extraArgs,
      timeoutMs: 90 * 60_000, stallMs: DEFAULTS.stallMinutes * 60_000,
      prompt, promise: PROMISE, continuePrompt, maxIterations: 1000, signal: ac.signal,
      onEvent: (ev) => appendFileSync(eventLog, JSON.stringify(ev) + '\n'),
      onTurn: (i, sessionId, t) => {
        usage.push({ ts: new Date().toISOString(), issue: 0, role: 'chat', sessionId, iteration: i, durationMs: t.durationMs, usage: t.usage, costUsd: t.costUsd, ok: t.ok });
        costUsd += t.costUsd ?? 0;
        log(`turn ${i}: ${t.ok ? 'ok' : 'error ' + t.error} · ${Math.round(t.durationMs / 1000)}s · $${costUsd.toFixed(2)}`);
        check();
      },
    });
  } finally {
    clearInterval(timer);
  }
  t1 ??= Date.now();
  log(`session ended: ${r.stopReason} after ${r.iterations} turn(s)`);
  return { usage, ended: r.stopReason === 'promise' ? 'done' : capped ? 'capped' : 'early', t0, t1 };
}

/** The `hx3` arm: the brief filed with `hx prd`, then `hx run --watch --workers 3` until the PRD closes. */
async function hx3Arm(ctx) {
  const { log, repo, work, maxHours, maxUsd } = ctx;
  const brief = readFileSync(briefFile, 'utf8');
  const title = /^#\s+(.+)$/m.exec(brief)?.[1]?.trim() ?? 'tally';
  const out = hx(['prd', briefFile, '--title', `PRD: ${title}`], { cwd: work });
  const prd = Number(/\/issues\/(\d+)/.exec(out)?.[1]);
  if (!prd) throw new Error(`hx prd printed no issue url:\n${out}`);
  log(`filed PRD #${prd}`);
  const usageFile = path.join(work, '.hx', 'usage.jsonl');
  const readUsage = () => (existsSync(usageFile) ? parseJsonl(readFileSync(usageFile, 'utf8')) : []);
  const t0 = Date.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HX, 'run', '--watch', '--workers', '3'], { cwd: work, stdio: 'inherit' });
  let exited = false, ended;
  const exit = new Promise((resolve) => child.on('close', () => { exited = true; resolve(); }));
  for (;;) {
    await Promise.race([sleep(TICK), exit]);
    let state = null;
    try { state = json('gh', ['issue', 'view', String(prd), '-R', repo, '--json', 'state']).state; } catch (e) { log(`gh issue view failed: ${e.message.split('\n')[0]}`); }
    if (state === 'CLOSED') { ended = 'done'; break; }
    if (exited) { ended = 'early'; break; }
    const costUsd = usageTotals(readUsage()).costUsd;
    if (capCheck({ elapsedMs: Date.now() - t0, costUsd, maxHours, maxUsd }) === 'stop') { ended = 'capped'; break; }
  }
  const t1 = Date.now();
  log(`ended ${ended}`);
  if (!exited) {
    try { hx(['pause', '--now'], { cwd: work }); } catch (e) { log(`hx pause --now failed: ${e.message.split('\n')[0]}`); }
    await exit;
  }
  return { usage: readUsage(), ended, t0, t1 };
}

// 3. what GitHub says
const issues = (ctx) => json('gh', ['issue', 'list', '-R', ctx.repo, '--state', 'all', '--json', 'number,state', '--limit', '1000']);

// 4. grade a fresh clone of the default branch; nothing is copied into it
function clone(ctx) {
  rmSync(ctx.clone, { recursive: true, force: true });
  sh('gh', ['repo', 'clone', ctx.repo, ctx.clone, '--', '-q']);
}

/** The real per-run steps; a test passes its own. */
export const STEPS = { setup, arm: (ctx) => (ctx.arm === 'chat' ? chatArm(ctx) : hx3Arm(ctx)), issues, clone, grade };

// 5. the runs and their results
/** Runs `arm` `runs` times in a row under one stamp, each run on its own repo, directories and caps, and writes each
 *  run's result to `<resultsDir>/<arm>-<stamp>-<i>.json`. A run that throws is logged and the next one starts.
 *  Returns `{ stamp, files, failed }` (`failed`: the i of each run that threw). */
export async function runSet({
  arm, runs = 1, maxHours = 4, maxUsd = 60, owner, stamp = makeStamp(), resultsDir = RESULTS, tmp = os.tmpdir(),
  claudeBin = 'claude', commit = hxCommit(), steps = STEPS, print = console.log,
}) {
  const files = [], failed = [];
  mkdirSync(resultsDir, { recursive: true });
  for (let i = 1; i <= runs; i++) {
    const name = `${arm}-${stamp}-${i}`;
    const log = (m) => print(`${new Date().toTimeString().slice(0, 8)} [project ${arm} ${i}/${runs}] ${m}`);
    const ctx = {
      arm, i, stamp, repo: `${owner}/hx-project-${name}`, maxHours, maxUsd, log,
      work: path.join(tmp, 'hxp', name), worktreeRoot: path.join(tmp, 'hxp-wt', name), clone: path.join(tmp, 'hxp-grade', name),
    };
    try {
      await steps.setup(ctx);
      const roles = provenanceRoles(arm, arm === 'hx3' ? { config: loadProject(ctx.work).config } : {});
      const provenance = { claudeVersion: claudeVersion(claudeBin), hxCommit: commit, roles };
      const { usage, ended, t0, t1 } = await steps.arm(ctx);
      log(`finished in ${Math.round((t1 - t0) / 1000)}s`);
      const ghIssues = await steps.issues(ctx);
      await steps.clone(ctx);
      const score = await steps.grade(ctx.clone);
      const readState = (f) => { const p = path.join(ctx.work, '.hx', f); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
      const totals = usageTotals(usage);
      const session = arm === 'chat' ? roles.chat : roles.impl;
      const result = {
        arm, run: i, stamp, repo: ctx.repo, model: session.model, effort: session.effort, startedAt: new Date(t0).toISOString(), maxHours, maxUsd,
        passed: score.passed, failed: score.failed, total: score.total, failures: score.failures,
        wallMs: t1 - t0, tokens: totals.tokens, costUsd: totals.costUsd,
        sessions: sessionsByRole(usage),
        issuesFiled: ghIssues.length, issuesClosed: ghIssues.filter((x) => x.state === 'CLOSED').length,
        auditFails: arm === 'chat' ? null : auditFails(readState('run.log')),
        gateReds: arm === 'chat' ? null : gateReds(readState('gate-runs.jsonl')),
        escapedDefects: escapedDefects(score.failed, ended),
        ended, capped: ended === 'capped',
        provenance,
      };
      const file = path.join(resultsDir, `${name}.json`);
      writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
      files.push(file);
      log(`hidden ${result.passed}/${result.total} · ${result.ended} · ${result.issuesClosed}/${result.issuesFiled} issues closed · $${result.costUsd.toFixed(2)} · ${(result.tokens.total / 1e6).toFixed(2)}M tokens → ${file}`);
    } catch (e) {
      failed.push(i);
      log(`run ${i} failed: ${e?.message ?? e}`);
    }
  }
  return { stamp, files, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) { console.error(USAGE); process.exit(2); }
  const owner = sh('gh', ['api', 'user', '-q', '.login']).trim();
  const { failed } = await runSet({ ...args, owner });
  if (failed.length) { console.error(`failed runs: ${failed.join(', ')} of ${args.runs}`); process.exit(1); }
}
