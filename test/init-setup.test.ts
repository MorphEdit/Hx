// hx init detects worktreeSetup from a lockfile and worktreeCopy from a git-ignored .env (PRD #137, C.11–C.13);
// hx status shows both. Real git (a local bare origin), fake gh and the fake rtdd.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-is-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
const { SETUP_LOCKFILES, detectCopy, detectSetup } = await import('../src/cli.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
const seed = path.join(tmp, 'seed');
git(tmp, 'clone', '-q', origin, seed);
git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
git(seed, 'push', '-q', 'origin', 'HEAD:main');

let n = 0;
function setup() {
  const app = path.join(tmp, `app${++n}`);
  git(tmp, 'clone', '-q', origin, app);
  const hx = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), ...args], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  const cfgFile = path.join(app, '.hx', 'config.json');
  const cfg = () => JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
  const put = (f: string, s = '') => writeFileSync(path.join(app, f), s);
  return { app, hx, cfg, cfgFile, put };
}

test('SETUP_LOCKFILES: the ten lockfiles in order with their commands', E2E, () => {
  assert.deepEqual(SETUP_LOCKFILES.map(([l, c]) => `${l} -> ${c}`), [
    'pnpm-lock.yaml -> pnpm install --frozen-lockfile', 'yarn.lock -> yarn install --frozen-lockfile', 'package-lock.json -> npm ci',
    'bun.lockb -> bun install --frozen-lockfile', 'composer.lock -> composer install --no-interaction', 'poetry.lock -> poetry install',
    'uv.lock -> uv sync', 'Gemfile.lock -> bundle install', 'go.sum -> go mod download', 'Cargo.lock -> cargo fetch']);
});

test('detectSetup: null without a lockfile, the earlier lockfile in the list wins', E2E, () => {
  const d = mkdtempSync(path.join(tmp, 'ds-'));
  assert.equal(detectSetup(d), null);
  writeFileSync(path.join(d, 'Cargo.lock'), '');
  assert.deepEqual(detectSetup(d), { command: 'cargo fetch', lockfile: 'Cargo.lock' });
  writeFileSync(path.join(d, 'package-lock.json'), '');
  assert.deepEqual(detectSetup(d), { command: 'npm ci', lockfile: 'package-lock.json' });
  writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
  assert.deepEqual(detectSetup(d), { command: 'pnpm install --frozen-lockfile', lockfile: 'pnpm-lock.yaml' });
});

test('hx init with each of the ten lockfiles writes its command and says where it came from', E2E, () => {
  for (const [lockfile, command] of SETUP_LOCKFILES) {
    const { hx, cfg, put } = setup();
    put(lockfile);
    const out = hx('init');
    assert.equal(cfg().worktreeSetup, command, lockfile);
    assert.ok(out.includes(`worktree setup: ${command} (from ${lockfile}) — change worktreeSetup in .hx/config.json`), out);
  }
});

test('hx init with two lockfiles: the earlier one in the list wins', E2E, () => {
  const { hx, cfg, put } = setup();
  put('go.sum'); put('yarn.lock');
  assert.match(hx('init'), /worktree setup: yarn install --frozen-lockfile \(from yarn\.lock\)/);
  assert.equal(cfg().worktreeSetup, 'yarn install --frozen-lockfile');
});

test('hx init leaves a present worktreeSetup ("make deps" or "") alone, even with a lockfile', E2E, () => {
  for (const value of ['make deps', '']) {
    const { hx, cfg, cfgFile, put } = setup();
    hx('init');
    // a BOM, as Notepad writes it, does not hide the key
    writeFileSync(cfgFile, '﻿' + JSON.stringify({ ...cfg(), worktreeSetup: value }));
    put('package-lock.json');
    const out = hx('init');
    assert.equal(cfg().worktreeSetup, value);
    assert.doesNotMatch(out, /worktree setup:/);
  }
});

test('hx init with no lockfile: no worktreeSetup key, a hint; a lockfile added later is detected', E2E, () => {
  const { hx, cfg, put } = setup();
  const out = hx('init');
  assert.ok(!('worktreeSetup' in cfg()), JSON.stringify(cfg()));
  assert.match(out, /worktree setup: no lockfile found — set worktreeSetup in \.hx\/config\.json.*"worktreeSetup": "npm ci"/);
  hx('init');
  assert.ok(!('worktreeSetup' in cfg()), 'a second init with no lockfile keeps it unset');
  put('uv.lock');
  assert.match(hx('init'), /worktree setup: uv sync \(from uv\.lock\)/);
  assert.equal(cfg().worktreeSetup, 'uv sync');
});

test('hx init on a config written before this feature (no worktreeSetup/worktreeCopy) detects both', E2E, () => {
  const { hx, cfg, cfgFile, put } = setup();
  hx('init');
  const { worktreeSetup: _s, worktreeCopy: _c, ...old } = cfg();
  writeFileSync(cfgFile, JSON.stringify(old));
  put('.gitignore', '.env\n'); put('.env', 'A=1\n'); put('Gemfile.lock');
  hx('init');
  assert.equal(cfg().worktreeSetup, 'bundle install');
  assert.deepEqual(cfg().worktreeCopy, ['.env']);
});

test('detectCopy and hx init: a git-ignored .env becomes worktreeCopy [".env"]', E2E, async () => {
  const { app, hx, cfg, put } = setup();
  assert.equal(await detectCopy(app), null, 'no .env');
  put('.gitignore', '.env\n'); put('.env', 'SECRET=1\n');
  assert.deepEqual(await detectCopy(app), ['.env']);
  const out = hx('init');
  assert.deepEqual(cfg().worktreeCopy, ['.env']);
  assert.equal(out.split(/\r?\n/).filter((l) => /worktree copy: \.env/.test(l)).length, 1, out);
});

test('hx init: a tracked .env or no .env leaves worktreeCopy absent', E2E, async () => {
  const none = setup();
  none.hx('init');
  assert.ok(!('worktreeCopy' in none.cfg()));
  const tracked = setup();
  tracked.put('.env', 'A=1\n');
  git(tracked.app, 'add', '.env'); git(tracked.app, 'commit', '-q', '-m', 'env');
  assert.equal(await detectCopy(tracked.app), null);
  assert.doesNotMatch(tracked.hx('init'), /worktree copy/);
  assert.ok(!('worktreeCopy' in tracked.cfg()));
});

test('hx init leaves a present worktreeCopy ([] or ["x"]) alone, even with a git-ignored .env', E2E, () => {
  for (const value of [[], ['x']]) {
    const { hx, cfg, cfgFile, put } = setup();
    hx('init');
    writeFileSync(cfgFile, JSON.stringify({ ...cfg(), worktreeCopy: value }));
    put('.gitignore', '.env\n'); put('.env', 'A=1\n');
    assert.doesNotMatch(hx('init'), /worktree copy/);
    assert.deepEqual(cfg().worktreeCopy, value);
  }
});

test('hx status shows the setup command and the copy list when set, neither when both are empty', E2E, () => {
  const app = path.join(tmp, 'status-app');
  const sd = path.join(app, '.hx');
  mkdirSync(sd, { recursive: true });
  const base = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-status') };
  const status = () => {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  saveConfig(sd, base);
  assert.doesNotMatch(status(), /^(setup|copy) /m);
  saveConfig(sd, { ...base, worktreeSetup: 'npm ci', worktreeSetupMinutes: 7, worktreeCopy: ['.env', 'config/local'] });
  let out = status();
  assert.match(out, /^setup {4}npm ci \(timeout 7 min\)$/m);
  assert.match(out, /^copy {5}\.env, config\/local$/m);
  saveConfig(sd, { ...base, worktreeSetup: 'make deps' });
  out = status();
  assert.match(out, /^setup {4}make deps \(timeout 10 min\)$/m);
  assert.doesNotMatch(out, /^copy /m);
});
