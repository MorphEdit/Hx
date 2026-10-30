#!/usr/bin/env node
// Security eval: does the security pass find a planted vulnerability in a PRD's merged work, and sign off a
// clean one?
//
// security-eval/base/ is a tiny project; per case in security-eval/cases.json a PRD (#1) has one closed child
// (#2) whose merged commit (`closes #2`) adds the files in security-eval/<case>/: a command injection from an
// issue title, an rmSync on a path built from an issue title, a token written to a log — or, for `clean`, the
// same feature as `shell` done safely. Each case gets one security session (prompts/security.md, rendered as
// src/pool.ts renders it, the real lean worker setup), not told which kind it is. A good pass files an issue
// about each planted vulnerability, and files nothing and signs off the clean case.
//
// Nothing touches GitHub: `gh` is bench/eval-gh.mjs (a local fake board, no tokens) — the issues the session
// files, its labels and its comment land there and are read back; origin is a local bare repo.
//
//   node bench/security-eval.mjs     (spends real usage: one security session per case, one at a time)
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS, workerArgs } from '../src/config.ts';
import { SECURITY_MARKER } from '../src/pool.ts';
import { render } from '../src/state.ts';
import { board, useFakeGh } from './eval-gh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [security-eval] ${m}`);

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const repo = 'eval/hx-security-eval'; // a name for the prompt only: the fake gh answers for any repo
const work = path.join(os.tmpdir(), 'hxse', stamp);
const cases = JSON.parse(readFileSync(path.join(here, 'security-eval', 'cases.json'), 'utf8'));
const config = { ...DEFAULTS, repo, defaultBranch: 'main', worktreeRoot: work };
const L = config.labels;
const template = readFileSync(path.join(here, '..', 'prompts', 'security.md'), 'utf8');
const cont = readFileSync(path.join(here, '..', 'prompts', 'continue.md'), 'utf8');
const logDir = path.join(here, 'results', 'security-eval-logs');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });
const ident = ['-c', 'user.name=eval', '-c', 'user.email=eval@localhost'];

/** origin (bare) with main = base project + the child's merged commit; returns a fresh clone to check in. */
function setup(name, c, dir) {
  const origin = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed'), checkout = path.join(dir, 'checkout');
  sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(seed, { recursive: true });
  cpSync(path.join(here, 'security-eval', 'base'), seed, { recursive: true });
  const git = (...a) => sh('git', [...ident, ...a], { cwd: seed });
  git('init', '-q', '-b', 'main');
  git('add', '-A'); git('commit', '-q', '-m', 'issuebot: github helpers');
  cpSync(path.join(here, 'security-eval', name), seed, { recursive: true });
  git('add', '-A'); git('commit', '-q', '-m', `${c.child} (closes #2)`);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  sh('git', ['clone', '-q', origin, checkout]);
  return checkout;
}

// one case at a time: each has its own fake board, and the fake gh is chosen through this process's env
const results = [];
for (const name of Object.keys(cases).sort(() => Math.random() - 0.5)) {
  const c = cases[name];
  const dir = path.join(work, name);
  const checkout = setup(name, c, dir);
  const ghDir = path.join(dir, 'fake-gh');
  useFakeGh(ghDir, [
    { number: 1, title: c.prd.title, body: c.prd.body, state: 'OPEN', labels: [L.prd, L.reviewed], comments: [] },
    { number: 2, title: c.child, body: `Implements part of #1.\n\n## Parent\n#1\n`, state: 'CLOSED', labels: [L.ready], comments: [] },
  ]);
  const promise = 'SECURITY 1 DONE';
  const vars = { REPO: repo, BASE: 'main', TITLE: c.prd.title, PRD: 1, ISSUE: 1, ROUND: 1, ROUNDS: config.securityRounds,
    CHILDREN: `- #2 [closed] ${c.child}`, LABEL_READY: L.ready, LABEL_REVIEWED: L.reviewed, LABEL_SECURED: L.secured, LABEL_SECURITY: L.security,
    SUBJECT: 'security pass 1 of PRD #1', PROMISE: promise };
  const t0 = Date.now();
  let tokens = 0;
  const r = await runGoal({
    bin: config.claudeBin, cwd: checkout, model: config.model, effort: config.effort, extraArgs: workerArgs(config),
    timeoutMs: config.turnTimeoutMinutes * 60_000, prompt: render(template, vars), continuePrompt: render(cont, vars),
    promise, maxIterations: 3,
    onEvent: (ev) => appendFileSync(path.join(logDir, `${name}.jsonl`), JSON.stringify(ev) + '\n'),
    onTurn: (_n, _s, t) => { tokens += t.usage.input + t.usage.cacheWrite + t.usage.cacheRead + t.usage.output; },
  });
  const b = board.load(ghDir);
  const prd = b.issues.find((i) => i.number === 1);
  const filed = b.issues.filter((i) => i.filed).map((i) => ({ title: i.title, labels: i.labels, body: i.body }));
  const signedOff = prd.labels.includes(L.secured);
  const commented = prd.comments.some((x) => x.trimStart().startsWith(SECURITY_MARKER));
  // found: a filed issue is about the planted vulnerability (a loose keyword match; read the bodies)
  const found = c.vuln ? filed.some((i) => new RegExp(c.match, 'i').test(`${i.title}\n${i.body}`)) : null;
  const correct = c.vuln ? found : filed.length === 0 && signedOff;
  const got = filed.length ? `filed ${filed.length}` : signedOff ? 'signed off' : 'nothing';
  log(`${name.padEnd(7)} → ${got.padEnd(10)} ${correct ? '✓' : '✗ expected ' + (c.vuln ? 'an issue about: ' + c.vuln : 'no issue and a sign-off')}${commented ? '' : ' · no verdict comment'} · ${Math.round((Date.now() - t0) / 1000)}s · ${(tokens / 1000).toFixed(0)}K tokens`);
  results.push({ case: name, vuln: c.vuln, done: r.done, found, signedOff, commented, correct, filed,
    ghCalls: readFileSync(path.join(ghDir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length, ms: Date.now() - t0, tokens });
}
results.sort((a, b) => a.case.localeCompare(b.case));

// score
const vulns = results.filter((r) => r.vuln), clean = results.filter((r) => !r.vuln);
const summary = {
  model: config.model, effort: config.effort, at: new Date().toISOString(),
  vulnsFound: vulns.filter((r) => r.found).length, vulns: vulns.length,
  falseAlarms: clean.filter((r) => r.filed.length).length, cleanCases: clean.length,
  noComment: results.filter((r) => !r.commented).length,
  tokensPerPass: Math.round(results.reduce((a, r) => a + r.tokens, 0) / results.length),
  secondsPerPass: Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length / 1000),
  results,
};
writeFileSync(path.join(here, 'results', 'security-eval.json'), JSON.stringify(summary, null, 2) + '\n');
log(`vulnerabilities found ${summary.vulnsFound}/${summary.vulns} · false alarms ${summary.falseAlarms}/${summary.cleanCases} · no verdict comment ${summary.noComment} · ~${(summary.tokensPerPass / 1000).toFixed(0)}K tokens and ${summary.secondsPerPass}s per pass`);
