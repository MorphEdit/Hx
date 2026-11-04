// A watching runner updates its own hx install when idle and restarts itself; a new runner that does not start is
// rolled back (#253). Real git: the hx install is a clone (in a temp dir) of a copy of this repo's code with a bare
// origin; a second clone pushes the new commits. Fake gh and claude. The old runner runs in-process, the new one is
// a real `node <install>/bin/hx.mjs run --watch`, stopped by .hx/pause at the end of each test.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-su-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { pidAlive, readLive, setPause, clearPause } = await import('../src/runstate.ts');
const { readSelfUpdate, isCode, newerTag, selfUpdateConfigError } = await import('../src/selfupdate.ts');
const { killTree } = await import('../src/exec.ts');
const { loadJson } = await import('./fakes/lock.mjs');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

// the hx install: a copy of this repo's code, pushed to a bare origin and cloned (as an npm link of a clone would be)
const hxOrigin = path.join(tmp, 'hx.git'), dev = path.join(tmp, 'hx-dev'), inst = path.join(tmp, 'hx');
git(tmp, 'init', '-q', '--bare', '-b', 'main', hxOrigin);
git(tmp, 'clone', '-q', hxOrigin, dev);
for (const d of ['src', 'bin', 'scripts', 'prompts', 'templates', 'package.json']) cpSync(path.join(here, '..', d), path.join(dev, d), { recursive: true });
git(dev, 'add', '-A');
git(dev, 'commit', '-q', '-m', 'hx');
git(dev, 'push', '-q', 'origin', 'HEAD:main');
git(tmp, 'clone', '-q', hxOrigin, inst);
process.env.HX_SELF_ROOT = inst;
const head = () => git(inst, 'rev-parse', 'HEAD');
/** Commit `files` (path → content, null deletes) in the dev clone and push them to the install's origin: the new sha. */
const push = (files: Record<string, string | null>, msg: string) => {
  for (const [f, body] of Object.entries(files)) {
    if (body === null) rmSync(path.join(dev, f)); else writeFileSync(path.join(dev, f), body);
  }
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', msg);
  git(dev, 'push', '-q', 'origin', 'HEAD:main');
  return git(dev, 'rev-parse', 'HEAD');
};

// the project hx works on
const origin = path.join(tmp, 'origin.git'), root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
const config = (selfUpdate: boolean) => ({ ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, selfHeal: false,
  selfUpdate, selfUpdateMinutes: 0.02 });
const issue = (number: number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [L.ready] });
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return ok();
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runLog = () => { try { return readFileSync(path.join(stateDir, 'run.log'), 'utf8'); } catch { return ''; } };

/** Start the old runner (`runPool --watch`, in-process) with the config also on disk for the new one. */
function start(selfUpdate = true, issues: number[] = []) {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: issues.map(issue) }));
  rmSync(path.join(stateDir, 'selfupdate.json'), { force: true });
  saveConfig(stateDir, config(selfUpdate));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const ac = new AbortController();
  const run = pooled((signal) => runPool({ root, stateDir, config: config(selfUpdate) }, { workers: 1, watch: true, dryRun: false, signal }), ac.signal)
    .finally(() => { console.log = orig; });
  let rc: number | undefined;
  run.then((r) => { rc = r; }, () => {});
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  return { lines, run, rc: () => rc, has, count, text: () => `${lines.join('\n')}\n--- run.log ---\n${runLog()}`, stop: async () => { ac.abort(); return run; } };
}
/** Stop the new runner, if one owns live.json (whether or not an assertion failed): drain it (.hx/pause), wait for it to exit. */
async function stopNew() {
  const pid = readLive(stateDir)?.pid;
  if (!pid || pid === process.pid || !pidAlive(pid)) return;
  setPause(stateDir, 'drain');
  if (!(await until(() => !pidAlive(pid), 60_000))) killTree(pid, true);
  clearPause(stateDir);
}

test('pure parts: code paths, release tags, config checks', E2E, () => {
  for (const f of ['src/pool.ts', 'bin/hx.mjs', 'scripts/ship.mjs', 'package.json', 'package-lock.json']) assert.ok(isCode(f), f);
  for (const f of ['prompts/impl.md', 'README.md', 'docs/design.md', 'test/x.test.ts', 'templates/hx-skill.md']) assert.ok(!isCode(f), f);
  assert.ok(newerTag('0.1.0', 'v0.2.0') && newerTag('0.1.9', 'v0.1.10') && !newerTag('0.2.0', 'v0.2.0') && !newerTag('1.0.0', 'v0.9.9'));
  assert.equal(selfUpdateConfigError({ selfUpdate: true, selfUpdateMinutes: 15 }), null);
  assert.match(selfUpdateConfigError({ selfUpdate: 'yes' }) ?? '', /selfUpdate/);
  assert.match(selfUpdateConfigError({ selfUpdateMinutes: 0 }) ?? '', /selfUpdateMinutes/);
  assert.equal(DEFAULTS.selfUpdate, false);
  assert.equal(DEFAULTS.selfUpdateMinutes, 15);
});

test('selfUpdate off: a new code commit on the install\'s origin changes nothing', E2E, async () => {
  const before = head();
  push({ 'src/off.ts': 'export const off = 1;\n' }, 'code while off');
  const r = start(false);
  try {
    assert.ok(await until(() => r.has(/board empty/), 30_000), r.text());
    await pause(3000);
    assert.equal(r.rc(), undefined, 'the runner goes on');
    assert.ok(!r.has(/self-update/), r.text());
    assert.equal(head(), before);
    assert.equal(existsSync(path.join(stateDir, 'selfupdate.json')), false);
  } finally { await r.stop(); }
});

test('a new code commit while idle: fast-forward, a new runner writes the ready marker and takes the run lock, the old exits; hx status shows it', E2E, async () => {
  const before = head();
  const to = push({ 'src/new.ts': 'export const n = 1;\n' }, 'code');
  const r = start();
  let pid = 0;
  try {
    assert.ok(await until(() => r.rc() !== undefined, 120_000), r.text());
    assert.equal(r.rc(), 0);
    assert.ok(r.has(new RegExp(`self-update: ${before.slice(0, 7)}\\.\\.${to.slice(0, 7)} \\(\\d+ files\\)`)), r.text());
    assert.ok(r.has(/self-update: restarted/), r.text());
    assert.equal(head(), to);
    assert.equal(git(inst, 'symbolic-ref', '--short', 'HEAD'), 'main');
    const live = readLive(stateDir);
    pid = live?.pid ?? 0;
    assert.ok(pid && pid !== process.pid && pidAlive(pid), `the run lock is the new runner's: ${JSON.stringify(live)}`);
    assert.equal(existsSync(path.join(stateDir, 'selfupdate-ready')), false, 'the marker is consumed');
    assert.match(readSelfUpdate(stateDir).last?.line ?? '', /^self-update: restarted/);
    const out = execFileSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: root, encoding: 'utf8' });
    assert.match(out, /^runner   running · pid (\d+)/m);
    assert.equal(Number(/pid (\d+)/.exec(out)?.[1]), pid);
    assert.match(out, /^update   .* ago — self-update: restarted/m);
  } finally {
    await r.stop();
    await stopNew();
  }
});

test('a commit that only changes prompts/ does not restart the runner', E2E, async () => {
  const before = head();
  push({ 'prompts/impl.md': readFileSync(path.join(dev, 'prompts', 'impl.md'), 'utf8') + '\n' }, 'prompts only');
  const r = start();
  try {
    assert.ok(await until(() => r.has(/board empty/), 30_000), r.text());
    await pause(3000);
    assert.equal(r.rc(), undefined, 'the runner goes on');
    assert.ok(!r.has(/self-update/), r.text());
    assert.equal(head(), before);
  } finally { await r.stop(); }
});

test('a session running: no update until it ends', E2E, async () => {
  push({ 'src/later.ts': 'export const l = 1;\n' }, 'code during a session');
  const r = start(true, [1]);
  try {
    assert.ok(await until(() => r.rc() !== undefined, 180_000), r.text());
    const done = r.lines.findIndex((l) => /DONE ✓/.test(l)), first = r.lines.findIndex((l) => /self-update:/.test(l));
    assert.ok(done >= 0 && first > done, `the update comes after the session\n${r.text()}`);
    assert.equal(loadJson(stateFile).issues[0].state, 'CLOSED');
    assert.ok((readLive(stateDir)?.pid ?? 0) !== process.pid, r.text());
  } finally {
    await r.stop();
    await stopNew();
  }
});

test('a dirty checkout, or one off the default branch: no update, one log line each', E2E, async () => {
  const before = head();
  push({ 'src/dirty.ts': 'export const d = 1;\n' }, 'code while dirty');
  writeFileSync(path.join(inst, 'scratch.txt'), 'local work\n');
  const r = start();
  try {
    assert.ok(await until(() => r.has(/self-update: skipped — .* has local changes/), 30_000), r.text());
    await pause(3000);
    assert.equal(r.count(/self-update: skipped/), 1, r.text());
    rmSync(path.join(inst, 'scratch.txt'));
    git(inst, 'checkout', '-q', '-b', 'side');
    assert.ok(await until(() => r.has(/self-update: skipped — .* is on side, not main/), 30_000), r.text());
    await pause(3000);
    assert.equal(r.count(/self-update: skipped/), 2, r.text());
    assert.equal(r.rc(), undefined, 'the runner goes on');
    assert.equal(head(), before);
    assert.match(readSelfUpdate(stateDir).last?.line ?? '', /is on side/);
  } finally {
    await r.stop();
    git(inst, 'checkout', '-q', 'main');
    git(inst, 'branch', '-q', '-D', 'side');
  }
});

test('new code that exits on start: rolled back, the old runner keeps running, the bad sha is skipped, a later good sha updates', E2E, async () => {
  // the commits of the earlier tests: one ordinary update first, so this test starts from origin's head
  const goodEntry = readFileSync(path.join(dev, 'bin', 'hx.mjs'), 'utf8');
  const r0 = start();
  try {
    await until(() => r0.rc() !== undefined, 120_000);
  } finally { await r0.stop(); await stopNew(); }
  const old = head();
  assert.equal(old, git(dev, 'rev-parse', 'HEAD'));

  const bad = push({ 'bin/hx.mjs': goodEntry.replace('\n', '\nprocess.exit(3);\n') }, 'bad entry'); // exits on start, after the shebang
  const r = start();
  let pid = 0;
  try {
    assert.ok(await until(() => r.has(/self-update: rolled back/), 120_000), r.text());
    assert.ok(r.has(new RegExp(`self-update: rolled back to ${old.slice(0, 7)} \\(exited with code 3 before it was ready\\)`)), r.text());
    assert.equal(head(), old, 'the checkout is back at the old sha');
    assert.equal(git(inst, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
    assert.deepEqual(readSelfUpdate(stateDir).bad, [bad]);
    assert.equal(readLive(stateDir)?.pid, process.pid, 'the old runner holds the run lock again');
    await pause(3000);
    assert.equal(r.rc(), undefined, 'the old runner keeps running');
    assert.equal(r.count(/self-update: [0-9a-f]{7}\.\./), 1, `the bad sha is not tried again\n${r.text()}`);
    // a newer sha that starts: tried, from the detached rollback
    const good = push({ 'bin/hx.mjs': goodEntry, 'src/good.ts': 'export const g = 1;\n' }, 'good again');
    assert.ok(await until(() => r.rc() !== undefined, 120_000), r.text());
    assert.equal(r.rc(), 0);
    assert.ok(r.has(new RegExp(`self-update: ${old.slice(0, 7)}\\.\\.${good.slice(0, 7)} `)), r.text());
    assert.ok(r.has(/self-update: restarted/), r.text());
    assert.equal(head(), good);
    assert.equal(git(inst, 'symbolic-ref', '--short', 'HEAD'), 'main');
    pid = readLive(stateDir)?.pid ?? 0;
    assert.ok(pid && pid !== process.pid && pidAlive(pid), r.text());
  } finally {
    await r.stop();
    await stopNew();
  }
});
