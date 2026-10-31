// The shared usage hold under HX_FLEET_DIR (#114): unit tests of the hold.json helpers, and two real `hx run`
// children (fake gh and claude) where repo A's rate-limit event holds repo B's claims.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { holdFile, readHold, writeHold } from '../src/fleet.ts';
import { readLive } from '../src/runstate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-hold-'));
let n = 0;
const fresh = () => { const d = path.join(tmp, `f${n++}`); mkdirSync(d); return d; };
const onDisk = (d: string) => JSON.parse(readFileSync(holdFile(d), 'utf8'));

test('writeHold writes a hold; readHold reads it back while it is in force', E2E, () => {
  const d = fresh();
  const until = Date.now() + 60_000;
  assert.equal(writeHold(d, { until, reason: 'usage 95%', repo: 'me/a' }), true);
  assert.deepEqual(onDisk(d), { until, reason: 'usage 95%', repo: 'me/a' });
  assert.deepEqual(readHold(d), { until, reason: 'usage 95%', repo: 'me/a' });
});

test('writeHold keeps a later existing until, and replaces an earlier one', E2E, () => {
  const d = fresh();
  const later = Date.now() + 120_000;
  writeHold(d, { until: later, reason: 'first', repo: 'me/a' });
  assert.equal(writeHold(d, { until: later - 60_000, reason: 'second', repo: 'me/b' }), false);
  assert.deepEqual(onDisk(d), { until: later, reason: 'first', repo: 'me/a' });
  assert.equal(writeHold(d, { until: later + 60_000, reason: 'third', repo: 'me/c' }), true);
  assert.deepEqual(onDisk(d), { until: later + 60_000, reason: 'third', repo: 'me/c' });
});

test('an expired, missing or unparsable hold.json reads as no hold', E2E, () => {
  const d = fresh();
  assert.equal(readHold(d), null); // missing
  writeFileSync(holdFile(d), JSON.stringify({ until: Date.now() - 1000, reason: 'old', repo: 'me/a' }));
  assert.equal(readHold(d), null); // expired
  writeFileSync(holdFile(d), '{"until":');
  assert.equal(readHold(d), null); // unparsable
  writeFileSync(holdFile(d), JSON.stringify({ until: 'soon', reason: 'x', repo: 'me/a' }));
  assert.equal(readHold(d), null); // no numeric until
  // an unparsable file does not block a write
  writeFileSync(holdFile(d), '{"until":');
  const until = Date.now() + 60_000;
  assert.equal(writeHold(d, { until, reason: 'r', repo: 'me/a' }), true);
  assert.equal(readHold(d)?.until, until);
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
  return { base, root, board, fake };
}
function hxRun(r: ReturnType<typeof repo>, env: Record<string, string>) {
  const p = spawn(process.execPath, [HX, 'run', '--workers', '1'], { cwd: r.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'), HX_FAKE_STATE: r.board, HX_FAKE_DIR: r.fake, ...env } });
  let out = '';
  p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
  const done = new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out })));
  return { done, running: () => p.exitCode === null };
}
const closed = (board: string) => JSON.parse(readFileSync(board, 'utf8')).issues.filter((i: any) => i.state === 'CLOSED').map((i: any) => i.number).sort();
const tick = () => new Promise((r) => setTimeout(r, 50));

test('a rate-limit event in repo A writes hold.json; repo B copies the hold and claims nothing until it expires', E2E, async () => {
  const fleet = path.join(tmp, 'fleet');
  const timesB = path.join(tmp, 'times-b.jsonl');
  const env = { HX_FLEET_DIR: fleet, HX_HOME: path.join(tmp, 'home') };
  const a = repo('a', [1]), b = repo('b', [1]);
  const ra = hxRun(a, { ...env, FAKE_CLAUDE_RATE: '0.95', FAKE_CLAUDE_RESET_S: '8' });
  while (!existsSync(holdFile(fleet))) { if (!ra.running()) assert.fail((await ra.done).out); await tick(); }
  await tick(); // the rename is atomic, but let A finish logging
  const hold = onDisk(fleet);
  assert.equal(hold.repo, 'me/a');
  assert.match(hold.reason, /usage 95%/);
  assert.ok(hold.until > Date.now(), 'the hold is still in force when B starts');

  const rb = hxRun(b, { ...env, FAKE_CLAUDE_TIMES: timesB });
  let seen: { pausedUntil?: number; pauseReason?: string } | undefined;
  while (rb.running()) {
    const l = readLive(path.join(b.root, '.hx'));
    if (l?.pauseReason && !seen) seen = { pausedUntil: l.pausedUntil, pauseReason: l.pauseReason };
    await tick();
  }
  const [resA, resB] = await Promise.all([ra.done, rb.done]);
  assert.equal(resA.code, 0, resA.out); assert.equal(resB.code, 0, resB.out);
  assert.deepEqual(closed(a.board), [1], resA.out);
  assert.deepEqual(closed(b.board), [1], resB.out);
  assert.ok(seen, `B's live.json never showed a hold\n${resB.out}`);
  assert.equal(seen.pausedUntil, hold.until);
  assert.ok(seen.pauseReason!.startsWith('shared hold from me/a'), seen.pauseReason);
  assert.match(resB.out, /shared hold from me\/a: usage 95%/);
  // B's first session started only once the hold had expired
  const starts = readFileSync(timesB, 'utf8').trim().split('\n').map((l) => JSON.parse(l).start);
  assert.ok(Math.min(...starts) >= hold.until, `B claimed during the hold: ${Math.min(...starts)} < ${hold.until}`);
  assert.deepEqual(onDisk(fleet), hold); // B never rewrote it
});

test('hx run without HX_FLEET_DIR creates no hold.json, even after a usage hold of its own', E2E, async () => {
  const home = path.join(tmp, 'home-solo');
  const r = repo('solo', [1]);
  const res = await hxRun(r, { HX_HOME: home, FAKE_CLAUDE_RATE: '0.95', FAKE_CLAUDE_RESET_S: '1' }).done;
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(closed(r.board), [1]);
  assert.match(res.out, /usage 95%/); // the runner did set a hold
  const found: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.name === 'hold.json') found.push(f);
    if (e.isDirectory()) walk(f);
  } };
  walk(home); walk(r.base);
  assert.deepEqual(found, []);
  rmSync(home, { recursive: true, force: true });
});
