// Rate-limited gh calls (#171, PRD #138 §C5): inside a real `hx run` a gh call that hits a rate limit waits and
// retries; everywhere else it fails at once as before. Real git, fake gh (`state.limitNext`) and fake claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hhmm, type GhBudget } from '../src/ghlimit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const GH = path.join(here, 'fakes', 'gh.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ghw-'));
process.env.HX_GH_BIN = GH;
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');

const gh = await import('../src/github.ts');
const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, labelSpecs, saveConfig } = await import('../src/config.ts');
const { githubHoldFile } = await import('../src/fleet.ts');

const T = 1_800_000_000; // epoch seconds
const MIN = 60_000;
const bud = (core: [number, number], graphql: [number, number]): GhBudget => ({
  core: { remaining: core[0], limit: 5000, reset: core[1] }, graphql: { remaining: graphql[0], limit: 5000, reset: graphql[1] }, at: '' });

test('limitWaitMs: secondary Retry-After or 60 s, doubled on repeats up to 15 min; primary the bucket at 0, else the later reset; no read 60 s', E2E, () => {
  const now = T * 1000;
  assert.equal(gh.limitWaitMs({ kind: 'secondary' }, null, 1, now), MIN);
  assert.equal(gh.limitWaitMs({ kind: 'secondary', retryAfter: 2 }, null, 1, now), 2000);
  assert.equal(gh.limitWaitMs({ kind: 'secondary' }, null, 2, now), 2 * MIN);
  assert.equal(gh.limitWaitMs({ kind: 'secondary' }, null, 3, now), 4 * MIN);
  assert.equal(gh.limitWaitMs({ kind: 'secondary' }, null, 4, now), 8 * MIN);
  assert.equal(gh.limitWaitMs({ kind: 'secondary' }, null, 5, now), 15 * MIN, 'capped');
  assert.equal(gh.limitWaitMs({ kind: 'secondary' }, null, 30, now), 15 * MIN, 'capped');
  assert.equal(gh.limitWaitMs({ kind: 'secondary', retryAfter: 2 }, null, 3, now), 8000);
  // primary: the bucket at 0 remaining, whichever resets first
  assert.equal(gh.limitWaitMs({ kind: 'primary' }, bud([0, T + 30], [4000, T + 300]), 0, now), 30_000);
  assert.equal(gh.limitWaitMs({ kind: 'primary' }, bud([4000, T + 300], [0, T + 30]), 0, now), 30_000);
  // none at 0 (or both): the later of the two resets
  assert.equal(gh.limitWaitMs({ kind: 'primary' }, bud([10, T + 30], [4000, T + 300]), 0, now), 300_000);
  assert.equal(gh.limitWaitMs({ kind: 'primary' }, bud([0, T + 30], [0, T + 90]), 0, now), 90_000);
  assert.equal(gh.limitWaitMs({ kind: 'primary' }, null, 0, now), MIN, 'the rate_limit read failed');
  assert.equal(gh.limitWaitMs({ kind: 'primary' }, bud([0, T - 5], [10, T - 5]), 0, now), 1000, 'a reset already past: 1 s');
});

// direct calls against the fake gh
function board(state: object): { file: string; log: string } {
  const d = mkdtempSync(path.join(tmp, 'b-'));
  const file = path.join(d, 'board.json');
  writeFileSync(file, JSON.stringify({ comments: [], prs: [], issues: [{ number: 1, title: 't', body: '', state: 'OPEN', labels: [] }], ...state }));
  const log = path.join(d, 'gh.log');
  Object.assign(process.env, { HX_FAKE_STATE: file, HX_FAKE_GH_LOG: log });
  return { file, log };
}
const calls = (log: string, what: string) => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.startsWith(what)).length;
async function withSignal<T>(signal: AbortSignal | undefined, fn: (heard: [number, string][]) => Promise<T>): Promise<T> {
  const heard: [number, string][] = [];
  gh.setGhWaitSignal(signal);
  gh.onGhLimited((until, kind) => heard.push([until, kind]));
  try { return await fn(heard); } finally { gh.setGhWaitSignal(undefined); gh.onGhLimited(undefined); delete process.env.HX_FAKE_GH_LOG; }
}
const errorOf = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e: any) { return e.message; } return assert.fail('did not throw'); };

test('a secondary limit with Retry-After: 2 waits ~2 s and retries', E2E, async () => {
  const b = board({ limitNext: { match: 'issue list', kind: 'secondary', times: 1, retryAfter: 2 } });
  await withSignal(new AbortController().signal, async (heard) => {
    const t0 = Date.now();
    const issues = await gh.listIssues('me/app');
    const took = Date.now() - t0;
    assert.deepEqual(issues.map((i) => i.number), [1]);
    assert.ok(took >= 2000 && took < 20_000, `${took} ms`);
    assert.equal(calls(b.log, 'issue list'), 2);
    assert.equal(calls(b.log, 'api rate_limit'), 0, 'a secondary limit does not read the budget');
    assert.equal(heard.length, 1);
    assert.equal(heard[0][1], 'secondary');
  });
});

test('two secondary limits in a row: the second wait doubles', E2E, async () => {
  const b = board({ limitNext: { match: 'issue view', kind: 'secondary', times: 2, retryAfter: 1 } });
  await withSignal(new AbortController().signal, async (heard) => {
    const t0 = Date.now();
    assert.deepEqual(await gh.issueLabels('me/app', 1), []);
    assert.ok(Date.now() - t0 >= 3000, `${Date.now() - t0} ms`);
    assert.equal(calls(b.log, 'issue view'), 3);
    assert.equal(heard.length, 2);
  });
});

test('wait signal unset: a limited call fails at once with its original error (throw and null alike)', E2E, async () => {
  const b = board({ limitNext: { match: 'issue list', kind: 'primary', times: 1 }, rateLimit: { core: { limit: 5000, remaining: 0, reset: Math.floor(Date.now() / 1000) + 600 } } });
  await withSignal(undefined, async (heard) => {
    const t0 = Date.now();
    const msg = await errorOf(gh.listIssues('me/app'));
    assert.ok(Date.now() - t0 < 60_000, 'not a wait for the reset 600 s away');
    assert.equal(msg, `${GH} issue list -R me/app --state all --limit 1000 --json number,title,body,state,labels,author failed (1): HTTP 403: API rate limit exceeded for user ID 1.`);
    assert.equal(calls(b.log, 'issue list'), 1);
    assert.equal(calls(b.log, 'api rate_limit'), 0);
    assert.deepEqual(heard, []);
  });
  board({ limitNext: { match: 'pr list', kind: 'secondary', times: 1, retryAfter: 1 }, prs: [{ number: 100, head: 'issue/7', state: 'OPEN' }] });
  await withSignal(undefined, async () => assert.equal(await gh.openPrFor('me/app', 'issue/7'), null));
});

test('a non-limit failure (HTTP 502, HTTP 401) fails at once with the wait signal set', E2E, async () => {
  const b = board({ listFails: true });
  await withSignal(new AbortController().signal, async (heard) => {
    assert.match(await errorOf(gh.listIssues('me/app')), /failed \(1\): HTTP 502: Bad Gateway$/);
    assert.equal(calls(b.log, 'issue list'), 1);
    assert.deepEqual(heard, []);
  });
  const b2 = board({ loginFails: true });
  await withSignal(new AbortController().signal, async (heard) => {
    assert.match(await errorOf(gh.ghLogin()), /HTTP 401: Bad credentials/);
    assert.equal(calls(b2.log, 'api user'), 1);
    assert.deepEqual(heard, []);
  });
});

test('an aborted wait is not retried: the call fails with its original error; rateLimit() is never retried', E2E, async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const b = board({ limitNext: { match: 'issue list', kind: 'primary', times: 1 }, rateLimit: { core: { limit: 5000, remaining: 0, reset } } });
  const ac = new AbortController();
  await withSignal(ac.signal, async (heard) => {
    const p = errorOf(gh.listIssues('me/app'));
    while (!heard.length) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(heard, [[reset * 1000, 'primary']], 'primary waits until the reset of the bucket at 0');
    const t0 = Date.now();
    ac.abort();
    assert.match(await p, /API rate limit exceeded/);
    assert.ok(Date.now() - t0 < 60_000, 'the abort ended the wait for the reset 600 s away');
    assert.equal(calls(b.log, 'issue list'), 1);
  });
  const b2 = board({ rateLimitFails: true });
  await withSignal(new AbortController().signal, async () => {
    assert.equal(await gh.rateLimit(), null);
    assert.equal(calls(b2.log, 'api rate_limit'), 1);
  });
});

// hx run end to end
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let n = 0;
function repo(issues: number[], state: object) {
  const name = `r${n++}`;
  const base = path.join(tmp, name);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'app');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  // ghReservePct 0: the reserve (#170) stays out of the way; only the limited call makes the runner wait
  const cfg = { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(base, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ghReservePct: 0 };
  saveConfig(path.join(root, '.hx'), cfg);
  const file = path.join(base, 'board.json');
  writeFileSync(file, JSON.stringify({ comments: [], prs: [], labels: labelSpecs(DEFAULTS.labels).map((l) => l.name),
    issues: issues.map((number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] })), ...state }));
  const fake = path.join(base, 'sessions');
  mkdirSync(fake);
  return { base, root, board: file, fake, ghLog: path.join(base, 'gh.log'), project: { root, stateDir: path.join(root, '.hx'), config: cfg } };
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const closed = (file: string) => read(file).issues.filter((i: any) => i.state === 'CLOSED').map((i: any) => i.number).sort();
type Line = { at: number; text: string };
async function run(r: ReturnType<typeof repo>, env: Record<string, string> = {}, onLine?: (l: string) => void, also?: AbortSignal) {
  Object.assign(process.env, { HX_FAKE_STATE: r.board, HX_FAKE_DIR: r.fake, HX_FAKE_GH_LOG: r.ghLog, ...env });
  const lines: Line[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push({ at: Date.now(), text: String(m) }); onLine?.(String(m)); };
  let code: number;
  try { code = await pooled((signal) => runPool(r.project as any, { workers: 1, watch: false, dryRun: false, signal }), also); } finally {
    console.log = orig;
    delete process.env.HX_FAKE_GH_LOG;
    for (const k of Object.keys(env)) delete process.env[k];
  }
  return { code, lines, out: lines.map((l) => l.text).join('\n') };
}
function holdFilesUnder(...dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (d: string) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.name === 'github-hold.json') found.push(f);
    if (e.isDirectory()) walk(f);
  } };
  for (const d of dirs) walk(d);
  return found;
}

test('hx run: a primary limit on issue list waits until the reset, retries, and the run completes with no failure', E2E, async () => {
  const full = { limit: 5000, remaining: 5000 };
  const r = repo([1], { limitNext: { match: 'issue list', kind: 'primary', times: 1 },
    rateLimit: [{ for: 6, core: { limit: 5000, remaining: 0 }, graphql: full }, {}] });
  const res = await run(r);
  assert.equal(res.code, 0, res.out);
  const reset = read(r.board).rateLimitStart + 6;
  const waits = res.lines.filter((l) => /github rate limited/.test(l.text));
  assert.equal(waits.length, 1, res.out);
  assert.ok(waits[0].text.endsWith(`github rate limited — waiting until ${hhmm(reset)}`), waits[0].text);
  const claim = res.lines.find((l) => l.text.includes('[#1]'));
  assert.ok(claim && claim.at >= reset * 1000, `claimed during the wait\n${res.out}`);
  assert.doesNotMatch(res.out, /board read failed|handed back|released/);
  assert.equal(calls(r.ghLog, 'issue list') >= 2, true);
  assert.deepEqual(closed(r.board), [1]);
  assert.deepEqual(holdFilesUnder(process.env.HX_HOME!, r.base), [], 'no HX_FLEET_DIR, no github-hold.json');
});

test('hx run: Ctrl+C during a limited wait stops promptly, the call is not retried, no failure; HX_FLEET_DIR gets github-hold.json', E2E, async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const r = repo([1], { limitNext: { match: 'issue list', kind: 'primary', times: 5 },
    rateLimit: { core: { limit: 5000, remaining: 0, reset }, graphql: { limit: 5000, remaining: 5000, reset } } });
  const fleet = path.join(r.base, 'fleet');
  const ctrlC = new AbortController();
  let abortedAt = 0;
  const res = await run(r, { HX_FLEET_DIR: fleet }, (l) => {
    if (/github rate limited/.test(l) && !abortedAt) setTimeout(() => { abortedAt = Date.now(); ctrlC.abort(); }, 300);
  }, ctrlC.signal);
  assert.ok(abortedAt > 0, res.out);
  assert.ok(Date.now() - abortedAt < 30_000, 'stopped promptly');
  assert.equal(res.code, 0, res.out);
  assert.equal(res.lines.filter((l) => /github rate limited — waiting until/.test(l.text)).length, 1, res.out);
  assert.equal(calls(r.ghLog, 'issue list'), 1, 'not retried');
  assert.doesNotMatch(res.out, /\[#1\]/, 'nothing claimed');
  assert.deepEqual(closed(r.board), []);
  assert.deepEqual(read(githubHoldFile(fleet)), { until: reset * 1000, reason: 'github rate limited', repo: r.project.config.repo });
});

function hx(cwd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  const t0 = Date.now();
  const p = spawn(process.execPath, [HX, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
  return new Promise((res) => p.on('close', (code) => res({ code, out, ms: Date.now() - t0 })));
}

test('hx status: a limited issue list fails at once, with the exit code a failing issue list gives', E2E, async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const limited = repo([1], { limitNext: { match: 'issue list', kind: 'primary', times: 5 },
    rateLimit: { core: { limit: 5000, remaining: 0, reset }, graphql: { limit: 5000, remaining: 5000, reset } } });
  const failing = repo([1], { listFails: true });
  const a = await hx(limited.root, ['status'], { HX_FAKE_STATE: limited.board, HX_FAKE_GH_LOG: limited.ghLog });
  const b = await hx(failing.root, ['status'], { HX_FAKE_STATE: failing.board });
  assert.notEqual(b.code, 0, b.out);
  assert.equal(a.code, b.code, a.out);
  assert.match(a.out, /API rate limit exceeded/);
  assert.ok(a.ms < 30_000, `${a.ms} ms`);
  assert.equal(calls(limited.ghLog, 'issue list'), 1);
});
