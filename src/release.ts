// Release helpers (PRD #139): semver tags, the current version, bumps, which commits are fixes, and the release notes.
// Pure, no I/O, no imports.

export type Semver = [number, number, number];
export type BumpKind = 'major' | 'minor' | 'patch';
export interface Commit { subject: string; body: string }
export interface Prd { number: number; title: string }
export interface ClosedPrd extends Prd { closedAt?: string | null; stateReason?: string | null }

/** `vX.Y.Z` → its parts; anything else (`latest`, `v1`, `v1.2`, `1.2.3`) → null. */
export function parseTag(tag: string): Semver | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The semver tags in ascending semver order (`v0.9.3` before `v0.10.0`); other tags dropped. */
export function sortTags(tags: string[]): string[] {
  return tags.filter((t) => parseTag(t)).sort((a, b) => compareSemver(parseTag(a)!, parseTag(b)!));
}

/** The highest `vX.Y.Z` tag, or undefined when there is none. */
export function lastTag(tags: string[]): string | undefined {
  return sortTags(tags).at(-1);
}

/** The last tag's version; with no tag `package.json`'s version when given, else `0.0.0`. */
export function currentVersion(tags: string[], packageVersion?: string): string {
  const t = lastTag(tags);
  return t ? t.slice(1) : packageVersion || '0.0.0';
}

/** `0.4.2` → major `1.0.0`, minor `0.5.0`, patch `0.4.3`. */
export function bump(version: string, kind: BumpKind): string {
  const v = parseTag(`v${version}`);
  if (!v) throw new Error(`not a version: ${version}`);
  const [M, m, p] = v;
  return kind === 'major' ? `${M + 1}.0.0` : kind === 'minor' ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`;
}

export function isReleaseCommit(subject: string): boolean {
  return /^chore: release v\d+\.\d+\.\d+$/.test(subject);
}

const typed = (type: string, subject: string) => new RegExp(`^${type}(\\([^)]*\\))?:`).test(subject);

/** `fix:` or `fix(<scope>):`; a release commit never counts. */
export function isFix(subject: string): boolean {
  return !isReleaseCommit(subject) && typed('fix', subject);
}

/** The patch trigger: some commit in the list (release commits aside) is a fix. */
export function isFixDue(subjects: string[]): boolean {
  return subjects.some(isFix);
}

/** The issue title without a leading `PRD:`, trimmed. */
export function prdDisplayTitle(title: string): string {
  return title.replace(/^\s*PRD:/i, '').trim();
}

/** One notes line: `- <subject> (#issue, #PR)`, the ` (closes #N)` and ` (#PR)` suffixes folded into the parenthesis. */
export function noteLine(c: Commit): string {
  let subject = c.subject.trim();
  let pr: string | undefined;
  const prMatch = /\s*\(#(\d+)\)$/.exec(subject);
  if (prMatch) { pr = prMatch[1]; subject = subject.slice(0, prMatch.index); }
  const issues: string[] = [];
  for (const m of `${subject}\n${c.body ?? ''}`.matchAll(/closes #(\d+)/gi)) if (!issues.includes(m[1]) && m[1] !== pr) issues.push(m[1]);
  subject = subject.replace(/\s*\(closes #\d+\)/gi, '').trim();
  const refs = [...issues, ...(pr ? [pr] : [])].map((n) => `#${n}`);
  return `- ${subject}${refs.length ? ` (${refs.join(', ')})` : ''}`;
}

const SECTIONS: [string, (s: string) => boolean][] = [
  ['Features', (s) => typed('feat', s)],
  ['Fixes', (s) => typed('fix', s)],
  ['Docs', (s) => typed('docs', s)],
  ['Other', () => true],
];

/** The release notes: PRD lines, then Features / Fixes / Docs / Other (empty ones left out), then the diff link. */
export function buildNotes(o: { repo: string; commits: Commit[]; prds: Prd[]; previousTag?: string; newTag: string }): string {
  const blocks: string[] = [];
  if (o.prds.length) blocks.push(o.prds.map((p) => `PRD #${p.number}: ${prdDisplayTitle(p.title)}`).join('\n'));
  const groups = new Map<string, string[]>(SECTIONS.map(([name]) => [name, []]));
  for (const c of o.commits) {
    const subject = c.subject.trim();
    if (isReleaseCommit(subject)) continue;
    const [name] = SECTIONS.find(([, match]) => match(subject))!;
    groups.get(name)!.push(noteLine(c));
  }
  for (const [name, lines] of groups) if (lines.length) blocks.push(`## ${name}\n${lines.join('\n')}`);
  blocks.push(o.previousTag
    ? `Full diff: https://github.com/${o.repo}/compare/${o.previousTag}...${o.newTag}`
    : `Full diff: https://github.com/${o.repo}/commits/${o.newTag}`);
  return blocks.join('\n\n') + '\n';
}

/** PRDs closed as completed after `after` (all when absent) and not after `notAfter` (when given). */
export function prdsInRange<T extends ClosedPrd>(prds: T[], after?: string, notAfter?: string): T[] {
  const lo = after ? Date.parse(after) : -Infinity, hi = notAfter ? Date.parse(notAfter) : Infinity;
  return prds.filter((p) => {
    if (String(p.stateReason ?? '').toUpperCase() !== 'COMPLETED' || !p.closedAt) return false;
    const t = Date.parse(p.closedAt);
    return t > lo && t <= hi;
  });
}
