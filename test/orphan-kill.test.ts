// #328: a timed-out or stopped session must not leave the processes its agent started running, and hx run sweeps
// what an earlier run left in its worktrees. Real git (a local bare origin), fake gh and fake claude.
import { E2E, pooled, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-328-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runTurn } = await import('../src/agent.ts');
const exec = await import('../src/exec.ts');
const { namesDir, procsInDir, isInside, killByPath } = exec;
const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { setPause, clearPause } = await import('../src/runstate.ts');

/** Waits for the pid to be gone: far below the 60 s sleeper (CLAUDE.md Testing rule 3). */
const gone = async (pid: number) => {
  for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};
/** The pid a fake wrote to `file`, once it is there. */
const pidIn = async (file: string): Promise<number> => {
  for (let i = 0; i < 1200; i++) {
    const s = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (s) return Number(s);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no pid in ${file}`);
};
/** A detached 60 s sleeper whose command line names `arg`. */
const sleeper = (arg: string): number => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)', arg], { stdio: 'ignore', detached: true });
  c.unref();
  return c.pid!;
};
const reap = (pid: number) => { try { process.kill(pid); } catch {} };

test('namesDir: a path inside the directory, in either slash form; never a sibling with the same prefix', E2E, () => {
  const d = path.join(tmp, 'wt', 'i28');
  assert.ok(namesDir(`node ${path.join(d, 'bin', 'hx.mjs')} run`, d));
  assert.ok(namesDir(`node --test "${d.replace(/\\/g, '/')}/test/a.test.ts"`, d));
  assert.ok(namesDir(`git -C ${d}`, d));
  assert.ok(namesDir(`git -C "${d}" status`, d));
  assert.ok(!namesDir(`node ${path.join(tmp, 'wt', 'i285', 'x.js')}`, d), 'i28 is not i285');
  assert.ok(!namesDir('node --test "test/**/*.test.ts"', d));
  if (process.platform === 'win32') assert.ok(namesDir(`node ${d.toUpperCase()}\\x.js`, d), 'case-insensitive on Windows');
});

test('procsInDir: never the runner itself or one of its ancestors', E2E, () => {
  const d = path.join(tmp, 'wt', 'i1');
  const cmd = `node ${path.join(d, 'x.js')}`;
  const procs = [
    { pid: 10, ppid: 1, cmd }, // the runner's parent (a shell started in the worktree)
    { pid: 20, ppid: 10, cmd }, // the runner
    { pid: 30, ppid: 20, cmd }, // a child of the runner
    { pid: 40, ppid: 99, cmd }, // an orphan
    { pid: 50, ppid: 99, cmd: 'node elsewhere.js' },
  ];
  assert.deepEqual(procsInDir(procs, d, 20), [30, 40]);
});

test('killByPath refuses a directory outside the worktree root', E2E, async () => {
  const root = path.join(tmp, 'root-a');
  const outside = path.join(tmp, 'root-b', 'i9');
  mkdirSync(outside, { recursive: true });
  assert.ok(isInside(path.join(root, 'i9'), root));
  assert.ok(!isInside(root, root));
  assert.ok(!isInside(outside, root));
  const pid = sleeper(path.join(outside, 'x'));
  try {
    assert.equal(await killByPath(outside, root), 0);
    assert.ok(alive(pid), 'a process outside the worktree root is never touched');
  } finally { reap(pid); }
});

test('sweepWorktrees: kills what runs in each directory under the root, skipping the ones in use', E2E, async () => {
  const { sweepWorktrees } = await import('../src/worktree.ts');
  const root = path.join(tmp, 'root-s');
  assert.deepEqual(await sweepWorktrees(root), [], 'no root: nothing to sweep');
  mkdirSync(path.join(root, 'i1'), { recursive: true });
  mkdirSync(path.join(root, 'i2'), { recursive: true });
  const left = sleeper(path.join(root, 'i1', 'x.js'));
  const busy = sleeper(path.join(root, 'i2', 'x.js'));
  try {
    assert.deepEqual(await sweepWorktrees(root, ['i2']), [{ name: 'i1', killed: 1 }]);
    assert.ok(await gone(left), 'the leftover in i1 is killed');
    assert.ok(alive(busy), 'i2 is in use: never swept');
  } finally { reap(left); reap(busy); }
});

/** A fake claude that starts a sleeper (directly, or through a step that exits at once, as a Bash tool call that timed
 *  out leaves it), writes its pid, then hangs without a line on stdout. */
function fakeClaude(dir: string, wt: string, orphan: boolean): { bin: string; pidFile: string } {
  const pidFile = path.join(dir, 'sleeper.pid');
  const sleep = path.join(wt, 'sleep.js');
  writeFileSync(sleep, 'setTimeout(() => {}, 60e3);\n');
  const step = path.join(wt, 'step.js'); // the intermediate: starts the sleeper detached and exits
  writeFileSync(step, `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(sleep)}], { stdio: 'ignore', detached: true });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref();
`);
  const bin = path.join(dir, 'claude.mjs');
  writeFileSync(bin, orphan
    ? `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(step)}], { stdio: 'ignore' }).on('exit', () => {});
setInterval(() => {}, 60e3);
`
    : `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const c = spawn(process.execPath, [${JSON.stringify(sleep)}], { stdio: 'ignore', detached: true });
writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 60e3);
`);
  return { bin, pidFile };
}

for (const orphan of [false, true]) {
  for (const how of ['timeout', 'abort'] as const) {
    test(`runTurn ${how}: the ${orphan ? 'orphaned grandchild' : 'child'} the agent started is killed`, E2E, async () => {
      const dir = mkdtempSync(path.join(tmp, 'turn-'));
      const wt = path.join(dir, 'i285'); mkdirSync(wt);
      const { bin, pidFile } = fakeClaude(dir, wt, orphan);
      const ac = new AbortController();
      if (how === 'abort') void pidIn(pidFile).then(() => ac.abort());
      const r = await runTurn({ bin, cwd: wt, prompt: 'go', sessionId: 's', resume: false, model: 'm', extraArgs: [], sweepRoot: dir,
        timeoutMs: how === 'timeout' ? 3000 : 60_000, signal: ac.signal });
      if (how === 'timeout') assert.equal(r.timedOut, true);
      const pid = await pidIn(pidFile);
      const dead = await gone(pid);
      if (!dead) reap(pid);
      assert.ok(dead, `the sleeper ${pid} (command line in ${wt}) is still running after the session ended`);
    });
  }
}

// hx run, as in robust.test.ts
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
const wtRoot = path.join(tmp, 'wt');
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wtRoot,
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, sizeCheck: false } }); // no 60 s size turn before the impl turn writes its pid
const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], issues }));
const byNum = (n: number) => JSON.parse(readFileSync(stateFile, 'utf8')).issues.find((i: any) => i.number === n);

async function run(env: Record<string, string> = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const rc = await pooled((signal) => runPool(project(), { workers: 1, watch: false, dryRun: false, signal }));
    return { rc, lines };
  } finally {
    console.log = orig;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('hx pause --now: the orphaned process the session left in its worktree is killed', E2E, async () => {
  board([{ number: 5, title: 'task 5', body: '', state: 'OPEN', labels: [L.ready] }]);
  const pidFile = path.join(tmp, 'pause.pid');
  void pidIn(pidFile).then(() => setPause(stateDir, 'now'));
  const { lines } = await run({ FAKE_CLAUDE_ORPHAN: pidFile, FAKE_CLAUDE_DELAY_MS: '60000' });
  clearPause(stateDir);
  assert.ok(lines.some((l) => /checkpoint saved/.test(l)), lines.join('\n'));
  assert.deepEqual(byNum(5).labels, [L.ready], 'handed back');
  const pid = await pidIn(pidFile);
  const dead = await gone(pid);
  if (!dead) reap(pid);
  assert.ok(dead, `the sleeper ${pid} (command line in ${path.join(wtRoot, 'i5')}) is still running after pause --now`);
});

test('hx run start: a process left in a worktree with no live session is killed, one log line; the same name elsewhere is not', E2E, async () => {
  const left = path.join(wtRoot, 'i285');
  const elsewhere = path.join(tmp, 'elsewhere', 'i285');
  mkdirSync(left, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const victim = sleeper(path.join(left, 'bin', 'hx.mjs'));
  const bystander = sleeper(path.join(elsewhere, 'bin', 'hx.mjs'));
  try {
    board([]);
    const { rc, lines } = await run();
    assert.equal(rc, 0, lines.join('\n'));
    assert.ok(await gone(victim), `the leftover ${victim} in ${left} is still running`);
    assert.equal(lines.filter((l) => /health: killed 1 leftover process\(es\) in i285$/.test(l)).length, 1, lines.join('\n'));
    assert.ok(alive(bystander), 'a process with the same name outside the worktree root is not touched');
    assert.ok(!existsSync(left), 'the directory, no longer held open, is removed as a leftover');
  } finally { reap(victim); reap(bystander); }
});

test('parseProcessJson: a control byte in one command line (a character the code page lacks) never empties the listing', E2E, () => {
  const { parseProcessJson } = exec;
  const sub = String.fromCharCode(0x1a); // what code page 437 makes of `→`
  const text = `[{"ProcessId":4,"ParentProcessId":0,"CommandLine":null},{"ProcessId":7,"ParentProcessId":4,"CommandLine":"bash -c \\"push ${sub} fail()\\""}]\r\n`;
  assert.deepEqual(parseProcessJson(text), [{ pid: 4, ppid: 0, cmd: '' }, { pid: 7, ppid: 4, cmd: `bash -c "push ${sub} fail()"` }]);
  assert.deepEqual(parseProcessJson('{"ProcessId":9,"ParentProcessId":1,"CommandLine":"node x.js"}'), [{ pid: 9, ppid: 1, cmd: 'node x.js' }], 'one process: an object, not an array');
  assert.deepEqual(parseProcessJson('not json'), []);
  assert.deepEqual(parseProcessJson(''), []);
});

test('listProcesses / sweepWorktrees: a bystander with non-ASCII in its command line is listed as it is and turns no sweep off', E2E, async () => {
  const { sweepWorktrees } = await import('../src/worktree.ts');
  const root = path.join(tmp, 'root-u');
  mkdirSync(path.join(root, 'i285'), { recursive: true });
  const arg = 'a → b — \u{1F600}';
  const bystander = sleeper(arg);
  const left = sleeper(path.join(root, 'i285', 'x.js'));
  try {
    const procs = await exec.listProcesses();
    const me = procs.find((p) => p.pid === bystander);
    assert.ok(me, `the bystander ${bystander} is listed (${procs.length} processes)`);
    assert.ok(me.cmd.includes(arg), me.cmd);
    let one: { pid: number; cmd: string }[] = [];
    for (let i = 0; i < 3 && !one.length; i++) one = await exec.queryProcesses(); // WMI busy: an empty answer is tried again
    assert.ok(one.find((p) => p.pid === bystander)?.cmd.includes(arg), 'one query already lists it, non-ASCII intact');
    assert.deepEqual(await sweepWorktrees(root), [{ name: 'i285', killed: 1 }]);
    assert.ok(await gone(left), 'the leftover is killed');
    assert.ok(alive(bystander), 'the bystander is not touched');
  } finally { reap(left); reap(bystander); }
});
