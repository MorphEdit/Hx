// hx start end to end: real git (a local bare origin), fake gh and fake claude (HX_CLAUDE_BIN, since there is no
// .hx/config.json to name it before hx init runs).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, labelSpecs, saveConfig } from '../src/config.ts';
import { killTree } from '../src/exec.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const FAKE_CLAUDE = path.join(here, 'fakes', 'claude.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-st-'));
const ALL_LABELS = labelSpecs(DEFAULTS.labels).map((l) => l.name);
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

let n = 0;
/** A repo with a bare origin and its own fake board; config: write .hx/config.json first. */
function repo(o: { config?: boolean; state?: Record<string, unknown> } = {}) {
  const k = ++n;
  const origin = path.join(tmp, `o${k}.git`), root = path.join(tmp, `r${k}`), fakeDir = path.join(tmp, `s${k}`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  writeFileSync(path.join(root, 'README.md'), 'app\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  mkdirSync(fakeDir);
  if (o.config) saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `w${k}`), claudeBin: FAKE_CLAUDE });
  const stateFile = path.join(tmp, `board${k}.json`);
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], labels: ALL_LABELS, ...o.state }));
  const env = { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_DIR: fakeDir,
    HX_CLAUDE_BIN: FAKE_CLAUDE, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '23.6.0', HX_LABEL_RETRY_MS: '10' };
  return { root, env, board: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}
type Repo = ReturnType<typeof repo>;

function hx(r: Repo, args: string[], input = '', env: Record<string, string> = {}) {
  const p = spawnSync(process.execPath, [HX, ...args], { cwd: r.root, input, encoding: 'utf8', env: { ...r.env, ...env } });
  return { code: p.status, out: p.stdout + p.stderr };
}

/** hx start until its output matches `until` (the run has started), then kill it and everything it started. */
function hxUntil(r: Repo, args: string[], until: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HX, ...args], { cwd: r.root, env: r.env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' });
    let out = '', done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      killTree(child.pid, true);
      err ? reject(err) : resolve(out);
    };
    const on = (d: Buffer) => { out += d.toString(); if (until.test(out)) finish(); };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (code) => finish(new Error(`hx start exited (${code}) before ${until}:\n${out}`)));
  });
}

const RUN_STARTED = /run: hx run --watch --workers 1[\s\S]*skills: /;
const at = (out: string, s: string) => { const i = out.indexOf(s); assert.ok(i >= 0, `${s} missing:\n${out}`); return i; };

test('hx start: a required ✗ (gh logged out) stops with exit 1 before init', E2E, () => {
  const r = repo({ state: { authStatus: 'out' } });
  const p = hx(r, ['start', 'add dark mode', '--yes']);
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /✗ gh logged in — not logged in/);
  assert.doesNotMatch(p.out, /init:/);
  assert.ok(!existsSync(path.join(r.root, '.hx', 'config.json')));
  assert.equal(r.board().issues.length, 0);
});

test('hx start "idea" --yes on a fresh repo: doctor notes the config, init runs, the PRD is filed, the plan shown, the run starts; a second hx start finds every step done', E2E, async () => {
  const r = repo();
  const out = await hxUntil(r, ['start', 'add dark mode', '--yes', '--workers', '1'], RUN_STARTED);
  assert.match(out, /– \.hx\/config\.json — missing\n\s+fix: `hx start` runs `hx init` next/);
  assert.ok(at(out, 'init: no .hx/config.json — running hx init') < at(out, 'PRD: grilling the idea'));
  assert.ok(existsSync(path.join(r.root, '.hx', 'config.json')), 'hx init wrote the config');
  const [prd] = r.board().issues;
  assert.equal(prd.title, 'Grilled feature');
  assert.ok(prd.labels.includes(DEFAULTS.labels.prd));
  assert.doesNotMatch(out, /\[y\/N\]|\[Y\/n\]|What should hx build/);
  assert.ok(at(out, 'filed https://github.com/me/app/issues/1') < at(out, 'plan:'));
  assert.ok(at(out, 'plan:') < at(out, `#${prd.number}`) && at(out, `#${prd.number}`) < at(out, 'run: hx run --watch'));

  const again = await hxUntil(r, ['start', '--yes', '--workers', '1'], RUN_STARTED);
  assert.match(again, /✓ \.hx\/config\.json/); // doctor re-runs
  assert.ok(at(again, '✓ .hx/config.json') < at(again, 'init: already done'));
  assert.ok(at(again, 'init: already done') < at(again, 'PRD: already done (#1 on the board)'));
  assert.ok(at(again, 'PRD: already done') < at(again, 'plan:') && at(again, 'plan:') < at(again, 'run: hx run --watch'));
  assert.doesNotMatch(again, /running hx init|grilling|What should hx build/);
  assert.equal(r.board().issues.length, 1, 'nothing new filed');
});

test('hx start "idea" with filing declined: init already done, nothing filed, no run', E2E, () => {
  const r = repo({ config: true });
  const p = hx(r, ['start', 'add dark mode'], 'n\n');
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /✓ \.hx\/config\.json/);
  assert.match(p.out, /init: already done/);
  assert.match(p.out, /File this PRD on me\/app\? \[y\/N\] /);
  assert.match(p.out, /not filed/);
  assert.equal(r.board().issues.length, 0);
  assert.doesNotMatch(p.out, /plan:|run: hx run|board empty|skills: /);
  assert.ok(!existsSync(path.join(r.root, '.hx', 'live.json')), 'no run, no session');
});

test('hx start without --yes: "n" to Start N worker(s) stops with exit 0 before the run', E2E, () => {
  const r = repo({ config: true, state: { issues: [{ number: 1, title: 't', body: 'b', state: 'OPEN', labels: [DEFAULTS.labels.ready] }] } });
  const p = hx(r, ['start', '--workers', '2'], 'n\n');
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /PRD: already done \(#1 on the board\)/);
  assert.match(p.out, /plan:/);
  assert.match(p.out, /Start 2 worker\(s\) now\? \[Y\/n\] /);
  assert.match(p.out, /not started/);
  assert.doesNotMatch(p.out, /run: hx run|skills: /);
});

test('hx start without an idea on an empty board asks what to build; no answer or no PRD written stops with exit 1', E2E, () => {
  const r = repo({ config: true, state: { issues: [{ number: 1, title: 'x', body: 'b', state: 'OPEN', labels: [DEFAULTS.labels.ready], author: 'mallory' }] } });
  let p = hx(r, ['start', '--yes'], '');
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /What should hx build\? /); // an untrusted ready issue does not count
  assert.match(p.out, /nothing to build/);
  p = hx(r, ['start', '--yes'], 'add dark mode\n', { FAKE_GRILL_NOWRITE: '1' });
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /no PRD written — nothing filed/);
  assert.doesNotMatch(p.out, /plan:|run: hx run/);
  assert.equal(r.board().issues.length, 1);
});

test('hx help lists start', E2E, () => {
  const p = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(p.stdout, /^\s+start \[/m);
});
