// The control-room data of hx dashboard (PRD #367): run.log lines read as claims, stages and today's events. Pure: no I/O, no clock.
import { localDay } from './usage.ts';

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
