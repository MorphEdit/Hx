// The one-child path's pure parts (PRD #422, #425): the decision, the child's body, the log line, the config key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA_FINDING, criteriaCheck, singleChild, singleChildBody, singleChildLine } from '../src/prd.ts';
import { parseBlockedBy, parseParent, plan } from '../src/state.ts';
import { DEFAULTS, singleChildError } from '../src/config.ts';

const items = (n: number) => Array.from({ length: n }, (_, k) => `- [ ] criterion ${k + 1}`).join('\n');
const prdBody = (n: number) => `## Problem\n\nslow\n\n## Acceptance criteria\n\n${items(n)}\n\n## Edge cases\n\n- none\n`;

test('singleChild: K criteria → one child (count), K+1 → decompose', () => {
  assert.equal(singleChild(prdBody(15), 15, 2, false), 'count');
  assert.equal(singleChild(prdBody(16), 15, 2, false), null);
  assert.equal(singleChild(prdBody(1), 15, 3, true), 'count');
  assert.equal(singleChild(prdBody(4), 3, 2, true), null);
});

test('singleChild: a pool of one (workers 1, auto off) takes one child whatever the count', () => {
  assert.equal(singleChild(prdBody(16), 15, 1, false), 'pool');
  assert.equal(singleChild(prdBody(3), 15, 1, false), 'pool', 'the pool-of-one rule comes before the count');
});

test('singleChild: 0 turns the path off, also under the pool-of-one trigger', () => {
  assert.equal(singleChild(prdBody(3), 0, 2, false), null);
  assert.equal(singleChild(prdBody(3), 0, 1, false), null);
  assert.equal(singleChild(prdBody(30), 0, 1, false), null);
});

test('singleChild: no Acceptance criteria section, or an empty one, decomposes even in a pool of one', () => {
  assert.equal(singleChild('## Problem\n\n- slow\n', 15, 1, false), null);
  assert.equal(singleChild('## Acceptance criteria\n\n## Notes\n\n- a\n', 15, 1, false), null);
  assert.equal(singleChild('', 15, 1, false), null);
});

test('singleChild: workers 1 with auto on → the count decides', () => {
  assert.equal(singleChild(prdBody(16), 15, 1, true), null);
  assert.equal(singleChild(prdBody(15), 15, 1, true), 'count');
});

test('singleChildBody: the criteria section word for word, a pointer to the PRD, then Blocked by None and Parent', () => {
  const section = '## Acceptance criteria\n\n- [ ] one `x`\n  - detail\n* two\n1) three';
  const body = `# T\n\n## Problem\n\n- slow\n\n${section}\n\n## Edge cases\n\n- none\n`;
  const child = singleChildBody(body, 42);
  assert.ok(child.startsWith(`${section}\n\n`), child);
  assert.ok(!child.includes('Edge cases') && !child.includes('## Problem'), child);
  assert.match(child, /PRD #42/);
  assert.ok(child.trimEnd().endsWith('## Blocked by\nNone\n\n## Parent\n#42'), child);
  assert.deepEqual(parseParent(child, 'me/app'), { repo: 'me/app', number: 42 });
  assert.deepEqual(parseBlockedBy(child, 'me/app'), []);
  // the section last in the body, and CRLF line ends, are copied as they are
  const crlf = `## Problem\r\n\r\n- slow\r\n\r\n## Acceptance criteria\r\n\r\n- [ ] one\r\n- [ ] two\r\n`;
  assert.ok(singleChildBody(crlf, 7).startsWith('## Acceptance criteria\r\n\r\n- [ ] one\r\n- [ ] two\n\n'));
  assert.deepEqual(parseParent(singleChildBody(crlf, 7), 'me/app'), { repo: 'me/app', number: 7 });
});

test('singleChildLine: the count reason names K, the pool-of-one reason says so', () => {
  assert.equal(singleChildLine(5, 9, 'count', 15), 'prd #5: one child #9 (≤ 15 acceptance criteria) — no decompose');
  assert.equal(singleChildLine(5, 9, 'pool', 15), 'prd #5: one child #9 (a pool of one) — no decompose');
});

test('config: singleChildMaxCriteria defaults to 15; a negative, fractional or string value is an error', () => {
  assert.equal(DEFAULTS.singleChildMaxCriteria, 15);
  for (const v of [0, 1, 15, 100, undefined]) assert.equal(singleChildError(v), null, String(v));
  for (const v of [-1, 1.5, '15', null, NaN, true]) assert.match(singleChildError(v) ?? '', /^singleChildMaxCriteria: .* whole number, 0 or more/, String(v));
});

test('plan: the decompose action carries the PRD body; a PRD with a child gets no decompose action', () => {
  const L = DEFAULTS.labels;
  const prd = { number: 1, title: 'f', body: prdBody(2), state: 'OPEN' as const, labels: [L.prd, L.hardened], author: 'me' };
  const pl = plan([prd], 'me/app', L, new Map());
  assert.deepEqual(pl.actions.map((a) => [a.kind, a.kind === 'decompose' ? a.body : '']), [['decompose', prdBody(2)]]);
  const kid = { number: 2, title: 'Implement PRD #1: f', body: singleChildBody(prd.body, 1), state: 'OPEN' as const, labels: [L.ready], author: 'me' };
  const p2 = plan([prd, kid], 'me/app', L, new Map());
  assert.ok(!p2.actions.some((a) => a.kind === 'decompose'), JSON.stringify(p2.actions));
  assert.equal(p2.prds[0].status, 'building');
});

test('criteriaCheck: no or empty criteria fail the round; the engine finding alone on PASS, last on FAIL (PRD #436)', () => {
  assert.equal(CRITERIA_FINDING, '- The PRD has no "## Acceptance criteria" section with items — the one-child path and the review need testable criteria — hx engine check');
  assert.equal(CRITERIA_FINDING.length, 137, 'not cut by the 140-character log line');
  const pass = { pass: true, findings: '- none' };
  const fail = { pass: false, findings: '- a\n- b' };
  assert.deepEqual(criteriaCheck('## Problem\nslow\n', pass), { pass: false, findings: CRITERIA_FINDING, engine: true });
  assert.deepEqual(criteriaCheck('## Acceptance criteria\n\n## Quality bar\n- x\n', { pass: true, findings: '(none given)' }), { pass: false, findings: CRITERIA_FINDING, engine: true });
  assert.deepEqual(criteriaCheck('no section', fail), { pass: false, findings: `- a\n- b\n${CRITERIA_FINDING}`, engine: true });
  assert.deepEqual(criteriaCheck(prdBody(1), pass), { ...pass, engine: false });
  assert.deepEqual(criteriaCheck(prdBody(3), fail), { ...fail, engine: false });
});
