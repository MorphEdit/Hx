// Pure board logic: which open issues can a worker take right now? No I/O here, so it is unit-tested.
import type { Issue } from './github.ts';
import type { Labels } from './config.ts';

export interface Ref {
  repo: string; // owner/name
  number: number;
}

const BLOCKED_BY_HEADING = /^#{2,3}\s+Blocked by\s*:?\s*$/im;
const NEXT_HEADING = /^#{2,3}\s+/m;
// owner/repo#N, or a bare #N not glued to a word (so `fixes#88` is not a ref) — same grammar as Harness.
const ISSUE_REF = /(?:(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+))|(?:(?<![\w.-])#(\d+))/g;
const NONE_SECTION = /^\s*None\b/i;

/** Refs listed under a `## Blocked by` section. A section starting with `None` means no blockers. */
export function parseBlockedBy(body: string, selfRepo: string): Ref[] {
  const m = BLOCKED_BY_HEADING.exec(body ?? '');
  if (!m) return [];
  let section = body.slice(m.index + m[0].length);
  const next = NEXT_HEADING.exec(section);
  if (next) section = section.slice(0, next.index);
  if (NONE_SECTION.test(section)) return [];
  const refs: Ref[] = [];
  for (const r of section.matchAll(ISSUE_REF)) {
    const ref = r[1] ? { repo: r[1], number: Number(r[2]) } : { repo: selfRepo, number: Number(r[3]) };
    if (!refs.some((x) => x.repo.toLowerCase() === ref.repo.toLowerCase() && x.number === ref.number)) refs.push(ref);
  }
  return refs;
}

export const refKey = (r: Ref) => `${r.repo.toLowerCase()}#${r.number}`;

export interface BoardRow {
  number: number;
  title: string;
  status: 'triage' | 'claimable' | 'working' | 'blocked-label' | 'waiting' | 'untrusted';
  waitingOn: Ref[]; // open blockers, for status === 'waiting'
  author?: string; // status 'untrusted' through its own author ('' = a deleted account)
  untrustedPrd?: { number: number; author: string }; // status 'untrusted' through its PRD's author
}

/** Whether an issue's author is in the trusted set (lowercased logins). No set = no filter (unit tests);
 *  hx run / status always pass one. An empty author (a deleted, "ghost" account) is never trusted. */
export function isTrusted(i: Issue, trusted?: Set<string>): boolean {
  return !trusted || (!!i.author && trusted.has(i.author.toLowerCase()));
}

/** The trusted set: the gh login plus config.trustedAuthors, lowercased for a case-insensitive match. */
export function trustedSet(login: string, extra: string[] = []): Set<string> {
  return new Set([login, ...extra].map((l) => l.trim().toLowerCase()).filter(Boolean));
}

/** The bug lane as board() sees it. */
export interface BugLane {
  triage: boolean; // config.bugTriage
  prdChildren: Set<number>; // issues whose parent is a PRD (open or closed): classified as normal children
}

/**
 * Classify every open ready issue and, with `bug.triage`, every open untriaged `bug` issue that is not a
 * PRD's child: it gets status `triage` instead of `claimable` (ready-for-agent or not). `states` maps
 * refKey → state for every ref we could resolve; an unresolvable ref counts as open (never start work on
 * a dependency we cannot see). Triage rows come first, then claimable rows, oldest issue first.
 */
export function board(issues: Issue[], repo: string, labels: Labels, states: Map<string, 'OPEN' | 'CLOSED'>,
  inFlight: Set<number> = new Set(), inherited: Map<number, Ref[]> = new Map(), trusted?: Set<string>,
  untrustedPrd: Map<number, { number: number; author: string }> = new Map(), bug?: BugLane): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const i of issues) {
    if (i.state !== 'OPEN' || i.labels.includes(labels.prd)) continue;
    const triage = !!bug?.triage && i.labels.includes(labels.bug) && !i.labels.includes(labels.triaged) && !bug.prdChildren.has(i.number);
    if (!triage && !i.labels.includes(labels.ready)) continue;
    let status: BoardRow['status'];
    let waitingOn: Ref[] = [];
    if (!isTrusted(i, trusted)) {
      rows.push({ number: i.number, title: i.title, status: 'untrusted', waitingOn, author: i.author ?? '' });
      continue;
    }
    if (untrustedPrd.has(i.number)) {
      rows.push({ number: i.number, title: i.title, status: 'untrusted', waitingOn, untrustedPrd: untrustedPrd.get(i.number) });
      continue;
    }
    if (inFlight.has(i.number) || i.labels.includes(labels.working)) status = 'working';
    else if (i.labels.includes(labels.blocked)) status = 'blocked-label';
    else {
      waitingOn = openBlockers(i, repo, states).concat(inherited.get(i.number) ?? []);
      status = waitingOn.length ? 'waiting' : triage ? 'triage' : 'claimable';
    }
    rows.push({ number: i.number, title: i.title, status, waitingOn });
  }
  const rank = { triage: 0, claimable: 1, working: 2, waiting: 3, 'blocked-label': 4, untrusted: 5 } as const;
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.number - b.number);
}

function openBlockers(i: Issue, repo: string, states: Map<string, 'OPEN' | 'CLOSED'>): Ref[] {
  return parseBlockedBy(i.body, repo).filter((r) =>
    !(r.repo.toLowerCase() === repo.toLowerCase() && r.number === i.number) && states.get(refKey(r)) !== 'CLOSED');
}

// `## Parent` (heading, ref on the next lines), `## Parent #N`, `Parent: #N`, or a legacy `Part of #N`.
const PARENT_HEADING = /^#{2,3}\s+Parent\s*:?\s*$/im;
const REF = String.raw`(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+))`;
const PARENT_INLINE = new RegExp(String.raw`^#{2,3}[ \t]+Parent[ \t]*:?[ \t]*${REF}`, 'im');
const PARENT_COLON = new RegExp(String.raw`(?<![\w.-])Parent:[ \t]*${REF}`, 'i');
const PART_OF = new RegExp(String.raw`(?<![\w.-])Part of\s+${REF}`, 'i');

/** The PRD an issue belongs to, if its body names one. */
export function parseParent(body: string, selfRepo: string): Ref | null {
  body ??= '';
  const toRef = (m: RegExpExecArray | RegExpMatchArray) =>
    m[1] ? { repo: m[1], number: Number(m[2]) } : { repo: selfRepo, number: Number(m[3]) };
  const h = PARENT_HEADING.exec(body);
  if (h) {
    let section = body.slice(h.index + h[0].length);
    const next = NEXT_HEADING.exec(section);
    if (next) section = section.slice(0, next.index);
    const m = [...section.matchAll(ISSUE_REF)][0];
    if (m) return m[1] ? { repo: m[1], number: Number(m[2]) } : { repo: selfRepo, number: Number(m[3]) };
  }
  for (const re of [PARENT_INLINE, PARENT_COLON, PART_OF]) {
    const m = re.exec(body);
    if (m) return toRef(m);
  }
  return null;
}

export type Action =
  | { kind: 'gauntlet'; prd: number; title: string }
  | { kind: 'decompose'; prd: number; title: string; children: Issue[] }
  | { kind: 'review'; prd: number; title: string; children: Issue[] }
  | { kind: 'security'; prd: number; title: string; children: Issue[] }
  | { kind: 'close-prd'; prd: number; secured?: boolean } // secured: the security pass signed it off
  | { kind: 'label-ready'; issue: number; prd: number }
  | { kind: 'impl'; issue: number; title: string }
  | { kind: 'triage'; issue: number; title: string };

export interface PrdRow {
  number: number;
  title: string;
  status: 'gauntlet' | 'decompose' | 'building' | 'review' | 'security' | 'done' | 'working' | 'waiting' | 'blocked-label' | 'untrusted';
  open: number; // open children
  closed: number;
  waitingOn: Ref[];
  author?: string; // status 'untrusted': who opened it ('' = a deleted account)
}

export interface Plan {
  actions: Action[]; // in priority order: triage, bug implementation, PRD sessions, engine-only steps, then implementation
  prds: PrdRow[];
  board: BoardRow[];
  parents: Record<number, number>; // issue → its PRD (closed PRDs too), from the issue's `## Parent`
}

/** Session keys the pool tracks in flight: one session per PRD, one per issue. */
export const prdKey = (n: number) => `prd:${n}`;
export const issueKey = (n: number) => `issue:${n}`;

/**
 * The whole board, PRDs included. `all` is every issue (open and closed, no PRs).
 *  - a PRD (open, `prd` label) with no children and not yet `prd-hardened` → gauntlet (critique, revise),
 *    unless `opts.gauntlet` is false; a PRD that already has children never goes back to the gauntlet
 *  - a PRD with no children → decompose
 *  - children still open → they are built through the normal ready-issue flow
 *  - every child closed, not yet `reviewed` → review (may file gap issues: back to building)
 *  - reviewed, every child closed, not yet `security-reviewed` → security pass (may file security issues:
 *    hx then removes `prd-reviewed`, so after the fixes the PRD is reviewed and checked again),
 *    unless `opts.security` is false
 *  - reviewed (and security-reviewed) and every child closed → the engine closes it
 * A PRD's own `## Blocked by` sequences PRDs: until it clears, nothing of that PRD runs.
 * `opts.trusted` (lowercased logins): a PRD opened by anyone else is `untrusted` and nothing of it runs —
 * its children are not claimed either; an issue opened by anyone else is never claimed and never counts
 * as a PRD's child (it neither holds a PRD in building nor reaches a session's prompt).
 * The bug lane: an open `bug` issue that is not a PRD's child is triaged first (`opts.bugTriage`, default
 * true: status `triage`, never claimable before `bug-triaged`); once claimable it is built before anything else.
 */
export function plan(all: Issue[], repo: string, labels: Labels, states: Map<string, 'OPEN' | 'CLOSED'>,
  busy: Set<string> = new Set(), opts: { gauntlet?: boolean; security?: boolean; bugTriage?: boolean; trusted?: Set<string> } = {}): Plan {
  const gauntlet = opts.gauntlet ?? true;
  const security = opts.security ?? true;
  const prdIssues = all.filter((i) => i.labels.includes(labels.prd)).sort((a, b) => a.number - b.number);
  const prdNums = new Set(prdIssues.map((p) => p.number));
  const children = new Map<number, Issue[]>(prdIssues.map((p) => [p.number, []]));
  const parentOf = new Map<number, number>();
  const prdChildren = new Set<number>(); // trusted or not: a PRD's child never enters the bug lane
  for (const i of all) {
    if (prdNums.has(i.number)) continue;
    const p = parseParent(i.body, repo);
    if (!p || p.repo.toLowerCase() !== repo.toLowerCase() || !prdNums.has(p.number)) continue;
    prdChildren.add(i.number);
    if (!isTrusted(i, opts.trusted)) continue;
    children.get(p.number)!.push(i);
    parentOf.set(i.number, p.number);
  }

  const actions: Action[] = [];
  const engine: Action[] = [];
  const prds: PrdRow[] = [];
  const inherited = new Map<number, Ref[]>();
  const untrustedPrd = new Map<number, { number: number; author: string }>();
  for (const p of prdIssues) {
    if (p.state !== 'OPEN') continue;
    const kids = children.get(p.number)!;
    // a child whose session is still running counts as open: the agent closes the issue when it
    // merges, before the session ends, and a review must not start on a half-finished child
    const open = kids.filter((k) => k.state === 'OPEN' || busy.has(issueKey(k.number)));
    const waitingOn = openBlockers(p, repo, states);
    // children wait while their PRD is sequenced behind another, or while decompose is still filing
    // them (a child filed first may get its `Blocked by` from a sibling that does not exist yet)
    if (waitingOn.length || busy.has(prdKey(p.number)))
      for (const k of kids) inherited.set(k.number, [{ repo, number: p.number }]);
    const trusted = isTrusted(p, opts.trusted);
    if (!trusted) for (const k of kids) untrustedPrd.set(k.number, { number: p.number, author: p.author ?? '' });
    let status: PrdRow['status'];
    if (!trusted) status = 'untrusted';
    else if (p.labels.includes(labels.blocked)) status = 'blocked-label';
    else if (waitingOn.length) status = 'waiting';
    else if (busy.has(prdKey(p.number))) status = 'working';
    else if (!kids.length) status = gauntlet && !p.labels.includes(labels.hardened) ? 'gauntlet' : 'decompose';
    else if (open.length) status = 'building';
    else if (!p.labels.includes(labels.reviewed)) status = 'review';
    else status = security && !p.labels.includes(labels.secured) ? 'security' : 'done';
    prds.push({ number: p.number, title: p.title, status, open: open.length, closed: kids.length - open.length, waitingOn,
      ...(trusted ? {} : { author: p.author ?? '' }) });

    if (status === 'gauntlet') actions.push({ kind: 'gauntlet', prd: p.number, title: p.title });
    else if (status === 'decompose') actions.push({ kind: 'decompose', prd: p.number, title: p.title, children: kids });
    else if (status === 'review') actions.push({ kind: 'review', prd: p.number, title: p.title, children: kids });
    else if (status === 'security') actions.push({ kind: 'security', prd: p.number, title: p.title, children: kids });
    else if (status === 'done') engine.push({ kind: 'close-prd', prd: p.number, secured: p.labels.includes(labels.secured) });
    // an open child filed without any lane label would hold its PRD forever: make it claimable
    if (status === 'building')
      for (const k of open)
        if (![labels.ready, labels.working, labels.blocked].some((l) => k.labels.includes(l)))
          engine.push({ kind: 'label-ready', issue: k.number, prd: p.number });
  }

  const inFlight = new Set([...busy].filter((k) => k.startsWith('issue:')).map((k) => Number(k.slice(6))));
  const rows = board(all, repo, labels, states, inFlight, inherited, opts.trusted, untrustedPrd,
    { triage: opts.bugTriage ?? true, prdChildren });
  const bugs = new Set(all.filter((i) => i.labels.includes(labels.bug) && !prdChildren.has(i.number)).map((i) => i.number));
  const triage: Action[] = [], bugImpl: Action[] = [], impl: Action[] = [];
  for (const r of rows)
    if (r.status === 'triage') triage.push({ kind: 'triage', issue: r.number, title: r.title });
    else if (r.status === 'claimable') (bugs.has(r.number) ? bugImpl : impl).push({ kind: 'impl', issue: r.number, title: r.title });
  return { actions: [...triage, ...bugImpl, ...actions, ...engine, ...impl], prds, board: rows, parents: Object.fromEntries(parentOf) };
}

/** Every ref the ready issues depend on that lives in another repo (resolved one by one). */
export function externalRefs(issues: Issue[], repo: string): Ref[] {
  const seen = new Map<string, Ref>();
  for (const i of issues)
    for (const r of parseBlockedBy(i.body, repo))
      if (r.repo.toLowerCase() !== repo.toLowerCase()) seen.set(refKey(r), r);
  return [...seen.values()];
}

/** First line of a triage session's verdict comment. */
export const TRIAGE_MARKER = '<!-- hx:triage -->';

/** A triage comment's verdict: the marker on line 1, then exactly `VERDICT: REPRODUCED` or `VERDICT: NEEDS-INFO`,
 *  or `VERDICT: FAILED…`, on the first non-empty line after it. Anything else is null. */
export function triageVerdict(body: string): 'REPRODUCED' | 'NEEDS-INFO' | 'FAILED' | null {
  const lines = (body ?? '').trimStart().split(/\r?\n/);
  if (lines[0].trim() !== TRIAGE_MARKER) return null;
  const v = lines.slice(1).map((l) => l.trim()).find((l) => l !== '');
  if (v === 'VERDICT: REPRODUCED' || v === 'VERDICT: NEEDS-INFO') return v.slice(9) as 'REPRODUCED' | 'NEEDS-INFO';
  return v?.startsWith('VERDICT: FAILED') ? 'FAILED' : null;
}

/** The plan's actions the pool may start: only the `--issue` targets, and while the gate is red only its
 *  fix issue (no triage either). */
export function claimable(actions: Action[], o: { only?: number[]; gateRed?: boolean; fixIssue?: number } = {}): Action[] {
  return actions.filter((a) => (!o.only || o.only.includes('issue' in a ? a.issue : a.prd))
    && (!o.gateRed || (a.kind === 'impl' && a.issue === o.fixIssue)));
}

export const PROMISE_RE = (promise: string) =>
  new RegExp(`<promise>\\s*${promise.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</promise>`);

/** Critic findings go into the reviser prompt between BEGIN/END markers: drop any marker line from the
 *  text so it cannot close the block early and pose as prompt text. */
export function fenceFindings(findings: string): string {
  return findings
    .split(/\r?\n/)
    .filter((l) => !/(BEGIN|END)\s+CRITIC\s+FINDINGS/i.test(l))
    .join('\n');
}

/** Substitute {{NAME}} placeholders; an unknown placeholder is left visible rather than silently blanked. */
export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}
