// hx fleet run: one hx run child per fleet repo, output prefixed with the repo, Ctrl+C forwarded over IPC (#115).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { startFleetRun, writeFleet } from '../src/fleet.ts';
import { writeLive } from '../src/runstate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const ENTRY = path.join(here, 'fakes', 'entry.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-frun-'));
let n = 0;

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
/** A repo with its own origin, board (one ready issue per number) and fake session dir. */
function repo(name: string, issues: number[] = []) {
  const base = path.join(tmp, `${name}${n++}`);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'app');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(base, 'wt'),
    claudeBin: CLAUDE, maxIterations: 3, pollSeconds: 1, audit: false });
  const board = path.join(base, 'board.json');
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: issues.map((number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] })) }));
  const fake = path.join(base, 'sessions');
  mkdirSync(fake);
  return { root, board, fake, name: `me/${name}` };
}
/** A plain hx repo (config only, no git) for the fake entry. */
function plain(name: string) {
  const root = path.join(tmp, `${name}${n++}`);
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') });
  return root;
}
function home(fleet: Parameters<typeof writeFleet>[0]): string {
  const h = path.join(tmp, `home${n++}`);
  mkdirSync(h);
  process.env.HX_HOME = h;
  writeFleet(fleet);
  return h;
}
// The fleet gives every child one environment, so the fake gh and claude find their repo's board from their cwd
// (the repo root or one of its worktrees, both under the repo's base dir, next to board.json).
function router(fake: string): string {
  const f = path.join(tmp, `route-${fake}`);
  writeFileSync(f, `import { existsSync } from 'node:fs';
import path from 'node:path';\n` +
    `let d = process.cwd();
while (!existsSync(path.join(d, 'board.json')) && path.dirname(d) !== d) d = path.dirname(d);\n` +
    `process.env.HX_FAKE_STATE = path.join(d, 'board.json'); process.env.HX_FAKE_DIR = path.join(d, 'sessions');\n` +
    `await import(${JSON.stringify(pathToFileURL(path.join(here, 'fakes', fake)).href)});\n`);
  return f;
}
const GH = router('gh.mjs'), CLAUDE = router('claude.mjs');
const FAKES = { HX_GH_BIN: GH, HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs') };
const closed = (board: string) => JSON.parse(readFileSync(board, 'utf8')).issues.filter((i: any) => i.state === 'CLOSED').map((i: any) => i.number);

test('hx fleet run: every output line carries the [owner/name] prefix of its repo', E2E, async () => {
  const a = repo('a', [1]), b = repo('b', [2]);
  const h = home({ repos: [{ root: a.root }, { root: b.root }] });
  const p = spawn(process.execPath, [HX, 'fleet', 'run'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...FAKES, HX_HOME: h } });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 0, out);
  assert.deepEqual(closed(a.board), [1], out);
  assert.deepEqual(closed(b.board), [2], out);
  const lines = out.split(/\r?\n/).filter(Boolean);
  for (const l of lines) assert.ok(l.startsWith(`[${a.name}] `) || l.startsWith(`[${b.name}] `), l);
  const of = (r: { name: string }) => lines.filter((l) => l.startsWith(`[${r.name}] `)).join('\n');
  assert.match(of(a), /#1\b/); assert.doesNotMatch(of(a), /#2\b/);
  assert.match(of(b), /#2\b/); assert.doesNotMatch(of(b), /#1\b/);
});

test('interrupt(): both children checkpoint their running sessions and exit; done resolves to the highest exit code', E2E, async () => {
  const a = repo('a', [1]), b = repo('b', [2]);
  home({ repos: [{ root: a.root }, { root: b.root }] });
  const lines: string[] = [];
  const run = startFleetRun({ entry: HX, env: { ...FAKES, FAKE_CLAUDE_DELAY_MS: '120000' }, print: (l) => lines.push(l) });
  const started = (r: { fake: string }) => readdirSync(r.fake).some((f) => f.endsWith('.prompt-1.txt'));
  const deadline = Date.now() + 120_000;
  while (!(started(a) && started(b))) {
    assert.ok(Date.now() < deadline, lines.join('\n'));
    await new Promise((r) => setTimeout(r, 100));
  }
  run.interrupt();
  const code = await run.done;
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(lines.filter((l) => l === 'Ctrl+C — asking every repo to checkpoint').length, 1);
  for (const r of [a, b]) {
    assert.ok(lines.some((l) => l.startsWith(`[${r.name}] `) && l.includes('Ctrl+C — checkpointing running sessions')), lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith(`[${r.name}] `) && /checkpoint saved/.test(l)), lines.join('\n'));
    assert.deepEqual(closed(r.board), []);
  }
});

test('done is the highest child exit code; a later interrupt() says force quit; output is line-buffered with a partial line flushed', E2E, async () => {
  const a = plain('a'), b = plain('b'), c = plain('c');
  writeFileSync(path.join(a, 'exit-code'), '3');
  writeFileSync(path.join(b, 'exit-code'), '5');
  home({ repos: [{ root: a }, { root: b }, { root: c }] });
  const lines: string[] = [];
  const run = startFleetRun({ entry: ENTRY, print: (l) => lines.push(l) });
  run.interrupt(); run.interrupt(); run.interrupt();
  assert.equal(await run.done, 5);
  assert.deepEqual(lines.filter((l) => l.startsWith('Ctrl+C')), ['Ctrl+C — asking every repo to checkpoint',
    'Ctrl+C again — force quit sent to every repo', 'Ctrl+C again — force quit sent to every repo']);
  for (const name of ['me/a', 'me/b', 'me/c'])
    assert.deepEqual(lines.filter((l) => l.startsWith(`[${name}] `)).sort(), [`[${name}] hello`, `[${name}] oops`, `[${name}] world`], lines.join('\n'));
});

test('skips: a live runner (live.json with a live pid) and a missing root; with nothing started done is 0', E2E, async () => {
  const live = plain('busy');
  writeLive(path.join(live, '.hx'), { pid: process.ppid, startedAt: new Date().toISOString(), repo: 'me/busy', workers: 1, sessions: [] });
  const gone = path.join(tmp, `gone${n++}`);
  home({ repos: [{ root: live }, { root: gone }] });
  const lines: string[] = [];
  const run = startFleetRun({ entry: ENTRY, print: (l) => lines.push(l) });
  assert.equal(await run.done, 0);
  assert.deepEqual(lines, [`[me/busy] skipped: hx is already running (pid ${process.ppid})`, `[${gone}] skipped: missing`]);
  assert.ok(!existsSync(path.join(live, 'entry.json')));
  run.interrupt(); // nothing to send to
  home({ repos: [] });
  assert.equal(await startFleetRun({ entry: ENTRY, print: () => {} }).done, 0);
});

test('children get HX_FLEET_DIR, HX_FLEET_WORKERS and --workers <cap> (fleet.json workers, else 2; --workers overrides), an IPC channel, cwd = root', E2E, async () => {
  const entry = (root: string) => JSON.parse(readFileSync(path.join(root, 'entry.json'), 'utf8'));
  const a = plain('a');
  let h = home({ repos: [{ root: a }] });
  await startFleetRun({ entry: ENTRY, print: () => {} }).done;
  assert.deepEqual(entry(a), { args: ['run', '--workers', '2'], cwd: a, HX_FLEET_DIR: path.join(h, '.hx', 'fleet'), HX_FLEET_WORKERS: '2', ipc: true });
  h = home({ repos: [{ root: a }], workers: 3 });
  await startFleetRun({ entry: ENTRY, watch: true, print: () => {} }).done;
  assert.deepEqual(entry(a), { args: ['run', '--workers', '3', '--watch'], cwd: a, HX_FLEET_DIR: path.join(h, '.hx', 'fleet'), HX_FLEET_WORKERS: '3', ipc: true });
  await startFleetRun({ entry: ENTRY, workers: 7, print: () => {} }).done;
  assert.equal(entry(a).HX_FLEET_WORKERS, '7');
  assert.deepEqual(entry(a).args, ['run', '--workers', '7']);
});

test('hx help lists fleet run', E2E, () => {
  const r = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /fleet run \[--workers N\] \[--watch\]/);
});
