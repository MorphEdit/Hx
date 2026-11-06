// The control room's "Same look" (#378, PRD #367): every fixed label of docs/design/control-room.html is in the reference
// and on the page, in its static markup or in what its script renders from the reference's SAMPLE (test/fixtures), with an
// issue, a waiting issue and a PRD selected in turn; the page's panels come in the reference's order. Sample data is not compared.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E, N, T, page, staticBody } from './fakedom.ts';
import { controlRoomState } from './fixtures/control-room-state.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'src', 'dashboard.html'), 'utf8');
const ref = readFileSync(path.join(here, '..', 'docs', 'design', 'control-room.html'), 'utf8');

const ISSUE_STEPS = ['Claimed', 'Implement', 'Audit', 'Merge', 'Gate'], PRD_STEPS = ['Gauntlet', 'Decompose', 'Build', 'Review', 'Security'];
const STAGES = ['Gauntlet', 'Decompose', 'Implement', 'Audit', 'Merge', 'Gate'];
const LABELS = [
  'HX CONTROL ROOM', 'RUNNER', 'MACHINE', 'MAIN', 'WAITING ON YOU', 'TODAY',
  'BOARD', 'All', 'Building', 'Done',
  'PIPELINE', 'Flow', 'Timeline', '01', '02', '03', '04', '05', '06', ...STAGES, 'WAITING FOR ANOTHER ISSUE',
  'done', 'merging', 'implementing', 'waiting', 'Each bar is one session. Click one to see its issue. The gate row is the full test suite on main.',
  'DETAILS', ...ISSUE_STEPS, ...PRD_STEPS, 'WORKER', 'TOKENS', 'TIME', 'ROUND', 'PR', 'WAITS ON', 'STATUS', 'STEPS', 'WHAT HAPPENS NEXT',
  'EVENT LOG', 'today, from .hx/run.log · the selected issue is highlighted', 'Results', 'Problems', 'ISSUE', 'STEP', 'WHAT HAPPENED',
];
// the reference's panels; the page's own additions (the Waiting on you card, the More area, the fleet link) are not compared
const PANELS = ['Board', 'Pipeline', 'Issue details', 'Event log'];

/** The header and the reference's four panels under `root`. */
const regions = (root: E) => root.all().filter((e) => e.tag === 'header' || (e.tag === 'section' && PANELS.includes(e.getAttribute('aria-label') ?? '')));
/** Every text under the regions, each node's text trimmed. */
const texts = (root: E) => regions(root).flatMap((r) => {
  const out: string[] = [];
  const walk = (n: N) => { if (n instanceof T) out.push(n.data.trim()); else n.childNodes.forEach(walk); };
  walk(r);
  return out;
});
const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;
/** `probe` of the page with the sample, once per selection: the default (#351, merging), a waiting issue (#352), a PRD (#315). */
async function rendered<R>(probe: (root: E) => R): Promise<{ sel: string; seen: R }[]> {
  const p = page(html, controlRoomState(), null);
  await p.flush();
  const out = [{ sel: String(p.evaluate('state.sel')), seen: probe(p.root) }];
  for (const n of ['352', '315']) {
    p.click(p.button('sel', n, p.ids.get('groups')!)!);
    out.push({ sel: String(p.evaluate('state.sel')), seen: probe(p.root) });
  }
  return out;
}

test('Same look: every fixed label is in the reference and on the page, in its static markup or rendered from the sample', E2E, async () => {
  const refStatic = texts(staticBody(ref)), pageStatic = texts(staticBody(html));
  const views = await rendered(texts);
  assert.deepEqual(views.map((v) => v.sel), ['351', '352', '315'], 'an issue, a waiting issue and a PRD selected in turn');
  const missing: string[] = [];
  for (const l of LABELS) {
    assert.ok(ref.includes(l), `the reference has ${l}`);
    // a label in the reference's markup is in the page's markup as often (both tab rows have All); one the reference's
    // script renders is rendered by the page's script from the sample
    const inMarkup = count(refStatic, l);
    const shown = inMarkup ? count(pageStatic, l) >= inMarkup : views.some((v) => v.seen.includes(l));
    if (!shown) missing.push(l);
  }
  assert.deepEqual(missing, [], 'labels the page does not show');
});

test('Same look: the stage columns, the step trails and the facts rows carry the reference\'s labels, in its order', E2E, async () => {
  const byId = (root: E, id: string) => root.all().find((e) => e.getAttribute('id') === id)!;
  const views = await rendered((root) => {
    const details = byId(root, 'details'), [, , box, next] = details.childNodes as E[];
    return {
      stages: (byId(root, 'stages').childNodes as E[]).map((c) => ((c.childNodes[0] as E).childNodes as E[]).slice(0, 2).map((x) => x.textContent).join(' ')),
      steps: details.all().filter((e) => e.tag === 'li').map((li) => ((li.childNodes[1] as E).childNodes[0] as E).textContent),
      facts: (box.childNodes as E[]).map((r) => (r.childNodes[0] as E).textContent),
      next: (next.childNodes[0] as E).textContent,
    };
  });
  const [issue, wait, prd] = views.map((v) => v.seen);
  assert.deepEqual(issue.stages, STAGES.map((s, i) => `0${i + 1} ${s}`));
  assert.deepEqual(issue.steps, ISSUE_STEPS);
  assert.deepEqual(wait.steps, ISSUE_STEPS);
  assert.deepEqual(prd.steps, PRD_STEPS);
  assert.deepEqual(issue.facts, ['WORKER', 'TOKENS', 'TIME', 'ROUND', 'PR']);
  assert.deepEqual(wait.facts, ['WAITS ON', 'WORKER']);
  assert.deepEqual(prd.facts, ['STATUS', 'STEPS']);
  for (const v of [issue, wait, prd]) assert.equal(v.next, 'WHAT HAPPENS NEXT');
  // the step names and facts rows come from the state: hx's control-room data writes the same words
  const cr = readFileSync(path.join(here, '..', 'src', 'controlroom.ts'), 'utf8');
  for (const w of [...ISSUE_STEPS, ...PRD_STEPS, 'WORKER', 'TOKENS', 'TIME', 'ROUND', 'PR', 'WAITS ON', 'STATUS', 'STEPS'])
    assert.ok(cr.includes(`'${w}'`), `src/controlroom.ts writes ${w}`);
});

test('Same look: the panels come in the reference\'s order after the header — Board, Pipeline, Issue details, Event log', E2E, () => {
  const order = (root: E) => {
    const all = root.all(), header = all.findIndex((e) => e.tag === 'header');
    const sections = all.map((e, i) => [i, e.tag === 'section' ? e.getAttribute('aria-label') : null] as const).filter(([, l]) => l);
    assert.ok(header >= 0, 'a header');
    assert.ok(sections.every(([i]) => i > header), 'every panel after the header');
    return sections.map(([, l]) => l);
  };
  const refOrder = order(staticBody(ref));
  assert.deepEqual(refOrder, PANELS);
  assert.deepEqual(order(staticBody(html)).filter((l) => refOrder.includes(l!)), refOrder);
});
