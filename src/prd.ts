// Filing a PRD or a bug: one markdown file → one issue. Shared by `hx prd`, `hx grill` and `hx bug`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Config } from './config.ts';
import * as gh from './github.ts';

/** File `file` as a PRD issue and return its URL. Title: `title` if given, else the first '# ' line (removed from the body). */
export async function filePrd(config: Config, file: string, title?: string): Promise<string> {
  let body = readFileSync(file, 'utf8');
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (!title && h1) { title = h1[1]; body = body.replace(h1[0], '').trimStart(); }
  if (!title) throw new Error('no title: pass --title or start the file with a "# Title" line');
  return gh.createIssue(config.repo, title, body, [config.labels.prd]);
}

/** The title of a bug: `title` if given, else the first '# ' line, else the first non-empty line, cut to 80 characters. */
export function bugTitle(body: string, title?: string): string {
  if (title) return title;
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  const line = h1 ? h1[1] : (body.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  if (!line) throw new Error('no title: pass --title or give the bug a first line');
  return line.slice(0, 80);
}

/** File a bug issue (label bug only, not ready-for-agent) from a file, or from `arg` itself when it is not a file. Returns its URL. */
export async function fileBug(config: Config, arg: string, title?: string): Promise<string> {
  const body = existsSync(arg) && statSync(arg).isFile() ? readFileSync(arg, 'utf8') : arg;
  return gh.createIssue(config.repo, bugTitle(body, title), body, [config.labels.bug]);
}
