// .hx/tested-trees.jsonl (#351): the record module, ship.mjs's records and --resume's skip (real git, a local bare
// origin, the fake gh), the reuseTestedTrees key, and HX_TESTED_TREES in the env of hx's sessions and its ship --resume.
import { E2E, pooled, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIP = path.join(here, '..', 'scripts', 'ship.mjs');
const FAKE_GH = path.join(here, 'fakes', 'gh.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tt-'));

const { appendTestedTree, latestTreeRecord, passedTree, readTestedTrees, reuseTestedTreesError, testedTreesEnv } = await import('../src/tested.ts');
const { DEFAULTS } = await import('../src/config.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---- the module ----

test('readTestedTrees skips malformed lines; only the latest record for a tree and command counts, and only a pass is reused', E2E, () => {
  const f = path.join(tmp, 'unit.jsonl');
  assert.deepEqual(readTestedTrees(f), [], 'a missing file is no records');
  const at = '2026-11-06T10:00:00.000Z';
  appendTestedTree(f, { tree: 'aaa', command: 'npm test', ok: true, at });
  appendFileSync(f, 'not json\n{"tree":"aaa"}\n\n{"tree":"aaa","command":"npm test","ok":"yes","at":"x"}\n');
  appendTestedTree(f, { tree: 'bbb', command: 'npm test', ok: false, at });
  appendTestedTree(f, { tree: 'ccc', command: 'npm test', ok: true, at });
  appendTestedTree(f, { tree: 'ccc', command: 'npm test', ok: false, at: '2026-11-06T11:00:00.000Z' });
  assert.equal(readTestedTrees(f).length, 4, 'malformed lines skipped');
  assert.deepEqual(passedTree(f, 'aaa', 'npm test'), { tree: 'aaa', command: 'npm test', ok: true, at });
  assert.equal(passedTree(f, 'aaa', 'npm run test'), null, 'a pass for another command is not reused');
  assert.equal(passedTree(f, 'bbb', 'npm test'), null, 'a failing latest record is not reused');
  assert.equal(passedTree(f, 'ccc', 'npm test'), null, 'a pass followed by a later fail is not reused');
  assert.equal(latestTreeRecord(readTestedTrees(f), 'ccc', 'npm test')?.at, '2026-11-06T11:00:00.000Z');
  assert.equal(passedTree(f, 'ddd', 'npm test'), null);
  // appended, never rewritten: the first line is still there
  assert.match(readFileSync(f, 'utf8').split('\n')[0], /"tree":"aaa"/);
});

test('reuseTestedTrees: default true; true → HX_TESTED_TREES the absolute path, false → none; a non-boolean is refused', E2E, () => {
  assert.equal(DEFAULTS.reuseTestedTrees, true);
  assert.deepEqual(testedTreesEnv('x/.hx', { reuseTestedTrees: true }), { HX_TESTED_TREES: path.resolve('x/.hx', 'tested-trees.jsonl') });
  assert.ok(path.isAbsolute(testedTreesEnv('.hx', { reuseTestedTrees: true }).HX_TESTED_TREES));
  assert.deepEqual(testedTreesEnv('x/.hx', { reuseTestedTrees: false }), {});
  for (const v of [undefined, true, false]) assert.equal(reuseTestedTreesError(v), null, String(v));
  for (const v of ['yes', 1, 0, null, 'true']) assert.match(reuseTestedTreesError(v) ?? '', /^reuseTestedTrees: .* must be true or false$/, String(v));
});

// ---- ship.mjs ----

let k = 0;
function setup() {
  const dir = path.join(tmp, `s${++k}`);
  mkdirSync(dir);
  const origin = path.join(dir, 'origin.git'), wt = path.join(dir, 'wt'), other = path.join(dir, 'other');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, wt);
  writeFileSync(path.join(wt, 'a.txt'), 'one\n');
  git(wt, 'add', '-A'); git(wt, ...gitId, 'commit', '-q', '-m', 'init'); git(wt, 'push', '-q', 'origin', 'HEAD:main');
  git(wt, 'checkout', '-q', '-b', 'issue/7');
  git(dir, 'clone', '-q', origin, other);
  const board = path.join(dir, 'board.json');
  writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: [{ number: 7, title: 't', body: '', state: 'OPEN', labels: [] }] }));
  writeFileSync(path.join(wt, 'c.txt'), 'mine\n');
  const marker = path.join(dir, 'ran.txt');
  return { dir, wt, other, board, trees: path.join(dir, 'tested-trees.jsonl'), marker,
    // a passing test command that appends a line to the marker each time it runs
    cmd: `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, '/')}', 'x\\n')"` };
}
type Env = ReturnType<typeof setup>;
const shipRun = (e: Env, extra: string[], o: { trees?: boolean; env?: Record<string, string> } = {}) =>
  spawnSync(process.execPath, [SHIP, ...extra], { cwd: e.wt, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, HX_FAKE_STATE: e.board, HX_GH_BIN: FAKE_GH, ...(o.trees === false ? {} : { HX_TESTED_TREES: e.trees }), ...o.env } });
const args = (cmd: string, ...more: string[]) => ['--repo', 'me/app', '--base', 'main', '--issue', '7', '--title', 'feat: thing', '--test', cmd, ...more];
const records = (e: Env) => (existsSync(e.trees) ? readFileSync(e.trees, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const runs = (e: Env) => (existsSync(e.marker) ? readFileSync(e.marker, 'utf8').split('\n').filter(Boolean).length : 0);
const treeOf = (e: Env) => git(e.wt, 'rev-parse', 'HEAD^{tree}');
const board = (e: Env) => JSON.parse(readFileSync(e.board, 'utf8'));
const land = (e: Env, file: string) => {
  writeFileSync(path.join(e.other, file), 'theirs\n');
  git(e.other, 'add', '-A'); git(e.other, ...gitId, 'commit', '-q', '-m', `land ${file}`); git(e.other, 'push', '-q', 'origin', 'HEAD:main');
};
const SKIPPED = /^ship: tests: tree ([0-9a-f]{7}) already passed \((\S+)\) — skipped$/m;

test('ship --no-merge appends one record: the HEAD\'s tree, the --test command, ok true, an ISO at', E2E, () => {
  const e = setup();
  const r = shipRun(e, args(e.cmd, '--no-merge'));
  assert.equal(r.status, 0, r.stderr);
  const recs = records(e);
  assert.equal(recs.length, 1);
  assert.deepEqual(Object.keys(recs[0]), ['tree', 'command', 'ok', 'at']);
  assert.equal(recs[0].tree, treeOf(e));
  assert.equal(recs[0].command, e.cmd);
  assert.equal(recs[0].ok, true);
  assert.match(recs[0].at, ISO);
});

test('ship: a failing run and a timed-out run each append ok false', E2E, () => {
  const e = setup();
  const fail = 'node -e "process.exit(1)"';
  const r = shipRun(e, args(fail));
  assert.equal(r.status, 4, r.stderr);
  assert.deepEqual(records(e).map((x) => [x.tree, x.command, x.ok]), [[treeOf(e), fail, false]]);
  const hang = 'node -e "setInterval(() => {}, 1e3)"';
  const t = shipRun(e, args(hang), { env: { HX_SHIP_TEST_TIMEOUT_MS: '3000' } });
  assert.equal(t.status, 4, t.stderr);
  assert.match(t.stderr, /tests timed out/);
  assert.deepEqual(records(e).map((x) => [x.command, x.ok]), [[fail, false], [hang, false]]);
});

test('ship --resume on an unmoved base skips the tests with the log line, writes no record, and still merges', E2E, () => {
  const e = setup();
  assert.equal(shipRun(e, args(e.cmd, '--no-merge')).status, 0);
  assert.equal(runs(e), 1);
  const at = records(e)[0].at;
  const r = shipRun(e, ['--resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runs(e), 1, 'the test command did not run again');
  const m = SKIPPED.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.equal(m![1], treeOf(e).slice(0, 7));
  assert.equal(m![2], at);
  assert.doesNotMatch(r.stdout, /tests pass/);
  assert.equal(records(e).length, 1, 'a skipped step writes no record');
  assert.match(r.stdout, /SHIPPED #7 via PR #100/);
  assert.equal(board(e).prs[0].state, 'MERGED');
});

test('ship --resume on a moved base runs the tests and appends a record for the new tree', E2E, () => {
  const e = setup();
  assert.equal(shipRun(e, args(e.cmd, '--no-merge')).status, 0);
  const first = records(e)[0].tree;
  land(e, 'b.txt');
  const r = shipRun(e, ['--resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /already passed/);
  assert.equal(runs(e), 2);
  const recs = records(e);
  assert.equal(recs.length, 2);
  assert.notEqual(recs[1].tree, first);
  assert.equal(recs[1].tree, treeOf(e));
  assert.equal(recs[1].ok, true);
  assert.equal(board(e).prs[0].state, 'MERGED');
});

test('ship --resume runs the tests when the latest record is a fail, a pass then a later fail, or a pass for another command', E2E, () => {
  const cases: [string, (tree: string, cmd: string) => object[]][] = [
    ['a failing latest record', (tree, cmd) => [{ tree, command: cmd, ok: false, at: '2026-11-06T10:00:00.000Z' }]],
    ['a pass, then a later fail', (tree, cmd) => [{ tree, command: cmd, ok: true, at: '2026-11-06T10:00:00.000Z' }, { tree, command: cmd, ok: false, at: '2026-11-06T11:00:00.000Z' }]],
    ['a pass for another command', (tree) => [{ tree, command: 'npm run other', ok: true, at: '2026-11-06T10:00:00.000Z' }]],
  ];
  for (const [what, recs] of cases) {
    const e = setup();
    // --no-merge without the variable: no record from it
    assert.equal(shipRun(e, args(e.cmd, '--no-merge'), { trees: false }).status, 0, what);
    assert.ok(!existsSync(e.trees), what);
    writeFileSync(e.trees, recs(treeOf(e), e.cmd).map((x) => JSON.stringify(x) + '\n').join(''));
    const r = shipRun(e, ['--resume']);
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /already passed/, what);
    assert.equal(runs(e), 2, what);
    assert.deepEqual(records(e).at(-1), { ...records(e).at(-1), tree: treeOf(e), command: e.cmd, ok: true }, what);
  }
});

test('ship --no-merge and a plain ship never skip, even on a tree that already passed', E2E, () => {
  const e = setup();
  assert.equal(shipRun(e, args(e.cmd, '--no-merge')).status, 0);
  assert.equal(shipRun(e, args(e.cmd, '--no-merge')).status, 0);
  assert.equal(runs(e), 2);
  const r = shipRun(e, args(e.cmd));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /already passed/);
  assert.equal(runs(e), 3);
  assert.equal(records(e).length, 3);
});

test('ship with HX_TESTED_TREES unset neither writes the file nor skips', E2E, () => {
  const e = setup();
  assert.equal(shipRun(e, args(e.cmd, '--no-merge'), { trees: false }).status, 0);
  const r = shipRun(e, ['--resume'], { trees: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runs(e), 2);
  assert.doesNotMatch(r.stdout, /already passed/);
  assert.ok(!existsSync(e.trees));
});

// ---- hx sets HX_TESTED_TREES ----

const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = FAKE_GH;
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
const { runPool } = await import('../src/pool.ts');
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, ...gitId, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, gate: false, sizeCheck: false, ...extra } });
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
// a test command that appends its HX_TESTED_TREES to <out> as it runs
const envScript = path.join(tmp, 'envout.mjs');
writeFileSync(envScript, `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify(process.env.HX_TESTED_TREES ?? null) + '\\n');
`);
const seen = (out: string): (string | null)[] => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

async function hxRun(n: number, extra: Record<string, unknown>) {
  rmSync(fakeDir, { recursive: true, force: true }); mkdirSync(fakeDir);
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [{ number: n, title: `task ${n}`, body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] }] }));
  const out = path.join(tmp, `ship-${n}.jsonl`);
  process.env.FAKE_SHIP_TEST = `node "${envScript}" "${out}"`;
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    const rc = await pooled((signal) => runPool(project(extra) as any, { workers: 1, watch: false, dryRun: false, only: [n], signal }));
    assert.equal(rc, 0, lines.join('\n'));
  } finally { console.log = orig; delete process.env.FAKE_SHIP_TEST; }
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.equal(s.prs[0].state, 'MERGED');
  return { out, lines };
}

test('hx run: every session gets HX_TESTED_TREES; hx\'s own ship --resume gets it too and skips the tree the implementer\'s ship passed', E2E, async () => {
  const file = path.resolve(stateDir, 'tested-trees.jsonl');
  rmSync(file, { force: true });
  const { out } = await hxRun(11, {});
  const envs = sessionEnvs(fakeDir);
  assert.ok(envs.some((x) => x.role === 'implement') && envs.some((x) => x.role === 'audit'), JSON.stringify(envs));
  for (const x of envs) assert.equal(x.testedTrees, file, JSON.stringify(x));
  // the implementer's ship --no-merge ran the tests (with the variable) and recorded them; hx's ship --resume, given the
  // variable, found that pass for the unmoved tree and did not run them again
  assert.deepEqual(seen(out), [file]);
  const recs = readTestedTrees(file);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].ok, true);
  assert.equal(recs[0].command, `node "${envScript}" "${out}"`);
  assert.equal(process.env.HX_TESTED_TREES, undefined, 'the test process has none: hx set it');
});

test('hx run with reuseTestedTrees false: no session and no ship --resume gets HX_TESTED_TREES; the tests run twice, nothing recorded', E2E, async () => {
  const file = path.resolve(stateDir, 'tested-trees.jsonl');
  rmSync(file, { force: true });
  const { out } = await hxRun(12, { reuseTestedTrees: false });
  const envs = sessionEnvs(fakeDir);
  assert.ok(envs.length > 0);
  for (const x of envs) assert.equal(x.testedTrees, null, JSON.stringify(x));
  assert.deepEqual(seen(out), [null, null]);
  assert.ok(!existsSync(file));
});

test('hx run with reuseTestedTrees "yes" stops at start (exit 2) with the key named, before claiming anything', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [{ number: 13, title: 't', body: '', state: 'OPEN', labels: [DEFAULTS.labels.ready] }] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  let rc: number;
  try { rc = await pooled((signal) => runPool(project({ reuseTestedTrees: 'yes' }) as any, { workers: 1, watch: false, dryRun: false, only: [13], signal })); }
  finally { console.log = orig; }
  assert.equal(rc, 2);
  assert.ok(lines.some((l) => /STOPPED: reuseTestedTrees: "yes" must be true or false/.test(l)), lines.join('\n'));
  assert.equal(read().issues[0].state, 'OPEN');
});

test('docs: the reuseTestedTrees config row names the gate\'s 2 h; the ship section names the record file and --resume\'s skip; ship.mjs\'s header too', E2E, () => {
  const guide = readFileSync(path.join(here, '..', 'docs', 'guide.md'), 'utf8');
  const row = /^\| `reuseTestedTrees` \| `true` \|.*$/m.exec(guide)?.[0] ?? '';
  for (const w of ['HX_TESTED_TREES', '.hx/tested-trees.jsonl', 'ship --resume', '2 h', '`false`']) assert.ok(row.includes(w), w);
  const audited = guide.slice(guide.indexOf('## Every PR is audited before it merges'), guide.indexOf('\n## CI gate'));
  for (const w of ['.hx/tested-trees.jsonl', 'already passed', 'reuseTestedTrees']) assert.ok(audited.includes(w), w);
  const header = readFileSync(SHIP, 'utf8').split('\nimport ')[0];
  for (const w of ['HX_TESTED_TREES', 'tested-trees.jsonl', 'already passed']) assert.ok(header.includes(w), w);
});
