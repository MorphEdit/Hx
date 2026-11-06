// The gate and .hx/tested-trees.jsonl (#352): every real gate run is recorded; while green, a head whose tree passed
// the gate command within 2 h is not tested again (a reused line in gate-runs.jsonl). Real git (a local bare origin),
// fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-gru-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readGate, readGateRuns } = await import('../src/gate.ts');
const { readTestedTrees } = await import('../src/tested.ts');

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
// the gate command and the worktree setup each leave a mark when they run
const ran = path.join(tmp, 'gate-ran'), setupRan = path.join(tmp, 'setup-ran');
const GATE = `node -e "require('fs').appendFileSync('${fwd(ran)}', 'x'); process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;
const SETUP = `node -e "require('fs').appendFileSync('${fwd(setupRan)}', 'x')"`;
const treesFile = path.join(stateDir, 'tested-trees.jsonl');
const runs = () => (existsSync(ran) ? readFileSync(ran, 'utf8').length : 0);
const trees = () => readTestedTrees(treesFile);
const headTree = () => git(root, 'rev-parse', 'origin/main^{tree}');
const headSha = () => git(root, 'rev-parse', 'origin/main');

function setMain(broken: boolean) {
  git(root, 'pull', '-q', 'origin', 'main');
  const f = path.join(root, 'BROKEN');
  if (broken === existsSync(f)) return;
  if (broken) writeFileSync(f, 'x\n'); else rmSync(f);
  git(root, 'add', '-A');
  git(root, ...gitId, 'commit', '-q', '-m', broken ? 'break' : 'unbreak');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
}
/** A fresh .hx: gate.json's last result (`last`: green, red or none), and the tested-trees lines given. */
function reset(last: 'green' | 'red' | 'none', records: object[] = []) {
  for (const f of ['gate-runs.jsonl', 'gate.json', 'tested-trees.jsonl']) rmSync(path.join(stateDir, f), { force: true });
  rmSync(ran, { force: true });
  rmSync(setupRan, { force: true });
  if (last !== 'none') writeFileSync(path.join(stateDir, 'gate.json'), JSON.stringify({ last: { sha: 'a'.repeat(40), ok: last === 'green', command: GATE, output: '', at: new Date().toISOString() } }));
  if (records.length) writeFileSync(treesFile, records.map((r) => JSON.stringify(r) + '\n').join(''));
}
const rec = (o: { tree?: string; command?: string; ok?: boolean; agoMs?: number } = {}) =>
  ({ tree: o.tree ?? headTree(), command: o.command ?? GATE, ok: o.ok ?? true, at: new Date(Date.now() - (o.agoMs ?? 60_000)).toISOString() });
const project = (extra: object = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, selfHeal: false, gateCommand: GATE, worktreeSetup: SETUP, ...extra } });
/** A plain run (a red gate: watched until gate.json has a result). live.json is read at the health pass's line, before the run removes it. */
async function runLogged(p: ReturnType<typeof project>, untilResult = false) {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const lines: string[] = [];
  let live: any;
  const orig = console.log;
  console.log = (m: string) => {
    lines.push(m); orig(m);
    if (!live && /health: \d+ ✓/.test(m)) live = JSON.parse(readFileSync(path.join(stateDir, 'live.json'), 'utf8'));
  };
  const ac = new AbortController();
  const before = readGate(stateDir).last?.at;
  const poll = untilResult ? setInterval(() => { const l = readGate(stateDir).last; if (l && l.at !== before) { clearInterval(poll); ac.abort(); } }, 50) : undefined;
  const rc = await pooled((signal) => runPool(p, { workers: 1, watch: untilResult, dryRun: false, signal }), ac.signal)
    .finally(() => { console.log = orig; clearInterval(poll); });
  return { rc, lines, live };
}

test('green with a passing record for the head tree and the gate command, 1 min old: reused — no setup, no test command, a reused line', E2E, async () => {
  setMain(false);
  reset('green', [rec()]);
  const { rc, lines, live } = await runLogged(project());
  assert.equal(rc, 0, lines.join('\n'));
  const sha = headSha();
  assert.ok(lines.some((l) => l.includes(`gate green ✓ at ${sha.slice(0, 7)} (tree already tested)`)), lines.join('\n'));
  assert.equal(runs(), 0, 'the test command never ran');
  assert.equal(existsSync(setupRan), false, 'the worktree setup never ran');
  const g = readGate(stateDir).last!;
  assert.equal(g.ok, true);
  assert.equal(g.sha, sha);
  assert.equal(g.reused, true);
  assert.equal(live?.gate?.ok, true, lines.join('\n'));
  assert.equal(live.gate.sha, sha);
  const gr = readGateRuns(stateDir);
  assert.equal(gr.length, 1);
  assert.deepEqual({ ...gr[0], ts: '' }, { ts: '', sha, ok: true, durationMs: 0, timedOut: false, reused: true });
  assert.equal(trees().length, 1, 'a reused run writes no tested-trees line');
});

test('a real gate run appends a tested-trees line: the head tree, the gate command, ok, at (a pass and a fail)', E2E, async () => {
  setMain(false);
  reset('none');
  const { rc, lines } = await runLogged(project());
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(runs(), 1);
  assert.ok(lines.some((l) => /gate green ✓ at [0-9a-f]{7}$/.test(l)), lines.join('\n'));
  const t = trees();
  assert.equal(t.length, 1);
  assert.deepEqual({ ...t[0], at: '' }, { tree: headTree(), command: GATE, ok: true, at: '' });
  assert.equal(t[0].at, readGate(stateDir).last!.at);
  assert.equal(readGateRuns(stateDir)[0].reused, undefined);

  setMain(true);
  reset('none');
  await runLogged(project(), true);
  assert.equal(readGate(stateDir).last?.ok, false);
  assert.deepEqual(trees().map((r) => [r.tree, r.command, r.ok]), [[headTree(), GATE, false]]);
  setMain(false);
});

test('not reused — each runs the full suite: a failing record, a pass then a fail, older than 2 h, another command, a red gate, no last result', E2E, async () => {
  setMain(false);
  const cases: [string, 'green' | 'red' | 'none', () => object[]][] = [
    ['a failing record', 'green', () => [rec({ ok: false })]],
    ['a pass followed by a later fail', 'green', () => [rec({ agoMs: 120_000 }), rec({ ok: false })]],
    ['a record older than 2 h', 'green', () => [rec({ agoMs: 2 * 3_600_000 + 60_000 })]],
    ['a record for another command', 'green', () => [rec({ command: 'npm test' })]],
    ['a record for another tree', 'green', () => [rec({ tree: 'f'.repeat(40) })]],
    ['the gate red', 'red', () => [rec()]],
    ['no last result', 'none', () => [rec()]],
  ];
  for (const [what, last, records] of cases) {
    const recs = records();
    reset(last, recs);
    const { lines } = await runLogged(project());
    assert.equal(runs(), 1, `${what}: the test command ran\n${lines.join('\n')}`);
    assert.equal(existsSync(setupRan), true, `${what}: the setup ran`);
    assert.ok(!lines.some((l) => /tree already tested/.test(l)), what);
    assert.equal(readGateRuns(stateDir)[0].reused, undefined, what);
    assert.equal(readGate(stateDir).last?.ok, true, what);
    assert.equal(trees().length, recs.length + 1, `${what}: the real run is recorded`);
  }
});

test('reuseTestedTrees false: the gate neither reads nor writes tested-trees.jsonl and never reuses', E2E, async () => {
  setMain(false);
  reset('green', [rec()]);
  const before = readFileSync(treesFile, 'utf8');
  const { lines } = await runLogged(project({ reuseTestedTrees: false }));
  assert.equal(runs(), 1, lines.join('\n'));
  assert.ok(!lines.some((l) => /tree already tested/.test(l)));
  assert.equal(readFileSync(treesFile, 'utf8'), before, 'nothing appended');
  reset('none');
  await runLogged(project({ reuseTestedTrees: false }));
  assert.equal(existsSync(treesFile), false, 'no file written');
});
