// The size session's reply parser and the hx-size markers (PRD #300, #306).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZE_FITS, SIZE_NARROWED, SIZE_SPLIT, parseSizeReply } from '../src/size.ts';

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
