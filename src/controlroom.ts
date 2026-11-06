// The control-room data of hx dashboard (PRD #367): run.log lines read as claims, stages, today's events, the timeline and the issue states. Pure: no I/O, no clock.
import { localDay } from './usage.ts';
import type { Plan, Ref } from './state.ts';

/** One run.log line: its ISO time, its issue (null for a runner line) and its message. */
export interface LogLine { t: string; issue: number | null; msg: string }

// `<ISO> [#<n>] <msg>` or `<ISO> <msg>`, as src/outcomes.ts reads them; any other line is skipped
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:\[#(\d+)\] )?(.*)$/;

export function parseLine(line: string): LogLine | null {
  const m = LINE.exec(line);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { t: m[1], issue: m[2] === undefined ? null : Number(m[2]), msg: m[3] };
}

export const parseLines = (lines: string[]): LogLine[] => lines.map(parseLine).filter((l): l is LogLine => l !== null);

// the claim log call in work() (src/pool.ts): `impl: <title>`, `decompose: <title>`, `<kind> (round <r>): <title>`
const CLAIM_PLAIN = /^(impl|decompose): (.*)$/;
const CLAIM_ROUND = /^(gauntlet|review|security|triage|bar) \(round ([1-9]\d*)\): (.*)$/;

export interface Claim { kind: string; round: number | null; title: string }

/** The claim a line records, by its exact shape only; null for every other line (`triage: …` / `bar: …` with no round are results). */
export function claimOf(l: LogLine): Claim | null {
  if (l.issue === null) return null;
  let m = CLAIM_PLAIN.exec(l.msg);
  if (m) return { kind: m[1], round: null, title: m[2] };
  m = CLAIM_ROUND.exec(l.msg);
  return m ? { kind: m[1], round: Number(m[2]), title: m[3] } : null;
}

export const isClaimLine = (l: LogLine) => claimOf(l) !== null;

/** An issue's current claim: its lines from its latest claim line on; empty when it has none. */
export function currentClaim(lines: LogLine[], issue: number): LogLine[] {
  const own = lines.filter((l) => l.issue === issue);
  let from = -1;
  for (let i = own.length - 1; i >= 0; i--) if (isClaimLine(own[i])) { from = i; break; }
  return from < 0 ? [] : own.slice(from);
}

export type ImplStage = 'impl' | 'audit' | 'merge';

/** The stage of a live impl session: the latest audit / merge / back-to-the-implementer line after its claim wins. */
export function implStage(lines: LogLine[], issue: number): ImplStage {
  let stage: ImplStage = 'impl';
  for (const { msg } of currentClaim(lines, issue).slice(1)) {
    if (/^audit \d+\/\d+: PR #\d+/.test(msg)) stage = 'audit';
    else if (msg.startsWith('audit PASS ✓') || /merging held PR #\d+/.test(msg)) stage = 'merge';
    else if (msg.startsWith('audit FAIL ✗') || msg.includes('back to the implementer')) stage = 'impl';
  }
  return stage;
}

export type EventKind = 'result' | 'problem' | 'info';
export interface Event { t: string; issue: number | null; step: string; text: string; tokens: number | null; kind: EventKind }

const TOKENS = /(\d+(?:\.\d+)?)([KMB]?) tokens\b/;
const SCALE: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9 };

/** The first `<x>[K|M] tokens` in a message as a number (`2.5M` → 2500000), else null. */
export function tokensIn(msg: string): number | null {
  const m = TOKENS.exec(msg);
  return m ? Math.round(Number(m[1]) * SCALE[m[2]]) : null;
}

/** The message without a trailing `(…)` summary that holds a token count. */
export function withoutSummary(msg: string): string {
  const s = msg.trimEnd();
  if (!s.endsWith(')')) return msg;
  let depth = 0, i = s.length - 1;
  for (; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(' && --depth === 0) break;
  }
  if (i < 0 || tokensIn(s.slice(i)) === null) return msg;
  return s.slice(0, i).trimEnd();
}

// the step of a message, by its start (PRD #367, Data → events); first match wins
const STEPS: [string, (m: string) => boolean][] = [
  ['Gate', (m) => m.startsWith('gate')],
  ['Implement', (m) => ['impl', 'checkpoint', 'timed out', 'asked', 'not narrowed'].some((w) => m.startsWith(w))],
  ['Audit', (m) => m.startsWith('audit')],
  ['Merge', (m) => m.startsWith('DONE ✓ audited and merged') || m.startsWith('merge') || m.includes('merging held PR')],
  ['Close', (m) => m.startsWith('DONE ✓ closed without a PR') || m.startsWith('PRD closed')],
  ['Size', (m) => m.startsWith('split') || m.startsWith('size')],
  ['Gauntlet', (m) => ['gauntlet', 'critic', 'revise', 'reviser'].some((w) => m.startsWith(w))],
  ['Decompose', (m) => m.startsWith('decompose')],
  ['Review', (m) => m.startsWith('review')],
  ['Security', (m) => m.startsWith('security')],
  ['Bar', (m) => m.startsWith('bar')],
  ['Triage', (m) => m.startsWith('triage')],
  ['Release', (m) => m.startsWith('released') || m.startsWith('release')],
  ['Start', (m) => m.startsWith('hx pool up') || m.startsWith('self-update: restarted')],
];

export const stepOf = (msg: string): string | null => STEPS.find(([, is]) => is(msg))?.[0] ?? null;

const PROBLEM = ['RED ✗', 'FAIL ✗', 'FAILED', 'GAVE UP', 'timed out', 'conflict', 'error', 'failed', 'crashed', 'STOPPED'];
const RESULT = ['DONE ✓', 'PASS ✓', 'PRD closed ✓', 'gate green ✓'];

/** A line's kind: a claim line is always info (its title is data), else problem / result / info by their words. */
export function kindOf(l: LogLine, blockedLabel: string): EventKind {
  if (isClaimLine(l)) return 'info';
  if (PROBLEM.some((w) => l.msg.includes(w)) || l.msg.includes(`labelled ${blockedLabel}`)) return 'problem';
  if (RESULT.some((w) => l.msg.includes(w))) return 'result';
  return 'info';
}

/** Today's events in log order: lines of the local day `today` (YYYY-MM-DD) with a step, or problems (step Error). */
export function eventsFrom(lines: string[], today: string, blockedLabel: string): Event[] {
  const out: Event[] = [];
  for (const l of parseLines(lines)) {
    if (localDay(l.t) !== today) continue;
    const kind = kindOf(l, blockedLabel);
    const step = stepOf(l.msg) ?? (kind === 'problem' ? 'Error' : null);
    if (step === null) continue;
    out.push({ t: l.t, issue: l.issue, step, text: withoutSummary(l.msg), tokens: tokensIn(l.msg), kind });
  }
  return out;
}

/** One Timeline bar: a session (or a gate run) over [startMs, endMs]; `running` on a live session's bar, `ok` on a gate run's. */
export interface Bar { issue: number | null; role: string; startMs: number; endMs: number; running?: true; ok?: boolean }
export interface Lane { worker: string; bars: Bar[] }
export interface Timeline { from: number; to: number; lanes: Lane[] }

/** What timelineFrom reads of a usage record, a live session and a gate run. */
type UsageRec = { ts: string; issue: number; role?: string; sessionId: string; durationMs?: number };
type Session = { number: number; kind: string; since: string };
type Gate = { ts: string; ok: boolean; durationMs?: number };

export const GATE_LANE = 'gate';

/** The Timeline (PRD #367, Data → timeline): finished and live sessions packed into worker lanes `W1`, `W2`, …, then the
 *  `gate` lane, over the last `hours` before `now`. `lines` are run.log lines (for a live impl session's stage). */
export function timelineFrom(usage: UsageRec[], sessions: Session[], gateRuns: Gate[], lines: string[], now: number, hours = 6): Timeline {
  const from = now - hours * 3_600_000;
  const groups = new Map<string, Bar>();
  for (const r of usage) {
    const role = r.role ?? 'impl', end = Date.parse(r.ts), start = end - (r.durationMs ?? 0);
    if (Number.isNaN(end)) continue;
    const key = JSON.stringify([r.issue, role, r.sessionId]);
    const b = groups.get(key);
    if (!b) groups.set(key, { issue: r.issue, role, startMs: start, endMs: end });
    else { b.startMs = Math.min(b.startMs, start); b.endMs = Math.max(b.endMs, end); }
  }
  const finished = [...groups.values()];
  const parsed = parseLines(lines);
  const live: Bar[] = sessions.map((s) => {
    const since = Date.parse(s.since);
    const ends = finished.filter((b) => b.issue === s.number && b.endMs > since).map((b) => b.endMs);
    const role = s.kind === 'impl' ? implStage(parsed, s.number) : s.kind;
    return { issue: s.number, role, startMs: ends.length ? Math.max(...ends) : since, endMs: now, running: true };
  });
  // the window: bars ending before `from` dropped, bars starting before it clipped; issue 0 (the self-review session) is null
  const inWindow = (b: Bar): Bar[] => (b.endMs < from ? [] : [{ ...b, issue: b.issue || null, startMs: Math.max(b.startMs, from) }]);
  const bars = [...finished, ...live].flatMap(inWindow)
    .sort((a, b) => a.startMs - b.startMs || (a.issue ?? 0) - (b.issue ?? 0) || a.endMs - b.endMs);
  const lanes: Lane[] = [];
  for (const bar of bars) {
    const free = (l: Lane) => l.bars.at(-1)!.endMs <= bar.startMs;
    const lane = lanes.find((l) => free(l) && l.bars.at(-1)!.issue === bar.issue) ?? lanes.find(free);
    if (lane) lane.bars.push(bar);
    else lanes.push({ worker: `W${lanes.length + 1}`, bars: [bar] });
  }
  const gate = gateRuns.flatMap((g) => {
    const end = Date.parse(g.ts);
    return Number.isNaN(end) ? [] : inWindow({ issue: null, role: 'gate', startMs: end - (g.durationMs ?? 0), endMs: end, ok: g.ok });
  });
  lanes.push({ worker: GATE_LANE, bars: gate });
  return { from, to: now, lanes };
}

/** An issue's (or its live session's) worker: the lane of its running bar, else of its latest bar by end time; `—` with none. */
export function workerOf(timeline: Timeline, issue: number): string {
  let best: { worker: string; bar: Bar } | null = null;
  for (const l of timeline.lanes) {
    if (l.worker === GATE_LANE) continue;
    for (const bar of l.bars) {
      if (bar.issue !== issue) continue;
      if (!best || (bar.running && !best.bar.running) || (!!bar.running === !!best.bar.running && bar.endMs > best.bar.endMs)) best = { worker: l.worker, bar };
    }
  }
  return best?.worker ?? '—';
}

/** Tokens as the page shows them: `2.5M` (one decimal from a million), `288K` (whole thousands), else the number. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

/** A duration rounded to the minute: `44 min` under an hour, `1h29m` from an hour. */
export function fmtSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** The page's five statuses (PRD #367, Behaviour → "Page status words and dots"). */
export type Status = 'done' | 'merging' | 'auditing' | 'implementing' | 'waiting';

/** One issue or PRD in the control room. `prd` is the item's own number for a PRD, else its parent PRD (null when none);
 *  `board` is its board or PRD row's status (null when none) and `held` its held merge, kept for "what next". */
export interface Item {
  number: number; prd: number | null; title: string; group: string; status: Status; word: string; stage: ImplStage | null;
  since: string | null; waitsOn: string[]; worker: string; tokens: string; time: string; round: string; pr: string;
  steps: { name: string; state: 'done' | 'now' | 'next'; note: string }[]; facts: [string, string][]; next: string;
  board: string | null; held: boolean; closedAt: string | null;
}
export interface Group { key: string; title: string; progress: string }

/** What issueStates reads of the board plan and of a live session. */
type PlanPart = Pick<Plan, 'prds' | 'board' | 'parents'>;
type LiveSession = { number: number; kind: string; since: string; title?: string };
type Step = Item['steps'][number];

const PRD_KINDS: Record<string, string> = { gauntlet: 'gauntlet', decompose: 'decompose', review: 'review', security: 'security', bar: 'quality bar' };
const STATUS_ORDER: Status[] = ['done', 'merging', 'auditing', 'implementing', 'waiting'];
const STAGE_STATUS: Record<ImplStage, Status> = { impl: 'implementing', audit: 'auditing', merge: 'merging' };
// hx's own closing lines for an issue (status rule 3)
const isClosing = (msg: string) => ['DONE ✓ audited and merged', 'DONE ✓ closed without a PR', 'impl DONE ✓'].some((w) => msg.startsWith(w));
const TURN = /^[\w-]+ turn \d+: (?:ok|error)\b/;
const SPLIT = /^split #(\d+) → (.*)$/;
const ISSUE_STEPS = ['Claimed', 'Implement', 'Audit', 'Merge', 'Gate'];
const PRD_STEPS = ['Gauntlet', 'Decompose', 'Build', 'Review', 'Security'];
// the now step: an issue's by its status; a PRD's by its running session's kind, else its board status (bar, done: every step done)
const ISSUE_NOW: Record<Status, number> = { waiting: -1, implementing: 1, auditing: 2, merging: 3, done: 5 };
const PRD_NOW: Record<string, number> = { gauntlet: 0, decompose: 1, building: 2, review: 3, security: 4, bar: 5, done: 5 };
const PRD_STEP_WORD: Record<string, string> = { ...PRD_KINDS, building: 'building' };

/** A local clock time, `HH:MM`, in the time zone of the machine running the code. */
export function fmtClock(t: string | number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Refs in a sentence: `#a`, `#a and #b`, `#a, #b and #c`. */
export const refList = (refs: string[]): string => (refs.length < 2 ? refs.join('') : `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)}`);

/** A step trail: the steps before `now` done, `now` now, the rest next (`now` = -1: every step next; past the end: every
 *  step done). A step's note is `note`'s, else `done` for a done step, `in progress` for the now step, empty for next. */
function trail(names: string[], now: number, note: (name: string, state: Step['state']) => string | null): Step[] {
  return names.map((name, k) => {
    const state: Step['state'] = k < now ? 'done' : k === now ? 'now' : 'next';
    return { name, state, note: note(name, state) ?? (state === 'done' ? 'done' : state === 'now' ? 'in progress' : '') };
  });
}

type TurnLine = { i: number; ok: boolean; tokens: number; secs: number | null };
const turnStats = (t: TurnLine) => ` · ${fmtTokens(t.tokens)} tokens${t.secs === null ? '' : ` · ${fmtSpan(t.secs * 1000)}`}`;

/** What the step notes read of a current claim: its latest `<role> turn i` line and the turn after it (an `audit n/N` line
 *  restarts the numbering), its latest `audit n/N: PR #p` line, and that audit's verdict with the `audit turn` line before it. */
export function claimNotes(claim: LogLine[], role: string) {
  let turn: TurnLine | null = null, last = 0, auditTurn: TurnLine | null = null;
  let audit: { n: number; of: number; pr: number } | null = null, verdict: { pass: boolean; turn: TurnLine | null } | null = null;
  for (const { msg } of claim) {
    let m = /^([\w-]+) turn (\d+): (ok|error)\b/.exec(msg);
    if (m) {
      const secs = / · (\d+)s(?: · |$)/.exec(msg);
      const t = { i: Number(m[2]), ok: m[3] === 'ok', tokens: tokensIn(msg) ?? 0, secs: secs ? Number(secs[1]) : null };
      if (m[1] === role) { turn = t; last = t.i; } else if (m[1] === 'audit') auditTurn = t;
    } else if ((m = /^audit (\d+)\/(\d+): PR #(\d+)/.exec(msg))) {
      audit = { n: Number(m[1]), of: Number(m[2]), pr: Number(m[3]) };
      verdict = null; auditTurn = null; last = 0;
    } else if (msg.startsWith('audit PASS ✓') || msg.startsWith('audit FAIL ✗')) verdict = { pass: msg.startsWith('audit PASS ✓'), turn: auditTurn };
  }
  return {
    turnNote: turn && `turn ${turn.i} ${turn.ok ? 'ok' : 'error'}${turnStats(turn)}`,
    running: last + 1,
    auditNote: audit && `audit ${audit.n} of ${audit.of} on PR #${audit.pr}`,
    verdictNote: verdict && `${verdict.pass ? 'PASS ✓' : 'FAIL ✗'}${verdict.turn ? turnStats(verdict.turn) : ''}`,
  };
}

/** The control room's issues (PRD #367, Data → issues): every open PRD, board row, live session (the self-review one left out)
 *  and PRD or issue closed today, with its status and display strings, and the board groups in board order.
 *  `plan` is undefined before the first board read; with `repo` (owner/name) its own blockers show as `#N`; now is `timeline.to`. */
export function issueStates(a: { plan?: PlanPart; sessions: LiveSession[]; lines: string[]; timeline: Timeline; auditRounds: number; today: string; repo?: string }): { groups: Group[]; items: Item[] } {
  const { plan, timeline, auditRounds, today } = a;
  const now = timeline.to;
  const lines = parseLines(a.lines);
  const sessions = a.sessions.filter((s) => !(s.number === 0 || s.kind === 'selfreview'));
  const prdRows = new Map((plan?.prds ?? []).map((r) => [r.number, r]));
  const rows = new Map((plan?.board ?? []).map((r) => [r.number, r]));
  const openPrdOf = (n: number): number | null => (plan && prdRows.has(plan.parents[n]) ? plan.parents[n] : null);

  // today's closing lines (the latest per number), every issue hx closed in the lines read, and the latest split line listing each issue
  const closedIssue = new Map<number, string>(), closedPrd = new Map<number, string>(), everDone = new Set<number>();
  const splitOf = new Map<number, number>(), noPr = new Set<number>(); // noPr: today's latest closing line is `closed without a PR`
  for (const l of lines) {
    if (l.issue === null) continue;
    if (isClosing(l.msg)) {
      everDone.add(l.issue);
      if (localDay(l.t) === today) {
        closedIssue.set(l.issue, l.t);
        if (l.msg.startsWith('DONE ✓ closed without a PR')) noPr.add(l.issue); else noPr.delete(l.issue);
      }
    }
    if (l.msg.startsWith('PRD closed ✓') && localDay(l.t) === today) closedPrd.set(l.issue, l.t);
    const m = SPLIT.exec(l.msg);
    if (m) for (const r of m[2].replace(/ \(.*$/, '').matchAll(/(?<![\w/])#(\d+)/g)) splitOf.set(Number(r[1]), Number(m[1]));
  }
  const claimTitle = (n: number): string | null => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].issue === n) { const c = claimOf(lines[i]); if (c) return c.title; }
    return null;
  };

  // a split group's members: the issues its split line is the latest to list, and no open PRD holds
  const members = new Map<number, number[]>();
  for (const [n, parent] of splitOf) if (openPrdOf(n) === null) members.set(parent, [...(members.get(parent) ?? []), n]);

  const numbers = new Set<number>([...prdRows.keys(), ...rows.keys(), ...sessions.map((s) => s.number), ...closedPrd.keys(), ...closedIssue.keys()]);
  const isPrd = (n: number) => prdRows.has(n) || closedPrd.has(n) || sessions.some((s) => s.number === n && s.kind in PRD_KINDS);
  const ref = (r: Ref) => (a.repo && r.repo.toLowerCase() === a.repo.toLowerCase() ? `#${r.number}` : `${r.repo}#${r.number}`);
  const groupOf = (n: number, prd: boolean, closed: boolean): string => {
    if (prd) return closed ? 'closed' : prdRows.has(n) ? `prd:${n}` : 'other';
    const p = openPrdOf(n);
    if (p !== null) return `prd:${p}`;
    const s = splitOf.get(n);
    if (s !== undefined && members.has(s)) return `split:${s}`;
    return closed ? 'closed' : 'other';
  };

  const claims = new Map<number, LogLine[]>();
  const items: Item[] = [...numbers].map((n) => {
    const prd = isPrd(n), session = sessions.find((s) => s.number === n), row = rows.get(n), prow = prdRows.get(n);
    const closedAt = (prd ? closedPrd.get(n) : closedIssue.get(n)) ?? null;
    let status: Status = 'waiting', word = 'waiting', stage: ImplStage | null = null;
    if (prd) {
      if (closedAt) status = word = 'done';
      else if (session && session.kind in PRD_KINDS) { status = 'implementing'; word = PRD_KINDS[session.kind]; }
      else if (prow?.status === 'building') { status = 'implementing'; word = 'building'; }
    } else if (session?.kind === 'impl') { stage = implStage(lines, n); status = word = STAGE_STATUS[stage]; }
    else if (session?.kind === 'triage') status = word = 'implementing';
    else if (closedAt) status = word = 'done';

    // tokens, round and PR from the current claim's turn lines and its latest `audit n/N: PR #p` (or held-merge) line
    const claim = currentClaim(lines, n);
    claims.set(n, claim);
    let tokens = 0, turns = 0, round = 1, pr = 'not yet';
    for (const { msg } of claim) {
      if (TURN.test(msg)) { turns++; tokens += tokensIn(msg) ?? 0; }
      let m = /^audit (\d+)\/\d+: PR #(\d+)/.exec(msg);
      if (m) { round = Number(m[1]); pr = `#${m[2]}`; }
      else if ((m = /merging held PR #(\d+) \(audit (\d+)\//.exec(msg))) { round = Number(m[2]); pr = `#${m[1]}`; }
    }
    // time: claim (else the session's since) → now while running, → the closing line when done; none while waiting
    const start = claim.length ? Date.parse(claim[0].t) : session ? Date.parse(session.since) : null;
    const end = session ? now : status === 'done' && closedAt ? Date.parse(closedAt) : null;
    return {
      number: n, prd: prd ? n : plan?.parents[n] ?? null,
      title: prow?.title ?? row?.title ?? session?.title ?? claimTitle(n) ?? '',
      group: groupOf(n, prd, status === 'done'), status, word, stage, since: session?.since ?? null,
      waitsOn: (prow?.waitingOn ?? row?.waitingOn ?? []).map(ref), worker: workerOf(timeline, n),
      tokens: turns ? fmtTokens(tokens) : session ? 'turn running' : '',
      time: start !== null && end !== null ? fmtSpan(end - start) : '',
      round: `${round} of ${auditRounds}`, pr, steps: [], facts: [], next: '',
      board: prow?.status ?? row?.status ?? null, held: !!row?.held, closedAt,
    };
  });

  // the step trail, the facts rows and the "what next" sentence (PRD #367, Right: Details); <deps> = the items whose only
  // open blocker is this one, a blocker that is an open PRD of this repo reads `PRD #N`
  const sameRepo = (r: Ref) => !a.repo || r.repo.toLowerCase() === a.repo.toLowerCase();
  const blockers = (n: number) => prdRows.get(n)?.waitingOn ?? rows.get(n)?.waitingOn ?? [];
  const deps = (n: number) => items.filter((x) => { const b = blockers(x.number); return b.length === 1 && b[0].number === n && sameRepo(b[0]); })
    .map((x) => x.number).sort((x, y) => x - y).map((x) => `#${x}`).join(', ');
  const startsWhen = (n: number, verb: string) => {
    const b = blockers(n), p = b.find((r) => sameRepo(r) && prdRows.has(r.number));
    if (p) return `Starts when PRD #${p.number} is ready.`;
    return `Starts when ${refList(b.map(ref))} ${verb}.`;
  };
  const shared = (i: Item): string | null => ({
    'blocked-label': 'Stopped after a failure. A person has to look at it.',
    untrusted: 'Not built: opened by an account hx does not trust.',
  } as Record<string, string>)[i.board ?? ''] ?? null;
  for (const i of items) {
    const claim = claims.get(i.number)!, session = sessions.find((s) => s.number === i.number);
    if (i.prd === i.number) {
      const prow = prdRows.get(i.number), kind = session && session.kind in PRD_KINDS ? session.kind : null;
      const nowAt = i.status === 'done' ? PRD_STEPS.length : PRD_NOW[kind ?? prow?.status ?? ''] ?? -1;
      let gauntlet: string | null = null;
      for (const l of lines) {
        const m = l.issue === i.number && /^gauntlet round (\d+)\/(\d+): (PASS ✓|FAIL ✗)/.exec(l.msg);
        if (m) gauntlet = `round ${m[1]} of ${m[2]} · ${m[3]}`;
      }
      i.steps = trail(PRD_STEPS, nowAt, (name, state) => state === 'next' ? null
        : name === 'Gauntlet' ? gauntlet
        : name === 'Build' && prow ? `${prow.closed}/${prow.open + prow.closed} issues done` : null);
      const k = i.steps.filter((s) => s.state === 'done').length;
      i.facts = [['STATUS', i.status === 'done' ? `closed ${fmtClock(i.closedAt!)}` : i.word], ['STEPS', i.status === 'done' ? 'all passed' : `${k} of 5 done`]];
      i.next = i.status === 'done' ? 'Closed.'
        : kind ? `A ${PRD_KINDS[kind]} session is running.`
        : prow?.status === 'building' ? `Its issues are being built: ${prow.closed}/${prow.open + prow.closed} done.`
        : prow && prow.status in PRD_KINDS ? `The ${PRD_STEP_WORD[prow.status]} step starts when a worker is free.`
        : prow?.status === 'waiting' && prow.waitingOn.length ? startsWhen(i.number, prow.waitingOn.length > 1 ? 'are done' : 'is done')
        : shared(i) ?? '';
      continue;
    }
    const c = claimNotes(claim, session?.kind === 'triage' ? 'triage' : 'impl');
    const merged = i.status === 'done' && !noPr.has(i.number);
    i.steps = trail(ISSUE_STEPS, ISSUE_NOW[i.status], (name, state) => {
      if (state === 'next') return name === 'Gate' && i.status === 'merging' ? 'runs the full suite on main after the merge' : null;
      if (name === 'Claimed') return claim.length ? `${i.worker} · ${fmtClock(claim[0].t)}` : null;
      if (name === 'Implement') return c.turnNote ?? (state === 'now' ? 'turn running' : null);
      if (name === 'Audit') return c.verdictNote ?? (state === 'now' ? c.auditNote : null);
      if (name === 'Merge') return state === 'now' ? 'rebasing on main, then merging' : merged ? 'merged ✓' : null;
      return null;
    });
    i.facts = i.status === 'waiting' ? [['WAITS ON', i.waitsOn.join(', ') || '—'], ['WORKER', 'none yet']]
      : [['WORKER', i.worker], ['TOKENS', i.tokens || '—'], ['TIME', i.time || '—'], ['ROUND', i.round], ['PR', i.pr]];
    const d = deps(i.number);
    i.next = merged ? 'Merged.'
      : i.status === 'done' ? 'Closed without a PR.'
      : i.status === 'merging' ? `Rebase on main and merge.${d ? ` When it lands, ${d} can start.` : ''}`
      : i.status === 'auditing' ? `An independent audit checks PR ${i.pr} (round ${i.round}).`
      : i.status === 'implementing' ? `The implementer is working on it (turn ${c.running}).${d ? ` ${d} waits for it.` : ''}`
      : blockers(i.number).length ? startsWhen(i.number, blockers(i.number).length > 1 ? 'merge' : 'merges')
      : i.held ? 'Its audited PR merges once main is green.'
      : ({
        question: 'Waits for your answer on GitHub.',
        triage: 'A triage session reproduces the bug first.',
        working: 'Labelled as working, but no session is running.',
        claimable: 'Starts when a worker is free.',
      } as Record<string, string>)[i.board ?? ''] ?? shared(i) ?? '';
  }

  const titleOf = (n: number) => prdRows.get(n)?.title ?? rows.get(n)?.title ?? claimTitle(n) ?? '';
  const groups: Group[] = [...prdRows.values()].sort((x, y) => x.number - y.number)
    .map((r) => ({ key: `prd:${r.number}`, title: `PRD #${r.number} · ${r.title}`, progress: `${r.closed}/${r.open + r.closed}` }));
  for (const [parent, ms] of [...members].sort((x, y) => x[0] - y[0])) {
    const t = titleOf(parent);
    groups.push({ key: `split:${parent}`, title: t ? `#${parent} · ${t} (split)` : `#${parent} (split)`,
      progress: `${ms.filter((k) => everDone.has(k)).length}/${ms.length}` });
  }
  const count = (key: string) => items.filter((i) => i.group === key).length;
  if (count('other')) groups.push({ key: 'other', title: 'Other issues', progress: String(count('other')) });
  if (count('closed')) groups.push({ key: 'closed', title: 'Closed today', progress: String(count('closed')) });

  // board order: by group; then done, merging, auditing, implementing, waiting, by number; Closed today: PRDs, then newest close first
  const at = (i: Item) => groups.findIndex((g) => g.key === i.group);
  const isPrdItem = (i: Item) => Number(i.prd === i.number);
  items.sort((x, y) => at(x) - at(y) || (x.group === 'closed'
    ? isPrdItem(y) - isPrdItem(x) || Date.parse(y.closedAt!) - Date.parse(x.closedAt!) || x.number - y.number
    : STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || x.number - y.number));
  return { groups, items };
}
