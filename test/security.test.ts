// The security pass end to end: real git (a local bare origin), fake gh and claude.
//   review sign-off → security files a `security` issue → prd-reviewed removed → fixed → review → security PASS → closed.
import { E2E, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-s-'));
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
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, ...extra } });

const board = (issues: any[], comments: any[] = []) => writeFileSync(stateFile, JSON.stringify({ comments, prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const prd = (n: number, body: string, labels: string[] = []) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels: [L.prd, ...labels] });
const kid = (n: number, p: number) => ({ number: n, title: `part of ${p}`, body: `do it\n\n## Parent\n#${p}\n`, state: 'CLOSED', labels: [L.ready] });
const marked = (n: number, marker: string) => read().comments.filter((c: any) => c.issue === n && c.body.split('\n')[0] === marker);
const kids = (n: number) => read().issues.filter((i: any) => new RegExp(`## Parent\\n#${n}\\b`).test(i.body));
// a built PRD with one review round behind it: the fake reviewer signs off from round 2 on
const reviewedOnce = (n: number) => ({ issue: n, body: '<!-- hx-review -->\nround 1' });

async function run(extra = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal: new AbortController().signal }), lines };
  } finally { console.log = orig; }
}

test('security files an issue → prd-reviewed removed → fixed → review again → security PASS → PRD closed', E2E, async () => {
  board([prd(1, 'Auth.\n')]);
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assert.deepEqual(lines.filter((l) => /crashed|FAILED/.test(l)), []);
  const p = issue(1);
  assert.equal(p.state, 'CLOSED');
  assert.ok(p.labels.includes(L.reviewed) && p.labels.includes(L.secured), p.labels.join());
  assert.ok(!p.labels.includes(L.working) && !p.labels.includes(L.blocked));
  const sec = kids(1).filter((k: any) => k.labels.includes(L.security));
  assert.equal(sec.length, 1, 'the first pass filed one security issue');
  assert.equal(sec[0].state, 'CLOSED', 'and it was implemented');
  assert.equal(kids(1).length, 4, 'A, B, the review gap and the security issue');
  // the session owns the verdict comment: exactly one per pass, none from hx
  const s = marked(1, '<!-- hx-security -->');
  assert.deepEqual(s.map((c: any) => c.body.split('\n')[1]), [`round 1: filed #${sec[0].number}`, 'round 2: signed off']);
  assert.equal(marked(1, '<!-- hx-review -->').length, 3, 'gap, sign-off, then a review of the security fix');
  // order: review sign-off → security 1 → reviewed removed → fix → review 3 → security 2 → closed
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const order = [at(/\[#1\] review \(round 2\)/), at(/\[#1\] security \(round 1\)/), at(/\[#1\] security pass filed issue\(s\) — removed prd-reviewed$/),
    at(new RegExp(`\\[#${sec[0].number}\\] impl`)), at(/\[#1\] review \(round 3\)/), at(/\[#1\] security \(round 2\)/), at(/\[#1\] PRD closed/)];
  assert.ok(order.every((x, k) => x >= 0 && (k === 0 || x > order[k - 1])), `${order}\n${lines.join('\n')}`);
  assert.ok(read().comments.some((c: any) => c.issue === 1 && /passed review and the security pass — closed by hx/.test(c.body)), 'close message mentions security');
  const usage = readUsage(stateDir).filter((r) => r.issue === 1);
  assert.deepEqual([...new Set(usage.map((r) => r.role))].sort(), ['decompose', 'review', 'security']);
  assert.ok(!existsSync(path.join(tmp, 'wt', 'p1')), 'worktree removed');
  // the prompt got the child list, the label names and the round
  const prompt = readFileSync(path.join(fakeDir, usage.find((r) => r.role === 'security')!.sessionId + '.prompt-1.txt'), 'utf8');
  assert.match(prompt, /^Role: security/);
  assert.match(prompt, /security round 1 of 2/);
  assert.match(prompt, /- #2 \[closed\] part A of feature 1/);
  assert.match(prompt, /--label ready-for-agent --label security /);
  assert.match(prompt, /--add-label security-reviewed/);
  const envs = sessionEnvs(fakeDir);
  assert.ok(envs.some((e) => e.role === 'security'));
  for (const e of envs) assert.equal(e.trusted, 'me', JSON.stringify(e));
});

test('security never passes: after securityRounds the PRD is agent-blocked with a comment for a human, not closed', E2E, async () => {
  board([prd(10, 'SECURITYNEVER\n', [L.reviewed]), kid(11, 10)], [reviewedOnce(10)]);
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  const p = issue(10);
  assert.equal(p.state, 'OPEN');
  assert.ok(p.labels.includes(L.blocked) && !p.labels.includes(L.working) && !p.labels.includes(L.secured), p.labels.join());
  assert.equal(marked(10, '<!-- hx-security -->').length, 2, 'two passes ran');
  assert.equal(kids(10).filter((k: any) => k.labels.includes(L.security) && k.state === 'CLOSED').length, 2, 'each filed issue was fixed');
  const human = read().comments.filter((c: any) => c.issue === 10 && /2 security passes have run/.test(c.body));
  assert.equal(human.length, 1);
  assert.match(human[0].body, /add the `security-reviewed` label to sign it off, or raise `securityRounds` and remove `agent-blocked`/);
  assert.ok(lines.some((l) => /\[#10\] security round cap \(2\) reached — labelled agent-blocked/.test(l)), lines.join('\n'));
});

for (const [name, body, why] of [
  ['neither labels nor files', 'SECURITYNOOP\n', /the security pass neither added `security-reviewed` nor filed a `security` issue/],
  ['leaves only an untrusted security issue behind', 'SECURITYSTRANGERISSUE\n', /the security pass neither added `security-reviewed` nor filed a `security` issue/],
  ['signs off without its verdict comment', 'SECURITYNOCOMMENT\n', /the security pass posted no `<!-- hx-security -->` comment/],
] as const) {
  test(`a security session that ${name} is reported failed; the PRD is not closed`, E2E, async () => {
    board([prd(20, body, [L.reviewed]), kid(21, 20)], [reviewedOnce(20)]);
    const { rc, lines } = await run();
    assert.equal(rc, 1, lines.join('\n'));
    const p = issue(20);
    assert.equal(p.state, 'OPEN');
    assert.ok(p.labels.includes(L.blocked) && !p.labels.includes(L.working), p.labels.join());
    assert.ok(p.labels.includes(L.reviewed), 'a failed pass leaves the review sign-off alone');
    assert.ok(read().comments.some((c: any) => c.issue === 20 && /security stopped/.test(c.body) && why.test(c.body)), JSON.stringify(read().comments));
    assert.ok(lines.some((l) => /\[#20\] security FAILED/.test(l)), lines.join('\n'));
    assert.ok(!existsSync(path.join(tmp, 'wt', 'p20')), 'worktree removed');
  });
}

test('security: false — a reviewed PRD closes without a security pass', E2E, async () => {
  board([prd(30, 'x\n', [L.reviewed]), kid(31, 30)]);
  const { rc, lines } = await run({ security: false });
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(issue(30).state, 'CLOSED');
  assert.equal(marked(30, '<!-- hx-security -->').length, 0);
  assert.ok(read().comments.some((c: any) => c.issue === 30 && c.body === 'All child issues are closed and the PRD passed review — closed by hx.'));
});

test('hx init creates security-reviewed and security; hx status prints the security status', E2E, () => {
  const app = path.join(tmp, 'cli');
  git(tmp, 'clone', '-q', origin, app);
  board([prd(40, 'x\n', [L.reviewed]), kid(41, 40)]);
  const hx = (...args: string[]) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), ...args], { cwd: app, encoding: 'utf8' });
  const init = hx('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.ok(read().labels.includes(L.secured) && read().labels.includes(L.security), JSON.stringify(read().labels));
  assert.match(init.stdout, /labels .*security-reviewed, security/);
  const st = hx('status');
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /PRD #40\s+security\s+feature 40/);
});
