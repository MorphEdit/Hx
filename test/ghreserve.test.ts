// The GitHub budget reserve (#170, PRD #138 §B, §D7): reserveState, ghReservePct, a runner that claims nothing and
// reads no board while budget-low, and github-hold.json shared across the fleet. Real git, fake gh and fake claude;
// the fake gh's `state.rateLimit` phases stand in for a budget that resets.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hhmm, reserveState, type GhBudget } from '../src/ghlimit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const GH = path.join(here, 'fakes', 'gh.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-rsv-'));
process.env.HX_GH_BIN = GH;
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, ghReservePctError, labelSpecs, saveConfig } = await import('../src/config.ts');
const { githubHoldFile, readGithubHold, writeGithubHold } = await import('../src/fleet.ts');

const T = 1_800_000_000; // epoch seconds
const bud = (core: [number, number, number], graphql: [number, number, number]): GhBudget => ({
  core: { remaining: core[0], limit: core[1], reset: core[2] }, graphql: { remaining: graphql[0], limit: graphql[1], reset: graphql[2] }, at: '' });

test('reserveState: one bucket low, both low (the later reset), none low, pct 0 never low', E2E, () => {
  assert.deepEqual(reserveState(bud([4000, 5000, T], [812, 5000, T + 60]), 0.2), { low: true, bucket: 'graphql', remaining: 812, limit: 5000, until: (T + 60) * 1000 });
  assert.deepEqual(reserveState(bud([100, 5000, T + 90], [4000, 5000, T]), 0.2), { low: true, bucket: 'core', remaining: 100, limit: 5000, until: (T + 90) * 1000 });
  // both below: the later reset, and the bucket it belongs to
  assert.deepEqual(reserveState(bud([100, 5000, T + 300], [200, 5000, T + 60]), 0.2), { low: true, bucket: 'core', remaining: 100, limit: 5000, until: (T + 300) * 1000 });
  assert.deepEqual(reserveState(bud([100, 5000, T], [200, 5000, T + 60]), 0.2), { low: true, bucket: 'graphql', remaining: 200, limit: 5000, until: (T + 60) * 1000 });
  assert.deepEqual(reserveState(bud([1000, 5000, T], [4999, 5000, T]), 0.2), { low: false }, 'exactly at the reserve is not below it');
  assert.deepEqual(reserveState(bud([5000, 5000, T], [5000, 5000, T]), 0.2), { low: false });
  assert.deepEqual(reserveState(bud([0, 5000, T], [0, 5000, T]), 0), { low: false });
  assert.deepEqual(reserveState(bud([0, 5000, T], [0, 5000, T]), -1), { low: false });
});

test('ghReservePct: default 0.2; a share from 0 to 1 is valid, anything else is an error', E2E, () => {
  assert.equal(DEFAULTS.ghReservePct, 0.2);
  for (const v of [0, 0.2, 1, undefined]) assert.equal(ghReservePctError(v), null, String(v));
  for (const v of [-0.1, 1.5, '0.2', NaN, null]) assert.match(ghReservePctError(v) ?? '', /^ghReservePct: .* from 0 to 1/, String(v));
});

test('readGithubHold / writeGithubHold: the rules of hold.json in github-hold.json', E2E, () => {
  const d = path.join(tmp, 'holds');
  assert.equal(readGithubHold(d), null); // missing
  const until = Date.now() + 60_000;
  assert.equal(writeGithubHold(d, { until, reason: 'graphql 812/5000', repo: 'me/a' }), true);
  assert.deepEqual(JSON.parse(readFileSync(githubHoldFile(d), 'utf8')), { until, reason: 'graphql 812/5000', repo: 'me/a' });
  assert.equal(path.basename(githubHoldFile(d)), 'github-hold.json');
  assert.deepEqual(readGithubHold(d), { until, reason: 'graphql 812/5000', repo: 'me/a' });
  assert.equal(writeGithubHold(d, { until: until - 1000, reason: 'earlier', repo: 'me/b' }), false, 'a later until is kept');
  assert.equal(readGithubHold(d)?.repo, 'me/a');
  assert.equal(writeGithubHold(d, { until: until + 1000, reason: 'later', repo: 'me/c' }), true);
  assert.equal(readGithubHold(d)?.repo, 'me/c');
  assert.equal(readGithubHold(d, until + 2000), null, 'expired');
  writeFileSync(githubHoldFile(d), '{"until":');
  assert.equal(readGithubHold(d), null, 'unparsable');
  assert.equal(writeGithubHold(d, { until, reason: 'r', repo: 'me/a' }), true, 'an unparsable file does not block a write');
});

// a repo with its own origin, board and fake session dir
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
let n = 0;
function repo(issues: number[], rateLimit: unknown, config: object = {}) {
  const name = `r${n++}`;
  const base = path.join(tmp, name);
  mkdirSync(base);
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'app');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, root);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const cfg = { ...DEFAULTS, repo: `me/${name}`, defaultBranch: 'main', worktreeRoot: path.join(base, 'wt'),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...config };
  saveConfig(path.join(root, '.hx'), cfg);
  const board = path.join(base, 'board.json');
  // the labels exist already: a start that creates them takes seconds on a loaded machine
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], rateLimit, labels: labelSpecs(DEFAULTS.labels).map((l) => l.name),
    issues: issues.map((number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] })) }));
  const fake = path.join(base, 'sessions');
  mkdirSync(fake);
  return { base, root, board, fake, ghLog: path.join(base, 'gh.log'), project: { root, stateDir: path.join(root, '.hx'), config: cfg } };
}
const closed = (board: string) => JSON.parse(readFileSync(board, 'utf8')).issues.filter((i: any) => i.state === 'CLOSED').map((i: any) => i.number).sort();
const issueLists = (ghLog: string) => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '').split('\n').filter((l) => l.startsWith('issue list')).length;
const full = { limit: 5000, remaining: 5000 };
// the fake gh's phases are timed from its first rate_limit read (epoch seconds)
const started = (board: string): number => JSON.parse(readFileSync(board, 'utf8')).rateLimitStart;

type Line = { at: number; text: string; issueLists: number };
/** One `hx run` (no --watch) in this process; each log line with its time and the `issue list` calls made so far. */
async function run(r: ReturnType<typeof repo>): Promise<{ code: number; lines: Line[]; out: string }> {
  Object.assign(process.env, { HX_FAKE_STATE: r.board, HX_FAKE_DIR: r.fake, HX_FAKE_GH_LOG: r.ghLog });
  const lines: Line[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push({ at: Date.now(), text: String(m), issueLists: issueLists(r.ghLog) }); };
  let code: number;
  try { code = await pooled((signal) => runPool(r.project as any, { workers: 1, watch: false, dryRun: false, signal })); } finally {
    console.log = orig;
    delete process.env.HX_FAKE_GH_LOG;
  }
  return { code, lines, out: lines.map((l) => l.text).join('\n') };
}
const find = (lines: Line[], re: RegExp) => lines.filter((l) => re.test(l.text));
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

test('below the reserve: nothing claimed, no issue list, one low line; after the reset the issue is claimed and restored is logged; no HX_FLEET_DIR, no github-hold.json', E2E, async () => {
  const r = repo([1], [{ for: 4, core: full, graphql: { limit: 5000, remaining: 812 } }, {}]);
  const res = await run(r);
  assert.equal(res.code, 0, res.out);
  const reset = started(r.board) + 4;
  const low = find(res.lines, /github budget low/);
  assert.equal(low.length, 1, res.out);
  assert.ok(low[0].text.endsWith(`github budget low: graphql 812/5000 — no new claims until ${hhmm(reset)}`), low[0].text);
  const restored = find(res.lines, /github budget restored/);
  assert.equal(restored.length, 1, res.out);
  assert.ok(restored[0].at >= reset * 1000, 'restored only once the reset passed');
  assert.equal(restored[0].issueLists, low[0].issueLists, 'no issue list while budget-low');
  // without --watch the low budget did not end the run: it waited, then claimed and finished
  const claim = res.lines.find((l) => l.text.includes('[#1]'));
  assert.ok(claim && claim.at >= restored[0].at, res.out);
  const done = find(res.lines, /nothing left to do/);
  assert.equal(done.length, 1, res.out);
  assert.ok(done[0].at >= claim!.at, 'the run did not finish while budget-low');
  assert.deepEqual(closed(r.board), [1]);
  assert.deepEqual(holdFilesUnder(process.env.HX_HOME!, r.base), []);
});

test('still below after the reset: the runner stays low with the new reset and logs it once more', E2E, async () => {
  const r = repo([1], [
    { for: 3, core: full, graphql: { limit: 5000, remaining: 812 } },
    // 8 s, not 3: the runner reads again only once r1 has passed, and on a loaded suite that read can land seconds
    // late — past a short second phase, so it saw the restored budget and never the second low (#227)
    { for: 8, core: { limit: 5000, remaining: 300 }, graphql: full },
    {},
  ]);
  const res = await run(r);
  assert.equal(res.code, 0, res.out);
  const r1 = started(r.board) + 3, r2 = r1 + 8;
  const low = find(res.lines, /github budget low/).map((l) => l.text.replace(/^\S+ /, ''));
  assert.deepEqual(low, [`github budget low: graphql 812/5000 — no new claims until ${hhmm(r1)}`, `github budget low: core 300/5000 — no new claims until ${hhmm(r2)}`], res.out);
  const restored = find(res.lines, /github budget restored/);
  assert.equal(restored.length, 1, res.out);
  assert.ok(restored[0].at >= r2 * 1000, res.out);
  assert.ok(res.lines.find((l) => l.text.includes('[#1]'))!.at >= r2 * 1000, 'nothing claimed before the second reset');
  assert.deepEqual(closed(r.board), [1]);
});

test('a budget raised before its reset restores normal work on the next read', E2E, async () => {
  const r = repo([1], [{ for: 3, core: full, graphql: { limit: 5000, remaining: 10, resetIn: 3600 } }, {}]);
  const res = await run(r);
  assert.equal(res.code, 0, res.out);
  const raised = (started(r.board) + 3) * 1000;
  assert.equal(find(res.lines, /github budget low: graphql 10\/5000/).length, 1, res.out);
  const restored = find(res.lines, /github budget restored/);
  assert.equal(restored.length, 1, res.out);
  // budget-low polls every 2 × pollSeconds: the next read after the raise comes long before the reset an hour away
  assert.ok(restored[0].at >= raised && restored[0].at < raised + 60_000, `${restored[0].at - raised} ms after the raise`);
  assert.deepEqual(closed(r.board), [1]);
});

test('ghReservePct 0: the issue is claimed at a low budget', E2E, async () => {
  const r = repo([1], [{ core: { limit: 5000, remaining: 5, resetIn: 3600 }, graphql: { limit: 5000, remaining: 5, resetIn: 3600 } }], { ghReservePct: 0 });
  const res = await run(r);
  assert.equal(res.code, 0, res.out);
  assert.doesNotMatch(res.out, /github budget low/);
  assert.deepEqual(closed(r.board), [1]);
});

test('a bad ghReservePct stops the run before the board is read', E2E, async () => {
  const r = repo([1], {}, { ghReservePct: 2 });
  const res = await run(r);
  assert.equal(res.code, 2, res.out);
  assert.match(res.out, /STOPPED: ghReservePct: 2 must be a number from 0 to 1/);
  assert.equal(issueLists(r.ghLog), 0);
  assert.deepEqual(closed(r.board), []);
});

function hxRun(r: ReturnType<typeof repo>, env: Record<string, string>) {
  const p = spawn(process.execPath, [HX, 'run', '--workers', '1'], { cwd: r.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    HX_FAKE_STATE: r.board, HX_FAKE_DIR: r.fake, ...env } });
  let out = '';
  p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
  const done = new Promise<{ code: number | null; out: string }>((res) => p.on('close', (code) => res({ code, out })));
  return { done, running: () => p.exitCode === null };
}
const tick = () => new Promise((r) => setTimeout(r, 50));

test('fleet: repo A going budget-low writes github-hold.json; repo B, with a full budget, claims nothing until it expires, then claims', E2E, async () => {
  const fleet = path.join(tmp, 'fleet');
  const timesB = path.join(tmp, 'times-b.jsonl');
  const env = { HX_FLEET_DIR: fleet, HX_HOME: path.join(tmp, 'home') };
  const a = repo([], [{ for: 20, core: full, graphql: { limit: 5000, remaining: 812 } }, {}]);
  const b = repo([1], undefined); // B's own view: 5000/5000
  // ordered by events, not by B's start time (#342: B spawned once the hold was there, and a loaded machine's start
  // outlasted the reset): A's first budget read, which starts the 20 s, waits until B's first board read is waiting;
  // that read waits until A has written the hold, and B's next step reads it
  const waiting = path.join(tmp, 'b-waiting');
  const withWait = (board: string, waitFor: object) => writeFileSync(board, JSON.stringify({ ...JSON.parse(readFileSync(board, 'utf8')), waitFor }));
  withWait(a.board, { match: 'api rate_limit', file: waiting });
  withWait(b.board, { match: 'issue list', file: githubHoldFile(fleet), mark: waiting });
  const ra = hxRun(a, env);
  const rb = hxRun(b, { ...env, FAKE_CLAUDE_TIMES: timesB });
  while (!existsSync(githubHoldFile(fleet))) {
    if (!ra.running()) assert.fail((await ra.done).out);
    if (!rb.running()) assert.fail((await rb.done).out);
    await tick();
  }
  await tick();
  const hold = JSON.parse(readFileSync(githubHoldFile(fleet), 'utf8'));
  const reset = started(a.board) + 20;
  assert.deepEqual(hold, { until: reset * 1000, reason: 'graphql 812/5000', repo: a.project.config.repo });

  const [resA, resB] = await Promise.all([ra.done, rb.done]);
  assert.equal(resA.code, 0, resA.out); assert.equal(resB.code, 0, resB.out);
  assert.match(resB.out, new RegExp(`github budget low: shared hold from ${a.project.config.repo}: graphql 812/5000 — no new claims until ${hhmm(reset)}`));
  assert.deepEqual(closed(b.board), [1], resB.out);
  const starts = readFileSync(timesB, 'utf8').trim().split('\n').map((l) => JSON.parse(l).start);
  assert.ok(Math.min(...starts) >= hold.until, `B claimed during the hold: ${Math.min(...starts)} < ${hold.until}`);
  assert.deepEqual(JSON.parse(readFileSync(githubHoldFile(fleet), 'utf8')), hold, 'B never wrote the hold back');
});
