// End to end: real git (a local bare repo as origin), fake gh and fake claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');
const { runGoal } = await import('../src/agent.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const L = DEFAULTS.labels;
const fakeClaude = path.join(here, 'fakes', 'claude.mjs');

// one git repo (with a local bare origin) shared by the tests, which run in order
let project: { root: string; stateDir: string } | undefined;
function setupProject() {
  if (project) return project;
  const origin = path.join(tmp, 'origin.git');
  const root = path.join(tmp, 'app');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  return project = { root, stateDir: path.join(root, '.hx') };
}

const baseConfig = () => ({ ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: fakeClaude, maxIterations: 3, pollSeconds: 1, audit: false });

function setup() {
  const issue = (number: number, labels: string[], body = '') => ({ number, title: `task ${number}`, body, state: 'OPEN', labels });
  writeFileSync(stateFile, JSON.stringify({ comments: [], issues: [
    issue(1, [L.ready]),
    issue(2, [L.ready], '## Blocked by\n#1'),
    issue(3, [L.ready], 'this one will FAIL'),
    issue(4, []),
  ] }));
  return { ...setupProject(), config: baseConfig() };
}

test('pool drives the board to completion, respecting Blocked by', E2E, async () => {
  const p = setup();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const rc = await pooled((signal) => runPool(p, { workers: 2, watch: false, dryRun: false, signal }))
    .finally(() => { console.log = orig; });
  assert.deepEqual(lines.filter((l) => /crashed/.test(l)), [], 'no worker crashed');
  assert.equal(lines.filter((l) => /\] impl: /.test(l)).length, 3, 'each ready issue claimed exactly once');
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const by = (n: number) => s.issues.find((i: any) => i.number === n);

  assert.equal(rc, 1, 'one issue failed');
  assert.equal(by(1).state, 'CLOSED');
  assert.equal(by(2).state, 'CLOSED');
  assert.deepEqual(by(1).labels, [L.ready]);
  assert.equal(by(3).state, 'OPEN');
  assert.deepEqual(by(3).labels.sort(), [L.blocked, L.ready].sort());
  assert.deepEqual(by(4).labels, [], 'unlabelled issue untouched');
  assert.equal(s.comments.length, 1);
  assert.match(s.comments[0].body, /no completion after 3 turns/);

  assert.ok(!existsSync(path.join(p.config.worktreeRoot, 'i1')), 'finished worktree removed');
  assert.ok(existsSync(path.join(p.config.worktreeRoot, 'i3')), 'failed worktree kept');

  const u = readUsage(p.stateDir);
  assert.equal(u.filter((r) => r.issue === 1).length, 2);
  assert.equal(u.filter((r) => r.issue === 3).length, 3);
  assert.equal(new Set(u.filter((r) => r.issue === 1).map((r) => r.sessionId)).size, 1, 'one session per issue, resumed');
  assert.equal(u[0].usage.cacheRead, 5000);
  // #2 only ran after #1 closed
  const first2 = u.findIndex((r) => r.issue === 2);
  const last1 = u.map((r) => r.issue).lastIndexOf(1);
  assert.ok(first2 > last1);
});

test('PRD flow: decompose → build → review (gap, then sign-off) → close, PRDs sequenced', E2E, async () => {
  const b = JSON.parse(readFileSync(stateFile, 'utf8'));
  const prd = (number: number, title: string, body = '') => ({ number, title, body, state: 'OPEN', labels: ['prd'] });
  b.issues.push(prd(20, 'Auth'), prd(21, 'Billing', '## Blocked by\n#20\n'));
  b.comments = [];
  writeFileSync(stateFile, JSON.stringify(b));
  const p = { ...setupProject(), config: { ...baseConfig(), reviewRounds: 3, security: false } }; // the security pass: test/security.test.ts

  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const rc = await pooled((signal) => runPool(p, { workers: 2, watch: false, dryRun: false, signal, only: undefined }))
    .finally(() => { console.log = orig; });

  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const kids = (n: number) => s.issues.filter((i: any) => new RegExp(`## Parent\\n#${n}\\b`).test(i.body));
  assert.deepEqual(lines.filter((l) => /crashed|FAILED/.test(l)), []);
  assert.equal(rc, 0);
  for (const n of [20, 21]) {
    const prdIssue = s.issues.find((i: any) => i.number === n);
    assert.equal(prdIssue.state, 'CLOSED', `PRD #${n} closed`);
    assert.ok(prdIssue.labels.includes('prd-reviewed'));
    assert.deepEqual(kids(n).map((k: any) => k.state), ['CLOSED', 'CLOSED', 'CLOSED'], `PRD #${n}: A, B and the gap issue all done`);
    assert.equal(s.comments.filter((c: any) => c.issue === n && c.body.startsWith('<!-- hx-review -->')).length, 2, 'two review rounds');
  }
  // sequencing: nothing of Billing (#21) started before Auth (#20) was closed
  const closed20 = lines.findIndex((l) => /\[#20\] PRD closed/.test(l));
  const first21 = lines.findIndex((l) => /\[#21\]/.test(l));
  assert.ok(closed20 > 0 && first21 > closed20, 'PRD #21 waits for PRD #20');
  const roles = new Set(readUsage(p.stateDir).map((r) => r.role));
  assert.deepEqual([...roles].sort(), ['critic', 'decompose', 'impl', 'review', 'revise']);
  // the gauntlet hardened each PRD before it was decomposed
  for (const n of [20, 21]) {
    assert.ok(s.issues.find((i: any) => i.number === n).labels.includes(L.hardened));
    assert.equal(s.comments.filter((c: any) => c.issue === n && c.body.startsWith('<!-- hx-gauntlet -->')).length, 2);
  }
});

test('a setup error (API 400) stops the pool and leaves the issues untouched', E2E, async () => {
  const b = JSON.parse(readFileSync(stateFile, 'utf8'));
  b.issues.push({ number: 90, title: 'x', body: '', state: 'OPEN', labels: [L.ready] },
    { number: 91, title: 'y', body: '', state: 'OPEN', labels: [L.ready] });
  b.comments = [];
  writeFileSync(stateFile, JSON.stringify(b));
  process.env.FAKE_CLAUDE_MODE = 'fatal';
  try {
    const p = { ...setupProject(), config: baseConfig() };
    const rc = await pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal, only: [90, 91] }));
    assert.equal(rc, 2);
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const n of [90, 91]) assert.deepEqual(s.issues.find((i: any) => i.number === n).labels, [L.ready], `#${n} not labelled`);
  assert.equal(s.comments.length, 0);
  assert.equal(readUsage(setupProject().stateDir).filter((r) => r.issue === 91).length, 0, 'no second issue attempted');
});

test('runGoal: usage limit and crash stop the loop with the right reason', E2E, async () => {
  const base = { bin: fakeClaude, cwd: tmp, model: 'x', extraArgs: [], timeoutMs: 30_000, prompt: 'Issue: #1',
    continuePrompt: 'c #1', promise: 'ISSUE 1 DONE', maxIterations: 5 };
  process.env.FAKE_CLAUDE_MODE = 'limit';
  const lim = await runGoal(base);
  assert.equal(lim.stopReason, 'limited');
  assert.equal(lim.last?.limited?.resetsAt, 4102444800);
  process.env.FAKE_CLAUDE_MODE = 'crash';
  const crash = await runGoal(base);
  assert.equal(crash.stopReason, 'error');
  assert.equal(crash.iterations, 1);
  assert.match(crash.last?.error ?? '', /exited 3/);
  delete process.env.FAKE_CLAUDE_MODE;
});
