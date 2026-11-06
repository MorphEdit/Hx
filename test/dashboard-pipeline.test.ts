// The control room's Pipeline panel (#376, PRD #367 "Centre: Pipeline"): Flow (six stage columns with each live session's
// chip, the Gate column, the waiting lane, the legend's tests line) and Timeline (worker lanes, then the gate lane, bars placed
// over [from, to], six HH:MM ticks); chips and bars select their issue; every string enters the page as text.
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

// local Date values, so the expected HH:MM ticks are the local clock on any machine
const ms = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();
const FROM = ms(8), TO = ms(14);
const item = (number: number, status: string, o: object = {}) =>
  ({ number, prd: null, title: `T${number}`, status, worker: '—', waitsOn: [], chip: null, ...o });
const ITEMS = [
  item(10, 'implementing', { prd: 10, worker: 'W4', chip: { column: 'Gauntlet', note: 'round 2' } }),
  item(351, 'merging', { prd: 10, worker: 'W1', chip: { column: 'Merge', note: 'audit PASS · rebasing' } }),
  item(354, 'implementing', { worker: 'W2', chip: { column: 'Implement', note: 'turn 3' } }),
  item(362, 'implementing', { worker: 'W3', chip: { column: 'Implement', note: 'triage · turn 1' } }),
  item(360, 'auditing', { worker: 'W5', chip: { column: 'Audit', note: 'audit 1/3 · PR #366' } }),
  item(352, 'waiting', { waitsOn: ['#351'] }),
  item(353, 'waiting', { waitsOn: ['#351', '#354'] }),
  item(355, 'waiting', { waitsOn: ['other/lib#7'] }),
  item(356, 'waiting'),
  item(357, 'done', { waitsOn: ['#1'] }),
];
const bar = (issue: number | null, role: string, h0: number, m0: number, h1: number, m1: number, o: object = {}) =>
  ({ issue, role, startMs: ms(h0, m0), endMs: ms(h1, m1), ...o });
const LANES = [
  { worker: 'W1', bars: [bar(351, 'impl', 8, 0, 11, 0), bar(351, 'audit', 11, 0, 12, 0), bar(351, 'merge', 12, 0, 14, 0, { running: true })] },
  { worker: 'W2', bars: [bar(null, 'selfreview', 8, 0, 9, 0), bar(354, 'checkpoint', 9, 0, 10, 0), bar(354, 'critic', 10, 0, 11, 0)] },
  { worker: 'W3', bars: [bar(362, 'triage', 8, 0, 8, 30), bar(362, 'bar-judge', 8, 30, 9, 0), bar(362, 'decompose', 9, 0, 9, 30),
    bar(362, 'review', 9, 30, 10, 0), bar(362, 'security', 10, 0, 10, 30), bar(362, 'revise', 10, 30, 11, 0), bar(362, 'bar', 11, 0, 11, 30)] },
  { worker: 'gate', bars: [bar(null, 'gate', 9, 0, 9, 30, { ok: true }), bar(null, 'gate', 12, 0, 12, 30, { ok: false })] },
];
const RUNNING = { running: true, workers: 3, testConcurrency: 3, cpus: 12 };
const state = (o: object = {}) => ({ repo: 'me/app', runner: RUNNING, sessions: [], gate: { sha: '6f53613abcdef', ok: true }, health: null,
  log: [], waiting: [], events: [], timeline: { from: FROM, to: TO, lanes: LANES }, issues: { groups: [], items: ITEMS },
  usage: { total: null, byRole: [], byModel: [], byDay: [], byPrd: null }, ...o });

type P = ReturnType<typeof page>;
const columns = (p: P) => p.ids.get('stages')!.childNodes as E[];
const head = (c: E) => ((c.childNodes[0] as E).childNodes as E[]).map(text);
const chips = (c: E) => (c.childNodes as E[]).slice(1);
const chipText = (b: E) => [...((b.childNodes[0] as E).childNodes as E[]).map(text), text(b.childNodes[1] as E)];
const lanes = (p: P) => p.ids.get('lanes')!.childNodes as E[];
const bars = (lane: E) => ((lane.childNodes[1] as E).childNodes as E[]);
const style = (e: E) => e.getAttribute('style') ?? '';
const prop = (e: E, k: string) => new RegExp(`(?:^|;)${k}:([^;]*)`).exec(style(e))?.[1];

test('Flow: the six columns 01–06 with chips in their column (worker, #N or PRD #N, note) and busy / idle subtitles', E2E, async () => {
  const p = page(state());
  await p.flush();
  assert.deepEqual(columns(p).map(head), [
    ['01', 'Gauntlet', '1 session'], ['02', 'Decompose', 'PRD → issues · idle'], ['03', 'Implement', '2 sessions'],
    ['04', 'Audit', '1 session'], ['05', 'Merge', '1 session'], ['06', 'Gate', 'main green ✓ 6f53613'],
  ]);
  assert.deepEqual(columns(p).map((c) => chips(c).map(chipText)), [
    [['W4', 'PRD #10', 'round 2']], [], [['W2', '#354', 'turn 3'], ['W3', '#362', 'triage · turn 1']],
    [['W5', '#360', 'audit 1/3 · PR #366']], [['W1', '#351', 'audit PASS · rebasing']], [],
  ]);
  // chips are buttons with data-sel and aria-pressed; the left edge blue while merging, orange otherwise
  const all = columns(p).flatMap(chips);
  assert.ok(all.every((b) => b.tag === 'button' && b.getAttribute('type') === 'button' && b.getAttribute('aria-pressed') !== null));
  assert.deepEqual(all.map((b) => b.getAttribute('data-sel')), ['10', '354', '362', '360', '351']);
  assert.deepEqual(all.map((b) => prop(b, 'border-left')), ['4px solid var(--orange)', '4px solid var(--orange)', '4px solid var(--orange)',
    '4px solid var(--orange)', '4px solid var(--blue)']);
  // the reference's busy border only on a column with chips
  const box = (c: E) => prop(c.childNodes[0] as E, 'border');
  assert.deepEqual(columns(p).map(box), ['2px solid var(--ink)', '1px solid var(--border)', '2px solid var(--ink)', '2px solid var(--ink)',
    '2px solid var(--ink)', '1px solid var(--border)']);
  assert.deepEqual(((columns(p)[0].childNodes[0] as E).childNodes as E[]).map((e) => e.getAttribute('class')), ['mono', 'head', null]);
});

test('Flow: every column idle with no session; the Gate subtitle green, RED or no run yet, and never a chip', E2E, async () => {
  const p = page(state({ issues: { groups: [], items: [] }, gate: { sha: 'abcdef1234', ok: false } }));
  await p.flush();
  assert.deepEqual(columns(p).map((c) => head(c)[2]), ['PRD critic · idle', 'PRD → issues · idle', 'issue → PR · idle',
    'independent check · idle', 'PR → main · idle', 'main RED ✗ abcdef1']);
  assert.ok(columns(p).every((c) => chips(c).length === 0));
  const q = page(state({ gate: null, issues: { groups: [], items: [item(1, 'implementing', { worker: 'W1', chip: { column: 'Gate', note: 'x' } })] } }));
  await q.flush();
  assert.equal(head(columns(q)[5])[2], 'main · no run yet');
  assert.equal(columns(q).flatMap(chips).length, 0, 'the Gate column holds no chip');
});

test('Flow: the waiting lane holds each waiting item with an open blocker: one, two, another repo', E2E, async () => {
  const p = page(state());
  await p.flush();
  const lane = p.ids.get('waiting')!.childNodes as E[];
  assert.deepEqual(lane.map((b) => (b.childNodes as E[]).map(text)), [
    ['#352', 'waits on #351'], ['#353', 'waits on #351, #354'], ['#355', 'waits on other/lib#7'],
  ]);
  assert.deepEqual(lane.map((b) => b.getAttribute('data-sel')), ['352', '353', '355']);
  assert.ok(lane.every((b) => b.tag === 'button' && b.getAttribute('aria-pressed') !== null));
  assert.equal(prop(lane[0], 'border'), '1px dashed var(--grey)');
});

test('Flow legend: the tests line from the runner; left out when stopped or with no testConcurrency', E2E, async () => {
  const line = (s: object) => { const p = page(s); return p.flush().then(() => p.ids.get('tests-line')!); };
  const on = await line(state());
  assert.equal(on.hidden, false);
  assert.equal(text(on), 'tests run 3 files at a time per session (12 CPUs shared by 3 sessions + the gate)');
  const stopped = await line(state({ runner: { running: false } }));
  assert.equal(stopped.hidden, true);
  assert.equal(text(stopped), '');
  assert.equal((await line(state({ runner: { ...RUNNING, testConcurrency: null } }))).hidden, true);
  assert.equal((await line(state({ runner: { running: true, workers: 3, cpus: 12 } }))).hidden, true);
  // the legend's four status entries stay before it
  const legend = (await line(state())).parentNode as E;
  assert.deepEqual((legend.childNodes as E[]).map(text), ['done', 'merging', 'implementing', 'waiting',
    'tests run 3 files at a time per session (12 CPUs shared by 3 sessions + the gate)']);
});

test('Timeline: lanes in order with gate last, the bar texts, the role styles, six ticks and positions from from / to', E2E, async () => {
  const p = page(state());
  await p.flush();
  assert.deepEqual(lanes(p).map((l) => text(l.childNodes[0] as E)), ['W1', 'W2', 'W3', 'gate']);
  assert.deepEqual(lanes(p).map((l) => bars(l).map(text)), [
    ['#351 implement', '#351 audit', '#351 merge'],
    ['', '#354 checkpoint', '#354 critic'],
    ['#362 triage', '#362 bar-judge', '#362 decompose', '#362 review', '#362 security', '#362 revise', '#362 bar'],
    ['green', 'RED'],
  ]);
  // the reference's four styles: impl (and any other role), audit, merge, gate
  const STYLE: Record<string, string> = { impl: 'var(--orange-pale)', audit: 'var(--blue)', merge: 'var(--blue-pale)', gate: 'var(--ink)' };
  const kinds = lanes(p).map((l) => bars(l).map((b) => Object.keys(STYLE).find((k) => prop(b, 'background') === STYLE[k])));
  assert.deepEqual(kinds, [
    ['impl', 'audit', 'merge'],
    ['impl', 'impl', 'audit'],
    ['impl', 'audit', 'impl', 'audit', 'audit', 'impl', 'impl'],
    ['gate', 'gate'],
  ]);
  const w1 = bars(lanes(p)[0]);
  assert.deepEqual(w1.map((b) => [prop(b, 'border'), prop(b, 'color')]),
    [['1px solid var(--orange)', 'var(--ink)'], ['1px solid var(--blue)', 'var(--panel)'], ['1px solid var(--blue)', 'var(--ink)']]);
  assert.deepEqual(bars(lanes(p)[3]).map((b) => [prop(b, 'border'), prop(b, 'color')]),
    [['1px solid var(--ink)', 'var(--panel)'], ['1px solid var(--ink)', 'var(--panel)']]);
  // left = (start - from) / (to - from), width likewise, as percentages
  assert.deepEqual(w1.map((b) => [prop(b, 'left'), prop(b, 'width')]), [['0%', '50%'], ['50%', '16.667%'], ['66.667%', '33.333%']]);
  assert.deepEqual(bars(lanes(p)[3]).map((b) => [prop(b, 'left'), prop(b, 'width')]), [['16.667%', '8.333%'], ['66.667%', '8.333%']]);
  // six local HH:MM ticks evenly spaced from `from` to `to`
  assert.deepEqual((p.ids.get('ticks')!.childNodes as E[]).map(text), ['08:00', '09:12', '10:24', '11:36', '12:48', '14:00']);
  // bars are buttons with an aria-label; a bar with no issue (and a gate bar) has no data-sel
  const all = lanes(p).flatMap(bars);
  assert.ok(all.every((b) => b.tag === 'button' && b.getAttribute('type') === 'button' && b.getAttribute('aria-label')));
  assert.deepEqual(all.filter((b) => !b.hasAttribute('data-sel')).map((b) => b.getAttribute('aria-label')), ['selfreview', 'green', 'RED']);
  assert.equal(w1[0].getAttribute('aria-label'), '#351 implement');
});

test('Timeline: no lanes and no ticks before the first state', E2E, async () => {
  const p = page(null);
  await p.flush();
  assert.equal(lanes(p).length, 0);
  assert.equal(p.ids.get('ticks')!.childNodes.length, 0);
});

test('clicking a chip, a waiting chip or a bar selects its issue (state.sel, aria-pressed); a bar with no issue selects nothing', E2E, async () => {
  const p = page(state());
  await p.flush();
  const chip = (n: string) => columns(p).flatMap(chips).concat(p.ids.get('waiting')!.childNodes as E[]).find((b) => b.getAttribute('data-sel') === n)!;
  p.click(chip('354'));
  assert.equal(p.evaluate('state.sel'), '354');
  assert.equal(chip('354').getAttribute('aria-pressed'), 'true');
  assert.equal(chip('351').getAttribute('aria-pressed'), 'false');
  assert.equal(prop(chip('354'), 'border'), '2px solid var(--ink)');
  p.click(chip('353'));
  assert.equal(p.evaluate('state.sel'), '353');
  assert.equal(chip('353').getAttribute('aria-pressed'), 'true');
  assert.equal(chip('354').getAttribute('aria-pressed'), 'false');
  p.click(bars(lanes(p)[0])[1]);
  assert.equal(p.evaluate('state.sel'), '351');
  assert.equal(chip('351').getAttribute('aria-pressed'), 'true');
  assert.ok(bars(lanes(p)[0]).every((b) => prop(b, 'border') === '2px solid var(--ink)'), 'the selected issue\'s bars are outlined');
  p.click(bars(lanes(p)[1])[0]);
  assert.equal(p.evaluate('state.sel'), '351', 'the self-review bar selects nothing');
  p.click(bars(lanes(p)[3])[0]);
  assert.equal(p.evaluate('state.sel'), '351', 'a gate bar selects nothing');
  p.tick();
  await p.flush();
  assert.equal(chip('351').getAttribute('aria-pressed'), 'true', 'kept across a poll');
});

test('hostile strings in workers, notes, blockers and lane names are text, never markup', E2E, async () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const s = state({
    issues: { groups: [], items: [item(1, 'implementing', { title: XSS, worker: XSS, chip: { column: 'Implement', note: XSS } }),
      item(2, 'waiting', { title: XSS, waitsOn: [XSS] })] },
    timeline: { from: FROM, to: TO, lanes: [{ worker: XSS, bars: [bar(1, XSS, 8, 0, 9, 0)] }, { worker: 'gate', bars: [] }] },
  });
  const p = page(s);
  await p.flush();
  const pipeline = p.ids.get('stages')!.closest('section')!;
  assert.ok(pipeline.all().every((e) => e.tag !== 'img'));
  const t = text(p.ids.get('stages')!) + text(p.ids.get('waiting')!);
  assert.ok(t.includes(`${XSS}#1${XSS}`));
  assert.ok(t.includes(`waits on ${XSS}`));
  assert.equal(text(lanes(p)[0].childNodes[0] as E), XSS);
  assert.equal(text(bars(lanes(p)[0])[0]), `#1 ${XSS}`);
});
