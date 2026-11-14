// #472: a runner records how it ends (exit.json with its pid, code and reason, and a run.log line) for a crash, a
// signal and a normal end; one that died without a record is named by hx status; log() writes run.log before the console.
import { E2E, deadPid } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, 'fakes', 'exitrunner.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-exit-'));

const { diedWithoutRecord, readExit, readExitRecord, recordExits, writeExit, writeLive, EXIT_SIGNALS } = await import('../src/runstate.ts');
const { log, runLogFile, setConsoleLog, setRunLog } = await import('../src/pool.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');

let n = 0;
const newState = () => { const d = path.join(tmp, `s${++n}`, '.hx'); mkdirSync(d, { recursive: true }); return d; };
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return ok();
};
const runLog = (stateDir: string) => { try { return readFileSync(runLogFile(stateDir), 'utf8').trim().split('\n').map((l) => l.replace(/^\S+ /, '')); } catch { return []; } };

/** The fake runner in `mode`, to its end: its pid, exit code, run.log lines (no timestamps) and exit.json. */
async function runner(mode: string, o: { during?: (child: ReturnType<typeof spawn>, stateDir: string) => Promise<void> | void } = {}) {
  const stateDir = newState();
  const child = spawn(process.execPath, [RUNNER, stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stdout!.resume(); child.stderr!.on('data', (d) => { err += d; });
  const exit = new Promise<{ code: number | null; signal: string | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  if (o.during) { assert.ok(await until(() => existsSync(path.join(stateDir, 'ready')), 30_000), `the runner started: ${err}`); await o.during(child, stateDir); }
  const { code, signal } = await exit;
  const record = (() => { try { return JSON.parse(readFileSync(path.join(stateDir, 'exit.json'), 'utf8')); } catch { return null; } })();
  return { pid: child.pid!, code, signal, stateDir, lines: runLog(stateDir), record, err, stopped: existsSync(path.join(stateDir, 'stopped')) };
}

test('an uncaught exception: exit.json has the pid, code 1 and the reason; run.log names it; the process exits 1', E2E, async () => {
  const r = await runner('throw');
  assert.equal(r.code, 1, r.err);
  assert.equal(r.record?.pid, r.pid);
  assert.equal(r.record.code, 1);
  assert.equal(r.record.reason, 'uncaught exception: boom in the loop');
  assert.ok(!Number.isNaN(Date.parse(r.record.at)));
  assert.deepEqual(r.lines, ['hx pool up', `crashed: uncaught exception: boom in the loop — runner pid ${r.pid} exits 1`]);
  assert.match(r.err, /Error: boom in/, 'the trace still reaches stderr');
  assert.ok(r.stopped, 'the stop hook ran (hx run kills its sessions there)');
  assert.equal(readExit(r.stateDir, r.pid), 1);
  assert.equal(readExitRecord(r.stateDir, r.pid)?.reason, 'uncaught exception: boom in the loop');
});

test('an unhandled rejection: exit.json has the pid, code 1 and the reason; run.log names it; the process exits 1', E2E, async () => {
  const r = await runner('reject');
  assert.equal(r.code, 1, r.err);
  assert.deepEqual({ pid: r.record?.pid, code: r.record?.code, reason: r.record?.reason },
    { pid: r.pid, code: 1, reason: 'unhandled rejection: a promise nobody awaited' });
  assert.deepEqual(r.lines, ['hx pool up', `crashed: unhandled rejection: a promise nobody awaited — runner pid ${r.pid} exits 1`]);
  assert.ok(r.stopped);
});

for (const sig of EXIT_SIGNALS.filter((s) => s !== 'SIGINT' && os.constants.signals[s as keyof typeof os.constants.signals] !== undefined)) {
  test(`${sig}: exit.json has the signal's name and a non-zero code before the runner stops; run.log says so`, E2E, async () => {
    const r = await runner(`signal:${sig}`);
    const code = 128 + os.constants.signals[sig as keyof typeof os.constants.signals];
    assert.equal(r.code, code, r.err);
    assert.deepEqual({ pid: r.record?.pid, code: r.record?.code, reason: r.record?.reason }, { pid: r.pid, code, reason: sig });
    assert.deepEqual(r.lines, ['hx pool up', `runner pid ${r.pid} stopped by ${sig}`]);
    assert.ok(r.stopped);
  });
}

test('SIGBREAK is recorded only where the platform has it', E2E, () => {
  assert.deepEqual([...EXIT_SIGNALS], ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
  assert.equal(os.constants.signals['SIGBREAK' as keyof typeof os.constants.signals] !== undefined, process.platform === 'win32');
});

test('a real SIGTERM (not on Windows, where one cannot be sent): recorded, then the runner stops', { ...E2E, skip: process.platform === 'win32' }, async () => {
  const r = await runner('wait', { during: (child) => { child.kill('SIGTERM'); } });
  assert.equal(r.code, 128 + os.constants.signals.SIGTERM, r.err);
  assert.equal(r.record?.reason, 'SIGTERM');
  assert.equal(r.record.pid, r.pid);
  assert.deepEqual(r.lines, ['hx pool up', `runner pid ${r.pid} stopped by SIGTERM`]);
});

test('SIGINT: recorded at once (code 130) while hx run\'s own handler stops the run; the final record keeps the signal', E2E, async () => {
  const r = await runner('sigint');
  assert.equal(r.code, 0, r.err);
  const early = JSON.parse(readFileSync(path.join(r.stateDir, 'exit-early.json'), 'utf8'));
  assert.deepEqual({ pid: early.pid, code: early.code, reason: early.reason }, { pid: r.pid, code: 128 + os.constants.signals.SIGINT, reason: 'SIGINT' });
  assert.deepEqual({ pid: r.record?.pid, code: r.record?.code, reason: r.record?.reason }, { pid: r.pid, code: 0, reason: 'SIGINT' });
  assert.deepEqual(r.lines, ['hx pool up', `runner pid ${r.pid} stopped (exit 0 after SIGINT)`]);
  assert.ok(!r.stopped, 'no stop hook: the run ended by itself');
});

test('a normal end and a process.exit somewhere: the code, the reason `exit`, one run.log line each', E2E, async () => {
  const a = await runner('end:0');
  assert.equal(a.code, 0, a.err);
  assert.deepEqual({ pid: a.record?.pid, code: a.record?.code, reason: a.record?.reason }, { pid: a.pid, code: 0, reason: 'exit' });
  assert.deepEqual(a.lines, ['hx pool up', `runner pid ${a.pid} stopped (exit 0)`]);
  const b = await runner('exit:7');
  assert.equal(b.code, 7, b.err);
  assert.deepEqual({ pid: b.record?.pid, code: b.record?.code, reason: b.record?.reason }, { pid: b.pid, code: 7, reason: 'exit' });
  assert.deepEqual(b.lines, ['hx pool up', `runner pid ${b.pid} stopped (exit 7)`]);
});

test('recordExits: end() writes the final record and its line once, and takes its process handlers away', E2E, () => {
  const stateDir = newState(), lines: string[] = [];
  const events = ['uncaughtException', 'unhandledRejection', 'exit', 'SIGINT', 'SIGTERM', 'SIGHUP'];
  const count = () => events.map((e) => process.listenerCount(e));
  const before = count();
  const rec = recordExits({ stateDir, log: (l) => lines.push(l) });
  assert.deepEqual(count(), before.map((c) => c + 1), 'one handler each while the run lasts');
  rec.end(3, 'error: the board could not be read');
  assert.deepEqual(count(), before, 'none left');
  rec.end(0);
  assert.deepEqual(lines, [`runner pid ${process.pid} stopped (exit 3) — error: the board could not be read`]);
  assert.deepEqual({ ...readExitRecord(stateDir, process.pid), at: '' }, { pid: process.pid, code: 3, at: '', reason: 'error: the board could not be read' });
});

test('a console that went away: the runner keeps running, run.log gets every line, it ends by itself', E2E, async () => {
  const r = await runner('console', { during: (child, stateDir) => {
    child.stdout!.destroy(); child.stderr!.destroy(); // its console is gone: every later write to it fails
    writeFileSync(path.join(stateDir, 'go'), '');
  } });
  assert.deepEqual(r.lines, ['hx pool up', 'board empty — watching for new issues', 'still here', `runner pid ${r.pid} stopped (exit 0)`]);
  assert.equal(r.code, 0);
  assert.deepEqual({ code: r.record?.code, reason: r.record?.reason }, { code: 0, reason: 'exit' });
});

test('log(): the run.log line is written before the console line, so a console write that fails does not cost it', E2E, () => {
  const stateDir = newState(), file = runLogFile(stateDir);
  const real = console.log, seen: string[] = [];
  setRunLog(file);
  try {
    console.log = () => { seen.push(readFileSync(file, 'utf8')); throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' }); };
    assert.throws(() => log('board empty — watching for new issues'), { code: 'EBADF' });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /^\S+ board empty — watching for new issues\n$/, 'run.log had the line when the console was written');
    setConsoleLog(false);
    log('second', 12);
    assert.equal(seen.length, 1, 'no console line with the console off');
    assert.deepEqual(runLog(stateDir), ['board empty — watching for new issues', '[#12] second']);
  } finally { console.log = real; setConsoleLog(true); setRunLog(null); }
});

test('writeExit / readExitRecord: the reason is kept, another pid\'s record reads as none', E2E, () => {
  const stateDir = newState();
  writeExit(stateDir, 143, 4242, 'SIGTERM');
  assert.deepEqual({ ...readExitRecord(stateDir, 4242), at: '' }, { pid: 4242, code: 143, at: '', reason: 'SIGTERM' });
  assert.equal(readExit(stateDir, 4242), 143);
  assert.equal(readExitRecord(stateDir, 4243), null);
  writeExit(stateDir, 0, 4242);
  assert.ok(!('reason' in readExitRecord(stateDir, 4242)!), 'no reason given: none recorded');
});

const liveAt = (stateDir: string, pid: number, sessions = 0) => writeLive(stateDir, { pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 3,
  sessions: Array.from({ length: sessions }, (_, i) => ({ key: `issue:${i + 1}`, number: i + 1, kind: 'impl', title: 't', since: new Date().toISOString(), turn: 1, tokens: 0 })) });

test('diedWithoutRecord: a dead pid in live.json and no exit record of that pid; last seen is the newer of run.log\'s last line and live.json', E2E, () => {
  const stateDir = newState();
  assert.equal(diedWithoutRecord(stateDir), null, 'no live.json');
  liveAt(stateDir, process.pid);
  assert.equal(diedWithoutRecord(stateDir), null, 'the runner is alive');
  liveAt(stateDir, deadPid(), 2);
  const beat = new Date('2026-11-11T14:17:29.000Z');
  utimesSync(path.join(stateDir, 'live.json'), beat, beat);
  assert.deepEqual(diedWithoutRecord(stateDir), { pid: deadPid(), sessions: 2, lastSeen: '2026-11-11T14:17:29.000Z' }, 'no run.log: the heartbeat');
  writeFileSync(runLogFile(stateDir), '2026-11-11T14:17:24.000Z self-update: c380a1c..c8fd3a1 (60 files)\n2026-11-11T14:17:25.500Z hx pool up\n');
  assert.equal(diedWithoutRecord(stateDir)!.lastSeen, '2026-11-11T14:17:29.000Z', 'the heartbeat is newer than the last line');
  writeFileSync(runLogFile(stateDir), '2026-11-11T14:17:29.000Z hx pool up\r\n2026-11-11T14:20:00.250Z board empty — watching for new issues\r\n');
  assert.equal(diedWithoutRecord(stateDir)!.lastSeen, '2026-11-11T14:20:00.250Z', 'the last run-log line is newer');
  writeExit(stateDir, 0, 38488, 'exit'); // the old runner's record, as in the report
  assert.equal(diedWithoutRecord(stateDir)!.pid, deadPid(), 'another runner\'s record is not this one\'s');
  writeExit(stateDir, 1, deadPid(), 'uncaught exception: boom');
  assert.equal(diedWithoutRecord(stateDir), null, 'it recorded its exit');
});

test('hx status: `runner   died without a record — pid N, last seen <time>` for a dead pid with no exit record of its own', E2E, () => {
  const app = path.join(tmp, 'app');
  const stateDir = path.join(app, '.hx');
  mkdirSync(stateDir, { recursive: true });
  saveConfig(stateDir, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') } as any);
  const board = path.join(tmp, 'board.json');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const hx = () => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: board } });
  const runnerLines = (out: string) => out.split(/\r?\n/).filter((l) => l.startsWith('runner   '));

  // the report: live.json names the dead new runner, exit.json is still the old runner's
  liveAt(stateDir, deadPid());
  writeExit(stateDir, 0, 38488);
  const seen = new Date(statSync(path.join(stateDir, 'live.json')).mtimeMs);
  let st = hx();
  assert.equal(st.status, 0, st.stdout + st.stderr);
  let lines = runnerLines(st.stdout);
  assert.equal(lines[0], 'runner   not running');
  assert.ok(lines[1].startsWith(`runner   died without a record — pid ${deadPid()}, last seen ${seen.toLocaleString()} (`), lines[1]);
  assert.match(lines[1], / \(\d+s ago\)$/);
  assert.equal(lines.length, 2);

  // it recorded a crash: the reason, not `died without a record`
  writeExit(stateDir, 1, deadPid(), 'uncaught exception: EBADF: bad file descriptor, write');
  st = hx();
  lines = runnerLines(st.stdout);
  assert.equal(lines[0], 'runner   not running');
  assert.match(lines[1], new RegExp(`^runner   last exit 1 — pid ${deadPid()}, uncaught exception: EBADF: bad file descriptor, write, \\d+s ago$`));
  assert.doesNotMatch(st.stdout, /died without a record/);

  // a live runner, or none: neither line
  liveAt(stateDir, process.pid);
  st = hx();
  assert.match(st.stdout, new RegExp(`^runner   running · pid ${process.pid}`, 'm'));
  assert.doesNotMatch(st.stdout, /died without a record|last exit/);
  rmSync(path.join(stateDir, 'live.json'));
  st = hx();
  assert.deepEqual(runnerLines(st.stdout), ['runner   not running']);
});
