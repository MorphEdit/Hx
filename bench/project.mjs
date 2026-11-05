#!/usr/bin/env node
// Project benchmark: one end-user brief (bench/project/brief.md) built end to end, two ways.
//   chat — one Claude session gets the brief and works until it says it is done
//   hx3  — the brief filed with `hx prd`, then `hx run --watch --workers 3` until the PRD closes
// Each stops at --max-hours or --max-usd, whichever comes first. Then a fresh clone of the default branch is
// graded by the hidden suite (bench/project-grade.mjs), and the result goes to bench/results/project-<arm>.json.
//
//   node bench/project.mjs <chat|hx3> [--max-hours 4] [--max-usd 60]
// Creates a private GitHub repo <owner>/hx-project-<arm>-<stamp> (owner from `gh`). Costs real usage.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS } from '../src/config.ts';
import { grade } from './project-grade.mjs';
import { auditFails, capCheck, escapedDefects, gateReds, parseJsonl, sessionsByRole, setupRepo, usageTotals } from './project-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const arm = process.argv[2];
const WORKERS = { chat: 1, hx3: 3 }[arm];
const usageLine = 'usage: node bench/project.mjs <chat|hx3> [--max-hours 4] [--max-usd 60]';
if (!WORKERS) { console.error(usageLine); process.exit(2); }
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  if (!(v > 0)) { console.error(usageLine); process.exit(2); }
  return v;
};
const maxHours = flag('--max-hours', 4);
const maxUsd = flag('--max-usd', 60);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const json = (cmd, args, opts) => JSON.parse(sh(cmd, args, opts));
const hx = (args, opts = {}) => sh(process.execPath, ['--disable-warning=ExperimentalWarning', HX, ...args], opts);
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [project ${arm}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 60_000;

const owner = sh('gh', ['api', 'user', '-q', '.login']).trim();
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const repo = `${owner}/hx-project-${arm}-${stamp}`;
const work = path.join(os.tmpdir(), 'hxp', `${arm}-${stamp}`);
const model = DEFAULTS.model;
const effort = DEFAULTS.effort;
const briefFile = path.join(here, 'project', 'brief.md');
const brief = readFileSync(briefFile, 'utf8');

// 1. a fresh repo from the template
mkdirSync(work, { recursive: true });
setupRepo(work);
sh('gh', ['repo', 'create', repo, '--private', '--source', work, '--push'], { cwd: work });
log(`created ${repo} in ${work}`);
hx(['init'], { cwd: work });
const cfgFile = path.join(work, '.hx', 'config.json');
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
cfg.workers = WORKERS;
cfg.worktreeRoot = path.join(os.tmpdir(), 'hxp-wt', `${arm}-${stamp}`);
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

// 2. run the arm until it is done, capped or ends early
let usage = []; // usage records: { role, sessionId, usage, costUsd, … }
let ended; // 'done' | 'capped' | 'early'
let t0, t1;
if (arm === 'chat') {
  const PROMISE = 'PROJECT DONE';
  const prompt = `${brief.trimEnd()}\n\n---\nBuild this in the current directory, a git repo whose default branch is \`main\` `
    + `(remote: ${repo}). Commit and push to \`main\` as you go: only what is pushed counts. `
    + `When the project is finished and pushed, output exactly:\n<promise>${PROMISE}</promise>\n`;
  const continuePrompt = `Continue building the project from the brief. Commit and push to \`main\` as you go. `
    + `When it is finished and pushed, output exactly:\n<promise>${PROMISE}</promise>`;
  const eventLog = path.join(work, '.hx', 'chat.jsonl');
  const ac = new AbortController();
  let costUsd = 0, capped = false;
  const check = () => {
    if (ac.signal.aborted || capCheck({ elapsedMs: Date.now() - t0, costUsd, maxHours, maxUsd }) === 'continue') return;
    capped = true; t1 = Date.now();
    log(`cap reached ($${costUsd.toFixed(2)}, ${Math.round((t1 - t0) / 60_000)} min): stopping`);
    ac.abort();
  };
  t0 = Date.now();
  const timer = setInterval(check, TICK);
  const r = await runGoal({
    bin: 'claude', cwd: work, model, effort, extraArgs: [], timeoutMs: 90 * 60_000, stallMs: DEFAULTS.stallMinutes * 60_000,
    prompt, promise: PROMISE, continuePrompt, maxIterations: 1000, signal: ac.signal,
    onEvent: (ev) => appendFileSync(eventLog, JSON.stringify(ev) + '\n'),
    onTurn: (i, sessionId, t) => {
      usage.push({ ts: new Date().toISOString(), issue: 0, role: 'chat', sessionId, iteration: i, durationMs: t.durationMs, usage: t.usage, costUsd: t.costUsd, ok: t.ok });
      costUsd += t.costUsd ?? 0;
      log(`turn ${i}: ${t.ok ? 'ok' : 'error ' + t.error} · ${Math.round(t.durationMs / 1000)}s · $${costUsd.toFixed(2)}`);
      check();
    },
  });
  clearInterval(timer);
  t1 ??= Date.now();
  ended = r.stopReason === 'promise' ? 'done' : capped ? 'capped' : 'early';
  log(`session ended: ${r.stopReason} after ${r.iterations} turn(s)`);
} else {
  const title = /^#\s+(.+)$/m.exec(brief)?.[1]?.trim() ?? 'tally';
  const out = hx(['prd', briefFile, '--title', `PRD: ${title}`], { cwd: work });
  const prd = Number(/\/issues\/(\d+)/.exec(out)?.[1]);
  if (!prd) throw new Error(`hx prd printed no issue url:\n${out}`);
  log(`filed PRD #${prd}`);
  const usageFile = path.join(work, '.hx', 'usage.jsonl');
  const readUsage = () => (existsSync(usageFile) ? parseJsonl(readFileSync(usageFile, 'utf8')) : []);
  t0 = Date.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HX, 'run', '--watch', '--workers', '3'], { cwd: work, stdio: 'inherit' });
  let exited = false;
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
  t1 = Date.now();
  log(`ended ${ended}`);
  if (!exited) {
    try { hx(['pause', '--now'], { cwd: work }); } catch (e) { log(`hx pause --now failed: ${e.message.split('\n')[0]}`); }
    await exit;
  }
  usage = readUsage();
}
log(`finished in ${Math.round((t1 - t0) / 1000)}s`);

// 3. what GitHub says
const ghIssues = json('gh', ['issue', 'list', '-R', repo, '--state', 'all', '--json', 'number,state', '--limit', '1000']);

// 4. grade a fresh clone of the default branch; nothing is copied into it
const clone = path.join(os.tmpdir(), 'hxp-grade', `${arm}-${stamp}`);
rmSync(clone, { recursive: true, force: true });
sh('gh', ['repo', 'clone', repo, clone, '--', '-q']);
const score = grade(clone);

// 5. the result
const readState = (f) => { const p = path.join(work, '.hx', f); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
const totals = usageTotals(usage);
const result = {
  arm, repo, model, effort, startedAt: new Date(t0).toISOString(), maxHours, maxUsd,
  passed: score.passed, failed: score.failed, total: score.total, failures: score.failures,
  wallMs: t1 - t0, tokens: totals.tokens, costUsd: totals.costUsd,
  sessions: sessionsByRole(usage),
  issuesFiled: ghIssues.length, issuesClosed: ghIssues.filter((i) => i.state === 'CLOSED').length,
  auditFails: arm === 'chat' ? null : auditFails(readState('run.log')),
  gateReds: arm === 'chat' ? null : gateReds(readState('gate-runs.jsonl')),
  escapedDefects: escapedDefects(score.failed, ended),
  ended, capped: ended === 'capped',
};
mkdirSync(path.join(here, 'results'), { recursive: true });
writeFileSync(path.join(here, 'results', `project-${arm}.json`), JSON.stringify(result, null, 2) + '\n');
log(`hidden ${result.passed}/${result.total} · ${result.ended} · ${result.issuesClosed}/${result.issuesFiled} issues closed · $${result.costUsd.toFixed(2)} · ${(result.tokens.total / 1e6).toFixed(2)}M tokens`);
