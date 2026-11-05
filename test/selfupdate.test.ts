// A watching runner updates its own hx install when idle and restarts itself; a new runner that does not start is
// rolled back (#253). Real git: the hx install is a clone (in a temp dir) of a copy of this repo's code with a bare
// origin; a second clone pushes the new commits. Fake gh and claude. The old runner runs in-process, the new one is
// a real `node <install>/bin/hx.mjs run --watch`, stopped by .hx/pause at the end of each test.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const { pidAlive, readLive, setPause, clearPause, writeLive } = await import('../src/runstate.ts');
const { readSelfUpdate, writeSelfUpdate, isCode, newerTag, selfUpdateConfigError, sessionOutcome, watchEvent, watchVerdict, gateAtOld, watchStatus } = await import('../src/selfupdate.ts');
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
  git(dev, 'commit', '-q', '--allow-empty', '-m', msg);
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
const config = (selfUpdate: boolean, extra: Record<string, unknown> = {}) => ({ ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, selfHeal: false,
  selfUpdate, selfUpdateMinutes: 0.02, ...extra });
const issue = (i: number | { number: number; body: string }) => {
  const { number, body } = typeof i === 'number' ? { number: i, body: '' } : i;
  return { number, title: `task ${number}`, body, state: 'OPEN', labels: [L.ready] };
};
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return ok();
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runLog = (dir = stateDir) => { try { return readFileSync(path.join(dir, 'run.log'), 'utf8'); } catch { return ''; } };

/**
 * Start the old runner (`runPool --watch`, in-process) with the config also on disk for the new one. `o.root`: another
 * project; `o.before`: runs once selfupdate.json is cleared (a watch window to record); `o.extra`: config on top.
 */
function start(selfUpdate = true, issues: (number | { number: number; body: string })[] = [],
  o: { root?: string; before?: () => void; extra?: Record<string, unknown> } = {}) {
  const root_ = o.root ?? root, stateDir = path.join(root_, '.hx');
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: issues.map(issue) }));
  rmSync(path.join(stateDir, 'selfupdate.json'), { force: true });
  saveConfig(stateDir, config(selfUpdate, o.extra));
  o.before?.();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const ac = new AbortController();
  const run = pooled((signal) => runPool({ root: root_, stateDir, config: config(selfUpdate, o.extra) }, { workers: 1, watch: true, dryRun: false, signal }), ac.signal)
    .finally(() => { console.log = orig; });
  let rc: number | undefined;
  run.then((r) => { rc = r; }, () => {});
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  return { lines, run, rc: () => rc, has, count, text: () => `${lines.join('\n')}\n--- run.log ---\n${runLog(stateDir)}`, stop: async () => { ac.abort(); return run; } };
}
/** Stop the new runner, if one owns live.json (whether or not an assertion failed): drain it (.hx/pause), wait for it to exit. */
async function stopNew(stateDir_ = stateDir) {
  const stateDir = stateDir_;
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

test('the watch window (#316): a pure function of the recorded events and an injected clock', E2E, () => {
  const t0 = Date.parse('2026-11-06T10:00:00Z'), min = 60_000;
  const G = 'a'.repeat(40), N = 'b'.repeat(40);
  const w0 = { from: G, to: N, until: new Date(t0 + 30 * min).toISOString(), fails: 0 };
  type E = Parameters<typeof watchEvent>[1];
  const ERR: E = { session: 'error' }, OK: E = { session: 'ok' }, OTHER: E = { session: 'other' };
  const ev = (...es: E[]) => es.reduce((w, e) => watchEvent(w, e, t0 + min), w0);
  const at = (w: typeof w0, m: number) => watchVerdict(w, t0 + m * min, 3);
  assert.deepEqual(at(ev(ERR, ERR, ERR), 1), { kind: 'rollback', reason: '3 sessions in a row ended with an error' });
  assert.equal(ev(ERR, ERR, OK).fails, 0, 'a success ends the streak');
  assert.equal(at(ev(ERR, ERR, OK), 1).kind, 'watching');
  assert.equal(at(ev(ERR, ERR, OTHER, ERR), 1).kind, 'rollback', 'a FAIL verdict, a timeout or a usage limit neither counts nor ends the streak');
  assert.equal(at(ev(ERR, OTHER, ERR, OTHER), 1).kind, 'watching');
  assert.equal(watchVerdict(ev(ERR, ERR), t0 + min, 2).kind, 'rollback', 'selfUpdateFailLimit');
  // the gate: only the first run at N counts
  assert.match((at(ev({ gate: 'bad' }), 1) as { reason: string }).reason, /^the first gate run at bbbbbbb is red and its failing tests are green at aaaaaaa$/);
  assert.equal(at(ev({ gate: 'red-at-both' }), 1).kind, 'watching');
  assert.equal(ev({ gate: 'green' }, { gate: 'bad' }).gate, 'green');
  // the clock: watching until `until`, then good; an event after the window changes nothing
  assert.deepEqual(at(w0, 29), { kind: 'watching', leftMs: min });
  assert.deepEqual(at(w0, 30), { kind: 'good' });
  assert.equal(watchEvent(w0, ERR, t0 + 31 * min), w0);
  // how a session's end counts
  assert.equal(sessionOutcome(undefined), 'other');
  assert.equal(sessionOutcome(undefined, true), 'error', 'an hx error (the session threw)');
  assert.equal(sessionOutcome({ done: true, stopReason: 'promise' }), 'ok');
  assert.equal(sessionOutcome({ done: false, stopReason: 'error' }), 'error');
  assert.equal(sessionOutcome({ done: false, stopReason: 'fatal' }), 'error');
  assert.equal(sessionOutcome({ done: false, stopReason: 'error', last: { timedOut: true } }), 'other', 'a timeout');
  for (const stopReason of ['limited', 'aborted', 'max-iterations', 'promise']) assert.equal(sessionOutcome({ done: false, stopReason }), 'other', stopReason);
  // the red first gate at N against the same command at G
  assert.equal(gateAtOld({ output: '✖ widget renders (1ms)' }, { ok: true, output: '' }), 'bad');
  assert.equal(gateAtOld({ output: '✖ widget renders (1ms)' }, { ok: false, output: '✖ widget renders (3ms)' }), 'red-at-both');
  assert.equal(gateAtOld({ output: '✖ widget renders (1ms)\n✖ menu opens (1ms)' }, { ok: false, output: '✖ widget renders (2ms)' }), 'bad');
  // hx status
  assert.equal(watchStatus(w0, t0 + 18 * min), 'watching bbbbbbb for 12 more min (rolled back to aaaaaaa if it misbehaves)');
  assert.equal(watchStatus(w0, t0 + 30 * min), null);
  assert.equal(watchStatus(undefined, t0), null);
  // the settings
  assert.equal(DEFAULTS.selfUpdateWatchMinutes, 30);
  assert.equal(DEFAULTS.selfUpdateFailLimit, 3);
  assert.equal(selfUpdateConfigError({ selfUpdateWatchMinutes: 30, selfUpdateFailLimit: 3 }), null);
  assert.match(selfUpdateConfigError({ selfUpdateWatchMinutes: 0 }) ?? '', /selfUpdateWatchMinutes/);
  assert.match(selfUpdateConfigError({ selfUpdateFailLimit: 1.5 }) ?? '', /selfUpdateFailLimit/);
});

test('selfUpdate off: a new code commit on the install\'s origin changes nothing', E2E, async () => {
  const before = head();
  push({ 'src/off.ts': 'export const off = 1;\n' }, 'code while off');
  const r = start(false);
  try {
    assert.ok(await until(() => r.has(/board empty/), 120_000), r.text());
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
    assert.ok(await until(() => r.has(/board empty/), 120_000), r.text());
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
    assert.ok(await until(() => r.has(/self-update: skipped — .* has local changes/), 120_000), r.text());
    await pause(3000);
    assert.equal(r.count(/self-update: skipped/), 1, r.text());
    rmSync(path.join(inst, 'scratch.txt'));
    git(inst, 'checkout', '-q', '-b', 'side');
    assert.ok(await until(() => r.has(/self-update: skipped — .* is on side, not main/), 120_000), r.text());
    await pause(3000);
    assert.equal(r.count(/self-update: skipped/), 2, r.text());
    assert.equal(r.rc(), undefined, 'the runner goes on');
    assert.equal(head(), before);
    assert.match(readSelfUpdate(stateDir).last?.line ?? '', /is on side/);
  } finally {
    // leave the install clean and on main even when an assertion failed, so the failure is the one reported and the
    // next test's update is not skipped as dirty
    await r.stop();
    rmSync(path.join(inst, 'scratch.txt'), { force: true });
    git(inst, 'checkout', '-q', 'main');
    if (git(inst, 'branch', '--list', 'side')) git(inst, 'branch', '-q', '-D', 'side');
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

// The watch window (#316). Each test leaves the install where a self-update from G to a new code commit N would: at N,
// on main, the window recorded in selfupdate.json. The in-process runner is the runner on N.
/** Move the install to origin/main's head, on main. */
const syncInstall = () => {
  git(inst, 'fetch', '-q', 'origin');
  git(inst, 'checkout', '-q', 'main');
  git(inst, 'merge', '--ff-only', '-q', 'origin/main');
  return head();
};
/** A self-update to a new code commit: G the install before, N after. */
const updated = (files: Record<string, string | null>, msg: string) => {
  const G = syncInstall();
  const N = push(files, msg);
  assert.equal(syncInstall(), N, 'the install is at N');
  return { G, N };
};
const recordWatch = (dir: string, G: string, N: string, ms = 30 * 60_000) =>
  writeSelfUpdate(dir, { bad: [], watch: { from: G, to: N, until: new Date(Date.now() + ms).toISOString(), fails: 0 } });
const rolledBack = (N: string, G: string, why: string) => new RegExp(`self-update: rolled back ${N.slice(0, 7)} → ${G.slice(0, 7)} \\(${why}`);
/** A runner other than this process owns the run lock, and selfupdate.json's last line says it took over. */
const tookOver = (dir: string) => {
  const l = readLive(dir);
  return !!l && l.pid !== process.pid && pidAlive(l.pid) && /^self-update: restarted/.test(readSelfUpdate(dir).last?.line ?? '');
};

test('watch: a crash inside the window → back on G, N marked bad, one log line; hx status shows the rollback; a newer sha M still updates', E2E, async () => {
  const { G, N } = updated({ 'src/crashy.ts': 'export const c = 1;\n' }, 'crashy');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const r = start(true, [], { before: () => {
    recordWatch(stateDir, G, N);
    // the runner on N crashed: its run lock is left behind
    writeLive(stateDir, { pid: dead, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  } });
  try {
    assert.ok(await until(() => r.rc() !== undefined, 120_000), r.text());
    assert.equal(r.rc(), 0, 'a runner on G took over');
    assert.equal(r.count(/self-update: rolled back/), 1, r.text());
    assert.ok(r.has(rolledBack(N, G, `the runner crashed \\(pid ${dead}\\)\\)$`)), r.text());
    assert.equal(head(), G, 'back on G');
    assert.equal(git(inst, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
    const su = readSelfUpdate(stateDir);
    assert.deepEqual(su.bad, [N]);
    assert.equal(su.watch, undefined, 'the window is closed');
    assert.deepEqual([su.rollback?.from, su.rollback?.to], [N, G]);
    const pid = readLive(stateDir)?.pid ?? 0;
    assert.ok(pid && pid !== process.pid && pidAlive(pid), 'the runner on G owns the run lock');
    const out = execFileSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: root, encoding: 'utf8' });
    assert.match(out, new RegExp(`^rollback .* ago — ${N.slice(0, 7)} → ${G.slice(0, 7)} \\(the runner crashed \\(pid ${dead}\\)\\)$`, 'm'));
    // a newer sha after the bad one: the runner on G updates to it, from the detached rollback
    const M = push({ 'src/m.ts': 'export const m = 1;\n' }, 'newer');
    assert.ok(await until(() => head() === M && tookOver(stateDir), 120_000), runLog());
    assert.equal(git(inst, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(readSelfUpdate(stateDir).watch?.to, M, 'M is watched in turn');
  } finally {
    await r.stop();
    await stopNew();
  }
});

test('watch: three agent errors in a row → back on G', E2E, async () => {
  const { G, N } = updated({ 'src/errs.ts': 'export const e = 1;\n' }, 'errors');
  const r = start(true, [1, 2, 3].map((number) => ({ number, body: 'IMPLCRASH' })), { before: () => recordWatch(stateDir, G, N) });
  try {
    assert.ok(await until(() => r.rc() !== undefined, 180_000), r.text());
    assert.equal(r.rc(), 0);
    assert.equal(r.count(/self-update: rolled back/), 1, r.text());
    assert.ok(r.has(rolledBack(N, G, '3 sessions in a row ended with an error\\)$')), r.text());
    assert.equal(head(), G);
    assert.deepEqual(readSelfUpdate(stateDir).bad, [N]);
  } finally {
    await r.stop();
    await stopNew();
  }
});

test('watch: two agent errors and then a success → no rollback', E2E, async () => {
  const { G, N } = updated({ 'src/errs2.ts': 'export const e = 2;\n' }, 'errors then ok');
  const r = start(true, [{ number: 1, body: 'IMPLCRASH' }, { number: 2, body: 'IMPLCRASH' }, 3], { before: () => recordWatch(stateDir, G, N) });
  try {
    assert.ok(await until(() => loadJson(stateFile).issues.find((i: any) => i.number === 3)?.state === 'CLOSED' && r.has(/board empty/), 180_000), r.text());
    assert.equal(r.lines.filter((l) => /FAILED ✗/.test(l)).length, 2, r.text());
    assert.ok(!r.has(/self-update: rolled back/), r.text());
    assert.equal(r.rc(), undefined, 'the runner goes on');
    assert.equal(head(), N);
    assert.equal(readSelfUpdate(stateDir).watch?.fails, 0, 'the success ended the streak');
  } finally { await r.stop(); }
});

// the gate tests: the project is hx itself (a clone of the install's origin), so its gate runs at N
const hxApp = path.join(tmp, 'hxapp'), hxAppState = path.join(hxApp, '.hx');
git(tmp, 'clone', '-q', hxOrigin, hxApp);
const gateCheck = (ok: boolean) => `console.log('${ok ? '✔' : '✖'} widget renders (1ms)');\nprocess.exit(${ok ? 0 : 1});\n`;
const gateOpts = (G: string, N: string) => ({ root: hxApp, before: () => recordWatch(hxAppState, G, N), extra: { gate: true, gateCommand: 'node gate-check.mjs' } });

test('watch: the first gate run at N is red and the failing test is green at G → back on G', E2E, async () => {
  push({ 'gate-check.mjs': gateCheck(true) }, 'gate green');
  const { G, N } = updated({ 'gate-check.mjs': gateCheck(false), 'src/gated.ts': 'export const g = 1;\n' }, 'gate red');
  const r = start(true, [], gateOpts(G, N));
  try {
    assert.ok(await until(() => r.rc() !== undefined, 180_000), r.text());
    assert.equal(r.rc(), 0);
    assert.ok(r.has(new RegExp(`self-update: the gate is red at ${N.slice(0, 7)} — running it at ${G.slice(0, 7)}`)), r.text());
    assert.equal(r.count(/self-update: rolled back/), 1, r.text());
    assert.ok(r.has(rolledBack(N, G, `the first gate run at ${N.slice(0, 7)} is red and its failing tests are green at ${G.slice(0, 7)}\\)$`)), r.text());
    assert.equal(head(), G);
    assert.deepEqual(readSelfUpdate(hxAppState).bad, [N]);
  } finally {
    await r.stop();
    await stopNew(hxAppState);
  }
});

test('watch: the first gate run at N is red and red at G too → no rollback (a gate-fix issue handles it)', E2E, async () => {
  push({ 'gate-check.mjs': gateCheck(false) }, 'gate red at G');
  const { G, N } = updated({ 'src/gated2.ts': 'export const g = 2;\n' }, 'still red');
  const r = start(true, [], gateOpts(G, N));
  try {
    assert.ok(await until(() => r.has(/self-update: the same tests fail at/), 180_000), r.text());
    await pause(2000);
    assert.ok(!r.has(/self-update: rolled back/), r.text());
    assert.equal(r.rc(), undefined, 'the runner goes on');
    assert.equal(head(), N);
    assert.equal(readSelfUpdate(hxAppState).watch?.gate, 'red-at-both');
  } finally {
    await r.stop();
    push({ 'gate-check.mjs': gateCheck(true) }, 'gate green again');
  }
});

test('watch: a clean window → N is good, no rollback; hx status shows an open window', E2E, async () => {
  const { G, N } = updated({ 'src/clean.ts': 'export const c = 2;\n' }, 'clean');
  // hx status, runner or not: the open window
  recordWatch(stateDir, G, N, 12.5 * 60_000);
  const out = execFileSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: root, encoding: 'utf8' });
  assert.match(out, new RegExp(`^watch    watching ${N.slice(0, 7)} for 1[23] more min \\(rolled back to ${G.slice(0, 7)} if it misbehaves\\)$`, 'm'));
  const r = start(true, [], { before: () => recordWatch(stateDir, G, N, 2000) });
  try {
    assert.ok(await until(() => r.has(new RegExp(`self-update: ${N.slice(0, 7)} is good$`)), 60_000), r.text());
    assert.ok(!r.has(/self-update: rolled back/), r.text());
    const su = readSelfUpdate(stateDir);
    assert.equal(su.good, N);
    assert.equal(su.watch, undefined);
    assert.equal(head(), N);
    assert.equal(r.rc(), undefined, 'the runner goes on');
  } finally { await r.stop(); }
});
