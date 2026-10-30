import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board, externalRefs, issueKey, parseBlockedBy, parseParent, plan, prdKey, PROMISE_RE, refKey, render } from '../src/state.ts';
import { DEFAULTS, workerArgs } from '../src/config.ts';

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

test('parseParent: heading, inline, colon and legacy forms', () => {
  assert.deepEqual(parseParent('x\n\n## Parent\n#7\n', R), { repo: R, number: 7 });
  assert.deepEqual(parseParent('## Parent #8', R), { repo: R, number: 8 });
  assert.deepEqual(parseParent('Parent: other/x#9', R), { repo: 'other/x', number: 9 });
  assert.deepEqual(parseParent('Part of #10', R), { repo: R, number: 10 });
  assert.equal(parseParent('## Blocked by\n#3', R), null);
});

test('plan: PRD lifecycle and sequencing', () => {
  const L = DEFAULTS.labels;
  const i = (number: number, labels: string[], body = '', state: 'OPEN' | 'CLOSED' = 'OPEN') => ({ number, title: `t${number}`, body, state, labels });
  const kid = (n: number, prdN: number, state: 'OPEN' | 'CLOSED' = 'OPEN', labels = [L.ready]) => i(n, labels, `## Parent\n#${prdN}`, state);
  const all = [
    i(1, [L.prd, L.hardened]),                            // no children, hardened → decompose
    i(2, [L.prd]), kid(10, 2), kid(11, 2, 'CLOSED'),        // building; #10 claimable
    i(3, [L.prd]), kid(12, 3, 'CLOSED'),                    // all closed, not reviewed → review
    i(4, [L.prd, L.reviewed]), kid(13, 4, 'CLOSED'),        // reviewed → engine closes
    i(5, [L.prd], '## Blocked by\n#2'), kid(14, 5),          // PRD waits on #2 → child #14 waits too
    i(6, [L.prd]), kid(15, 6, 'OPEN', []),                  // unlabelled child → engine labels it
    i(7, [L.prd, L.ready]), kid(16, 7),                     // a PRD is never implemented itself; its
  ];                                                        // child waits while decompose (busy) runs
  const states = new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state]));
  const pl = plan(all, R, L, states, new Set([prdKey(7)]));
  assert.deepEqual(pl.prds.map((p) => [p.number, p.status]), [
    [1, 'decompose'], [2, 'building'], [3, 'review'], [4, 'done'], [5, 'waiting'], [6, 'building'], [7, 'working']]);
  assert.deepEqual(pl.actions.map((a) => `${a.kind}:${'issue' in a ? a.issue : a.prd}`),
    ['decompose:1', 'review:3', 'close-prd:4', 'label-ready:15', 'impl:10']);
  assert.deepEqual(pl.board.find((r) => r.number === 14)?.waitingOn, [{ repo: R, number: 5 }]);
  assert.ok(!pl.board.some((r) => r.number === 7));
  assert.equal(pl.board.find((r) => r.number === 16)?.status, 'waiting');
  // #12 is closed but its session is still running → PRD #3 is not reviewed yet
  const pl2 = plan(all, R, L, states, new Set([issueKey(12)]));
  assert.equal(pl2.prds.find((p) => p.number === 3)?.status, 'building');
  assert.ok(!pl2.actions.some((a) => a.kind === 'review'));
});

test('workerArgs: lean flags by default, then claudeArgs; off when leanWorkers is false', () => {
  const c = { ...DEFAULTS, repo: R, defaultBranch: 'main', worktreeRoot: 'x', claudeArgs: ['--foo'] };
  assert.deepEqual(workerArgs(c), ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local',
    '--tools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--foo']);
  assert.deepEqual(workerArgs({ ...c, leanWorkers: false }), ['--foo']);
  assert.ok(!workerArgs({ ...c, workerTools: [] }).includes('--tools'), 'no tool list = the CLI default tools');
});

test('promise matching and render', () => {
  assert.ok(PROMISE_RE('ISSUE 4 DONE').test('ok <promise> ISSUE 4 DONE </promise>'));
  assert.ok(!PROMISE_RE('ISSUE 4 DONE').test('<promise>ISSUE 44 DONE</promise>'));
  assert.equal(render('#{{ISSUE}} {{NOPE}}', { ISSUE: 3 }), '#3 {{NOPE}}');
});

test('plan: the gauntlet runs before decompose, only on a PRD without children', () => {
  const L = DEFAULTS.labels;
  const i = (number: number, labels: string[], body = '', state: 'OPEN' | 'CLOSED' = 'OPEN') => ({ number, title: `t${number}`, body, state, labels });
  const kid = (n: number, prdN: number, state: 'OPEN' | 'CLOSED' = 'OPEN') => i(n, [L.ready], `## Parent\n#${prdN}`, state);
  const all = [
    i(1, [L.prd]),                                    // no children, not hardened → gauntlet
    i(2, [L.prd, L.hardened]),                        // hardened → decompose
    i(3, [L.prd]), kid(10, 3),                        // children, no prd-hardened → building, never gauntlet
    i(4, [L.prd]), kid(11, 4, 'CLOSED'),              // all closed, no prd-hardened → review, never gauntlet
    i(5, [L.prd]),                                    // a gauntlet round is running → working
    i(6, [L.prd], '## Blocked by\n#3'),               // waits on PRD #3 → no gauntlet yet
    i(7, [L.prd, L.blocked]),                         // needs a human → no gauntlet
    i(12, [L.ready]),
  ];
  const states = new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state]));
  const pl = plan(all, R, L, states, new Set([prdKey(5)]));
  assert.deepEqual(pl.prds.map((p) => [p.number, p.status]), [
    [1, 'gauntlet'], [2, 'decompose'], [3, 'building'], [4, 'review'], [5, 'working'], [6, 'waiting'], [7, 'blocked-label']]);
  // a PRD session action: before the implementation work
  assert.deepEqual(pl.actions.map((a) => `${a.kind}:${'issue' in a ? a.issue : a.prd}`),
    ['gauntlet:1', 'decompose:2', 'review:4', 'impl:10', 'impl:12']);
  assert.deepEqual(pl.actions[0], { kind: 'gauntlet', prd: 1, title: 't1' });
  assert.ok(!pl.actions.some((a) => 'prd' in a && a.prd === 5), 'busy PRD: no decompose, no gauntlet');

  // the gauntlet off: straight to decompose
  const off = plan(all, R, L, states, new Set([prdKey(5)]), { gauntlet: false });
  assert.deepEqual(off.prds.map((p) => [p.number, p.status]).slice(0, 2), [[1, 'decompose'], [2, 'decompose']]);
  assert.ok(!off.actions.some((a) => a.kind === 'gauntlet'));
  // on is the default
  assert.deepEqual(plan(all, R, L, states, new Set(), { gauntlet: true }).actions[0], { kind: 'gauntlet', prd: 1, title: 't1' });
  assert.equal(plan(all, R, L, states).prds.find((p) => p.number === 5)?.status, 'gauntlet');
});
