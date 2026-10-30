#!/usr/bin/env node
// Benchmark: the same six issues (bench/issues.json) on a fresh repo, three ways.
//   chat — one Claude session does all six in a row (how most people use an agent)
//   hx1  — hx with 1 worker: one fresh session per issue, one at a time
//   hx3  — hx with 3 workers: fresh sessions, in parallel where `## Blocked by` allows
// Then grades main against hidden tests the agents never saw, and writes bench/results/<config>.json.
//
//   node bench/run.mjs <chat|hx1|hx3>
// Creates a private GitHub repo MorphEdit/hx-bench-<config>-<stamp> (owner from `gh`). Costs real usage.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const config = process.argv[2];
const WORKERS = { chat: 1, hx1: 1, hx3: 3 }[config];
if (!WORKERS) { console.error('usage: node bench/run.mjs <chat|hx1|hx3>'); process.exit(2); }

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const json = (cmd, args, opts) => JSON.parse(sh(cmd, args, opts));
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [bench ${config}] ${m}`);

const owner = sh('gh', ['api', 'user', '-q', '.login']).trim();
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const repo = `${owner}/hx-bench-${config}-${stamp}`;
const work = path.join(os.tmpdir(), 'hxb', `${config}-${stamp}`);
const model = DEFAULTS.model;
const effort = DEFAULTS.effort;

// 1. a fresh repo from the template, with the six issues
mkdirSync(work, { recursive: true });
cpSync(path.join(here, 'template'), work, { recursive: true });
sh('git', ['init', '-q', '-b', 'main'], { cwd: work });
sh('git', ['add', '-A'], { cwd: work });
sh('git', ['commit', '-q', '-m', 'textstat: empty project'], { cwd: work });
sh('gh', ['repo', 'create', repo, '--private', '--source', work, '--push'], { cwd: work });
log(`created ${repo} in ${work}`);
sh('node', ['--disable-warning=ExperimentalWarning', HX, 'init'], { cwd: work });
const cfgFile = path.join(work, '.hx', 'config.json');
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
cfg.workers = WORKERS;
cfg.worktreeRoot = path.join(os.tmpdir(), 'hxb-wt', `${config}-${stamp}`);
writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
const issues = JSON.parse(readFileSync(path.join(here, 'issues.json'), 'utf8'));
for (const it of issues)
  sh('gh', ['issue', 'create', '-R', repo, '--label', cfg.labels.ready, '--title', it.title, '--body-file', '-'], { input: it.body });
log(`filed ${issues.length} issues`);

// 2. run it
const usage = []; // { ts, issue, role, sessionId, iteration, durationMs, usage }
const t0 = Date.now();
if (config === 'chat') {
  const prompt = readFileSync(path.join(here, 'chat.md'), 'utf8').replaceAll('{{REPO}}', repo);
  const eventLog = path.join(work, '.hx', 'chat.jsonl');
  const r = await runGoal({
    bin: 'claude', cwd: work, model, effort, extraArgs: [], timeoutMs: 90 * 60_000, prompt, promise: 'ALL ISSUES DONE',
    continuePrompt: `Continue. Check which of issues #1-#6 of ${repo} are still open and keep going. When all six are closed, output exactly:\n<promise>ALL ISSUES DONE</promise>`,
    maxIterations: 10,
    onEvent: (ev) => appendFileSync(eventLog, JSON.stringify(ev) + '\n'),
    onTurn: (i, sessionId, t) => {
      usage.push({ ts: new Date().toISOString(), issue: 0, role: 'chat', sessionId, iteration: i, durationMs: t.durationMs, usage: t.usage, ok: t.ok });
      log(`turn ${i}: ${t.ok ? 'ok' : 'error ' + t.error} · ${Math.round(t.durationMs / 1000)}s`);
    },
  });
  log(`session ended: ${r.stopReason} after ${r.iterations} turn(s)`);
} else {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HX, 'run'], { cwd: work, stdio: 'inherit' });
    child.on('close', resolve);
  });
  const f = path.join(work, '.hx', 'usage.jsonl');
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) usage.push(JSON.parse(l));
}
const t1 = Date.now();
log(`finished in ${Math.round((t1 - t0) / 1000)}s`);

// 3. what GitHub says
const ghIssues = json('gh', ['issue', 'list', '-R', repo, '--state', 'all', '--json', 'number,state,closedAt', '--limit', '100']);
const prs = json('gh', ['pr', 'list', '-R', repo, '--state', 'all', '--json', 'number,title,state,createdAt,mergedAt,headRefName', '--limit', '100']);

// 4. grade a fresh clone of main against the hidden tests
const grade = path.join(os.tmpdir(), 'hxb-grade', `${config}-${stamp}`);
rmSync(grade, { recursive: true, force: true });
sh('gh', ['repo', 'clone', repo, grade, '--', '-q']);
cpSync(path.join(here, 'hidden'), path.join(grade, 'hidden'), { recursive: true });
const hidden = {};
for (const f of readdirSync(path.join(grade, 'hidden')).sort()) {
  const n = Number(/i(\d+)/.exec(f)[1]);
  try { sh(process.execPath, ['--test', path.join('hidden', f)], { cwd: grade }); hidden[n] = true; } catch { hidden[n] = false; }
}
let ownTests = null;
try { const out = sh('npm', ['test'], { cwd: grade, shell: true }); ownTests = /ℹ pass (\d+)/.exec(out)?.[1] ?? null; } catch { ownTests = 'failing'; }

// 5. timeline: when each issue was being worked on, relative to the start
const sum = (k) => usage.reduce((a, u) => a + (u.usage?.[k] ?? 0), 0);
let timeline;
if (config === 'chat') {
  // one session; an issue's bar runs from the previous merge (or the start) to its own PR's merge
  const merged = prs.filter((p) => p.mergedAt).sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  let prev = t0;
  timeline = merged.map((p) => {
    const n = Number(/issue\/(\d+)/.exec(p.headRefName)?.[1] ?? /#(\d+)/.exec(p.title)?.[1] ?? 0);
    const seg = { issue: n, role: 'impl', lane: 0, start: prev - t0, end: Date.parse(p.mergedAt) - t0 };
    prev = Date.parse(p.mergedAt);
    return seg;
  });
} else {
  // sessions from hx's usage log: a session spans its first turn's start to its last turn's end
  const sessions = new Map();
  for (const u of usage) {
    const end = Date.parse(u.ts) - t0;
    const start = end - u.durationMs;
    const s = sessions.get(u.sessionId) ?? { issue: u.issue, role: u.role, start, end };
    s.start = Math.min(s.start, start); s.end = Math.max(s.end, end);
    sessions.set(u.sessionId, s);
  }
  const lanes = [];
  timeline = [...sessions.values()].sort((a, b) => a.start - b.start).map((s) => {
    let lane = lanes.findIndex((free) => free <= s.start);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = s.end;
    return { ...s, lane };
  });
}

const result = {
  config, workers: WORKERS, model, effort, repo, startedAt: new Date(t0).toISOString(), wallMs: t1 - t0,
  tokens: { input: sum('input'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'), output: sum('output') },
  turns: usage.length, sessions: new Set(usage.map((u) => u.sessionId)).size,
  issuesClosed: ghIssues.filter((i) => i.state === 'CLOSED').length, issuesTotal: ghIssues.length,
  prsMerged: prs.filter((p) => p.mergedAt).length, hidden, hiddenPassed: Object.values(hidden).filter(Boolean).length,
  ownTestsPassing: ownTests, timeline,
};
result.tokens.total = result.tokens.input + result.tokens.cacheWrite + result.tokens.cacheRead + result.tokens.output;
mkdirSync(path.join(here, 'results'), { recursive: true });
writeFileSync(path.join(here, 'results', `${config}.json`), JSON.stringify(result, null, 2) + '\n');
log(`hidden tests ${result.hiddenPassed}/6 · ${result.issuesClosed}/${result.issuesTotal} issues closed · ${result.prsMerged} PRs merged · ${(result.tokens.total / 1e6).toFixed(2)}M tokens`);
