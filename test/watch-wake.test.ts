// `hx run --watch` wakes within seconds when .hx/wake changes, instead of after pollSeconds (#100).
// Real git (a local bare origin), fake gh and claude. pollSeconds is 600: a claim in seconds is the wake's.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-w-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool, waitAny } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { loadJson, locked, saveJson } = await import('./fakes/lock.mjs');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const wakeFile = path.join(stateDir, 'wake');
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 600, audit: false } });
const issue = (number: number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [L.ready] });
const addIssue = (n: number) => locked(stateFile, () => { const s = loadJson(stateFile); s.issues.push(issue(n)); saveJson(stateFile, s); });
const claimed = (n: number) => {
  const i = loadJson(stateFile).issues.find((x: any) => x.number === n);
  return !!i && (i.state === 'CLOSED' || i.labels.includes(L.working));
};
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return ok();
};

/** Start `runPool --watch` and capture its log; stop() aborts it and waits for it to return. */
function start() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const ac = new AbortController();
  const run = pooled((signal) => runPool(project(), { workers: 1, watch: true, dryRun: false, signal }), ac.signal)
    .finally(() => { console.log = orig; });
  let rc: number | undefined;
  run.then((r) => { rc = r; }, () => {});
  return { lines, run, returned: () => rc !== undefined, stop: async () => { ac.abort(); return run; } };
}
const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
const idle = (lines: string[]) => lines.some((l) => /board empty — watching/.test(l));

test('a write to .hx/wake wakes an idle --watch run within seconds; no wake file, or a deleted one, is no error', E2E, async () => {
  rmSync(wakeFile, { force: true });
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const r = start();
  try {
    assert.ok(await until(() => idle(r.lines), 30_000), r.lines.join('\n'));
    addIssue(1);
    writeFileSync(wakeFile, String(Date.now()));
    const at = Date.now();
    assert.ok(await until(() => claimed(1), 10_000), `#1 not claimed within 10 s of the wake\n${r.lines.join('\n')}`);
    assert.ok(Date.now() - at < 10_000);
    // the file deleted while watched: no error, the run goes on, and a later write wakes it again
    rmSync(wakeFile);
    await new Promise((res) => setTimeout(res, 3000));
    assert.equal(r.returned(), false, 'the run is still going');
    assert.ok(await until(() => loadJson(stateFile).issues.find((x: any) => x.number === 1).state === 'CLOSED', 60_000), r.lines.join('\n'));
    addIssue(2);
    writeFileSync(wakeFile, String(Date.now()));
    assert.ok(await until(() => claimed(2), 10_000), `#2 not claimed after a second wake\n${r.lines.join('\n')}`);
  } finally {
    await r.stop();
  }
  assert.ok(!r.lines.some((l) => /ENOENT|wake.*fail/i.test(l)), r.lines.join('\n'));
});

test('a wake that lands while the loop reads the board is latched: the board is read again, not after pollSeconds', E2E, async () => {
  rmSync(wakeFile, { force: true });
  // the first board read is slow: during it #3 is filed and .hx/wake written, but this read's answer lacks #3
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [],
    slowList: { add: issue(3), wake: wakeFile, ms: 4500 } }));
  const r = start();
  try {
    assert.ok(await until(() => claimed(3), 30_000), `#3 not claimed: the wake was lost\n${r.lines.join('\n')}`);
  } finally {
    await r.stop();
  }
});

test('with .hx/pause present, a wake claims nothing; the drained run leaves no 600 s poll timer behind', E2E, async () => {
  rmSync(wakeFile, { force: true });
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const before = timers();
  const r = start();
  try {
    assert.ok(await until(() => idle(r.lines), 30_000), r.lines.join('\n'));
    writeFileSync(path.join(stateDir, 'pause'), 'drain');
    addIssue(4);
    writeFileSync(wakeFile, String(Date.now()));
    await until(() => r.returned(), 10_000);
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(claimed(4), false, r.lines.join('\n'));
  } finally {
    await r.stop();
    rmSync(path.join(stateDir, 'pause'), { force: true });
  }
});

test('waitAny clears its timer when another promise, or a stop, ends the wait first', E2E, async () => {
  const before = timers();
  await waitAny(600_000, new AbortController().signal, [Promise.resolve()]);
  assert.equal(timers(), before, 'woken: the 600 s timer is cleared');
  const ac = new AbortController();
  const w = waitAny(600_000, ac.signal, [new Promise(() => {})]);
  ac.abort();
  await w;
  assert.equal(timers(), before, 'stopped: the 600 s timer is cleared');
  const t = Date.now();
  await waitAny(50, new AbortController().signal, [new Promise(() => {})]);
  assert.ok(Date.now() - t >= 40, 'the timer still ends the wait');
  assert.equal(timers(), before);
});
