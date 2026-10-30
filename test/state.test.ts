import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board, externalRefs, parseBlockedBy, PROMISE_RE, refKey, render } from '../src/state.ts';
import { DEFAULTS } from '../src/config.ts';

const R = 'me/app';

test('parseBlockedBy: same-repo and cross-repo refs, section ends at next heading', () => {
  const body = '## What\nstuff #99\n\n## Blocked by\n- #3\n- other/lib#7 and #3 again\n\n## Parent\n#1\n';
  assert.deepEqual(parseBlockedBy(body, R), [{ repo: R, number: 3 }, { repo: 'other/lib', number: 7 }]);
});

test('parseBlockedBy: None, missing section, glued refs', () => {
  assert.deepEqual(parseBlockedBy('## Blocked by\nNone — #4 already merged', R), []);
  assert.deepEqual(parseBlockedBy('no section, #4', R), []);
  assert.deepEqual(parseBlockedBy('### Blocked by:\nfixes#88 but #5', R), [{ repo: R, number: 5 }]);
});

test('board: classifies and orders claimable first, oldest first', () => {
  const L = DEFAULTS.labels;
  const issue = (number: number, labels: string[], body = '') => ({ number, title: `t${number}`, body, state: 'OPEN' as const, labels });
  const issues = [
    issue(9, [L.ready]),
    issue(5, [L.ready], '## Blocked by\n#2'),       // #2 closed → claimable
    issue(6, [L.ready], '## Blocked by\n#3'),       // #3 open → waiting
    issue(7, [L.ready, L.working]),
    issue(8, [L.ready, L.blocked]),
    issue(4, []),                                   // not ready → ignored
    issue(10, [L.ready], '## Blocked by\nx/y#1'),   // unresolvable external → waiting
    issue(11, [L.ready]),
  ];
  const states = new Map([[refKey({ repo: R, number: 2 }), 'CLOSED' as const], [refKey({ repo: R, number: 3 }), 'OPEN' as const]]);
  const rows = board(issues, R, L, states, new Set([11]));
  assert.deepEqual(rows.map((r) => [r.number, r.status]), [
    [5, 'claimable'], [9, 'claimable'], [7, 'working'], [11, 'working'], [6, 'waiting'], [10, 'waiting'], [8, 'blocked-label']]);
  assert.deepEqual(externalRefs(issues, R), [{ repo: 'x/y', number: 1 }]);
});

test('promise matching and render', () => {
  assert.ok(PROMISE_RE('ISSUE 4 DONE').test('ok <promise> ISSUE 4 DONE </promise>'));
  assert.ok(!PROMISE_RE('ISSUE 4 DONE').test('<promise>ISSUE 44 DONE</promise>'));
  assert.equal(render('#{{ISSUE}} {{NOPE}}', { ISSUE: 3 }), '#3 {{NOPE}}');
});
