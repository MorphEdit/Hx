// The CI gate end to end: real git (a local bare origin), fake gh and claude.
// main is broken → hx files a fix issue, claims nothing else, the fix lands, the gate turns green,
// and only then does the rest of the board run.
import { E2E, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-g-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readGate } = await import('../src/gate.ts');

const L = DEFAULTS.labels;
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
// main is red: the gate command fails while a BROKEN file exists
writeFileSync(path.join(root, 'BROKEN'), 'x\n');
git(root, 'add', '-A');
git(root, ...gitId, 'commit', '-q', '-m', 'oops');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const GATE = `node -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;

test('a red main: hx files the fix, claims nothing else until main is green again', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [{ number: 1, title: 'task 1', body: '', state: 'OPEN', labels: [L.ready] }] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const p = { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gateCommand: GATE } };
  const rc = await runPool(p, { workers: 2, watch: false, dryRun: false, signal: new AbortController().signal })
    .finally(() => { console.log = orig; });
  assert.equal(rc, 0, lines.join('\n'));

  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const fix = s.issues.find((i: any) => /^Default branch is red/.test(i.title));
  assert.ok(fix, 'hx filed a fix issue');
  assert.deepEqual(fix.labels.sort(), [L.gateFix, L.ready].sort());
  assert.match(fix.body, /## Blocked by\nNone/);
  assert.equal(fix.state, 'CLOSED');
  assert.equal(s.issues.filter((i: any) => /^Default branch is red/.test(i.title)).length, 1, 'filed once');
  assert.equal(s.issues.find((i: any) => i.number === 1).state, 'CLOSED');

  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/gate RED/) >= 0);
  assert.ok(at(/gate green ✓ again/) > at(new RegExp(`\\[#${fix.number}\\] impl DONE`)), 'green only after the fix merged');
  assert.ok(at(/\[#1\] impl:/) > at(/gate green ✓ again/), '#1 waited for a green main, though a second worker was free');
  const g = readGate(stateDir);
  assert.equal(g.last?.ok, true);
  assert.equal(g.fixIssue, undefined);
});

test('a gate command that hangs: killed with its whole tree at the timeout, the gate is red with "timed out"', E2E, async () => {
  const { runGate } = await import('../src/gate.ts');
  const pidFile = path.join(tmp, 'gate.pid').replace(/\\/g, '/');
  const hang = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1e3)"`;
  const t0 = Date.now();
  const r = await runGate(root, path.join(tmp, 'wt'), 'main', hang, 1500);
  assert.ok(Date.now() - t0 < 15_000, 'gave up within seconds');
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.output, /timed out after 0\.03 min/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the gate's test process ${pid} is not left running`);
});
