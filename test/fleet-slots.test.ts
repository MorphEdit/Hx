// One worker cap shared by every runner: file slots under HX_FLEET_DIR (#113). Unit tests of the slot helpers,
// a race between two processes, and two real `hx run` children (fake gh and claude) sharing one slot.
import { E2E, deadPid } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { acquireSlot, releaseSlot, slotsDir } from '../src/fleet.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-slots-'));
let n = 0;
const fresh = () => { const d = path.join(tmp, `f${n++}`); mkdirSync(d); return d; };
const me = { pid: process.pid, repo: 'me/a', issue: 1 };
const slot = (d: string, k: number) => path.join(slotsDir(d), `${k}.json`);
const old = (f: string, secs: number) => { const t = new Date(Date.now() - secs * 1000); utimesSync(f, t, t); };

test('cap 2: two acquisitions succeed, the third fails; a release frees one', E2E, () => {
  const d = fresh();
  assert.equal(acquireSlot(d, 2, me), 0);
  assert.equal(acquireSlot(d, 2, { ...me, issue: 2 }), 1);
  assert.equal(acquireSlot(d, 2, { ...me, issue: 3 }), null);
  const held = JSON.parse(readFileSync(slot(d, 1), 'utf8'));
  assert.equal(held.pid, process.pid); assert.equal(held.repo, 'me/a'); assert.equal(held.issue, 2);
  assert.ok(!Number.isNaN(Date.parse(held.since)));
  releaseSlot(d, 0);
  assert.ok(!existsSync(slot(d, 0)));
  assert.equal(acquireSlot(d, 2, { ...me, issue: 3 }), 0);
  assert.equal(JSON.parse(readFileSync(slot(d, 0), 'utf8')).issue, 3);
});

test('a slot whose pid is dead is taken over', E2E, () => {
  const d = fresh();
  mkdirSync(slotsDir(d));
  writeFileSync(slot(d, 0), JSON.stringify({ pid: deadPid(), repo: 'x', issue: 9, since: '' }));
  assert.equal(acquireSlot(d, 1, me), 0);
  assert.equal(JSON.parse(readFileSync(slot(d, 0), 'utf8')).pid, process.pid);
  assert.deepEqual(readdirSync(slotsDir(d)), ['0.json']); // the takeover marker is gone
});

test('an unparsable slot younger than 10 s is held; an older one is taken over', E2E, () => {
  const d = fresh();
  mkdirSync(slotsDir(d));
  writeFileSync(slot(d, 0), '{"pid":');
  assert.equal(acquireSlot(d, 1, me), null);
  assert.equal(readFileSync(slot(d, 0), 'utf8'), '{"pid":');
  old(slot(d, 0), 11);
  assert.equal(acquireSlot(d, 1, me), 0);
  assert.equal(JSON.parse(readFileSync(slot(d, 0), 'utf8')).pid, process.pid);
});

test('a takeover marker older than 60 s is removed and its slot taken over; a young one blocks the takeover', E2E, () => {
  const d = fresh();
  mkdirSync(slotsDir(d));
  const dead = deadPid();
  writeFileSync(slot(d, 0), JSON.stringify({ pid: dead, repo: 'x', issue: 9, since: '' }));
  const marker = path.join(slotsDir(d), `0.${dead}.takeover`);
  writeFileSync(marker, '');
  assert.equal(acquireSlot(d, 1, me), null); // someone else is taking it over
  assert.equal(JSON.parse(readFileSync(slot(d, 0), 'utf8')).pid, dead);
  old(marker, 61);
  assert.equal(acquireSlot(d, 1, me), 0);
  assert.ok(!existsSync(marker));
  assert.equal(JSON.parse(readFileSync(slot(d, 0), 'utf8')).pid, process.pid);
});

test('a slot file at k >= cap does not block acquisition; a live holder is never taken over', E2E, () => {
  const d = fresh();
  mkdirSync(slotsDir(d));
  writeFileSync(slot(d, 1), JSON.stringify({ pid: deadPid(), repo: 'x', issue: 9, since: '' }));
  writeFileSync(slot(d, 5), JSON.stringify({ pid: process.pid, repo: 'x', issue: 9, since: '' }));
  assert.equal(acquireSlot(d, 1, me), 0);
  assert.equal(acquireSlot(d, 1, me), null);
  assert.equal(JSON.parse(readFileSync(slot(d, 5), 'utf8')).repo, 'x');
});

test('race: two processes taking over two stale slots never share one', E2E, async () => {
  const child = path.join(tmp, 'racer.mjs');
  writeFileSync(child, `
import { existsSync } from 'node:fs';
const { acquireSlot } = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'src', 'fleet.ts')).href)});
const [dir, go] = process.argv.slice(2);
while (!existsSync(go)) await new Promise((r) => setTimeout(r, 2));
const got = [];
for (let i = 0; i < 2; i++) { const k = acquireSlot(dir, 2, { pid: process.pid, repo: 'r', issue: i }); if (k !== null) got.push(k); }
process.stdout.write(JSON.stringify(got) + '\\n');
process.stdin.resume(); // hold the slots (a live pid) until the test has checked them
`);
  for (let round = 0; round < 6; round++) {
    const d = fresh();
    mkdirSync(slotsDir(d));
    for (const k of [0, 1]) writeFileSync(slot(d, k), JSON.stringify({ pid: deadPid(), repo: 'x', issue: k, since: '' }));
    const go = path.join(d, 'go');
    const kids = [0, 1].map(() => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child, d, go], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      const line = new Promise<number[]>((res, rej) => {
        p.stdout.on('data', (b) => { out += b; if (out.includes('\n')) res(JSON.parse(out)); });
        p.on('exit', (c) => rej(new Error(`racer exited ${c}`)));
      });
      return { p, line, exited: new Promise((r) => p.on('exit', r)) };
    });
    await new Promise((r) => setTimeout(r, 300)); // both started and waiting
    writeFileSync(go, '');
    try {
      const got = await Promise.all(kids.map((k) => k.line));
      const all = got.flat();
      assert.ok(all.length <= 2, JSON.stringify(got));
      assert.equal(new Set(all).size, all.length, `round ${round}: a slot reported twice ${JSON.stringify(got)}`);
      got.forEach((ks, i) => { for (const k of ks) assert.equal(JSON.parse(readFileSync(slot(d, k), 'utf8')).pid, kids[i].p.pid); });
    } finally {
      for (const k of kids) k.p.stdin.end();
      await Promise.all(kids.map((k) => k.exited));
    }
  }
});

// two repos, each with its own origin, board and fake session dir
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function repo(name: string, issues: number[]) {
  const base = path.join(tmp, name);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'app');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(base, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false });
  const board = path.join(base, 'board.json');
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: issues.map((number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] })) }));
  const fake = path.join(base, 'sessions');
  mkdirSync(fake);
  return { root, board, fake };
}
function hxRun(r: ReturnType<typeof repo>, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const p = spawn(process.execPath, [HX, 'run', '--workers', '1'], { cwd: r.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'), HX_FAKE_STATE: r.board, HX_FAKE_DIR: r.fake, ...env } });
  let out = '';
  p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
  return new Promise((res) => p.on('close', (code) => res({ code, out })));
}
const closed = (board: string) => JSON.parse(readFileSync(board, 'utf8')).issues.filter((i: any) => i.state === 'CLOSED').map((i: any) => i.number).sort();

test('two hx run children with HX_FLEET_WORKERS=1 build both boards one session at a time', E2E, async () => {
  const fleet = path.join(tmp, 'fleet');
  const times = path.join(tmp, 'times.jsonl');
  const env = { HX_FLEET_DIR: fleet, HX_FLEET_WORKERS: '1', HX_HOME: path.join(tmp, 'home'), FAKE_CLAUDE_TIMES: times, FAKE_CLAUDE_DELAY_MS: '300' };
  const a = repo('a', [1, 2]), b = repo('b', [1, 2]);
  const [ra, rb] = await Promise.all([hxRun(a, env), hxRun(b, env)]);
  assert.equal(ra.code, 0, ra.out); assert.equal(rb.code, 0, rb.out);
  assert.deepEqual(closed(a.board), [1, 2], ra.out);
  assert.deepEqual(closed(b.board), [1, 2], rb.out);
  // a session spans its turns: the first start to the last end of one session id
  const spans = new Map<string, { start: number; end: number }>();
  for (const l of readFileSync(times, 'utf8').trim().split('\n')) {
    const t = JSON.parse(l);
    const s = spans.get(t.sid);
    spans.set(t.sid, s ? { start: Math.min(s.start, t.start), end: Math.max(s.end, t.end) } : { start: t.start, end: t.end });
  }
  const sorted = [...spans.values()].sort((x, y) => x.start - y.start);
  assert.equal(sorted.length, 4);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, `sessions overlap: ${JSON.stringify(sorted)}`);
  assert.deepEqual(readdirSync(slotsDir(fleet)), []); // every slot handed back
});

test('hx run without HX_FLEET_DIR creates no slot files', E2E, async () => {
  const home = path.join(tmp, 'home-solo');
  const r = repo('solo', [1]);
  const res = await hxRun(r, { HX_HOME: home });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(closed(r.board), [1]);
  const found: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.name === 'slots') found.push(f);
    if (e.isDirectory()) walk(f);
  } };
  walk(home); walk(r.root);
  assert.deepEqual(found, []);
  rmSync(home, { recursive: true, force: true });
});
