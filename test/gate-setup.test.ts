// The CI gate runs the worktree setup (config.worktreeSetup) in its worktree before the gate command, and
// retries a failed setup at once, up to 3 tries in a row at one sha, before the gate turns red.
// Real git (a local bare origin), fake gh and claude.
import { E2E, pooled, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-gs-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { gateIssueBody, gateIssueTitle, readGate } = await import('../src/gate.ts');

const L = DEFAULTS.labels;
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
const helper = path.join(tmp, 'helper'); // a second clone that moves main while a gate check runs
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
writeFileSync(path.join(root, 'README.md'), 'app\n');
git(root, 'add', '-A');
git(root, ...gitId, 'commit', '-q', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
git(tmp, 'clone', '-q', origin, helper);
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const exclude = path.join(root, '.git', 'info', 'exclude');
writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');

const fwd = (p: string) => p.replace(/\\/g, '/');
const script = (name: string, body: string) => { const f = path.join(tmp, name); writeFileSync(f, body); return `node "${fwd(f)}"`; };
/** main with or without a BROKEN file (the failing setups below fail while it exists). */
function setMain(broken: boolean) {
  git(root, 'pull', '-q', 'origin', 'main');
  const f = path.join(root, 'BROKEN');
  if (broken === existsSync(f)) return;
  if (broken) writeFileSync(f, 'x\n'); else rmSync(f);
  git(root, 'add', '-A');
  git(root, ...gitId, 'commit', '-q', '-m', broken ? 'break the setup' : 'unbreak');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
}
/** A gate command that appends one line to `runs` (outside the worktree) per run and passes. */
const countingGate = (runs: string) => `node -e "require('fs').appendFileSync('${fwd(runs)}', 'run\\n')"`;
const project = (extra: object) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, ...extra } });
async function runLogged(p: ReturnType<typeof project>, opts: { watch?: boolean; signal?: AbortSignal; onLine?: (l: string) => void } = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); opts.onLine?.(m); orig(m); };
  const rc = await pooled((signal) => runPool(p, { workers: 1, watch: !!opts.watch, dryRun: false, signal }), opts.signal)
    .finally(() => { console.log = orig; });
  return { rc, lines };
}
const gateJson = () => { try { return readFileSync(path.join(stateDir, 'gate.json'), 'utf8'); } catch { return ''; } };
const fixIssues = () => JSON.parse(readFileSync(stateFile, 'utf8')).issues.filter((i: any) => /^Default branch is red/.test(i.title));

test('the gate runs worktreeSetup in its worktree before the gate command: a marker the setup writes makes it green', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const setup = `node -e "require('fs').writeFileSync('MARKER', 'ok')"`;
  const gate = `node -e "process.exit(require('fs').existsSync('MARKER') ? 0 : 1)"`;
  const { rc, lines } = await runLogged(project({ gateCommand: gate, worktreeSetup: setup }));
  assert.equal(rc, 0, lines.join('\n'));
  const g = readGate(stateDir);
  assert.equal(g.last?.ok, true, lines.join('\n'));
  assert.equal(g.last?.setupFailed, undefined);
  assert.equal(g.last?.command, gate);
  assert.ok(lines.some((l) => l.includes(`gate: setup: ${setup} (`)), lines.join('\n'));
  assert.ok(!existsSync(path.join(stateDir, 'logs', 'setup-gate.json')), 'the gate never writes a setup record');
  assert.equal(fixIssues().length, 0);
});

test('with worktreeSetup unset the gate logs nothing about setup', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const { rc, lines } = await runLogged(project({ gateCommand: `node -e "process.exit(0)"`, worktreeSetup: '', worktreeCopy: [] }));
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(readGate(stateDir).last?.ok, true);
  assert.ok(!lines.some((l) => /gate: setup/.test(l)), lines.join('\n'));
});

test('a setup that fails twice then succeeds: retried at once, the gate command runs once and the gate is green', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const count = path.join(tmp, 'flaky.count');
  const runs = path.join(tmp, 'flaky.runs');
  const setup = script('flaky.mjs', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const f = ${JSON.stringify(count)};
const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1;
writeFileSync(f, String(n));
if (n <= 2) { console.log('registry timeout ' + n); process.exit(1); }
`);
  const before = gateJson();
  const between: string[] = [];
  const { rc, lines } = await runLogged(project({ gateCommand: countingGate(runs), worktreeSetup: setup }),
    { onLine: (l) => { if (/gate: setup FAILED/.test(l)) between.push(gateJson()); } });
  assert.equal(rc, 0, lines.join('\n'));
  const failed = lines.filter((l) => /gate: setup FAILED/.test(l));
  assert.equal(failed.length, 2, lines.join('\n'));
  assert.match(failed[0], /gate: setup FAILED \(exit 1, try 1 of 3\): registry timeout 1/);
  assert.match(failed[1], /gate: setup FAILED \(exit 1, try 2 of 3\): registry timeout 2/);
  assert.deepEqual(between, [before, before], 'gate.json keeps the previous result between tries');
  assert.equal(readFileSync(runs, 'utf8'), 'run\n', 'the gate command ran once');
  const g = readGate(stateDir);
  assert.equal(g.last?.ok, true);
  assert.equal('setupFailed' in (g.last ?? {}), false);
  assert.equal(fixIssues().length, 0, 'no fix issue');
  assert.ok(!lines.some((l) => /gate RED/.test(l)));
});

test('a setup that always fails: red after 3 tries at one sha, one fix issue naming the setup command and worktreeSetup', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  setMain(true);
  const runs = path.join(tmp, 'red.runs');
  const setup = script('red.mjs', `import { existsSync } from 'node:fs';
if (existsSync('BROKEN')) { for (let i = 1; i <= 70; i++) console.log('npm ERR line ' + i); process.exit(1); }
`);
  const before = gateJson();
  const between: string[] = [];
  let atRed: { gate: string; live: any; ran: boolean } | undefined;
  const { rc, lines } = await runLogged(project({ gateCommand: countingGate(runs), worktreeSetup: setup }), {
    onLine: (l) => {
      if (/gate: setup FAILED/.test(l)) between.push(gateJson());
      // the fix session starts after the startup gate check wrote its result
      if (!atRed && /\] impl:/.test(l)) atRed = { gate: gateJson(), ran: existsSync(runs), live: JSON.parse(readFileSync(path.join(stateDir, 'live.json'), 'utf8')) };
    },
  });
  assert.equal(rc, 0, lines.join('\n'));
  const failed = lines.filter((l) => /gate: setup FAILED/.test(l));
  assert.equal(failed.length, 3, lines.join('\n'));
  for (let k = 1; k <= 3; k++) assert.match(failed[k - 1], new RegExp(`gate: setup FAILED \\(exit 1, try ${k} of 3\\): .*npm ERR line 70`));
  assert.deepEqual(between, [before, before, before], 'gate.json keeps the previous result between tries');

  assert.ok(atRed, lines.join('\n'));
  const red = JSON.parse(atRed.gate).last;
  assert.equal(red.ok, false);
  assert.equal(red.setupFailed, true);
  assert.equal(red.command, setup);
  assert.match(red.output, /^worktree setup failed: /);
  assert.match(red.output, /npm ERR line 70$/);
  assert.ok(!/npm ERR line 10\n/.test(red.output), 'the last 60 lines only');
  assert.equal(atRed.ran, false, 'the gate command never ran while the setup failed');
  assert.equal(atRed.live.gate.ok, false);
  assert.equal(atRed.live.gate.sha, red.sha);

  const fixes = fixIssues();
  assert.equal(fixes.length, 1, 'exactly one fix issue');
  assert.ok(fixes[0].title.includes(setup), fixes[0].title);
  assert.match(fixes[0].title, /worktreeSetup/);
  assert.ok(fixes[0].body.includes(`\`${setup}\``));
  assert.match(fixes[0].body, /`worktreeSetup`/);
  assert.match(fixes[0].body, /npm ERR line 70/);
  assert.match(fixes[0].body, /## Blocked by\nNone\n$/);
  assert.deepEqual(fixes[0].labels.sort(), [L.gateFix, L.ready].sort());
  // the fix (the fake removes BROKEN) lands: the setup passes, the gate command runs, the gate is green again
  assert.ok(lines.some((l) => /gate green ✓ again/.test(l)), lines.join('\n'));
  assert.ok(existsSync(runs), 'the gate command ran once the setup passed');
  assert.equal(readGate(stateDir).last?.ok, true);
});

test('the sha changes between setup tries: the count restarts at 1', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  setMain(true);
  const moved = path.join(tmp, 'moved');
  // the first try moves main (a merge lands meanwhile), and every try fails while BROKEN exists
  const setup = script('moving.mjs', `import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(moved)})) {
  writeFileSync(${JSON.stringify(moved)}, 'x');
  const g = (...a) => execFileSync('git', a, { cwd: ${JSON.stringify(helper)}, stdio: 'pipe' });
  g('pull', '-q', 'origin', 'main'); writeFileSync(${JSON.stringify(path.join(helper, 'more.txt'))}, 'more');
  g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'meanwhile'); g('push', '-q', 'origin', 'HEAD:main');
}
if (existsSync('BROKEN')) { console.log('broken'); process.exit(1); }
`);
  const { rc, lines } = await runLogged(project({ gateCommand: `node -e "process.exit(0)"`, worktreeSetup: setup }));
  assert.equal(rc, 0, lines.join('\n'));
  const tries = lines.filter((l) => /gate: setup FAILED/.test(l)).map((l) => /try (\d) of 3/.exec(l)?.[1]);
  assert.deepEqual(tries.slice(0, 4), ['1', '1', '2', '3'], lines.join('\n'));
  assert.equal(fixIssues().length, 1, 'one fix issue for this red');
  assert.equal(readGate(stateDir).last?.ok, true);
});

test('Ctrl+C during the gate setup: no gate.json written, no fix issue, no setup FAILED line', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  const pidFile = fwd(path.join(tmp, 'setup-abort.pid'));
  const setup = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60e3)"`;
  const before = gateJson();
  const ac = new AbortController();
  const poll = setInterval(() => {
    try { readFileSync(pidFile, 'utf8'); } catch { return; }
    clearInterval(poll); ac.abort();
  }, 50);
  const { lines } = await runLogged(project({ gateCommand: `node -e "process.exit(0)"`, worktreeSetup: setup }), { watch: true, signal: ac.signal })
    .finally(() => clearInterval(poll));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0 && !alive(pid), `the setup process ${pid} is not left running`);
  assert.equal(gateJson(), before, 'gate.json has no new result');
  assert.ok(!lines.some((l) => /setup FAILED|gate (RED|green)/.test(l)), lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).issues.length, 0, 'no fix issue filed');
});

test('gateIssueTitle / gateIssueBody: a setupFailed result names the setup command and worktreeSetup, not the test command', E2E, () => {
  const r = { sha: 'abcdef1234', ok: false, command: 'npm ci', output: 'worktree setup failed: ERR', setupFailed: true, at: '' };
  assert.equal(gateIssueTitle('main', r), 'Default branch is red: the worktree setup `npm ci` (worktreeSetup) fails on main at abcdef1');
  const body = gateIssueBody('main', r);
  assert.match(body, /`npm ci` \(the `worktreeSetup` config\)/);
  assert.match(body, /not the test command/);
  assert.match(body, /worktree setup failed: ERR/);
  assert.match(body, /## Blocked by\nNone\n$/);
  const t = { ...r, command: 'npm test', setupFailed: undefined };
  assert.equal(gateIssueTitle('main', t), 'Default branch is red: `npm test` fails on main at abcdef1');
  assert.doesNotMatch(gateIssueBody('main', t), /worktreeSetup/);
});
