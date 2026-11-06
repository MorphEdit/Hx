// src/controlroom.ts issueStates, part 1 (#372, PRD #367): the items, their status words, stage, waitsOn, worker, tokens,
// time, round and PR, and the board groups. Times are built from local Date values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtSpan, fmtTokens, issueStates, type Item, type Timeline } from '../src/controlroom.ts';
import { localDay } from '../src/usage.ts';

const ms = (h: number, m = 0, day = 7) => new Date(2026, 10, day, h, m).getTime();
const iso = (h: number, m = 0, day = 7) => new Date(ms(h, m, day)).toISOString();
const NOW = ms(15);
const TODAY = localDay(iso(15));
const line = (h: number, m: number, n: number, msg: string, day = 7) => `${iso(h, m, day)} [#${n}] ${msg}`;
const noTimeline: Timeline = { from: ms(9), to: NOW, lanes: [{ worker: 'gate', bars: [] }] };
const row = (number: number, status: string, extra: object = {}) => ({ number, title: `T${number}`, status, waitingOn: [], ...extra });
const prdRow = (number: number, status: string, extra: object = {}) =>
  ({ number, title: `P${number}`, status, open: 1, closed: 1, waitingOn: [], ...extra });
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
const sw = (i: Item) => [i.status, i.word];
const impl = (n: number, since = iso(13)) => ({ number: n, kind: 'impl', title: `T${n}`, since, turn: 1, tokens: 0 });

test('fmtTokens and fmtSpan: 2.5M / 288K / the number; 44 min / 1h29m', () => {
  assert.equal(fmtTokens(2_500_000), '2.5M');
  assert.equal(fmtTokens(288_400), '288K');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtSpan(44 * 60_000 + 10_000), '44 min');
  assert.equal(fmtSpan(89 * 60_000), '1h29m');
  assert.equal(fmtSpan(65 * 60_000), '1h05m');
});

test('a live impl session: implementing, auditing or merging from its stage lines', () => {
  const r = states({
    plan: { board: [row(1, 'working'), row(2, 'working'), row(3, 'working'), row(4, 'working')] },
    sessions: [impl(1), impl(2), impl(3), impl(4)],
    lines: [
      line(13, 0, 1, 'impl: T1'),
      line(13, 0, 2, 'impl: T2'), line(13, 30, 2, 'audit 1/3: PR #20'),
      line(13, 0, 3, 'impl: T3'), line(13, 30, 3, 'audit 1/3: PR #30'), line(14, 0, 3, 'audit PASS ✓'),
      line(13, 0, 4, 'impl: T4'), line(13, 30, 4, 'audit 1/3: PR #40'), line(14, 0, 4, 'audit FAIL ✗ — missing test'),
    ],
  });
  assert.deepEqual(sw(item(r, 1)), ['implementing', 'implementing']);
  assert.equal(item(r, 1).stage, 'impl');
  assert.deepEqual(sw(item(r, 2)), ['auditing', 'auditing']);
  assert.equal(item(r, 2).stage, 'audit');
  assert.deepEqual(sw(item(r, 3)), ['merging', 'merging']);
  assert.equal(item(r, 3).stage, 'merge');
  assert.deepEqual(sw(item(r, 4)), ['implementing', 'implementing']);
  assert.equal(item(r, 4).since, iso(13));
});

test('a live triage session: implementing; a triage: FAILED line after its claim does not restart the claim', () => {
  const r = states({
    plan: { board: [row(5, 'triage')] },
    sessions: [{ number: 5, kind: 'triage', title: 'T5', since: iso(13), turn: 2, tokens: 0 }],
    lines: [
      line(13, 0, 5, 'triage (round 1): T5'),
      line(13, 20, 5, 'triage turn 1: ok · 300.0K tokens (2.0K out) · 900s'),
      line(13, 30, 5, 'triage: FAILED (the repro did not run)'),
      line(13, 40, 5, 'triage turn 2: ok · 200.0K tokens (1.0K out) · 300s'),
    ],
  });
  const i = item(r, 5);
  assert.deepEqual(sw(i), ['implementing', 'implementing']);
  assert.equal(i.stage, null);
  assert.equal(i.tokens, '500K'); // both turns: the FAILED line is a result line, not a claim
  assert.equal(i.time, '2h00m');  // from the 13:00 claim to now
});

test('done from each of the three closing lines today; a closing line on another day is not today', () => {
  const r = states({
    lines: [
      line(10, 0, 6, 'impl: T6'), line(11, 0, 6, 'DONE ✓ audited and merged (1 round(s), 2.0M tokens)'),
      line(10, 0, 7, 'impl: T7'), line(10, 30, 7, 'DONE ✓ closed without a PR (300.0K tokens)'),
      line(10, 0, 8, 'impl: T8'), line(12, 0, 8, 'impl DONE ✓ (1.0M tokens)'),
      line(10, 0, 9, 'impl: T9', 6), line(11, 0, 9, 'impl DONE ✓ (1.0M tokens)', 6),
    ],
  });
  for (const n of [6, 7, 8]) assert.deepEqual(sw(item(r, n)), ['done', 'done']);
  assert.equal(r.items.find((i) => i.number === 9), undefined);
  assert.equal(item(r, 6).time, '1h00m'); // claim → its DONE ✓ line
  assert.equal(item(r, 8).closedAt, iso(12));
});

test('every board status is waiting, the board status and held kept on the item', () => {
  const statuses = ['claimable', 'waiting', 'working', 'blocked-label', 'question', 'triage', 'untrusted'];
  const board = [...statuses.map((s, k) => row(10 + k, s)), row(20, 'claimable', { held: true })];
  const r = states({ plan: { board } });
  statuses.forEach((s, k) => {
    const i = item(r, 10 + k);
    assert.deepEqual(sw(i), ['waiting', 'waiting'], s);
    assert.equal(i.board, s);
    assert.equal(i.held, false);
    assert.equal(i.stage, null);
    assert.equal(i.since, null);
  });
  assert.equal(item(r, 20).held, true);
  assert.equal(item(r, 20).board, 'claimable');
});

test('a PRD: done from PRD closed ✓ today, the word of its running session, building, else waiting', () => {
  const kinds = { 31: 'gauntlet', 32: 'decompose', 33: 'review', 34: 'security', 35: 'bar' };
  const r = states({
    plan: { prds: [...Object.keys(kinds).map((n) => prdRow(Number(n), 'gauntlet')), prdRow(36, 'building'), prdRow(37, 'review'), prdRow(38, 'blocked-label')] },
    sessions: Object.entries(kinds).map(([n, kind]) => ({ number: Number(n), kind, title: `P${n}`, since: iso(14), turn: 1, tokens: 0 })),
    lines: [line(9, 0, 39, 'review (round 1): P39'), line(11, 0, 39, 'PRD closed ✓')],
  });
  assert.deepEqual(sw(item(r, 31)), ['implementing', 'gauntlet']);
  assert.deepEqual(sw(item(r, 32)), ['implementing', 'decompose']);
  assert.deepEqual(sw(item(r, 33)), ['implementing', 'review']);
  assert.deepEqual(sw(item(r, 34)), ['implementing', 'security']);
  assert.deepEqual(sw(item(r, 35)), ['implementing', 'quality bar']);
  assert.deepEqual(sw(item(r, 36)), ['implementing', 'building']);
  assert.deepEqual(sw(item(r, 37)), ['waiting', 'waiting']); // a review step with no session running
  assert.deepEqual(sw(item(r, 38)), ['waiting', 'waiting']);
  assert.deepEqual(sw(item(r, 39)), ['done', 'done']);
  assert.equal(item(r, 39).title, 'P39'); // a closed PRD's title from its latest claim line
  for (const n of [31, 36, 39]) assert.equal(item(r, n).prd, n); // a PRD item's prd is itself
});

test('waitsOn: open blockers in this repo as #N, another repo as owner/repo#N, none as []', () => {
  const r = states({ plan: {
    board: [row(40, 'waiting', { waitingOn: [{ repo: 'me/app', number: 41 }, { repo: 'Other/lib', number: 7 }] }), row(42, 'claimable')],
    prds: [prdRow(43, 'waiting', { waitingOn: [{ repo: 'ME/App', number: 39 }] })],
  } });
  assert.deepEqual(item(r, 40).waitsOn, ['#41', 'Other/lib#7']);
  assert.deepEqual(item(r, 42).waitsOn, []);
  assert.deepEqual(item(r, 43).waitsOn, ['#39']);
});

test('tokens, time, round and PR from the current claim; worker from the timeline', () => {
  const timeline: Timeline = { from: ms(9), to: NOW, lanes: [
    { worker: 'W1', bars: [{ issue: 50, role: 'impl', startMs: ms(9, 30), endMs: ms(10) }] },
    { worker: 'W2', bars: [{ issue: 50, role: 'audit', startMs: ms(14), endMs: NOW, running: true }] },
    { worker: 'gate', bars: [] },
  ] };
  const r = states({
    plan: { board: [row(50, 'working'), row(51, 'claimable')] },
    sessions: [impl(50, iso(13, 31))],
    timeline, auditRounds: 4,
    lines: [
      line(9, 0, 50, 'impl: old claim'), line(9, 30, 50, 'impl turn 1: ok · 9.0M tokens (1.0K out) · 600s'),
      line(13, 31, 50, 'impl: T50'),
      line(13, 50, 50, 'impl turn 1: ok · 1.5M tokens (10.0K out) · 1200s'),
      line(14, 0, 50, 'audit 1/4: PR #60'),
      line(14, 20, 50, 'audit turn 1: ok · 600.0K tokens (5.0K out) · 1200s'),
      line(14, 21, 50, 'audit FAIL ✗ — no test'),
      line(14, 30, 50, 'impl turn 2: error · 400.0K tokens (1.0K out) · 300s · boom'),
      line(14, 40, 50, 'audit 2/4: PR #61'),
    ],
  });
  const i = item(r, 50);
  assert.equal(i.tokens, '2.5M'); // the current claim's three turn lines, not the old claim's
  assert.equal(i.time, '1h29m');
  assert.equal(i.round, '2 of 4');
  assert.equal(i.pr, '#61');
  assert.equal(i.worker, 'W2');
  const w = item(r, 51);
  assert.equal(w.round, '1 of 4');
  assert.equal(w.pr, 'not yet');
  assert.equal(w.worker, '—');
  assert.equal(w.tokens, '');
  assert.equal(w.time, '');
});

test('a live session before its first turn ends: turn running; no audit line: round 1, PR not yet', () => {
  const r = states({ plan: { board: [row(52, 'working')] }, sessions: [impl(52, iso(14, 45))], lines: [line(14, 45, 52, 'impl: T52')] });
  const i = item(r, 52);
  assert.equal(i.tokens, 'turn running');
  assert.equal(i.time, '15 min');
  assert.equal(i.round, '1 of 3');
  assert.equal(i.pr, 'not yet');
  assert.deepEqual(i.steps.map((s) => s.note), ['— · 14:45', 'turn running', '', '', '']); // the details (#373)
  assert.equal(i.next, 'The implementer is working on it (turn 1).');
});

test('a held merge line gives the round and the PR', () => {
  const r = states({ plan: { board: [row(53, 'working')] }, sessions: [impl(53)], lines: [
    line(13, 0, 53, 'impl: T53'), line(14, 0, 53, 'main is green: merging held PR #70 (audit 2/3 PASS kept)'),
  ] });
  assert.deepEqual([item(r, 53).status, item(r, 53).round, item(r, 53).pr], ['merging', '2 of 3', '#70']);
});

test('a live self-review session gives no item', () => {
  const r = issueStates({ plan: undefined, sessions: [{ number: 0, kind: 'selfreview', title: 'self-review of abc', since: iso(14) }],
    lines: [], timeline: noTimeline, auditRounds: 3, today: TODAY });
  assert.deepEqual(r, { groups: [], items: [] });
});

test('the groups: PRD groups by number, a split group, Other issues, Closed today; each item in exactly one group', () => {
  const r = states({
    plan: {
      prds: [prdRow(90, 'building', { open: 2, closed: 1 }), prdRow(80, 'gauntlet', { open: 0, closed: 0 })],
      board: [row(91, 'claimable'), row(92, 'waiting'), row(101, 'claimable'), row(102, 'claimable'), row(110, 'claimable')],
      parents: { 91: 90, 92: 90, 93: 90, 120: 70 },
    },
    lines: [
      line(9, 0, 100, 'impl: Big thing'), line(9, 30, 100, 'split #100 → #101, #102, #103'),
      line(9, 40, 103, 'impl: T103'), line(10, 0, 103, 'DONE ✓ audited and merged (1 round(s), 1.0M tokens)'),
      line(9, 0, 93, 'impl: T93'), line(11, 0, 93, 'impl DONE ✓ (1.0M tokens)'),
      line(9, 0, 120, 'impl: T120'), line(12, 0, 120, 'DONE ✓ closed without a PR (1.0M tokens)'), // its PRD #70 is closed
      line(9, 0, 121, 'impl: T121'), line(13, 0, 121, 'impl DONE ✓ (1.0M tokens)'),
      line(8, 0, 70, 'security (round 1): P70'), line(12, 30, 70, 'PRD closed ✓'),
      line(8, 0, 71, 'review (round 1): P71'), line(10, 30, 71, 'PRD closed ✓'),
    ],
  });
  assert.deepEqual(r.groups, [
    { key: 'prd:80', title: 'PRD #80 · P80', progress: '0/0' },
    { key: 'prd:90', title: 'PRD #90 · P90', progress: '1/3' },
    { key: 'split:100', title: '#100 · Big thing (split)', progress: '1/3' },
    { key: 'other', title: 'Other issues', progress: '1' },
    { key: 'closed', title: 'Closed today', progress: '4' },
  ]);
  const byGroup = (k: string) => r.items.filter((i) => i.group === k).map((i) => i.number);
  assert.deepEqual(byGroup('prd:80'), [80]);
  assert.deepEqual(byGroup('prd:90'), [93, 90, 91, 92]); // done first, then by status, then number
  assert.deepEqual(byGroup('split:100'), [103, 101, 102]);
  assert.deepEqual(byGroup('other'), [110]);
  assert.deepEqual(byGroup('closed'), [70, 71, 121, 120]); // PRDs first, newest close first within each
  const numbers = r.items.map((i) => i.number);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(r.items.every((i) => r.groups.some((g) => g.key === i.group)));
  assert.equal(r.items.find((i) => i.number === 100), undefined); // a split parent closed "not planned" is no item
  assert.equal(item(r, 121).title, 'T121');
});

test('a narrowed split whose children belong to an open PRD: they stay in the PRD group, the split makes no group', () => {
  const r = states({
    plan: { prds: [prdRow(200, 'building')], board: [row(201, 'working'), row(202, 'claimable'), row(203, 'claimable')], parents: { 201: 200, 202: 200, 203: 200 } },
    lines: [line(10, 0, 201, 'impl: T201'), line(11, 0, 201, 'split #201 → #202, #203 (narrowed after a timeout)')],
  });
  assert.deepEqual(r.groups.map((g) => g.key), ['prd:200']);
  assert.deepEqual(r.items.filter((i) => i.group === 'prd:200').map((i) => i.number), [200, 201, 202, 203]);
});

test('the latest split line listing an issue wins; split none makes no group', () => {
  const r = states({
    plan: { board: [row(301, 'claimable')] },
    lines: [line(9, 0, 300, 'split #300 → #301'), line(10, 0, 310, 'split #310 → #301 (narrowed after a timeout)'), line(11, 0, 320, 'split #320 → none (narrowed after a timeout)')],
  });
  assert.deepEqual(r.groups, [{ key: 'split:310', title: '#310 (split)', progress: '0/1' }]);
  assert.equal(item(r, 301).group, 'split:310');
});

test('an issue closed without a closing line today is no item; a closed item\'s title is from its latest claim line', () => {
  const r = states({ lines: [
    line(9, 0, 400, 'impl: first try'), line(10, 0, 400, 'impl: second try'), line(10, 30, 400, 'DONE ✓ audited and merged (1 round(s), 1.0M tokens)'),
    line(9, 0, 401, 'DONE ✓ closed without a PR (1.0M tokens)'), // no claim line read
    line(9, 0, 402, 'impl: T402'), line(9, 30, 402, 'merged by a person'),
  ] });
  assert.deepEqual(r.items.map((i) => i.number), [400, 401]);
  assert.equal(item(r, 400).title, 'second try');
  assert.equal(item(r, 401).title, '');
});

test('plan undefined: no crash, sessions in Other issues, closed ones in Closed today', () => {
  const r = states({
    sessions: [impl(500), { number: 501, kind: 'review', title: 'P501', since: iso(14), turn: 1, tokens: 0 }],
    lines: [line(13, 0, 500, 'impl: T500'), line(9, 0, 502, 'impl: T502'), line(10, 0, 502, 'impl DONE ✓ (1.0M tokens)')],
  });
  assert.deepEqual(r.groups, [{ key: 'other', title: 'Other issues', progress: '2' }, { key: 'closed', title: 'Closed today', progress: '1' }]);
  assert.deepEqual(r.items.map((i) => [i.number, i.group, i.word]), [[500, 'other', 'implementing'], [501, 'other', 'review'], [502, 'closed', 'done']]);
  assert.equal(item(r, 500).prd, null);
});
