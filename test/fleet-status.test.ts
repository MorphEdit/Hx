// hx fleet status (#116): every listed repo's hx status under its header, then the slots in use and the shared hold.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { slotsInUse, writeFleet } from '../src/fleet.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-fstat-'));
let n = 0;
const dir = (name: string) => { const d = path.join(tmp, `${name}${n++}`); mkdirSync(d, { recursive: true }); return d; };

function repo(name: string): string {
  const r = dir(name);
  saveConfig(path.join(r, '.hx'), { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') });
  return r;
}
const issue = (number: number, repo: string) => ({ number, title: `task ${number} of ${repo}`, body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready], repo });

function setup(extra: object = {}) {
  const home = dir('home');
  const a = repo('alpha'), b = repo('beta');
  const before = process.env.HX_HOME;
  process.env.HX_HOME = home;
  try { writeFleet({ repos: [{ root: a }, { root: b }], workers: 3 }); } finally {
    if (before === undefined) delete process.env.HX_HOME; else process.env.HX_HOME = before;
  }
  const board = path.join(home, 'board.json');
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: [issue(1, 'me/alpha'), issue(2, 'me/beta')], ...extra }));
  const slots = path.join(home, '.hx', 'fleet', 'slots');
  mkdirSync(slots, { recursive: true });
  return { home, a, b, board, slots, fleetDir: path.join(home, '.hx', 'fleet') };
}
function hx(s: ReturnType<typeof setup>, args: string[], cwd = tmp) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, HX_HOME: s.home, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: s.board } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// a pid no process has (a just-exited child's pid can be reused at once on a busy machine)
const DEAD_PID = 2147483644;

test('hx fleet status prints each repo under its header, followed by that repo\'s hx status', E2E, () => {
  const s = setup();
  const r = hx(s, ['fleet', 'status']);
  assert.equal(r.code, 0, r.out + r.err);
  const ia = r.out.indexOf(`== me/alpha (${s.a})`), ib = r.out.indexOf(`== me/beta (${s.b})`);
  assert.ok(ia >= 0 && ib > ia, r.out);
  const partA = r.out.slice(ia, ib), partB = r.out.slice(ib);
  assert.match(partA, /me\/alpha — 0 open PRD\(s\), 1 open 'ready-for-agent' issue\(s\)/);
  assert.match(partA, /task 1 of me\/alpha/);
  assert.doesNotMatch(partA, /task 2/);
  assert.match(partB, /me\/beta — 0 open PRD\(s\), 1 open 'ready-for-agent' issue\(s\)/);
  assert.match(partB, /task 2 of me\/beta/);
  // each part is exactly what hx status prints in that repo
  const single = hx(s, ['status'], s.a);
  assert.equal(single.code, 0, single.out + single.err);
  assert.ok(partA.includes(single.out), `${partA}\n---\n${single.out}`);
  assert.match(r.out, /fleet\s+0\/3 slot\(s\) in use\s*$/);
});

test('a repo whose board read fails shows its error; the other repo and the fleet line still print; exit is non-zero', E2E, () => {
  const s = setup({ listFails: 'me/alpha' });
  const r = hx(s, ['fleet', 'status']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /HTTP 502: Bad Gateway/);
  assert.match(r.out, new RegExp(`== me/alpha`));
  assert.match(r.out, /task 2 of me\/beta/);
  assert.match(r.out, /fleet\s+0\/3 slot\(s\) in use/);
});

test('a failing trusted lookup is shown per repo and the rest still prints', E2E, () => {
  const s = setup({ loginFails: true });
  const r = hx(s, ['fleet', 'status']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /could not look up the gh login/);
  assert.ok(r.out.includes(`== me/beta (${s.b})`), r.out);
  assert.match(r.out, /fleet\s+0\/3/);
});

test('a missing root prints its header and missing', E2E, () => {
  const s = setup();
  const gone = path.join(tmp, `gone${n++}`);
  const before = process.env.HX_HOME;
  process.env.HX_HOME = s.home;
  try { writeFleet({ repos: [{ root: gone }, { root: s.b }] }); } finally {
    if (before === undefined) delete process.env.HX_HOME; else process.env.HX_HOME = before;
  }
  const r = hx(s, ['fleet', 'status']);
  assert.match(r.out.split(`== ? (${gone})`)[1] ?? '', /^\r?\nmissing/, r.out);
  assert.match(r.out, /task 2 of me\/beta/);
  assert.match(r.out, /fleet\s+0\/2 slot\(s\) in use/, 'cap defaults to 2');
});

test('the fleet line counts live slot files only, and shows a future hold but not an expired one', E2E, () => {
  const s = setup();
  writeFileSync(path.join(s.slots, '0.json'), JSON.stringify({ pid: process.pid, repo: 'me/alpha', issue: 1 }));
  writeFileSync(path.join(s.slots, '1.json'), JSON.stringify({ pid: DEAD_PID, repo: 'me/beta', issue: 2 }));
  writeFileSync(path.join(s.slots, '2.json'), '{"pid":');
  assert.equal(slotsInUse(s.fleetDir), 1);
  const until = Date.now() + 3_600_000;
  writeFileSync(path.join(s.fleetDir, 'hold.json'), JSON.stringify({ until, reason: 'usage 95%', repo: 'me/alpha' }));
  const r = hx(s, ['fleet', 'status']);
  assert.equal(r.code, 0, r.out + r.err);
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('fleet'))!;
  assert.match(line, /1\/3 slot\(s\) in use · hold until .+ \(usage 95%, me\/alpha\)/);
  assert.ok(line.includes(new Date(until).toLocaleString()), line);

  writeFileSync(path.join(s.fleetDir, 'hold.json'), JSON.stringify({ until: Date.now() - 1000, reason: 'old', repo: 'me/beta' }));
  const later = hx(s, ['fleet', 'status']);
  const line2 = later.out.split(/\r?\n/).find((l) => l.startsWith('fleet'))!;
  assert.match(line2, /^fleet\s+1\/3 slot\(s\) in use$/);
});

test('slotsInUse is 0 without a slots dir', E2E, () => {
  assert.equal(slotsInUse(path.join(tmp, 'nowhere')), 0);
});

test('hx help lists fleet status', E2E, () => {
  const r = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /fleet status/);
});
