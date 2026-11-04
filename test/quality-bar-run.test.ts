// hx run with a PRD at its quality bar (#257): the run session records ours and the reference into A/ and B/,
// a fresh judge picks one (retried once), and hx resolves the round: won, lost (a gap issue), the cap, a
// reference that cannot be provisioned, no verdict. Real git (a local bare origin), fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-qb-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readMapping } = await import('../src/bar.ts');

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
const wtRoot = path.join(tmp, 'wt');
const project = (over: Record<string, unknown> = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wtRoot,
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, ...over } });

const BAR = (flags: string) => `Billing. ${flags}\n\n## Quality bar\nBeat: Stripe Billing — https://stripe.com/billing\nJudged on:\n- invoice speed\n- clarity of totals\n`;
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const prd = () => read().issues.find((i: any) => i.number === 1);
const comments = () => read().comments.filter((c: any) => c.issue === 1).map((c: any) => c.body as string);
const markers = () => comments().filter((b) => b.startsWith('<!-- hx-bar round='));
const usage = () => existsSync(path.join(stateDir, 'usage.jsonl'))
  ? readFileSync(path.join(stateDir, 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
/** The sessions the fake claude ran: role, judge?, cwd-free; with their first prompt. */
const sessions = () => readdirSync(fakeDir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => ({
  ...JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')), prompt: readFileSync(path.join(fakeDir, f.replace('.json', '.prompt-1.txt')), 'utf8') }));
const barRuns = () => sessions().filter((s) => s.role === 'bar' && !s.judge);
const judges = () => sessions().filter((s) => s.role === 'bar' && s.judge);

function board(body: string, labels: string[], extra: { comments?: unknown[]; issues?: unknown[] } = {}) {
  writeFileSync(stateFile, JSON.stringify({ comments: extra.comments ?? [], prs: [], issues: [
    { number: 1, title: 'billing', body, state: 'OPEN', labels: [L.prd, L.hardened, ...labels] },
    { number: 2, title: 'part', body: 'do it\n\n## Blocked by\nNone\n\n## Parent\n#1\n', state: 'CLOSED', labels: [L.ready] },
    ...(extra.issues ?? []),
  ] }));
}

async function run(over: Record<string, unknown> = {}, only?: number[]) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  let rc: number;
  try { rc = await pooled((signal) => runPool(project(over) as any, { workers: 1, watch: false, dryRun: false, only, signal })); } finally { console.log = orig; }
  assert.deepEqual(lines.filter((l) => /crashed/.test(l)), [], lines.join('\n'));
  return { rc, lines, log: lines.join('\n') };
}

beforeEach(() => {
  for (const f of readdirSync(fakeDir)) rmSync(path.join(fakeDir, f), { recursive: true, force: true });
  rmSync(path.join(stateDir, 'usage.jsonl'), { force: true });
  rmSync(path.join(stateDir, 'bar'), { recursive: true, force: true });
});

test('a PRD without a quality bar is closed as before: no bar session', E2E, async () => {
  board('Billing.\n', [L.reviewed, L.secured]);
  const { rc, log } = await run();
  assert.equal(rc, 0, log);
  assert.equal(prd().state, 'CLOSED');
  assert.deepEqual(usage().filter((u) => u.role === 'bar'), []);
  assert.deepEqual(barRuns().concat(judges()), []);
});

test('round 1 lost: one gap issue, one marker, prd-reviewed and security-reviewed removed, PRD open; a stranger marker never counts', E2E, async () => {
  board(BAR('BARLOSE1'), [L.reviewed, L.secured], { comments: [{ issue: 1, author: 'mallory', body: '<!-- hx-bar round=1 -->\n**hx quality bar round 1/3: won**' }] });
  const { rc, log } = await run({}, [1]);
  assert.equal(rc, 0, log);
  const p = prd();
  assert.equal(p.state, 'OPEN');
  assert.ok(!p.labels.includes(L.reviewed) && !p.labels.includes(L.secured) && !p.labels.includes(L.barPassed) && !p.labels.includes(L.working), p.labels.join());
  assert.ok(!p.labels.includes(L.blocked));
  const gaps = read().issues.filter((i: any) => i.number > 2);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].labels, [L.ready]);
  assert.match(gaps[0].body, /## Blocked by\nNone\n\n## Parent\n#1$/);
  assert.match(gaps[0].body, /3 clicks to send an invoice/);
  const ms = comments().filter((b) => b.startsWith('<!-- hx-bar round=1 -->'));
  assert.equal(ms.length, 2, 'the stranger one and hx one');
  assert.equal(markers().length, 2);
  const mine = read().comments.filter((c: any) => c.issue === 1 && c.author !== 'mallory' && c.body.startsWith('<!-- hx-bar'));
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /round 1\/3: lost/);
  assert.match(mine[0].body, new RegExp(`gap issue: #${gaps[0].number}`));
  assert.match(log, /bar round 1\/3: lost/);
  // one run session and one judge, both counted as role bar
  assert.equal(barRuns().length, 1);
  assert.match(barRuns()[0].prompt, /round 1 of 3/, 'the stranger marker did not count');
  assert.equal(judges().length, 1);
  assert.ok(usage().filter((u) => u.role === 'bar').length >= 2);
  // .mapping: written by hx next to A/ and B/, never inside them
  const rDir = path.join(stateDir, 'bar', '1', 'r1');
  assert.ok(readMapping(rDir));
  assert.deepEqual(readdirSync(rDir).sort(), ['.mapping', 'A', 'B']);
  for (const s of ['A', 'B']) assert.ok(!readdirSync(path.join(rDir, s)).includes('.mapping'));
  // the run prompt names both output dirs and the reference dir; the judge prompt names A, B and the dimensions only
  const run1 = barRuns()[0].prompt;
  assert.ok(run1.includes(path.join(rDir, 'A')) && run1.includes(path.join(rDir, 'B')) && run1.includes(path.join(stateDir, 'bar', '1', 'ref')));
  const jp = judges()[0].prompt;
  assert.match(jp, /^- A: `[^`]+[\\/]r1[\\/]A`$/m);
  assert.match(jp, /^- B: `[^`]+[\\/]r1[\\/]B`$/m);
  assert.match(jp, /- invoice speed\n- clarity of totals/);
  assert.ok(!jp.includes('.mapping'), 'no .mapping');
  assert.ok(!jp.includes(root) && !jp.includes(wtRoot) && !jp.includes('me/app'), 'no repo path');
  assert.ok(!jp.includes('Stripe'), 'the judge is blind to the product');
  assert.ok(!existsSync(path.join(wtRoot, 'p1')), 'worktree removed');
});

test('lost round 1 → gap issue fixed → review again → round 2 won: marker, quality-bar-passed, PRD closed', E2E, async () => {
  board(BAR('BARLOSE1'), [L.reviewed]);
  const { rc, log } = await run({ security: false });
  assert.equal(rc, 0, log);
  const p = prd();
  assert.equal(p.state, 'CLOSED', log);
  assert.ok(p.labels.includes(L.barPassed));
  const ms = markers();
  assert.equal(ms.length, 2);
  assert.match(ms[0], /round 1\/3: lost/);
  assert.match(ms[1], /^<!-- hx-bar round=2 -->\n\*\*hx quality bar round 2\/3: won\*\*/);
  assert.match(ms[1], /gap: the loser takes 4 clicks/);
  // a review ran after the lost round's marker, before round 2
  const cs = comments();
  const lost = cs.findIndex((b) => b.startsWith('<!-- hx-bar round=1 -->'));
  const won = cs.findIndex((b) => b.startsWith('<!-- hx-bar round=2 -->'));
  assert.ok(cs.slice(lost + 1, won).some((b) => b.startsWith('<!-- hx-review -->')), cs.join('\n---\n'));
  assert.equal(barRuns().length, 2);
  assert.equal(judges().length, 2);
  assert.match(log, /bar round 2\/3: won/);
});

test('a reference that cannot be provisioned: a comment with the reason, quality-bar-passed, PRD closed, never blocked', E2E, async () => {
  board(BAR('BARNOPROV'), [L.reviewed, L.secured]);
  const { rc, log } = await run();
  assert.equal(rc, 0, log);
  const p = prd();
  assert.equal(p.state, 'CLOSED');
  assert.ok(p.labels.includes(L.barPassed) && !p.labels.includes(L.blocked), p.labels.join());
  assert.ok(comments().some((b) => /could not be provisioned/.test(b) && /needs a paid account/.test(b)), comments().join('\n'));
  assert.deepEqual(markers(), []);
  assert.equal(judges().length, 0);
  assert.equal(read().issues.length, 2, 'no gap issue');
  assert.match(log, /bar round 1\/3: provision failed — the reference needs a paid account/);
});

test('losing round barRounds: the round marker, a cap comment with the standing gap, no gap issue, signed off', E2E, async () => {
  const earlier = '<!-- hx-bar round=1 -->\n**hx quality bar round 1/2: lost**\n\ngap: x\n\ngap issue: #9';
  board(BAR('BARLOSEALL'), [L.reviewed, L.secured], { comments: [{ issue: 1, body: earlier }] });
  const { rc, log } = await run({ barRounds: 2 });
  assert.equal(rc, 0, log);
  const p = prd();
  assert.equal(p.state, 'CLOSED');
  assert.ok(p.labels.includes(L.barPassed));
  assert.equal(read().issues.length, 2, 'no gap issue');
  const ms = markers();
  assert.equal(ms.length, 2);
  assert.match(ms[1], /^<!-- hx-bar round=2 -->\n\*\*hx quality bar round 2\/2: lost\*\*/);
  assert.ok(!/gap issue/.test(ms[1]));
  const cap = comments().find((b) => b.startsWith('<!-- hx-bar cap -->'));
  assert.ok(cap, comments().join('\n'));
  assert.match(cap!, /standing gap: the loser takes 4 clicks to send an invoice/);
  assert.match(log, /bar round 2\/2: lost at the cap/);
});

test('a judge reply in a bad shape once is retried: one run, two judges, no marker for the failed attempt', E2E, async () => {
  board(BAR('BARBAD1'), [L.reviewed, L.secured]);
  const { rc, log } = await run();
  assert.equal(rc, 0, log);
  assert.equal(barRuns().length, 1);
  assert.equal(judges().length, 2);
  // the retry judged the same recordings
  assert.equal(judges()[0].prompt, judges()[1].prompt);
  const ms = markers();
  assert.equal(ms.length, 1);
  assert.match(ms[0], /round 1\/3: won/);
  assert.equal(prd().state, 'CLOSED');
  assert.match(log, /judge attempt 1 gave no valid verdict — judging again/);
});

test('a judge reply in a bad shape twice: a no verdict marker, sign-off, no gap issue', E2E, async () => {
  board(BAR('BARBAD2 BARLOSEALL'), [L.reviewed, L.secured]);
  const { rc, log } = await run();
  assert.equal(rc, 0, log);
  assert.equal(barRuns().length, 1);
  assert.equal(judges().length, 2);
  const ms = markers();
  assert.equal(ms.length, 1);
  assert.match(ms[0], /round 1\/3: no verdict/);
  const p = prd();
  assert.equal(p.state, 'CLOSED');
  assert.ok(p.labels.includes(L.barPassed));
  assert.equal(read().issues.length, 2, 'no gap issue');
  assert.match(log, /bar round 1\/3: no verdict/);
});
