// src/controlroom.ts issueStates, part 2 (#373, PRD #367 "Right: Details"): the step trail with its notes, the facts rows
// and the "what happens next" sentence. Times are built from local Date values, so the HH:MM expectations hold in any zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimNotes, fmtClock, issueStates, parseLines, refList, type Item, type Timeline } from '../src/controlroom.ts';
import { localDay } from '../src/usage.ts';

const ms = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();
const iso = (h: number, m = 0) => new Date(ms(h, m)).toISOString();
const NOW = ms(15);
const TODAY = localDay(iso(15));
const line = (h: number, m: number, n: number, msg: string) => `${iso(h, m)} [#${n}] ${msg}`;
const noTimeline: Timeline = { from: ms(9), to: NOW, lanes: [{ worker: 'gate', bars: [] }] };
const row = (number: number, status: string, extra: object = {}) => ({ number, title: `T${number}`, status, waitingOn: [], ...extra });
const prdRow = (number: number, status: string, extra: object = {}) =>
  ({ number, title: `P${number}`, status, open: 2, closed: 1, waitingOn: [], ...extra });
const me = (number: number) => ({ repo: 'me/app', number });
type PlanIn = { prds?: object[]; board?: object[]; parents?: Record<number, number> };
const plan = (p: PlanIn) => ({ prds: p.prds ?? [], board: p.board ?? [], parents: p.parents ?? {} }) as any;

function states(o: { plan?: PlanIn; sessions?: object[]; lines?: string[]; timeline?: Timeline; auditRounds?: number }) {
  return issueStates({ plan: o.plan && plan(o.plan), sessions: (o.sessions ?? []) as any, lines: o.lines ?? [],
    timeline: o.timeline ?? noTimeline, auditRounds: o.auditRounds ?? 3, today: TODAY, repo: 'me/app' });
}
const item = (r: { items: Item[] }, n: number) => {
  const i = r.items.find((x) => x.number === n);
  assert.ok(i, `item #${n}`);
  return i;
};
const session = (number: number, kind = 'impl', since = iso(13)) => ({ number, kind, title: `T${number}`, since, turn: 1, tokens: 0 });
const states_ = (i: Item) => i.steps.map((s) => s.state).join(' ');
const names = (i: Item) => i.steps.map((s) => s.name);
const notes = (i: Item) => i.steps.map((s) => s.note);
const w1 = (issue: number): Timeline => ({ from: ms(9), to: NOW, lanes: [
  { worker: 'W1', bars: [{ issue, role: 'impl', startMs: ms(13), endMs: NOW, running: true }] }, { worker: 'gate', bars: [] }] });

test('fmtClock is the local HH:MM; refList: #a / #a and #b / #a, #b and #c', () => {
  assert.equal(fmtClock(iso(9, 5)), '09:05');
  assert.equal(fmtClock(ms(13, 41)), '13:41');
  assert.deepEqual([refList(['#1']), refList(['#1', '#2']), refList(['#1', '#2', '#3'])], ['#1', '#1 and #2', '#1, #2 and #3']);
});

test('claimNotes: the latest turn of a role, the turn after it, the audit line and its verdict with the audit turn before it', () => {
  const claim = parseLines([
    line(12, 0, 1, 'impl: T1'), line(12, 30, 1, 'impl turn 1: ok · 1.0M tokens (1.0K out) · 1800s'),
    line(12, 40, 1, 'impl turn 2: error · 288.4K tokens (1.0K out) · 120s · boom'),
  ]);
  assert.deepEqual(claimNotes(claim, 'impl'), { turnNote: 'turn 2 error · 288K tokens · 2 min', running: 3, auditNote: null, verdictNote: null });
  const audited = parseLines([line(13, 0, 1, 'audit 1/3: PR #9'), line(13, 30, 1, 'audit turn 1: ok · 1.9M tokens (1.0K out) · 1740s'), line(13, 31, 1, 'audit FAIL ✗ — x')]);
  assert.deepEqual(claimNotes([...claim, ...audited], 'impl'),
    { turnNote: 'turn 2 error · 288K tokens · 2 min', running: 1, auditNote: 'audit 1 of 3 on PR #9', verdictNote: 'FAIL ✗ · 1.9M tokens · 29 min' });
  assert.deepEqual(claimNotes(parseLines([line(13, 0, 1, 'audit 2/3: PR #9'), line(13, 1, 1, 'audit PASS ✓')]), 'impl').verdictNote, 'PASS ✓');
  assert.equal(claimNotes(claim, 'triage').turnNote, null);
});

test('the issue trail for each status: waiting, implementing, auditing, merging, done', () => {
  const r = states({
    plan: { board: [row(1, 'claimable'), row(2, 'working'), row(3, 'working'), row(4, 'working')] },
    sessions: [session(2), session(3), session(4)],
    lines: [
      line(13, 0, 2, 'impl: T2'),
      line(13, 0, 3, 'impl: T3'), line(13, 30, 3, 'audit 1/3: PR #30'),
      line(13, 0, 4, 'impl: T4'), line(13, 30, 4, 'audit 1/3: PR #40'), line(14, 0, 4, 'audit PASS ✓'),
      line(10, 0, 5, 'impl: T5'), line(11, 0, 5, 'DONE ✓ audited and merged (1 round(s), 2.0M tokens)'),
    ],
  });
  assert.deepEqual(names(item(r, 1)), ['Claimed', 'Implement', 'Audit', 'Merge', 'Gate']);
  assert.equal(states_(item(r, 1)), 'next next next next next');
  assert.deepEqual(notes(item(r, 1)), ['', '', '', '', '']);
  assert.equal(states_(item(r, 2)), 'done now next next next');
  assert.equal(states_(item(r, 3)), 'done done now next next');
  assert.equal(states_(item(r, 4)), 'done done done now next');
  assert.equal(states_(item(r, 5)), 'done done done done done');
});

test('issue notes: Claimed, Implement (ok / error / running), Audit (verdict / in audit), Merge, Gate', () => {
  const r = states({
    plan: { board: [row(10, 'working'), row(11, 'working'), row(12, 'working'), row(13, 'working')] },
    sessions: [session(10), session(11), session(12), session(13)],
    timeline: w1(10),
    lines: [
      // #10 merging: an impl turn, an audit turn, then PASS
      line(12, 36, 10, 'impl: T10'),
      line(13, 20, 10, 'impl turn 1: ok · 2.5M tokens (10.0K out) · 2640s'),
      line(13, 21, 10, 'audit 1/3: PR #100'),
      line(13, 50, 10, 'audit turn 1: ok · 1.9M tokens (5.0K out) · 1740s'),
      line(13, 51, 10, 'audit PASS ✓'),
      // #11 implementing after a FAIL; its latest impl turn ended in an error
      line(12, 0, 11, 'impl: T11'),
      line(12, 30, 11, 'impl turn 1: ok · 1.0M tokens (1.0K out) · 1800s'),
      line(12, 31, 11, 'audit 1/3: PR #110'),
      line(12, 50, 11, 'audit turn 1: ok · 300.0K tokens (1.0K out) · 1100s'),
      line(12, 51, 11, 'audit FAIL ✗ — no test'),
      line(12, 52, 11, 'audit found gaps — back to the implementer, round 2/3'),
      line(13, 30, 11, 'impl turn 1: error · 400.0K tokens (1.0K out) · 300s · boom'),
      // #12 auditing, no verdict yet
      line(13, 0, 12, 'impl: T12'), line(13, 40, 12, 'impl turn 1: ok · 950 tokens (10 out) · 5340s'), line(13, 41, 12, 'audit 2/3: PR #120'),
      // #13 implementing, no turn finished yet
      line(14, 45, 13, 'impl: T13'),
    ],
  });
  assert.deepEqual(notes(item(r, 10)), ['W1 · 12:36', 'turn 1 ok · 2.5M tokens · 44 min', 'PASS ✓ · 1.9M tokens · 29 min',
    'rebasing on main, then merging', 'runs the full suite on main after the merge']);
  assert.deepEqual(notes(item(r, 11)), ['— · 12:00', 'turn 1 error · 400K tokens · 5 min', '', '', '']);
  assert.deepEqual(notes(item(r, 12)), ['— · 13:00', 'turn 1 ok · 950 tokens · 1h29m', 'audit 2 of 3 on PR #120', '', '']);
  assert.deepEqual(notes(item(r, 13)), ['— · 14:45', 'turn running', '', '', '']);
});

test('issue notes fall back to done / in progress / empty; merged ✓ only for a merge, not a close without a PR', () => {
  const r = states({
    plan: { board: [row(21, 'triage')] },
    sessions: [session(21, 'triage')],
    lines: [
      line(10, 0, 20, 'DONE ✓ closed without a PR (300.0K tokens)'), // no claim line read
      line(9, 0, 22, 'impl: T22'), line(10, 0, 22, 'impl DONE ✓ (1.0M tokens)'),
      line(13, 0, 21, 'triage (round 1): T21'), line(13, 30, 21, 'triage turn 1: ok · 200.0K tokens (1.0K out) · 600s'),
    ],
  });
  assert.deepEqual(notes(item(r, 20)), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(notes(item(r, 22)), ['— · 09:00', 'done', 'done', 'merged ✓', 'done']);
  assert.deepEqual(notes(item(r, 21)), ['— · 13:00', 'turn 1 ok · 200K tokens · 10 min', '', '', '']); // a triage session's own turns
});

test('the PRD trail for each PRD status, a running session and bar', () => {
  const r = states({
    plan: { prds: [prdRow(30, 'gauntlet'), prdRow(31, 'decompose'), prdRow(32, 'building'), prdRow(33, 'review'), prdRow(34, 'security'),
      prdRow(35, 'bar'), prdRow(36, 'waiting', { waitingOn: [me(30)] }), prdRow(37, 'blocked-label'), prdRow(38, 'untrusted'),
      prdRow(39, 'working'), prdRow(40, 'working')] },
    sessions: [session(39, 'security', iso(14)), session(40, 'bar', iso(14))],
    lines: [line(8, 0, 41, 'review (round 1): P41'), line(12, 37, 41, 'PRD closed ✓')],
  });
  assert.deepEqual(names(item(r, 30)), ['Gauntlet', 'Decompose', 'Build', 'Review', 'Security']);
  assert.equal(states_(item(r, 30)), 'now next next next next');
  assert.equal(states_(item(r, 31)), 'done now next next next');
  assert.equal(states_(item(r, 32)), 'done done now next next');
  assert.equal(states_(item(r, 33)), 'done done done now next');
  assert.equal(states_(item(r, 34)), 'done done done done now');
  assert.equal(states_(item(r, 35)), 'done done done done done');
  for (const n of [36, 37, 38]) assert.equal(states_(item(r, n)), 'next next next next next', `#${n}`);
  assert.equal(states_(item(r, 39)), 'done done done done now'); // its running security session
  assert.equal(states_(item(r, 40)), 'done done done done done'); // a running bar session
  assert.equal(states_(item(r, 41)), 'done done done done done'); // closed today
});

test('PRD notes: the latest gauntlet round line, Build closed/total, else done / in progress / empty', () => {
  const r = states({
    plan: { prds: [prdRow(50, 'gauntlet'), prdRow(51, 'building', { open: 2, closed: 3 }), prdRow(52, 'review')] },
    sessions: [session(50, 'gauntlet', iso(14))],
    lines: [
      line(10, 0, 50, 'gauntlet (round 1): P50'), line(11, 0, 50, 'gauntlet round 1/3: FAIL ✗ — vague'),
      line(11, 30, 50, 'gauntlet round 1/3 done (1.0M tokens)'), line(14, 0, 50, 'gauntlet (round 2): P50'),
      line(9, 0, 51, 'gauntlet round 2/3: PASS ✓ — labelled prd-hardened (2.0M tokens)'),
    ],
  });
  assert.deepEqual(notes(item(r, 50)), ['round 1 of 3 · FAIL ✗', '', '', '', '']);
  assert.deepEqual(notes(item(r, 51)), ['round 2 of 3 · PASS ✓', 'done', '3/5 issues done', '', '']);
  assert.deepEqual(notes(item(r, 52)), ['done', 'done', '1/3 issues done', 'in progress', '']);
});

test('facts: a running issue, a done issue, a waiting issue, a PRD done and not done', () => {
  const r = states({
    plan: { board: [row(60, 'working'), row(62, 'waiting', { waitingOn: [me(60), { repo: 'o/lib', number: 7 }] }), row(63, 'claimable')],
      prds: [prdRow(64, 'building')] },
    sessions: [session(60, 'impl', iso(13, 31))], timeline: w1(60), auditRounds: 4,
    lines: [
      line(13, 31, 60, 'impl: T60'), line(13, 50, 60, 'impl turn 1: ok · 1.5M tokens (10.0K out) · 1200s'), line(14, 0, 60, 'audit 2/4: PR #61'),
      line(9, 0, 61, 'impl: T61'), line(10, 0, 61, 'DONE ✓ closed without a PR (300.0K tokens)'),
      line(8, 0, 65, 'review (round 1): P65'), line(12, 37, 65, 'PRD closed ✓'),
    ],
  });
  assert.deepEqual(item(r, 60).facts, [['WORKER', 'W1'], ['TOKENS', '1.5M'], ['TIME', '1h29m'], ['ROUND', '2 of 4'], ['PR', '#61']]);
  assert.deepEqual(item(r, 61).facts, [['WORKER', '—'], ['TOKENS', '—'], ['TIME', '1h00m'], ['ROUND', '1 of 4'], ['PR', 'not yet']]);
  assert.deepEqual(item(r, 62).facts, [['WAITS ON', '#60, o/lib#7'], ['WORKER', 'none yet']]);
  assert.deepEqual(item(r, 63).facts, [['WAITS ON', '—'], ['WORKER', 'none yet']]);
  assert.deepEqual(item(r, 64).facts, [['STATUS', 'building'], ['STEPS', '2 of 5 done']]);
  assert.deepEqual(item(r, 65).facts, [['STATUS', 'closed 12:37'], ['STEPS', 'all passed']]);
});

test('what next for an issue: every rule of the table, the <deps> suffixes and the blocker wordings', () => {
  const r = states({
    plan: {
      prds: [prdRow(90, 'decompose')],
      board: [
        row(70, 'working'), row(71, 'working'), row(72, 'working'), row(73, 'working'),
        row(80, 'waiting', { waitingOn: [me(70)] }),
        row(81, 'waiting', { waitingOn: [me(70)] }),
        row(82, 'waiting', { waitingOn: [me(72)] }),
        row(83, 'waiting', { waitingOn: [me(70), me(72)] }),
        row(84, 'waiting', { waitingOn: [me(70), me(72), { repo: 'o/lib', number: 7 }] }),
        row(85, 'waiting', { waitingOn: [me(70), me(90)] }),
        row(86, 'claimable', { held: true }), row(87, 'question'), row(88, 'blocked-label'), row(89, 'triage'),
        row(91, 'untrusted'), row(92, 'working'), row(93, 'claimable'),
      ],
    },
    sessions: [session(70), session(71), session(72), session(73)],
    lines: [
      line(13, 0, 70, 'impl: T70'), line(13, 30, 70, 'audit 1/3: PR #700'), line(14, 0, 70, 'audit PASS ✓'),
      line(13, 0, 71, 'impl: T71'), line(13, 30, 71, 'audit 2/3: PR #710'),
      line(13, 0, 72, 'impl: T72'), line(13, 30, 72, 'impl turn 1: ok · 1.0M tokens (1.0K out) · 1800s'),
      line(13, 0, 73, 'impl: T73'),
      line(9, 0, 74, 'impl: T74'), line(10, 0, 74, 'DONE ✓ audited and merged (1 round(s), 1.0M tokens)'),
      line(9, 0, 75, 'impl: T75'), line(10, 0, 75, 'DONE ✓ closed without a PR (300.0K tokens)'),
      line(9, 0, 76, 'impl: T76'), line(10, 0, 76, 'impl DONE ✓ (1.0M tokens)'),
    ],
  });
  const next = (n: number) => item(r, n).next;
  assert.equal(next(74), 'Merged.');
  assert.equal(next(76), 'Merged.');
  assert.equal(next(75), 'Closed without a PR.');
  assert.equal(next(70), 'Rebase on main and merge. When it lands, #80, #81 can start.');
  assert.equal(next(71), 'An independent audit checks PR #710 (round 2 of 3).');
  assert.equal(next(72), 'The implementer is working on it (turn 2). #82 waits for it.');
  assert.equal(next(73), 'The implementer is working on it (turn 1).');
  assert.equal(next(80), 'Starts when #70 merges.');
  assert.equal(next(83), 'Starts when #70 and #72 merge.');
  assert.equal(next(84), 'Starts when #70, #72 and o/lib#7 merge.');
  assert.equal(next(85), 'Starts when PRD #90 is ready.');
  assert.equal(next(86), 'Its audited PR merges once main is green.');
  assert.equal(next(87), 'Waits for your answer on GitHub.');
  assert.equal(next(88), 'Stopped after a failure. A person has to look at it.');
  assert.equal(next(89), 'A triage session reproduces the bug first.');
  assert.equal(next(91), 'Not built: opened by an account hx does not trust.');
  assert.equal(next(92), 'Labelled as working, but no session is running.');
  assert.equal(next(93), 'Starts when a worker is free.');
});

test('what next: a merging or implementing issue with no <deps> has no suffix; an audit FAIL restarts the turn count', () => {
  const r = states({
    plan: { board: [row(100, 'working'), row(101, 'working'), row(102, 'waiting', { waitingOn: [me(101), me(100)] })] },
    sessions: [session(100), session(101)],
    lines: [
      line(13, 0, 100, 'impl: T100'), line(13, 30, 100, 'audit 1/3: PR #1000'), line(14, 0, 100, 'audit PASS ✓'),
      line(12, 0, 101, 'impl: T101'), line(12, 20, 101, 'impl turn 1: ok · 1.0M tokens (1.0K out) · 600s'),
      line(12, 30, 101, 'impl turn 2: ok · 1.0M tokens (1.0K out) · 600s'), line(12, 40, 101, 'audit 1/3: PR #1010'),
      line(13, 0, 101, 'audit FAIL ✗ — gaps'),
    ],
  });
  assert.equal(item(r, 100).next, 'Rebase on main and merge.'); // #102 has two blockers: not a dep
  assert.equal(item(r, 101).next, 'The implementer is working on it (turn 1).');
});

test('what next for a PRD: done, a session running, building, each step waiting for a worker, waiting, blocked-label, untrusted', () => {
  const r = states({
    plan: { prds: [prdRow(110, 'review'), prdRow(111, 'building', { open: 2, closed: 3 }),
      prdRow(112, 'gauntlet'), prdRow(113, 'decompose'), prdRow(114, 'review'), prdRow(115, 'security'), prdRow(116, 'bar'),
      prdRow(117, 'waiting', { waitingOn: [me(112)] }), prdRow(118, 'waiting', { waitingOn: [me(93), me(94)] }),
      prdRow(119, 'blocked-label'), prdRow(120, 'untrusted'), prdRow(122, 'working'), prdRow(123, 'waiting', { waitingOn: [me(95)] })] },
    sessions: [session(110, 'review', iso(14)), session(122, 'bar', iso(14))],
    lines: [line(8, 0, 121, 'security (round 1): P121'), line(12, 37, 121, 'PRD closed ✓')],
  });
  const next = (n: number) => item(r, n).next;
  assert.equal(next(121), 'Closed.');
  assert.equal(next(110), 'A review session is running.');
  assert.equal(next(122), 'A quality bar session is running.');
  assert.equal(next(111), 'Its issues are being built: 3/5 done.');
  assert.equal(next(112), 'The gauntlet step starts when a worker is free.');
  assert.equal(next(113), 'The decompose step starts when a worker is free.');
  assert.equal(next(114), 'The review step starts when a worker is free.');
  assert.equal(next(115), 'The security step starts when a worker is free.');
  assert.equal(next(116), 'The quality bar step starts when a worker is free.');
  assert.equal(next(117), 'Starts when PRD #112 is ready.');
  assert.equal(next(123), 'Starts when #95 is done.');
  assert.equal(next(118), 'Starts when #93 and #94 are done.');
  assert.equal(next(119), 'Stopped after a failure. A person has to look at it.');
  assert.equal(next(120), 'Not built: opened by an account hx does not trust.');
});
