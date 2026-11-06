// A git fixture built once per test file and copied for each test (#369): a copy is file I/O, where the init,
// clones, commit and pushes it replaces are a dozen git processes, each slow to start on a loaded machine.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A path with forward slashes: how a template's clones must name their origin, so the URL appears verbatim in
 *  their .git/config (git stores a backslash path escaped). */
export const fwd = (p: string): string => p.split(path.sep).join('/');

/** Copies `template` (a bare origin and clones of it, side by side) into `dest`, then points each clone named in
 *  `clones` at the copy's own origin. Every copy is a repo of its own: no test sees another's pushes. */
export function copyRepos(template: string, dest: string, clones: string[]): void {
  cpSync(template, dest, { recursive: true });
  for (const c of clones) {
    const file = path.join(dest, c, '.git', 'config');
    const text = readFileSync(file, 'utf8');
    if (!text.includes(fwd(template))) throw new Error(`${file}: no remote under ${fwd(template)} (clone with fwd(origin))`);
    writeFileSync(file, text.replaceAll(fwd(template), fwd(dest)));
  }
}
