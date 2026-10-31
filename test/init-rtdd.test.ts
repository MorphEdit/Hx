// hx init and rtdd: real git (a local bare origin), fake gh and the fake rtdd with its call log.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ir-'));
const stateFile = path.join(tmp, 'board.json');
const FAKE_RTDD = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = FAKE_RTDD;
process.env.HX_FAKE_STATE = stateFile;
writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
const seed = path.join(tmp, 'seed');
git(tmp, 'clone', '-q', origin, seed);
git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
git(seed, 'push', '-q', 'origin', 'HEAD:main');

let n = 0;
function setup() {
  const app = path.join(tmp, `app${++n}`), log = path.join(tmp, `rtdd${n}.log`);
  git(tmp, 'clone', '-q', origin, app);
  const hx = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
    [path.join(here, '..', 'bin', 'hx.mjs'), 'init', ...args], { cwd: app, encoding: 'utf8', env: { ...process.env, HX_FAKE_RTDD_LOG: log, ...env } });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { app, hx, calls };
}
const HINT = /hx init --rtdd.*commit \.rtdd\//;

test('hx init --rtdd runs rtdd init in the repo root, commits nothing; no --version probe, no hint', E2E, () => {
  const { app, hx, calls } = setup();
  const head = git(app, 'rev-parse', 'HEAD');
  const r = hx(['--rtdd']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(path.join(app, '.rtdd', 'config.yaml')));
  assert.deepEqual(calls(), [['init']]);
  assert.doesNotMatch(r.stdout, HINT);
  assert.equal(git(app, 'rev-parse', 'HEAD'), head, 'nothing committed');
  assert.match(git(app, 'status', '--porcelain'), /\.rtdd\//, '.rtdd/ is left uncommitted');
});

test('hx init --rtdd with a failing rtdd init: error printed, config saved, non-zero exit', E2E, () => {
  const { app, hx, calls } = setup();
  const r = hx(['--rtdd'], { HX_FAKE_RTDD_INIT_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rtdd init failed.*rtdd init: failed/);
  assert.ok(existsSync(path.join(app, '.hx', 'config.json')), 'the rest of init is done');
  assert.match(r.stdout, /created .*config\.json/);
  assert.deepEqual(calls(), [['init']]);
});

test('hx init without .rtdd/config.yaml in the working tree: hint, rtdd called only with --version', E2E, () => {
  const { hx, calls } = setup();
  const r = hx([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, HINT);
  assert.deepEqual(calls(), [['--version']]);
});

test('hx init with an uncommitted .rtdd/config.yaml: no hint, rtdd not called', E2E, () => {
  const { app, hx, calls } = setup();
  mkdirSync(path.join(app, '.rtdd'));
  writeFileSync(path.join(app, '.rtdd', 'config.yaml'), 'version: 1\n');
  const r = hx([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /rtdd/);
  assert.deepEqual(calls(), []);
});

test('hx init with a broken or missing rtdd: nothing about rtdd, exit 0', E2E, () => {
  for (const env of [{ HX_FAKE_RTDD_VERSION_FAIL: '1' }, { HX_RTDD_BIN: path.join(tmp, 'no-such-rtdd.mjs') },
    { HX_RTDD_BIN: path.join(tmp, 'no-such-rtdd') }]) {
    const { app, hx } = setup();
    const r = hx([], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /rtdd/, JSON.stringify(env));
    rmSync(app, { recursive: true, force: true });
  }
});

test('hx init uses config.rtddBin of an existing .hx/config.json when HX_RTDD_BIN is empty', E2E, () => {
  const { app, hx, calls } = setup();
  assert.equal(hx([]).status, 0);
  const cfg = path.join(app, '.hx', 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), rtddBin: FAKE_RTDD }));
  const r = hx(['--rtdd'], { HX_RTDD_BIN: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(), [['--version'], ['init']]);
});

test('hx init creates the bug lane labels bug and bug-triaged', E2E, () => {
  const { hx } = setup();
  const r = hx([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const labels: string[] = JSON.parse(readFileSync(stateFile, 'utf8')).labels ?? [];
  for (const l of ['bug', 'bug-triaged']) assert.ok(labels.includes(l), `${l} in ${labels.join(', ')}`);
});

test('hx help mentions --rtdd on the init line', E2E, () => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^\s+init \[--rtdd\]/m);
});

test('every test file that spawns hx init sets HX_RTDD_BIN to the fake rtdd', E2E, () => {
  for (const f of readdirSync(here).filter((f) => f.endsWith('.test.ts'))) {
    const src = readFileSync(path.join(here, f), 'utf8');
    if (!/hx\('init'|'init', \.\.\.args|hx\.mjs'\), 'init'/.test(src)) continue;
    assert.match(src, /process\.env\.HX_RTDD_BIN = .*'fakes', 'rtdd\.mjs'\)|process\.env\.HX_RTDD_BIN = FAKE_RTDD/, f);
  }
});
