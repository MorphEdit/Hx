// hx run with a PRD at its quality bar: until the round flow lands the bar action is skipped with one log
// line — no crash, no session, the PRD stays open. Real git (a local bare origin), fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-qb-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');

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
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false } });

const BAR = 'Billing.\n\n## Quality bar\nBeat: Stripe Billing — https://stripe.com/billing\nJudged on:\n- invoice speed\n';
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));

test('a PRD at its bar: hx run logs the skip once, runs no session and leaves the PRD open', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
    { number: 1, title: 'billing', body: BAR, state: 'OPEN', labels: [L.prd, L.hardened, L.reviewed, L.secured] },
    { number: 2, title: 'part', body: 'do it\n\n## Parent\n#1\n', state: 'CLOSED', labels: [L.ready] },
  ] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  let rc: number;
  try { rc = await pooled((signal) => runPool(project(), { workers: 1, watch: false, dryRun: false, signal })); } finally { console.log = orig; }
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(lines.filter((l) => /crashed|FAILED/.test(l)), []);
  assert.equal(lines.filter((l) => /\[#1\] bar: quality bar round not implemented yet/.test(l)).length, 1, lines.join('\n'));
  const p = read().issues.find((i: any) => i.number === 1);
  assert.equal(p.state, 'OPEN');
  assert.ok(!p.labels.includes(L.working), p.labels.join());
  assert.deepEqual(readdirSync(fakeDir), [], 'no session ran');
});
