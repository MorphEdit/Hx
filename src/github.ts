import { run, type ExecResult } from './exec.ts';
import { classifyLimit, limitWaitMs, parseRateLimit, type GhBudget, type LimitKind } from './ghlimit.ts';

export { limitWaitMs };

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  author: string; // login of who opened it ('' = a deleted, "ghost" account)
}

const GH = process.env.HX_GH_BIN || 'gh';

// A gh call that hits a rate limit waits and retries only while a wait signal is set (a real `hx run`); unset, it
// fails at once as before. The wait ends early when the signal aborts, and then the call fails with its own error.
let waitSignal: AbortSignal | undefined;
let limitedListener: ((until: number, kind: LimitKind['kind']) => void) | undefined;
/** Set (or clear, with undefined) the signal under which a rate-limited gh call waits and retries. */
export function setGhWaitSignal(signal: AbortSignal | undefined): void { waitSignal = signal; }
/** Hear about each wait: `until` = its end (ms epoch). undefined clears the listener. */
export function onGhLimited(fn: ((until: number, kind: LimitKind['kind']) => void) | undefined): void { limitedListener = fn; }

/** Resolves true after ms, false as soon as the signal aborts. */
function waitOut(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(t); signal.removeEventListener('abort', aborted); resolve(ok); };
    const aborted = () => done(false);
    const t = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** One gh call; a rate-limited failure is waited out and retried while the wait signal is set. */
async function ghRun(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<ExecResult> {
  let streak = 0; // secondary limits in a row
  for (;;) {
    const r = await run(GH, args, opts);
    const signal = waitSignal;
    if (r.code === 0 || !signal) return r;
    const k = classifyLimit(r.stderr || r.stdout);
    if (!k) return r;
    streak = k.kind === 'secondary' ? streak + 1 : 0;
    const budget = k.kind === 'primary' ? await rateLimit() : null;
    const now = Date.now();
    const ms = limitWaitMs(k, budget, streak, now);
    try { limitedListener?.(now + ms, k.kind); } catch {}
    if (!(await waitOut(ms, signal))) return r;
  }
}

async function ghOk(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  const r = await ghRun(args, opts);
  if (r.code !== 0) throw new Error(`${GH} ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

function toIssue(raw: any): Issue {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: String(raw.state ?? 'OPEN').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    labels: (raw.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
    author: raw.author?.login ?? '',
  };
}

export async function repoSlug(cwd: string): Promise<string> {
  return (await ghOk(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd })).trim();
}

/** The account gh is logged in as. Throws when gh cannot tell: hx never runs with an empty trusted set. */
export async function ghLogin(): Promise<string> {
  const r = await ghRun(['api', 'user', '-q', '.login']);
  const login = r.stdout.trim();
  if (r.code !== 0 || !login)
    throw new Error(`could not look up the gh login (gh api user${r.code !== 0 ? ` failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` : ' returned no login'}) — run  gh auth login  and try again`);
  return login;
}

/** The API budget (`gh api rate_limit` is free: it does not count against it); null on any failure, never throws. */
export async function rateLimit(): Promise<GhBudget | null> {
  try {
    const r = await run(GH, ['api', 'rate_limit']);
    return r.code === 0 ? parseRateLimit(r.stdout) : null;
  } catch { return null; }
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await ghOk(['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])).trim();
}

/** Every issue, open and closed (closed children still count toward their PRD). PRs excluded. */
export async function listIssues(repo: string): Promise<Issue[]> {
  const out = await ghOk(['issue', 'list', '-R', repo, '--state', 'all', '--limit', '1000',
    '--json', 'number,title,body,state,labels,author']);
  return JSON.parse(out).map(toIssue);
}

export async function issueLabels(repo: string, n: number): Promise<string[]> {
  const out = await ghOk(['issue', 'view', String(n), '-R', repo, '--json', 'labels']);
  return toIssue({ number: n, ...JSON.parse(out) }).labels;
}

export async function issueBody(repo: string, n: number): Promise<string> {
  const out = await ghOk(['issue', 'view', String(n), '-R', repo, '--json', 'body']);
  return JSON.parse(out).body ?? '';
}

/** The bodies of issue `n`'s comments written by a trusted account (lowercased logins: the gh login +
 *  config.trustedAuthors). A comment without an author (a deleted account) is untrusted. The set is required
 *  and must not be empty: hx's own logic (handoff note, round markers, verdicts) never reads a stranger's comment. */
export async function commentBodies(repo: string, n: number, trusted: Set<string>): Promise<string[]> {
  if (!trusted?.size) throw new Error('no trusted authors: refusing to read comments without the author filter');
  const out = await ghOk(['issue', 'view', String(n), '-R', repo, '--json', 'comments']);
  return (JSON.parse(out).comments ?? [])
    .filter((c: any) => typeof c.author?.login === 'string' && trusted.has(c.author.login.toLowerCase()))
    .map((c: any) => c.body ?? '');
}

/** Issue `n`'s body and creation time with every comment's author, body and creation time (unfiltered: callers apply
 *  the trusted set, as ownerAnswer in question.ts does). A comment without an author has author ''. */
export async function issueThread(repo: string, n: number): Promise<{ body: string; createdAt: string; comments: { author: string; body: string; createdAt: string }[] }> {
  const raw = JSON.parse(await ghOk(['issue', 'view', String(n), '-R', repo, '--json', 'body,createdAt,comments']));
  return { body: raw.body ?? '', createdAt: raw.createdAt ?? '',
    comments: (raw.comments ?? []).map((c: any) => ({ author: typeof c.author?.login === 'string' ? c.author.login : '', body: c.body ?? '', createdAt: c.createdAt ?? '' })) };
}

export async function createIssue(repo: string, title: string, body: string, labels: string[]): Promise<string> {
  const args = ['issue', 'create', '-R', repo, '--title', title, '--body-file', '-'];
  for (const l of labels) args.push('--label', l);
  return (await ghOk(args, { input: body })).trim();
}

/**
 * The open PR whose head is `branch` in `repo` itself, or null. `--head` matches the branch name only, so a
 * PR from a fork with a branch of the same name matches too: those are never ours and never taken.
 */
export async function openPrFor(repo: string, branch: string): Promise<number | null> {
  const r = await ghRun(['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository']);
  if (r.code !== 0) return null;
  try {
    const own = (JSON.parse(r.stdout) as { number: number; isCrossRepository: boolean }[]).find((p) => p.isCrossRepository === false);
    return own ? own.number : null;
  } catch { return null; }
}

/**
 * Whether `branch` has a PR of its own in `repo` in any state (open, closed or merged). A failed list counts as
 * a PR: the caller treats "no PR" as the case that skips the audit, so an unknown answer must not.
 */
export async function hasAnyPrFor(repo: string, branch: string): Promise<boolean> {
  const r = await ghRun(['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', 'number,isCrossRepository']);
  if (r.code !== 0) return true;
  try {
    return (JSON.parse(r.stdout) as { isCrossRepository: boolean }[]).some((p) => p.isCrossRepository === false);
  } catch { return true; }
}

/** The open PR `gh pr view <branch>` finds, or null: the fallback when `gh pr list --head` does not list a fresh PR yet. */
export async function viewOpenPr(repo: string, branch: string): Promise<number | null> {
  const r = await ghRun(['pr', 'view', branch, '-R', repo, '--json', 'number,state']);
  if (r.code !== 0) return null;
  try {
    const pr = JSON.parse(r.stdout) as { number: number; state: string };
    return String(pr.state).toUpperCase() === 'OPEN' && typeof pr.number === 'number' ? pr.number : null;
  } catch { return null; }
}

export async function closeIssue(repo: string, n: number, commentBody: string, reason?: 'completed' | 'not planned'): Promise<void> {
  await ghOk(['issue', 'close', String(n), '-R', repo, '--comment', commentBody, ...(reason ? ['--reason', reason] : [])]);
}

/** number → state for every issue and PR in the repo (a `Blocked by` ref may name either). */
export async function allStates(repo: string): Promise<Map<number, 'OPEN' | 'CLOSED'>> {
  const out = await ghOk(['api', '--paginate', `repos/${repo}/issues?state=all&per_page=100`,
    '-q', '.[] | [.number, .state] | @tsv']);
  const m = new Map<number, 'OPEN' | 'CLOSED'>();
  for (const line of out.split('\n')) {
    const [n, s] = line.trim().split('\t');
    if (n) m.set(Number(n), s === 'closed' ? 'CLOSED' : 'OPEN');
  }
  return m;
}

export async function issueState(repo: string, n: number): Promise<'OPEN' | 'CLOSED' | null> {
  const r = await ghRun(['api', `repos/${repo}/issues/${n}`, '-q', '.state']);
  if (r.code !== 0) return null;
  return r.stdout.trim() === 'closed' ? 'CLOSED' : 'OPEN';
}

export async function editLabels(repo: string, n: number, add: string[], remove: string[] = []): Promise<void> {
  const args = ['issue', 'edit', String(n), '-R', repo];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  await ghOk(args);
}

/** Replace issue `n`'s body (via stdin: a long body never hits the Windows command-line limit). */
export async function editBody(repo: string, n: number, body: string): Promise<void> {
  await ghOk(['issue', 'edit', String(n), '-R', repo, '--body-file', '-'], { input: body });
}

export async function comment(repo: string, n: number, body: string): Promise<void> {
  // body via stdin: a long comment never hits the Windows command-line limit
  await ghOk(['issue', 'comment', String(n), '-R', repo, '--body-file', '-'], { input: body });
}

/** The names of every label in the repo. */
export async function listLabels(repo: string): Promise<Set<string>> {
  const out = await ghOk(['label', 'list', '-R', repo, '--limit', '1000', '--json', 'name', '-q', '.[].name']);
  return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
}

export async function ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
  await ghRun(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
}

export interface ClosedIssue { number: number; title: string; closedAt: string | null; stateReason: string | null }

/** The closed issues labelled `label` (closed PRDs for the release notes), with when and why they closed. */
export async function closedWithLabel(repo: string, label: string): Promise<ClosedIssue[]> {
  const out = await ghOk(['issue', 'list', '-R', repo, '--label', label, '--state', 'closed', '--limit', '1000',
    '--json', 'number,title,closedAt,stateReason']);
  return JSON.parse(out).map((r: any) => ({ number: r.number, title: r.title ?? '', closedAt: r.closedAt ?? null, stateReason: r.stateReason ?? null }));
}

/** Whether GitHub has a release for `tag`: false only when gh says it is not found; any other failure throws. */
export async function releaseExists(repo: string, tag: string): Promise<boolean> {
  const r = await ghRun(['release', 'view', tag, '-R', repo, '--json', 'tagName']);
  if (r.code === 0) return true;
  const err = (r.stderr || r.stdout).trim();
  if (/not found/i.test(err)) return false;
  throw new Error(`gh release view ${tag} failed (${r.code}): ${err.slice(0, 200)}`);
}

/** Creates the release for an existing tag, marked latest; the notes come from a file (never a shell or argv). */
export async function createRelease(repo: string, tag: string, notesFile: string): Promise<void> {
  await ghOk(['release', 'create', tag, '-R', repo, '--title', tag, '--notes-file', notesFile, '--latest', '--verify-tag']);
}

export interface IssueWithComments {
  number: number; state: 'OPEN' | 'CLOSED'; stateReason: string | null; createdAt: string; closedAt: string | null; body: string;
  labels: string[]; author: string; comments: { author: string; body: string; createdAt: string }[];
}

const ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number state stateReason createdAt closedAt body author { login } labels(first: 30) { nodes { name } }
        comments(first: 100) { nodes { author { login } body createdAt } } }
    }
  }
}`;

/** Every issue with its labels and comments: one GraphQL query, paged 50 issues at a time (not one call per issue). */
export async function issuesWithComments(repo: string): Promise<IssueWithComments[]> {
  const [owner, name] = repo.split('/');
  const out: IssueWithComments[] = [];
  for (let after: string | undefined; ;) {
    const page = JSON.parse(await ghOk(['api', 'graphql', '-f', `query=${ISSUES_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      ...(after ? ['-f', `after=${after}`] : [])]));
    const issues = page?.data?.repository?.issues;
    if (!issues) throw new Error(`gh api graphql: no issues in the answer for ${repo}`);
    for (const n of issues.nodes ?? []) out.push({
      number: n.number, state: String(n.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN', stateReason: n.stateReason ?? null,
      createdAt: n.createdAt ?? '', closedAt: n.closedAt ?? null, body: n.body ?? '', labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
      author: n.author?.login ?? '',
      comments: (n.comments?.nodes ?? []).map((c: any) => ({ author: c.author?.login ?? '', body: c.body ?? '', createdAt: c.createdAt ?? '' })),
    });
    if (!issues.pageInfo?.hasNextPage) return out;
    after = issues.pageInfo.endCursor;
  }
}

/** A PR from one of hx's `issue/<N>` branches in the repo itself (not a fork). */
export interface IssuePr { number: number; headRefName: string; mergeable?: string }

/** The open (with mergeable) or merged PRs whose head is an `issue/<N>` branch of the repo itself. */
export async function listIssuePrs(repo: string, state: 'open' | 'merged'): Promise<IssuePr[]> {
  const out = await ghOk(['pr', 'list', '-R', repo, '--state', state, '--limit', '1000',
    '--json', state === 'open' ? 'number,headRefName,mergeable,isCrossRepository' : 'number,headRefName,isCrossRepository']);
  return (JSON.parse(out) as any[]).filter((p) => p.isCrossRepository === false && /^issue\/\d+$/.test(p.headRefName ?? ''))
    .map((p) => ({ number: p.number, headRefName: p.headRefName, ...(p.mergeable !== undefined ? { mergeable: p.mergeable } : {}) }));
}

/** Closes PR `n` with a comment; its branch is kept (no --delete-branch). */
export async function closePr(repo: string, n: number, commentBody: string): Promise<void> {
  await ghOk(['pr', 'close', String(n), '-R', repo, '--comment', commentBody]);
}
