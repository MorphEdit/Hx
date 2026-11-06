// src/controlroom.ts (#370, PRD #367): the run.log line helpers (claim lines, the current claim, a live impl session's
// stage) and eventsFrom. Times are built from local Date values, so "today" holds in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimOf, currentClaim, eventsFrom, implStage, isClaimLine, parseLine, parseLines, tokensIn, withoutSummary } from '../src/controlroom.ts';

const TODAY = '2026-11-07';
const at = (h: number, m = 0, s = 0, day = 7) => new Date(2026, 10, day, h, m, s).toISOString();
const line = (h: number, msg: string, n?: number) => `${at(h)} ${n === undefined ? '' : `[#${n}] `}${msg}`;
const one = (msg: string, n?: number, blocked = 'agent-blocked') => eventsFrom([line(12, msg, n)], TODAY, blocked);
const ev = (msg: string, n?: number) => { const e = one(msg, n); assert.equal(e.length, 1, `one event for ${msg}`); return e[0]; };

test('parseLine reads `<ISO> [#n] <msg>` and `<ISO> <msg>`; other lines are skipped', () => {
  assert.deepEqual(parseLine('2026-11-07T10:00:00.000Z [#5] impl: x'), { t: '2026-11-07T10:00:00.000Z', issue: 5, msg: 'impl: x' });
  assert.deepEqual(parseLine('2026-11-07T10:00:00Z gate green ✓'), { t: '2026-11-07T10:00:00Z', issue: null, msg: 'gate green ✓' });
  assert.equal(parseLine('a continuation line'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLines(['x', '2026-11-07T10:00:00Z hx pool up', '']).length, 1);
});

test('claim lines by their exact shape only', () => {
  const c = (msg: string, n: number | null = 5) => claimOf({ t: at(1), issue: n, msg });
  assert.deepEqual(c('impl: Add a thing'), { kind: 'impl', round: null, title: 'Add a thing' });
  assert.deepEqual(c('decompose: PRD x'), { kind: 'decompose', round: null, title: 'PRD x' });
  for (const k of ['gauntlet', 'review', 'security', 'triage', 'bar']) assert.deepEqual(c(`${k} (round 2): T`), { kind: k, round: 2, title: 'T' });
  // not claims: results with no round, round 0, a kind with no round form, a round on impl, a line without an issue
  for (const msg of ['triage: REPRODUCED ✓ (1 turn(s), 2M tokens)', 'triage: NEEDS-INFO — waiting for the reporter (x)', 'triage: FAILED (agent error; 1 turn(s), 5K tokens)',
    'triage: GAVE UP after 3 rounds', 'triage: round cap reached — labelled agent-blocked', 'bar: 2 round(s) already ran — labelled quality-bar-passed',
    'triage (round 0): T', 'gauntlet: T', 'impl (round 1): T', 'impl turn 1: ok · 2M tokens (5K out) · 60s', 'impl DONE ✓ (x)', 'audit 1/3: PR #9', 'review round cap (3) reached — labelled agent-blocked'])
    assert.equal(c(msg), null, msg);
  assert.equal(c('impl: T', null), null, 'a claim line names its issue');
  assert.equal(isClaimLine({ t: at(1), issue: 5, msg: 'bar (round 1): T' }), true);
});

test('the current claim: from the latest claim line on; a result line never starts a claim', () => {
  const lines = parseLines([
    line(1, 'triage (round 1): Bug', 7), line(2, 'triage: FAILED (agent error; 1 turn(s), 5K tokens)', 7),
    line(3, 'impl: Other', 8), line(4, 'triage (round 2): Bug', 7), line(5, 'triage: GAVE UP after 2 rounds', 7), line(6, 'triage: REPRODUCED ✓ (2M tokens)', 7),
  ]);
  assert.deepEqual(currentClaim(lines, 7).map((l) => l.msg), ['triage (round 2): Bug', 'triage: GAVE UP after 2 rounds', 'triage: REPRODUCED ✓ (2M tokens)']);
  assert.deepEqual(currentClaim(lines.slice(0, 2), 7).map((l) => l.msg), ['triage (round 1): Bug', 'triage: FAILED (agent error; 1 turn(s), 5K tokens)'],
    'triage: FAILED after a triage claim keeps that claim');
  assert.deepEqual(currentClaim(lines, 8).map((l) => l.msg), ['impl: Other']);
  assert.deepEqual(currentClaim(lines, 9), [], 'no claim line: empty');
});

test('the stage of a live impl session: the latest audit / merge / back line after the claim', () => {
  const stage = (...msgs: string[]) => implStage(parseLines([line(1, 'audit PASS ✓', 5), line(2, 'impl: T', 5),
    ...msgs.map((m, i) => line(3 + i, m, 5)), line(20, 'audit 1/3: PR #1', 6)]), 5);
  assert.equal(stage(), 'impl', 'none → impl (an audit line before the claim does not count, nor another issue\'s)');
  assert.equal(stage('impl turn 1: ok · 2M tokens (5K out) · 60s'), 'impl');
  assert.equal(stage('audit 1/3: PR #12'), 'audit');
  assert.equal(stage('audit 1/3: PR #12', 'audit turn 1: ok · 1M tokens (5K out) · 60s'), 'audit');
  assert.equal(stage('audit 1/3: PR #12', 'audit PASS ✓'), 'merge');
  assert.equal(stage('audit 1/3: PR #12', 'audit FAIL ✗ — a finding'), 'impl');
  assert.equal(stage('audit 1/3: PR #12', 'audit FAIL ✗ — x', 'audit 2/3: PR #12'), 'audit');
  assert.equal(stage('main is green: merging held PR #12 (audit 1/3 PASS kept)'), 'merge');
  assert.equal(stage('audit PASS ✓', 'tests fail after the rebase — back to the implementer, merge round 1/2 (audit round 1/3 unchanged)'), 'impl');
  assert.equal(implStage(parseLines([line(1, 'audit 1/3: PR #1', 5)]), 5), 'impl', 'no claim line: impl');
});

test('eventsFrom: the kinds', () => {
  for (const msg of ['gate RED ✗ on abc', 'audit FAIL ✗ — x', 'triage: FAILED (agent error; 1 turn(s), 5K tokens)', 'triage: GAVE UP after 3 rounds',
    'impl timed out after 30 min', 'review round cap (3) reached — labelled agent-blocked', 'merge conflict on PR #4', 'impl turn 2: error · 1K tokens (1K out) · 5s',
    'checkpoint failed: x — the worktree still has the work', 'gate crashed', 'STOPPED: bad config'])
    assert.equal(ev(msg, 3).kind, 'problem', msg);
  for (const msg of ['DONE ✓ audited and merged (1 round(s), 3 turn(s), 2M tokens)', 'audit PASS ✓', 'PRD closed ✓ (3 issues)', 'gate green ✓ again', 'impl DONE ✓ (2 turn(s), 1M tokens)'])
    assert.equal(ev(msg, 3).kind, 'result', msg);
  for (const msg of ['audit 1/3: PR #4', 'impl turn 1: ok · 2M tokens (5K out) · 60s', 'released v0.3.0 (PRD #129)', 'hx pool up: 3 workers'])
    assert.equal(ev(msg, 3).kind, 'info', msg);
  // `labelled <blockedLabel>` uses the passed label
  assert.equal(one('review round cap (3) reached — labelled stuck', 3, 'stuck')[0].kind, 'problem');
  assert.equal(one('review round cap (3) reached — labelled stuck', 3, 'agent-blocked')[0].kind, 'info');
});

test('eventsFrom: the triage and bar result lines', () => {
  assert.deepEqual([ev('triage (round 1): A bug', 4).kind, ev('triage (round 1): A bug', 4).step], ['info', 'Triage']);
  assert.equal(ev('triage: FAILED (no verdict comment; 1 turn(s), 5K tokens)', 4).kind, 'problem');
  assert.equal(ev('triage: GAVE UP after 3 rounds', 4).kind, 'problem');
  assert.equal(ev('triage: REPRODUCED ✓ (1 turn(s), 2M tokens)', 4).kind, 'info');
  assert.equal(ev('triage: NEEDS-INFO — waiting for the reporter (1 turn(s), 2M tokens)', 4).kind, 'info');
  assert.equal(ev('triage: round cap reached — labelled agent-blocked', 4).kind, 'problem');
  assert.deepEqual([ev('bar: 2 round(s) already ran — labelled quality-bar-passed', 4).kind, ev('bar: 2 round(s) already ran — labelled quality-bar-passed', 4).step], ['info', 'Bar']);
});

test('eventsFrom: a claim line with a hostile title stays info, its title kept as text', () => {
  const title = '<img src=x onerror=alert(1)> FAIL ✗ DONE ✓ gate RED ✗ labelled agent-blocked';
  for (const msg of [`impl: ${title}`, `review (round 1): ${title}`, `bar (round 2): ${title}`]) {
    const e = ev(msg, 9);
    assert.equal(e.kind, 'info', msg);
    assert.equal(e.text, msg);
  }
});

test('eventsFrom: every step of the table; Error for an otherwise unmatched problem; an unmatched non-problem line left out', () => {
  const steps: [string, string, number?][] = [
    ['gate green ✓ again', 'Gate'], ['gate RED ✗ on abc', 'Gate'],
    ['impl: T', 'Implement', 1], ['impl turn 1: ok · 2M tokens (5K out) · 60s', 'Implement', 1], ['checkpoint saved (288K tokens)', 'Implement', 1],
    ['timed out after 30 min', 'Implement', 1], ['asked the owner a question', 'Implement', 1], ['not narrowed after the timeout: x', 'Implement', 1],
    ['audit 1/3: PR #2', 'Audit', 1], ['audit PASS ✓', 'Audit', 1],
    ['DONE ✓ audited and merged (1 round(s), 2M tokens)', 'Merge', 1], ['merge round 1/2', 'Merge', 1], ['main is green: merging held PR #2 (audit 1/3 PASS kept)', 'Merge', 1],
    ['DONE ✓ closed without a PR (1 turn(s), 1M tokens)', 'Close', 1], ['PRD closed ✓', 'Close', 1],
    ['split into #3, #4', 'Size', 1], ['size check: fits', 'Size', 1],
    ['gauntlet (round 1): P', 'Gauntlet', 1], ['critic: 3 findings', 'Gauntlet', 1], ['revise done', 'Gauntlet', 1], ['reviser done', 'Gauntlet', 1],
    ['decompose: P', 'Decompose', 1], ['review (round 1): P', 'Review', 1], ['security (round 1): P', 'Security', 1], ['bar (round 1): P', 'Bar', 1],
    ['triage: REPRODUCED ✓ (2M tokens)', 'Triage', 1], ['released v0.3.0 (PRD #129)', 'Release'], ['release: none due — no PRD closed', 'Release'],
    ['hx pool up: 3 workers', 'Start'], ['self-update: restarted — pid 5 took over', 'Start'],
    ['model mismatch: asked for x, got y — something failed', 'Error'], ['worktree setup crashed', 'Error', 2],
  ];
  for (const [msg, step, n] of steps) assert.equal(ev(msg, n).step, step, msg);
  assert.deepEqual(one('model mismatch: asked for x, got y'), [], 'an unmatched info line is left out');
  assert.deepEqual(one('labels changed by hand', 2), []);
});

test('eventsFrom: today only, in log order', () => {
  const lines = [
    `${at(23, 59, 59, 6)} [#1] audit PASS ✓`,                 // the day before
    `${at(0, 0, 0)} [#1] audit 1/3: PR #2`,
    'not a log line',
    `${at(12)} gate RED ✗ on abc`,
    `${at(23, 59, 59)} [#2] impl: T`,
    `${at(0, 0, 0, 8)} [#2] audit PASS ✓`,                    // the day after
  ];
  const e = eventsFrom(lines, TODAY, 'agent-blocked');
  assert.deepEqual(e.map((x) => [x.t, x.issue, x.step]), [[at(0, 0, 0), 1, 'Audit'], [at(12), null, 'Gate'], [at(23, 59, 59), 2, 'Implement']]);
});

test('eventsFrom: tokens parsed and the trailing token summary removed from text', () => {
  assert.deepEqual([ev('DONE ✓ audited and merged (1 round(s), 3 turn(s), 2.5M tokens)', 1).text, ev('DONE ✓ audited and merged (1 round(s), 3 turn(s), 2.5M tokens)', 1).tokens],
    ['DONE ✓ audited and merged', 2_500_000]);
  assert.deepEqual([ev('checkpoint saved (288K tokens)', 1).text, ev('checkpoint saved (288K tokens)', 1).tokens], ['checkpoint saved', 288_000]);
  assert.equal(ev('impl DONE ✓ (1 turn(s), 950 tokens)', 1).tokens, 950, 'a plain number');
  const turn = ev('impl turn 1: ok · 1.2M tokens (300K out) · 60s', 1);
  assert.deepEqual([turn.text, turn.tokens], ['impl turn 1: ok · 1.2M tokens (300K out) · 60s', 1_200_000], 'the first count; no trailing summary');
  const none = ev('audit 1/3: PR #2', 1);
  assert.deepEqual([none.text, none.tokens], ['audit 1/3: PR #2', null]);
  assert.equal(ev('released v0.3.0 (PRD #129)').text, 'released v0.3.0 (PRD #129)', 'a trailing (…) with no token count stays');
  assert.equal(ev('triage: FAILED (agent error: bad (x); 1 turn(s), 5K tokens)', 1).text, 'triage: FAILED', 'nested parens');
  assert.equal(tokensIn('a 3M tokens b 1K tokens'), 3_000_000);
  assert.equal(withoutSummary('x (no count)'), 'x (no count)');
});
