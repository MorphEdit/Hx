// Each pool gate run whose test command ran is a line of .hx/gate-runs.jsonl (#204), and hx warns once per run
// when the median of the last 5 nears gateMinutes. Real git (a local bare origin), fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-gr-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { fmtDuration, readGate, readGateRuns, runGate, slowGateWarning } = await import('../src/gate.ts');
const { releaseGate } = await import('../src/release.ts');

const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
writeFileSync(path.join(root, 'README'), 'x\n');
git(root, 'add', '-A');
git(root, ...gitId, 'commit', '-q', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const exclude = path.join(root, '.git', 'info', 'exclude');
writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');

const fwd = (p: string) => p.replace(/\\/g, '/');
const GATE = `node -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;
const runsFile = path.join(stateDir, 'gate-runs.jsonl');
const runsText = () => { try { return readFileSync(runsFile, 'utf8'); } catch { return ''; } };
const reset = (lines: object[] = []) => {
  rmSync(runsFile, { force: true });
  rmSync(path.join(stateDir, 'gate.json'), { force: true });
  if (lines.length) writeFileSync(runsFile, lines.map((l) => JSON.stringify(l) + '\n').join(''));
};
function setMain(broken: boolean) {
  git(root, 'pull', '-q', 'origin', 'main');
  const f = path.join(root, 'BROKEN');
  if (broken === existsSync(f)) return;
  if (broken) writeFileSync(f, 'x\n'); else rmSync(f);
  git(root, 'add', '-A');
  git(root, ...gitId, 'commit', '-q', '-m', broken ? 'break' : 'unbreak');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
}
const project = (extra: object) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gateCommand: GATE, ...extra } });
/** Run the pool; with `untilResult`, watch and stop once gate.json has a result (a red gate files a fix nobody makes). */
async function runLogged(p: ReturnType<typeof project>, untilResult = false) {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const ac = new AbortController();
  const poll = untilResult ? setInterval(() => { if (readGate(stateDir).last) { clearInterval(poll); ac.abort(); } }, 50) : undefined;
  const rc = await pooled((signal) => runPool(p, { workers: 1, watch: untilResult, dryRun: false, signal }), ac.signal)
    .finally(() => { console.log = orig; clearInterval(poll); });
  return { rc, lines };
}
const old = (durationMs: number) => ({ ts: '2026-01-01T00:00:00.000Z', sha: 'abc', ok: true, durationMs, timedOut: false });

test('fmtDuration: as in the warning example', E2E, () => {
  assert.equal(fmtDuration(910_000), '15m10s');
  assert.equal(fmtDuration(20 * 60_000), '20m');
  assert.equal(fmtDuration(65_000), '1m05s');
  assert.equal(fmtDuration(45_000), '45s');
});

test('slowGateWarning: nearest-rank median of the last 5 above 70% of gateMinutes; none below or with fewer than 5', E2E, () => {
  const runs = (ms: number[]) => ms.map(old);
  assert.equal(slowGateWarning(runs([910_000, 910_000, 910_000, 1, 1]), 20),
    'gate is slow: median 15m10s of a 20m timeout — tests may time out under load');
  assert.equal(slowGateWarning(runs([910_000, 910_000, 910_000, 910_000]), 20), undefined, 'fewer than 5');
  assert.equal(slowGateWarning(runs([910_000, 910_000, 1, 1, 1]), 20), undefined, 'median below');
  assert.equal(slowGateWarning(runs([840_000, 840_000, 840_000, 840_000, 840_000]), 20), undefined, 'exactly 70% is not above');
  // only the last 5 count
  assert.equal(slowGateWarning(runs([1, 1, 1, 910_000, 910_000, 910_000, 910_000, 910_000]), 20)?.startsWith('gate is slow'), true);
  assert.equal(slowGateWarning(runs([910_000, 910_000, 910_000, 1, 1, 1, 1, 1]), 20), undefined);
});

test('readGateRuns skips malformed lines', E2E, () => {
  reset();
  writeFileSync(runsFile, [JSON.stringify(old(5)), 'not json', '{"ok":true}', '', JSON.stringify(old(7)), '{"durationMs":"x","ok":true}'].join('\n'));
  assert.deepEqual(readGateRuns(stateDir).map((r) => r.durationMs), [5, 7]);
  rmSync(runsFile);
  assert.deepEqual(readGateRuns(stateDir), []);
});

test('a green pool gate appends { ts, sha, ok, durationMs, timedOut }; gate.json keeps its shape', E2E, async () => {
  setMain(false); reset();
  const { rc, lines } = await runLogged(project({}));
  assert.equal(rc, 0, lines.join('\n'));
  const runs = readGateRuns(stateDir);
  assert.equal(runs.length, 1, runsText());
  const g = readGate(stateDir).last!;
  assert.deepEqual(Object.keys(runs[0]).sort(), ['durationMs', 'ok', 'sha', 'timedOut', 'ts']);
  assert.equal(runs[0].ok, true);
  assert.equal(runs[0].timedOut, false);
  assert.ok(runs[0].durationMs >= 0);
  assert.equal(runs[0].sha, git(root, 'rev-parse', 'origin/main'));
  assert.equal(runs[0].ts, g.at);
  assert.ok(!lines.some((l) => /gate is slow/.test(l)));
});

test('a red pool gate appends ok: false, timedOut: false', E2E, async () => {
  setMain(true); reset();
  const { lines } = await runLogged(project({}), true);
  const runs = readGateRuns(stateDir);
  assert.equal(runs.length, 1, runsText() + lines.join('\n'));
  assert.equal(runs[0].ok, false);
  assert.equal(runs[0].timedOut, false);
  assert.ok(runs[0].durationMs >= 0);
  assert.equal(runs[0].ts, readGate(stateDir).last!.at);
  setMain(false);
});

test('a timed-out pool gate appends ok: false, timedOut: true', E2E, async () => {
  setMain(false); reset();
  const sleeper = `node -e "setTimeout(() => {}, 120e3)"`;
  const { lines } = await runLogged(project({ gateCommand: sleeper, gateMinutes: 0.05 }), true);
  const runs = readGateRuns(stateDir);
  assert.equal(runs.length, 1, runsText() + lines.join('\n'));
  assert.equal(runs[0].ok, false);
  assert.equal(runs[0].timedOut, true);
  assert.ok(runs[0].durationMs >= 2000, `ran until the 3 s timeout: ${runs[0].durationMs}`);
});

test('a failing worktree setup (every try) appends no line', E2E, async () => {
  setMain(false); reset();
  const { lines } = await runLogged(project({ worktreeSetup: `node -e "process.exit(1)"` }), true);
  assert.equal(readGate(stateDir).last?.setupFailed, true, lines.join('\n'));
  assert.equal(lines.filter((l) => /try \d of 3/.test(l)).length, 3, lines.join('\n'));
  assert.equal(runsText(), '');
});

test('an aborted pool gate (Ctrl+C) appends no line', E2E, async () => {
  setMain(false); reset();
  const pidFile = fwd(path.join(tmp, 'abort.pid'));
  const sleeper = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60e3)"`;
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const ac = new AbortController();
  const poll = setInterval(() => { if (existsSync(pidFile)) { clearInterval(poll); ac.abort(); } }, 50);
  await pooled((signal) => runPool(project({ gateCommand: sleeper }), { workers: 1, watch: true, dryRun: false, signal }), ac.signal)
    .finally(() => clearInterval(poll));
  assert.ok(existsSync(pidFile), 'the gate command started');
  assert.equal(runsText(), '');
});

test('the release gate appends no line', E2E, async () => {
  setMain(false); reset();
  const c = project({}).config;
  const r = await releaseGate({ root, stateDir }, c, () => {})();
  assert.equal(r?.ok, true);
  assert.equal(runsText(), '');
});

test('runGate: durationMs is the test command only, not a slow worktree setup; absent after a failed setup', E2E, async () => {
  setMain(false);
  const config = { ...DEFAULTS, worktreeSetup: `node -e "setTimeout(() => {}, 4000)"`, worktreeSetupMinutes: 5 };
  const t0 = Date.now();
  const r = await runGate(root, path.join(tmp, 'wt'), 'main', GATE, 60_000, undefined, { stateDir, config, log: () => {} });
  const total = Date.now() - t0;
  assert.equal(r.ok, true, r.output);
  assert.ok(total >= 4000, `the setup ran: ${total}`);
  assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0 && r.durationMs < total - 3500, `durationMs ${r.durationMs} of ${total}`);
  const bad = await runGate(root, path.join(tmp, 'wt'), 'main', GATE, 60_000, undefined,
    { stateDir, config: { ...config, worktreeSetup: `node -e "process.exit(1)"` }, log: () => {} });
  assert.equal(bad.setupFailed, true);
  assert.equal(bad.durationMs, undefined);
});

test('the slow warning: logged once when the median of the last 5 crosses 70% of gateMinutes, not twice in one run', E2E, async () => {
  // 4 slow lines from earlier runs; this run gates red (5th line) and, after the fix merges, green (6th)
  setMain(true); reset([old(59_000), old(59_000), old(59_000), old(59_000)]);
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const rc = await pooled((signal) => runPool(project({ gateMinutes: 1 }), { workers: 1, watch: false, dryRun: false, signal }))
    .finally(() => { console.log = orig; });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(readGateRuns(stateDir).length, 6, runsText());
  assert.equal(readGate(stateDir).last?.ok, true);
  const slow = lines.filter((l) => /gate is slow/.test(l));
  assert.equal(slow.length, 1, lines.join('\n'));
  assert.match(slow[0], /gate is slow: median 59s of a 1m timeout — tests may time out under load/);
});

test('the slow warning: not when the median is below, not with fewer than 5 lines', E2E, async () => {
  setMain(false); reset([old(59_000), old(59_000), old(1), old(1)]);
  let { lines } = await runLogged(project({ gateMinutes: 1 }));
  assert.equal(readGateRuns(stateDir).length, 5);
  assert.ok(!lines.some((l) => /gate is slow/.test(l)), lines.join('\n'));
  reset([old(59_000), old(59_000), old(59_000)]);
  ({ lines } = await runLogged(project({ gateMinutes: 1 })));
  assert.equal(readGateRuns(stateDir).length, 4);
  assert.ok(!lines.some((l) => /gate is slow/.test(l)), lines.join('\n'));
});
