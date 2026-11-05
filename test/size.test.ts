// The size session's reply parser and the hx-size markers (PRD #300, #306).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZE_FITS, SIZE_NARROWED, SIZE_SPLIT, addBlockers, narrowedBody, narrowedComment, parseSizeReply, splitLines, withTrailers } from '../src/size.ts';
import { parseBlockedBy, parseParent } from '../src/state.ts';

const P = 'SIZE 7 DONE';
const tag = `<promise>${P}</promise>`;
const child = (k: number, title: string, blocked: string, body: string) => `=== CHILD ${k}: ${title}\nBlocked by: ${blocked}\n${body}`;
const split = (...blocks: string[]) => ['SIZE: split', ...blocks, tag].join('\n');
const narrow = (...blocks: string[]) => ['SIZE: narrow', ...blocks, tag].join('\n');
const scope = '=== SCOPE\nOnly the parser.\n\n- [ ] tests pass';

test('markers: one hx-size comment per result', () => {
  assert.equal(SIZE_FITS, '<!-- hx-size fits -->');
  assert.equal(SIZE_SPLIT, '<!-- hx-size split -->');
  assert.equal(SIZE_NARROWED, '<!-- hx-size narrowed -->');
});

test('fits: accepted up front, text before the SIZE line and the promise ignored, blocks after it ignored', () => {
  assert.deepEqual(parseSizeReply(`I read the issue.\n\nSIZE: fits\n${tag}`, 'up-front', P), { shape: 'fits' });
  assert.deepEqual(parseSizeReply(`  SIZE: fits  \n=== FOO\n=== CHILD 3:\n`, 'up-front', P), { shape: 'fits' });
  assert.deepEqual(parseSizeReply(`SIZE: fits ${tag}`, 'up-front', P), { shape: 'fits' });
});

test('split: two and three children, Blocked by resolved to child numbers', () => {
  const two = parseSizeReply(`Preamble.\n${split(child(1, 'Add a', 'none', 'Do a.\n\nAC: a works.'), child(2, 'Add b', 'child 1', 'Do b.'))}`, 'up-front', P);
  assert.deepEqual(two, { shape: 'split', children: [
    { title: 'Add a', body: 'Do a.\n\nAC: a works.', blockedBy: [] },
    { title: 'Add b', body: 'Do b.', blockedBy: [1] },
  ] });
  const three = parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b'), child(3, 'C', 'child 1, child 2', 'c')), 'up-front', P);
  assert.equal(three?.shape, 'split');
  assert.deepEqual(three?.shape === 'split' && three.children.map((c) => c.blockedBy), [[], [], [1, 2]]);
});

test('split: text between the SIZE line and the first block is ignored; CRLF works', () => {
  const r = parseSizeReply(split('Here is the split:', '', child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b')).replace(/\n/g, '\r\n'), 'up-front', P);
  assert.deepEqual(r, { shape: 'split', children: [{ title: 'A', body: 'a', blockedBy: [] }, { title: 'B', body: 'b', blockedBy: [] }] });
});

test('narrow: a SCOPE block alone and a SCOPE block then two children', () => {
  assert.deepEqual(parseSizeReply(narrow(scope), 'after-timeout', P), { shape: 'narrow', scope: 'Only the parser.\n\n- [ ] tests pass', children: [] });
  assert.deepEqual(parseSizeReply(narrow(scope, child(1, 'Rest a', 'none', 'a'), child(2, 'Rest b', 'child 1', 'b')), 'after-timeout', P), {
    shape: 'narrow', scope: 'Only the parser.\n\n- [ ] tests pass',
    children: [{ title: 'Rest a', body: 'a', blockedBy: [] }, { title: 'Rest b', body: 'b', blockedBy: [1] }],
  });
});

test('invalid: no SIZE line, or a shape in the wrong mode', () => {
  assert.equal(parseSizeReply(`It fits.\n${tag}`, 'up-front', P), null);
  assert.equal(parseSizeReply('SIZE: maybe', 'up-front', P), null);
  assert.equal(parseSizeReply('SIZE: fits', 'after-timeout', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b')), 'after-timeout', P), null);
  assert.equal(parseSizeReply(narrow(scope), 'up-front', P), null);
});

test('invalid split: 0 or 1 child', () => {
  assert.equal(parseSizeReply(split(), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a')), 'up-front', P), null);
});

test('invalid: children numbered 1, 3 and 1, 1', () => {
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(3, 'B', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(1, 'B', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(2, 'A', 'none', 'a'), child(3, 'B', 'none', 'b')), 'up-front', P), null);
});

test('invalid: Blocked by naming the child itself, a later child or child 0; a child without a Blocked by line', () => {
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'child 2', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'child 2', 'a'), child(2, 'B', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'child 0', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), '=== CHILD 2: B\nDo b.'), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), '=== CHILD 2: B\n\n'), 'up-front', P), null);
  assert.equal(parseSizeReply(narrow(scope, '=== CHILD 1: B\nDo b.'), 'after-timeout', P), null);
});

test('invalid: an empty title or an empty body', () => {
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, '', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, '   ', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'none', '  \n ')), 'up-front', P), null);
  assert.equal(parseSizeReply(narrow(scope, child(1, 'A', 'none', '')), 'after-timeout', P), null);
});

test('invalid: a body with a Blocked by or Parent heading', () => {
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a\n\n## Blocked by\nNone'), child(2, 'B', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b\n\n## Parent #4')), 'up-front', P), null);
  assert.equal(parseSizeReply(narrow(scope, child(1, 'A', 'none', 'a\n## Parent\n#4')), 'after-timeout', P), null);
});

test('invalid: an unknown === header in split and in narrow', () => {
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b'), '=== FOO\nx'), 'up-front', P), null);
  assert.equal(parseSizeReply(narrow(scope, '=== FOO\nx'), 'after-timeout', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), '=== CHILD two: B\nBlocked by: none\nb'), 'up-front', P), null);
});

test('invalid narrow: no SCOPE, two SCOPE blocks, SCOPE after a child, an empty SCOPE; a SCOPE block in split', () => {
  assert.equal(parseSizeReply(narrow(child(1, 'A', 'none', 'a')), 'after-timeout', P), null);
  assert.equal(parseSizeReply(narrow(), 'after-timeout', P), null);
  assert.equal(parseSizeReply(narrow(scope, scope), 'after-timeout', P), null);
  assert.equal(parseSizeReply(narrow(child(1, 'A', 'none', 'a'), scope), 'after-timeout', P), null);
  assert.equal(parseSizeReply(narrow('=== SCOPE\n  \n'), 'after-timeout', P), null);
  assert.equal(parseSizeReply(split(scope, child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b')), 'up-front', P), null);
  assert.equal(parseSizeReply(split(child(1, 'A', 'none', 'a'), child(2, 'B', 'none', 'b'), scope), 'up-front', P), null);
});

test('code fences: a === CHILD line and a SIZE line inside a fence stay body text', () => {
  const body = 'Make the parser accept:\n```\nSIZE: split\n=== CHILD 2: x\n```\nAC: tested.';
  const r = parseSizeReply(split(child(1, 'A', 'none', body), child(2, 'B', 'child 1', 'b')), 'up-front', P);
  assert.deepEqual(r, { shape: 'split', children: [{ title: 'A', body, blockedBy: [] }, { title: 'B', body: 'b', blockedBy: [1] }] });
  // a SIZE line inside a fence before the real one is not the shape line
  const fenced = parseSizeReply(`\`\`\`\nSIZE: fits\n\`\`\`\n${narrow(scope)}`, 'after-timeout', P);
  assert.equal(fenced?.shape, 'narrow');
  assert.equal(parseSizeReply('```\nSIZE: fits\n```', 'up-front', P), null);
});

test('splitLines: the split # lines of the last 24 h, oldest first; other and malformed lines skipped (#308)', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const lines = [
    `${at(1)} [#4] split #4 → #5, #6`,
    `${at(25)} [#1] split #1 → #2, #3`,
    `${at(2)} split #7 → #8, #9 (narrowed after a timeout)`,
    `${at(1)} [#4] size #4: fits`,
    'split #10 → #11, #12',
    'not-a-time split #13 → #14, #15',
    '',
  ];
  assert.deepEqual(splitLines(lines, now), [
    { at: at(2), msg: 'split #7 → #8, #9 (narrowed after a timeout)' },
    { at: at(1), msg: 'split #4 → #5, #6' },
  ]);
  assert.deepEqual(splitLines([], now), []);
});

const R = 'me/app';
const nums = (body: string) => parseBlockedBy(body, R).map((r) => r.number);

test('withTrailers: no blockers is None, two blockers one per line, then the parent (#309)', () => {
  const none = withTrailers('  Do a.\n\nAC: a works.\n\n', [], 7);
  assert.equal(none, 'Do a.\n\nAC: a works.\n\n## Blocked by\nNone\n\n## Parent\n#7');
  assert.deepEqual(nums(none), []);
  assert.equal(parseParent(none, R)?.number, 7);
  const two = withTrailers('Do b.', [7, 12], 7);
  assert.equal(two, 'Do b.\n\n## Blocked by\n#7\n#12\n\n## Parent\n#7');
  assert.deepEqual(nums(two), [7, 12]);
  assert.equal(parseParent(two, R)?.number, 7);
});

test('addBlockers: a None section becomes the refs (#309)', () => {
  const b = addBlockers('Work.\n\n## Blocked by\nNone\n', [20, 21]);
  assert.equal(b, 'Work.\n\n## Blocked by\n#20\n#21\n');
  assert.deepEqual(nums(b), [20, 21]);
});

test('addBlockers: refs go after the existing ones; a ref already there is not added twice (#309)', () => {
  // other/repo#20 is not #20 of this repo, so #20 is still added
  const b = addBlockers('Work.\n\n## Blocked by\n#5\nother/repo#20\n', [20, 21]);
  assert.equal(b, 'Work.\n\n## Blocked by\n#5\nother/repo#20\n#20\n#21\n');
  assert.deepEqual(nums(b), [5, 20, 20, 21]);
  assert.deepEqual(parseBlockedBy(b, R).map((r) => `${r.repo}#${r.number}`), ['me/app#5', 'other/repo#20', 'me/app#20', 'me/app#21']);
  const again = addBlockers('## Blocked by\n#5\n#20', [20, 21]);
  assert.equal(again, '## Blocked by\n#5\n#20\n#21');
  assert.deepEqual(nums(again), [5, 20, 21]);
  assert.equal(addBlockers('## Blocked by\n#5\n#20', [20, 5]), '## Blocked by\n#5\n#20');
});

test('addBlockers: a following ## Parent and the text before the section are unchanged (#309)', () => {
  const b = addBlockers('Intro #9.\n\n## Blocked by\n#5\n\n## Parent\n#3\n\nTail.', [20, 21]);
  assert.equal(b, 'Intro #9.\n\n## Blocked by\n#5\n#20\n#21\n\n## Parent\n#3\n\nTail.');
  assert.deepEqual(nums(b), [5, 20, 21]);
  assert.equal(parseParent(b, R)?.number, 3);
  const none = addBlockers('## Blocked by\nNone\n\n## Parent\n#3', [20]);
  assert.equal(none, '## Blocked by\n#20\n\n## Parent\n#3');
  assert.deepEqual(nums(none), [20]);
  assert.equal(parseParent(none, R)?.number, 3);
});

test('narrowedBody: the heading and its line first, the SCOPE text, the old Blocked by refs and the old Parent (#312)', () => {
  const old = 'A big job.\n\n## Blocked by\n#5\nother/repo#6\n\n## Parent\n#3\n';
  const b = narrowedBody(old, '\nOnly the parser.\n\n- [ ] tests pass\n', [20, 21], 75, R);
  assert.equal(b, '## Scope (narrowed after a timeout)\nNarrowed by hx after a 75-min timeout; the rest is #20, #21.\n\n'
    + 'Only the parser.\n\n- [ ] tests pass\n\n## Blocked by\n#5\nother/repo#6\n\n## Parent\n#3');
  assert.deepEqual(parseBlockedBy(b, R).map((r) => `${r.repo}#${r.number}`), ['me/app#5', 'other/repo#6']);
  assert.equal(parseParent(b, R)?.number, 3);
  // another parent form is kept as a ## Parent heading
  assert.equal(parseParent(narrowedBody('Part of #9.\n\nWork.', 'Scope.', [], 75, R), R)?.number, 9);
});

test('narrowedBody: nothing filed, no blockers, no parent: `the rest is none.`, `None`, no ## Parent (#312)', () => {
  const b = narrowedBody('A big job.\n', 'Scope.', [], 0.5, R);
  assert.equal(b, '## Scope (narrowed after a timeout)\nNarrowed by hx after a 0.5-min timeout; the rest is none.\n\nScope.\n\n## Blocked by\nNone');
  assert.equal(parseParent(b, R), null);
  assert.deepEqual(parseBlockedBy(b, R), []);
  assert.equal(narrowedBody('Work.\n\n## Blocked by\nNone\n', 'Scope.', [4], 75, R).endsWith('## Blocked by\nNone'), true);
});

test('narrowedComment: the narrowed marker first, the rest issues, the previous body in <details> (#312)', () => {
  const c = narrowedComment([20, 21], 'Old body.\n');
  assert.equal(c.split('\n')[0], SIZE_NARROWED);
  assert.match(c, /^- #20\n- #21$/m);
  assert.match(c, /<details><summary>[^<]+<\/summary>\n\nOld body\.\n\n<\/details>$/);
  assert.match(narrowedComment([], 'x'), /nothing else was filed/);
});
