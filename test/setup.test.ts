// The worktree setup step (src/setup.ts): worktreeCopy copies untracked local files into a new worktree and keeps
// them out of git, worktreeSetup runs a command there; worktreeCopyError; addWorktree's `created`. Real git (a local
// bare origin), fake gh; no package manager.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-setup-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { DEFAULTS, worktreeCopyError } = await import('../src/config.ts');
const { addWorktree, removeWorktree, implWorktree } = await import('../src/worktree.ts');
const { setupWorktree, setupLine, setupNote, readSetupRecord, writeSetupRecord } = await import('../src/setup.ts');
const { runPool } = await import('../src/pool.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
const wtRoot = path.join(tmp, 'wt');
const stateDir = path.join(root, '.hx');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
writeFileSync(path.join(root, 'tracked.txt'), 'from git\n');
git(root, 'add', 'tracked.txt');
git(root, 'commit', '-q', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
mkdirSync(stateDir);
// the checkout's own untracked local files, and .hx/ kept out of git as hx init does
writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
mkdirSync(path.join(root, 'config', 'local', 'nested'), { recursive: true });
writeFileSync(path.join(root, 'config', 'local', 'nested', 'db.json'), '{"db":"x"}\n');
writeFileSync(path.join(root, 'tracked.txt'), 'local edit\n'); // tracked: must never be copied over the worktree's
const exclude = path.join(root, '.git', 'info', 'exclude');
writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');

const cfg = (extra = {}) => ({ worktreeSetup: '', worktreeSetupMinutes: 10, worktreeCopy: [] as string[], ...extra });
let seq = 0;
/** A fresh worktree, then setupWorktree on it; returns what it logged. */
async function setup(config: ReturnType<typeof cfg>, signal?: AbortSignal) {
  const name = `s${++seq}`;
  const { dir } = await addWorktree(root, wtRoot, { name, branch: `hx/s-${seq}`, base: 'main', fresh: true });
  const logs: string[] = [];
  const res = await setupWorktree({ checkout: root, dir, name, stateDir, config, signal, log: (m) => logs.push(m) });
  return { res, dir, name, logs };
}
const setupFiles = () => existsSync(path.join(stateDir, 'logs')) ? readdirSync(path.join(stateDir, 'logs')).filter((f) => f.startsWith('setup-')) : [];
const script = (name: string, body: string) => { const f = path.join(tmp, name); writeFileSync(f, body); return `node "${f}"`; };

test('worktreeCopyError: relative paths inside the repo only, the message names the entry', E2E, () => {
  assert.equal(worktreeCopyError(['.env', 'config/local']), null);
  assert.equal(worktreeCopyError([]), null);
  assert.equal(worktreeCopyError(undefined), null);
  assert.deepEqual(DEFAULTS.worktreeCopy, []);
  assert.equal(DEFAULTS.worktreeSetup, '');
  assert.equal(DEFAULTS.worktreeSetupMinutes, 10);
  assert.equal(worktreeCopyError(['../x']), 'worktreeCopy: "../x" must be a path inside the repo (no "..")');
  for (const bad of ['../x', 'a/../../x', 'a\\..\\x', '/etc/x', 'C:\\x', 'C:/x', '\\server\\x', '\\\\server\\share\\x', '*.env', 'a?', 'x[1]', '{a,b}', ''])
    assert.ok((worktreeCopyError(['.env', bad]) ?? '').startsWith(`worktreeCopy: ${JSON.stringify(bad)} must be `), bad);
  assert.match(worktreeCopyError('.env')!, /^worktreeCopy: must be an array/);
  assert.match(worktreeCopyError(['.env', 3])!, /^worktreeCopy: must be an array/);
});

test('addWorktree: created for a new worktree and one re-created from origin/issue/N, not for a reused one', E2E, async () => {
  const spec = implWorktree(901, 'main');
  const a = await addWorktree(root, wtRoot, spec);
  assert.deepEqual([a.created, a.resumed], [true, false]);
  const b = await addWorktree(root, wtRoot, spec);
  assert.deepEqual([b.created, b.resumed], [false, true], 'reused');
  git(a.dir, 'push', '-q', 'origin', 'HEAD:issue/901');
  await removeWorktree(root, a.dir);
  const c = await addWorktree(root, wtRoot, spec);
  assert.deepEqual([c.created, c.resumed], [true, true], 're-created from origin/issue/901');
  await removeWorktree(root, c.dir);
});

test('worktreeCopy: files and folders copied, kept out of git status, each excluded once across two worktrees', E2E, async () => {
  const config = cfg({ worktreeCopy: ['.env', 'config/local'] });
  const one = await setup(config);
  const two = await setup(config);
  for (const s of [one, two]) {
    assert.equal(readFileSync(path.join(s.dir, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(readFileSync(path.join(s.dir, 'config', 'local', 'nested', 'db.json'), 'utf8'), '{"db":"x"}\n');
    assert.equal(git(s.dir, 'status', '--porcelain'), '');
    assert.deepEqual(s.res, { ...s.res, ok: true, exit: 0, timedOut: false, aborted: false, tail: '', command: '' }, 'copy only: ok, empty tail');
    assert.deepEqual(s.logs, []);
  }
  const lines = readFileSync(exclude, 'utf8').split(/\r?\n/);
  assert.equal(lines.filter((l) => l === '/.env').length, 1);
  assert.equal(lines.filter((l) => l === '/config/local').length, 1);
  assert.deepEqual(setupFiles(), [], 'no command: no log written');
});

test('worktreeCopy: a missing entry is skipped silently, a tracked one is not copied and is logged', E2E, async () => {
  const s = await setup(cfg({ worktreeCopy: ['nope.txt', 'tracked.txt'] }));
  assert.equal(readFileSync(path.join(s.dir, 'tracked.txt'), 'utf8'), 'from git\n', "the worktree's tracked version is unchanged");
  assert.deepEqual(s.logs, ['setup: skipped tracked.txt (tracked by git)']);
  assert.equal(git(s.dir, 'status', '--porcelain'), '');
  assert.equal(s.res, undefined, 'nothing copied and no command: nothing to report');
  assert.ok(!readFileSync(exclude, 'utf8').split(/\r?\n/).includes('/tracked.txt'));
});

test('nothing configured: undefined, nothing runs, no setup-* file', E2E, async () => {
  const s = await setup(cfg());
  assert.equal(s.res, undefined);
  assert.deepEqual(setupFiles(), []);
});

test('worktreeSetup: runs in the worktree, its output goes to logs/setup-<name>.log', E2E, async () => {
  const cmd = script('ok.js', `require('fs').writeFileSync('marker.txt', 'made'); console.log('installed 3 packages');`);
  const s = await setup(cfg({ worktreeSetup: cmd }));
  assert.equal(s.res?.ok, true);
  assert.equal(s.res?.exit, 0);
  assert.equal(s.res?.command, cmd);
  assert.equal(readFileSync(path.join(s.dir, 'marker.txt'), 'utf8'), 'made');
  assert.match(readFileSync(path.join(stateDir, 'logs', `setup-${s.name}.log`), 'utf8'), /installed 3 packages/);
  assert.ok(!existsSync(path.join(stateDir, 'logs', `setup-${s.name}.json`)), 'setupWorktree never writes a record');
  assert.equal(setupNote(cmd, s.res), '');
  assert.match(setupLine(s.res!, 'npm ci'), /^setup: npm ci \(\d+s\)$/);
});

test('a failing command: ok false, exit 1, the last 20 lines; setupNote and setupLine carry them', E2E, async () => {
  const cmd = script('fail.js', `for (let i = 1; i <= 30; i++) console.log('line ' + i); process.exit(1);`);
  const s = await setup(cfg({ worktreeSetup: cmd }));
  assert.equal(s.res?.ok, false);
  assert.equal(s.res?.exit, 1);
  assert.equal(s.res?.timedOut, false);
  const tail = s.res!.tail.split(/\r?\n/);
  assert.equal(tail.length, 20);
  assert.equal(tail[0], 'line 11');
  assert.equal(tail[19], 'line 30');
  const note = setupNote(cmd, s.res);
  assert.ok(note.startsWith(`The worktree setup command \`${cmd}\` failed; its output is below. Fix the environment first if the failure blocks you, and say so in your handoff.`));
  assert.ok(note.includes('```\n' + s.res!.tail + '\n```'), note);
  assert.match(setupLine(s.res!, 'npm ci'), /^setup FAILED \(exit 1\): line 11 \| .* \| line 30$/);
  assert.match(setupLine(s.res!, 'npm ci', { suffix: 'try 2 of 3' }), /^setup FAILED \(exit 1, try 2 of 3\): line 11/);
  assert.match(readFileSync(path.join(stateDir, 'logs', `setup-${s.name}.log`), 'utf8'), /line 1\b[\s\S]*line 30/, 'the full output');
  // records: written and read back by the wiring
  writeSetupRecord(stateDir, s.name, s.res!);
  const rec = readSetupRecord(stateDir, s.name);
  assert.deepEqual({ ...rec, at: undefined }, { command: cmd, ok: false, exit: 1, timedOut: false, tail: s.res!.tail, at: undefined });
  assert.ok(!Number.isNaN(Date.parse(rec!.at)));
  assert.equal(readSetupRecord(stateDir, 'none'), undefined);
});

test('a command that hangs is killed with its tree after worktreeSetupMinutes: timedOut, not ok', E2E, async () => {
  const cmd = script('hang.js', `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120e3)'], { stdio: 'inherit' });
console.log('waiting'); setTimeout(() => {}, 120e3);`);
  const t0 = Date.now();
  const s = await setup(cfg({ worktreeSetup: cmd, worktreeSetupMinutes: 0.03 }));
  assert.ok(Date.now() - t0 < 60_000, 'returned well before the child would exit');
  assert.equal(s.res?.timedOut, true);
  assert.equal(s.res?.ok, false);
  assert.match(setupLine(s.res!, 'npm ci', { minutes: 10 }), /^setup FAILED \(timed out after 10 min\): /);
});

test('a fired signal: aborted, no output log and no record', E2E, async () => {
  const cmd = script('slow.js', `setTimeout(() => {}, 120e3);`);
  const before = setupFiles();
  const s = await setup(cfg({ worktreeSetup: cmd }), AbortSignal.abort());
  assert.equal(s.res?.aborted, true);
  assert.equal(s.res?.ok, false);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t = await setup(cfg({ worktreeSetup: cmd }), ac.signal);
  assert.equal(t.res?.aborted, true);
  assert.deepEqual(setupFiles(), before, 'nothing written');
});

test('hx run with a bad worktreeCopy logs STOPPED and exits 2 before reading the board', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [{ number: 1, title: 't', body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] }] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };
  let rc: number;
  try {
    rc = await pooled((signal) => runPool({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wtRoot,
      claudeBin: path.join(here, 'fakes', 'claude.mjs'), roleSkills: {}, worktreeCopy: ['../secrets'] } }, { workers: 1, watch: false, dryRun: false, signal }));
  } finally { console.log = orig; }
  assert.equal(rc, 2);
  assert.ok(lines.some((l) => l.includes('STOPPED: worktreeCopy: "../secrets" must be a path inside the repo (no "..")')), lines.join('\n'));
  assert.ok(!lines.some((l) => /gh login/.test(l)), 'stopped before anything asked gh');
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).issues[0].labels, [DEFAULTS.labels.ready], 'not claimed');
});

test.after(() => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
