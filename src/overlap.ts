// hx overlap <path>...: which agent-working issues (their impl worktree's diff on this machine) and open PRs touch
// the given paths. Read-only: it lists issues and PRs and runs git diff, and never edits an issue, a PR or a worktree.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Project } from './config.ts';
import { runOk } from './exec.ts';
import { listIssues, listOpenPrNumbers, prFiles } from './github.ts';
import { implWorktree } from './worktree.ts';

const GIT = process.env.HX_GIT_BIN || 'git';

/** What one issue or PR touches: an issue's worktree diff, or a PR's changed files. */
export interface OverlapSource { kind: 'issue' | 'pr'; number: number; files: string[] }

/** A path as the repo sees it: `\` → `/`, a leading `./` dropped; an absolute path under `root` made relative to it. */
export function normPath(p: string, root?: string): string {
  let s = p.trim();
  if (root && (path.isAbsolute(s) || path.win32.isAbsolute(s))) s = path.relative(root, s);
  s = s.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/** The overlap lines, sorted by path: `<path>: issue #n, …, PR #m, …` (issues first, each group ascending). Pure. */
export function overlapLines(paths: string[], sources: OverlapSource[], root?: string): string[] {
  const asked = [...new Set(paths.map((p) => normPath(p, root)).filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [];
  for (const p of asked) {
    const by = (kind: OverlapSource['kind']) => [...new Set(sources.filter((s) => s.kind === kind && s.files.some((f) => normPath(f) === p))
      .map((s) => s.number))].sort((a, b) => a - b);
    const names = [...by('issue').map((n) => `issue #${n}`), ...by('pr').map((n) => `PR #${n}`)];
    if (names.length) lines.push(`${p}: ${names.join(', ')}`);
  }
  return lines;
}

/** The files issue `n`'s impl worktree differs in from origin/<base>, uncommitted changes to tracked files included;
 *  none when the worktree directory does not exist on this machine. */
async function worktreeFiles(worktreeRoot: string, n: number, base: string): Promise<string[]> {
  const dir = path.join(worktreeRoot, implWorktree(n, base).name);
  if (!existsSync(dir)) return [];
  const out = await runOk(GIT, ['-C', dir, '-c', 'core.quotePath=false', 'diff', '--name-only', `origin/${base}`]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Every source hx overlap checks: the open issues labelled labels.working, then every open PR of the repo. */
export async function overlapSources(p: Project): Promise<OverlapSource[]> {
  const c = p.config;
  const [issues, prs] = await Promise.all([listIssues(c.repo), listOpenPrNumbers(c.repo)]);
  const working = issues.filter((i) => i.state === 'OPEN' && i.labels.includes(c.labels.working));
  const root = path.resolve(p.root, c.worktreeRoot);
  const sources: OverlapSource[] = [];
  for (const i of working) sources.push({ kind: 'issue', number: i.number, files: await worktreeFiles(root, i.number, c.defaultBranch) });
  // a few PR diffs at a time: a board with many open PRs does not start one gh per PR at once
  for (let k = 0; k < prs.length; k += 4) {
    const batch = prs.slice(k, k + 4);
    const files = await Promise.all(batch.map((m) => prFiles(c.repo, m)));
    batch.forEach((m, j) => sources.push({ kind: 'pr', number: m, files: files[j] }));
  }
  return sources;
}

/** hx overlap's lines for `paths` (relative to the repo root); [] = no overlap. */
export async function overlap(p: Project, paths: string[]): Promise<string[]> {
  return overlapLines(paths, await overlapSources(p), p.root);
}
