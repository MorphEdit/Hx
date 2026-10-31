// Startup repair of broken loose refs of hx branches (issue/N, hx/prd-N, hx/audit-N).
// Real git (a local bare origin), fake gh and fake claude, like robust.test.ts.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-br-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);
writeFileSync(stateFile, JSON.stringify({ comments: [], issues: [] }));

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { hxBranch, repairBrokenRefs } = await import('../src/worktree.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
let n = 0;

/** A fresh clone of a fresh bare origin, with one commit on main. */
function repo() {
  const dir = path.join(tmp, `r${++n}`);
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'app');
  const wt = path.join(dir, 'wt');
  mkdirSync(dir);
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, root);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  return { root, wt };
}

/** A worktree `name` on a new branch `br` with a commit of its own; `push` also puts it on origin. */
function branch(root: string, wt: string, name: string, br: string, push: boolean) {
  const dir = path.join(wt, name);
  git(root, 'worktree', 'add', '-q', '-b', br, dir, 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', `work on ${br}`);
  if (push) { git(dir, 'push', '-q', 'origin', `${br}:${br}`); git(root, 'fetch', '-q', 'origin'); }
  return dir;
}

const refFile = (root: string, br: string) => path.join(root, '.git', 'refs', 'heads', ...br.split('/'));
const breakRef = (root: string, br: string) => writeFileSync(refFile(root, br), Buffer.alloc(41));
const worktrees = (root: string) => git(root, 'worktree', 'list', '--porcelain');

async function repair(root: string, wt: string) {
  const lines: string[] = [];
  const out = await repairBrokenRefs(root, wt, (m) => lines.push(m));
  return { out, lines };
}

async function runOnce(root: string, wt: string) {
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir, { recursive: true });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };
  try {
    const rc = await pooled((signal) => runPool({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wt,
      claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false } } as any,
    { workers: 1, watch: false, dryRun: false, signal }));
    return { rc, lines };
  } finally { console.log = orig; }
}

test('hx run: a NUL-filled issue/7 with origin/issue/7 is recreated there and its worktree kept', E2E, async () => {
  const { root, wt } = repo();
  const dir = branch(root, wt, 'i7', 'issue/7', true);
  breakRef(root, 'issue/7');
  const { rc, lines } = await runOnce(root, wt);
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => l.includes('repaired broken ref issue/7 from origin/issue/7')), lines.join('\n'));
  assert.equal(git(root, 'rev-parse', 'issue/7'), git(root, 'rev-parse', 'origin/issue/7'));
  assert.ok(existsSync(dir));
  assert.ok(worktrees(root).includes('branch refs/heads/issue/7'));
});

test('hx run: a NUL-filled issue/7 without a remote branch is removed with a warning, its worktree too, and the run goes on', E2E, async () => {
  const { root, wt } = repo();
  const dir = branch(root, wt, 'i7', 'issue/7', false);
  // a worktree whose directory is already gone: only `git worktree prune` clears it
  const gone = branch(root, wt, 'x1', 'other', false);
  rmSync(gone, { recursive: true, force: true });
  breakRef(root, 'issue/7');
  const { rc, lines } = await runOnce(root, wt);
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => l.includes('removed broken ref issue/7 — its unpushed work may be lost (see git fsck --lost-found)')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('nothing left to do')), 'runPool continued');
  assert.ok(!existsSync(refFile(root, 'issue/7')));
  assert.ok(!existsSync(dir));
  const list = worktrees(root);
  assert.ok(!list.includes('issue/7'));
  assert.ok(!list.includes('refs/heads/other'), 'pruned');
});

test('repairBrokenRefs: valid refs, hx/gate and other branches are untouched', E2E, async () => {
  const { root, wt } = repo();
  branch(root, wt, 'i3', 'issue/3', false);
  const before = readFileSync(refFile(root, 'issue/3'), 'utf8');
  git(root, 'branch', 'hx/gate', 'main');
  git(root, 'branch', 'feature/x', 'main');
  breakRef(root, 'hx/gate');
  breakRef(root, 'feature/x');
  const { out, lines } = await repair(root, wt);
  assert.deepEqual(out, []);
  assert.deepEqual(lines, []);
  assert.equal(readFileSync(refFile(root, 'issue/3'), 'utf8'), before);
  assert.deepEqual(readFileSync(refFile(root, 'hx/gate')), Buffer.alloc(41));
  assert.deepEqual(readFileSync(refFile(root, 'feature/x')), Buffer.alloc(41));
});

test('repairBrokenRefs: a broken hx/prd-N is repaired from origin, or removed with its worktree', E2E, async () => {
  const { root, wt } = repo();
  const p4 = branch(root, wt, 'p4', 'hx/prd-4', true);
  const p5 = branch(root, wt, 'p5', 'hx/prd-5', false);
  breakRef(root, 'hx/prd-4');
  writeFileSync(refFile(root, 'hx/prd-5'), 'garbage\n');
  const { out, lines } = await repair(root, wt);
  assert.deepEqual(out.sort((a, b) => a.branch.localeCompare(b.branch)), [{ branch: 'hx/prd-4', repaired: true }, { branch: 'hx/prd-5', repaired: false }]);
  assert.ok(lines.includes('repaired broken ref hx/prd-4 from origin/hx/prd-4'), lines.join('\n'));
  assert.ok(lines.includes('removed broken ref hx/prd-5 — its unpushed work may be lost (see git fsck --lost-found)'), lines.join('\n'));
  assert.equal(git(root, 'rev-parse', 'hx/prd-4'), git(root, 'rev-parse', 'origin/hx/prd-4'));
  assert.ok(existsSync(p4));
  assert.ok(!existsSync(p5));
  assert.ok(!existsSync(refFile(root, 'hx/prd-5')));
});

test('repairBrokenRefs: a broken hx/audit-N without a remote is removed with its a<N> worktree', E2E, async () => {
  const { root, wt } = repo();
  const a9 = branch(root, wt, 'a9', 'hx/audit-9', false);
  breakRef(root, 'hx/audit-9');
  const { out } = await repair(root, wt);
  assert.deepEqual(out, [{ branch: 'hx/audit-9', repaired: false }]);
  assert.ok(!existsSync(a9));
});

test('repairBrokenRefs: no checkout logs one line and returns nothing', E2E, async () => {
  const lines: string[] = [];
  const out = await repairBrokenRefs(path.join(tmp, 'nope'), path.join(tmp, 'nope-wt'), (m) => lines.push(m));
  assert.deepEqual(out, []);
  assert.equal(lines.length, 1);
});

test('hxBranch: the worktree name of each hx branch, null for any other branch', E2E, () => {
  assert.equal(hxBranch('issue/7'), 'i7');
  assert.equal(hxBranch('hx/prd-12'), 'p12');
  assert.equal(hxBranch('hx/audit-3'), 'a3');
  for (const b of ['hx/gate', 'issue/x', 'issue/7/sub', 'hx/prd-', 'feature/x', 'main']) assert.equal(hxBranch(b), null, b);
});
