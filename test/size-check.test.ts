// The up-front size check (#311, PRD #300 §1): a single issue is sized by one `size` session (the decompose role) in
// its new impl worktree before the impl session, and split into child issues when it is too big. End to end: real git
// with a local bare origin, fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-sz-'));
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
const { SIZE_FITS, SIZE_SPLIT } = await import('../src/size.ts');

const fakeClaude = path.join(here, 'fakes', 'claude.mjs');
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
  claudeBin: fakeClaude, maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, bugTriage: false,
  security: false, trustedAuthors: ['Alice'], ...extra } });
// the gh login is Hx-Bot (a comment without an author is its own); alice is trusted
const board = (issues: any[], comments: any[] = [], extra = {}) =>
  writeFileSync(stateFile, JSON.stringify({ login: 'Hx-Bot', comments, prs: [], issues, ...extra }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const commentsOn = (n: number): string[] => read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body);
const ready = (n: number, body: string, labels: string[] = [L.ready]) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels });
const runLog = () => readFileSync(path.join(stateDir, 'run.log'), 'utf8');
/** The roles of the sessions started since `since` for issue #n, in the order they started (their first prompt's file). */
const roles = (since: number, n: number) => readdirSync(fakeDir).filter((f) => f.endsWith('.prompt-1.txt')).map((f) => path.join(fakeDir, f))
  .filter((f) => statSync(f).mtimeMs >= since).sort((x, y) => statSync(x).mtimeMs - statSync(y).mtimeMs).map((f) => readFileSync(f, 'utf8'))
  .filter((t) => new RegExp(`(?:Issue|PRD): #${n}\\b`).test(t)).map((t) => /^Role: (\w+)/.exec(t)?.[1]);

async function run(extra = {}, issues?: number[]) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal, ...(issues ? { only: issues } : {}) })), lines };
  } finally { console.log = orig; }
}

test('config: sizeCheck defaults to true', E2E, () => {
  assert.equal(DEFAULTS.sizeCheck, true);
});

test('size fits: the marker, `size #n: fits`, the issue implemented in the same worktree; a second claim is not sized again', E2E, async () => {
  board([ready(10, 'Add a button.')]);
  const since = Date.now();
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(roles(since, 10), ['size', 'implement'], 'the size session first, then the impl session');
  assert.deepEqual(commentsOn(10), [`${SIZE_FITS}\n**hx:** sized: fits one session.`]);
  assert.match(runLog(), /\[#10\] size #10: fits\n/);
  assert.equal(issue(10).state, 'CLOSED', 'implemented');
  const dirs = lines.map((l) => /\[#10\] working in (.+)$/.exec(l)?.[1]).filter(Boolean);
  assert.equal(dirs.length, 1, 'one worktree for both sessions');
  // the size session ran in the impl worktree, recorded as decompose
  assert.deepEqual(readUsage(stateDir).filter((r) => r.issue === 10).map((r) => r.role), ['decompose', 'impl', 'impl']);

  // reopened by hand: the hx-size marker by hx's login means it is not sized again
  const b = read();
  Object.assign(b.issues.find((i: any) => i.number === 10), { state: 'OPEN', labels: [L.ready] });
  writeFileSync(stateFile, JSON.stringify(b));
  const again = Date.now();
  assert.equal((await run()).rc, 0);
  assert.deepEqual(roles(again, 10), ['implement']);
  assert.equal(commentsOn(10).filter((c) => c.startsWith(SIZE_FITS)).length, 1);
});

test('size split: children filed with trailers, dependents updated, the split marker, closed not planned, no impl session', E2E, async () => {
  board([ready(20, 'A big job. SIZESPLIT'),
    { number: 21, title: 'after 20', body: 'later\n\n## Blocked by\n#20\n', state: 'OPEN', labels: [L.ready] }]);
  const since = Date.now();
  const { rc, lines } = await run({}, [20]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(roles(since, 20), ['size'], 'no impl session ran');
  const [a, b] = read().issues.filter((i: any) => i.number > 21);
  assert.ok(a && b, JSON.stringify(read().issues));
  assert.deepEqual([a.number, b.number], [22, 23]);
  assert.equal(a.title, 'first half of #20');
  assert.equal(a.body, 'do the first half\n\n## Blocked by\nNone\n\n## Parent\n#20');
  assert.equal(b.body, 'do the second half\n\n## Blocked by\n#22\n\n## Parent\n#20');
  assert.deepEqual(a.labels, [L.ready]);
  assert.deepEqual(b.labels, [L.ready]);
  assert.deepEqual(commentsOn(20), [`${SIZE_SPLIT}\n**hx:** split into #22, #23 — each about one session; the work continues there.`]);
  const p = issue(20);
  assert.equal(p.state, 'CLOSED');
  assert.equal(p.stateReason, 'NOT_PLANNED');
  assert.ok(!p.labels.includes(L.working) && !p.labels.includes(L.blocked), p.labels.join());
  assert.match(runLog(), /\[#20\] split #20 → #22, #23\n/);
  assert.equal(issue(21).body, 'later\n\n## Blocked by\n#20\n#22\n#23\n', 'the dependent still waits on the children');
  assert.ok(!lines.some((l) => /FAILED|crashed/.test(l)), lines.join('\n'));
  assert.ok(!existsSync(path.join(tmp, 'wt', 'i20')), 'the impl worktree is removed');
  assert.deepEqual(readUsage(stateDir).filter((r) => r.issue === 20).map((r) => r.role), ['decompose']);
});

test('size: an invalid reply is treated as fits, with the failed marker, and the issue is implemented', E2E, async () => {
  board([ready(30, 'Do it. SIZEBAD')]);
  const since = Date.now();
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(roles(since, 30), ['size', 'implement']);
  assert.deepEqual(commentsOn(30), [`${SIZE_FITS}\n**hx:** size check failed (the reply has no valid SIZE shape); treated as fits.`]);
  assert.equal(issue(30).state, 'CLOSED');
});

test('size split: the second issue create fails — agent-blocked, the fail comment starts with the split marker, nothing else written', E2E, async () => {
  board([ready(40, 'A big job. SIZESPLIT'),
    { number: 41, title: 'after 40', body: 'later\n\n## Blocked by\n#40\n', state: 'OPEN', labels: [L.ready] }], [], { createFails: 2 });
  const { lines } = await run({}, [40]);
  const p = issue(40);
  assert.equal(p.state, 'OPEN', 'not closed');
  assert.ok(p.labels.includes(L.blocked) && !p.labels.includes(L.working), p.labels.join());
  const cs = commentsOn(40);
  assert.equal(cs.length, 1, cs.join('\n---\n'));
  assert.equal(cs[0].split('\n')[0], SIZE_SPLIT);
  assert.match(cs[0], /the split stopped at filing child 2: .*502.*; filed #42/);
  assert.deepEqual(read().issues.map((i: any) => i.number), [40, 41, 42], 'only the first child was filed');
  assert.equal(issue(41).body, 'later\n\n## Blocked by\n#40\n', 'no dependent edited');
  assert.ok(!runLog().includes('split #40 →'), 'no split line');
  assert.ok(lines.some((l) => /\[#40\] impl FAILED ✗ — the split stopped at filing child 2/.test(l)), lines.join('\n'));
  // the split marker on the fail comment: a later claim never sizes it again
  const b = read();
  Object.assign(b.issues.find((i: any) => i.number === 40), { labels: [L.ready] });
  writeFileSync(stateFile, JSON.stringify(b));
  git(root, 'worktree', 'remove', '--force', path.join(tmp, 'wt', 'i40'));
  git(root, 'branch', '-D', 'issue/40');
  const again = Date.now();
  await run({}, [40]);
  assert.deepEqual(roles(again, 40), ['implement']);
});

test('no size session: a parent (## Parent #N, Parent: #N), a bug, a gate fix, a resumed worktree, sizeCheck false', E2E, async () => {
  board([
    { number: 50, title: 'the PRD', body: 'prd', state: 'OPEN', labels: ['prd'] },
    ready(51, 'child. SIZESPLIT\n\n## Parent #50\n'),
    ready(52, 'child. SIZESPLIT\n\nParent: #50\n'),
    ready(53, 'a bug. SIZESPLIT', [L.ready, L.bug]),
    ready(54, 'a gate fix. SIZESPLIT', [L.ready, L.gateFix]),
  ]);
  const since = Date.now();
  const { rc, lines } = await run({}, [51, 52, 53, 54]);
  assert.equal(rc, 0, lines.join('\n'));
  for (const n of [51, 52, 53, 54]) {
    assert.deepEqual(roles(since, n), ['implement'], `#${n}`);
    assert.equal(issue(n).state, 'CLOSED', `#${n}`);
  }

  board([ready(55, 'A big job. SIZESPLIT')]);
  const off = Date.now();
  assert.equal((await run({ sizeCheck: false })).rc, 0);
  assert.deepEqual(roles(off, 55), ['implement']);
  assert.deepEqual(commentsOn(55), []);

  // a kept impl worktree with work on it (resumed): never sized up front
  board([ready(56, 'A big job. SIZESPLIT FAIL')]);
  await run({ sizeCheck: false, maxIterations: 1 });
  assert.ok(issue(56).labels.includes(L.blocked));
  const b = read();
  Object.assign(b.issues[0], { labels: [L.ready] });
  writeFileSync(stateFile, JSON.stringify(b));
  const resumed = Date.now();
  const r = await run({ maxIterations: 1 });
  assert.ok(r.lines.some((l) => /\[#56\] working in .*\(resuming earlier work\)/.test(l)), r.lines.join('\n'));
  assert.deepEqual(roles(resumed, 56), ['implement']);
  assert.ok(!commentsOn(56).some((c) => c.startsWith('<!-- hx-size')));
});

test('a size marker by a trustedAuthors login (not hx\'s) is ignored: the issue is sized', E2E, async () => {
  board([ready(60, 'Add a button.')], [
    { issue: 60, body: `${SIZE_FITS}\n**hx:** sized: fits one session.`, author: 'alice' },
    { issue: 60, body: `${SIZE_SPLIT}\nsplit`, author: 'mallory' },
  ]);
  const since = Date.now();
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(roles(since, 60), ['size', 'implement']);
  assert.match(runLog(), /\[#60\] size #60: fits\n/);
});
