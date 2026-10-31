// Worktree cleanup never fails finished work: real git (a local bare origin), the real ship.mjs, fake gh and claude.
// Removing a worktree directory throws (Windows: EPERM, a file still open) → the issue still ends DONE ✓,
// the gate re-runs after the merge, and the leftover directory is removed on the next start.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-c-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { worktreeFs } = await import('../src/worktree.ts');

const L = DEFAULTS.labels;
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, ...gitId, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const wtRoot = path.join(tmp, 'wt');
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wtRoot,
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 2, gate: true,
  gateCommand: 'node -e "process.exit(0)"' } });

const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));

async function run() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(), { workers: 1, watch: false, dryRun: false, signal })), lines };
  } finally { console.log = orig; }
}

test('removing the worktree throws after the merge: the issue still ends DONE ✓, rc 0, the gate re-runs', E2E, async () => {
  board([{ number: 1, title: 'task 1', body: '', state: 'OPEN', labels: [L.ready] }]);
  const real = worktreeFs.removeDir;
  const stuck: string[] = [];
  worktreeFs.removeDir = async (checkout, dir) => {
    if (/^[ia]\d+$/.test(path.basename(dir))) {
      stuck.push(dir);
      throw Object.assign(new Error(`EPERM, Permission denied: ${dir}`), { code: 'EPERM' });
    }
    return real(checkout, dir);
  };
  let res;
  try { res = await run(); } finally { worktreeFs.removeDir = real; }
  const { rc, lines } = res;
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(stuck.some((d) => path.basename(d) === 'i1'), 'the impl worktree removal was attempted and failed');
  assert.ok(!lines.some((l) => /crashed/.test(l)), lines.join('\n'));
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const done = at(/\[#1\] DONE ✓ audited and merged/);
  assert.ok(done >= 0, lines.join('\n'));
  assert.ok(lines.some((l) => /warning: could not remove .*i1 \(in use\?\) — remove it by hand or it will be cleaned up next run/.test(l)));
  // the gate ran at start and again on the merge commit
  const greens = lines.map((l, i) => (/gate green ✓/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.ok(greens.length >= 2 && greens.at(-1)! > done, 'gate re-run after the merge:\n' + lines.join('\n'));
  assert.equal(read().issues[0].state, 'CLOSED');
  assert.ok(!read().issues[0].labels.includes(L.blocked));
});

test('next start: a leftover directory git no longer lists is removed; listed worktrees stay', E2E, async () => {
  const leftover = path.join(wtRoot, 'i7');
  mkdirSync(path.join(leftover, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(leftover, 'node_modules', 'x', 'f.js'), 'x');
  const listed = path.join(wtRoot, 'i1'); // from the test above: still a registered worktree
  assert.ok(existsSync(listed));
  board([]);
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(!existsSync(leftover), 'leftover directory removed');
  assert.ok(existsSync(listed), 'a listed worktree (it may hold work) is kept');
  assert.ok(lines.some((l) => /removed leftover directory .*i7/.test(l)));
});
