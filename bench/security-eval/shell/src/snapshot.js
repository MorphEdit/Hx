import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { issue } from './github.js';

/** Write issue `n` to snapshots/<n>.md and commit it with the issue title in the message. */
export function snapshot(repo, n, cwd = process.cwd()) {
  const it = issue(repo, n);
  writeFileSync(`${cwd}/snapshots/${n}.md`, `# ${it.title}\n\n${it.body}\n`);
  execSync(`git add snapshots && git commit -q -m "snapshot #${n}: ${it.title}"`, { cwd });
}
