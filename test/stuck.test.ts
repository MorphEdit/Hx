// #65: a fresh PR missing from `gh pr list --head` for a while, and a label edit that fails, must not leave an
// issue stuck as agent-working. Real git (a local bare origin), the real ship.mjs, fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-s-'));
const stateFile = path.join(tmp, 'board.json');
const ghLog = path.join(tmp, 'gh.log');
const fakeDir = path.join(tmp, 'sessions');
Object.assign(process.env, {
  HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'),
  HX_FAKE_STATE: stateFile, HX_FAKE_DIR: fakeDir, HX_FAKE_GH_LOG: ghLog, HX_PR_RETRY_MS: '1', HX_LABEL_RETRY_MS: '1',
});
mkdirSync(fakeDir);

const { runPool, relabel, findOpenPr } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');

const L = DEFAULTS.labels;
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, ...gitId, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = () => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 1 } });

const board = (issues: any[], extra = {}) => { writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues, ...extra })); writeFileSync(ghLog, ''); };
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const ghCalls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
const issue = (n: number, body = '', labels = [L.ready]) => ({ number: n, title: `task ${n}`, body, state: 'OPEN', labels });

async function run(only: number[]) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(), { workers: 1, watch: false, dryRun: false, only, signal })), lines };
  } finally { console.log = orig; }
}

test('a PR missing from gh pr list for the first calls is found on a retry: audited and merged, not blocked', E2E, async () => {
  board([issue(1)], { prListLag: 2 });
  const { rc, lines } = await run([1]);
  assert.equal(rc, 0, lines.join('\n'));
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.ok(!s.issues[0].labels.includes(L.blocked) && !s.issues[0].labels.includes(L.working), JSON.stringify(s.issues[0].labels));
  assert.equal(s.prs.length, 1);
  assert.equal(s.prs[0].state, 'MERGED');
  assert.ok(lines.some((l) => /\[#1\] DONE ✓ audited and merged/.test(l)), lines.join('\n'));
});

test('a PR gh pr list never shows within the retries is found by gh pr view <branch>', E2E, async () => {
  board([issue(2)], { prListLag: 5 }); // hx lists five times (about 30 s), then falls back to gh pr view
  const { rc, lines } = await run([2]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(ghCalls().some((l) => /^pr view issue\/2 -R me\/app --json number,state$/.test(l)), ghCalls().join('\n'));
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.equal(s.prs[0].state, 'MERGED');
});

test('findOpenPr: retries gh pr list with backoff, then gh pr view; null when neither finds an open PR', E2E, async () => {
  board([issue(3)], { prs: [{ number: 7, head: 'issue/3', state: 'OPEN', hide: 1 }] });
  assert.equal(await findOpenPr('me/app', 'issue/3'), 7);
  assert.equal(ghCalls().filter((l) => l.startsWith('pr list')).length, 2);
  board([issue(3)], { prs: [{ number: 8, head: 'issue/3', state: 'CLOSED' }] });
  assert.equal(await findOpenPr('me/app', 'issue/3'), null);
  assert.deepEqual(ghCalls().map((l) => l.split(' ').slice(0, 2).join(' ')), ['pr list', 'pr list', 'pr list', 'pr list', 'pr list', 'pr view']);
  // the waits between the lists grow (1, 2, 4, 8 units: about 30 s at the default 2 s unit)
  process.env.HX_PR_RETRY_MS = '20';
  try {
    board([issue(3)]);
    const t = Date.now();
    assert.equal(await findOpenPr('me/app', 'issue/3'), null);
    assert.ok(Date.now() - t >= 280, `waited ${Date.now() - t} ms`);
  } finally { process.env.HX_PR_RETRY_MS = '1'; }
});

test('a label edit in fail() that fails once is retried: the issue ends agent-blocked, not agent-working', E2E, async () => {
  board([issue(4, 'AUDITNEVER')], { labelFails: 1 });
  const { rc, lines } = await run([4]);
  assert.equal(rc, 1);
  const s = read();
  assert.equal(s.labelFails, 0, 'the failure was used up');
  assert.ok(s.issues[0].labels.includes(L.blocked), JSON.stringify(s.issues[0].labels));
  assert.ok(!s.issues[0].labels.includes(L.working), JSON.stringify(s.issues[0].labels));
  assert.ok(!lines.some((l) => /WARNING/.test(l)), lines.join('\n'));
});

test('a label edit that fails every time is logged as a warning naming the issue, and the end of the run names it as stuck', E2E, async () => {
  board([issue(5, 'AUDITNEVER')], { labelFails: -1 });
  const { lines } = await run([5]);
  const s = read();
  assert.ok(s.issues[0].labels.includes(L.working), 'the edit really failed');
  assert.ok(lines.some((l) => /\[#5\] WARNING: could not change the labels of #5 \(\+agent-blocked -agent-working\) after 3 tries/.test(l)), lines.join('\n'));
  assert.equal(ghCalls().filter((l) => /^issue edit 5 .*--remove-label/.test(l)).length, 3, 'tried three times');
  assert.ok(lines.some((l) => /\[#5\] impl FAILED ✗[\s\S]*; NOT labelled agent-blocked/.test(l)), lines.join('\n'));
  const done = lines.findIndex((l) => /nothing left to do — done/.test(l));
  assert.ok(done >= 0, lines.join('\n'));
  assert.ok(lines.slice(done).some((l) => /WARNING: still labelled agent-working with no session running: #5\b/.test(l)), lines.join('\n'));
});

test('hx run ending with nothing to do names every issue left agent-working', E2E, async () => {
  board([issue(6, '', [L.ready, L.working]), issue(7, '', [L.ready, L.working]), issue(8, '', [L.ready, L.blocked])]);
  const { rc, lines } = await run([6, 7, 8]);
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => /WARNING: still labelled agent-working with no session running: #6, #7 — remove the label/.test(l)), lines.join('\n'));
});

test('relabel: succeeds without a warning when the edit works', E2E, async () => {
  board([issue(9, '', [L.ready, L.working])]);
  assert.equal(await relabel('me/app', 9, [L.blocked], [L.working]), true);
  assert.deepEqual(read().issues[0].labels, [L.ready, L.blocked]);
});
