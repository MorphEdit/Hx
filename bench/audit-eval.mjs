#!/usr/bin/env node
// Audit eval: can the auditor tell a correct PR from one with a planted defect?
//
// For each of the six benchmark issues there are two PRs on a fresh private repo:
//   ok  — the reference implementation + the implementer-style tests in audit-eval/visible/
//   bug — the same, but the module has one planted defect (audit-eval/defects.json) that breaks a rule
//         or an example stated in the issue, while the PR's own tests still pass
// Each PR gets one independent audit session (prompts/audit.md, the real lean worker setup), not told
// which kind it is. A good auditor FAILs all 6 defective PRs and PASSes all 6 correct ones.
//
//   node bench/audit-eval.mjs        (creates a private repo, spends real usage: ~12 audit sessions)
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoal } from '../src/agent.ts';
import { DEFAULTS, workerArgs } from '../src/config.ts';
import { auditVerdict } from '../src/pool.ts';
import { render } from '../src/state.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)} [audit-eval] ${m}`);
const MODULE = { 1: 'src/tokenize.js', 2: 'src/freq.js', 3: 'src/slugify.js', 4: 'src/reading.js', 5: 'bin/textstat.js', 6: 'src/truncate.js' };
const VISIBLE = { 1: 'tokenize', 2: 'freq', 3: 'slugify', 4: 'reading', 5: 'textstat', 6: 'truncate' };
// what each module needs on the base branch, so a PR adds exactly one issue's module
const DEPENDENTS = { 1: [2, 4, 5], 2: [5], 3: [5], 4: [5], 5: [], 6: [] };
const WORKERS = 3;

const owner = sh('gh', ['api', 'user', '-q', '.login']).trim();
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const repo = `${owner}/hx-audit-eval-${stamp}`;
const work = path.join(os.tmpdir(), 'hxae', stamp);
const wtRoot = path.join(os.tmpdir(), 'hxae-wt', stamp);
const git = (...a) => sh('git', a, { cwd: work });
const issues = JSON.parse(readFileSync(path.join(here, 'issues.json'), 'utf8'));
const defects = JSON.parse(readFileSync(path.join(here, 'audit-eval', 'defects.json'), 'utf8'));
const config = { ...DEFAULTS, repo, defaultBranch: 'main', worktreeRoot: wtRoot };

// 1. the repo: main = the empty project; per issue a base branch and the two PR branches
mkdirSync(work, { recursive: true });
cpSync(path.join(here, 'template'), work, { recursive: true });
git('init', '-q', '-b', 'main');
git('add', '-A'); git('commit', '-q', '-m', 'textstat: empty project');
sh('gh', ['repo', 'create', repo, '--private', '--source', work, '--push'], { cwd: work });
log(`created ${repo}`);
for (let i = 1; i <= 6; i++) {
  git('checkout', '-q', '-B', `base-${i}`, 'main');
  for (const [n, f] of Object.entries(MODULE)) {
    if (Number(n) === i || DEPENDENTS[i].includes(Number(n))) continue;
    mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    cpSync(path.join(here, 'reference', f), path.join(work, f));
  }
  git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', `base for issue #${i}`);
  for (const kind of ['ok', 'bug']) {
    git('checkout', '-q', '-B', `pr-${i}-${kind}`, `base-${i}`);
    mkdirSync(path.dirname(path.join(work, MODULE[i])), { recursive: true });
    cpSync(path.join(here, kind === 'ok' ? 'reference' : 'audit-eval/buggy', MODULE[i]), path.join(work, MODULE[i]));
    cpSync(path.join(here, 'audit-eval', 'visible', `${VISIBLE[i]}.test.js`), path.join(work, 'test', `${VISIBLE[i]}.test.js`));
    git('add', '-A'); git('commit', '-q', '-m', `feat: ${issues[i - 1].title} (closes #${i})`);
  }
}
git('checkout', '-q', 'main');
git('push', '-q', '--all', 'origin');
git('fetch', '-q', 'origin');
for (const it of issues) sh('gh', ['issue', 'create', '-R', repo, '--title', it.title, '--body-file', '-'], { input: it.body });
log('pushed 6 base + 12 PR branches, filed 6 issues');

// 2. one independent audit per PR, in a random order, a few at a time
const cases = [];
for (let i = 1; i <= 6; i++) for (const kind of ['ok', 'bug']) cases.push({ issue: i, kind });
cases.sort(() => Math.random() - 0.5);
const template = readFileSync(path.join(here, '..', 'prompts', 'audit.md'), 'utf8');
const logDir = path.join(here, 'results', 'audit-eval-logs');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });
mkdirSync(wtRoot, { recursive: true });

async function audit(cse) {
  const { issue: i, kind } = cse;
  const branch = `pr-${i}-${kind}`;
  const dir = path.join(wtRoot, `${i}${kind}`);
  sh('git', ['-C', work, 'worktree', 'add', '-q', '--detach', dir, `origin/${branch}`]);
  const promise = `AUDIT ${i} DONE`;
  const vars = { REPO: repo, ISSUE: i, TITLE: issues[i - 1].title, BRANCH: branch, BASE: `base-${i}`, PR: branch, ROUND: 1, ROUNDS: 1, PROMISE: promise };
  const t0 = Date.now();
  let tokens = 0;
  const r = await runGoal({
    bin: config.claudeBin, cwd: dir, model: config.model, effort: config.effort, extraArgs: workerArgs(config),
    timeoutMs: 30 * 60_000, prompt: render(template, vars), promise, maxIterations: 3,
    continuePrompt: `Continue the audit and end with the VERDICT / FINDINGS block and <promise>${promise}</promise>.`,
    onEvent: (ev) => appendFileSync(path.join(logDir, `${i}-${kind}.jsonl`), JSON.stringify(ev) + '\n'),
    onTurn: (_n, _s, t) => { tokens += t.usage.input + t.usage.cacheWrite + t.usage.cacheRead + t.usage.output; },
  });
  sh('git', ['-C', work, 'worktree', 'remove', '--force', dir]);
  const v = auditVerdict(r.done ? r.last?.text ?? '' : '');
  const expected = kind === 'ok' ? 'PASS' : 'FAIL';
  const got = v ? (v.pass ? 'PASS' : 'FAIL') : 'NONE';
  log(`#${i} ${kind.padEnd(3)} → ${got.padEnd(4)} ${got === expected ? '✓' : '✗ expected ' + expected} · ${Math.round((Date.now() - t0) / 1000)}s · ${(tokens / 1000).toFixed(0)}K tokens`);
  return { issue: i, kind, expected, got, correct: got === expected, findings: v?.findings ?? r.last?.error ?? '', defect: kind === 'bug' ? defects[i].defect : null,
    ms: Date.now() - t0, tokens };
}

const results = [];
const queue = [...cases];
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (queue.length) results.push(await audit(queue.shift()));
}));
results.sort((a, b) => a.issue - b.issue || a.kind.localeCompare(b.kind));

// 3. score
const bugs = results.filter((r) => r.kind === 'bug'), oks = results.filter((r) => r.kind === 'ok');
const summary = {
  repo, model: config.model, effort: config.effort, at: new Date().toISOString(),
  defectsCaught: bugs.filter((r) => r.got === 'FAIL').length, defects: bugs.length,
  falseAlarms: oks.filter((r) => r.got === 'FAIL').length, correctPrs: oks.length,
  noVerdict: results.filter((r) => r.got === 'NONE').length,
  tokensPerAudit: Math.round(results.reduce((a, r) => a + r.tokens, 0) / results.length),
  secondsPerAudit: Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length / 1000),
  results,
};
writeFileSync(path.join(here, 'results', 'audit-eval.json'), JSON.stringify(summary, null, 2) + '\n');
log(`defects caught ${summary.defectsCaught}/${summary.defects} · false alarms ${summary.falseAlarms}/${summary.correctPrs} · no verdict ${summary.noVerdict} · ~${(summary.tokensPerAudit / 1000).toFixed(0)}K tokens and ${summary.secondsPerAudit}s per audit`);
