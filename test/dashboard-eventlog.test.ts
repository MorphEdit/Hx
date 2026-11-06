// The control room's Event log (#377, PRD #367): today's events as the reference's table, the All / Results / Problems
// filter kept across polls, the selected issue's rows highlighted, `No events today.`, every string as text.
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

// fixture times from local Date values, so the expected HH:MM:SS is the local clock on any machine
const at = (h: number, m: number, s: number) => new Date(2026, 10, 7, h, m, s).toISOString();
const ev = (t: string, issue: number | null, step: string, txt: string, tokens: number | null, kind: string) => ({ t, issue, step, text: txt, tokens, kind });
const EVENTS = [
  ev(at(9, 5, 7), 351, 'Implement', 'impl: Add the thing', null, 'info'),
  ev(at(11, 32, 50), null, 'Gate', 'gate RED ✗ at 5ca3204', null, 'problem'),
  ev(at(12, 21, 31), null, 'Start', 'hx run started', null, 'info'),
  ev(at(12, 37, 43), 315, 'Security', 'security pass DONE ✓', 288_400, 'result'),
  ev(at(13, 20, 45), 351, 'Implement', 'impl turn 1: ok', 2_500_000, 'info'),
  ev(at(13, 49, 41), 351, 'Audit', 'audit PASS ✓', 950, 'result'),
  ev(at(14, 0, 0), 354, 'Audit', 'audit FAIL ✗', 1_940_000, 'problem'),
];
// 315 is a PRD item (prd === number); 351 is its child, 354 an issue with no PRD
const ITEMS = [{ number: 315, prd: 315 }, { number: 351, prd: 315 }, { number: 354, prd: null }];
const state = (events: object[] = EVENTS) => ({ repo: 'me/app', runner: { running: false }, sessions: [], gate: null, health: null, log: ['raw line'],
  waiting: [], events, issues: { groups: [], items: ITEMS }, usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null } });

const rows = (p: ReturnType<typeof page>) => p.ids.get('events')!.childNodes as E[];
const cells = (r: E) => (r.childNodes as E[]).map(text);
const on = (r: E) => (r.getAttribute('style') ?? '').includes('box-shadow:inset 3px 0 0 var(--blue)');

test('Event log: one row per event with TIME, ISSUE (#N / PRD #N / gate / runner), STEP badge, WHAT HAPPENED, short TOKENS', E2E, async () => {
  const p = page(state());
  await p.flush();
  assert.deepEqual(rows(p).map(cells), [
    ['09:05:07', '#351', 'Implement', 'impl: Add the thing', ''],
    ['11:32:50', 'gate', 'Gate', 'gate RED ✗ at 5ca3204', ''],
    ['12:21:31', 'runner', 'Start', 'hx run started', ''],
    ['12:37:43', 'PRD #315', 'Security', 'security pass DONE ✓', '288K'],
    ['13:20:45', '#351', 'Implement', 'impl turn 1: ok', '2.5M'],
    ['13:49:41', '#351', 'Audit', 'audit PASS ✓', '950'],
    ['14:00:00', '#354', 'Audit', 'audit FAIL ✗', '1.9M'],
  ]);
  // the reference's styles, each colour a custom property; the step badge by kind
  const r = rows(p)[1];
  assert.equal(r.getAttribute('style'), 'border-top:1px solid var(--soft);background:var(--panel)');
  const badge = (i: number) => (rows(p)[i].childNodes[2] as E).all()[0].getAttribute('style');
  const base = 'display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;';
  assert.equal(badge(1), base + 'background:var(--orange-pale);color:var(--orange-deep)');
  assert.equal(badge(3), base + 'background:var(--blue-pale);color:var(--blue-deep)');
  assert.equal(badge(2), base + 'background:var(--soft);color:var(--ink-2)');
  assert.deepEqual((r.childNodes as E[]).map((c) => c.getAttribute('class')), ['mono', 'mono', null, null, 'mono']);
  assert.equal((r.childNodes[4] as E).getAttribute('style'), 'padding:9px 16px;font-size:12px;text-align:right;white-space:nowrap');
  assert.equal(p.evaluate('shortTok(1000)'), '1K');
  assert.equal(p.evaluate('shortTok(999)'), '999');
  assert.equal(p.evaluate('shortTok(1000000)'), '1.0M');
  assert.equal(p.evaluate('shortTok(0)'), '0');
  // the raw log tail stays in the collapsed <details> below the table
  assert.equal(text(p.ids.get('log')!), 'raw line');
  assert.equal(p.ids.get('log')!.closest('details')!.hasAttribute('open'), false);
});

test('Event log filter: Results only result rows, Problems only problem rows, All every row; it survives a poll', E2E, async () => {
  const p = page(state());
  await p.flush();
  const what = () => rows(p).map((r) => cells(r)[3]);
  p.click(p.button('filter', 'results')!);
  assert.deepEqual(what(), ['security pass DONE ✓', 'audit PASS ✓']);
  p.tick();
  await p.flush();
  assert.deepEqual(what(), ['security pass DONE ✓', 'audit PASS ✓'], 'kept across a poll');
  p.click(p.button('filter', 'problems')!);
  assert.deepEqual(what(), ['gate RED ✗ at 5ca3204', 'audit FAIL ✗']);
  p.tick();
  await p.flush();
  assert.deepEqual(what(), ['gate RED ✗ at 5ca3204', 'audit FAIL ✗'], 'kept across a poll');
  p.click(p.button('filter', 'all')!);
  assert.equal(rows(p).length, EVENTS.length);
});

test('Event log: a data-sel click highlights exactly the selected issue\'s rows; a new selection moves the highlight', E2E, async () => {
  const p = page(state());
  await p.flush();
  assert.deepEqual(rows(p).map(on), EVENTS.map(() => false), 'nothing selected');
  const pick = (n: string) => {
    const b = p.document.createElement('button');
    b.setAttribute('data-sel', n);
    p.ids.get('lanes')!.appendChild(b);
    p.click(b);
  };
  pick('351');
  assert.deepEqual(rows(p).map(on), [true, false, false, false, true, true, false]);
  assert.equal(rows(p)[0].getAttribute('style'), 'border-top:1px solid var(--soft);background:var(--blue-select);box-shadow:inset 3px 0 0 var(--blue)');
  pick('315');
  assert.deepEqual(rows(p).map(on), [false, false, false, true, false, false, false]);
  pick('354');
  assert.deepEqual(rows(p).map(on), [false, false, false, false, false, false, true]);
  p.tick();
  await p.flush();
  assert.deepEqual(rows(p).map(on), [false, false, false, false, false, false, true], 'kept across a poll');
});

test('Event log: No events today. with an empty list, and with none under the filter', E2E, async () => {
  const p = page(state([]));
  await p.flush();
  assert.equal(rows(p).length, 1);
  assert.equal(text(rows(p)[0]), 'No events today.');
  assert.equal((rows(p)[0].childNodes[0] as E).getAttribute('colspan'), '5');
  const q = page(state([EVENTS[0]]));
  await q.flush();
  q.click(q.button('filter', 'problems')!);
  assert.deepEqual(rows(q).map(text), ['No events today.']);
});

test('Event log: a hostile event text and step are text, never markup', E2E, async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const p = page(state([ev(at(10, 0, 0), 7, XSS, XSS, null, 'problem')]));
  await p.flush();
  assert.deepEqual(cells(rows(p)[0]).slice(2, 4), [XSS, XSS]);
  assert.equal(p.ids.get('events')!.all().some((e) => e.tag === 'img'), false);
});
