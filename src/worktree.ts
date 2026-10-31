import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
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
/** A read-only checkout of the implementer's pushed branch, for the auditor. */
export const auditWorktree = (issue: number): WorktreeSpec => ({ name: `a${issue}`, branch: `hx/audit-${issue}`, base: `issue/${issue}`, fresh: true });
export const prdWorktree =(prd: number, base: string): WorktreeSpec => ({ name: `p${prd}`, branch: `hx/prd-${prd}`, base, fresh: true });

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
  // a ship.mjs in another worktree may be fetching the same ref right now: retry the race
  for (let i = 1; ; i++) {
    const f = await run(GIT, ['-C', checkout, 'fetch', '-q', 'origin', base]);
    if (f.code === 0) break;
    if (i >= 4) throw new Error(`git fetch origin ${base} failed: ${f.stderr.trim()}`);
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
  const remote = fresh ? null : await run(GIT, ['-C', checkout, 'ls-remote', '--heads', 'origin', branch]);
  const resumed = !!remote && remote.code === 0 && remote.stdout.trim() !== '';
  if (resumed) await runOk(GIT, ['-C', checkout, 'fetch', '-q', 'origin', `${branch}:refs/remotes/origin/${branch}`]);
  await runOk(GIT, ['-C', checkout, 'worktree', 'add', '-f', '--no-track', '-B', branch, dir, resumed ? `origin/${branch}` : `origin/${base}`]);
  return { dir, resumed };
}

/** Deletes a worktree directory; replaceable so tests can simulate Windows holding a file open. */
export const worktreeFs = {
  removeDir: async (checkout: string, dir: string): Promise<void> => {
    await run(GIT, ['-C', checkout, 'worktree', 'remove', '--force', dir]);
    // `worktree remove` leaves the dir behind when a process still holds a file open on Windows
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  },
};

const warnStuck = (dir: string, e: any) =>
  console.log(`[${new Date().toLocaleTimeString()}] warning: could not remove ${dir} (in use?) — remove it by hand or it will be cleaned up next run (${e?.code ?? e?.message ?? e})`);

/** Cleanup: never throws, so a finished issue is never failed by a directory Windows still holds open. */
async function removeWorktreeNow(checkout: string, dir: string): Promise<void> {
  if (existsSync(dir)) {
    try { await worktreeFs.removeDir(checkout, dir); } catch (e) { warnStuck(dir, e); }
  }
  await run(GIT, ['-C', checkout, 'worktree', 'prune']);
}

const norm = (p: string) => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };

/**
 * Best effort, on start: delete directories under `root` that git no longer lists as worktrees
 * (left by a removal that failed). Listed worktrees stay: they may hold an interrupted session's work.
 */
export function cleanStaleWorktrees(checkout: string, root: string, owned: Iterable<string> = []): Promise<string[]> {
  return serial(async () => {
    if (!existsSync(root)) return [];
    await run(GIT, ['-C', checkout, 'worktree', 'prune']);
    const list = await run(GIT, ['-C', checkout, 'worktree', 'list', '--porcelain']);
    if (list.code !== 0) return [];
    const keep = new Set([...owned].map(norm));
    for (const m of list.stdout.matchAll(/^worktree (.+)$/gm)) keep.add(norm(m[1].trim()));
    const removed: string[] = [];
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const dir = path.join(root, e.name);
      if (!e.isDirectory() || keep.has(norm(dir))) continue;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); removed.push(dir); } catch (err) { warnStuck(dir, err); }
    }
    return removed;
  });
}

/** hx's branches whose loose ref is checked at startup, with the worktree name each one uses. */
export function hxBranch(branch: string): string | null {
  let m = /^issue\/(\d+)$/.exec(branch);
  if (m) return `i${m[1]}`;
  m = /^hx\/(prd|audit)-(\d+)$/.exec(branch);
  return m ? `${m[1] === 'prd' ? 'p' : 'a'}${m[2]}` : null;
}

export interface RefRepair { branch: string; repaired: boolean }

/**
 * On start: a loose ref of an hx branch (issue/N, hx/prd-N, hx/audit-N) that is not a sha (a crash
 * mid-write leaves NUL bytes) breaks every git command on it. Delete it; recreate it at origin/<branch>
 * as last fetched, else remove its worktree (nothing left to resume). Packed refs and hx/gate are never
 * touched. Never throws: each failure is logged.
 */
export function repairBrokenRefs(checkout: string, root: string, log: (msg: string) => void = console.log): Promise<RefRepair[]> {
  return serial(async () => {
    const out: RefRepair[] = [];
    let heads: string;
    try {
      const common = await runOk(GIT, ['-C', checkout, 'rev-parse', '--git-common-dir']);
      heads = path.join(path.resolve(checkout, common.trim()), 'refs', 'heads');
    } catch (e: any) { log(`could not check branch refs: ${e?.message ?? e}`); return out; }
    const loose: string[] = [];
    for (const dir of ['issue', 'hx']) {
      try {
        for (const e of readdirSync(path.join(heads, dir), { withFileTypes: true }))
          if (e.isFile() && hxBranch(`${dir}/${e.name}`)) loose.push(`${dir}/${e.name}`);
      } catch {} // no such directory: nothing to check
    }
    for (const branch of loose) {
      try {
        const file = path.join(heads, ...branch.split('/'));
        if (/^[0-9a-f]{40}\n?$/.test(readFileSync(file, 'latin1'))) continue;
        unlinkSync(file);
        const remote = await run(GIT, ['-C', checkout, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
        const sha = remote.code === 0 ? remote.stdout.trim() : '';
        if (sha) {
          await runOk(GIT, ['-C', checkout, 'update-ref', `refs/heads/${branch}`, sha]);
          log(`repaired broken ref ${branch} from origin/${branch}`);
        } else {
          log(`removed broken ref ${branch} — its unpushed work may be lost (see git fsck --lost-found)`);
          const dir = path.join(root, hxBranch(branch)!);
          if (existsSync(dir)) await removeWorktreeNow(checkout, dir);
        }
        out.push({ branch, repaired: !!sha });
        await run(GIT, ['-C', checkout, 'worktree', 'prune']);
      } catch (e: any) { log(`could not repair broken ref ${branch}: ${e?.message ?? e}`); }
    }
    return out;
  });
}
