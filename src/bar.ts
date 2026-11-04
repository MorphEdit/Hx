// The quality bar (PRD #254, #256): a blind A/B of ours against a named real product, one round at a time.
// Pure helpers for a round (paths, the A/B mapping, the judge reply, the PRD markers, the gap issue body);
// writeMapping is the one helper that touches the disk.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Side = 'ours' | 'ref';
export interface Mapping { A: Side; B: Side }
export type BarResult = 'won' | 'lost' | 'no verdict';

export const BAR_PROMISE = 'BAR DONE';
export const BAR_JUDGE_PROMISE = 'BAR JUDGED';
export const BAR_MARKER_PREFIX = '<!-- hx-bar round=';
export const BAR_CAP_MARKER = '<!-- hx-bar cap -->';

/** `.hx/bar/<prd>/`, its `ref/` (the provisioned reference) and `r<round>/` (A/, B/ and .mapping). */
export const barDir = (stateDir: string, prd: number) => path.join(stateDir, 'bar', String(prd));
export const refDir = (stateDir: string, prd: number) => path.join(barDir(stateDir, prd), 'ref');
export const roundDir = (stateDir: string, prd: number, round: number) => path.join(barDir(stateDir, prd), `r${round}`);
export const mappingFile = (rDir: string) => path.join(rDir, '.mapping');

/** Which side is A, chosen by hx (never by a session): the two sides always differ. */
export function pickMapping(rng: () => number = Math.random): Mapping {
  return rng() < 0.5 ? { A: 'ours', B: 'ref' } : { A: 'ref', B: 'ours' };
}

/** Create `A/` and `B/` (empty) and write `.mapping` next to them, never inside. */
export function writeMapping(rDir: string, m: Mapping): void {
  mkdirSync(path.join(rDir, 'A'), { recursive: true });
  mkdirSync(path.join(rDir, 'B'), { recursive: true });
  writeFileSync(mappingFile(rDir), JSON.stringify(m) + '\n');
}

/** The round's mapping, or null when `.mapping` is missing or not a valid mapping. */
export function readMapping(rDir: string): Mapping | null {
  try {
    const m = JSON.parse(readFileSync(mappingFile(rDir), 'utf8'));
    const ok = (s: unknown) => s === 'ours' || s === 'ref';
    return ok(m?.A) && ok(m?.B) && m.A !== m.B ? { A: m.A, B: m.B } : null;
  } catch { return null; }
}

/** The judge's verdict: without the promise line, exactly `winner: A|B` then `gap: <sentence>`; anything else is null. */
export function parseJudgeReply(text: string, promise: string): { winner: 'A' | 'B'; gap: string } | null {
  const tag = `<promise>${promise}</promise>`;
  if (!(text ?? '').includes(tag)) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== tag).map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 2) return null;
  const w = /^winner:\s*([AB])$/.exec(lines[0]);
  const g = /^gap:\s*(.+)$/.exec(lines[1]);
  return w && g ? { winner: w[1] as 'A' | 'B', gap: g[1].trim() } : null;
}

/** A round's PRD comment: the marker line, the result line, the gap and, for a lost round, its gap issue. */
export function barMarker(round: number, result: BarResult, gap: string, extra: { rounds?: number; issue?: number } = {}): string {
  const of = extra.rounds ? `/${extra.rounds}` : '';
  const lines = [`${BAR_MARKER_PREFIX}${round} -->`, `**hx quality bar round ${round}${of}: ${result}**`, '', `gap: ${gap}`];
  if (result === 'lost' && extra.issue) lines.push('', `gap issue: #${extra.issue}`);
  return lines.join('\n');
}

/** The round, result and gap of a round comment, or null when the body is not one. */
export function parseBarMarker(body: string): { round: number; result: BarResult; gap: string; issue?: number } | null {
  const lines = (body ?? '').trimStart().split(/\r?\n/);
  const m = /^<!-- hx-bar round=(\d+) -->$/.exec(lines[0]?.trim() ?? '');
  const r = /^\*\*hx quality bar round (\d+)(?:\/\d+)?: (won|lost|no verdict)\*\*$/.exec(lines[1]?.trim() ?? '');
  if (!m || !r || r[1] !== m[1]) return null;
  const gap = lines.map((l) => /^gap:\s*(.*)$/.exec(l.trim())).find(Boolean)?.[1] ?? '';
  const issue = lines.map((l) => /^gap issue: #(\d+)$/.exec(l.trim())).find(Boolean)?.[1];
  return { round: Number(m[1]), result: r[2] as BarResult, gap, ...(issue ? { issue: Number(issue) } : {}) };
}

/** The next round: the trusted round comments so far + 1 (callers pass `gh.commentBodies(…, ctx.trusted)`). */
export const barRound = (trustedBodies: string[]) =>
  trustedBodies.filter((b) => (b ?? '').trimStart().split(/\r?\n/, 1)[0].startsWith(BAR_MARKER_PREFIX)).length + 1;

/** The comment posted when the last round (`barRounds`) is lost: the gap stands, the PRD is signed off. */
export const barCapComment = (rounds: number, gap: string) =>
  `${BAR_CAP_MARKER}\n**hx quality bar: cap of ${rounds} round${rounds === 1 ? '' : 's'} reached — signed off on the criteria**\n\n`
  + `standing gap: ${gap}`;

/** The body of the one issue a lost round files: the gap, then the sections parseBlockedBy and parseParent read. */
export function gapIssueBody(prd: number, round: number, gap: string, product: string): string {
  return `Quality bar round ${round} of PRD #${prd}: a blind A/B against ${product} was lost on this gap.\n\n`
    + `## What\n${gap}\n\n`
    + `## Acceptance criteria\n- The gap above is closed: on the same task, ours is at least as good as ${product}.\n\n`
    + `## Blocked by\nNone\n\n## Parent\n#${prd}`;
}

/** A PRD's bar on hx status and the dashboard: the latest round comment's round and result (round 0 and
 *  result null before the first round). Callers pass `gh.commentBodies(…, ctx.trusted)`. */
export interface BarStatus { round: number; rounds: number; result: BarResult | null; gap: string }
export function barStatus(trustedBodies: string[], rounds: number): BarStatus {
  const last = trustedBodies.map(parseBarMarker).filter((m) => m !== null).pop();
  return last ? { round: last.round, rounds, result: last.result, gap: last.gap } : { round: 0, rounds, result: null, gap: '' };
}

/** `bar round 2/3 · last: lost — <gap>` (the gap cut to `max` characters), or `bar: not run yet`. */
export function barLine(s: BarStatus, max = 60): string {
  if (!s.result) return 'bar: not run yet';
  const gap = s.gap.length > max ? s.gap.slice(0, max - 1) + '…' : s.gap;
  return `bar round ${s.round}/${s.rounds} · last: ${s.result}${gap ? ` — ${gap}` : ''}`;
}
