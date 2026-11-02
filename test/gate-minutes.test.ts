// The gate's time limit is gateMinutes (#180): a run past it is killed with its tree and counts as red.
import { E2E, pooled, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-gm-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readGate } = await import('../src/gate.ts');

const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
writeFileSync(path.join(root, 'README'), 'x\n');
git(root, 'add', '-A');
git(root, ...gitId, 'commit', '-q', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);

test('gateMinutes defaults to 45, above the old hard-coded 20 a loaded machine ran past', E2E, () => {
  assert.equal(DEFAULTS.gateMinutes, 45);
});

test('a gate run past gateMinutes is killed with its tree: red, timed out after gateMinutes', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const pidFile = path.join(tmp, 'gate.pid').replace(/\\/g, '/');
  const sleeper = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 120e3)"`;
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const p = { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false,
    gateCommand: sleeper, gateMinutes: 0.05 } };
  // a red gate files a fix the fake worker cannot make: stop once the first result is written
  const ac = new AbortController();
  const poll = setInterval(() => { if (readGate(stateDir).last) { clearInterval(poll); ac.abort(); } }, 50);
  const started = Date.now();
  await pooled((signal) => runPool(p, { workers: 1, watch: true, dryRun: false, signal }), ac.signal)
    .finally(() => { console.log = orig; clearInterval(poll); });
  assert.ok(Date.now() - started < 100_000, 'the gate did not wait for the 120 s command');
  const g = readGate(stateDir).last;
  assert.ok(g, lines.join('\n'));
  assert.equal(g.ok, false);
  assert.equal(g.timedOut, true);
  assert.match(g.output, /gate: timed out after 0\.05 min — process tree killed/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the gate's process ${pid} is not left running`);
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(s.issues.some((i: any) => /^Default branch is red/.test(i.title)), 'a fix issue filed');
});
