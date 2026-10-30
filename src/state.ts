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
  status: 'claimable' | 'working' | 'blocked-label' | 'waiting';
  waitingOn: Ref[]; // open blockers, for status === 'waiting'
}

/**
 * Classify every open ready issue. `states` maps refKey → state for every ref we could resolve;
 * an unresolvable ref counts as open (never start work on a dependency we cannot see).
 * Claimable rows come first, oldest issue first.
 */
export function board(issues: Issue[], repo: string, labels: Labels, states: Map<string, 'OPEN' | 'CLOSED'>,
  inFlight: Set<number> = new Set()): BoardRow[] {
  const rows: BoardRow[] = [];
  for (const i of issues) {
    if (i.state !== 'OPEN' || !i.labels.includes(labels.ready)) continue;
    let status: BoardRow['status'];
    let waitingOn: Ref[] = [];
    if (inFlight.has(i.number) || i.labels.includes(labels.working)) status = 'working';
    else if (i.labels.includes(labels.blocked)) status = 'blocked-label';
    else {
      waitingOn = parseBlockedBy(i.body, repo).filter((r) =>
        !(r.repo.toLowerCase() === repo.toLowerCase() && r.number === i.number) && states.get(refKey(r)) !== 'CLOSED');
      status = waitingOn.length ? 'waiting' : 'claimable';
    }
    rows.push({ number: i.number, title: i.title, status, waitingOn });
  }
  const rank = { claimable: 0, working: 1, waiting: 2, 'blocked-label': 3 } as const;
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.number - b.number);
}

/** Every ref the ready issues depend on that lives in another repo (resolved one by one). */
export function externalRefs(issues: Issue[], repo: string): Ref[] {
  const seen = new Map<string, Ref>();
  for (const i of issues)
    for (const r of parseBlockedBy(i.body, repo))
      if (r.repo.toLowerCase() !== repo.toLowerCase()) seen.set(refKey(r), r);
  return [...seen.values()];
}

export const PROMISE_RE = (promise: string) =>
  new RegExp(`<promise>\\s*${promise.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</promise>`);

/** Substitute {{NAME}} placeholders; an unknown placeholder is left visible rather than silently blanked. */
export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}
