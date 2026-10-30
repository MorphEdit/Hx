import { execFileSync } from 'node:child_process';

/** Issue `n` of `repo` as { number, title, body, headRefName? } — read with gh, no shell. */
export function issue(repo, n) {
  const out = execFileSync('gh', ['issue', 'view', String(n), '-R', repo, '--json', 'number,title,body'], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** The open issues of `repo` with `label`. */
export function issuesWith(repo, label) {
  const out = execFileSync('gh', ['issue', 'list', '-R', repo, '--label', label, '--json', 'number,title'], { encoding: 'utf8' });
  return JSON.parse(out);
}
