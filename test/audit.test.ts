// The auditor loop end to end: real git (a local bare origin), the real ship.mjs, fake gh and claude.
//   implementer ships with --no-merge → an independent audit session → hx merges on PASS, or the
//   findings go back to the implementer; too many FAILs and the issue goes to a human.
import { E2E, pooled, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-a-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, auditVerdict, reauditNote } = await import('../src/pool.ts');
const { render } = await import('../src/state.ts');
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

async function run(only: number[], extra = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, only, signal })), lines };
  } finally { console.log = orig; }
}

test('auditVerdict reads PASS / FAIL and the findings', E2E, () => {
  assert.deepEqual(auditVerdict('x\nVERDICT: PASS\nFINDINGS:\n- none\n\n<promise>AUDIT 1 DONE</promise>'), { pass: true, findings: '- none' });
  const v = auditVerdict('**VERDICT: FAIL**\nFINDINGS:\n- a — b — c\n- d\n<promise>AUDIT 2 DONE</promise>');
  assert.equal(v?.pass, false);
  assert.equal(v?.findings, '- a — b — c\n- d');
  assert.equal(auditVerdict('looks fine to me'), null);
});

test('auditVerdict reads a PASS whose FINDINGS are per-criterion evidence lines (#233)', E2E, () => {
  const ev = '- criterion 1: hx help lists it — src/cli.ts:42 — `node bin/hx.mjs help` → "hx foo  do foo"\n'
    + '- criterion 2: a FAIL on a bad id — src/x.ts:7 — `node -e "…"` → exit 2, "no such id"';
  assert.deepEqual(auditVerdict(`done.\nVERDICT: PASS\nFINDINGS:\n${ev}\n\n<promise>AUDIT 9 DONE</promise>`), { pass: true, findings: ev });
});

test('audit PASS: hx merges the PR the implementer left open', E2E, async () => {
  board([issue(1)]);
  const { rc, lines } = await run([1], { sizeCheck: false });
  assert.equal(rc, 0, lines.join('\n'));
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.deepEqual(s.issues[0].labels, [L.ready]);
  assert.equal(s.prs[0].state, 'MERGED', 'merged by hx, not by the implementer');
  assert.equal(audits(1).length, 1);
  assert.match(audits(1)[0].body, /PASS/);
  // the PASS comment carries the auditor's evidence for every criterion (#233)
  const body = audits(1)[0].body;
  assert.ok(body.includes('\n- issue #1 criterion 1: writes impl-1.txt — impl-1.txt:1 — `git show --stat HEAD` → impl-1.txt | 1 +\n'), body);
  assert.ok(body.includes('\n- issue #1 criterion 2: tests pass — test/x.test.ts:3 — `npm test` → pass 3, fail 0'), body);
  assert.doesNotMatch(audits(1)[0].body, /- none/);
  assert.deepEqual([...new Set(readUsage(stateDir).filter((r) => r.issue === 1).map((r) => r.role))].sort(), ['audit', 'impl']);
  assert.equal(git(root, 'ls-remote', '--heads', 'origin', 'issue/1'), '', 'branch deleted after the merge');
  assert.ok(!existsSync(path.join(tmp, 'wt', 'a1')), 'audit worktree removed');
  // the implementer and the auditor both get the trusted set (the gh login) for scripts/issue.mjs
  const envs = sessionEnvs(fakeDir);
  assert.deepEqual([...new Set(envs.map((e) => e.role))].sort(), ['audit', 'implement']);
  for (const e of envs) assert.equal(e.trusted, 'me', JSON.stringify(e));
});

test('audit PASS whose evidence carries the red result on the reverted code and the green one on the branch: merged, posted (#251)', E2E, async () => {
  board([issue(12, 'AUDITREVERT')]);
  const { rc, lines } = await run([12]);
  assert.equal(rc, 0, lines.join('\n'));
  const s = read();
  assert.equal(s.issues.find((i: any) => i.number === 12).state, 'CLOSED');
  assert.equal(s.prs.find((p: any) => p.head === 'issue/12').state, 'MERGED');
  assert.equal(audits(12).length, 1);
  const body = audits(12)[0].body;
  assert.match(body, /PASS/);
  assert.ok(body.includes('\n- issue #12 criterion 1: writes impl-12.txt — test/impl.test.ts "writes it" — reverted: `node --test test/impl.test.ts` → fail 1, pass 0 — branch: `node --test test/impl.test.ts` → pass 1, fail 0\n'), body);
  assert.ok(body.includes('\n- issue #12 criterion 2: not testable per the issue — docs/x.md:3 — `git diff --stat` → docs/x.md | 2 +'), body);
});

test('audit PASS with no hx-ship.json (a PR opened outside ship): hx rebuilds the state from the PR and merges it', E2E, async () => {
  board([issue(11, 'SHIPNOSTATE')]);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  let rc: number;
  try {
    rc = await pooled((signal) => runPool(project({ gateCommand: 'node -e "process.exit(0)"', gate: false }), { workers: 1, watch: false, dryRun: false, only: [11], signal }));
  } finally { console.log = orig; }
  assert.equal(rc, 0, lines.join('\n'));
  const s = read();
  assert.equal(s.issues[0].state, 'CLOSED', lines.join('\n'));
  assert.equal(s.prs[0].state, 'MERGED');
  assert.ok(lines.some((l) => /DONE ✓ audited and merged/.test(l)), lines.join('\n'));
  assert.ok(!s.issues[0].labels.includes(L.blocked));
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

// the first prompt of each audit session of issue n, in the order they ran
const auditPrompts = (n: number) => readdirSync(fakeDir).filter((f) => f.endsWith('.prompt-1.txt'))
  .map((f) => ({ f, t: statSync(path.join(fakeDir, f)).mtimeMs, text: readFileSync(path.join(fakeDir, f), 'utf8') }))
  .filter((p) => /^Role: audit/.test(p.text) && p.text.includes(`Issue: #${n} `)).sort((a, b) => a.t - b.t).map((p) => p.text);
// the head the k-th audit of issue n checked (the fake writes audit-<origin hash>-<n>-<k>.sha; this file has one origin)
const auditedSha = (n: number, k: number) => readFileSync(path.join(fakeDir, readdirSync(fakeDir).find((f) => f.endsWith(`-${n}-${k}.sha`))!), 'utf8').trim();

test('audit PASS but the merge hits a rebase conflict: a merge round, the audit round unchanged, then merged (#347)', E2E, async () => {
  board([issue(5, 'AUDITCONFLICT')]);
  const { rc, lines } = await run([5]);
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /\[#5\] merge after audit failed \(rebase conflict\) — back to the implementer, merge round 1\/3 \(audit round 1\/2 unchanged\)$/.test(l)), lines.join('\n'));
  const s = read();
  const retry = s.comments.filter((c: any) => c.issue === 5 && c.body.startsWith('<!-- hx-retry -->'));
  assert.equal(retry.length, 1);
  assert.match(retry[0].body, /merge after audit failed \(rebase conflict\) — back to the implementer, merge round 1\/3 \(audit round 1\/2 unchanged\) \(PR #\d+\)/);
  // the re-audit is still audit round 1: the merge failure used no audit round
  assert.deepEqual(audits(5).map((c: any) => /\*\*hx audit (\d+\/\d+): (PASS|FAIL)/.exec(c.body)?.slice(1).join(' ')), ['1/2 PASS', '1/2 PASS']);
  assert.equal(s.issues[0].state, 'CLOSED');
  assert.ok(s.prs.some((p: any) => p.state === 'MERGED'));
  assert.ok(lines.some((l) => /\[#5\] DONE ✓ audited and merged \(1 round\(s\), 1 merge round\(s\), /.test(l)), lines.join('\n'));
  // the re-audit is told the sha the first audit passed, and to check the commits since it
  const [first, second] = auditPrompts(5);
  assert.doesNotMatch(first, /re-audit/);
  assert.ok(second.includes(`the previous audit PASSED at ${auditedSha(5, 1)}`), second);
  assert.ok(second.includes(`git log --oneline ${auditedSha(5, 1)}..HEAD`), second);
});

test('auditRounds 1: an audit PASS then two merge failures is still retried, not failed (#347)', E2E, async () => {
  board([issue(13, 'AUDITCONFLICT2')]);
  const { rc, lines } = await run([13], { auditRounds: 1 });
  assert.equal(rc, 0, lines.join('\n'));
  for (const k of [1, 2]) assert.ok(lines.some((l) => new RegExp(`\\[#13\\] merge after audit failed \\(rebase conflict\\) — back to the implementer, merge round ${k}/3 \\(audit round 1/1 unchanged\\)$`).test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /still not passing/.test(l)), lines.join('\n'));
  const s = read();
  assert.equal(s.issues.find((i: any) => i.number === 13).state, 'CLOSED');
  assert.ok(lines.some((l) => /\[#13\] DONE ✓ audited and merged \(1 round\(s\), 2 merge round\(s\), /.test(l)), lines.join('\n'));
  // each re-audit names the sha the audit before it passed
  const p = auditPrompts(13);
  assert.equal(p.length, 3);
  assert.ok(p[1].includes(`PASSED at ${auditedSha(13, 1)}`) && p[2].includes(`PASSED at ${auditedSha(13, 2)}`));
  assert.notEqual(auditedSha(13, 1), auditedSha(13, 2));
});

test('mergeRounds merge failures in a row: failed, the reason naming the merge rounds (#347)', E2E, async () => {
  board([issue(14, 'AUDITCONFLICT9')]);
  const { rc, lines } = await run([14], { mergeRounds: 2, selfHeal: false }); // no health pass resuming it afterwards
  assert.equal(rc, 1, lines.join('\n'));
  const s = read();
  const i = s.issues.find((x: any) => x.number === 14);
  assert.equal(i.state, 'OPEN');
  assert.ok(i.labels.includes(L.blocked));
  assert.ok(s.prs.filter((p: any) => p.head === 'issue/14').every((p: any) => p.state === 'OPEN'), 'nothing merged');
  assert.equal(audits(14).length, 2, 'one audit per merge round');
  assert.ok(lines.some((l) => /\[#14\] merge after audit failed \(rebase conflict\) — back to the implementer, merge round 1\/2 \(audit round 1\/2 unchanged\)$/.test(l)), lines.join('\n'));
  assert.ok(s.comments.some((c: any) => c.issue === 14 && /still not merging after 2 merge round\(s\) \(audit 1\/2 passed\)/.test(c.body)),
    JSON.stringify(s.comments.filter((c: any) => c.issue === 14)));
  assert.ok(!s.comments.some((c: any) => c.issue === 14 && /still not passing after/.test(c.body)));
});

test('the audit prompt: {{REAUDIT_NOTE}} is empty on a first audit and carries the passed sha after a merge-fix round (#347)', E2E, () => {
  const t = readFileSync(path.join(here, '..', 'prompts', 'audit.md'), 'utf8');
  assert.equal(t.split('{{REAUDIT_NOTE}}').length, 2, 'the placeholder once');
  assert.equal(render(t, { REAUDIT_NOTE: '' }), t.replace('{{REAUDIT_NOTE}}', ''));
  const sha = 'abc1234def5678abc1234def5678abc1234def56';
  const out = render(t, { REAUDIT_NOTE: reauditNote(sha, 'main') });
  assert.ok(out.includes(`the previous audit PASSED at ${sha}`), out);
  assert.ok(out.includes(`check the commits since ${sha}`));
  assert.ok(out.includes(`\`git log --oneline ${sha}..HEAD\``));
  assert.ok(out.includes(`\`git diff ${sha} HEAD\``));
  assert.match(out, /Do not re-audit the whole PR from scratch/);
  assert.match(out, /can still break a criterion that passed: then VERDICT: FAIL/);
  assert.match(out, /anything\.\nThis is a re-audit[^\n]*\nBe economical/, 'a line of its own');
});
