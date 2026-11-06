// src/controlroom.ts issueStates' Flow chip (#376, PRD #367 "Centre: Pipeline → Flow"): each live session's column and
// note, the ` · round <r>` suffix from its claim line, and no chip for the self-review session or an item with no session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipOf, issueStates, parseLines, type Item, type Timeline } from '../src/controlroom.ts';
import { localDay } from '../src/usage.ts';

const ms = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();
const iso = (h: number, m = 0) => new Date(ms(h, m)).toISOString();
const TODAY = localDay(iso(15));
const line = (h: number, m: number, n: number, msg: string) => `${iso(h, m)} [#${n}] ${msg}`;
const noTimeline: Timeline = { from: ms(9), to: ms(15), lanes: [{ worker: 'gate', bars: [] }] };
const row = (number: number, status: string) => ({ number, title: `T${number}`, status, waitingOn: [] });
const prdRow = (number: number, status: string) => ({ number, title: `P${number}`, status, open: 2, closed: 1, waitingOn: [] });
const session = (number: number, kind: string, turn = 1) => ({ number, kind, title: `T${number}`, since: iso(13), turn, tokens: 0 });

function states(o: { board?: object[]; prds?: object[]; sessions?: object[]; lines?: string[] }) {
  return issueStates({ plan: { prds: o.prds ?? [], board: o.board ?? [], parents: {} } as any, sessions: (o.sessions ?? []) as any,
    lines: o.lines ?? [], timeline: noTimeline, auditRounds: 3, today: TODAY, repo: 'me/app' });
}
const chip = (r: { items: Item[] }, n: number) => {
  const i = r.items.find((x) => x.number === n);
  assert.ok(i, `item #${n}`);
  return i.chip;
};

test('chip: an impl session by its stage: Implement `turn <turn>`, Audit `audit <n>/<N> · PR #<p>`, Merge `audit PASS · rebasing`', () => {
  const r = states({
    board: [row(1, 'working'), row(2, 'working'), row(3, 'working'), row(4, 'working')],
    sessions: [session(1, 'impl', 2), session(2, 'impl', 1), session(3, 'impl', 1), session(4, 'impl', 3)],
    lines: [
      line(13, 0, 1, 'impl: T1'), line(13, 30, 1, 'impl turn 1: ok · 1.0M tokens (1.0K out) · 1800s'),
      line(13, 0, 2, 'impl: T2'), line(13, 40, 2, 'audit 1/3: PR #20'), line(14, 0, 2, 'audit FAIL ✗ — x'), line(14, 1, 2, 'audit 2/3: PR #20'),
      line(13, 0, 3, 'impl: T3'), line(13, 40, 3, 'audit 1/3: PR #30'), line(14, 0, 3, 'audit PASS ✓'),
      line(13, 0, 4, 'impl: T4'), line(13, 40, 4, 'audit 1/3: PR #40'), line(14, 0, 4, 'audit FAIL ✗ — back to the implementer'),
    ],
  });
  assert.deepEqual(chip(r, 1), { column: 'Implement', note: 'turn 2' });
  assert.deepEqual(chip(r, 2), { column: 'Audit', note: 'audit 2/3 · PR #20' });
  assert.deepEqual(chip(r, 3), { column: 'Merge', note: 'audit PASS · rebasing' });
  assert.deepEqual(chip(r, 4), { column: 'Implement', note: 'turn 3' }, 'back to the implementer after a FAIL');
});

test('chip: an impl session merging a held PR is in Merge', () => {
  const r = states({ board: [row(5, 'working')], sessions: [session(5, 'impl')],
    lines: [line(13, 0, 5, 'impl: T5'), line(14, 0, 5, 'main is green: merging held PR #50 (audit 1/3)')] });
  assert.deepEqual(chip(r, 5), { column: 'Merge', note: 'audit PASS · rebasing' });
});

test('chip: gauntlet `round <r>`, decompose, and review / security / bar in Audit with ` · round <r>` from their claim line', () => {
  const r = states({
    prds: [prdRow(10, 'gauntlet'), prdRow(11, 'decompose'), prdRow(12, 'review'), prdRow(13, 'security'), prdRow(14, 'bar')],
    sessions: [session(10, 'gauntlet'), session(11, 'decompose'), session(12, 'review'), session(13, 'security'), session(14, 'bar')],
    lines: [
      line(13, 0, 10, 'gauntlet (round 2): P10'), line(13, 0, 11, 'decompose: P11'), line(13, 0, 12, 'review (round 1): P12'),
      line(13, 0, 13, 'security (round 2): P13'), line(13, 0, 14, 'bar (round 3): P14'),
    ],
  });
  assert.deepEqual(chip(r, 10), { column: 'Gauntlet', note: 'round 2' });
  assert.deepEqual(chip(r, 11), { column: 'Decompose', note: 'decompose' });
  assert.deepEqual(chip(r, 12), { column: 'Audit', note: 'review · round 1' });
  assert.deepEqual(chip(r, 13), { column: 'Audit', note: 'security pass · round 2' });
  assert.deepEqual(chip(r, 14), { column: 'Audit', note: 'quality bar · round 3' });
});

test('chip: no ` · round <r>` without a claim line of the session\'s own kind; a result line is not a claim', () => {
  const r = states({
    prds: [prdRow(20, 'review'), prdRow(21, 'security'), prdRow(22, 'bar')],
    sessions: [session(20, 'review'), session(21, 'security'), session(22, 'bar')],
    lines: [line(13, 0, 21, 'gauntlet (round 2): P21'), line(13, 0, 22, 'bar: 2 round(s) already ran — closing')],
  });
  assert.deepEqual(chip(r, 20), { column: 'Audit', note: 'review' });
  assert.deepEqual(chip(r, 21), { column: 'Audit', note: 'security pass' }, 'the claim line is the gauntlet\'s');
  assert.deepEqual(chip(r, 22), { column: 'Audit', note: 'quality bar' });
  // a gauntlet session with no claim line still has its column
  assert.deepEqual(chipOf({ kind: 'gauntlet' }, null, []), { column: 'Gauntlet', note: 'gauntlet' });
});

test('chip: triage and any other kind in Implement, `<kind> · turn <turn>`', () => {
  const r = states({ board: [row(30, 'triage'), row(31, 'working')], sessions: [session(30, 'triage', 4), session(31, 'checkpoint', 2)],
    lines: [line(13, 0, 30, 'triage (round 1): T30')] });
  assert.deepEqual(chip(r, 30), { column: 'Implement', note: 'triage · turn 4' });
  assert.deepEqual(chip(r, 31), { column: 'Implement', note: 'checkpoint · turn 2' });
  assert.deepEqual(chipOf({ kind: 'impl', turn: 7 }, 'impl', parseLines([line(13, 0, 1, 'impl: T1')])), { column: 'Implement', note: 'turn 7' });
});

test('chip: none for the self-review session, an item with no live session, or an issue closed today', () => {
  const r = states({
    board: [row(40, 'claimable'), row(41, 'working')], prds: [prdRow(42, 'gauntlet')],
    sessions: [session(0, 'selfreview'), session(41, 'impl')],
    lines: [line(12, 0, 43, 'impl: T43'), line(12, 30, 43, 'DONE ✓ audited and merged PR #44')],
  });
  assert.equal(r.items.some((i) => i.number === 0), false, 'the self-review session is no item');
  assert.equal(chip(r, 40), null);
  assert.equal(chip(r, 42), null, 'a PRD with no session');
  assert.equal(chip(r, 43), null, 'closed today');
  assert.deepEqual(r.items.filter((i) => i.chip).map((i) => i.number), [41]);
});
