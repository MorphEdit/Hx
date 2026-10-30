import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { issue } from './github.js';

const ROOT = path.resolve('scratch');

/** The scratch directory for issue `n`, named after its title so people can find it. */
export function scratchDir(repo, n) {
  const it = issue(repo, n);
  return path.join(ROOT, it.title.trim().toLowerCase().replace(/\s+/g, '-'));
}

export function makeScratch(repo, n) {
  const dir = scratchDir(repo, n);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove the scratch directory of issue `n` once it is closed. */
export function cleanScratch(repo, n) {
  rmSync(scratchDir(repo, n), { recursive: true, force: true });
}
