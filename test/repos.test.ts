// ~/.hx/repos.json: every hx init / hx run records its repo there, hx fleet forget drops one (#165).
// Real git (a local bare origin) and fake gh; HX_HOME is a temp dir per test, never the real home.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRepos, registerRepo, reposFile, seeRepo, writeRepos } from '../src/fleet.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-repos-'));
const stateFile = path.join(tmp, 'board.json');
writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
const FAKES = { HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile };

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
const seed = path.join(tmp, 'seed');
git(tmp, 'clone', '-q', origin, seed);
git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
git(seed, 'push', '-q', 'origin', 'HEAD:main');

let n = 0;
function home(): string {
  const h = path.join(tmp, `home${++n}`);
  mkdirSync(h);
  return h;
}
function app(): string {
  const a = path.join(tmp, `app${++n}`);
  git(tmp, 'clone', '-q', origin, a);
  return a;
}
function hx(h: string, cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...FAKES, HX_HOME: h } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const reposOf = (h: string) => JSON.parse(readFileSync(path.join(h, '.hx', 'repos.json'), 'utf8')).repos;
const tmpFiles = (h: string) => readdirSync(path.join(h, '.hx')).filter((f) => /^repos\.json\..*\.tmp$/.test(f));
function withHome<T>(h: string, f: () => T): T {
  const before = process.env.HX_HOME;
  process.env.HX_HOME = h;
  try { return f(); } finally { if (before === undefined) delete process.env.HX_HOME; else process.env.HX_HOME = before; }
}

test('reposFile honours HX_HOME; readRepos: absent → empty, unparsable or no repos array → null', E2E, () => {
  const h = home();
  withHome(h, () => {
    assert.equal(reposFile(), path.join(h, '.hx', 'repos.json'));
    assert.deepEqual(readRepos(), { repos: [] });
    mkdirSync(path.join(h, '.hx'));
    for (const bad of ['{nope', '{"repos": 3}', '{}', 'null']) {
      writeFileSync(reposFile(), bad);
      assert.equal(readRepos(), null, bad);
    }
    writeRepos({ repos: [{ root: 'R', repo: 'me/r', lastSeen: 't' }] });
    assert.deepEqual(readRepos(), { repos: [{ root: 'R', repo: 'me/r', lastSeen: 't' }] });
  });
});

test('seeRepo adds a new root and updates the same root (sameRoot) in place', E2E, () => {
  const a = path.join(tmp, 'A'), b = path.join(tmp, 'B');
  const t1 = new Date('2026-01-01T00:00:00Z'), t2 = new Date('2026-01-02T00:00:00Z');
  let l = seeRepo({ repos: [] }, a, 'me/a', t1);
  l = seeRepo(l, b, 'me/b', t1);
  l = seeRepo(l, a + path.sep, 'me/a2', t2);
  assert.deepEqual(l.repos, [
    { root: path.resolve(a + path.sep), repo: 'me/a2', lastSeen: t2.toISOString() },
    { root: b, repo: 'me/b', lastSeen: t1.toISOString() },
  ]);
  if (process.platform === 'win32') assert.equal(seeRepo(l, a.toUpperCase(), 'me/a', t2).repos.length, 2);
});

test('registerRepo creates a missing .hx dir, leaves an unparsable file byte for byte, never throws', E2E, () => {
  const h = home();
  withHome(h, () => {
    registerRepo(path.join(tmp, 'X'), 'me/x');
    assert.deepEqual(reposOf(h).map((r: any) => r.repo), ['me/x']);
    assert.deepEqual(tmpFiles(h), []);
    writeFileSync(reposFile(), '{"repos": [ broken');
    registerRepo(path.join(tmp, 'Y'), 'me/y');
    assert.equal(readFileSync(reposFile(), 'utf8'), '{"repos": [ broken');
  });
  const h2 = home();
  writeFileSync(path.join(h2, '.hx'), 'a file where the .hx dir should be');
  withHome(h2, () => assert.doesNotThrow(() => registerRepo(path.join(tmp, 'Z'), 'me/z')));
});

test('hx init and hx run --dry-run record the repo; running twice gives one entry with a later lastSeen', E2E, () => {
  const h = home();
  const a = app();
  let r = hx(h, a, 'init');
  assert.equal(r.code, 0, r.out + r.err);
  let repos = reposOf(h);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].root, a);
  assert.equal(repos[0].repo, 'me/app');
  const first = repos[0].lastSeen;
  assert.ok(!Number.isNaN(Date.parse(first)), first);
  assert.deepEqual(tmpFiles(h), []);

  r = hx(h, a, 'run', '--dry-run');
  assert.equal(r.code, 0, r.out + r.err);
  repos = reposOf(h);
  assert.equal(repos.length, 1);
  assert.ok(repos[0].lastSeen > first, `${repos[0].lastSeen} > ${first}`);
  const second = repos[0].lastSeen;

  r = hx(h, a, 'run', '--dry-run');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(reposOf(h).length, 1);
  assert.ok(reposOf(h)[0].lastSeen > second);
  assert.deepEqual(tmpFiles(h), []);

  // hx run alone (no hx init under this home) records the repo too
  const h2 = home();
  r = hx(h2, a, 'run', '--dry-run');
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(reposOf(h2).map((x: any) => x.root), [a]);
});

test('an unparsable repos.json is left byte for byte by hx init and hx run, which still succeed', E2E, () => {
  const h = home();
  mkdirSync(path.join(h, '.hx'));
  const f = path.join(h, '.hx', 'repos.json');
  const bytes = '﻿{"repos": [ not json';
  writeFileSync(f, bytes);
  const a = app();
  let r = hx(h, a, 'init');
  assert.equal(r.code, 0, r.out + r.err);
  r = hx(h, a, 'run', '--dry-run');
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(readFileSync(f, 'utf8'), bytes);
  writeFileSync(f, '{"other": 1}');
  assert.equal(hx(h, a, 'run', '--dry-run').code, 0);
  assert.equal(readFileSync(f, 'utf8'), '{"other": 1}');
});

test('a read-only repos.json or an unusable .hx dir does not stop hx run', E2E, () => {
  const a = app();
  const h = home();
  assert.equal(hx(h, a, 'init').code, 0);
  const f = path.join(h, '.hx', 'repos.json');
  chmodSync(f, 0o444);
  try {
    const r = hx(h, a, 'run', '--dry-run');
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(tmpFiles(h), []);
  } finally { chmodSync(f, 0o644); }

  const h2 = home();
  writeFileSync(path.join(h2, '.hx'), 'a file where the .hx dir should be');
  const r = hx(h2, a, 'run', '--dry-run');
  assert.equal(r.code, 0, r.out + r.err);
});

test('hx fleet forget <root> and <subdir> remove the entry, print forgot <root>, leave fleet.json byte for byte', E2E, () => {
  const h = home();
  const a = app(), b = app();
  mkdirSync(path.join(a, 'src'));
  assert.equal(hx(h, a, 'init').code, 0);
  assert.equal(hx(h, b, 'init').code, 0);
  assert.equal(reposOf(h).length, 2);
  const fleetJson = path.join(h, '.hx', 'fleet.json');
  writeFileSync(fleetJson, '{ "repos": [], "workers": 3 }');

  let r = hx(h, tmp, 'fleet', 'forget', path.join(a, 'src'));
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.trim(), `forgot ${a}`);
  assert.deepEqual(reposOf(h).map((x: any) => x.root), [b]);

  r = hx(h, tmp, 'fleet', 'forget', b);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.trim(), `forgot ${b}`);
  assert.deepEqual(reposOf(h), []);
  assert.equal(readFileSync(fleetJson, 'utf8'), '{ "repos": [], "workers": 3 }');
  assert.deepEqual(tmpFiles(h), []);
});

test('hx fleet forget a root that is also in the fleet: the note is printed, fleet.json unchanged', E2E, () => {
  const h = home();
  const a = app();
  assert.equal(hx(h, a, 'init').code, 0);
  assert.equal(hx(h, a, 'fleet', 'add').code, 0);
  const fleetJson = path.join(h, '.hx', 'fleet.json');
  const before = readFileSync(fleetJson, 'utf8');
  const r = hx(h, tmp, 'fleet', 'forget', a);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^forgot ${a.replace(/[\\.]/g, '\\$&')}`));
  assert.match(r.out, /stays listed while it is in the fleet \(hx fleet remove .+ to drop it\)/);
  assert.equal(readFileSync(fleetJson, 'utf8'), before);
  assert.deepEqual(reposOf(h), []);
});

test('hx fleet forget: a path not listed exits 1 on stderr; an unusable repos.json too; no argument exits 2', E2E, () => {
  const h = home();
  const a = app();
  const other = path.join(tmp, `other${++n}`);
  mkdirSync(other);
  let r = hx(h, tmp, 'fleet', 'forget', other);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `not in repos.json: ${other}`);
  assert.equal(hx(h, a, 'init').code, 0);
  r = hx(h, tmp, 'fleet', 'forget', other);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `not in repos.json: ${other}`);
  assert.equal(reposOf(h).length, 1);

  writeFileSync(path.join(h, '.hx', 'repos.json'), '{bad');
  r = hx(h, tmp, 'fleet', 'forget', a);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), `not in repos.json: ${a}`);
  assert.equal(readFileSync(path.join(h, '.hx', 'repos.json'), 'utf8'), '{bad');

  r = hx(h, tmp, 'fleet', 'forget');
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: hx fleet forget <path>/);
  r = hx(h, tmp, 'fleet', 'nope');
  assert.match(r.err, /\| forget <path> \|/);
});

test('hx help lists fleet forget next to fleet remove', E2E, () => {
  const r = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /fleet remove <path>[^\n]*\n\s+fleet forget <path>/);
});
