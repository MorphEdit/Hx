import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board, externalRefs, issueKey, parseBlockedBy, parseParent, plan, prdKey, PROMISE_RE, refKey, render, trustedSet } from '../src/state.ts';
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
    i(4, [L.prd, L.reviewed, L.secured]), kid(13, 4, 'CLOSED'), // reviewed, secured → engine closes
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

test('plan: the security pass runs after review sign-off and before the PRD closes', () => {
  const L = DEFAULTS.labels;
  const i = (number: number, labels: string[], body = '', state: 'OPEN' | 'CLOSED' = 'OPEN') => ({ number, title: `t${number}`, body, state, labels });
  const kid = (n: number, state: 'OPEN' | 'CLOSED', labels = [L.ready]) => i(n, labels, '## Parent\n#1', state);
  const at = (prd: string[], kids: ReturnType<typeof kid>[], opts?: { gauntlet?: boolean; security?: boolean }) => {
    const all = [i(1, prd), ...kids];
    const states = new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state]));
    const pl = plan(all, R, L, states, new Set(), opts);
    return { status: pl.prds[0].status, actions: pl.actions.map((a) => `${a.kind}:${'issue' in a ? a.issue : a.prd}`), pl };
  };
  // the full lifecycle, one step at a time
  const steps = [
    at([L.prd], []),
    at([L.prd, L.hardened], []),
    at([L.prd, L.hardened], [kid(10, 'OPEN')]),
    at([L.prd, L.hardened], [kid(10, 'CLOSED')]),
    at([L.prd, L.hardened, L.reviewed], [kid(10, 'CLOSED')]),
    at([L.prd, L.hardened, L.reviewed, L.secured], [kid(10, 'CLOSED')]),
  ];
  assert.deepEqual(steps.map((s) => s.status), ['gauntlet', 'decompose', 'building', 'review', 'security', 'done']);
  assert.deepEqual(steps.map((s) => s.actions[0]), ['gauntlet:1', 'decompose:1', 'impl:10', 'review:1', 'security:1', 'close-prd:1']);
  const kidsClosed = [kid(10, 'CLOSED')];
  assert.deepEqual(steps[4].pl.actions[0], { kind: 'security', prd: 1, title: 't1', children: kidsClosed });
  assert.deepEqual(steps[5].pl.actions[0], { kind: 'close-prd', prd: 1, secured: true });

  // not before prd-reviewed: security-reviewed alone does not skip the review
  assert.equal(at([L.prd, L.secured], kidsClosed).status, 'review');
  // an open security issue filed by the pass (prd-reviewed removed by hx) → building, then review again
  const sec = kid(11, 'OPEN', [L.ready, L.security]);
  assert.equal(at([L.prd, L.hardened], [kid(10, 'CLOSED'), sec]).status, 'building');
  // an open child holds even a reviewed PRD in building: no security, no close
  const held = at([L.prd, L.reviewed], [kid(10, 'CLOSED'), sec]);
  assert.equal(held.status, 'building');
  assert.deepEqual(held.actions, ['impl:11']);
  // close-prd only after security-reviewed
  assert.ok(!at([L.prd, L.reviewed], kidsClosed).actions.includes('close-prd:1'));
  // a running security session: working, nothing else for that PRD
  const all = [i(1, [L.prd, L.reviewed]), ...kidsClosed];
  const busy = plan(all, R, L, new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state])), new Set([prdKey(1)]));
  assert.equal(busy.prds[0].status, 'working');
  assert.deepEqual(busy.actions, []);
  // security off: reviewed goes straight to done (closed without the security message)
  const off = at([L.prd, L.reviewed], kidsClosed, { security: false });
  assert.equal(off.status, 'done');
  assert.deepEqual(off.pl.actions, [{ kind: 'close-prd', prd: 1, secured: false }]);
  // both off: today's flow — decompose directly, review, close
  const both = { gauntlet: false, security: false };
  assert.deepEqual([at([L.prd], [], both), at([L.prd], kidsClosed, both), at([L.prd, L.reviewed], kidsClosed, both)].map((s) => s.status),
    ['decompose', 'review', 'done']);
  // a PRD session action: ordered with the other PRD sessions, before engine steps and implementation
  const mixed = [i(1, [L.prd, L.reviewed]), kid(10, 'CLOSED'), i(2, [L.prd]), i(3, [L.prd, L.hardened]), i(4, [L.ready])];
  const pm = plan(mixed, R, L, new Map(mixed.map((x) => [refKey({ repo: R, number: x.number }), x.state])));
  assert.deepEqual(pm.actions.map((a) => `${a.kind}:${'issue' in a ? a.issue : a.prd}`), ['security:1', 'gauntlet:2', 'decompose:3', 'impl:4']);
});

test('plan: only issues and PRDs opened by a trusted account are worked on', () => {
  const L = DEFAULTS.labels;
  const i = (number: number, labels: string[], author: string, body = '', state: 'OPEN' | 'CLOSED' = 'OPEN') =>
    ({ number, title: `t${number}`, body, state, labels, author });
  const kid = (n: number, prdN: number, author = 'me', state: 'OPEN' | 'CLOSED' = 'OPEN', labels = [L.ready]) =>
    i(n, labels, author, `## Parent\n#${prdN}`, state);
  const trusted = trustedSet('Me', ['Alice']);
  assert.deepEqual([...trusted], ['me', 'alice']);
  const run = (all: ReturnType<typeof i>[], busy = new Set<string>()) =>
    plan(all, R, L, new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state])), busy, { trusted });
  const acts = (pl: ReturnType<typeof plan>) => pl.actions.map((a) => `${a.kind}:${'issue' in a ? a.issue : a.prd}`);

  // ready issues: the login and trustedAuthors (any case) are claimable; anyone else and a deleted account are not
  const ready = run([i(1, [L.ready], 'ME'), i(2, [L.ready], 'mallory'), i(3, [L.ready], 'alice'), i(4, [L.ready], '')]);
  assert.deepEqual(acts(ready), ['impl:1', 'impl:3']);
  assert.deepEqual(ready.board.map((r) => [r.number, r.status]), [[1, 'claimable'], [3, 'claimable'], [2, 'untrusted'], [4, 'untrusted']]);
  assert.equal(ready.board.find((r) => r.number === 2)?.author, 'mallory');
  assert.equal(ready.board.find((r) => r.number === 4)?.author, '');
  const noAuthor = { number: 5, title: 't5', body: '', state: 'OPEN' as const, labels: [L.ready] } as any;
  assert.equal(run([noAuthor]).board[0].status, 'untrusted', 'a missing author is untrusted');
  // an untrusted issue even beats working / blocked: it is never a claim
  assert.equal(run([i(6, [L.ready, L.working], 'mallory')]).board[0].status, 'untrusted');

  // an untrusted PRD: no gauntlet, decompose, review, security, close or label-ready; its children are not claimed
  for (const prd of [[L.prd], [L.prd, L.hardened], [L.prd, L.reviewed], [L.prd, L.reviewed, L.secured]]) {
    for (const kids of [[], [kid(10, 1, 'me', 'CLOSED')], [kid(10, 1), kid(11, 1, 'me', 'OPEN', [])]]) {
      const pl = run([i(1, prd, 'eve'), ...kids]);
      assert.deepEqual(acts(pl), [], `${prd} ${kids.length}`);
      assert.equal(pl.prds[0].status, 'untrusted');
      assert.equal(pl.prds[0].author, 'eve');
    }
  }
  const up = run([i(1, [L.prd], 'eve'), kid(10, 1)]);
  assert.deepEqual(up.board[0], { number: 10, title: 't10', status: 'untrusted', waitingOn: [], untrustedPrd: { number: 1, author: 'eve' } });
  // the same board with a trusted PRD works as before
  assert.deepEqual(acts(run([i(1, [L.prd], 'Alice'), kid(10, 1)])), ['impl:10']);

  // an untrusted issue naming a trusted PRD as its parent is not its child
  const sneaky = (state: 'OPEN' | 'CLOSED', labels = [L.ready]) => kid(20, 1, 'mallory', state, labels);
  const rev = run([i(1, [L.prd], 'me'), kid(10, 1, 'me', 'CLOSED'), sneaky('OPEN')]);
  assert.equal(rev.prds[0].status, 'review', 'it does not hold the PRD in building');
  const review = rev.actions.find((a) => a.kind === 'review') as any;
  assert.deepEqual(review.children.map((k: any) => k.number), [10], 'absent from the review children');
  assert.equal(rev.board.find((r) => r.number === 20)?.status, 'untrusted');
  assert.equal(run([i(1, [L.prd], 'me'), kid(10, 1, 'me', 'CLOSED'), sneaky('OPEN', [])]).prds[0].status, 'review');
  assert.ok(!acts(run([i(1, [L.prd], 'me'), kid(10, 1), sneaky('OPEN', [])])).includes('label-ready:20'), 'never labelled ready');
  // a PRD whose only "child" is untrusted: still undecomposed, and the decompose prompt never sees it
  const dec = run([i(1, [L.prd, L.hardened], 'me'), sneaky('OPEN')]);
  assert.equal(dec.prds[0].status, 'decompose');
  assert.deepEqual((dec.actions[0] as any).children, []);
  const sec = run([i(1, [L.prd, L.reviewed], 'me'), kid(10, 1, 'me', 'CLOSED'), sneaky('CLOSED')]);
  assert.deepEqual((sec.actions[0] as any).children.map((k: any) => k.number), [10], 'absent from the security children');

  // no trusted set (pure unit use): no filter
  assert.equal(plan([i(2, [L.ready], 'mallory')], R, L, new Map()).board[0].status, 'claimable');
});
