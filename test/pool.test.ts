// End to end: real git (a local bare repo as origin), fake gh and fake claude.
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

function setup() {
  const origin = path.join(tmp, 'origin.git');
  const root = path.join(tmp, 'app');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const issue = (number: number, labels: string[], body = '') => ({ number, title: `task ${number}`, body, state: 'OPEN', labels });
  writeFileSync(stateFile, JSON.stringify({ comments: [], issues: [
    issue(1, [L.ready]),
    issue(2, [L.ready], '## Blocked by\n#1'),
    issue(3, [L.ready], 'this one will FAIL'),
    issue(4, []),
  ] }));
  const stateDir = path.join(root, '.hx');
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
    claudeBin: fakeClaude, maxIterations: 3, pollSeconds: 1 };
  return { root, stateDir, config };
}

test('pool drives the board to completion, respecting Blocked by', async () => {
  const p = setup();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const rc = await runPool(p, { workers: 2, watch: false, dryRun: false, signal: new AbortController().signal })
    .finally(() => { console.log = orig; });
  assert.deepEqual(lines.filter((l) => /crashed/.test(l)), [], 'no worker crashed');
  assert.equal(lines.filter((l) => /claimed/.test(l)).length, 3, 'each ready issue claimed exactly once');
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

test('runGoal: usage limit and crash stop the loop with the right reason', async () => {
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
