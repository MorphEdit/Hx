// Filing a PRD, an issue or a bug: one markdown file → one issue. Shared by `hx prd`, `hx grill`, `hx issue` and `hx bug`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Config } from './config.ts';
import * as gh from './github.ts';

/**
 * File `file` as an issue (labels: the PRD label unless given) and return its URL.
 * Title: `title` if given (body unchanged), else the first '# ' line (removed from the body).
 */
export async function filePrd(config: Config, file: string, title?: string, labels: string[] = [config.labels.prd]): Promise<string> {
  let body = readFileSync(file, 'utf8');
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (!title && h1) { title = h1[1]; body = body.replace(h1[0], '').trimStart(); }
  if (!title) throw new Error('no title: pass --title or start the file with a "# Title" line');
  return gh.createIssue(config.repo, title, body, labels);
}

/** The title of a bug: `title` if given, else the first '# ' line, else the first non-empty line, cut to 80 characters. */
export function bugTitle(body: string, title?: string): string {
  if (title) return title;
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  const line = h1 ? h1[1] : (body.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  if (!line) throw new Error('no title: pass --title or give the bug a first line');
  return line.slice(0, 80);
}

/** File a bug issue (label bug only, not ready-for-agent) from a file, or from `arg` itself when it is not a file. Returns its URL. */
export async function fileBug(config: Config, arg: string, title?: string): Promise<string> {
  const body = existsSync(arg) && statSync(arg).isFile() ? readFileSync(arg, 'utf8') : arg;
  return gh.createIssue(config.repo, bugTitle(body, title), body, [config.labels.bug]);
}

export interface QualityBar { product: string; url: string; dimensions: string[] }

/** A PRD's `## Quality bar` section (`Beat: <product> — <URL>`, then `Judged on:` and `- ` bullets up to the
 *  next `## ` heading), or null when the body has none. `-` works in place of `—`. */
export function parseQualityBar(body: string): QualityBar | null {
  const h = /^##[ \t]+Quality bar[ \t]*$/im.exec(body ?? '');
  if (!h) return null;
  let section = body.slice(h.index + h[0].length);
  const next = /^##[ \t]+/m.exec(section);
  if (next) section = section.slice(0, next.index);
  const lines = section.split(/\r?\n/).map((l) => l.trim());
  const beat = lines.map((l) => /^Beat:\s*(.+?)\s+[—-]\s+(\S+)$/i.exec(l)).find((m) => m);
  const judged = lines.findIndex((l) => /^Judged on:?$/i.test(l));
  const dimensions = judged < 0 ? [] : lines.slice(judged + 1).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
  return { product: beat?.[1] ?? '', url: beat?.[2] ?? '', dimensions };
}

/** The number of items in a PRD's `## Acceptance criteria` list (up to the next `## ` heading), 0 when there is
 *  none. An item is a list line (`- `, `* `, `- [ ] `, `1. `, `1) `) at the smallest indentation of the section's
 *  list lines; deeper bullets and continuation lines belong to their item. */
export function countCriteria(body: string): number {
  const h = /^##[ \t]+Acceptance criteria[ \t]*$/im.exec(body ?? '');
  if (!h) return 0;
  let section = body.slice(h.index + h[0].length);
  const next = /^##[ \t]+/m.exec(section);
  if (next) section = section.slice(0, next.index);
  const indents = section.split(/\r?\n/).map((l) => /^([ \t]*)(?:[-*]|\d+[.)])[ \t]+\S/.exec(l)?.[1].length).filter((n) => n !== undefined);
  if (!indents.length) return 0;
  const top = Math.min(...indents);
  return indents.filter((n) => n === top).length;
}

/** The gauntlet's engine finding (PRD #436): the one fixed line a round adds when the PRD has no counted criteria. */
export const CRITERIA_FINDING = '- The PRD has no "## Acceptance criteria" section with items — the one-child path and the review need testable criteria — hx engine check';

/** A gauntlet round's verdict after the engine check (PRD #436). When `countCriteria(body)` is 0 the round is a FAIL
 *  (`engine` true): on a critic PASS its findings are the engine finding alone, on a critic FAIL the critic's then the
 *  engine finding. Otherwise the critic's verdict as it is. */
export function criteriaCheck(body: string, v: { pass: boolean; findings: string }): { pass: boolean; findings: string; engine: boolean } {
  if (countCriteria(body) > 0) return { ...v, engine: false };
  return { pass: false, findings: v.pass ? CRITERIA_FINDING : `${v.findings}\n${CRITERIA_FINDING}`, engine: true };
}

/** Why the engine files one child for a PRD instead of starting a decompose session (PRD #422), or null to decompose.
 *  The first rule that applies decides: `max` 0 (off) → null; no criteria → null; a pool of one (`workers` 1, autoWorkers
 *  off) → 'pool'; at most `max` criteria → 'count'; else null. `workers` and `auto` are the run's (`--workers`, HX_AUTO_WORKERS). */
export function singleChild(body: string, max: number, workers: number, auto: boolean): 'pool' | 'count' | null {
  if (max === 0) return null;
  const n = countCriteria(body);
  if (n === 0) return null;
  if (workers === 1 && !auto) return 'pool';
  return n <= max ? 'count' : null;
}

/** The engine-filed child's body: PRD `prd`'s `## Acceptance criteria` section word for word (heading to the next `## `
 *  heading), a pointer to the PRD for the rest, then `## Blocked by` None and `## Parent` #prd as decompose children end. */
export function singleChildBody(prdBody: string, prd: number): string {
  const h = /^##[ \t]+Acceptance criteria[ \t]*$/im.exec(prdBody ?? '');
  let section = h ? prdBody.slice(h.index) : '';
  const next = /^##[ \t]+/m.exec(section.slice(h ? h[0].length : 0));
  if (h && next) section = section.slice(0, h[0].length + next.index);
  return `${section.trimEnd()}\n\nEverything else (the goals, the behaviour, the edge cases, the notes for implementers) is in PRD #${prd}: read it before you start.\n\n## Blocked by\nNone\n\n## Parent\n#${prd}\n`;
}

/** The run.log line and the PRD comment for an engine-filed child. */
export function singleChildLine(prd: number, child: number, reason: 'pool' | 'count', max: number): string {
  return `prd #${prd}: one child #${child} (${reason === 'pool' ? 'a pool of one' : `≤ ${max} acceptance criteria`}) — no decompose`;
}

// The PRD's `## Original request` (PRD #475): the user's own words as a block quote, the first section after the title.
const ORIGINAL_HEADING = /^##[ \t]+Original request[ \t]*\r?$/im;
const NEXT_HEADING = /^##[ \t]/m;

/** Where the first `## Original request` section of `body` starts and ends (the heading line up to the next line
 *  starting with `## `, or the end of the body), or null when there is none. */
function originalSpan(body: string): { start: number; end: number; head: number } | null {
  const h = ORIGINAL_HEADING.exec(body ?? '');
  if (!h) return null;
  const head = h.index + h[0].length;
  const next = NEXT_HEADING.exec(body.slice(head));
  return { start: h.index, end: next ? head + next.index : body.length, head };
}

/** The first `## Original request` section of `body`, its heading included, or null when there is none. */
export function originalRequest(body: string): string | null {
  const s = originalSpan(body);
  return s ? body.slice(s.start, s.end) : null;
}

/** Text compared word for word: `> ` prefixes dropped, every run of whitespace one space (CRLF and LF alike). */
const flat = (s: string) => s.replace(/^[ \t]*(?:>[ \t]?)+/gm, '').replace(/\s+/g, ' ').trim();

/** A section compared as text: LF line endings, the blank lines at its end dropped. */
const sectionText = (s: string) => s.replace(/\r\n/g, '\n').replace(/(?:\n[ \t]*)+$/, '');

/** The idea as a block quote: LF line endings, the blank lines at its start and end dropped, each line prefixed `> `. */
export function quoteIdea(idea: string): string {
  const lines = idea.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.map((l) => `> ${l}`).join('\n');
}

/** `section` (heading included) put in as the first section of `body`: right before the first line that starts with
 *  `## `, or at the end of a body that has none. */
function insertFirst(body: string, section: string): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const next = NEXT_HEADING.exec(body);
  const text = section.replace(/\s+$/, '');
  if (next) return `${body.slice(0, next.index)}${text}${eol}${eol}${body.slice(next.index)}`;
  return body.trim() ? `${body.replace(/\s+$/, '')}${eol}${eol}${text}${eol}` : `${text}${eol}`;
}

/** The grill session's PRD with the idea kept in its `## Original request` section (PRD #475). An empty idea (or only
 *  whitespace) changes nothing; a section that already holds the idea (`> ` prefixes and whitespace aside) changes
 *  nothing; a section without it gets the idea at its top, above the session's lines; no section gets one, first. */
export function withIdea(body: string, idea: string): string {
  if (!idea?.trim()) return body;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const quote = quoteIdea(idea).replace(/\n/g, eol);
  const s = originalSpan(body);
  if (!s) return insertFirst(body, `## Original request${eol}${eol}${quote}${eol}`);
  if (flat(body.slice(s.head, s.end)).includes(flat(idea))) return body;
  const rest = body.slice(s.head, s.end).replace(/^\s+/, '');
  return `${body.slice(0, s.head)}${eol}${eol}${quote}${eol}${rest ? `${eol}${rest}` : eol}${body.slice(s.end)}`;
}

/** The PRD body after a revise session with the `## Original request` section as it was before the session
 *  (PRD #475): a changed section replaced where it stands, a removed one put back first, one the reviser added to
 *  a PRD that had none removed (every one). `line` is the run.log line, null when the body is left as it is. */
export function keepOriginal(before: string, after: string): { body: string; line: string | null } {
  const was = originalRequest(before);
  const now = originalSpan(after);
  if (was === null && !now) return { body: after, line: null };
  if (was !== null && now && sectionText(was) === sectionText(after.slice(now.start, now.end))) return { body: after, line: null };
  if (was !== null && now) {
    const keep = sectionText(was) + (now.end < after.length ? '\n\n' : '\n');
    return { body: after.slice(0, now.start) + keep + after.slice(now.end),
      line: 'the reviser changed the ## Original request section — the earlier text put back' };
  }
  if (was !== null) return { body: insertFirst(after, was),
    line: 'the reviser removed the ## Original request section — the earlier text put back as the first section' };
  let body = after;
  for (let s = originalSpan(body); s; s = originalSpan(body)) body = body.slice(0, s.start) + body.slice(s.end);
  return { body, line: 'the reviser added a ## Original request section the PRD did not have — removed' };
}
