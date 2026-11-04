// The quality bar's pure round helpers (PRD #254, #256): paths, the A/B mapping, the judge reply, the PRD markers,
// the gap issue body, and the two bar prompts rendered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR_JUDGE_PROMISE, BAR_MARKER_PREFIX, barCapComment, barDir, barMarker, barRound, gapIssueBody, mappingFile, parseBarMarker,
  parseJudgeReply, pickMapping, readMapping, refDir, roundDir, writeMapping } from '../src/bar.ts';
import { parseBlockedBy, parseParent, render } from '../src/state.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-bar-'));
const P = 'BAR JUDGED';

test('paths: .hx/bar/<prd>/, its ref/ and r<round>/', () => {
  const s = path.join('x', '.hx');
  assert.equal(barDir(s, 7), path.join(s, 'bar', '7'));
  assert.equal(refDir(s, 7), path.join(s, 'bar', '7', 'ref'));
  assert.equal(roundDir(s, 7, 2), path.join(s, 'bar', '7', 'r2'));
  assert.equal(mappingFile(roundDir(s, 7, 2)), path.join(s, 'bar', '7', 'r2', '.mapping'));
});

test('pickMapping: the two sides differ, and seeds give both A = ours and A = ref', () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const m = pickMapping(rng);
    assert.notEqual(m.A, m.B);
    assert.ok(['ours', 'ref'].includes(m.A) && ['ours', 'ref'].includes(m.B));
    seen.add(m.A);
  }
  assert.deepEqual([...seen].sort(), ['ours', 'ref']);
  assert.deepEqual(pickMapping(() => 0.1), { A: 'ours', B: 'ref' });
  assert.deepEqual(pickMapping(() => 0.9), { A: 'ref', B: 'ours' });
});

test('writeMapping: .mapping in the round dir, A/ and B/ created empty; readMapping reads it back', () => {
  const r = roundDir(path.join(tmp, '.hx'), 12, 1);
  assert.equal(readMapping(r), null);
  writeMapping(r, { A: 'ref', B: 'ours' });
  assert.deepEqual(readdirSync(r).sort(), ['.mapping', 'A', 'B']);
  assert.deepEqual(readdirSync(path.join(r, 'A')), []);
  assert.deepEqual(readdirSync(path.join(r, 'B')), []);
  assert.ok(existsSync(path.join(r, '.mapping')));
  assert.deepEqual(readMapping(r), { A: 'ref', B: 'ours' });
});

test('parseJudgeReply: valid A and B replies, blank lines and whitespace ignored', () => {
  assert.deepEqual(parseJudgeReply(`winner: A\ngap: B has no undo.\n\n<promise>${P}</promise>`, P), { winner: 'A', gap: 'B has no undo.' });
  assert.deepEqual(parseJudgeReply(`\n\n  winner: B  \r\n\r\n   gap:   A takes four clicks to add an invoice.  \n\n  <promise>${P}</promise>  \n`, P),
    { winner: 'B', gap: 'A takes four clicks to add an invoice.' });
});

test('parseJudgeReply: anything else is null', () => {
  assert.equal(parseJudgeReply('winner: A\ngap: B has no undo.', P), null, 'missing promise');
  assert.equal(parseJudgeReply(`winner: A\ngap: B has no undo.\n<promise>OTHER</promise>`, P), null, 'another promise');
  assert.equal(parseJudgeReply(`I compared both.\nwinner: A\ngap: B has no undo.\n<promise>${P}</promise>`, P), null, 'three lines');
  assert.equal(parseJudgeReply(`winner: A\nscore: 7/10\ngap: B has no undo.\n<promise>${P}</promise>`, P), null, 'a score line');
  assert.equal(parseJudgeReply(`winner: A (8 vs 6)\ngap: B has no undo.\n<promise>${P}</promise>`, P), null, 'a score in the winner line');
  assert.equal(parseJudgeReply(`winner: A\ngap:\n<promise>${P}</promise>`, P), null, 'empty gap');
  assert.equal(parseJudgeReply(`winner: A\ngap:   \n<promise>${P}</promise>`, P), null, 'blank gap');
  assert.equal(parseJudgeReply(`winner: A\n<promise>${P}</promise>`, P), null, 'missing gap');
  assert.equal(parseJudgeReply(`winner: C\ngap: x.\n<promise>${P}</promise>`, P), null, 'no such side');
  assert.equal(parseJudgeReply(`gap: x.\nwinner: A\n<promise>${P}</promise>`, P), null, 'wrong order');
  assert.equal(parseJudgeReply('', P), null);
});

test('barMarker / parseBarMarker round-trip: won, lost with its gap issue, no verdict', () => {
  const won = barMarker(1, 'won', 'the reference loads slower.', { rounds: 3 });
  assert.equal(won.split('\n')[0], '<!-- hx-bar round=1 -->');
  assert.equal(won.split('\n')[1], '**hx quality bar round 1/3: won**');
  assert.deepEqual(parseBarMarker(won), { round: 1, result: 'won', gap: 'the reference loads slower.' });
  const lost = barMarker(2, 'lost', 'ours has no CSV export.', { rounds: 3, issue: 301 });
  assert.match(lost, /#301/);
  assert.deepEqual(parseBarMarker(lost), { round: 2, result: 'lost', gap: 'ours has no CSV export.', issue: 301 });
  const nv = barMarker(3, 'no verdict', 'the judge gave no valid reply twice.');
  assert.deepEqual(parseBarMarker(nv), { round: 3, result: 'no verdict', gap: 'the judge gave no valid reply twice.' });
  assert.equal(parseBarMarker('<!-- hx-review -->\n**hx review round 1/3**'), null);
  assert.equal(parseBarMarker('just text'), null);
});

test('barRound: only bodies whose first line starts with the prefix count, + 1', () => {
  assert.equal(barRound([]), 1);
  const bodies = [barMarker(1, 'lost', 'x.', { issue: 5 }), '<!-- hx-review -->\nreview', `quoted: ${BAR_MARKER_PREFIX}1 -->`,
    `text first\n${BAR_MARKER_PREFIX}2 -->`, barMarker(2, 'lost', 'y.', { issue: 6 }), barCapComment(3, 'y.')];
  assert.equal(barRound(bodies), 3);
});

test('barCapComment names the standing gap and is not a round marker', () => {
  const c = barCapComment(3, 'ours has no CSV export.');
  assert.match(c, /standing gap: ours has no CSV export\./);
  assert.match(c, /3 rounds/);
  assert.equal(parseBarMarker(c), null);
  assert.equal(barRound([c]), 1);
});

test('gapIssueBody: ends with Blocked by None and Parent #<prd>; parseParent and parseBlockedBy read it', () => {
  const b = gapIssueBody(254, 2, 'ours has no CSV export.', 'Acme Billing');
  assert.ok(b.endsWith('## Blocked by\nNone\n\n## Parent\n#254'));
  assert.match(b, /ours has no CSV export\./);
  assert.match(b, /Acme Billing/);
  assert.deepEqual(parseParent(b, 'o/r'), { repo: 'o/r', number: 254 });
  assert.deepEqual(parseBlockedBy(b, 'o/r'), []);
});

const prompt = (f: string) => readFileSync(path.join(root, 'prompts', f), 'utf8');
const DIMS = '- speed of adding an invoice\n- clarity of the totals';

test('bar-judge prompt, rendered: the two directories and the dimensions, no .mapping, no repo path, no {{ left', () => {
  const t = prompt('bar-judge.md');
  const A = path.join(tmp, '.hx', 'bar', '9', 'r1', 'A'), B = path.join(tmp, '.hx', 'bar', '9', 'r1', 'B');
  const s = render(t, { DIR_A: A, DIR_B: B, DIMENSIONS: DIMS, PROMISE: BAR_JUDGE_PROMISE });
  for (const x of [A, B, DIMS, `<promise>${BAR_JUDGE_PROMISE}</promise>`]) assert.ok(s.includes(x), x);
  assert.doesNotMatch(s, /\.mapping/);
  assert.doesNotMatch(s, /\{\{/);
  assert.ok(!s.includes(root), 'no repo path');
  assert.doesNotMatch(t, /\{\{(REPO|ROOT|WORKTREE|BASE|PRD|ISSUE_SCRIPT)\}\}/);
  assert.match(s, /^winner: A/m);
  assert.match(s, /^gap: /m);
  assert.match(s, /no scores/i);
});

test('bar prompt, rendered: ref dir, both output dirs, the dimensions, PROVISION FAILED; never A/B or .mapping', () => {
  const t = prompt('bar.md');
  const vars = { REPO: 'o/r', PRD: 9, TITLE: 'billing', ROUND: 1, ROUNDS: 3, PRODUCT: 'Acme Billing — https://acme.example',
    REF_DIR: '/s/.hx/bar/9/ref', DIMENSIONS: DIMS, OURS_DIR: '/s/.hx/bar/9/r1/B', REF_OUT_DIR: '/s/.hx/bar/9/r1/A', PROMISE: 'BAR DONE' };
  const s = render(t, vars);
  for (const x of [vars.REF_DIR, vars.OURS_DIR, vars.REF_OUT_DIR, DIMS, vars.PRODUCT, '<promise>BAR DONE</promise>']) assert.ok(s.includes(x), x);
  assert.match(s, /PROVISION FAILED: <exactly what failed>/);
  assert.doesNotMatch(s, /\{\{/);
  assert.doesNotMatch(t, /\.mapping|\bA\/|\bB\/|\{\{DIR_[AB]\}\}/);
});

test('both bar prompts carry the foreground-only rule verbatim', () => {
  const RULE = "Run every command in the foreground and wait for it. Never start a command in the background, and never poll for a background command's output in a loop.";
  for (const f of ['bar.md', 'bar-judge.md']) assert.ok(prompt(f).includes(RULE), f);
});
