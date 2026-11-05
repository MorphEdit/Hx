// A held merge (#301): an audited PR whose merge fails its tests only on tests that also fail on a red default
// branch is not at fault. hx keeps its PASS, counts no round and runs no implementer; the PR waits in
// .hx/held.json and its merge is retried once the gate is green. Pure helpers and the state file.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GateResult } from './gate.ts';

export const HELD_MARKER = '<!-- hx-merge-held -->';
/** The status hx status and the dashboard show for a held issue. */
export const HELD_STATUS = 'held (main red)';

/** One held PR: its number, the audit round its PASS is from (kept, not counted again), and when. */
export interface HeldMerge { pr: number; round: number; at: string }

const file = (stateDir: string) => path.join(stateDir, 'held.json');

/** issue number → its held merge; {} when the file is missing or unreadable. */
export function readHeld(stateDir: string): Record<string, HeldMerge> {
  try {
    const s = JSON.parse(readFileSync(file(stateDir), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

export function writeHeld(stateDir: string, s: Record<string, HeldMerge>): void {
  writeFileSync(file(stateDir), JSON.stringify(s, null, 2) + '\n');
}

/** Records issue `n` as held, or (h undefined) takes it out. */
export function setHeld(stateDir: string, n: number, h: HeldMerge | undefined): void {
  const s = readHeld(stateDir);
  if (h) s[n] = h;
  else if (n in s) delete s[n];
  else return;
  writeHeld(stateDir, s);
}

/**
 * The names of the failing tests in a test run's output, in order, without duplicates: node --test's spec
 * (`✖ name (1.2ms)`) and TAP (`not ok 3 - name`) reporters, jest (`✕ name (5 ms)`), pytest (`FAILED a.py::t`)
 * and go (`--- FAIL: TestX`). An output in no known shape gives none.
 */
export function failingTests(output: string): string[] {
  const out = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    let name = '';
    if ((m = /^[✖✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/.exec(l))) name = m[1];
    else if ((m = /^not ok \d+ - (.+?)(?:\s+#\s*(?:TODO|SKIP)\b.*)?$/i.exec(l))) name = /#\s*(TODO|SKIP)\b/i.test(l) ? '' : m[1];
    else if ((m = /^FAILED\s+(\S+)/.exec(l))) name = m[1];
    else if ((m = /^--- FAIL:\s+(\S+)/.exec(l))) name = m[1];
    if (name && name !== 'failing tests:') out.add(name);
  }
  return [...out];
}

export type MergeFailure =
  | { held: true } // every failing test also fails on the red default branch: the PR is not at fault
  | { held: false; notOnMain: string[] }; // back to the implementer; notOnMain names the PR's own failures, when known

/**
 * After a PASSed PR's merge failed its tests (`prOutput`): held when the gate's last result for the default
 * branch is red and every failing test found in prOutput is also in the gate's failing tests. No failing test
 * found in prOutput, or a green (or no) gate result: not held, nothing named.
 */
export function mergeFailure(prOutput: string, gate: GateResult | undefined): MergeFailure {
  if (!gate || gate.ok || gate.setupFailed) return { held: false, notOnMain: [] };
  const pr = failingTests(prOutput);
  if (!pr.length) return { held: false, notOnMain: [] };
  const main = new Set(failingTests(gate.output));
  const notOnMain = pr.filter((t) => !main.has(t));
  return notOnMain.length ? { held: false, notOnMain } : { held: true };
}

/** The comment on a held issue. */
export const heldComment = (base: string, fixIssue: number | undefined, pr: number) =>
  `${HELD_MARKER}\n**hx:** held: ${base} is red${fixIssue ? ` (#${fixIssue})` : ''}; merges once ${base} is green (PR #${pr}, audit PASS kept)`;
