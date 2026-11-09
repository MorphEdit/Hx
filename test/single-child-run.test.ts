// The one-child path end to end (PRD #422, #425): real git (a local bare origin), fake gh and claude.
//   a small PRD → hx files `Implement PRD #<n>: <title>` itself, no decompose session; a big one decomposes as before.
import { E2E, pooled, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-1c-'));
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
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, workers: 2, autoWorkers: false, ...extra } });

const criteria = (n: number) => `## Acceptance criteria\n\n${Array.from({ length: n }, (_, k) => `- [ ] criterion ${k + 1}\n  - detail ${k + 1}`).join('\n')}`;
const prdBody = (n: number) => `## Problem\n\nslow\n\n${criteria(n)}\n\n## Edge cases\n\n- none\n`;
const prd = (n: number, body: string, labels = [L.prd, L.hardened]) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels });
const board = (issues: any[], extra = {}) => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues, ...extra }));
  for (const f of readdirSync(fakeDir)) rmSync(path.join(fakeDir, f), { recursive: true, force: true });
  rmSync(path.join(stateDir, 'logs'), { recursive: true, force: true });
  rmSync(path.join(stateDir, 'run.log'), { force: true });
};
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const kids = (n: number) => read().issues.filter((i: any) => new RegExp(`## Parent\\n#${n}\\b`).test(i.body));
const runLog = () => (existsSync(path.join(stateDir, 'run.log')) ? readFileSync(path.join(stateDir, 'run.log'), 'utf8') : '');
const roles = (n: number) => readUsage(stateDir).filter((r) => r.issue === n).map((r) => r.role);

async function run(only: number[], extra = {}, workers = (extra as any).workers ?? 2) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers, watch: false, dryRun: false, only, signal })), lines };
  } finally { console.log = orig; }
}

/** PRD `n` (`count` criteria) got exactly one engine-filed child and no decompose session; the run log and the PRD's comment say `reason`. */
function oneChild(n: number, count: number, reason: string) {
  const k = kids(n);
  assert.equal(k.length, 1, JSON.stringify(k));
  assert.equal(k[0].title, `Implement PRD #${n}: feature ${n}`);
  assert.deepEqual(k[0].labels, [L.ready]);
  assert.ok(k[0].body.startsWith(`${criteria(count)}\n\n`), k[0].body);
  assert.match(k[0].body, /## Blocked by\nNone\n\n## Parent\n#\d+\n$/);
  const line = `prd #${n}: one child #${k[0].number} (${reason}) — no decompose`;
  assert.ok(runLog().includes(`[#${n}] ${line}\n`), runLog());
  assert.deepEqual(read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body), [line]);
  assert.ok(!roles(n).includes('decompose'), roles(n).join());
  assert.ok(!sessionEnvs(fakeDir).some((e) => e.role === 'decompose'), 'no decompose session');
  assert.ok(!/decompose/.test(runLog().split('\n').filter((l) => l.includes(`[#${n}]`) && !l.includes('no decompose')).join('\n')), runLog());
  assert.ok(!existsSync(path.join(stateDir, 'logs', `decompose-${n}.jsonl`)), 'no decompose session log');
}

test('a hardened PRD with at most singleChildMaxCriteria criteria gets one engine-filed child, no decompose session', E2E, async () => {
  board([prd(1, prdBody(15))]);
  const { rc, lines } = await run([1]);
  assert.equal(rc, 0, lines.join('\n'));
  oneChild(1, 15, '≤ 15 acceptance criteria');
  assert.equal(readUsage(stateDir).length, 0, 'no session was counted');
});

test('gauntlet: false — a PRD without prd-hardened takes the one-child path too', E2E, async () => {
  board([prd(2, prdBody(3), [L.prd])]);
  const { rc, lines } = await run([2], { gauntlet: false });
  assert.equal(rc, 0, lines.join('\n'));
  oneChild(2, 3, '≤ 15 acceptance criteria');
  assert.ok(!read().issues.find((i: any) => i.number === 2).labels.includes(L.hardened));
});

test('a PRD above the threshold still goes through decompose', E2E, async () => {
  board([prd(3, prdBody(16))]);
  const { rc, lines } = await run([3]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(kids(3).map((k: any) => k.title), ['part A of feature 3', 'part B of feature 3']);
  assert.ok(roles(3).includes('decompose'));
  assert.ok(!runLog().includes('one child'), runLog());
});

test('workers 1 with autoWorkers false: a pool of one takes the one-child path above the threshold', E2E, async () => {
  board([prd(4, prdBody(16))]);
  const { rc, lines } = await run([4], { workers: 1, autoWorkers: false });
  assert.equal(rc, 0, lines.join('\n'));
  oneChild(4, 16, 'a pool of one');
});

test('hx run --workers 1 over a config with workers 2 and autoWorkers false is a pool of one', E2E, async () => {
  board([prd(5, prdBody(16))]);
  const { rc, lines } = await run([5], { workers: 2, autoWorkers: false }, 1);
  assert.equal(rc, 0, lines.join('\n'));
  oneChild(5, 16, 'a pool of one');
});

test('singleChildMaxCriteria 0 decomposes, also in a pool of one', E2E, async () => {
  board([prd(6, prdBody(3))]);
  const { rc, lines } = await run([6], { workers: 1, singleChildMaxCriteria: 0 });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(kids(6).length, 2);
  assert.ok(roles(6).includes('decompose'));
  assert.ok(!runLog().includes('one child'), runLog());
});

test('one runner never files two children for a PRD, even when the next board reads do not list the new child yet', E2E, async () => {
  board([prd(7, prdBody(2))], { createHiddenReads: 3 });
  const { rc, lines } = await run([7]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(read().issues.length, 2, JSON.stringify(read().issues.map((i: any) => i.title)));
  assert.equal(runLog().split('\n').filter((l) => l.includes('one child #')).length, 1, runLog());
  assert.equal(read().comments.length, 1);
});

test('a failed gh issue create is logged, nothing is half-filed, and a later pass files the child', E2E, async () => {
  board([prd(8, prdBody(2))], { createFails: 1 });
  const { rc, lines } = await run([8]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(runLog().includes('[#8] one child failed:'), runLog());
  oneChild(8, 2, '≤ 15 acceptance criteria');
});

test('an invalid singleChildMaxCriteria stops hx run before the board is read', E2E, async () => {
  board([prd(9, prdBody(2))]);
  for (const v of [-1, 1.5, '15']) {
    const { rc, lines } = await run([9], { singleChildMaxCriteria: v });
    assert.equal(rc, 2, lines.join('\n'));
    assert.ok(lines.some((l) => /STOPPED: singleChildMaxCriteria: .* whole number, 0 or more/.test(l)), lines.join('\n'));
  }
  assert.equal(kids(9).length, 0);
});
