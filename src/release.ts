// Releases (PRD #139). First the pure helpers: semver tags, the current version, bumps, which commits are fixes,
// and the release notes. Then the I/O: origin's tags and commits, the closed PRDs, the gate for `hx release`,
// and `release()`, which makes one release (version commit, annotated tag, atomic push, GitHub release).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { run, runOk } from './exec.ts';
import { readGate, remoteSha, runGate, type GateResult } from './gate.ts';
import * as gh from './github.ts';
import { otherRunner } from './runstate.ts';
import { addWorktree, removeWorktree } from './worktree.ts';

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

export type Due = { due: true; bump?: BumpKind } | { due: false; why: string }; // no bump: release() decides

/** Whether `hx run` releases now (autoRelease, PRD #139 §D10): minor when a PRD closed since the last tag; else
 *  patch when the last tag is older than `patchHours` (or there is none) and a fix merged since it. */
export function releaseDue(o: { last?: string; lastDate?: string; prdsSince: number[]; subjects: string[]; patchHours: number; now: Date }): Due {
  if (o.prdsSince.length) return { due: true, bump: 'minor' };
  const since = o.last ?? 'the start';
  if (!isFixDue(o.subjects)) return { due: false, why: `no PRD closed and no fix merged since ${since}` };
  const age = o.lastDate ? o.now.getTime() - Date.parse(o.lastDate) : Infinity;
  if (age <= o.patchHours * 3_600_000) return { due: false, why: `fixes merged, but ${since} is less than ${o.patchHours} h old` };
  return { due: true, bump: 'patch' };
}

/** package.json text with its (first) `"version"` value set, everything else kept byte for byte. */
export function setPackageVersion(text: string, version: string): string {
  const re = /("version"\s*:\s*")[^"]*(")/;
  return re.test(text) ? text.replace(re, (_, a, b) => `${a}${version}${b}`) : text.replace('{', `{\n  "version": "${version}",`);
}

// ---- I/O ----

const GIT = () => process.env.HX_GIT_BIN || 'git';
const git = (cwd: string, ...args: string[]) => runOk(GIT(), ['-C', cwd, ...args]);
/** Origin's tags are fetched here, apart from local tags (a local tag never counts). */
const tagRef = (tag: string) => `refs/hx/tags/${tag}`;

export interface TagInfo { name: string; date: string } // date: tagger date (annotated), else commit date

/** Origin's tags with their dates, after fetching them and origin/<base> into `checkout`. */
export async function originTags(checkout: string, base: string): Promise<TagInfo[]> {
  await git(checkout, 'fetch', '-q', '--no-tags', '--prune', '--force', 'origin', '+refs/tags/*:refs/hx/tags/*',
    `+refs/heads/${base}:refs/remotes/origin/${base}`);
  const out = await git(checkout, 'for-each-ref', '--format=%(refname:lstrip=3)%09%(creatordate:iso-strict)', 'refs/hx/tags');
  return out.split('\n').map((l) => l.trim().split('\t')).filter(([n, d]) => n && d).map(([name, date]) => ({ name, date }));
}

/** The first-parent commits of `range` (`a..b`, or one ref for all of its history), newest first. */
export async function firstParentCommits(checkout: string, range: string): Promise<Commit[]> {
  const out = await git(checkout, 'log', '--first-parent', '--format=%s%x00%b%x1e', range);
  return out.split('\x1e').map((r) => r.replace(/^\r?\n/, '')).filter((r) => r.includes('\0'))
    .map((r) => { const [subject, body] = r.split('\0'); return { subject: subject.trim(), body: body.trim() }; });
}

/** releaseDue on origin's tags, commits and closed PRDs; also due (no bump: release() makes it) when the last tag on
 *  origin has no GitHub release, e.g. after a failed `gh release create`. */
export async function dueRelease(p: { root: string }, c: Config, now = new Date()): Promise<Due> {
  const tags = await originTags(p.root, c.defaultBranch);
  const last = lastTag(tags.map((t) => t.name));
  const lastDate = last ? tags.find((t) => t.name === last)?.date : undefined;
  const prdsSince = prdsInRange(await gh.closedWithLabel(c.repo, c.labels.prd), lastDate).map((x) => x.number);
  const subjects = (await firstParentCommits(p.root, last ? `${tagRef(last)}..origin/${c.defaultBranch}` : `origin/${c.defaultBranch}`)).map((x) => x.subject);
  const due = releaseDue({ last, lastDate, prdsSince, subjects, patchHours: c.autoReleasePatchHours, now });
  if (!due.due && last && !(await gh.releaseExists(c.repo, last))) return { due: true };
  return due;
}

export interface ReleasePaths { root: string; stateDir: string }

/** The gate `hx release` uses: the recorded result when it is for origin's head, else a gate run that is never
 *  recorded (gate.json untouched, no fix issue) — even with `gate` off. null: no gate command known. */
export function releaseGate(paths: ReleasePaths, c: Config, log: (m: string) => void, signal?: AbortSignal): () => Promise<GateResult | null> {
  return async () => {
    const gs = readGate(paths.stateDir);
    const head = await remoteSha(paths.root, c.defaultBranch);
    if (head && gs.last?.sha === head) { log(`gate: the recorded result is for ${c.defaultBranch} at ${head.slice(0, 7)}`); return gs.last; }
    const cmd = c.gateCommand || gs.command;
    if (!cmd) return null;
    log(`gate: running \`${cmd}\` on ${c.defaultBranch}`);
    const r = await runGate(paths.root, c.worktreeRoot, c.defaultBranch, cmd, c.gateMinutes * 60_000, signal,
      { stateDir: paths.stateDir, config: c, log: (m) => log(`gate: ${m}`) });
    await r.killed;
    return r;
  };
}

export interface ReleaseOptions {
  paths: ReleasePaths;
  config: Config;
  bump?: BumpKind; // else minor when a PRD closed since the last tag, patch otherwise
  yes: boolean;
  dryRun: boolean;
  gate: () => Promise<GateResult | null>; // null: no gate command known
  log: (m: string) => void;
  confirm: (question: string) => Promise<boolean>;
  inRun?: boolean; // called by hx run (autoRelease): the run is the runner, so no live-runner check
  planned?: (tag: string) => void; // told the tag before anything that can fail is pushed or created
}
/** `released`: the tag of the release made (a new one or the missing one), if any; `prds`: the PRDs in its notes. */
export interface ReleaseOutcome { code: number; released?: string; prds?: number[] }

/** Makes one release (PRD #139 §B3–§B7). Returns the exit code; a git or gh failure throws. */
export async function release(o: ReleaseOptions): Promise<ReleaseOutcome> {
  const { paths: p, config: c, log } = o;
  const base = c.defaultBranch;
  if (!o.dryRun && !o.inRun) {
    const other = otherRunner(p.stateDir);
    if (other) { log(`hx is already running for this repo (pid ${other.pid}): stop it first, or set autoRelease`); return { code: 3 }; }
  }
  const tags = await originTags(p.root, base);
  const sorted = sortTags(tags.map((t) => t.name));
  const last = sorted.at(-1), prev = sorted.at(-2);
  const dateOf = (t?: string) => (t ? tags.find((x) => x.name === t)?.date : undefined);
  const prds = await gh.closedWithLabel(c.repo, c.labels.prd);

  // the last tag on origin has no GitHub release: make only that one
  if (last && !(await gh.releaseExists(c.repo, last))) {
    const commits = await firstParentCommits(p.root, prev ? `${tagRef(prev)}..${tagRef(last)}` : tagRef(last));
    const inRange = prdsInRange(prds, dateOf(prev), dateOf(last));
    const notes = buildNotes({ repo: c.repo, commits, prds: inRange, previousTag: prev, newTag: last });
    o.planned?.(last);
    if (o.dryRun) { log(`${last} is on origin with no GitHub release: hx release would create it with these notes\n\n${notes}`); return { code: 0 }; }
    await publish(p, c, last, notes);
    log(`created the missing release ${last}`);
    return { code: 0, released: last, prds: inRange.map((x) => x.number) };
  }

  const merged = (await firstParentCommits(p.root, last ? `${tagRef(last)}..origin/${base}` : `origin/${base}`))
    .filter((x) => !isReleaseCommit(x.subject));
  if (!merged.length) { log(`nothing to release since ${last ?? 'the start'}`); return { code: 0 }; }
  const since = prdsInRange(prds, dateOf(last));
  const kind = o.bump ?? (since.length ? 'minor' : 'patch');
  let pkgVersion: string | undefined;
  if (!last) {
    const r = await run(GIT(), ['-C', p.root, 'show', `origin/${base}:package.json`]);
    try { if (r.code === 0) pkgVersion = JSON.parse(r.stdout).version; } catch {}
  }
  const current = currentVersion(sorted, pkgVersion);
  const tag = `v${bump(current, kind)}`;
  o.planned?.(tag);
  const notesFor = (commits: Commit[]) => buildNotes({ repo: c.repo, commits, prds: since, previousTag: last, newTag: tag });
  log(`release ${tag}: ${kind} bump from ${current}, ${merged.length} PR(s) merged since ${last ?? 'the start'}\n\n${notesFor(merged)}`);

  if (o.dryRun) {
    const head = await remoteSha(p.root, base);
    const g = readGate(p.stateDir).last;
    log(g && g.sha === head ? `gate: recorded ${g.ok ? 'green' : 'RED'} at ${head.slice(0, 7)} (${g.command})`
      : `gate: no recorded result for ${base} at ${head.slice(0, 7)} — hx release would run the gate`);
    return { code: 0 };
  }
  if (!o.yes && !(await o.confirm(`Release ${tag}? [y/N] `))) { log('not released'); return { code: 0 }; }

  const g = await o.gate();
  if (!g) { log('no gate command known: set gateCommand'); return { code: 1 }; }
  if (!g.ok) {
    const why = g.setupFailed ? 'the worktree setup failed' : g.timedOut ? 'timed out' : 'red';
    log(`gate ${why} on ${base} at ${g.sha.slice(0, 7)} (${g.command}) — not released\n${g.output}`);
    return { code: 1 };
  }
  const G = g.sha; // the gated commit: the release is made here even when the branch has moved since

  const wt = await addWorktree(p.root, c.worktreeRoot, { name: 'r', branch: 'hx/release', base, fresh: true });
  try {
    await git(wt.dir, 'reset', '-q', '--hard', G);
    const notes = notesFor((await firstParentCommits(wt.dir, last ? `${tagRef(last)}..${G}` : G)).filter((x) => !isReleaseCommit(x.subject)));
    const pkg = path.join(wt.dir, 'package.json');
    let target = G;
    if (existsSync(pkg)) {
      writeFileSync(pkg, setPackageVersion(readFileSync(pkg, 'utf8'), tag.slice(1)));
      await git(wt.dir, 'add', 'package.json');
      await git(wt.dir, 'commit', '-q', '-m', `chore: release ${tag}`);
      target = (await git(wt.dir, 'rev-parse', 'HEAD')).trim();
    }
    const tagAt = async (sha: string) => {
      await run(GIT(), ['-C', wt.dir, 'tag', '-d', tag]); // a local tag only: origin's tags are never moved or deleted
      await git(wt.dir, 'tag', '-a', tag, '-m', tag, sha);
    };
    await tagAt(target);
    if (target === G) await git(wt.dir, 'push', '-q', 'origin', `refs/tags/${tag}`);
    else {
      const push = await run(GIT(), ['-C', wt.dir, 'push', '-q', '--atomic', 'origin', `HEAD:refs/heads/${base}`, `refs/tags/${tag}`]);
      if (push.code !== 0) {
        // no rebase: a rebased commit would hold ungated changes, so the tag goes on G itself
        await tagAt(G);
        await git(wt.dir, 'push', '-q', 'origin', `refs/tags/${tag}`);
        log(`package.json was not bumped (push rejected): tagged ${tag} at ${G.slice(0, 7)}`);
      }
    }
    await publish(p, c, tag, notes);
  } finally {
    await removeWorktree(p.root, wt.dir);
  }
  log(`released ${tag}`);
  return { code: 0, released: tag, prds: since.map((x) => x.number) };
}

/** The GitHub release for a tag already on origin, marked latest; the notes go through a file. */
async function publish(p: ReleasePaths, c: Config, tag: string, notes: string): Promise<void> {
  const file = path.join(p.stateDir, `release-notes-${tag}.md`);
  writeFileSync(file, notes);
  try { await gh.createRelease(c.repo, tag, file); } finally { rmSync(file, { force: true }); }
}
