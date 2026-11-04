// Filing a PRD, an issue or a bug: one markdown file → one issue. Shared by `hx prd`, `hx grill`, `hx issue` and `hx bug`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Config } from './config.ts';
import * as gh from './github.ts';

/**
 * File `file` as an issue (labels: the PRD label unless given) and return its URL.
 * Title: `title` if given (body unchanged), else the first '# ' line (removed from the body).
 */
export async function filePrd(config: Config, file: string, title?: string, labels: string[] = [config.labels.prd]): Promise<string> {
  let body = readFileSync(file, 'utf8');
  const h1 = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (!title && h1) { title = h1[1]; body = body.replace(h1[0], '').trimStart(); }
  if (!title) throw new Error('no title: pass --title or start the file with a "# Title" line');
  return gh.createIssue(config.repo, title, body, labels);
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

export interface QualityBar { product: string; url: string; dimensions: string[] }

/** A PRD's `## Quality bar` section (`Beat: <product> — <URL>`, then `Judged on:` and `- ` bullets up to the
 *  next `## ` heading), or null when the body has none. `-` works in place of `—`. */
export function parseQualityBar(body: string): QualityBar | null {
  const h = /^##[ \t]+Quality bar[ \t]*$/im.exec(body ?? '');
  if (!h) return null;
  let section = body.slice(h.index + h[0].length);
  const next = /^##[ \t]+/m.exec(section);
  if (next) section = section.slice(0, next.index);
  const lines = section.split(/\r?\n/).map((l) => l.trim());
  const beat = lines.map((l) => /^Beat:\s*(.+?)\s+[—-]\s+(\S+)$/i.exec(l)).find((m) => m);
  const judged = lines.findIndex((l) => /^Judged on:?$/i.test(l));
  const dimensions = judged < 0 ? [] : lines.slice(judged + 1).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
  return { product: beat?.[1] ?? '', url: beat?.[2] ?? '', dimensions };
}
