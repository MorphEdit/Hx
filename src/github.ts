import { run, runOk } from './exec.ts';

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
}

const GH = process.env.HX_GH_BIN || 'gh';

function toIssue(raw: any): Issue {
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: String(raw.state ?? 'OPEN').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    labels: (raw.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
  };
}

export async function repoSlug(cwd: string): Promise<string> {
  return (await runOk(GH, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd })).trim();
}

export async function defaultBranch(repo: string): Promise<string> {
  return (await runOk(GH, ['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])).trim();
}

export async function listOpenIssues(repo: string): Promise<Issue[]> {
  const out = await runOk(GH, ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '500',
    '--json', 'number,title,body,state,labels']);
  return JSON.parse(out).map(toIssue);
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
