import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { run, runOk } from './exec.ts';

const GIT = process.env.HX_GIT_BIN || 'git';

export interface WorktreeSpec {
  name: string; // directory under the worktree root, e.g. i12 or p3
  branch: string;
  base: string;
  fresh: boolean; // read-only sessions (decompose, review) always start from the latest base
}

export const implWorktree = (issue: number, base: string): WorktreeSpec => ({ name: `i${issue}`, branch: `issue/${issue}`, base, fresh: false });
export const prdWorktree = (prd: number, base: string): WorktreeSpec => ({ name: `p${prd}`, branch: `hx/prd-${prd}`, base, fresh: true });

// Worktree commands of parallel workers write the same .git/config and index locks; run them one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/**
 * A worktree on `spec.branch` from origin/<base>. Unless `fresh`, an existing worktree on that branch
 * is reused, and a branch already on the remote (an earlier run pushed WIP) is continued.
 */
export function addWorktree(checkout: string, root: string, spec: WorktreeSpec): Promise<{ dir: string; resumed: boolean }> {
  return serial(() => addWorktreeNow(checkout, root, spec));
}

export function removeWorktree(checkout: string, dir: string): Promise<void> {
  return serial(() => removeWorktreeNow(checkout, dir));
}

async function addWorktreeNow(checkout: string, root: string, { name, branch, base, fresh }: WorktreeSpec): Promise<{ dir: string; resumed: boolean }> {
  const dir = path.join(root, name);
  mkdirSync(root, { recursive: true });
  // A worktree left by an interrupted run (Ctrl+C, usage limit) may hold uncommitted work: keep it.
  if (existsSync(dir)) {
    const head = await run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (!fresh && head.code === 0 && head.stdout.trim() === branch) return { dir, resumed: true };
    await removeWorktreeNow(checkout, dir);
  }
  const lp = await run(GIT, ['-C', checkout, 'config', '--get', 'core.longpaths']);
  if (lp.stdout.trim() !== 'true') await run(GIT, ['-C', checkout, 'config', 'core.longpaths', 'true']);
  await runOk(GIT, ['-C', checkout, 'fetch', '-q', 'origin', base]);
  const remote = fresh ? null : await run(GIT, ['-C', checkout, 'ls-remote', '--heads', 'origin', branch]);
  const resumed = !!remote && remote.code === 0 && remote.stdout.trim() !== '';
  if (resumed) await runOk(GIT, ['-C', checkout, 'fetch', '-q', 'origin', `${branch}:refs/remotes/origin/${branch}`]);
  await runOk(GIT, ['-C', checkout, 'worktree', 'add', '-f', '--no-track', '-B', branch, dir, resumed ? `origin/${branch}` : `origin/${base}`]);
  return { dir, resumed };
}

async function removeWorktreeNow(checkout: string, dir: string): Promise<void> {
  if (existsSync(dir)) {
    await run(GIT, ['-C', checkout, 'worktree', 'remove', '--force', dir]);
    // `worktree remove` leaves the dir behind when a process still holds a file open on Windows
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  await run(GIT, ['-C', checkout, 'worktree', 'prune']);
}
