import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { issue } from './github.js';

/** Write issue `n` to snapshots/<n>.md and commit it with the issue title in the message. */
export function snapshot(repo, n, cwd = process.cwd()) {
  const it = issue(repo, n);
  const num = Number(it.number);
  if (!Number.isInteger(num) || num <= 0) throw new Error(`bad issue number ${it.number}`);
  mkdirSync(path.join(cwd, 'snapshots'), { recursive: true });
  writeFileSync(path.join(cwd, 'snapshots', `${num}.md`), `# ${it.title}\n\n${it.body}\n`);
  execFileSync('git', ['add', 'snapshots'], { cwd });
  // the message goes through stdin: no shell, and a title starting with '-' is not an option
  execFileSync('git', ['commit', '-q', '-F', '-'], { cwd, input: `snapshot #${num}: ${it.title}\n` });
}
