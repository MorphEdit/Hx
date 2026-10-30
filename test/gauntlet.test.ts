// The gauntlet end to end: real git (a local bare origin), fake gh and claude.
//   critic FAIL → the reviser rewrites the PRD body → … → prd-hardened → decompose.
import { E2E } from './isolate.ts';
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
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');

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
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...extra } });

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
    return { rc: await runPool(project(extra), { workers: 1, watch: false, dryRun: false, only, signal: new AbortController().signal }), lines };
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
