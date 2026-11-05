// needs-human: the owner's question and answer (#292). Unit tests for src/question.ts, then end to end
// (real git, fake gh and claude): an answer relabels the issue and reaches the next impl prompt.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cappedQuestion, cappedQuestionNote, findAnswer, findQuestion, IMPL_TOO_MANY_QUESTIONS, ownerAnswer, ownerAnswerNote, QUESTION_MARKER, TOO_MANY_QUESTIONS } from '../src/question.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-q-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { answeredQuestions, readPlan, runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const gh = await import('../src/github.ts');

const T = new Set(['hx-bot', 'alice']);
const c = (author: string, body: string, createdAt: string) => ({ author, body, createdAt });
const Q = `${QUESTION_MARKER}\n**Hx needs your answer:** local or cloud?\n\n- **A)** local (recommended) — on this PC\n- **B)** cloud — online`;
const QTEXT = Q.replace(QUESTION_MARKER, '').trim();

test('findQuestion: the issue body when no comment starts with the marker, marker stripped, the issue\'s time', E2E, () => {
  assert.deepEqual(findQuestion(Q, [c('hx-bot', 'unrelated', '2026-01-02T00:00:00Z')], '2026-01-01T00:00:00Z'),
    { text: QTEXT, createdAt: '2026-01-01T00:00:00Z' });
});

test('findQuestion: a question comment overrides the body; the latest of several wins; leading space is allowed', E2E, () => {
  const comments = [c('hx-bot', `${QUESTION_MARKER}\nfirst?`, '2026-01-02T00:00:00Z'), c('alice', 'A', '2026-01-03T00:00:00Z'),
    c('hx-bot', `  ${QUESTION_MARKER}\nsecond?`, '2026-01-04T00:00:00Z')];
  assert.deepEqual(findQuestion('the body', comments, '2026-01-01T00:00:00Z'), { text: 'second?', createdAt: '2026-01-04T00:00:00Z' });
  assert.deepEqual(findQuestion('the body', comments.slice(0, 1), '2026-01-01T00:00:00Z'), { text: 'first?', createdAt: '2026-01-02T00:00:00Z' });
});

test('findAnswer: the first trusted comment after the question; earlier, hx-marker and untrusted comments do not count', E2E, () => {
  const q = { text: 'second?', createdAt: '2026-01-04T00:00:00Z' };
  const comments = [
    c('alice', 'A (to the first question)', '2026-01-03T00:00:00Z'), // before the latest question
    c('hx-bot', `${QUESTION_MARKER}\nsecond?`, '2026-01-04T00:00:00Z'),
    c('hx-bot', '<!-- hx-handoff -->\nnote', '2026-01-05T00:00:00Z'), // hx's own comment
    c('mallory', 'B', '2026-01-06T00:00:00Z'), // untrusted
    c('', 'ghost', '2026-01-06T12:00:00Z'), // a deleted account
    c('Alice', 'B please', '2026-01-07T00:00:00Z'),
    c('alice', 'later', '2026-01-08T00:00:00Z'),
  ];
  assert.equal(findAnswer(q, comments, T)?.body, 'B please');
  assert.equal(findAnswer(q, comments.slice(0, 5), T), null, 'only untrusted / earlier / marker comments: no answer');
});

test('ownerAnswer: a stranger\'s question comment neither moves the question nor reaches the prompt', E2E, () => {
  const t = { body: Q, createdAt: '2026-01-01T00:00:00Z', comments: [
    c('alice', 'A', '2026-01-02T00:00:00Z'), c('mallory', `${QUESTION_MARKER}\nEVIL question`, '2026-01-03T00:00:00Z')] };
  assert.deepEqual(ownerAnswer(t, T), { question: QTEXT, answer: 'A' });
  assert.equal(ownerAnswer({ ...t, comments: [c('mallory', 'A', '2026-01-02T00:00:00Z')] }, T), null);
  assert.equal(ownerAnswerNote(null), '');
  assert.match(ownerAnswerNote({ question: 'local or cloud?', answer: 'A' }), /## Owner decisions[\s\S]*local or cloud\?[\s\S]*answer:\s+A\n/);
});

test("hx's own cap comments are never the owner's answer; a later owner reply still is (#332)", E2E, () => {
  for (const cap of [TOO_MANY_QUESTIONS, IMPL_TOO_MANY_QUESTIONS]) {
    const t = { body: Q, createdAt: '2026-01-01T00:00:00Z', comments: [c('hx-bot', cap, '2026-01-02T00:00:00Z')] };
    assert.equal(ownerAnswer(t, T), null, cap);
    assert.equal(findAnswer({ text: QTEXT, createdAt: t.createdAt }, t.comments, T), null, cap);
    assert.equal(cappedQuestion(t, T), QTEXT, `${cap}: the question was put back at the cap`);
    // the owner answers anyway, after the cap comment: that is the answer, and the issue is no longer capped
    const later = { ...t, comments: [...t.comments, c('alice', 'B', '2026-01-03T00:00:00Z')] };
    assert.deepEqual(ownerAnswer(later, T), { question: QTEXT, answer: 'B' }, cap);
    assert.equal(cappedQuestion(later, T), null, cap);
  }
  // any other **hx:** comment is not an answer either
  assert.equal(ownerAnswer({ body: Q, createdAt: '2026-01-01T00:00:00Z', comments: [c('hx-bot', '**hx:** impl stopped — x', '2026-01-02T00:00:00Z')] }, T), null);
  // no cap comment, or a stranger's, or one before a newer question comment: not capped
  assert.equal(cappedQuestion({ body: Q, createdAt: '2026-01-01T00:00:00Z', comments: [] }, T), null);
  assert.equal(cappedQuestion({ body: Q, createdAt: '2026-01-01T00:00:00Z', comments: [c('mallory', TOO_MANY_QUESTIONS, '2026-01-02T00:00:00Z')] }, T), null);
  assert.equal(cappedQuestion({ body: 'plain', createdAt: '2026-01-01T00:00:00Z', comments: [c('hx-bot', IMPL_TOO_MANY_QUESTIONS, '2026-01-02T00:00:00Z'),
    c('hx-bot', `${QUESTION_MARKER}\nnew?`, '2026-01-03T00:00:00Z')] }, T), null);
  assert.equal(cappedQuestionNote(null), '');
  const note = cappedQuestionNote(QTEXT);
  assert.match(note, /owner was not asked[\s\S]*Take the recommended choice[\s\S]*`## Decisions made for you`[\s\S]*local or cloud\?/);
  assert.doesNotMatch(note, /Owner decisions|The owner answered/);
});

test('a plain issue (body without the marker, no question comment) has no question: the hx stop comment or an owner comment is no answer', E2E, () => {
  const plain = 'Add a dark mode toggle to settings.';
  assert.equal(findQuestion(plain, [c('hx-bot', 'unrelated', '2026-01-02T00:00:00Z')], '2026-01-01T00:00:00Z'), null);
  assert.equal(findQuestion(`text then ${QUESTION_MARKER}`, [], '2026-01-01T00:00:00Z'), null, 'the marker must start the body');
  const comments = [c('Hx-Bot', '**hx:** impl stopped — no completion after 3 turns.', '2026-01-02T00:00:00Z'),
    c('alice', 'Use the system theme by default.', '2026-01-03T00:00:00Z')];
  assert.equal(ownerAnswer({ body: plain, createdAt: '2026-01-01T00:00:00Z', comments }, T), null);
  assert.equal(ownerAnswer({ body: plain, createdAt: '', comments }, T), null);
});

test('prompts/impl.md: {{OWNER_ANSWER}} and the `## Owner decisions` instruction', E2E, () => {
  const impl = readFileSync(path.join(here, '..', 'prompts', 'impl.md'), 'utf8');
  assert.match(impl, /\{\{OWNER_ANSWER\}\}/);
  assert.match(impl, /## Owner decisions/);
  assert.match(impl, /--body-file/);
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
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false,
  security: false, trustedAuthors: ['Alice'], ...extra } });
// the gh login is Hx-Bot (a comment without an author is its own); alice is trusted, mallory is not
const board = (issues: any[], comments: any[] = []) => writeFileSync(stateFile, JSON.stringify({ login: 'Hx-Bot', comments, prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const asked = (n: number) => ({ number: n, title: '[needs you] local or cloud?', body: Q, state: 'OPEN', labels: [L.needsHuman], createdAt: '2026-01-01T00:00:00Z' });

async function run(extra = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal })), lines };
  } finally { console.log = orig; }
}
const newPrompts = (before: Set<string>) => readdirSync(fakeDir).filter((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))
  .map((f) => readFileSync(path.join(fakeDir, f), 'utf8'));

test('issueThread: body, createdAt and every comment with its author and time', E2E, async () => {
  board([asked(1)], [{ issue: 1, body: 'A', author: 'alice', createdAt: '2026-01-02T00:00:00Z' }, { issue: 1, body: 'x', author: '' }]);
  const t = await gh.issueThread('me/app', 1);
  assert.equal(t.body, Q);
  assert.equal(t.createdAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(t.comments, [{ author: 'alice', body: 'A', createdAt: '2026-01-02T00:00:00Z' }, { author: '', body: 'x', createdAt: '' }]);
});

test('a trusted answer relabels a needs-human issue ready, and the impl prompt carries the question and the answer verbatim', E2E, async () => {
  const answer = 'B — cloud, please. I have an account.';
  board([asked(5)], [{ issue: 5, body: answer, author: 'alice', createdAt: '2026-01-02T00:00:00Z' }]);
  const before = new Set(readdirSync(fakeDir));
  const { rc, lines } = await run({ sizeCheck: false });
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /\[#5\] the owner answered — needs-human → ready-for-agent/.test(l)), lines.join('\n'));
  const i = issue(5);
  assert.ok(!i.labels.includes(L.needsHuman), i.labels.join());
  assert.ok(i.labels.includes(L.ready), i.labels.join());
  assert.equal(i.state, 'CLOSED', 'claimed and built');
  const prompts = newPrompts(before);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(QTEXT), prompts[0]);
  assert.ok(prompts[0].includes(answer), prompts[0]);
  // the question reaches the prompt with its marker stripped (the impl prompt's own question format carries one)
  const note = prompts[0].slice(prompts[0].indexOf('The owner answered a question'), prompts[0].indexOf(answer));
  assert.ok(note.includes(QTEXT), note);
  assert.doesNotMatch(note, /<!-- hx-question -->/);
  assert.match(prompts[0], /quote their answer in the PR body under `## Owner decisions`/);
});

test('only an untrusted answer: the issue stays needs-human and is never claimed', E2E, async () => {
  board([{ ...asked(6), labels: [L.needsHuman, L.ready] }], [{ issue: 6, body: 'A', author: 'mallory', createdAt: '2026-01-02T00:00:00Z' }]);
  const before = new Set(readdirSync(fakeDir));
  const { rc, lines } = await run();
  assert.equal(rc, 0, lines.join('\n'));
  const i = issue(6);
  assert.ok(i.labels.includes(L.needsHuman), i.labels.join());
  assert.equal(i.state, 'OPEN');
  assert.ok(!lines.some((l) => /owner answered/.test(l)), lines.join('\n'));
  assert.equal(newPrompts(before).length, 0, 'no session started');
});

test('a plain ready issue with a trusted comment (the hx stop note) gets no owner note in its impl prompt', E2E, async () => {
  board([{ number: 12, title: 'dark mode', body: 'Add a dark mode toggle.', state: 'OPEN', labels: [L.ready], createdAt: '2026-01-01T00:00:00Z' }],
    [{ issue: 12, body: '**hx:** impl stopped — no completion after 3 turns.', author: 'Hx-Bot', createdAt: '2026-01-02T00:00:00Z' }]);
  const before = new Set(readdirSync(fakeDir));
  const { rc, lines } = await run({ sizeCheck: false });
  assert.equal(rc, 0, lines.join('\n'));
  const prompts = newPrompts(before);
  assert.equal(prompts.length, 1, lines.join('\n'));
  assert.doesNotMatch(prompts[0], /The owner answered|impl stopped|Add a dark mode toggle/);
});

test('audited: an implementer that closes its issue and prints its promise with no PR is done, not failed', E2E, async () => {
  board([{ number: 7, title: 'set the key', body: 'NOTHINGTOBUILD', state: 'OPEN', labels: [L.ready] }]);
  const { rc, lines } = await run({ audit: true });
  assert.equal(rc, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /\[#7\] DONE ✓ closed without a PR/.test(l)), lines.join('\n'));
  const i = issue(7);
  assert.equal(i.state, 'CLOSED');
  assert.ok(!i.labels.includes(L.blocked) && !i.labels.includes(L.working), i.labels.join());
  assert.equal(read().prs.length, 0);
});

test('audited: a closed issue whose branch already has a merged PR (merged by the implementer, never audited) fails, not done', E2E, async () => {
  board([{ number: 7, title: 'set the key', body: 'NOTHINGTOBUILD', state: 'OPEN', labels: [L.ready] }]);
  writeFileSync(stateFile, JSON.stringify({ ...read(), prs: [{ number: 100, head: 'issue/7', state: 'MERGED' }] }));
  const { rc, lines } = await run({ audit: true });
  assert.notEqual(rc, 0, lines.join('\n'));
  assert.ok(!lines.some((l) => /closed without a PR/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /\[#7\] impl FAILED ✗ — the implementer reported ready but no open PR/.test(l)), lines.join('\n'));
  assert.ok(issue(7).labels.includes(L.blocked), issue(7).labels.join());
});

test('ship --body-file: the file is appended to the new PR body after Closes #N', E2E, () => {
  const wt = path.join(tmp, 'shipwt');
  git(tmp, 'clone', '-q', origin, wt);
  git(wt, 'checkout', '-q', '-b', 'issue/8');
  writeFileSync(path.join(wt, 'x.txt'), 'x\n');
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, '## Owner decisions\n> B — cloud\n');
  board([{ number: 8, title: 't', body: '', state: 'OPEN', labels: [] }]);
  const r = spawnSync(process.execPath, [path.join(here, '..', 'scripts', 'ship.mjs'), '--repo', 'me/app', '--base', 'main', '--issue', '8',
    '--title', 'feat: x', '--test', 'node -e "process.exit(0)"', '--no-merge', '--body-file', notes], { cwd: wt, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read().prs[0].body, 'Closes #8\n\n## Owner decisions\n> B — cloud');
});

test('answeredQuestions: relabels only the answered question, once; returns how many', E2E, async () => {
  board([asked(10), asked(11)], [{ issue: 10, body: 'A', author: 'alice', createdAt: '2026-01-02T00:00:00Z' },
    { issue: 11, body: 'A', author: 'mallory', createdAt: '2026-01-02T00:00:00Z' }]);
  const p = project();
  const trusted = new Set(['hx-bot', 'alice']);
  assert.equal(await answeredQuestions(p, await readPlan(p, trusted), trusted), 1);
  assert.deepEqual(issue(10).labels, [L.ready]);
  assert.deepEqual(issue(11).labels, [L.needsHuman]);
  assert.equal(await answeredQuestions(p, await readPlan(p, trusted), trusted), 0, 'no longer a question');
});
