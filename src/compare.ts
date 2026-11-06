import { BAR_MARKER_PREFIX, parseBarMarker } from './bar.ts';
import { AUDIT_MARKER, RETRY_MARKER } from './pool.ts';
import { findAnswer, QUESTION_MARKER } from './question.ts';
import { median } from './timing.ts';
import { totalTokens, type UsageRecord } from './usage.ts';

/** `hx usage --compare`: the runs before and after a time, from usage.jsonl and hx's own markers on GitHub. Pure. */

export interface CompareComment { author: string; body: string; createdAt: string }
export interface CompareIssue {
  number: number;
  state: 'OPEN' | 'CLOSED';
  stateReason?: string | null;
  createdAt: string;
  body?: string; // a `[needs you]` issue's question starts it
  closedAt?: string | null;
  labels: string[];
  author: string; // '' = a deleted account
  comments: CompareComment[];
}

export interface RoleStats {
  role: string;
  sessions: number;
  medianDurationMs?: number;
  medianOutsideTestsMs?: number; // over the sessions with a record that has testMs; undefined when none has
  medianTokens?: number;
  medianOutput?: number;
  costPerSession?: number;
  failed: number; // sessions whose last turn was not ok
}

export interface Stops { timedOut: number; conflict: number; auditRounds: number; other: number }

export interface Period {
  from?: number; // ms epoch; undefined = since the first run
  to?: number; // undefined = now
  hours: number; // the union of the turns' run time
  medianWorkersTarget?: number; // per turn over the records with workersTarget (autoWorkers, #322); undefined when none has it
  roles: RoleStats[];
  auditPass: number;
  auditFail: number;
  failShare?: number; // 0..1; undefined without an audit
  firstRoundFails: number;
  barWon: number; // quality-bar rounds, from hx's `<!-- hx-bar round=N -->` comments; `no verdict` is neither
  barLost: number;
  questionsAsked: number; // needs-human questions (a trusted `<!-- hx-question -->` comment or issue body), by when asked
  questionsAnswered: number; // those with the owner's answer (question.ts findAnswer), by when answered
  closed: number; // issues closed as completed, PRDs left out
  gateFixOpened: number;
  tokens: number;
  costUsd: number;
  tokensPerClosed?: number;
  costPerClosed?: number;
  stops: Stops;
  rebaseTestRetries: number;
  smallSample: boolean; // fewer than SMALL_SAMPLE closed issues
}

export const SMALL_SAMPLE = 10;
export const STOP_PREFIX = '**hx:** impl stopped';

export interface CompareOptions {
  at: number; // the split, ms epoch
  from?: number; // drop everything older
  trusted: Set<string>; // lowercased logins: hx's own comments come from these
  labels: { prd: string; gateFix: string };
}

/** `--compare` / `--from`: an ISO time or local "YYYY-MM-DD HH:MM", as ms epoch; undefined when it is neither. */
export function parseTime(s: string): number | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s.trim());
  if (local) {
    const [y, mo, d, h, mi] = local.slice(1).map(Number);
    const t = new Date(y, mo - 1, d, h, mi);
    return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d && t.getHours() === h && t.getMinutes() === mi ? t.getTime() : undefined;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):?(\d{2}))?)?$/i.exec(s.trim());
  if (!iso) return undefined;
  // Date.parse rolls an impossible date into the next month (2026-02-30 → 03-02): check every field first
  const [y, mo, d, h, mi, sec, , oh, om] = iso.slice(1).map((v) => Number(v ?? 0));
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return undefined;
  if (h > 23 || mi > 59 || sec > 59 || oh > 23 || om > 59) return undefined;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : undefined;
}

/** Why an impl stopped, from the reason on the first line of hx's stop comment. */
export function stopCause(body: string): keyof Stops {
  const line = body.split('\n')[0];
  if (/still not passing after \d+ audit round/i.test(line)) return 'auditRounds';
  if (/mergeable|conflict|merging the audited PR failed|still not merging after/i.test(line)) return 'conflict';
  if (/timed out|stalled/i.test(line)) return 'timedOut';
  return 'other';
}

const isHx = (body: string, marker: string) => body.trimStart().startsWith(marker);

export function compare(recs: UsageRecord[], issues: CompareIssue[], o: CompareOptions): { before: Period; after: Period } {
  const period = (t: number) => (o.from !== undefined && t < o.from) || !Number.isFinite(t) ? undefined : t < o.at ? 0 : 1;
  const ps: Period[] = [0, 1].map((k) => ({
    ...(k === 0 ? (o.from !== undefined ? { from: o.from } : {}) : { from: o.at }), ...(k === 0 ? { to: o.at } : {}),
    hours: 0, roles: [], auditPass: 0, auditFail: 0, firstRoundFails: 0, barWon: 0, barLost: 0, questionsAsked: 0, questionsAnswered: 0, closed: 0, gateFixOpened: 0, tokens: 0, costUsd: 0,
    stops: { timedOut: 0, conflict: 0, auditRounds: 0, other: 0 }, rebaseTestRetries: 0, smallSample: true,
  }));

  // sessions (a checkpoint resumes its session under its own role): a session belongs to the period it started in
  const sessions = new Map<string, UsageRecord[]>();
  for (const r of recs) {
    const k = `${r.role ?? 'impl'}\0${r.sessionId}`;
    sessions.set(k, [...(sessions.get(k) ?? []), r]);
  }
  const byPeriod: Map<string, UsageRecord[][]>[] = [new Map(), new Map()];
  for (const rs of sessions.values()) {
    rs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const k = period(Date.parse(rs[0].ts));
    if (k === undefined) continue;
    const role = rs[0].role ?? 'impl';
    byPeriod[k].set(role, [...(byPeriod[k].get(role) ?? []), rs]);
  }
  byPeriod.forEach((roles, k) => {
    const p = ps[k];
    const spans: [number, number][] = [];
    for (const [role, ss] of [...roles].sort(([a], [b]) => a.localeCompare(b))) {
      const sum = (rs: UsageRecord[], f: (r: UsageRecord) => number) => rs.reduce((s, r) => s + (f(r) || 0), 0);
      const outside = ss.map((rs) => rs.filter((r) => typeof r.testMs === 'number' && Number.isFinite(r.testMs)))
        .filter((rs) => rs.length).map((rs) => sum(rs, (r) => r.durationMs - r.testMs!));
      const cost = ss.reduce((s, rs) => s + sum(rs, (r) => r.costUsd), 0);
      p.roles.push({ role, sessions: ss.length, medianDurationMs: median(ss.map((rs) => sum(rs, (r) => r.durationMs))),
        medianOutsideTestsMs: median(outside), medianTokens: median(ss.map((rs) => sum(rs, (r) => totalTokens(r.usage)))),
        medianOutput: median(ss.map((rs) => sum(rs, (r) => r.usage.output))), costPerSession: cost / ss.length,
        failed: ss.filter((rs) => rs.at(-1)!.ok === false).length });
      p.costUsd += cost;
      for (const rs of ss) for (const r of rs) {
        p.tokens += totalTokens(r.usage);
        const end = Date.parse(r.ts);
        spans.push([end - (r.durationMs || 0), end]);
      }
    }
    // hours of runs: the union of the turns' spans, so parallel sessions are not counted twice
    let ms = 0, cur: [number, number] | undefined;
    for (const s of spans.sort((a, b) => a[0] - b[0])) {
      if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
      else { if (cur) ms += cur[1] - cur[0]; cur = [...s]; }
    }
    if (cur) ms += cur[1] - cur[0];
    p.hours = ms / 3_600_000;
    // the run's worker target when each turn was recorded: older records without it are skipped
    const targets = [...roles.values()].flat(2).map((r) => r.workersTarget).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    const mt = median(targets);
    if (mt !== undefined) p.medianWorkersTarget = mt;
  });

  const trusted = (login: string) => !!login && o.trusted.has(login.toLowerCase());
  for (const i of issues) {
    if (!trusted(i.author)) continue;
    if (i.labels.includes(o.labels.gateFix)) { const k = period(Date.parse(i.createdAt)); if (k !== undefined) ps[k].gateFixOpened++; }
    if (i.state === 'CLOSED' && i.closedAt && !i.labels.includes(o.labels.prd) && i.stateReason !== 'NOT_PLANNED') {
      const k = period(Date.parse(i.closedAt));
      if (k !== undefined) ps[k].closed++;
    }
    for (const c of i.comments) {
      if (!trusted(c.author)) continue;
      const k = period(Date.parse(c.createdAt));
      if (k === undefined) continue;
      const p = ps[k];
      if (isHx(c.body, AUDIT_MARKER)) {
        const v = /\*\*hx audit (\d+)\/\d+: (PASS|FAIL)/.exec(c.body);
        if (!v) continue;
        if (v[2] === 'PASS') p.auditPass++;
        else { p.auditFail++; if (v[1] === '1') p.firstRoundFails++; }
      } else if (isHx(c.body, BAR_MARKER_PREFIX)) {
        const r = parseBarMarker(c.body)?.result;
        if (r === 'won') p.barWon++;
        else if (r === 'lost') p.barLost++;
      } else if (isHx(c.body, STOP_PREFIX)) p.stops[stopCause(c.body)]++;
      else if (isHx(c.body, RETRY_MARKER) && /tests fail after the rebase/.test(c.body)) p.rebaseTestRetries++;
    }
    // needs-human: every question, each with its own answer (one asked before a later question counts too)
    const own = i.comments.filter((c) => trusted(c.author));
    const questions = [...(isHx(i.body ?? '', QUESTION_MARKER) ? [{ text: '', createdAt: i.createdAt }] : []),
      ...own.filter((c) => isHx(c.body, QUESTION_MARKER)).map((c) => ({ text: '', createdAt: c.createdAt }))];
    for (const q of questions) {
      const k = period(Date.parse(q.createdAt));
      if (k !== undefined) ps[k].questionsAsked++;
      const a = findAnswer(q, own, o.trusted);
      const ka = a ? period(Date.parse(a.createdAt)) : undefined;
      if (ka !== undefined) ps[ka].questionsAnswered++;
    }
  }
  for (const p of ps) {
    const audits = p.auditPass + p.auditFail;
    if (audits) p.failShare = p.auditFail / audits;
    if (p.closed) { p.tokensPerClosed = p.tokens / p.closed; p.costPerClosed = p.costUsd / p.closed; }
    p.smallSample = p.closed < SMALL_SAMPLE;
  }
  return { before: ps[0], after: ps[1] };
}

/** The change from before to after: a count as a signed difference (`-3`), a share in points (`+2.0pp`), anything else in percent (`+12%`). */
export function change(before: number | undefined, after: number | undefined, kind: 'count' | 'pct' | 'share'): string {
  if (before === undefined || after === undefined) return '-';
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '±');
  if (kind === 'count') { const d = after - before; return d === 0 ? '0' : `${sign(d)}${Math.abs(d)}`; }
  if (kind === 'share') { const d = (after - before) * 100; return `${sign(Math.round(d * 10))}${Math.abs(d).toFixed(1)}pp`; }
  if (before === 0) return after === 0 ? '0%' : '-';
  const d = Math.round(((after - before) / before) * 100);
  return d === 0 ? '0%' : `${sign(d)}${Math.abs(d)}%`;
}
