// The bug lane in the pure board logic: triage status and actions, bug priority, the claim filter, verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimable, plan, refKey, TRIAGE_MARKER, triageVerdict, type Action } from '../src/state.ts';
import { DEFAULTS } from '../src/config.ts';

const R = 'me/app';
const L = DEFAULTS.labels;
const i = (number: number, labels: string[], body = '', state: 'OPEN' | 'CLOSED' = 'OPEN', author = 'me') =>
  ({ number, title: `t${number}`, body, state, labels, author });
const statesOf = (all: ReturnType<typeof i>[]) => new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state]));
const run = (all: ReturnType<typeof i>[], opts: { bugTriage?: boolean } = {}) =>
  plan(all, R, L, statesOf(all), new Set(), { trusted: new Set(['me']), ...opts });
const keys = (as: Action[]) => as.map((a) => `${a.kind}:${'issue' in a ? a.issue : a.prd}`);
const status = (pl: ReturnType<typeof plan>, n: number) => pl.board.find((r) => r.number === n)?.status;

test('config: bug labels and bugTriage/triageRounds defaults', () => {
  assert.equal(L.bug, 'bug');
  assert.equal(L.triaged, 'bug-triaged');
  assert.equal(DEFAULTS.bugTriage, true);
  assert.equal(DEFAULTS.triageRounds, 2);
});

test('a trusted bug with no lane labels, or with ready-for-agent but untriaged, is triaged and never claimable', () => {
  const pl = run([i(5, [L.bug]), i(6, [L.bug, L.ready])]);
  assert.equal(status(pl, 5), 'triage');
  assert.equal(status(pl, 6), 'triage');
  assert.deepEqual(keys(pl.actions), ['triage:5', 'triage:6']);
  assert.deepEqual(pl.actions[0], { kind: 'triage', issue: 5, title: 't5' });
});

test('a triaged bug is built before lower-numbered features, PRD sessions and engine steps; triage before bug impl', () => {
  const all = [
    i(1, [L.ready]),                                  // feature impl
    i(2, [L.prd]),                                    // gauntlet
    i(3, [L.prd, L.hardened]),                        // decompose
    i(4, [L.prd]), i(20, [], '## Parent\n#4', 'CLOSED'),                          // review
    i(7, [L.prd, L.reviewed]), i(21, [], '## Parent\n#7', 'CLOSED'),              // security
    i(8, [L.prd, L.reviewed, L.secured]), i(22, [], '## Parent\n#8', 'CLOSED'),  // engine close
    i(31, [L.bug, L.triaged, L.ready]), i(30, [L.bug, L.triaged, L.ready]),
    i(41, [L.bug]), i(40, [L.bug, L.ready]),
  ];
  const pl = run(all);
  assert.deepEqual(keys(pl.actions),
    ['triage:40', 'triage:41', 'impl:30', 'impl:31', 'gauntlet:2', 'decompose:3', 'review:4', 'security:7', 'close-prd:8', 'impl:1']);
  assert.equal(status(pl, 30), 'claimable');
  assert.deepEqual(pl.board.slice(0, 2).map((r) => r.status), ['triage', 'triage']);
});

test('untrusted, agent-blocked, agent-working and blocked bugs get no action', () => {
  const all = [
    i(5, [L.bug], '', 'OPEN', 'stranger'),
    i(6, [L.bug, L.blocked]),
    i(7, [L.bug, L.working]),
    i(8, [L.bug], '## Blocked by\n#9'), i(9, []),
    i(10, [L.bug], '## Blocked by\n#11'), i(11, [], '', 'CLOSED'),
  ];
  const pl = run(all);
  assert.equal(status(pl, 5), 'untrusted');
  assert.equal(pl.board.find((r) => r.number === 5)?.author, 'stranger');
  assert.equal(status(pl, 6), 'blocked-label');
  assert.equal(status(pl, 7), 'working');
  assert.equal(status(pl, 8), 'waiting');
  assert.deepEqual(pl.board.find((r) => r.number === 8)?.waitingOn, [{ repo: R, number: 9 }]);
  assert.deepEqual(keys(pl.actions), ['triage:10']);
  // in flight counts as working too
  const busy = plan(all, R, L, statesOf(all), new Set(['issue:10']), { trusted: new Set(['me']) });
  assert.equal(status(busy, 10), 'working');
  assert.deepEqual(keys(busy.actions), []);
});

test('a PRD child with bug is built as a normal child: no triage, no bug priority', () => {
  const all = [
    i(1, [L.ready]),
    i(2, [L.prd]), i(3, [L.bug, L.ready], '## Parent\n#2'), i(4, [L.bug], '## Parent\n#2'),
    i(5, [L.prd], '', 'CLOSED'), i(6, [L.bug, L.ready], '## Parent\n#5'),
  ];
  const pl = run(all);
  assert.equal(status(pl, 3), 'claimable');
  assert.equal(status(pl, 4), undefined, 'not ready: off the board as before');
  assert.equal(status(pl, 6), 'claimable');
  assert.deepEqual(keys(pl.actions), ['label-ready:4', 'impl:1', 'impl:3', 'impl:6']);
});

test('bugTriage false: a bug with ready-for-agent is claimable at once and still built first', () => {
  const all = [i(1, [L.ready]), i(2, [L.prd]), i(5, [L.bug, L.ready]), i(6, [L.bug])];
  const pl = run(all, { bugTriage: false });
  assert.equal(status(pl, 5), 'claimable');
  assert.equal(status(pl, 6), undefined);
  assert.deepEqual(keys(pl.actions), ['impl:5', 'gauntlet:2', 'impl:1']);
});

test('claimable: triage is started first; a red gate starts only its fix (no triage); --issue narrows', () => {
  const pl = run([i(1, [L.ready]), i(2, [L.prd]), i(5, [L.bug]), i(9, [L.ready])]);
  assert.deepEqual(keys(pl.actions), ['triage:5', 'gauntlet:2', 'impl:1', 'impl:9']);
  assert.deepEqual(keys(claimable(pl.actions)), ['triage:5', 'gauntlet:2', 'impl:1', 'impl:9']);
  assert.deepEqual(keys(claimable(pl.actions, { gateRed: true, fixIssue: 9 })), ['impl:9']);
  assert.deepEqual(keys(claimable(pl.actions, { gateRed: true, fixIssue: 5 })), [], 'a red gate starts no triage');
  assert.deepEqual(keys(claimable(pl.actions, { gateRed: true })), []);
  assert.deepEqual(keys(claimable(pl.actions, { only: [5, 2] })), ['triage:5', 'gauntlet:2']);
});

test('triageVerdict: marker on line 1, verdict on the next non-empty line', () => {
  const M = TRIAGE_MARKER;
  assert.equal(M, '<!-- hx:triage -->');
  assert.equal(triageVerdict(`${M}\nVERDICT: REPRODUCED\n\nsteps…`), 'REPRODUCED');
  assert.equal(triageVerdict(`  ${M}  \r\n\r\n   \r\n  VERDICT: NEEDS-INFO  \r\nwhat is missing`), 'NEEDS-INFO');
  assert.equal(triageVerdict(`${M}\n\nVERDICT: FAILED (the session ended without a verdict)`), 'FAILED');
  assert.equal(triageVerdict(`${M}\nVERDICT: FAILED`), 'FAILED');
  assert.equal(triageVerdict(`intro\n${M}\nVERDICT: REPRODUCED`), null, 'marker not on line 1');
  assert.equal(triageVerdict(`${M}`), null, 'no verdict line');
  assert.equal(triageVerdict(`${M}\n\n`), null);
  assert.equal(triageVerdict(`${M}\nVERDICT: maybe`), null);
  assert.equal(triageVerdict(`${M}\nVERDICT: REPRODUCED extra`), null);
  assert.equal(triageVerdict(`${M}\nI looked into it.\nVERDICT: REPRODUCED`), null, 'VERDICT only further down');
  assert.equal(triageVerdict('VERDICT: REPRODUCED'), null);
  assert.equal(triageVerdict(''), null);
});
