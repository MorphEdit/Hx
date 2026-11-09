// The gauntlet end to end: real git (a local bare origin), fake gh and claude.
//   critic FAIL → the reviser rewrites the PRD body → … → prd-hardened → decompose.
// The fake reviser adds an acceptance-criteria section when the engine check asks for one, so these tests turn the
// one-child path off (singleChildMaxCriteria 0) unless they are about it.
import { E2E, pooled, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-g-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');
const { CRITERIA_FINDING, countCriteria } = await import('../src/prd.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, singleChildMaxCriteria: 0, ...extra } });

const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const prd = (n: number, body: string) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels: [L.prd] });
const marked = (n: number, marker: string) => read().comments.filter((c: any) => c.issue === n && c.body.split('\n')[0] === marker);
const kids = (n: number) => read().issues.filter((i: any) => new RegExp(`## Parent\\n#${n}\\b`).test(i.body));

async function run(only: number[], extra = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, only, signal })), lines };
  } finally { console.log = orig; }
}

test('critic FAIL → reviser edits the body → critic PASS → prd-hardened → decompose', E2E, async () => {
  const original = 'Make search fast.\n\n## Blocked by\nNone\n';
  board([prd(1, original)]);
  const { rc, lines } = await run([1]);
  assert.equal(rc, 0, lines.join('\n'));
  const p = read().issues.find((i: any) => i.number === 1);
  assert.ok(p.labels.includes(L.hardened));
  assert.ok(!p.labels.includes(L.working) && !p.labels.includes(L.blocked), p.labels.join());
  assert.match(p.body, /## Assumptions[\s\S]*fake-revised/, 'the reviser rewrote the body');
  const orig = marked(1, '<!-- hx-prd-original -->');
  assert.equal(orig.length, 1);
  assert.equal(orig[0].body, `<!-- hx-prd-original -->\n${original}`);
  const g = marked(1, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 2);
  assert.match(g[0].body, /^<!-- hx-gauntlet -->\n\*\*hx gauntlet round 1\/2: FAIL ✗ → revised\*\*\n\n- PRD #1 says "fast"/);
  assert.match(g[1].body, /^<!-- hx-gauntlet -->\n\*\*hx gauntlet round 2\/2: PASS ✓\*\*/);
  assert.equal(kids(1).length, 2, 'decompose ran after the gauntlet');
  const passed = lines.findIndex((l) => /\[#1\] gauntlet round 2\/2: PASS/.test(l));
  const decomposed = lines.findIndex((l) => /\[#1\] decompose: /.test(l));
  assert.ok(passed > 0 && decomposed > passed, lines.join('\n'));
  const roles = readUsage(stateDir).filter((r) => r.issue === 1).map((r) => r.role);
  assert.deepEqual([...new Set(roles)].sort(), ['critic', 'decompose', 'revise']);
  const envs = sessionEnvs(fakeDir);
  assert.deepEqual([...new Set(envs.map((e) => e.role))].sort(), ['critic', 'decompose', 'revise']);
  for (const e of envs) assert.equal(e.trusted, 'me', JSON.stringify(e));
  assert.ok(!existsSync(path.join(tmp, 'wt', 'p1')), 'worktree removed');
});

test('the critic never passes: after gauntletRounds the PRD is hardened anyway and decomposed', E2E, async () => {
  board([prd(2, 'GAUNTLETNEVER: make it fast.\n')]);
  const { rc, lines } = await run([2], { gauntletRounds: 3 });
  assert.equal(rc, 0, lines.join('\n'));
  const p = read().issues.find((i: any) => i.number === 2);
  assert.ok(p.labels.includes(L.hardened));
  assert.ok(!p.labels.includes(L.working) && !p.labels.includes(L.blocked));
  const orig = marked(2, '<!-- hx-prd-original -->');
  assert.equal(orig.length, 1, 'the original body is kept once');
  assert.equal(orig[0].body, '<!-- hx-prd-original -->\nGAUNTLETNEVER: make it fast.\n');
  const g = marked(2, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 3);
  assert.ok(g.every((c: any, k: number) => c.body.includes(`round ${k + 1}/3: FAIL ✗ → revised`)));
  assert.match(g[2].body, /- PRD #2 says "fast" — two readings — body line 1/, 'the last comment holds the findings');
  assert.ok(lines.some((l) => /\[#2\] gauntlet round 3\/3 done — round cap reached, labelled prd-hardened/.test(l)), lines.join('\n'));
  assert.equal(kids(2).length, 2, 'decomposed');
});

test('a reviser that leaves the body unchanged: the round still counts, logged, not blocked', E2E, async () => {
  const body = 'REVISENOOP: make it fast.\n';
  board([prd(3, body)]);
  const { rc, lines } = await run([3]);
  assert.equal(rc, 0, lines.join('\n'));
  const p = read().issues.find((i: any) => i.number === 3);
  assert.equal(p.body, body);
  assert.ok(!p.labels.includes(L.blocked));
  assert.ok(p.labels.includes(L.hardened));
  assert.equal(lines.filter((l) => /\[#3\] reviser left the body unchanged — round \d counted, carrying on/.test(l)).length, 2, lines.join('\n'));
  const g = marked(3, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 2);
  assert.match(g[0].body, /left the body unchanged/);
  assert.equal(kids(3).length, 2, 'decomposed');
});

test('a critic that does not complete fails the PRD like any session: agent-blocked + comment', E2E, async () => {
  board([prd(4, 'make it fast')]);
  process.env.FAKE_CLAUDE_MODE = 'crash';
  try {
    const { rc } = await run([4]);
    assert.equal(rc, 1);
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
  const p = read().issues.find((i: any) => i.number === 4);
  assert.ok(p.labels.includes(L.blocked));
  assert.ok(!p.labels.includes(L.working) && !p.labels.includes(L.hardened));
  assert.ok(read().comments.some((c: any) => c.issue === 4 && /gauntlet stopped/.test(c.body)));
  assert.equal(kids(4).length, 0, 'not decomposed');
  assert.ok(!existsSync(path.join(tmp, 'wt', 'p4')), 'worktree removed');
});

test('gauntlet: false — a PRD is decomposed directly', E2E, async () => {
  board([prd(5, 'make it fast')]);
  const { rc } = await run([5], { gauntlet: false });
  assert.equal(rc, 0);
  assert.equal(marked(5, '<!-- hx-gauntlet -->').length, 0);
  assert.equal(kids(5).length, 2);
});

test('hx init creates prd-hardened; hx status prints the gauntlet status', E2E, () => {
  const app = path.join(tmp, 'cli');
  git(tmp, 'clone', '-q', origin, app);
  board([prd(6, 'make it fast')]);
  const hx = (...args: string[]) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), ...args], { cwd: app, encoding: 'utf8' });
  const init = hx('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.ok(read().labels.includes(L.hardened), JSON.stringify(read().labels));
  assert.match(init.stdout, /labels .*prd-hardened/);
  const st = hx('status');
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /PRD #6\s+gauntlet\s+feature 6/);
});

// the engine check (PRD #436): a PRD with no counted acceptance criteria fails the round whatever the critic said
const PASSING = '<!-- fake-revised -->'; // the fake critic passes a body that holds the fake reviser's marker
const failLines = (lines: string[], n: number) => lines.filter((l) => l.includes(`[#${n}] gauntlet round`) && / FAIL /.test(l))
  .map((l) => l.slice(l.indexOf('gauntlet round')));

test('engine check: no criteria section and a critic PASS → FAIL, the reviser gets the engine finding alone and adds the section', E2E, async () => {
  board([prd(7, `Make search fast.\n${PASSING}\n`)]);
  const { rc, lines } = await run([7], { singleChildMaxCriteria: 15 });
  assert.equal(rc, 0, lines.join('\n'));
  const g = marked(7, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 2);
  assert.equal(g[0].body, `<!-- hx-gauntlet -->\n**hx gauntlet round 1/2: FAIL ✗ → revised**\n\n${CRITERIA_FINDING}`, 'the critic\'s "none" is dropped');
  assert.match(g[1].body, /^<!-- hx-gauntlet -->\n\*\*hx gauntlet round 2\/2: PASS ✓\*\*/);
  assert.deepEqual(failLines(lines, 7), [`gauntlet round 1/2: FAIL ✗ — ${CRITERIA_FINDING}`]);
  const p = read().issues.find((i: any) => i.number === 7);
  assert.equal(countCriteria(p.body), 1, 'the reviser added the section');
  assert.ok(p.labels.includes(L.hardened));
  assert.equal(marked(7, '<!-- hx-prd-original -->').length, 1);
  assert.equal(kids(7).length, 1, 'the one-child path applies to the hand-written PRD');
  assert.match(kids(7)[0].body, /## Acceptance criteria\n- \[ \] search answers under 1s/);
});

test('engine check: an empty criteria section is treated the same way', E2E, async () => {
  board([prd(8, `Make search fast.\n\n## Acceptance criteria\n\nto do\n\n## Notes\n- keep it\n${PASSING}\n`)]);
  const { rc, lines } = await run([8]);
  assert.equal(rc, 0, lines.join('\n'));
  const g = marked(8, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 2);
  assert.equal(g[0].body, `<!-- hx-gauntlet -->\n**hx gauntlet round 1/2: FAIL ✗ → revised**\n\n${CRITERIA_FINDING}`);
  assert.match(g[1].body, /round 2\/2: PASS ✓/);
  assert.deepEqual(failLines(lines, 8), [`gauntlet round 1/2: FAIL ✗ — ${CRITERIA_FINDING}`]);
  assert.equal(countCriteria(read().issues.find((i: any) => i.number === 8).body), 1);
});

test('engine check: a counted criteria section and a critic PASS → prd-hardened, no reviser session', E2E, async () => {
  board([prd(9, `Make search fast.\n\n## Acceptance criteria\n- [ ] answers under 1s\n${PASSING}\n`)]);
  const { rc, lines } = await run([9]);
  assert.equal(rc, 0, lines.join('\n'));
  const g = marked(9, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 1);
  assert.match(g[0].body, /round 1\/2: PASS ✓\*\*\n\n- none$/);
  assert.ok(read().issues.find((i: any) => i.number === 9).labels.includes(L.hardened));
  assert.equal(marked(9, '<!-- hx-prd-original -->').length, 0);
  assert.ok(!readUsage(stateDir).some((r) => r.issue === 9 && r.role === 'revise'), 'no reviser');
  assert.deepEqual(failLines(lines, 9), []);
});

test('engine check on the last round: a critic FAIL gets the engine finding last, the reviser runs before prd-hardened', E2E, async () => {
  board([prd(10, 'Make search fast.\n')]);
  const { rc, lines } = await run([10], { gauntletRounds: 1 });
  assert.equal(rc, 0, lines.join('\n'));
  const g = marked(10, '<!-- hx-gauntlet -->');
  assert.equal(g.length, 1);
  assert.equal(g[0].body, `<!-- hx-gauntlet -->\n**hx gauntlet round 1/1: FAIL ✗ → revised**\n\n- PRD #10 says "fast" — two readings — body line 1\n${CRITERIA_FINDING}`);
  assert.deepEqual(failLines(lines, 10), [`gauntlet round 1/1: FAIL ✗ — ${CRITERIA_FINDING}`]);
  assert.ok(lines.some((l) => /\[#10\] gauntlet round 1\/1 done — round cap reached, labelled prd-hardened/.test(l)), lines.join('\n'));
  const p = read().issues.find((i: any) => i.number === 10);
  assert.equal(countCriteria(p.body), 1, 'the section is there before decompose');
  assert.ok(p.labels.includes(L.hardened));
  assert.ok(readUsage(stateDir).some((r) => r.issue === 10 && r.role === 'revise'));
  assert.equal(kids(10).length, 2, 'decomposed');
});

test('engine check: gauntlet false — no check, a PRD with no criteria is decomposed as today', E2E, async () => {
  board([prd(11, 'Make search fast.\n')]);
  const { rc } = await run([11], { gauntlet: false, singleChildMaxCriteria: 15 });
  assert.equal(rc, 0);
  assert.equal(marked(11, '<!-- hx-gauntlet -->').length, 0);
  assert.equal(countCriteria(read().issues.find((i: any) => i.number === 11).body), 0);
  assert.equal(kids(11).length, 2, 'decomposed');
});
