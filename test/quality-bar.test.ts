// The quality bar's board state: the bar status and action in plan(), parseQualityBar, the bar role's
// defaults, its forecast, and the review count a bar round resets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, refKey } from '../src/state.ts';
import { parseQualityBar } from '../src/prd.ts';
import { DEFAULTS, formatRoleModels, labelSpecs, roleModel, roleModelMap, roleModelsError, ROLES } from '../src/config.ts';
import { actionForecast } from '../src/budget.ts';
import { reviewRoundsDone } from '../src/pool.ts';
import type { UsageRecord } from '../src/usage.ts';

const R = 'me/app';
const L = DEFAULTS.labels;
const BAR = '## What\nA billing app.\n\n## Quality bar\nBeat: Stripe Billing — https://stripe.com/billing\nJudged on:\n- invoice speed\n- clarity\n\n## Notes\n- not a dimension\n';

const i = (number: number, labels: string[], body = '', state: 'OPEN' | 'CLOSED' = 'OPEN') =>
  ({ number, title: `t${number}`, body, state, labels, author: 'me' });
const kid = (n: number, state: 'OPEN' | 'CLOSED') => i(n, [L.ready], '## Parent\n#1', state);
const at = (prd: string[], kids: ReturnType<typeof kid>[], body = BAR, opts?: { security?: boolean }) => {
  const all = [i(1, prd, body), ...kids];
  const pl = plan(all, R, L, new Map(all.map((x) => [refKey({ repo: R, number: x.number }), x.state])), new Set(), opts);
  return { status: pl.prds[0].status, pl };
};
const closed = [kid(10, 'CLOSED')];

test('plan: bar status and action only when the section is there, every child closed, reviewed and secured, not bar-passed', () => {
  const r = at([L.prd, L.hardened, L.reviewed, L.secured], closed);
  assert.equal(r.status, 'bar');
  assert.deepEqual(r.pl.actions, [{ kind: 'bar', prd: 1, title: 't1', children: closed }]);
  // each missing condition gives the old status
  assert.equal(at([L.prd, L.hardened, L.reviewed, L.secured], [kid(10, 'CLOSED'), kid(11, 'OPEN')]).status, 'building');
  assert.equal(at([L.prd, L.hardened, L.secured], closed).status, 'review');
  assert.equal(at([L.prd, L.hardened, L.reviewed], closed).status, 'security');
  // security off: security-reviewed is not needed
  const off = at([L.prd, L.hardened, L.reviewed], closed, BAR, { security: false });
  assert.equal(off.status, 'bar');
  assert.deepEqual(off.pl.actions, [{ kind: 'bar', prd: 1, title: 't1', children: closed }]);
});

test('plan: with quality-bar-passed or without the section the PRD is done and closed as today', () => {
  for (const [labels, body] of [[[L.prd, L.reviewed, L.secured, L.barPassed], BAR], [[L.prd, L.reviewed, L.secured], '## What\nno bar']] as const) {
    const r = at([...labels], closed, body);
    assert.equal(r.status, 'done');
    assert.deepEqual(r.pl.actions, [{ kind: 'close-prd', prd: 1, secured: true }]);
  }
  const off = at([L.prd, L.reviewed, L.barPassed], closed, BAR, { security: false });
  assert.deepEqual(off.pl.actions, [{ kind: 'close-prd', prd: 1, secured: false }]);
});

test('parseQualityBar: full section, - instead of —, missing section, dimensions stop at the next heading', () => {
  assert.deepEqual(parseQualityBar(BAR), { product: 'Stripe Billing', url: 'https://stripe.com/billing', dimensions: ['invoice speed', 'clarity'] });
  assert.deepEqual(parseQualityBar('## Quality bar\r\nBeat: Linear - https://linear.app\r\nJudged on:\r\n- speed\r\n'),
    { product: 'Linear', url: 'https://linear.app', dimensions: ['speed'] });
  assert.equal(parseQualityBar('## What\nno bar here\n'), null);
  assert.equal(parseQualityBar(''), null);
});

test('config: the barPassed label, barRounds, the bar role at effort high unless roleModels.bar says otherwise', () => {
  assert.equal(L.barPassed, 'quality-bar-passed');
  assert.equal(DEFAULTS.barRounds, 3);
  const spec = labelSpecs(L).find((s) => s.name === 'quality-bar-passed');
  assert.ok(spec && /^[0-9a-f]{6}$/.test(spec.color) && spec.description.startsWith('hx: '));
  assert.ok((ROLES as readonly string[]).includes('bar'));
  assert.deepEqual(roleModel(DEFAULTS, 'bar'), { model: DEFAULTS.model, effort: 'high' });
  assert.equal(roleModel(DEFAULTS, 'review').effort, DEFAULTS.effort, 'other roles unchanged');
  assert.equal(roleModelsError({ bar: { model: 'm1', effort: 'max' } }), null);
  assert.deepEqual(roleModel({ ...DEFAULTS, roleModels: { bar: { effort: 'low' } } }, 'bar'), { model: DEFAULTS.model, effort: 'low' });
  assert.deepEqual(roleModel({ ...DEFAULTS, roleModels: { bar: { model: 'm1' } } }, 'bar'), { model: 'm1', effort: 'high' });
  // bar at its own default is not a role that differs; bar at the top-level effort is
  assert.equal(formatRoleModels(roleModelMap(DEFAULTS), DEFAULTS), '');
  assert.equal(formatRoleModels(roleModelMap({ ...DEFAULTS, roleModels: { bar: { effort: 'medium' } } }), DEFAULTS), `bar ${DEFAULTS.model}/medium`);
});

test('actionForecast: a bar action is two bar sessions (run + judge)', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 2, 10, m)).toISOString();
  const usage: UsageRecord[] = [4, 4, 4].map((costUsd, k) => ({ ts: t(k), issue: 1, role: 'bar', sessionId: `b${k}`, iteration: 1, model: 'm', ok: true, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd, durationMs: 0, numTurns: 1 }));
  assert.equal(actionForecast({ kind: 'bar', prd: 1, title: 'x', children: [] }, usage, { audit: true }), 8);
  assert.equal(actionForecast({ kind: 'bar', prd: 1, title: 'x', children: [] }, [], { audit: true }), undefined);
});

test('reviewRoundsDone: reviews before the latest bar marker do not count', () => {
  const rev = '<!-- hx-review -->\nfound gaps';
  assert.equal(reviewRoundsDone([rev, 'a comment', rev]), 2, 'no bar marker: every review counts');
  assert.equal(reviewRoundsDone([rev, rev, '<!-- hx-bar round=1 -->\nlost', rev]), 1);
  assert.equal(reviewRoundsDone([rev, '<!-- hx-bar round=1 -->', rev, rev, '  <!-- hx-bar round=2 -->\nlost']), 0);
  assert.equal(reviewRoundsDone([rev, 'quote:\n<!-- hx-bar round=1 -->', rev]), 2, 'a marker not on the first line does not count');
  assert.equal(reviewRoundsDone([]), 0);
});
