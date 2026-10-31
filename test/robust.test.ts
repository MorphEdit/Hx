// Phase 3: crash recovery, one runner per repo, pause (drain / now), Ctrl+C checkpoints, usage holds.
// Real git (a local bare origin), fake gh and fake claude, like pool.test.ts.
import { E2E, pooled, sessionEnvs, deadPid } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-r-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');
const { readLive, setPause, clearPause, writeLive } = await import('../src/runstate.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false } });

const issue = (number: number, labels: string[] = [L.ready], body = '') => ({ number, title: `task ${number}`, body, state: 'OPEN', labels });
const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const byNum = (n: number) => read().issues.find((i: any) => i.number === n);

async function run(opts: { workers?: number; signal?: AbortSignal; env?: Record<string, string> } = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const rc = await pooled((signal) => runPool(project(), { workers: opts.workers ?? 1, watch: false, dryRun: false, signal }), opts.signal);
    return { rc, lines };
  } finally {
    console.log = orig;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/** Call fn once a new claude session has received its first prompt (so it is mid-turn). */
function whenSessionStarts(fn: () => void): void {
  const before = new Set(readdirSync(fakeDir));
  const t = setInterval(() => {
    if (readdirSync(fakeDir).some((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))) { clearInterval(t); setTimeout(fn, 200); }
  }, 50);
  // a session that never starts must fail the test, not keep this file's event loop alive forever
  setTimeout(() => clearInterval(t), 30_000).unref();
}

test('a crashed run: its claims are handed back and the work completes', E2E, async () => {
  board([issue(1, [L.ready, L.working])]);
  writeLive(stateDir, { pid: deadPid(), startedAt: new Date().toISOString(), repo: 'me/app', workers: 1,
    sessions: [{ key: 'issue:1', number: 1, kind: 'impl', title: 'task 1', since: new Date().toISOString(), turn: 1, tokens: 0 }] });
  const { rc, lines } = await run();
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => /recovered .* released impl/.test(l)));
  assert.equal(byNum(1).state, 'CLOSED');
  assert.deepEqual(byNum(1).labels, [L.ready]);
  assert.equal(readLive(stateDir), null, 'live.json removed when the run ends');
});

test('a second runner for the same repo is refused', E2E, async () => {
  board([issue(2)]);
  writeLive(stateDir, { pid: process.ppid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  const { rc, lines } = await run();
  assert.equal(rc, 3);
  assert.ok(lines.some((l) => /already running/.test(l)));
  assert.equal(byNum(2).state, 'OPEN', 'nothing was claimed');
  writeFileSync(path.join(stateDir, 'live.json'), '{}');
});

test('pause (drain): the running session finishes, nothing new is claimed, then resume continues', E2E, async () => {
  board([issue(3), issue(4)]);
  whenSessionStarts(() => setPause(stateDir, 'drain'));
  const { rc, lines } = await run({ env: { FAKE_CLAUDE_DELAY_MS: '1200' } });
  assert.equal(rc, 0);
  assert.equal(byNum(3).state, 'CLOSED', 'the running session finished');
  assert.equal(byNum(4).state, 'OPEN', 'nothing new was claimed');
  assert.deepEqual(byNum(4).labels, [L.ready]);
  assert.ok(lines.some((l) => /paused — every session has finished/.test(l)));

  const again = await run();
  assert.equal(again.rc, 3, 'refuses to start while paused');
  clearPause(stateDir);
  await run();
  assert.equal(byNum(4).state, 'CLOSED', 'resume picks up the rest');
});

test('stop mid-session (Ctrl+C / pause --now): checkpoint, hand back, the next session gets the handoff', E2E, async () => {
  board([issue(5)]);
  const ac = new AbortController();
  whenSessionStarts(() => ac.abort());
  const { rc, lines } = await run({ signal: ac.signal, env: { FAKE_CLAUDE_DELAY_MS: '5000' } });
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => /checkpoint saved/.test(l)), 'checkpoint turn ran');
  const s = read();
  assert.equal(byNum(5).state, 'OPEN');
  assert.deepEqual(byNum(5).labels, [L.ready], 'handed back');
  assert.ok(s.comments.some((c: any) => c.issue === 5 && c.body.startsWith('<!-- hx-handoff -->')));
  assert.ok(existsSync(path.join(project().config.worktreeRoot, 'i5')), 'worktree kept');
  assert.ok(readUsage(stateDir).some((r) => r.issue === 5 && r.role === 'checkpoint'));
  // the checkpoint turn is a session of its own: it gets HX_TRUSTED too
  const checkpoints = sessionEnvs(fakeDir).filter((e) => e.checkpoint);
  assert.ok(checkpoints.length > 0);
  for (const e of checkpoints) assert.equal(e.trusted, 'me');

  // next run: the fresh session's first prompt carries the handoff note
  const before = new Set(readdirSync(fakeDir));
  await run();
  assert.equal(byNum(5).state, 'CLOSED');
  const firstPrompts = readdirSync(fakeDir).filter((f) => !before.has(f) && f.endsWith('.prompt-1.txt'));
  assert.ok(firstPrompts.some((f) => /half done; next: finish part 5/.test(readFileSync(path.join(fakeDir, f), 'utf8'))),
    'handoff note passed to the next session');
});

test('pause --now from another terminal stops a running session the same way', E2E, async () => {
  board([issue(6)]);
  whenSessionStarts(() => setPause(stateDir, 'now'));
  const { lines } = await run({ env: { FAKE_CLAUDE_DELAY_MS: '5000' } });
  assert.ok(lines.some((l) => /checkpoint saved/.test(l)));
  assert.deepEqual(byNum(6).labels, [L.ready]);
  clearPause(stateDir);
});

test('a usage window over usagePauseAt holds new claims until it resets', E2E, async () => {
  board([issue(7), issue(8)]);
  const t0 = Date.now();
  const { rc, lines } = await run({ env: { FAKE_CLAUDE_RATE: '0.95' } });
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => /usage 95% on the five_hour window — no new claims until/.test(l)));
  assert.equal(byNum(7).state, 'CLOSED');
  assert.equal(byNum(8).state, 'CLOSED', 'claimed after the window reset');
  const i7done = lines.findIndex((l) => /\[#7\] impl DONE/.test(l));
  const i8start = lines.findIndex((l) => /\[#8\] impl:/.test(l));
  assert.ok(i8start > i7done, '#8 waited for the hold, not run alongside');
  assert.ok(Date.now() - t0 >= 2000);
});
