// Test time per turn, end to end: the fake claude emits timestamped test commands, every UsageRecord of the run
// carries testMs / testRuns / testFailedRuns (0, 0, 0 without any); the gate command counts as a test; a bad testPatterns stops the run.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tm-'));
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
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false,
  security: false, roleSkills: {}, ...extra } });
const board = (n: number) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [{ number: n, title: `task ${n}`, body: '', state: 'OPEN', labels: [L.ready] }] }));

async function run(env: Record<string, string>, extra = {}, stop?: AbortSignal) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const rc = await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal }), stop);
    return { rc, lines };
  } finally {
    console.log = orig;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

test('every turn of a run records testMs, testRuns and testFailedRuns from its timestamped test commands', E2E, async () => {
  board(1);
  const r = await run({ FAKE_CLAUDE_TESTS: '1' });
  assert.equal(r.rc, 0, r.lines.join('\n'));
  const recs = readUsage(stateDir).filter((u) => u.issue === 1);
  assert.ok(recs.length >= 2, JSON.stringify(recs));
  for (const u of recs) {
    // npm test passes, node --test ends Exit code 1, cat test/x.ts is no test
    assert.equal(u.testRuns, 2, JSON.stringify(u));
    assert.equal(u.testFailedRuns, 1, JSON.stringify(u));
    assert.ok(Number.isInteger(u.testMs) && u.testMs! >= 0 && u.testMs! <= u.durationMs, JSON.stringify(u));
  }
});

test('the gate command counts as a test: from config.gateCommand, else from gate.json', E2E, async () => {
  board(2);
  let r = await run({ FAKE_CLAUDE_TESTS: '1' }, { gateCommand: 'cat test/x.ts' });
  assert.equal(r.rc, 0, r.lines.join('\n'));
  let recs = readUsage(stateDir).filter((u) => u.issue === 2);
  assert.ok(recs.length);
  for (const u of recs) assert.equal(u.testRuns, 3, JSON.stringify(u));

  board(3);
  writeFileSync(path.join(stateDir, 'gate.json'), JSON.stringify({ command: '  CAT test/x.ts ' }));
  try {
    r = await run({ FAKE_CLAUDE_TESTS: '1' });
    assert.equal(r.rc, 0, r.lines.join('\n'));
  } finally { rmSync(path.join(stateDir, 'gate.json'), { force: true }); }
  recs = readUsage(stateDir).filter((u) => u.issue === 3);
  assert.ok(recs.length);
  for (const u of recs) assert.equal(u.testRuns, 3, JSON.stringify(u));
});

test('a turn without test commands records 0, 0, 0', E2E, async () => {
  board(4);
  const r = await run({});
  assert.equal(r.rc, 0, r.lines.join('\n'));
  const recs = readUsage(stateDir).filter((u) => u.issue === 4);
  assert.ok(recs.length);
  for (const u of recs) assert.deepEqual([u.testMs, u.testRuns, u.testFailedRuns], [0, 0, 0], JSON.stringify(u));
});

test('an invalid testPatterns regex stops the run before anything is claimed, naming the entry', E2E, async () => {
  board(5);
  const r = await run({}, { testPatterns: ['(unclosed'] });
  assert.equal(r.rc, 2);
  assert.ok(r.lines.some((l) => /STOPPED: testPatterns: "\(unclosed" is not a valid regular expression/.test(l)), r.lines.join('\n'));
  assert.equal(readUsage(stateDir).filter((u) => u.issue === 5).length, 0);
});

test('a checkpoint turn records its test time too', E2E, async () => {
  board(6);
  const ac = new AbortController();
  const before = new Set(readdirSync(fakeDir));
  const t = setInterval(() => {
    if (readdirSync(fakeDir).some((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))) { clearInterval(t); setTimeout(() => ac.abort(), 200); }
  }, 50);
  setTimeout(() => clearInterval(t), E2E.timeout).unref();
  const r = await run({ FAKE_CLAUDE_DELAY_MS: '5000', FAKE_CLAUDE_TESTS: '1' }, {}, ac.signal);
  assert.equal(r.rc, 0, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /checkpoint saved/.test(l)), r.lines.join('\n'));
  const cps = readUsage(stateDir).filter((u) => u.issue === 6 && u.role === 'checkpoint');
  assert.ok(cps.length);
  for (const u of cps) assert.deepEqual([u.testRuns, u.testFailedRuns], [2, 1], JSON.stringify(u));
});
