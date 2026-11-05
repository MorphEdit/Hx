// needs-human on the decompose path: the decomposer files `[needs you]` question issues, hx keeps them within
// maxOpenQuestions after the session. End to end with real git (a local bare origin), fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-nh-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, questionsLeftLine, TOO_MANY_QUESTIONS } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readUsage } = await import('../src/usage.ts');
const { render } = await import('../src/state.ts');

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
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, security: false, ...extra } });

const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const commentsOn = (n: number) => read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body);
const openQuestionCount = () => read().issues.filter((i: any) => i.state === 'OPEN' && i.labels.includes(L.needsHuman)).length;
const prd = (n: number, body: string) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels: [L.prd] });
// the newest decompose prompt (this test's): file names are session ids, so order by time
// the first impl prompt of issue n
const implPrompt = (n: number) => readdirSync(fakeDir).filter((f) => /\.prompt-1\.txt$/.test(f))
  .map((f) => readFileSync(path.join(fakeDir, f), 'utf8')).find((t) => t.startsWith('Role: implement') && t.includes(`Issue: #${n} `)) ?? '';
const decomposePrompt = () => readdirSync(fakeDir).filter((f) => /\.prompt-1\.txt$/.test(f)).map((f) => path.join(fakeDir, f))
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  .map((f) => readFileSync(f, 'utf8')).filter((t) => /^Role: decompose/.test(t)).at(-1) ?? '';

async function run(extra = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers: 2, watch: false, dryRun: false, signal })), lines };
  } finally { console.log = orig; }
}

test('decompose files a [needs you] child: never claimed nor auto-readied, its sibling merges, the PRD is not reviewed', E2E, async () => {
  board([prd(1, 'Save scores. DECOMPOSEQUESTION\n\n## Blocked by\nNone\n')]);
  const { rc, lines } = await run();
  assert.deepEqual(lines.filter((l) => /crashed|FAILED/.test(l)), [], lines.join('\n'));
  assert.equal(rc, 0, lines.join('\n'));
  // #2 part A (ready-for-agent), #3 the question (needs-human)
  assert.equal(issue(2).state, 'CLOSED', 'the sibling ran and merged');
  const q = issue(3);
  assert.match(q.title, /^\[needs you\] /);
  assert.equal(q.state, 'OPEN');
  assert.deepEqual(q.labels, [L.needsHuman], 'never given ready-for-agent (label-ready) nor claimed');
  assert.deepEqual(lines.filter((l) => /\[#3\]/.test(l)), [], 'no session touched the question');
  assert.deepEqual(commentsOn(3), []);
  // the PRD waits on the open question: no review, no sign-off, not closed
  const p = issue(1);
  assert.equal(p.state, 'OPEN');
  assert.ok(!p.labels.includes(L.reviewed), p.labels.join());
  const roles = new Set(readUsage(stateDir).map((r) => r.role));
  assert.deepEqual([...roles].sort(), ['decompose', 'impl']);
  // the prompt it got said how many it may still file, under the default cap
  assert.match(decomposePrompt(), /You may still file 3 such question issue\(s\) \(0 of at most 3 are open now\)/);
  assert.match(decomposePrompt(), /--label needs-human/);
});

test('decompose files more questions than the cap allows: the newest excess become ready-for-agent with a comment', E2E, async () => {
  // #2 an open question elsewhere; #3 part A; #4-#7 four questions → 5 open, cap 2: #7, #6, #5 are swapped
  board([prd(1, 'Save scores. DECOMPOSEQUESTIONS4\n\n## Blocked by\nNone\n'),
    { number: 2, title: '[needs you] an older question', body: 'which colour?', state: 'OPEN', labels: [L.needsHuman] }]);
  const { rc, lines } = await run({ maxOpenQuestions: 2 });
  assert.deepEqual(lines.filter((l) => /crashed|FAILED/.test(l)), [], lines.join('\n'));
  assert.equal(rc, 0, lines.join('\n'));
  assert.match(decomposePrompt(), /You may still file 1 such question issue\(s\) \(1 of at most 2 are open now\)/);
  for (const n of [5, 6, 7]) {
    const i = issue(n);
    assert.ok(i.labels.includes(L.ready) && !i.labels.includes(L.needsHuman), `#${n}: ${i.labels.join()}`);
    assert.equal(commentsOn(n).filter((b: string) => b === TOO_MANY_QUESTIONS).length, 1, `#${n} commented once`);
    assert.equal(i.state, 'CLOSED', `#${n} was then built with the recommended choice`);
    // hx's cap comment is not the owner's answer: the prompt says the owner was not asked (#332)
    const prompt = implPrompt(n);
    assert.ok(prompt, `#${n} had an impl session`);
    assert.doesNotMatch(prompt, /The owner answered|## Owner decisions`\./, `#${n}`);
    assert.match(prompt, /The owner was not asked this issue's question[\s\S]*Take the recommended choice yourself and note it in the PR body under `## Decisions made for you`/, `#${n}`);
    assert.match(prompt, /keep scores\?/, `#${n}: the question is in the prompt`);
  }
  for (const n of [2, 4]) {
    assert.deepEqual(issue(n).labels, [L.needsHuman], `#${n} still a question`);
    assert.deepEqual(commentsOn(n), []);
  }
  assert.equal(openQuestionCount(), 2, 'the open count ends at maxOpenQuestions');
  assert.equal(TOO_MANY_QUESTIONS, '**hx:** too many open questions; the agent takes the recommended choice');
  assert.ok(lines.some((l) => /too many open questions \(cap 2\): #7, #6, #5 relabelled ready-for-agent/.test(l)), lines.join('\n'));
});

const decompose = readFileSync(path.join(here, '..', 'prompts', 'decompose.md'), 'utf8');

test('decompose prompt: the question format, the [needs you] title and the rules', E2E, () => {
  for (const w of ['<!-- hx-question -->', '**Hx needs your answer:**', '- **A)** <choice> (recommended) —', '- **B)** <choice> —',
    'Reply with just the letter, or say what you want in your own words.', '`[needs you] <short question>`', '--label {{LABEL_NEEDS_HUMAN}}',
    "never listed under any sibling's `## Blocked by`", "ask the owner only when no sensible default exists or the owner's own resource is\n   needed",
    'A secret is never pasted into a comment', 'gitignored', 'reply "done"', 'reply OK, or describe what was wrong',
    '`## Decisions made for you`', '{{QUESTIONS_LEFT}}', '--label {{LABEL_NEEDS_HUMAN}} --state open'])
    assert.ok(decompose.includes(w), w);
  // the marker line comes first in the format, the reply line last
  const f = decompose.slice(decompose.indexOf('<!-- hx-question -->'));
  assert.ok(f.indexOf('**Hx needs your answer:**') < f.indexOf('**A)**') && f.indexOf('**A)**') < f.indexOf('Reply with just the letter'));
});

test('decompose prompt: QUESTIONS_LEFT says how many may still be filed, and none at the cap', E2E, () => {
  const left = render(decompose, { QUESTIONS_LEFT: questionsLeftLine(1, 3), LABEL_NEEDS_HUMAN: L.needsHuman });
  assert.match(left, /You may still file 2 such question issue\(s\)/);
  assert.ok(!left.includes('{{QUESTIONS_LEFT}}'));
  for (const open of [3, 5]) {
    const full = render(decompose, { QUESTIONS_LEFT: questionsLeftLine(open, 3) });
    assert.match(full, /file none\. Take the recommended choice instead/, `${open} open`);
    assert.doesNotMatch(full, /You may still file/);
  }
  assert.equal(questionsLeftLine(0, 0).includes('file none'), true);
});
