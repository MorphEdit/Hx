// The control room's Board and Details panels (#375, PRD #367): the groups and their rows from `issues`, the All / Building /
// Done filter, the selected item's group, number, title, word, step trail, facts and next sentence, and the default selection.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E, page as fakePage, type Payload, text } from './fakedom.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'src', 'dashboard.html'), 'utf8');
const page = (state: Payload) => fakePage(html, state, null);

const XSS = '<img src=x onerror=alert(1)>';
const ISSUE = ['Claimed', 'Implement', 'Audit', 'Merge', 'Gate'], PRD = ['Gauntlet', 'Decompose', 'Build', 'Review', 'Security'];
const trail = (names: string[], states: string, notes: string[] = []) =>
  names.map((name, i) => ({ name, state: ({ d: 'done', n: 'now', x: 'next' } as Record<string, string>)[states[i]], note: notes[i] ?? '' }));
const item = (number: number, group: string, status: string, o: object = {}) => ({ number, prd: null, title: `title ${number}`, group, status,
  word: status, stage: null, since: null, waitsOn: [], steps: trail(ISSUE, 'xxxxx'), facts: [], next: '', ...o });
const at = (h: number, m: number) => new Date(2026, 10, 7, h, m).toISOString();

const GROUPS = [
  { key: 'prd:348', title: 'PRD #348 · Faster tests', progress: '2/6' },
  { key: 'split:325', title: '#325 · Machine panel (split)', progress: '0/4' },
  { key: 'other', title: 'Other issues', progress: '1' },
  { key: 'closed', title: 'Closed today', progress: '4' },
];
// out of order on purpose: the page sorts the rows and picks the earliest `since`, not the first item listed
const ITEMS = [
  item(352, 'prd:348', 'waiting', { prd: 348, title: 'Gate: reuse a tree that passed', waitsOn: ['#351'],
    facts: [['WAITS ON', '#351'], ['WORKER', 'none yet']], next: 'Starts when #351 merges.' }),
  item(354, 'prd:348', 'implementing', { prd: 348, since: at(12, 37), steps: trail(ISSUE, 'dnxxx', ['W2 · 12:37', 'turn running']) }),
  item(348, 'prd:348', 'implementing', { prd: 348, word: 'building', title: 'Faster tests', steps: trail(PRD, 'ddnxx'),
    facts: [['STATUS', 'building'], ['STEPS', '2 of 5 done']], next: 'Its issues are being built: 2/6 done.' }),
  item(351, 'prd:348', 'merging', { prd: 348, title: 'ship: record every full test run', stage: 'merge', since: at(12, 36),
    steps: trail(ISSUE, 'dddnx', ['W1 · 12:36', 'turn 1 ok · 2.5M tokens · 44 min', 'PASS ✓ · 1.9M tokens · 29 min', 'rebasing on main, then merging', 'runs the full suite on main after the merge']),
    facts: [['WORKER', 'W1'], ['TOKENS', '4.4M'], ['TIME', '1h29m'], ['ROUND', '1 of 3'], ['PR', '#366']], next: 'Rebase on main and merge. When it lands, #352 can start.' }),
  item(355, 'prd:348', 'auditing', { prd: 348, since: at(12, 50) }),
  item(349, 'prd:348', 'done', { prd: 348 }),
  item(363, 'split:325', 'waiting'),
  item(362, 'split:325', 'implementing', { since: at(12, 40) }),
  item(370, 'other', 'waiting', { title: XSS }),
  item(347, 'closed', 'done', { closedAt: at(10, 0) }),
  item(300, 'closed', 'done', { prd: 300, closedAt: at(5, 31) }),
  item(356, 'closed', 'done', { closedAt: at(12, 6) }),
  item(315, 'closed', 'done', { prd: 315, closedAt: at(12, 37), title: 'Auto-scale workers', steps: trail(PRD, 'ddddd', ['round 1 of 3 · PASS ✓', 'done', '4/4 issues done']),
    facts: [['STATUS', 'closed 12:37'], ['STEPS', 'all passed']], next: 'Closed.' }),
];
const state = (items: object[] = ITEMS, groups: object[] = GROUPS) => ({ repo: 'me/app', runner: { running: false }, sessions: [], gate: null,
  health: null, log: [], waiting: [], events: [], issues: { groups, items }, usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null } });

// a group block: [title, progress, rows]; a row: [number, word, title]
const blocks = (p: ReturnType<typeof page>) => (p.ids.get('groups')!.childNodes as E[]).map((g) => {
  const [head, ...rows] = g.childNodes as E[];
  return [...(head.childNodes as E[]).map(text), (rows as E[]).map((b) => {
    const [, col] = b.childNodes as E[], [line, title] = col.childNodes as E[];
    return [...(line.childNodes as E[]).map(text), text(title)].join(' | ');
  })];
});
const rowsOf = (p: ReturnType<typeof page>) => p.ids.get('groups')!.all().filter((e) => e.tag === 'button');
const row = (p: ReturnType<typeof page>, n: number) => rowsOf(p).find((b) => b.getAttribute('data-sel') === String(n))!;
const sel = (p: ReturnType<typeof page>) => p.evaluate('state.sel');

test('Board: groups in order with title and progress, rows sorted by status then number, open PRDs not rows, each a button', E2E, async () => {
  const p = page(state());
  await p.flush();
  assert.deepEqual(blocks(p), [
    ['PRD #348 · Faster tests', '2/6', ['#349 | done | title 349', '#351 | merging | ship: record every full test run', '#355 | auditing | title 355',
      '#354 | implementing | title 354', '#352 | waiting | Gate: reuse a tree that passed']],
    ['#325 · Machine panel (split)', '0/4', ['#362 | implementing | title 362', '#363 | waiting | title 363']],
    ['Other issues', '1', [`#370 | waiting | ${XSS}`]],
    // Closed today: its PRDs, then its issues, newest close first within each (PRD #367 "Left: Board")
    ['Closed today', '4', ['PRD #315 | done | Auto-scale workers', 'PRD #300 | done | title 300', '#356 | done | title 356', '#347 | done | title 347']],
  ]);
  for (const b of rowsOf(p)) {
    assert.equal(b.getAttribute('type'), 'button');
    assert.ok(['true', 'false'].includes(b.getAttribute('aria-pressed')!));
  }
  assert.equal(p.ids.get('groups')!.all().some((e) => e.tag === 'img'), false, 'a hostile title is text');
  // the dot and word colour per status: auditing and implementing share the working dot
  const DOT = p.evaluate('DOT');
  const look = (n: number) => { const b = row(p, n); const [dot, col] = b.childNodes as E[];
    return [dot.getAttribute('style'), ((col.childNodes[0] as E).childNodes[1] as E).getAttribute('style')]; };
  const word = (c: string) => `font-size:12px;font-weight:600;color:var(${c})`;
  assert.deepEqual(look(349), [DOT.done, word('--blue')]);
  assert.deepEqual(look(351), [DOT.merging, word('--blue')]);
  assert.deepEqual(look(355), [DOT.working, word('--orange-text')]);
  assert.deepEqual(look(354), [DOT.working, word('--orange-text')]);
  assert.deepEqual(look(352), [DOT.waiting, word('--muted-2')]);
  // the title is cut to one line; the selected row (the default, #351) is highlighted
  const title = ((row(p, 352).childNodes[1] as E).childNodes[1] as E).getAttribute('style')!;
  assert.match(title, /overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  assert.equal(row(p, 351).getAttribute('aria-pressed'), 'true');
  assert.match(row(p, 351).getAttribute('style')!, /background:var\(--blue-select\);border:1px solid var\(--blue\)$/);
  assert.equal(row(p, 352).getAttribute('aria-pressed'), 'false');
  assert.match(row(p, 352).getAttribute('style')!, /background:transparent;border:1px solid transparent$/);
});

test('Board filter: Building hides done rows, Done shows only done rows, a group with no row is not shown; Nothing on the board yet.', E2E, async () => {
  const p = page(state());
  await p.flush();
  const titles = () => blocks(p).map((b) => b[0]);
  const nums = () => rowsOf(p).map((b) => b.getAttribute('data-sel'));
  p.click(p.button('board', 'building')!);
  assert.deepEqual(titles(), ['PRD #348 · Faster tests', '#325 · Machine panel (split)', 'Other issues']);
  assert.deepEqual(nums(), ['351', '355', '354', '352', '362', '363', '370']);
  p.click(p.button('board', 'done')!);
  assert.deepEqual(titles(), ['PRD #348 · Faster tests', 'Closed today']);
  assert.deepEqual(nums(), ['349', '315', '300', '356', '347']);
  p.tick();
  await p.flush();
  assert.deepEqual(nums(), ['349', '315', '300', '356', '347'], 'the filter survives a poll');
  p.click(p.button('board', 'all')!);
  assert.equal(rowsOf(p).length, 12);

  const q = page(state([], []));
  await q.flush();
  assert.deepEqual(q.ids.get('groups')!.childNodes.map(text), ['Nothing on the board yet.']);
});

// Details: [group title, number, title, word], the steps as [name, state, dot, note], the facts, the next sentence
function details(p: ReturnType<typeof page>) {
  const [head, ol, facts, next] = p.ids.get('details')!.childNodes as E[];
  const dotState = (s: string) => (s.includes('background:var(--blue)') ? 'done' : s.includes('border:2px solid var(--orange)') ? 'now' : 'next');
  return {
    head: (head.childNodes as E[]).map(text),
    steps: (ol.childNodes as E[]).map((li) => {
      const [left, right] = li.childNodes as E[], dot = left.childNodes[0] as E;
      return [text(right.childNodes[0] as E), dotState(dot.getAttribute('style')!), text(dot), text(right.childNodes[1] as E)].join(' | ');
    }),
    facts: (facts.childNodes as E[]).map((r) => (r.childNodes as E[]).map(text)),
    next: (next.childNodes as E[]).map(text),
  };
}

test('Details: an issue, a waiting issue and a PRD selected in turn: group, number, title, word, steps, facts and next', E2E, async () => {
  const p = page(state());
  await p.flush();
  assert.equal(sel(p), '351', 'the default: the running item that started first');
  assert.deepEqual(details(p), {
    head: ['PRD #348 · Faster tests', '#351', 'ship: record every full test run', 'merging'],
    steps: ['Claimed | done | ✓ | W1 · 12:36', 'Implement | done | ✓ | turn 1 ok · 2.5M tokens · 44 min', 'Audit | done | ✓ | PASS ✓ · 1.9M tokens · 29 min',
      'Merge | now | 4 | rebasing on main, then merging', 'Gate | next | 5 | runs the full suite on main after the merge'],
    facts: [['WORKER', 'W1'], ['TOKENS', '4.4M'], ['TIME', '1h29m'], ['ROUND', '1 of 3'], ['PR', '#366']],
    next: ['WHAT HAPPENS NEXT', 'Rebase on main and merge. When it lands, #352 can start.'],
  });
  const word = (p.ids.get('details')!.childNodes[0] as E).childNodes[3] as E;
  assert.equal(word.getAttribute('style'), 'font-size:12px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:0.08em');

  p.click(row(p, 352));
  assert.equal(sel(p), '352');
  assert.equal(row(p, 352).getAttribute('aria-pressed'), 'true');
  assert.equal(row(p, 351).getAttribute('aria-pressed'), 'false');
  assert.deepEqual(details(p), {
    head: ['PRD #348 · Faster tests', '#352', 'Gate: reuse a tree that passed', 'waiting'],
    steps: ISSUE.map((n, i) => `${n} | next | ${i + 1} | `),
    facts: [['WAITS ON', '#351'], ['WORKER', 'none yet']],
    next: ['WHAT HAPPENS NEXT', 'Starts when #351 merges.'],
  });

  // a click on something inside a row counts
  const inner = (row(p, 315).childNodes[1] as E).childNodes[1] as E;
  p.click(inner);
  assert.equal(sel(p), '315');
  assert.deepEqual(details(p), {
    head: ['Closed today', 'PRD #315', 'Auto-scale workers', 'done'],
    steps: ['Gauntlet | done | ✓ | round 1 of 3 · PASS ✓', 'Decompose | done | ✓ | done', 'Build | done | ✓ | 4/4 issues done', 'Review | done | ✓ | ', 'Security | done | ✓ | '],
    facts: [['STATUS', 'closed 12:37'], ['STEPS', 'all passed']],
    next: ['WHAT HAPPENS NEXT', 'Closed.'],
  });
  // the step dots and lines: the last step has no line; a done step's line is blue, the others grey
  const lines = ((p.ids.get('details')!.childNodes[1] as E).childNodes as E[]).map((li) => ((li.childNodes[0] as E).childNodes[1] as E).getAttribute('style'));
  assert.deepEqual(lines.slice(-2), ['width:2px;flex:1;min-height:14px;background:var(--blue)', 'width:2px;flex:1;background:transparent']);

  // an open PRD (not a board row) shows its word and facts when selected from elsewhere, e.g. a chip
  const chip = p.document.createElement('button');
  chip.setAttribute('data-sel', '348');
  p.ids.get('lanes')!.appendChild(chip);
  p.click(chip);
  assert.deepEqual(details(p).head, ['PRD #348 · Faster tests', 'PRD #348', 'Faster tests', 'building']);
  assert.deepEqual(details(p).facts, [['STATUS', 'building'], ['STEPS', '2 of 5 done']]);
  assert.equal(details(p).steps[2], 'Build | now | 3 | ');
  assert.equal(((p.ids.get('details')!.childNodes[0] as E).childNodes[3] as E).getAttribute('style'),
    'font-size:12px;font-weight:600;color:var(--orange-text);text-transform:uppercase;letter-spacing:0.08em');

  // a hostile title is text in Details too
  p.click(row(p, 370));
  assert.equal(details(p).head[2], XSS);
  assert.equal(p.ids.get('details')!.all().some((e) => e.tag === 'img'), false);
});

test('selection: kept across a poll; a vanished one falls back to the earliest since, else the first row under the filter, else Nothing selected.', E2E, async () => {
  let s = state();
  const p = page(() => s);
  await p.flush();
  assert.equal(sel(p), '351');
  p.click(row(p, 363));
  p.tick();
  await p.flush();
  assert.equal(sel(p), '363', 'the selection survives a poll');
  assert.equal(row(p, 363).getAttribute('aria-pressed'), 'true');
  assert.equal(details(p).head[1], '#363');

  // #363 is gone: back to the running item that started first (#351 at 12:36, before #354, #362 and #355)
  s = state(ITEMS.filter((i) => i.number !== 363));
  p.tick();
  await p.flush();
  assert.equal(sel(p), '351');
  // nothing running and #351 gone: the first board row under the current filter
  const idle = ITEMS.filter((i) => i.number !== 351).map((i) => ({ ...i, since: null }));
  p.click(p.button('board', 'building')!);
  s = state(idle);
  p.tick();
  await p.flush();
  assert.equal(sel(p), '355', 'the first row under Building');
  assert.equal(details(p).head[1], '#355');
  p.click(p.button('board', 'done')!);
  s = state(idle.filter((i) => i.number !== 355));
  p.tick();
  await p.flush();
  assert.equal(sel(p), '349', 'the first row under Done');

  // nothing at all: the panel shows only its heading and Nothing selected.
  s = state([], []);
  p.tick();
  await p.flush();
  assert.equal(sel(p), null);
  const panel = p.ids.get('details')!.closest('section')!;
  assert.deepEqual(panel.all().map(text).filter((t, i, a) => i === a.indexOf(t) && t), ['DETAILS', 'Nothing selected.']);
  assert.equal(text(panel), 'DETAILSNothing selected.');
  assert.deepEqual(p.ids.get('details')!.childNodes.map(text), ['Nothing selected.']);
});

test('the default with no since anywhere is the first board row, sorted by status', E2E, async () => {
  const p = page(state([item(5, 'other', 'waiting'), item(4, 'other', 'implementing', { since: null })], [{ key: 'other', title: 'Other issues', progress: '2' }]));
  await p.flush();
  assert.equal(sel(p), '4', 'no since anywhere: the first row (implementing before waiting)');
});
