// The self-review session (PRD #194 §C, #239): after a quiet period, a read-only session reviews what merged on
// origin/<default> since the last review and its findings are filed into the bug lane. Pure helpers and the state file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** .hx/selfreview.json: the head of origin/<default> the last self-review reviewed, and when. */
export interface SelfReviewState { sha: string; at: string }

export const selfReviewFile = (stateDir: string) => path.join(stateDir, 'selfreview.json');
export const SELFREVIEW_PROMISE = 'SELFREVIEW DONE';
export const selfReviewMarker = (sha: string) => `<!-- hx:selfreview ${sha} -->`;

/** The recorded state, or null when the file is missing or unreadable. */
export function readSelfReview(stateDir: string): SelfReviewState | null {
  const f = selfReviewFile(stateDir);
  if (!existsSync(f)) return null;
  try {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return typeof s?.sha === 'string' && typeof s?.at === 'string' ? { sha: s.sha, at: s.at } : null;
  } catch { return null; }
}

export function writeSelfReview(stateDir: string, s: SelfReviewState): void {
  writeFileSync(selfReviewFile(stateDir), JSON.stringify(s, null, 2) + '\n');
}

export interface Finding { title: string; body: string }

/** The `## Finding: <title>` blocks of a reply, up to `max`; a block ends at the next heading or the promise. */
export function parseFindings(text: string, max: number): Finding[] {
  const out: Finding[] = [];
  const lines = text.replace(/<promise>[\s\S]*?<\/promise>/g, '').split(/\r?\n/);
  let cur: { title: string; lines: string[] } | null = null;
  const flush = () => { if (cur && cur.title) out.push({ title: cur.title, body: [`## Finding: ${cur.title}`, ...cur.lines].join('\n').trim() }); cur = null; };
  for (const l of lines) {
    const m = /^##\s+Finding:\s*(.*?)\s*$/.exec(l);
    if (m) { flush(); cur = { title: m[1], lines: [] }; continue; }
    if (cur && /^#{1,2}\s/.test(l)) { flush(); continue; }
    if (cur) cur.lines.push(l);
  }
  flush();
  return out.slice(0, Math.max(0, max));
}

/** An issue body for a finding: the finding, then the marker of the head reviewed. */
export const findingBody = (f: Finding, sha: string) => `${f.body}\n\n${selfReviewMarker(sha)}\n`;

export type SelfReviewDecision =
  | { kind: 'record' } // no state, or a sha the head does not descend from: record the head, no session
  | { kind: 'wait'; why: string }
  | { kind: 'review'; since: string };

/** Whether a pass starts a session: `ancestor` = the recorded sha is an ancestor of the head, `commits` in sha..head. */
export function selfReviewDecision(s: SelfReviewState | null, o: { ancestor: boolean; commits: number; now: number; everyHours: number }): SelfReviewDecision {
  if (!s || !o.ancestor) return { kind: 'record' };
  if (!o.commits) return { kind: 'wait', why: 'no merges since the last review' };
  if (o.now - Date.parse(s.at) < o.everyHours * 3_600_000) return { kind: 'wait', why: 'reviewed too recently' };
  return { kind: 'review', since: s.sha };
}
