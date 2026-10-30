// The auditor loop end to end: real git (a local bare origin), the real ship.mjs, fake gh and claude.
//   implementer ships with --no-merge → an independent audit session → hx merges on PASS, or the
//   findings go back to the implementer; too many FAILs and the issue goes to a human.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-a-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, auditVerdict } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');

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
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 2, ...extra } });

const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number, body = '') => ({ number: n, title: `task ${n}`, body, state: 'OPEN', labels: [L.ready] });
const audits = (n: number) => read().comments.filter((c: any) => c.issue === n && c.body.startsWith('<!-- hx-audit -->'));

async function run(only: number[]) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await runPool(project(), { workers: 1, watch: false, dryRun: false, only, signal: new AbortController().signal }), lines };
  } finally { console.log = orig; }
}

test('auditVerdict reads PASS / FAIL and the findings', E2E, () => {
  assert.deepEqual(auditVerdict('x\nVERDICT: PASS\nFINDINGS:\n- none\n\n<promise>AUDIT 1 DONE</promise>'), { pass: true, findings: '- none' });
  const v = auditVerdict('**VERDICT: FAIL**\nFINDINGS:\n- a — b — c\n- d\n<promise>AUDIT 2 DONE</promise>');
  assert.equal(v?.pass, false);
  assert.equal(v?.findings, '- a — b — c\n- d');
  assert.equal(auditVerdict('looks fine to me'), null);
});

test('audit PASS: hx merges the PR the implementer left open', E2E, async () => {
  board([issue(1)]);
  const { rc, lines } = await run([1]);
  assert.equal(rc, 0, lines.join('\n'));
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.deepEqual(s.issues[0].labels, [L.ready]);
  assert.equal(s.prs[0].state, 'MERGED', 'merged by hx, not by the implementer');
  assert.equal(audits(1).length, 1);
  assert.match(audits(1)[0].body, /PASS/);
  assert.deepEqual([...new Set(readUsage(stateDir).filter((r) => r.issue === 1).map((r) => r.role))].sort(), ['audit', 'impl']);
  assert.equal(git(root, 'ls-remote', '--heads', 'origin', 'issue/1'), '', 'branch deleted after the merge');
  assert.ok(!existsSync(path.join(tmp, 'wt', 'a1')), 'audit worktree removed');
});

test('audit FAIL: the findings go back to a fresh implementer, then PASS and merge', E2E, async () => {
  board([issue(2, 'AUDITFAIL')]);
  const before = new Set(readdirSync(fakeDir));
  const { rc, lines } = await run([2]);
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => /\[#2\] audit failed — back to the implementer, round 2\/2/.test(l)), lines.join('\n'));
  assert.ok(read().comments.some((c: any) => c.issue === 2 && c.body.startsWith('<!-- hx-retry -->') && /audit failed — back to the implementer, round 2\/2/.test(c.body)));
  const a = audits(2);
  assert.equal(a.length, 2);
  assert.match(a[0].body, /FAIL/);
  assert.match(a[1].body, /PASS/);
  assert.equal(read().issues[0].state, 'CLOSED');
  // the second implementer session was told what the audit found
  const prompts = readdirSync(fakeDir).filter((f) => !before.has(f) && f.endsWith('.prompt-1.txt')).map((f) => readFileSync(path.join(fakeDir, f), 'utf8'));
  const impls = prompts.filter((p) => /Role: implement/.test(p));
  assert.equal(impls.length, 2);
  assert.ok(impls.some((p) => /audit of PR #\d+ FAILED[\s\S]*requires X — code does Y/.test(p)), 'findings passed to the implementer');
  // and the auditor never sees the implementer's session: its prompt is the issue + the PR, nothing else
  const auditPrompts = prompts.filter((p) => /Role: audit/.test(p));
  assert.equal(auditPrompts.length, 2);
  assert.ok(auditPrompts.every((p) => !/READY #2/.test(p)));
});

test('audit keeps failing: after auditRounds the issue goes to a human, nothing is merged', E2E, async () => {
  board([issue(3, 'AUDITNEVER')]);
  const { rc } = await run([3]);
  assert.equal(rc, 1);
  const s = read();
  assert.equal(s.issues[0].state, 'OPEN');
  assert.ok(s.issues[0].labels.includes(L.blocked));
  assert.ok(s.prs.every((p: any) => p.state === 'OPEN'), 'no PR merged');
  assert.equal(audits(3).length, 2);
  assert.ok(s.comments.some((c: any) => c.issue === 3 && /still not passing after 2 audit round/.test(c.body)));
});

test('a repo that only takes auto-merge: hx waits for it to land instead of failing the issue', E2E, async () => {
  board([issue(4)]);
  process.env.HX_FAKE_AUTOMERGE = '1';
  process.env.HX_SHIP_RETRY_MS = '10';
  try {
    const { rc, lines } = await run([4]);
    assert.equal(rc, 0, lines.join('\n'));
    assert.ok(lines.some((l) => /\[#4\] DONE ✓ audited and merged/.test(l)));
  } finally { delete process.env.HX_FAKE_AUTOMERGE; delete process.env.HX_SHIP_RETRY_MS; }
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.ok(!s.issues[0].labels.includes(L.blocked));
});

test('audit PASS but the merge hits a rebase conflict: logged and commented, back to the implementer, then merged', E2E, async () => {
  board([issue(5, 'AUDITCONFLICT')]);
  const { rc, lines } = await run([5]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /\[#5\] merge after audit failed \(rebase conflict\) — back to the implementer, round 2\/2/.test(l)), lines.join('\n'));
  const s = read();
  const retry = s.comments.filter((c: any) => c.issue === 5 && c.body.startsWith('<!-- hx-retry -->'));
  assert.equal(retry.length, 1);
  assert.match(retry[0].body, /merge after audit failed \(rebase conflict\) — back to the implementer, round 2\/2 \(PR #\d+\)/);
  assert.equal(audits(5).length, 2);
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.ok(s.prs.some((p: any) => p.state === 'MERGED'));
  assert.ok(lines.some((l) => /\[#5\] DONE ✓ audited and merged \(2 round/.test(l)));
});
