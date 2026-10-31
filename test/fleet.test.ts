// The fleet list: fleet.json under HX_HOME and hx fleet add/remove/list/workers (the real CLI, HX_HOME a temp dir).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { addRepo, fleetDir, fleetFile, fleetWorkers, hxHome, readFleet, removeRepo, sameRoot, writeFleet } from '../src/fleet.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-fleet-'));

let n = 0;
function home(): string {
  const h = path.join(tmp, `home${n++}`);
  mkdirSync(h);
  return h;
}
function repo(name: string): string {
  const r = path.join(tmp, `${name}${n++}`);
  saveConfig(path.join(r, '.hx'), { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') });
  return r;
}
function hx(h: string, args: string[], cwd = tmp) {
  const r = spawnSync(process.execPath, [HX, 'fleet', ...args], { cwd, encoding: 'utf8', env: { ...process.env, HX_HOME: h } });
  return { code: r.status, out: r.stdout + r.stderr };
}
const fleetOf = (h: string) => JSON.parse(readFileSync(path.join(h, '.hx', 'fleet.json'), 'utf8'));

test('HX_HOME decides the fleet file and fleetDir; the real home otherwise', () => {
  const before = process.env.HX_HOME;
  try {
    process.env.HX_HOME = path.join(tmp, 'x');
    assert.equal(hxHome(), path.join(tmp, 'x'));
    assert.equal(fleetFile(), path.join(tmp, 'x', '.hx', 'fleet.json'));
    assert.equal(fleetDir(), path.join(tmp, 'x', '.hx', 'fleet'));
    delete process.env.HX_HOME;
    assert.equal(hxHome(), os.homedir());
  } finally {
    if (before === undefined) delete process.env.HX_HOME; else process.env.HX_HOME = before;
  }
});

test('pure helpers: add is a no-op for the same root (case-insensitive on Windows), remove drops it, workers default 2', () => {
  const a = addRepo({ repos: [] }, path.join(tmp, 'A'));
  assert.equal(addRepo(a, path.join(tmp, 'A') + path.sep).repos.length, 1);
  if (process.platform === 'win32') {
    assert.ok(sameRoot(path.join(tmp, 'A'), path.join(tmp, 'a').toUpperCase()));
    assert.equal(addRepo(a, path.join(tmp, 'a').toUpperCase()).repos.length, 1);
  }
  assert.deepEqual(removeRepo(a, path.join(tmp, 'A')).repos, []);
  assert.equal(fleetWorkers({ repos: [] }), 2);
  assert.equal(fleetWorkers({ repos: [], workers: 5 }), 5);
});

test('readFleet / writeFleet round-trip under HX_HOME; no file reads as an empty fleet', () => {
  const before = process.env.HX_HOME;
  try {
    process.env.HX_HOME = home();
    assert.deepEqual(readFleet(), { repos: [] });
    writeFleet({ repos: [{ root: 'R' }], workers: 3 });
    assert.deepEqual(readFleet(), { repos: [{ root: 'R' }], workers: 3 });
    assert.ok(existsSync(path.join(process.env.HX_HOME, '.hx', 'fleet.json')));
  } finally {
    if (before === undefined) delete process.env.HX_HOME; else process.env.HX_HOME = before;
  }
});

test('hx fleet add writes fleet.json (from a subdirectory too); adding twice keeps one entry', E2E, () => {
  const h = home();
  const r = repo('app');
  mkdirSync(path.join(r, 'src'));
  assert.equal(hx(h, ['add', path.join(r, 'src')]).code, 0);
  assert.deepEqual(fleetOf(h).repos, [{ root: r }]);
  const again = hx(h, ['add'], r);
  assert.equal(again.code, 0, again.out);
  const differentCase = hx(h, ['add', process.platform === 'win32' ? r.toUpperCase() : r]);
  assert.equal(differentCase.code, 0, differentCase.out);
  assert.deepEqual(fleetOf(h).repos, [{ root: r }]);
});

test('hx fleet add refuses a directory without .hx/config.json and leaves fleet.json unchanged', E2E, () => {
  const h = home();
  const r = repo('app');
  hx(h, ['add', r]);
  const before = readFileSync(path.join(h, '.hx', 'fleet.json'), 'utf8');
  const bare = path.join(tmp, `bare${n++}`);
  mkdirSync(bare);
  const res = hx(h, ['add', bare]);
  assert.notEqual(res.code, 0);
  assert.match(res.out, /run hx init there first/);
  assert.equal(readFileSync(path.join(h, '.hx', 'fleet.json'), 'utf8'), before);

  const h2 = home();
  assert.match(hx(h2, ['add', bare]).out, /run hx init there first/);
  assert.equal(existsSync(path.join(h2, '.hx', 'fleet.json')), false);
});

test('hx fleet remove removes the root and leaves its .hx/ intact', E2E, () => {
  const h = home();
  const a = repo('a'), b = repo('b');
  hx(h, ['add', a]);
  hx(h, ['add', b]);
  const res = hx(h, ['remove', a]);
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(fleetOf(h).repos, [{ root: b }]);
  assert.ok(existsSync(path.join(a, '.hx', 'config.json')));
  assert.notEqual(hx(h, ['remove', a]).code, 0);
});

test('hx fleet list prints root, repo and existence; a deleted root is marked missing', E2E, () => {
  const h = home();
  const a = repo('alpha'), b = repo('beta');
  hx(h, ['add', a]);
  hx(h, ['add', b]);
  renameSync(b, b + '-gone');
  const res = hx(h, ['list']);
  assert.equal(res.code, 0, res.out);
  const lines = res.out.split(/\r?\n/);
  const la = lines.find((l) => l.startsWith(a + ' '))!;
  const lb = lines.find((l) => l.startsWith(b + ' '))!;
  assert.ok(la && la.includes('me/alpha') && !la.includes('missing'), res.out);
  assert.ok(lb && lb.includes('missing'), res.out);
});

test('hx fleet workers sets the cap; unset reads as 2; non-positive integers are refused', E2E, () => {
  const h = home();
  hx(h, ['add', repo('app')]);
  assert.equal(fleetOf(h).workers, undefined);
  assert.match(hx(h, ['list']).out, /workers: 2/);
  assert.equal(hx(h, ['workers', '4']).code, 0);
  assert.equal(fleetOf(h).workers, 4);
  assert.equal(fleetOf(h).repos.length, 1);
  assert.match(hx(h, ['list']).out, /workers: 4/);
  for (const bad of ['0', '-1', '1.5', 'x']) assert.notEqual(hx(h, ['workers', bad]).code, 0, bad);
  assert.equal(fleetOf(h).workers, 4);
});

test('hx help lists fleet', () => {
  const r = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /fleet add/);
  assert.match(r.stdout, /fleet workers/);
});
