// The GitHub API budget: what `gh api rate_limit` reports, the line hx shows for it, and what kind of limit a
// failing gh call hit. Pure, no I/O, no imports: scripts/*.mjs import it as ../src/ghlimit.ts under plain node.

export interface Bucket {
  limit: number;
  remaining: number;
  reset: number; // epoch seconds
}

export interface GhBudget {
  core: Bucket;
  graphql: Bucket;
  at: string; // ISO time of the read
}

export type LimitKind = { kind: 'primary' } | { kind: 'secondary'; retryAfter?: number };

function bucket(raw: any): Bucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const { limit, remaining, reset } = raw;
  return [limit, remaining, reset].every((x) => typeof x === 'number' && Number.isFinite(x)) ? { limit, remaining, reset } : null;
}

/** The core and graphql buckets of `gh api rate_limit` output; null on bad JSON or a missing bucket. */
export function parseRateLimit(json: string, now = new Date()): GhBudget | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  const core = bucket(raw?.resources?.core), graphql = bucket(raw?.resources?.graphql);
  return core && graphql ? { core, graphql, at: now.toISOString() } : null;
}

const share = (b: Bucket) => (b.limit > 0 ? b.remaining / b.limit : 0);
/** Local `HH:MM` of an epoch-seconds time. */
export const hhmm = (epochSec: number) => {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** `github   core 4123/5000, graphql 4800/5000 (resets 22:41)`: the reset of the bucket with less left (a tie: core), local time. */
export function githubLine(b: GhBudget): string {
  const low = share(b.graphql) < share(b.core) ? b.graphql : b.core;
  return `github   core ${b.core.remaining}/${b.core.limit}, graphql ${b.graphql.remaining}/${b.graphql.limit} (resets ${hhmm(low.reset)})`;
}

/** The rate limit a failing gh call hit, from its stderr; null when it failed for another reason. */
export function classifyLimit(stderr: string): LimitKind | null {
  const s = String(stderr ?? '');
  if (/API rate limit exceeded/i.test(s)) return { kind: 'primary' };
  if (/secondary rate limit|abuse detection/i.test(s)) {
    const m = /Retry-After:\s*(\d+)/i.exec(s);
    return m ? { kind: 'secondary', retryAfter: Number(m[1]) } : { kind: 'secondary' };
  }
  return null;
}

export type Reserve = { low: false } | { low: true; bucket: 'core' | 'graphql'; remaining: number; limit: number; until: number /* ms epoch */ };

/** Budget-low when core or graphql has less than `pct` of its limit left; `until` = that bucket's reset (both: the later
 *  one, which `bucket` names). `pct <= 0` turns the reserve off. */
export function reserveState(b: GhBudget, pct: number): Reserve {
  if (!(pct > 0)) return { low: false };
  const below = (['core', 'graphql'] as const).filter((k) => share(b[k]) < pct);
  if (!below.length) return { low: false };
  const k = below.reduce((x, y) => (b[y].reset > b[x].reset ? y : x));
  return { low: true, bucket: k, remaining: b[k].remaining, limit: b[k].limit, until: b[k].reset * 1000 };
}
