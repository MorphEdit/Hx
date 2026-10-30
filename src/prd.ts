// Filing a PRD: one markdown file → one issue labelled prd. Shared by `hx prd` and `hx grill`.
import { readFileSync } from 'node:fs';
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
