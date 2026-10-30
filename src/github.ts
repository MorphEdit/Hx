import { run, runOk } from './exec.ts';

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  author: string; // login of who opened it ('' = a deleted, "ghost" account)
}

const GH = process.env.HX_GH_BIN || 'gh';

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
  return (await runOk(GH, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd })).trim();
}

/** The account gh is logged in as. Throws when gh cannot tell: hx never runs with an empty trusted set. */
export async function ghLogin(): Promise<string> {
  const r = await run(GH, ['api', 'user', '-q', '.login']);
  const login = r.stdout.trim();
  if (r.code !== 0 || !login)
    throw new Error(`could not look up the gh login (gh api user${r.code !== 0 ? ` failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` : ' returned no login'}) — run  gh auth login  and try again`);
  return login;
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await runOk(GH, ['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])).trim();
}

/** Every issue, open and closed (closed children still count toward their PRD). PRs excluded. */
export async function listIssues(repo: string): Promise<Issue[]> {
  const out = await runOk(GH, ['issue', 'list', '-R', repo, '--state', 'all', '--limit', '1000',
    '--json', 'number,title,body,state,labels,author']);
  return JSON.parse(out).map(toIssue);
}

export async function issueLabels(repo: string, n: number): Promise<string[]> {
  const out = await runOk(GH, ['issue', 'view', String(n), '-R', repo, '--json', 'labels']);
  return toIssue({ number: n, ...JSON.parse(out) }).labels;
}

export async function issueBody(repo: string, n: number): Promise<string> {
  const out = await runOk(GH, ['issue', 'view', String(n), '-R', repo, '--json', 'body']);
  return JSON.parse(out).body ?? '';
}

/** The bodies of issue `n`'s comments written by a trusted account (lowercased logins: the gh login +
 *  config.trustedAuthors). A comment without an author (a deleted account) is untrusted. The set is required
 *  and must not be empty: hx's own logic (handoff note, round markers, verdicts) never reads a stranger's comment. */
export async function commentBodies(repo: string, n: number, trusted: Set<string>): Promise<string[]> {
  if (!trusted?.size) throw new Error('no trusted authors: refusing to read comments without the author filter');
  const out = await runOk(GH, ['issue', 'view', String(n), '-R', repo, '--json', 'comments']);
  return (JSON.parse(out).comments ?? [])
    .filter((c: any) => typeof c.author?.login === 'string' && trusted.has(c.author.login.toLowerCase()))
    .map((c: any) => c.body ?? '');
}

export async function createIssue(repo: string, title: string, body: string, labels: string[]): Promise<string> {
  const args = ['issue', 'create', '-R', repo, '--title', title, '--body-file', '-'];
  for (const l of labels) args.push('--label', l);
  return (await runOk(GH, args, { input: body })).trim();
}

/**
 * The open PR whose head is `branch` in `repo` itself, or null. `--head` matches the branch name only, so a
 * PR from a fork with a branch of the same name matches too: those are never ours and never taken.
 */
export async function openPrFor(repo: string, branch: string): Promise<number | null> {
  const r = await run(GH, ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository']);
  if (r.code !== 0) return null;
  try {
    const own = (JSON.parse(r.stdout) as { number: number; isCrossRepository: boolean }[]).find((p) => p.isCrossRepository === false);
    return own ? own.number : null;
  } catch { return null; }
}

export async function closeIssue(repo: string, n: number, commentBody: string): Promise<void> {
  await runOk(GH, ['issue', 'close', String(n), '-R', repo, '--comment', commentBody]);
}

/** number → state for every issue and PR in the repo (a `Blocked by` ref may name either). */
export async function allStates(repo: string): Promise<Map<number, 'OPEN' | 'CLOSED'>> {
  const out = await runOk(GH, ['api', '--paginate', `repos/${repo}/issues?state=all&per_page=100`,
    '-q', '.[] | [.number, .state] | @tsv']);
  const m = new Map<number, 'OPEN' | 'CLOSED'>();
  for (const line of out.split('\n')) {
    const [n, s] = line.trim().split('\t');
    if (n) m.set(Number(n), s === 'closed' ? 'CLOSED' : 'OPEN');
  }
  return m;
}

export async function issueState(repo: string, n: number): Promise<'OPEN' | 'CLOSED' | null> {
  const r = await run(GH, ['api', `repos/${repo}/issues/${n}`, '-q', '.state']);
  if (r.code !== 0) return null;
  return r.stdout.trim() === 'closed' ? 'CLOSED' : 'OPEN';
}

export async function editLabels(repo: string, n: number, add: string[], remove: string[] = []): Promise<void> {
  const args = ['issue', 'edit', String(n), '-R', repo];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  await runOk(GH, args);
}

export async function comment(repo: string, n: number, body: string): Promise<void> {
  // body via stdin: a long comment never hits the Windows command-line limit
  await runOk(GH, ['issue', 'comment', String(n), '-R', repo, '--body-file', '-'], { input: body });
}

export async function ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
  await run(GH, ['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
}
