// The self-review session (PRD #194 §C, #239): .hx/selfreview.json, when a health pass in hx run starts a session,
// the selfreview role and its findings filed as bug issues. Real git (a local bare origin per test), fake gh and fake claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-sr-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
Object.assign(process.env, { HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_RTDD_BIN: path.join(here, 'fakes', 'rtdd.mjs'),
  HX_FAKE_STATE: stateFile, HX_FAKE_DIR: fakeDir });
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, healthConfigError, roleModelsError } = await import('../src/config.ts');
const { parseFindings, findingBody, selfReviewDecision, readSelfReview, selfReviewMarker } = await import('../src/selfreview.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const board = (o: any = {}) => writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], ...o }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const HOUR = 3_600_000;

let k = 0;
function repo(extra: object = {}) {
  const dir = path.join(tmp, `r${++k}`);
  mkdirSync(dir);
  const origin = path.join(dir, 'origin.git'), root = path.join(dir, 'app');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, root);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir);
  const exclude = path.join(root, '.git', 'info', 'exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(dir, 'wt'), claudeBin: path.join(here, 'fakes', 'claude.mjs'),
    maxIterations: 3, pollSeconds: 1, audit: false, gate: false, ...extra };
  return { root, stateDir, config, base: git(root, 'rev-parse', 'HEAD') };
}
type Repo = ReturnType<typeof repo>;
/** Merges on origin/main after the recorded sha: one commit per PR title. */
const merge = (r: Repo, ...titles: string[]) => { for (const t of titles) git(r.root, 'commit', '-q', '--allow-empty', '-m', t); git(r.root, 'push', '-q', 'origin', 'HEAD:main'); return git(r.root, 'rev-parse', 'HEAD'); };
const seed = (r: Repo, sha: string, agoMs: number) => writeFileSync(path.join(r.stateDir, 'selfreview.json'), JSON.stringify({ sha, at: new Date(Date.now() - agoMs).toISOString() }));
const runLog = (r: Repo) => { try { return readFileSync(path.join(r.stateDir, 'run.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const usage = (r: Repo) => { try { return readFileSync(path.join(r.stateDir, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
/** The first prompts and env of every fake-claude session that ran as role selfreview since `before`. */
const sessions = (before: Set<string>) => readdirSync(fakeDir).filter((f) => /\.env-1\.json$/.test(f) && !before.has(f))
  .map((f) => ({ env: JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')), prompt: readFileSync(path.join(fakeDir, f.replace('.env-1.json', '.prompt-1.txt')), 'utf8') }))
  .filter((s) => s.env.role === 'selfreview');
// `only` an issue that does not exist: filed bugs are not built, so the run ends after the review
const plain = (r: Repo, only = [999]) => { const before = new Set(readdirSync(fakeDir)); return pooled((signal) => runPool(r, { workers: 1, watch: false, dryRun: false, only, signal })).then((code) => ({ code, ran: sessions(before) })); };

// ---- pure ----

test('parseFindings: each `## Finding` block up to the cap, the promise and text outside blocks dropped', () => {
  const text = 'I looked.\n\n## Finding: off by one\nFile: a.ts:3\nWhat breaks: x\nReproduce: y\n\n## Finding: null deref\nFile: b.ts:9\nWhat breaks: z\nReproduce: w\n'
    + '## Finding: third\nFile: c.ts:1\n\n<promise>SELFREVIEW DONE</promise>';
  const f = parseFindings(text, 2);
  assert.deepEqual(f.map((x) => x.title), ['off by one', 'null deref']);
  assert.equal(f[0].body, '## Finding: off by one\nFile: a.ts:3\nWhat breaks: x\nReproduce: y');
  assert.equal(parseFindings(text, 5).length, 3);
  assert.ok(!parseFindings(text, 5)[2].body.includes('promise'));
  assert.deepEqual(parseFindings('nothing found\n<promise>SELFREVIEW DONE</promise>', 5), []);
  assert.equal(findingBody(f[0], 'abc'), `${f[0].body}\n\n<!-- hx:selfreview abc -->\n`);
});

test('selfReviewDecision: record without state or with a sha the head does not descend from; otherwise commits and hours decide', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const s = { sha: 'a', at: new Date(now - 13 * HOUR).toISOString() };
  assert.equal(selfReviewDecision(null, { ancestor: false, commits: 0, now, everyHours: 12 }).kind, 'record');
  assert.equal(selfReviewDecision(s, { ancestor: false, commits: 3, now, everyHours: 12 }).kind, 'record');
  assert.equal(selfReviewDecision(s, { ancestor: true, commits: 0, now, everyHours: 12 }).kind, 'wait');
  assert.equal(selfReviewDecision(s, { ancestor: true, commits: 2, now, everyHours: 14 }).kind, 'wait');
  assert.deepEqual(selfReviewDecision(s, { ancestor: true, commits: 2, now, everyHours: 12 }), { kind: 'review', since: 'a' });
});

test('config: selfReviewEveryHours and selfReviewMaxFindings have defaults and are validated; roleModels.selfreview is accepted', () => {
  assert.equal(DEFAULTS.selfReviewEveryHours, 12);
  assert.equal(DEFAULTS.selfReviewMaxFindings, 5);
  assert.equal(healthConfigError({ selfReviewEveryHours: 6, selfReviewMaxFindings: 3 }), null);
  assert.match(healthConfigError({ selfReviewEveryHours: -1 })!, /^selfReviewEveryHours:/);
  assert.match(healthConfigError({ selfReviewEveryHours: '12' })!, /^selfReviewEveryHours:/);
  assert.match(healthConfigError({ selfReviewMaxFindings: 0 })!, /^selfReviewMaxFindings:/);
  assert.match(healthConfigError({ selfReviewMaxFindings: 2.5 })!, /^selfReviewMaxFindings:/);
  assert.equal(roleModelsError({ selfreview: { model: 'claude-sonnet-5-5', effort: 'high' } }), null);
});

test('a bad selfReviewMaxFindings stops hx run before anything is read', E2E, async () => {
  const r = repo({ selfReviewMaxFindings: 0 });
  board();
  assert.equal((await plain(r)).code, 2);
  assert.ok(runLog(r).some((l) => /STOPPED: selfReviewMaxFindings/.test(l)));
});

// ---- in hx run ----

test('no selfreview.json: the head is recorded and no session runs', E2E, async () => {
  const r = repo();
  board();
  const { code, ran } = await plain(r);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  assert.equal(readSelfReview(r.stateDir)?.sha, r.base);
  assert.ok(runLog(r).some((l) => /self-review: recorded/.test(l)), runLog(r).join('\n'));
});

test('a recorded sha the head does not descend from: the head is recorded again, no session', E2E, async () => {
  const r = repo();
  board();
  seed(r, '0'.repeat(40), 13 * HOUR);
  const head = merge(r, 'feat: one (#5)');
  const { ran } = await plain(r);
  assert.equal(ran.length, 0);
  assert.equal(readSelfReview(r.stateDir)?.sha, head);
});

test('merges since the last sha, selfReviewEveryHours elapsed: one selfreview session; findings filed as bug issues, capped; the new head recorded', E2E, async () => {
  const r = repo({ selfReviewMaxFindings: 2, roleModels: { selfreview: { model: 'claude-sonnet-5-5', effort: 'high' } } });
  board();
  seed(r, r.base, 13 * HOUR);
  const head = merge(r, 'feat: add the widget (#5)', 'fix: the widget crash (#6)');
  process.env.FAKE_CLAUDE_FINDINGS = '4';
  let res;
  try { res = await plain(r); } finally { delete process.env.FAKE_CLAUDE_FINDINGS; }
  assert.equal(res.code, 0);
  assert.equal(res.ran.length, 1, runLog(r).join('\n'));
  const [s] = res.ran;
  assert.ok(s.prompt.startsWith('Role: selfreview'));
  assert.ok(s.prompt.includes(`${r.base}..${head}`), 'the range');
  assert.ok(s.prompt.includes('- feat: add the widget (#5)') && s.prompt.includes('- fix: the widget crash (#6)'), 'the merged PR titles');
  assert.ok(s.prompt.includes('at most 2 findings'));
  assert.deepEqual([s.env.model, s.env.effort], ['claude-sonnet-5-5', 'high']);
  const bugs = read().issues;
  assert.deepEqual(bugs.map((i: any) => i.title), ['defect 1 in sr', 'defect 2 in sr'], 'capped at selfReviewMaxFindings, run in the sr worktree');
  for (const b of bugs) {
    assert.deepEqual(b.labels, ['bug']);
    assert.ok(b.body.includes('File: src/x.ts:') && b.body.includes(selfReviewMarker(head)), b.body);
  }
  assert.equal(readSelfReview(r.stateDir)?.sha, head);
  assert.ok(runLog(r).some((l) => new RegExp(`self-review: filed 2 finding\\(s\\) since ${r.base.slice(0, 7)} \\(#1, #2\\)`).test(l)), runLog(r).join('\n'));
  const rec = usage(r).filter((u) => u.role === 'selfreview');
  assert.ok(rec.length >= 1 && rec.every((u) => u.model === 'claude-sonnet-5-5'));
  assert.ok(!existsSync(path.join(r.config.worktreeRoot, 'sr')), 'the worktree is removed');
});

test('no findings: the sha is recorded and `self-review: no findings since …` is logged', E2E, async () => {
  const r = repo();
  board();
  seed(r, r.base, 13 * HOUR);
  const head = merge(r, 'feat: one (#5)');
  const { ran } = await plain(r);
  assert.equal(ran.length, 1);
  assert.equal(read().issues.length, 0);
  assert.equal(readSelfReview(r.stateDir)?.sha, head);
  assert.ok(runLog(r).some((l) => new RegExp(`self-review: no findings since ${r.base.slice(0, 7)}$`).test(l)), runLog(r).join('\n'));
});

test('no commits in the range: no session', E2E, async () => {
  const r = repo();
  board();
  seed(r, r.base, 13 * HOUR);
  const { ran } = await plain(r);
  assert.equal(ran.length, 0);
});

test('fewer than selfReviewEveryHours since `at`: no session', E2E, async () => {
  const r = repo({ selfReviewEveryHours: 12 });
  board();
  seed(r, r.base, 11 * HOUR);
  merge(r, 'feat: one (#5)');
  const { ran } = await plain(r);
  assert.equal(ran.length, 0);
  assert.equal(readSelfReview(r.stateDir)?.sha, r.base, 'nothing recorded');
});

test('selfHeal false: no session, nothing recorded', E2E, async () => {
  const r = repo({ selfHeal: false });
  board();
  seed(r, r.base, 13 * HOUR);
  merge(r, 'feat: one (#5)');
  const { ran } = await plain(r);
  assert.equal(ran.length, 0);
  assert.equal(readSelfReview(r.stateDir)?.sha, r.base);
});

test('a claimable issue: it is built first, the review runs once the board is empty', E2E, async () => {
  const r = repo();
  board({ issues: [{ number: 1, title: 'task', body: '', state: 'OPEN', labels: ['ready-for-agent'], author: 'me' }] });
  seed(r, r.base, 13 * HOUR);
  merge(r, 'feat: one (#5)');
  const before = new Set(readdirSync(fakeDir));
  await pooled((signal) => runPool(r, { workers: 1, watch: false, dryRun: false, only: [1], signal }));
  // #1 was built first; the review ran only once the board was empty
  const log = runLog(r);
  const done = log.findIndex((l) => /\[#1\] impl DONE/.test(l));
  const review = log.findIndex((l) => /self-review: \d+ merge/.test(l));
  assert.ok(done >= 0 && review > done, log.join('\n'));
  assert.equal(sessions(before).length, 1);
});

test('a session that did not finish records nothing', E2E, async () => {
  const r = repo();
  board();
  seed(r, r.base, 13 * HOUR);
  merge(r, 'feat: one (#5)');
  process.env.FAKE_CLAUDE_MODE = 'crash';
  try { await plain(r); } finally { delete process.env.FAKE_CLAUDE_MODE; }
  assert.equal(readSelfReview(r.stateDir)?.sha, r.base);
  assert.ok(runLog(r).some((l) => /self-review: did not finish/.test(l)), runLog(r).join('\n'));
});
