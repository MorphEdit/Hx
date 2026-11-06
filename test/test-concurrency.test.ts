// HX_TEST_CONCURRENCY (#350): the formula and the testConcurrency key, the env of every session, gate run and
// ship --resume hx runs (real git, a local bare origin, fake gh and claude), live.json's last value and hx status's
// ` · concurrency <n>` at the end of the time line.
import { E2E, pooled, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tc-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { concurrencyEnv, concurrencyFor, outsideTestEnv, testConcurrencyError, testConcurrencyValue } = await import('../src/concurrency.ts');
const { runPool } = await import('../src/pool.ts');
const { timeLine } = await import('../src/cli.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');
const { appendGateRun } = await import('../src/gate.ts');
const { writeLive } = await import('../src/runstate.ts');

const CPUS = os.availableParallelism();
const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, sizeCheck: false, ...extra } });
const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number, body = '') => ({ number: n, title: `task ${n}`, body, state: 'OPEN', labels: [L.ready] });

// a test command that appends its HX_TEST_CONCURRENCY and live.json's testConcurrency, as it runs, to <out>
const envScript = path.join(tmp, 'envout.mjs');
writeFileSync(envScript, `import { appendFileSync, readFileSync } from 'node:fs';
const [out, live] = process.argv.slice(2);
let lv = null;
try { lv = JSON.parse(readFileSync(live, 'utf8')).testConcurrency ?? null; } catch {}
appendFileSync(out, JSON.stringify({ env: process.env.HX_TEST_CONCURRENCY ?? null, live: lv }) + '\\n');
`);
const envCommand = (out: string) => `node "${envScript}" "${out}" "${path.join(stateDir, 'live.json')}"`;
const seen = (out: string): { env: string | null; live: number | null }[] =>
  existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

async function run(extra: Record<string, unknown>, o: { only?: number[]; workers?: number } = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra) as any, { workers: o.workers ?? 1, watch: false, dryRun: false, only: o.only, signal })), lines };
  } finally { console.log = orig; }
}

// ---- the formula and the key ----

test('the formula: max(1, floor((cpus - 1) / n)); cpus 12 with 1, 3, 4 running → 11, 3, 2; never below 1', E2E, () => {
  assert.equal(concurrencyFor(12, 1), 11);
  assert.equal(concurrencyFor(12, 3), 3);
  assert.equal(concurrencyFor(12, 4), 2);
  assert.equal(concurrencyFor(2, 5), 1);
  assert.equal(concurrencyFor(1, 1), 1);
  // a session starting with 2 others in flight and the gate running: n = 4; a gate run with 2 sessions in flight: n = 3
  assert.equal(testConcurrencyValue('auto', 4, 12), 2);
  assert.equal(testConcurrencyValue('auto', 3, 12), 3);
});

test('testConcurrency: a positive integer is used whatever the count; 0 sets no variable; outside hx run n = 1', E2E, () => {
  for (const n of [1, 3, 40]) assert.equal(testConcurrencyValue(5, n, 12), 5);
  assert.equal(testConcurrencyValue(0, 1, 12), null);
  assert.deepEqual(concurrencyEnv(testConcurrencyValue(0, 3, 12)), {});
  assert.deepEqual(concurrencyEnv(testConcurrencyValue(5, 3, 12)), { HX_TEST_CONCURRENCY: '5' });
  assert.deepEqual(outsideTestEnv({ testConcurrency: 'auto' }), { HX_TEST_CONCURRENCY: String(Math.max(1, CPUS - 1)) });
  assert.deepEqual(outsideTestEnv({ testConcurrency: 7 }), { HX_TEST_CONCURRENCY: '7' });
  assert.deepEqual(outsideTestEnv({ testConcurrency: 0 }), {});
  assert.equal(DEFAULTS.testConcurrency, 'auto');
});

test('config: "auto", a positive integer and 0 are accepted; anything else is refused with one line naming the key', E2E, () => {
  for (const v of [undefined, 'auto', 1, 12, 0]) assert.equal(testConcurrencyError(v), null, String(v));
  for (const v of ['fast', -1, 1.5, true, null, '3', 'AUTO']) {
    const e = testConcurrencyError(v);
    assert.match(e ?? '', /^testConcurrency: /, String(v));
    assert.ok(!e!.includes('\n'));
  }
});

test('hx run with testConcurrency "fast" stops at start (exit 2) with the key named, before claiming anything', E2E, async () => {
  board([issue(9)]);
  const { rc, lines } = await run({ testConcurrency: 'fast' }, { only: [9] });
  assert.equal(rc, 2);
  assert.ok(lines.some((l) => /STOPPED: testConcurrency: "fast" must be/.test(l)), lines.join('\n'));
  assert.equal(read().issues[0].state, 'OPEN');
});

// ---- where hx sets it ----

test('a session gets HX_TEST_CONCURRENCY: testConcurrency 3 → "3", 0 → absent', E2E, async () => {
  for (const [n, setting, want] of [[1, 3, '3'], [2, 0, null]] as const) {
    rmSync(fakeDir, { recursive: true, force: true }); mkdirSync(fakeDir);
    board([issue(n)]);
    const { rc, lines } = await run({ testConcurrency: setting }, { only: [n] });
    assert.equal(rc, 0, lines.join('\n'));
    assert.equal(read().issues[0].state, 'CLOSED');
    const envs = sessionEnvs(fakeDir);
    assert.ok(envs.length > 0);
    for (const e of envs) assert.equal(e.testConcurrency, want, JSON.stringify(e));
  }
});

test('"auto": two sessions in flight at once each get the formula for n = 2', E2E, async () => {
  rmSync(fakeDir, { recursive: true, force: true }); mkdirSync(fakeDir);
  board([issue(3, 'HOLD'), issue(4, 'HOLD')]);
  const release = path.join(tmp, 'release-34');
  process.env.FAKE_CLAUDE_HOLD = release;
  // both sessions are held until both have started: neither can end before the other's start
  const t = setInterval(() => {
    if (existsSync(path.join(fakeDir, 'held-3')) && existsSync(path.join(fakeDir, 'held-4'))) { clearInterval(t); writeFileSync(release, ''); }
  }, 50);
  try {
    const { rc, lines } = await run({ testConcurrency: 'auto' }, { only: [3, 4], workers: 2 });
    assert.equal(rc, 0, lines.join('\n'));
  } finally { clearInterval(t); delete process.env.FAKE_CLAUDE_HOLD; }
  const envs = sessionEnvs(fakeDir);
  assert.ok(envs.length >= 2, JSON.stringify(envs)); // every turn of both sessions
  for (const e of envs) assert.equal(e.testConcurrency, String(concurrencyFor(CPUS, 2)), JSON.stringify(e));
});

test('the gate\'s test command gets it ("auto": the gate alone, n = 1; 5 → "5"; 0 → absent), and live.json holds the value set', E2E, async () => {
  for (const [setting, want] of [['auto', String(concurrencyFor(CPUS, 1))], [5, '5'], [0, null]] as const) {
    const out = path.join(tmp, `gate-${setting}.jsonl`);
    board([]);
    const { rc, lines } = await run({ gate: true, gateCommand: envCommand(out), testConcurrency: setting });
    assert.equal(rc, 0, lines.join('\n'));
    const s = seen(out);
    assert.ok(s.length >= 1, lines.join('\n'));
    assert.equal(s[0].env, want);
    // written before the gate command started; with 0 nothing is set, so nothing is written
    assert.equal(s[0].live, want === null ? null : Number(want));
  }
});

test('hx\'s own ship --resume after a passed audit gets it, and ship.mjs hands it to the test command', E2E, async () => {
  const out = path.join(tmp, 'ship.jsonl');
  process.env.FAKE_SHIP_TEST = envCommand(out);
  board([issue(5)]);
  try {
    // reuseTestedTrees off: hx's ship --resume would otherwise skip the tests on the tree the implementer's ship passed (#351)
    const { rc, lines } = await run({ audit: true, testConcurrency: 3, reuseTestedTrees: false }, { only: [5] });
    assert.equal(rc, 0, lines.join('\n'));
  } finally { delete process.env.FAKE_SHIP_TEST; }
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.equal(s.prs[0].state, 'MERGED');
  assert.equal(process.env.HX_TEST_CONCURRENCY, undefined, 'the test process has none: hx set it');
  // the implementer's ship --no-merge (the session's env), then hx's ship --resume
  assert.deepEqual(seen(out).map((x) => x.env), ['3', '3']);
});

// ---- hx status ----

test('timeLine ends with " · concurrency <n>"; without a value or with 0 the part is left out', E2E, () => {
  const s = { share: 0.76, testRunMedian: 240_000, gateMedian: 741_000, gateP90: 1_570_000, hasData: true };
  assert.equal(timeLine(s, 3), 'time     tests 76% of session time · median test run 4m · gate 12m21s (p90 26m10s) · concurrency 3');
  assert.equal(timeLine(s), 'time     tests 76% of session time · median test run 4m · gate 12m21s (p90 26m10s)');
  assert.equal(timeLine(s, 0), timeLine(s));
  assert.equal(timeLine({ hasData: false }, 3), undefined);
});

test('hx status: the time line ends with live.json\'s value; no runner, no value or 0 → left out', E2E, () => {
  const app = path.join(tmp, 'status-app');
  const sd = path.join(app, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt-status') } as any);
  appendGateRun(sd, { sha: 'abc', ok: true, command: 'npm test', output: '', durationMs: 60_000, at: new Date().toISOString() });
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const timeOf = () => {
    const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const l = r.stdout.split(/\r?\n/).find((x) => x.startsWith('time     '));
    assert.ok(l, r.stdout);
    return l!;
  };
  const base = { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 2, sessions: [] };
  writeLive(sd, { ...base, testConcurrency: 3 });
  assert.match(timeOf(), / · concurrency 3$/);
  writeLive(sd, base);
  assert.doesNotMatch(timeOf(), /concurrency/);
  writeLive(sd, { ...base, testConcurrency: 0 });
  assert.doesNotMatch(timeOf(), /concurrency/);
  writeLive(sd, { ...base, pid: 2 ** 30, testConcurrency: 3 }); // no live runner
  assert.doesNotMatch(timeOf(), /concurrency/);
});

test('docs: the testConcurrency config row, the paragraph under "Where the time goes"; the /hx skill names the key and the variable', E2E, () => {
  const guide = readFileSync(path.join(here, '..', 'docs', 'guide.md'), 'utf8');
  assert.match(guide, /^\| `testConcurrency` \| `"auto"` \|/m);
  const time = guide.slice(guide.indexOf('## Where the time goes'), guide.indexOf('\n## ', guide.indexOf('## Where the time goes') + 1));
  for (const w of ['HX_TEST_CONCURRENCY', 'max(1, floor((cpus - 1) / n))', '`n = 4`', '`n = 3`', '`n = 1`', '· concurrency 3', 'ship --resume', 'hx grill'])
    assert.ok(time.includes(w), w);
  const skill = readFileSync(path.join(here, '..', 'templates', 'hx-skill.md'), 'utf8');
  for (const w of ['testConcurrency', 'HX_TEST_CONCURRENCY']) assert.ok(skill.includes(w), w);
});
