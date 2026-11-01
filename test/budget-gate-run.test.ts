// End to end: the budget gate in hx run (real git, fake gh and fake claude) and the forecast in hx run --dry-run.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBudget } from './budget-fixture.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const L = DEFAULTS.labels;
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');

function setup(used: number, extra: Record<string, unknown> = {}) {
  writeFileSync(stateFile, JSON.stringify({ comments: [], issues: [{ number: 1, title: 'task 1', body: '', state: 'OPEN', labels: [L.ready] }] }));
  rmSync(stateDir, { recursive: true, force: true });
  writeBudget(stateDir, { used, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
  return { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...extra } };
}

async function capture(fn: () => Promise<number>, onLine = (_l: string) => {}): Promise<{ rc: number; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(String(m)); onLine(String(m)); };
  try { return { rc: await fn(), lines }; } finally { console.log = orig; }
}

test('hx run --dry-run: next lists each action with its forecast and marks the ones the gate skips', E2E, async () => {
  let { rc, lines } = await capture(() => pooled((signal) => runPool(setup(0.85), { workers: 1, watch: false, dryRun: true, signal })));
  assert.equal(rc, 0);
  assert.ok(lines.includes('\nnext: impl #1 ~3%'), lines.join('\n'));
  ({ lines } = await capture(() => pooled((signal) => runPool(setup(0.88), { workers: 1, watch: false, dryRun: true, signal }))));
  assert.ok(lines.includes('\nnext: impl #1 ~3% (budget: skip)'), lines.join('\n'));
  ({ lines } = await capture(() => pooled((signal) => runPool(setup(0.88, { budgetMinPairs: 6 }), { workers: 1, watch: false, dryRun: true, signal }))));
  assert.ok(lines.includes('\nnext: impl #1'), lines.join('\n')); // uncalibrated: no forecast shown
});

test('hx run: a gated action is not claimed, the skip is logged once, and the run waits instead of finishing', E2E, async () => {
  const p = setup(0.88);
  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // a few more polls (pollSeconds 1) after the first skip: the line is not repeated and the run does not finish
  const onLine = (l: string) => { if (!timer && /budget: not starting/.test(l)) timer = setTimeout(() => stop.abort(), 3500); };
  const { rc, lines } = await capture(() => pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal }), stop.signal), onLine)
    .finally(() => clearTimeout(timer));
  assert.ok(lines.some((l) => /budget: waiting for usage/.test(l)), lines.join('\n'));
  assert.equal(rc, 0);
  assert.equal(lines.filter((l) => l.endsWith('budget: not starting #1 impl — needs ~3% of five_hour, 88% used, cap 90%')).length, 1, lines.join('\n'));
  assert.ok(!lines.some((l) => /nothing left to do/.test(l)), 'a gated board is not "nothing to do"');
  assert.ok(!lines.some((l) => /\] impl: /.test(l)), 'not claimed');
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.deepEqual(s.issues[0].labels, [L.ready]);
});

test('hx run: budgetGate false claims as before', E2E, async () => {
  const p = setup(0.88, { budgetGate: false });
  const { rc, lines } = await capture(() => pooled((signal) => runPool(p, { workers: 1, watch: false, dryRun: false, signal })));
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(!lines.some((l) => /budget: not starting/.test(l)));
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).issues[0].state, 'CLOSED');
});
