// countCriteria (src/prd.ts): the items of a PRD's `## Acceptance criteria` list (PRD #422).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCriteria } from '../src/prd.ts';

const ac = (list: string, after = '') => `# T\n\n## Problem\n\n- not this\n\n## Acceptance criteria\n\n${list}\n${after}`;

test('countCriteria: boxes, ticked boxes, - and * bullets, 1. and 1) lists all count', () => {
  assert.equal(countCriteria(ac('- [ ] one\n- [ ] two\n- [ ] three')), 3);
  assert.equal(countCriteria(ac('- [x] one\n- [ ] two')), 2);
  assert.equal(countCriteria(ac('- one\n- two')), 2);
  assert.equal(countCriteria(ac('* one\n* two\n* three\n* four')), 4);
  assert.equal(countCriteria(ac('1. one\n2. two\n3. three')), 3);
  assert.equal(countCriteria(ac('1) one\n2) two')), 2);
  assert.equal(countCriteria(ac('- [ ] one\n- [x] two').replace(/\n/g, '\r\n')), 2);
});

test('countCriteria: nested bullets and wrapped continuation lines count with their parent', () => {
  assert.equal(countCriteria(ac('- [ ] one\n  - detail a\n  - detail b\n    1. deeper\n- [ ] two\n  that wraps\n  onto more lines\n- [ ] three')), 3);
  assert.equal(countCriteria(ac('1. one\n   - sub\n2. two')), 2);
});

test('countCriteria: a list indented as a whole still counts its items', () => {
  assert.equal(countCriteria(ac('  - one\n  - two\n    - sub\n  - three')), 3);
});

test('countCriteria: no section, or a heading with no list → 0', () => {
  assert.equal(countCriteria('# T\n\n## Problem\n\n- a\n- b\n'), 0);
  assert.equal(countCriteria(ac('Everything works.', '## Notes\n\n- a\n')), 0);
  assert.equal(countCriteria(ac('')), 0);
  assert.equal(countCriteria(''), 0);
});

test('countCriteria: items after the next ## heading (a Quality bar list, wherever it sits) are not counted', () => {
  assert.equal(countCriteria(ac('- [ ] one\n- [ ] two', '\n## Quality bar\n\nBeat: X — https://x.example\nJudged on:\n- speed\n- looks\n')), 2);
  const qbFirst = '# T\n\n## Quality bar\n\nJudged on:\n- a\n- b\n- c\n\n## Acceptance criteria\n\n- [ ] one\n\n## Edge cases\n\n- e\n';
  assert.equal(countCriteria(qbFirst), 1);
  assert.equal(countCriteria(ac('- [ ] one\n\n### Sub-heading\n\n- [ ] two')), 2);
});
