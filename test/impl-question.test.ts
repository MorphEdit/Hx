// needs-human on the impl path (#293): an impl session stops with `<promise>NEEDS_HUMAN <n></promise>`, hx posts its
// question, labels the issue needs-human and keeps the worktree, within maxOpenQuestions. Unit tests, then end to end
// (real git with a local bare origin, fake gh and claude).
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-iq-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, readPlan, answeredQuestions, oneAtATime, questionNote, IMPL_TOO_MANY_QUESTIONS } = await import('../src/pool.ts');
const { runGoal } = await import('../src/agent.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');
const { render, PROMISE_RE } = await import('../src/state.ts');
const { questionFromReply, QUESTION_MARKER } = await import('../src/question.ts');

const fakeClaude = path.join(here, 'fakes', 'claude.mjs');

// --- runGoal's alt promise ---
const goalBase = { bin: fakeClaude, cwd: tmp, model: 'x', extraArgs: [], timeoutMs: 30_000, prompt: 'Issue: #5',
  continuePrompt: 'c #5', promise: 'ISSUE 5 DONE', maxIterations: 2 };
async function withReply<T>(text: string, fn: () => Promise<T>): Promise<T> {
  process.env.FAKE_CLAUDE_TEXT = text;
  try { return await fn(); } finally { delete process.env.FAKE_CLAUDE_TEXT; }
}

test('runGoal: the alt promise stops the loop on its turn and is reported; it is no completion', E2E, async () => {
  const r = await withReply('a question?\n<promise> NEEDS_HUMAN 5 </promise>', () => runGoal({ ...goalBase, altPromise: 'NEEDS_HUMAN 5' }));
  assert.equal(r.stopReason, 'promise');
  assert.equal(r.promiseSeen, 'alt');
  assert.equal(r.done, false);
  assert.equal(r.iterations, 1);
  const main = await withReply('<promise>ISSUE 5 DONE</promise>', () => runGoal({ ...goalBase, altPromise: 'NEEDS_HUMAN 5' }));
  assert.deepEqual([main.done, main.stopReason, main.promiseSeen, main.iterations], [true, 'promise', 'main', 1]);
});

test('runGoal: NEEDS_HUMAN of another issue does not match; without altPromise NEEDS_HUMAN stops nothing', E2E, async () => {
  const other = await withReply('<promise>NEEDS_HUMAN 55</promise>', () => runGoal({ ...goalBase, altPromise: 'NEEDS_HUMAN 5' }));
  assert.deepEqual([other.done, other.stopReason, other.promiseSeen, other.iterations], [false, 'max-iterations', undefined, 2]);
  const none = await withReply('<promise>NEEDS_HUMAN 5</promise>', () => runGoal(goalBase));
  assert.deepEqual([none.done, none.stopReason, none.promiseSeen, none.iterations], [false, 'max-iterations', undefined, 2]);
});

// --- the pure helpers ---
const QBODY = '**Hx needs your answer:** keep the scores?\n\n- **A)** Yes (recommended) — scores stay\n- **B)** No — scores reset';

test('questionFromReply: the promise line removed and trimmed; the marker kept, or put first when missing', E2E, () => {
  assert.equal(questionFromReply(`\n${QUESTION_MARKER}\n${QBODY}\n\n<promise>NEEDS_HUMAN 7</promise>\n`, PROMISE_RE('NEEDS_HUMAN 7')), `${QUESTION_MARKER}\n${QBODY}`);
  assert.equal(questionFromReply(`${QBODY}\n<promise>NEEDS_HUMAN 7</promise>`, PROMISE_RE('NEEDS_HUMAN 7')), `${QUESTION_MARKER}\n${QBODY}`);
  // another issue's promise is not this one's: it stays
  assert.equal(questionFromReply(`${QBODY}\n<promise>NEEDS_HUMAN 70</promise>`, PROMISE_RE('NEEDS_HUMAN 7')), `${QUESTION_MARKER}\n${QBODY}\n<promise>NEEDS_HUMAN 70</promise>`);
});

test('oneAtATime: the second call starts only after the first has settled, a rejection included', E2E, async () => {
  const events: string[] = [];
  let release!: () => void;
  const first = oneAtATime(async () => { events.push('1 start'); await new Promise<void>((r) => (release = r)); events.push('1 end'); throw new Error('x'); });
  const second = oneAtATime(async () => { events.push('2 start'); return 2; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ['1 start'], 'the second waits on the first');
  release();
  await assert.rejects(first, /x/);
  assert.equal(await second, 2);
  assert.deepEqual(events, ['1 start', '1 end', '2 start']);
});

const impl = readFileSync(path.join(here, '..', 'prompts', 'impl.md'), 'utf8');

test('impl prompt: the question format, when to ask, never paste a secret, decisions made for you, the NEEDS_HUMAN promise', E2E, () => {
  for (const w of ['<!-- hx-question -->', '**Hx needs your answer:**', '- **A)** <choice> (recommended) —', '- **B)** <choice> —',
    'Reply with just the letter, or say what you want in your own words.',
    "ask the owner only when no sensible default exists or the owner's own resource is needed",
    'A secret\nis never pasted into a comment', 'gitignored', 'reply "done"', 'reply OK, or describe what\nwas wrong',
    '`## Decisions made for you`', 'push the branch', 'open, merge and close\nnothing', '{{QUESTION_NOTE}}'])
    assert.ok(impl.includes(w), w);
  assert.ok(impl.split('\n').includes('<promise>NEEDS_HUMAN {{ISSUE}}</promise>'), 'the exact promise line');
  const f = impl.slice(impl.indexOf('<!-- hx-question -->'));
  assert.ok(f.indexOf('**Hx needs your answer:**') < f.indexOf('**A)**') && f.indexOf('**A)**') < f.indexOf('Reply with just the letter'));
  // the normal promise stays the last line
  assert.equal(impl.trimEnd().split('\n').at(-1), '<promise>{{PROMISE}}</promise>');
});

test('impl prompt: QUESTION_NOTE is empty under the cap and, at it, says to take the recommended choice', E2E, () => {
  assert.equal(questionNote(2, 3), '');
  const under = render(impl, { QUESTION_NOTE: questionNote(0, 3), ISSUE: 9 });
  assert.doesNotMatch(under, /do not ask one/);
  assert.ok(!under.includes('{{QUESTION_NOTE}}'));
  for (const open of [3, 4]) {
    const full = render(impl, { QUESTION_NOTE: questionNote(open, 3), ISSUE: 9 });
    assert.match(full, new RegExp(`the owner already has ${open} open question\\(s\\), the most allowed \\(3\\): do not ask one\\. Take the recommended choice yourself and note it in the PR body under \`## Decisions made for you\``));
    assert.ok(full.includes('<promise>NEEDS_HUMAN 9</promise>'));
  }
  assert.equal(IMPL_TOO_MANY_QUESTIONS, '**hx:** too many open questions; the next session takes the recommended choice');
});

// --- end to end ---
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
  claudeBin: fakeClaude, maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false,
  security: false, trustedAuthors: ['Alice'], ...extra } });
// the gh login is Hx-Bot (a comment without an author is its own); alice is trusted
const board = (issues: any[], comments: any[] = []) => writeFileSync(stateFile, JSON.stringify({ login: 'Hx-Bot', comments, prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const commentsOn = (n: number): string[] => read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body);
const answer = (n: number, body: string) => writeFileSync(stateFile, JSON.stringify({ ...read(),
  comments: [...read().comments, { issue: n, body, author: 'alice', createdAt: new Date(Date.now() + 1000).toISOString() }] }));
const ready = (n: number, body: string) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels: [L.ready], createdAt: '2026-01-01T00:00:00Z' });
const implPrompts = (since: number) => readdirSync(fakeDir).filter((f) => f.endsWith('.prompt-1.txt')).map((f) => path.join(fakeDir, f))
  .filter((f) => statSync(f).mtimeMs >= since).map((f) => readFileSync(f, 'utf8')).filter((t) => /^Role: implement/.test(t));

async function run(extra = {}, workers = 1) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers, watch: false, dryRun: false, signal })), lines };
  } finally { console.log = orig; }
}
const workDir = (lines: string[], n: number) => lines.map((l) => new RegExp(`\\[#${n}\\] working in (.+?)( \\(resuming earlier work\\))?$`).exec(l)).filter(Boolean).map((m) => m![1]);

/** The question was posted (marker first, no promise), the issue waits on the owner, nothing failed, the worktree is kept. */
function assertAsked(n: number, lines: string[]) {
  const qs = commentsOn(n).filter((b) => b.startsWith(QUESTION_MARKER));
  assert.equal(qs.length, 1, commentsOn(n).join('\n---\n'));
  assert.equal(qs[0], `${QUESTION_MARKER}\n**Hx needs your answer:** keep the scores after a restart?\n\n- **A)** Yes (recommended) — scores stay\n- **B)** No — scores reset\n\nReply with just the letter, or say what you want in your own words.`);
  assert.doesNotMatch(qs[0], /<promise>|NEEDS_HUMAN/);
  const i = issue(n);
  assert.equal(i.state, 'OPEN');
  assert.deepEqual(i.labels, [L.needsHuman], 'needs-human, not ready-for-agent / agent-working / agent-blocked');
  assert.ok(!commentsOn(n).some((b) => /stopped —/.test(b)), 'no failure comment');
  assert.ok(lines.some((l) => new RegExp(`\\[#${n}\\] asked the owner a question — labelled needs-human`).test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /FAILED|crashed/.test(l)), lines.join('\n'));
  const [dir] = workDir(lines, n);
  assert.ok(dir && existsSync(path.join(dir, `wip-${n}.txt`)), `worktree kept: ${dir}`);
  return dir;
}

test('impl NEEDS_HUMAN: the question is posted, needs-human, worktree kept; a trusted answer resumes it on the same branch', E2E, async () => {
  board([ready(20, 'Save scores. IMPLQUESTION')]);
  const first = await run();
  assert.equal(first.rc, 0, first.lines.join('\n'));
  const dir = assertAsked(20, first.lines);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'issue/20');
  assert.equal(read().prs.length, 0, 'no PR looked for or opened');

  answer(20, 'A');
  const since = Date.now();
  const second = await run();
  assert.equal(second.rc, 0, second.lines.join('\n'));
  assert.ok(second.lines.some((l) => /\[#20\] the owner answered — needs-human → ready-for-agent/.test(l)), second.lines.join('\n'));
  assert.deepEqual(workDir(second.lines, 20), [dir], 'the kept worktree');
  assert.ok(second.lines.some((l) => l.endsWith(`[#20] working in ${dir} (resuming earlier work)`)), second.lines.join('\n'));
  const [p] = implPrompts(since);
  assert.match(p, /this branch already has work from an earlier session/);
  assert.match(p, /The owner answered a question on this issue[\s\S]*keep the scores after a restart\?[\s\S]*The owner's answer:\s+A\n/);
  assert.equal(issue(20).state, 'CLOSED', 'built from the answer');
});

test('impl NEEDS_HUMAN: a final message without the marker gets it added as the first line', E2E, async () => {
  board([ready(21, 'Save scores. IMPLQUESTION IMPLQUESTIONBARE')]);
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assertAsked(21, lines);
});

test('impl NEEDS_HUMAN: only the final message is posted, never the narration before it (tool calls, a marker of its own)', E2E, async () => {
  board([ready(29, 'Save scores. IMPLQUESTION IMPLQUESTIONNARRATE'), ready(30, 'Save scores. IMPLQUESTION IMPLQUESTIONNARRATE IMPLQUESTIONBARE')]);
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  for (const n of [29, 30]) {
    assertAsked(n, lines);
    assert.ok(!commentsOn(n).some((b) => /I'll read the issue|Committed and pushed/.test(b)), commentsOn(n).join('\n---\n'));
  }
  answer(29, 'A');
  const since = Date.now();
  assert.equal((await run()).rc, 0);
  const [p] = implPrompts(since);
  assert.match(p, /The owner answered a question on this issue/);
  const note = /The question:([\s\S]*?)The owner's answer:/.exec(p)?.[1] ?? '';
  assert.match(note, /keep the scores after a restart\?/);
  assert.doesNotMatch(note, /I'll read the issue|Committed and pushed|<!-- hx-question -->/, 'the owner note holds the question alone');
});

test('impl NEEDS_HUMAN on the audited path: the same, and no audit runs', E2E, async () => {
  board([ready(22, 'Save scores. IMPLQUESTION')]);
  const { rc, lines } = await run({ audit: true });
  assert.equal(rc, 0, lines.join('\n'));
  assertAsked(22, lines);
  assert.ok(!lines.some((l) => /\[#22\] audit/.test(l)), lines.join('\n'));
  assert.deepEqual(readUsage(stateDir).filter((r) => r.issue === 22).map((r) => r.role), ['impl']);
  assert.equal(read().prs.length, 0);
});

test('impl NEEDS_HUMAN: a question that cannot be posted fails the issue (agent-blocked), never asked again in a loop', E2E, async () => {
  board([ready(28, 'Save scores. IMPLQUESTION')]);
  writeFileSync(stateFile, JSON.stringify({ ...read(), commentFails: QUESTION_MARKER }));
  const { lines } = await run();
  const i = issue(28);
  assert.ok(i.labels.includes(L.blocked) && !i.labels.includes(L.needsHuman) && !i.labels.includes(L.working), i.labels.join());
  assert.ok(lines.some((l) => /\[#28\] impl FAILED ✗ — the question for the owner could not be posted: .*502/.test(l)), lines.join('\n'));
  assert.equal(lines.filter((l) => /\[#28\] impl turn 1/.test(l)).length, 1, 'one session');
  assert.ok(!commentsOn(28).some((b) => b.startsWith(QUESTION_MARKER)));
});

test('impl NEEDS_HUMAN at the cap: no question, no needs-human, the too-many comment, back to ready with the worktree kept', E2E, async () => {
  board([ready(23, 'Save scores. IMPLQUESTIONFIRST'),
    { number: 24, title: '[needs you] colour?', body: `${QUESTION_MARKER}\nwhich colour?`, state: 'OPEN', labels: [L.needsHuman] }]);
  const since = Date.now();
  const { rc, lines } = await run({ maxOpenQuestions: 1 });
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(!commentsOn(23).some((b) => b.includes(QUESTION_MARKER)), 'no question posted');
  assert.deepEqual(commentsOn(23), [IMPL_TOO_MANY_QUESTIONS]);
  assert.ok(lines.some((l) => /\[#23\] asked a question, but 1 of at most 1 are open — not posted, back to ready-for-agent/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /\[#23\].*labelled needs-human|FAILED/.test(l)), lines.join('\n'));
  // the issue was ready again: the next session took it on the kept worktree, told the cap is reached
  const dirs = workDir(lines, 23);
  assert.equal(dirs.length, 2, lines.join('\n'));
  assert.equal(dirs[0], dirs[1]);
  assert.ok(lines.some((l) => l.endsWith(`[#23] working in ${dirs[0]} (resuming earlier work)`)), lines.join('\n'));
  const prompts = implPrompts(since).filter((t) => /Issue: #23 /.test(t));
  assert.equal(prompts.length, 2);
  for (const t of prompts) assert.match(t, /the owner already has 1 open question\(s\), the most allowed \(1\): do not ask one/);
  const i = issue(23);
  assert.ok(i.labels.includes(L.ready) && !i.labels.includes(L.needsHuman) && !i.labels.includes(L.working), i.labels.join());
  assert.equal(i.state, 'CLOSED');
  assert.deepEqual(issue(24).labels, [L.needsHuman]);
});

test('impl NEEDS_HUMAN: two sessions that stop together at the cap minus one — only one question is posted', E2E, async () => {
  board([ready(25, 'IMPLQUESTIONFIRST'), ready(26, 'IMPLQUESTIONFIRST')]);
  const { rc, lines } = await run({ maxOpenQuestions: 1 }, 2);
  assert.equal(rc, 0, lines.join('\n'));
  const asked = [25, 26].filter((n) => commentsOn(n).some((b) => b.startsWith(QUESTION_MARKER)));
  const capped = [25, 26].filter((n) => commentsOn(n).includes(IMPL_TOO_MANY_QUESTIONS));
  assert.equal(asked.length, 1, lines.join('\n'));
  assert.equal(capped.length, 1, lines.join('\n'));
  assert.notEqual(asked[0], capped[0]);
  assert.deepEqual(issue(asked[0]).labels, [L.needsHuman]);
  assert.equal(read().issues.filter((i: any) => i.state === 'OPEN' && i.labels.includes(L.needsHuman)).length, 1);
});

test('a [needs you] issue answered, claimed, that asks again stays needs-human until a trusted answer after the new question', E2E, async () => {
  const body = `${QUESTION_MARKER}\n**Hx needs your answer:** local or cloud?\n\n- **A)** local (recommended) — on this PC\n- **B)** cloud — online\n\nIMPLQUESTIONALWAYS`;
  board([{ number: 27, title: '[needs you] local or cloud?', body, state: 'OPEN', labels: [L.needsHuman], createdAt: '2026-01-01T00:00:00Z' }],
    [{ issue: 27, body: 'B', author: 'alice', createdAt: '2026-01-02T00:00:00Z' }]);
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  assert.equal(lines.filter((l) => /\[#27\] the owner answered/.test(l)).length, 1, 'the old answer counted once, for the body question');
  assertAsked(27, lines);
  // the old answer is before the new question: it does not count
  const p = project();
  const trusted = new Set(['hx-bot', 'alice']);
  assert.equal(await answeredQuestions(p, await readPlan(p, trusted), trusted), 0);
  assert.deepEqual(issue(27).labels, [L.needsHuman]);
  answer(27, 'A, keep it local');
  assert.equal(await answeredQuestions(p, await readPlan(p, trusted), trusted), 1);
  assert.deepEqual(issue(27).labels, [L.ready]);
});
