// hx usage --compare (#231): src/compare.ts counts the two periods from usage records and hx's own markers on
// issues and comments; the command fetches every issue in one paged GraphQL query and prints them side by side.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { change, compare, parseTime, stopCause, type CompareIssue } from '../src/compare.ts';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { barMarker } from '../src/bar.ts';
import { docsText } from './docs-text.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-cmp-'));
const S = 1000, M = 60_000;
const AT = '2026-11-04T00:00:00Z';
const B = (h: number) => new Date(Date.parse(AT) - h * 3_600_000).toISOString(); // h hours before the split
const A = (h: number) => new Date(Date.parse(AT) + h * 3_600_000).toISOString(); // h hours after

const rec = (ts: string, role: string, sessionId: string, o: { durationMs?: number; testMs?: number; tokens?: number; output?: number; cost?: number; ok?: boolean; workersTarget?: number } = {}) => ({
  ts, issue: 1, role, sessionId, iteration: 1, model: 'm', ok: o.ok ?? true,
  usage: { input: o.tokens ?? 100, cacheWrite: 0, cacheRead: 0, output: o.output ?? 10 }, costUsd: o.cost ?? 1, durationMs: o.durationMs ?? 10 * M, numTurns: 1,
  ...(o.testMs !== undefined ? { testMs: o.testMs, testRuns: 1, testFailedRuns: 0 } : {}), ...(o.workersTarget !== undefined ? { workersTarget: o.workersTarget } : {}) });

const audit = (round: number, verdict: 'PASS' | 'FAIL') => `<!-- hx-audit -->\n**hx audit ${round}/3: ${verdict === 'PASS' ? 'PASS ✓' : 'FAIL ✗'}** (PR #9)\n\nfindings`;
const stop = (reason: string) => `**hx:** impl stopped — ${reason} (2 turns).\n\nLast reply:\n\n> x`;
const retry = (why: string) => `<!-- hx-retry -->\n**hx:** ${why} — back to the implementer, round 2/3 (PR #9)`;
const issue = (number: number, o: Partial<CompareIssue> = {}): CompareIssue =>
  ({ number, state: 'OPEN', createdAt: B(100), labels: [], author: 'me', comments: [], ...o });
const OPTS = { at: Date.parse(AT), trusted: new Set(['me']), labels: { prd: 'prd', gateFix: 'hx-gate-fix' } };

test('parseTime: ISO and local "YYYY-MM-DD HH:MM"; anything else is undefined', E2E, () => {
  assert.equal(parseTime('2026-11-04T09:00:00Z'), Date.parse('2026-11-04T09:00:00Z'));
  assert.equal(parseTime('2026-11-04T09:00+07:00'), Date.parse('2026-11-04T02:00:00Z'));
  assert.equal(parseTime('2026-11-04 09:30'), new Date(2026, 10, 4, 9, 30).getTime());
  assert.equal(parseTime('2024-02-29'), Date.parse('2024-02-29'));
  assert.equal(parseTime('2026-12-31T23:59:59.5Z'), Date.parse('2026-12-31T23:59:59.5Z'));
  // impossible ISO dates must not roll into the next month
  for (const bad of ['2026-02-30', '2026-02-29', '2026-11-31', '2026-04-31T10:00Z', '2026-00-10', '2026-11-00', '2026-11-04T24:00Z', '2026-11-04T09:60Z', '2026-11-04T09:00:60Z', '2026-11-04T09:00+25:00']) assert.equal(parseTime(bad), undefined, bad);
  for (const bad of ['yesterday', '2026-13-04 09:00', '2026-11-04 25:00', '04/11/2026', '', '1730707200']) assert.equal(parseTime(bad), undefined, bad);
});

test('stopCause: timed out, not mergeable or conflict, out of audit rounds, other', E2E, () => {
  assert.equal(stopCause(stop('agent error: turn timed out after 60 min')), 'timedOut');
  assert.equal(stopCause(stop('agent error: stalled: no output for 20 min')), 'timedOut');
  assert.equal(stopCause(stop('merging the audited PR failed: Pull request is not mergeable')), 'conflict');
  assert.equal(stopCause(stop('still not passing after 3 audit round(s); last findings: a conflict')), 'auditRounds');
  assert.equal(stopCause(stop('still not merging after 3 merge round(s) (audit 1/3 passed); last: x')), 'conflict');
  assert.equal(stopCause(stop('no completion after 20 turns')), 'other');
});

test('change: counts as a difference, shares in points, the rest in percent; unknown is -', E2E, () => {
  assert.equal(change(10, 7, 'count'), '-3');
  assert.equal(change(3, 5, 'count'), '+2');
  assert.equal(change(100, 112, 'pct'), '+12%');
  assert.equal(change(100, 97, 'pct'), '-3%');
  assert.equal(change(0.1, 0.05, 'share'), '-5.0pp');
  assert.equal(change(undefined, 5, 'pct'), '-');
  assert.equal(change(0, 5, 'pct'), '-');
});

test('compare: per-role sessions and medians in the period each session started; no testMs is left out, not 0', E2E, () => {
  const recs = [
    // before: two impl sessions (one over two turns), one failed review
    rec(B(5), 'impl', 's1', { durationMs: 10 * M, testMs: 4 * M, tokens: 1000, output: 100, cost: 2 }),
    rec(B(4), 'impl', 's1', { durationMs: 10 * M, testMs: 2 * M, tokens: 1000, output: 100, cost: 2 }),
    rec(B(3), 'impl', 's2', { durationMs: 30 * M, tokens: 500, output: 50, cost: 1 }), // no testMs: not in "outside tests"
    rec(B(2), 'review', 's3', { ok: false, durationMs: 5 * M }),
    rec(B(0.1), 'impl', 's4', { durationMs: 1 * M, testMs: 0 }), // starts before, ends after: before
    rec(A(0.1), 'impl', 's4', { durationMs: 1 * M, testMs: 0 }),
    // checkpoint resumes s1 under its own role
    rec(B(1), 'checkpoint', 's1', { durationMs: 1 * M }),
    // after: one impl session
    rec(A(1), 'impl', 's5', { durationMs: 8 * M, testMs: 1 * M, tokens: 2000, output: 300, cost: 3 }),
  ];
  const { before, after } = compare(recs as any, [], OPTS);
  const role = (p: typeof before, r: string) => p.roles.find((x) => x.role === r)!;
  assert.deepEqual(before.roles.map((r) => r.role), ['checkpoint', 'impl', 'review']);
  const bi = role(before, 'impl');
  assert.equal(bi.sessions, 3);
  assert.equal(bi.medianDurationMs, 20 * M); // 20m, 30m, 2m
  assert.equal(bi.medianOutsideTestsMs, 2 * M); // s1: 20m - 6m = 14m, s4: 2m; s2 has no testMs
  assert.equal(bi.medianTokens, 550); // s1 2200, s2 550, s4 220
  assert.equal(bi.medianOutput, 50); // 200, 50, 20
  assert.equal(bi.costPerSession, (4 + 1 + 2) / 3);
  assert.equal(bi.failed, 0);
  assert.equal(role(before, 'review').failed, 1);
  assert.equal(role(before, 'review').medianOutsideTestsMs, undefined);
  const ai = role(after, 'impl');
  assert.equal(ai.sessions, 1);
  assert.equal(ai.medianOutsideTestsMs, 7 * M);
  assert.equal(ai.costPerSession, 3);
  // only records without testMs: unknown, never 0
  const { after: only } = compare([rec(A(1), 'impl', 'x', { durationMs: 5 * M })] as any, [], OPTS);
  assert.equal(only.roles[0].medianOutsideTestsMs, undefined);
});

test('compare: audits, first-round FAILs, closed issues, gate-fix, stops, retries and per-closed cost land in the right period; a person\'s comment is ignored', E2E, () => {
  const recs = [rec(B(2), 'impl', 'b1', { tokens: 1000, output: 0, cost: 4, durationMs: 60 * M }), rec(A(2), 'impl', 'a1', { tokens: 3000, output: 0, cost: 6, durationMs: 30 * M }),
    rec(A(2.25), 'impl', 'a2', { tokens: 0, output: 0, cost: 0, durationMs: 30 * M })]; // overlaps a1 by 15m
  const c = (body: string, at: string, author = 'me') => ({ author, body, createdAt: at });
  const issues: CompareIssue[] = [
    issue(1, { state: 'CLOSED', closedAt: B(1), comments: [c(audit(1, 'FAIL'), B(3)), c(audit(2, 'PASS'), B(2)),
      c(retry('merge after audit failed (tests fail after the rebase)'), B(2.5)), c(retry('audit failed'), B(2.6)),
      c('**hx audit 1/3: FAIL ✗** — a person quoting it, no marker', B(2)), c('looks good to me', B(2))] }),
    issue(2, { state: 'CLOSED', closedAt: A(1), comments: [c(audit(1, 'PASS'), A(0.5)), c(audit(1, 'FAIL'), A(0.6), 'stranger'),
      c(stop('agent error: turn timed out after 60 min'), A(0.7)), c(stop('merging the audited PR failed: conflict'), A(0.8)),
      c(stop('still not passing after 3 audit round(s); last findings: x'), B(0.5)), c(stop('no completion after 9 turns'), A(0.9)),
      c(retry('merge after audit failed (tests fail after the rebase)'), A(0.4)), c(retry('merge after audit failed (tests fail after the rebase)'), A(0.45))] }),
    issue(3, { state: 'CLOSED', closedAt: A(2), labels: ['prd'] }), // a PRD: not an issue closed
    issue(4, { state: 'CLOSED', closedAt: A(2), stateReason: 'NOT_PLANNED' }), // not done
    issue(5, { state: 'CLOSED', closedAt: A(3), author: 'stranger' }), // untrusted
    issue(6, { labels: ['hx-gate-fix'], createdAt: A(1) }),
    issue(7, { labels: ['hx-gate-fix'], createdAt: B(1), state: 'CLOSED', closedAt: A(0.2) }),
  ];
  const { before, after } = compare(recs as any, issues, OPTS);
  assert.deepEqual([before.auditPass, before.auditFail, before.firstRoundFails, before.failShare], [1, 1, 1, 0.5]);
  assert.deepEqual([after.auditPass, after.auditFail, after.firstRoundFails, after.failShare], [1, 0, 0, 0]);
  assert.deepEqual([before.closed, after.closed], [1, 2]); // #1 before; #2 and the gate-fix #7 after
  assert.deepEqual([before.gateFixOpened, after.gateFixOpened], [1, 1]);
  assert.deepEqual(before.stops, { timedOut: 0, conflict: 0, auditRounds: 1, other: 0 });
  assert.deepEqual(after.stops, { timedOut: 1, conflict: 1, auditRounds: 0, other: 1 });
  assert.deepEqual([before.rebaseTestRetries, after.rebaseTestRetries], [1, 2]);
  assert.equal(before.tokensPerClosed, 1000);
  assert.equal(before.costPerClosed, 4);
  assert.equal(after.tokensPerClosed, 1500);
  assert.equal(after.costPerClosed, 3);
  assert.equal(before.hours, 1);
  assert.equal(after.hours, 0.75); // 30m + 30m overlapping by 15m
  assert.ok(before.smallSample && after.smallSample);
  const many = Array.from({ length: 10 }, (_, k) => issue(100 + k, { state: 'CLOSED', closedAt: A(1) }));
  assert.equal(compare([], many, OPTS).after.smallSample, false);
});

test('compare: median target workers per period, per turn, from workersTarget; records without it skipped; a session counts where it started (#322)', E2E, () => {
  const recs = [
    rec(B(5), 'impl', 's1', { workersTarget: 3 }),
    rec(B(4), 'impl', 's1', { workersTarget: 3 }),
    rec(B(3), 'review', 's2', { workersTarget: 1 }),
    rec(B(2), 'impl', 's3'), // an older record without workersTarget: skipped, not 0
    rec(B(0.1), 'impl', 's4', { workersTarget: 2 }), // s4 starts before the split: both its turns count before
    rec(A(0.1), 'impl', 's4', { workersTarget: 1 }),
    rec(A(1), 'impl', 's5', { workersTarget: Number.NaN }), // not finite: skipped
    rec(A(2), 'impl', 's6', { workersTarget: 4 }),
  ];
  const { before, after } = compare(recs as any, [], OPTS);
  assert.equal(before.medianWorkersTarget, 2); // 3, 3, 1, 2, 1 → 2
  assert.equal(after.medianWorkersTarget, 4); // only s6's record
  // a period with no record that has it: undefined
  const none = compare([rec(B(1), 'impl', 'x'), rec(A(1), 'impl', 'y', { workersTarget: 3 })] as any, [], OPTS);
  assert.equal(none.before.medianWorkersTarget, undefined);
  assert.equal(none.after.medianWorkersTarget, 3);
  assert.equal(compare([], [], OPTS).after.medianWorkersTarget, undefined);
});

test('compare --from: older runs, comments and issues are dropped', E2E, () => {
  const from = Date.parse(B(10));
  const recs = [rec(B(20), 'impl', 'old'), rec(B(5), 'impl', 'new')];
  const issues = [issue(1, { state: 'CLOSED', closedAt: B(15), comments: [{ author: 'me', body: audit(1, 'FAIL'), createdAt: B(15) }] }),
    issue(2, { state: 'CLOSED', closedAt: B(5) })];
  const { before } = compare(recs as any, issues, { ...OPTS, from });
  assert.equal(before.roles[0].sessions, 1);
  assert.equal(before.closed, 1);
  assert.equal(before.auditFail, 0);
  assert.equal(before.from, from);
});

test('compare: quality-bar rounds won and lost per period; an untrusted marker and a no-verdict round count as neither', E2E, () => {
  const c = (body: string, at: string, author = 'me') => ({ author, body, createdAt: at });
  const issues: CompareIssue[] = [
    issue(1, { labels: ['prd'], comments: [c(barMarker(1, 'lost', 'slow invoices', { rounds: 3, issue: 9 }), B(3)), c(barMarker(2, 'won', 'clear totals', { rounds: 3 }), B(1)),
      c(barMarker(3, 'won', 'forged', { rounds: 3 }), A(1), 'stranger'), c(barMarker(3, 'no verdict', 'no valid judge reply', { rounds: 3 }), A(2))] }),
    issue(2, { labels: ['prd'], comments: [c(barMarker(1, 'lost', 'a', { rounds: 3, issue: 10 }), A(1)), c(barMarker(2, 'lost', 'b', { rounds: 3, issue: 11 }), A(3)),
      c('<!-- hx-bar round=3 -->\nnot a round comment', A(4))] }),
  ];
  const recs = [rec(B(2), 'bar', 'run1'), rec(B(1.5), 'bar', 'judge1')];
  const { before, after } = compare(recs as any, issues, OPTS);
  assert.deepEqual([before.barWon, before.barLost], [1, 1]);
  assert.deepEqual([after.barWon, after.barLost], [0, 2]);
  assert.deepEqual(before.roles.map((r) => [r.role, r.sessions]), [['bar', 2]], 'the run and the judge both under bar');
});

test('compare: needs-human questions asked and answered per period; untrusted questions and answers and hx comments do not count', E2E, () => {
  const c = (body: string, at: string, author = 'me') => ({ author, body, createdAt: at });
  const Q = '<!-- hx-question -->\n**Hx needs your answer:** local or cloud?';
  const issues: CompareIssue[] = [
    // a [needs you] issue (decompose): asked when filed, answered by the owner after the split
    issue(1, { createdAt: B(5), body: Q, comments: [c('A', A(1))] }),
    // impl questions: one answered before the next is asked; the second answered after the split
    issue(2, { comments: [c(Q, B(4)), c('<!-- hx-audit -->\n**hx audit 1/3: PASS ✓**', B(3.5)), c('B', B(3)), c(Q, B(2)), c('the second', A(2))] }),
    // a stranger's answer does not count; hx's own <!-- hx- comment is not an answer
    issue(3, { comments: [c(Q, A(1)), c('A', A(2), 'stranger'), c('<!-- hx-retry -->\nback', A(3))] }),
    // a stranger's question comment and a stranger's [needs you] issue are not questions
    issue(4, { comments: [c(Q, A(1), 'stranger'), c('A', A(2))] }),
    issue(5, { author: 'stranger', createdAt: A(1), body: Q, comments: [c('A', A(2))] }),
    // a body that only mentions the marker later is not a question
    issue(6, { body: 'see <!-- hx-question --> below', comments: [c('ok', A(1))] }),
  ];
  const { before, after } = compare([], issues, OPTS);
  assert.deepEqual([before.questionsAsked, before.questionsAnswered], [3, 1]);
  assert.deepEqual([after.questionsAsked, after.questionsAnswered], [1, 2]);
});

test('compare: a [needs you] question followed only by an hx cap comment is asked, not answered (#332)', E2E, () => {
  const c = (body: string, at: string, author = 'me') => ({ author, body, createdAt: at });
  const Q = '<!-- hx-question -->\n**Hx needs your answer:** keep scores?';
  const issues: CompareIssue[] = [
    issue(1, { createdAt: A(1), body: Q, comments: [c('**hx:** too many open questions; the agent takes the recommended choice', A(1.5))] }),
    issue(2, { createdAt: A(1), body: Q, comments: [c('**hx:** too many open questions; the next session takes the recommended choice', A(1.5))] }),
    // the owner answers after the cap comment: answered
    issue(3, { createdAt: A(1), body: Q, comments: [c('**hx:** too many open questions; the agent takes the recommended choice', A(1.5)), c('B', A(2))] }),
  ];
  const { after } = compare([], issues, OPTS);
  assert.deepEqual([after.questionsAsked, after.questionsAnswered], [3, 1]);
});

function app(name: string, recs: any[], board: any) {
  const root = path.join(tmp, name), sd = path.join(root, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  if (recs.length) writeFileSync(path.join(sd, 'usage.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const b = path.join(tmp, `board-${name}.json`), log = path.join(tmp, `log-${name}.txt`);
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], ...board }));
  writeFileSync(log, '');
  const hx = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b, HX_FAKE_GH_LOG: log } });
  return { hx, calls: () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('api graphql')) };
}
const cells = (out: string, label: string) => out.split(/\r?\n/).find((l) => l.trim().startsWith(label))?.trim().slice(label.length).trim().split(/\s+/) ?? [];

test('hx usage --compare: pages through every issue, prints both periods with the change and the small-sample note', E2E, () => {
  // 7 closed issues, 3 per page: three GraphQL pages; the last issue (on page 3) is the only one with a FAIL audit
  const issues = Array.from({ length: 7 }, (_, k) => ({ number: k + 1, title: 't', body: '', state: 'CLOSED', labels: [],
    createdAt: B(50), closedAt: k < 4 ? B(1) : A(1), stateReason: 'COMPLETED' }));
  const comments = [{ issue: 7, body: audit(1, 'FAIL'), createdAt: A(0.5) }, { issue: 7, body: audit(2, 'PASS'), createdAt: A(0.7) },
    { issue: 1, body: audit(1, 'PASS'), createdAt: B(2) }, { issue: 1, body: audit(1, 'FAIL'), createdAt: B(2), author: 'someone' }];
  const { hx, calls } = app('cli', [rec(B(2), 'impl', 'b', { durationMs: 10 * M, cost: 2 }), rec(A(2), 'impl', 'a', { durationMs: 12 * M, cost: 1 })],
    { issues, comments, graphqlPage: 3 });
  const r = hx('usage', '--compare', AT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout;
  assert.equal(calls().length, 3, 'one GraphQL call per page of issues');
  assert.deepEqual(cells(out, 'issues closed'), ['4', '3', '-1'], out);
  assert.deepEqual(cells(out, 'audits FAIL'), ['0', '1', '+1'], out);
  assert.deepEqual(cells(out, 'first-round FAILs'), ['0', '1', '+1'], out);
  assert.equal(cells(out, 'median duration')[2], '+20%', out);
  assert.deepEqual(cells(out, 'cost/session'), ['$2.00', '$1.00', '-50%'], out);
  assert.match(out, /before .* h of runs/);
  assert.match(out, /note: 4 closed issue\(s\) before the change .* small sample/);
  assert.match(out, /note: 3 closed issue\(s\) after the change .* small sample/);
});

test('hx usage --compare prints bar rounds won and lost; hx usage --by role lists bar', E2E, () => {
  const comments = [{ issue: 1, body: barMarker(1, 'lost', 'slow', { rounds: 3, issue: 2 }), createdAt: B(1) },
    { issue: 1, body: barMarker(2, 'won', 'fine', { rounds: 3 }), createdAt: A(1) },
    { issue: 1, body: barMarker(3, 'won', 'forged', { rounds: 3 }), createdAt: A(1), author: 'someone' }];
  const { hx } = app('bar', [rec(B(2), 'bar', 'b', { tokens: 4321 }), rec(A(2), 'impl', 'a')],
    { issues: [{ number: 1, title: 'p', body: '', state: 'OPEN', labels: ['prd'], createdAt: B(50) }], comments });
  const r = hx('usage', '--compare', AT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cells(r.stdout, 'bar rounds won'), ['0', '1', '+1'], r.stdout);
  assert.deepEqual(cells(r.stdout, 'bar rounds lost'), ['1', '0', '-1'], r.stdout);
  const u = hx('usage', '--by', 'role');
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.match(u.stdout, /^\s*bar\b/m, u.stdout);
});

test('hx usage --compare prints questions asked and answered from the issue bodies and comments', E2E, () => {
  const Q = '<!-- hx-question -->\n**Hx needs your answer:** which?';
  const comments = [{ issue: 2, body: Q, createdAt: B(2) }, { issue: 2, body: 'A', createdAt: A(1) }, { issue: 1, body: 'B', createdAt: A(2) }];
  const { hx } = app('questions', [], { issues: [{ number: 1, title: '[needs you] which?', body: Q, state: 'OPEN', labels: ['needs-human'], createdAt: A(0.5) },
    { number: 2, title: 't', body: '', state: 'OPEN', labels: [], createdAt: B(50) }], comments });
  const r = hx('usage', '--compare', AT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cells(r.stdout, 'questions asked'), ['1', '1', '0'], r.stdout);
  assert.deepEqual(cells(r.stdout, 'questions answered'), ['0', '2', '+2'], r.stdout);
});

test('hx usage --compare prints the median target workers after hours of runs; - for a period without workersTarget (#322)', E2E, () => {
  const { hx } = app('target', [rec(B(3), 'impl', 'b1', { workersTarget: 3 }), rec(B(2), 'impl', 'b2', { workersTarget: 3 }), rec(B(1), 'impl', 'b3', { workersTarget: 1 }),
    rec(A(1), 'impl', 'a1', { workersTarget: 2 })], {});
  const r = hx('usage', '--compare', AT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cells(r.stdout, 'median target workers'), ['3', '2', '-1'], r.stdout);
  const board = r.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s{2,}/)[0]);
  assert.equal(board.indexOf('median target workers'), board.indexOf('hours of runs') + 1, r.stdout);
  const old = app('target-old', [rec(B(2), 'impl', 'b'), rec(A(2), 'impl', 'a', { workersTarget: 2 })], {}).hx('usage', '--compare', AT);
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.deepEqual(cells(old.stdout, 'median target workers'), ['-', '2', '-'], old.stdout);
});

test('hx usage --compare: no small-sample note with 10 or more closed issues in each period', E2E, () => {
  const issues = Array.from({ length: 20 }, (_, k) => ({ number: k + 1, title: 't', body: '', state: 'CLOSED', labels: [], createdAt: B(50), closedAt: k < 10 ? B(1) : A(1) }));
  const { hx } = app('big', [], { issues });
  const r = hx('usage', '--compare', '2026-11-04T00:00:00Z');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /small sample/);
});

test('hx usage --compare: a bad time exits 1 with a clear message, before any GitHub call', E2E, () => {
  const { hx, calls } = app('bad', [], {});
  for (const args of [['--compare', 'last tuesday'], ['--compare', '2026-11-04 25:00'], ['--compare', '2026-02-30'], ['--compare', '2026-04-31T10:00Z'], ['--compare', AT, '--from', '2026-11-31'], ['--compare', AT, '--from', 'soon'], ['--compare', AT, '--from', A(1)]]) {
    const r = hx('usage', ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /is not a time|--from must be before --compare/, r.stderr);
  }
  assert.match(hx('usage', '--compare', 'nope').stderr, /--compare "nope" is not a time — use an ISO time/);
  assert.equal(calls().length, 0);
});

test('hx help and the README name --compare', E2E, () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /usage --compare <time>/);
  const readme = docsText();
  assert.ok(readme.includes('**Did a change help?**') && readme.includes('hx usage --compare'));
});
