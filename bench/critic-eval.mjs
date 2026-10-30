#!/usr/bin/env node
// Critic eval: does the gauntlet's critic catch a planted defect in a PRD, and pass a clean one?
//
// critic-eval/*.md are PRDs for the textstat benchmark project; cases.json says which defect each one has
// (an ambiguity, a contradiction, a missing acceptance criterion) or that it is clean. Each PRD gets one
// independent critic session (prompts/critic.md, rendered as src/pool.ts renders it, the real lean worker
// setup) in a fresh checkout of the textstat project, not told which kind it is. A good critic FAILs every
// defective PRD with a finding about its defect, and PASSes the clean one.
//
// Nothing touches GitHub: `gh` is bench/eval-gh.mjs (a local fake board, no tokens), the project is a local
// git repo in the temp dir.
//
//   node bench/critic-eval.mjs       (spends real usage: one critic session per PRD)
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS, workerArgs } from '../src/config.ts';
import { auditVerdict } from '../src/pool.ts';
import { render } from '../src/state.ts';
import { useFakeGh } from './eval-gh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [critic-eval] ${m}`);
const WORKERS = 3;

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const repo = 'eval/hx-critic-eval'; // a name for the prompt only: the fake gh answers for any repo
const work = path.join(os.tmpdir(), 'hxce', stamp);
const cases = JSON.parse(readFileSync(path.join(here, 'critic-eval', 'cases.json'), 'utf8'));
const config = { ...DEFAULTS, repo, defaultBranch: 'main', worktreeRoot: work };

// 1. the board (one PRD issue per case) and the project the PRDs talk about
const names = Object.keys(cases);
const issues = names.map((name, k) => ({ number: k + 1, name, title: cases[name].title, state: 'OPEN', labels: [config.labels.prd],
  body: readFileSync(path.join(here, 'critic-eval', `${name}.md`), 'utf8'), comments: [] }));
useFakeGh(path.join(work, 'fake-gh'), issues);
const project = path.join(work, 'project');
mkdirSync(project, { recursive: true });
cpSync(path.join(here, 'template'), project, { recursive: true });
cpSync(path.join(here, 'reference'), project, { recursive: true });
sh('git', ['init', '-q', '-b', 'main'], { cwd: project });
sh('git', ['add', '-A'], { cwd: project });
sh('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-q', '-m', 'textstat'], { cwd: project });
log(`fake board with ${issues.length} PRDs, project in ${project}`);

// 2. one independent critic per PRD, in a random order, a few at a time
const template = readFileSync(path.join(here, '..', 'prompts', 'critic.md'), 'utf8');
const cont = readFileSync(path.join(here, '..', 'prompts', 'continue.md'), 'utf8');
const logDir = path.join(here, 'results', 'critic-eval-logs');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });
const order = [...issues].sort(() => Math.random() - 0.5);

async function critic(it) {
  const dir = path.join(work, `c${it.number}`);
  sh('git', ['clone', '-q', project, dir]);
  const promise = `CRITIC ${it.number} DONE`;
  const vars = { REPO: repo, BASE: 'main', TITLE: it.title, PRD: it.number, ISSUE: it.number, ROUND: 1, ROUNDS: config.gauntletRounds,
    SUBJECT: `gauntlet round 1 of PRD #${it.number}`, PROMISE: promise };
  const t0 = Date.now();
  let tokens = 0;
  const r = await runGoal({
    bin: config.claudeBin, cwd: dir, model: config.model, effort: config.effort, extraArgs: workerArgs(config),
    timeoutMs: config.turnTimeoutMinutes * 60_000, prompt: render(template, vars), continuePrompt: render(cont, vars),
    promise, maxIterations: 3,
    onEvent: (ev) => appendFileSync(path.join(logDir, `${it.name}.jsonl`), JSON.stringify(ev) + '\n'),
    onTurn: (_n, _s, t) => { tokens += t.usage.input + t.usage.cacheWrite + t.usage.cacheRead + t.usage.output; },
  });
  rmSync(dir, { recursive: true, force: true });
  const c = cases[it.name];
  const v = auditVerdict(r.done ? r.last?.text ?? '' : '');
  const expected = c.defect ? 'FAIL' : 'PASS';
  const got = v ? (v.pass ? 'PASS' : 'FAIL') : 'NONE';
  // a FAIL counts as catching the defect only if a finding is about it (a loose keyword match; read the findings)
  const caught = c.defect ? got === 'FAIL' && new RegExp(c.match, 'i').test(v.findings) : null;
  const correct = c.defect ? caught : got === 'PASS';
  log(`${it.name.padEnd(17)} → ${got.padEnd(4)} ${correct ? '✓' : '✗ expected ' + expected + (got === 'FAIL' && c.defect ? ' with a finding about the defect' : '')} · ${Math.round((Date.now() - t0) / 1000)}s · ${(tokens / 1000).toFixed(0)}K tokens`);
  return { case: it.name, expected, got, caught, correct, defect: c.defect, findings: v?.findings ?? r.last?.error ?? '', ms: Date.now() - t0, tokens };
}

const results = [];
const queue = [...order];
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (queue.length) results.push(await critic(queue.shift()));
}));
results.sort((a, b) => names.indexOf(a.case) - names.indexOf(b.case));

// 3. score
const bad = results.filter((r) => r.defect), clean = results.filter((r) => !r.defect);
const summary = {
  model: config.model, effort: config.effort, at: new Date().toISOString(),
  defectsCaught: bad.filter((r) => r.caught).length, defects: bad.length,
  failedOnOtherGrounds: bad.filter((r) => r.got === 'FAIL' && !r.caught).length,
  falseAlarms: clean.filter((r) => r.got === 'FAIL').length, cleanPrds: clean.length,
  noVerdict: results.filter((r) => r.got === 'NONE').length,
  tokensPerCritic: Math.round(results.reduce((a, r) => a + r.tokens, 0) / results.length),
  secondsPerCritic: Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length / 1000),
  results,
};
writeFileSync(path.join(here, 'results', 'critic-eval.json'), JSON.stringify(summary, null, 2) + '\n');
log(`defects caught ${summary.defectsCaught}/${summary.defects} (${summary.failedOnOtherGrounds} more FAILed on other grounds) · false alarms ${summary.falseAlarms}/${summary.cleanPrds} · no verdict ${summary.noVerdict} · ~${(summary.tokensPerCritic / 1000).toFixed(0)}K tokens and ${summary.secondsPerCritic}s per critic`);
