// The size session (PRD #300): its reply parsed into a shape (fits / split / narrow), and the hx-size marker
// comments that record the result so an issue is sized once. Pure: no I/O.

/** Marker comments, matched as a comment's first line (`firstLineIs` in pool.ts). */
export const SIZE_FITS = '<!-- hx-size fits -->';
export const SIZE_SPLIT = '<!-- hx-size split -->';
export const SIZE_NARROWED = '<!-- hx-size narrowed -->';

/** `up-front` before the first impl claim; `after-timeout` once an impl turn timed out. */
export type SizeMode = 'up-front' | 'after-timeout';
/** One child issue; `blockedBy` holds the `k` of earlier `CHILD k` blocks. */
export type SizeChild = { title: string; body: string; blockedBy: number[] };
export type SizeReply =
  | { shape: 'fits' }
  | { shape: 'split'; children: SizeChild[] }
  | { shape: 'narrow'; scope: string; children: SizeChild[] };

const SHAPE = /^SIZE: (fits|split|narrow)$/;
const CHILD_HEADER = /^=== CHILD (\d+):\s*(.*)$/;
const BLOCKED_NONE = /^Blocked by: none$/;
const BLOCKED_CHILDREN = /^Blocked by: (child \d+(?:, child \d+)*)$/;
// hx appends the `## Blocked by` and `## Parent` trailers itself, so a body must not carry its own.
const TRAILER_HEADING = /^#{1,6}\s+(?:Blocked by|Parent)\b/im;

/** The child of a `=== CHILD k: title` block, or null when its `Blocked by:` line, title or body is wrong. */
function parseChild(k: number, title: string, lines: string[]): SizeChild | null {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || !title) return null;
  const line = lines[first].trim();
  let blockedBy: number[] = [];
  if (!BLOCKED_NONE.test(line)) {
    const m = BLOCKED_CHILDREN.exec(line);
    if (!m) return null;
    blockedBy = m[1].split(', ').map((r) => Number(r.slice('child '.length)));
    if (blockedBy.some((b) => b < 1 || b >= k)) return null;
  }
  const body = lines.slice(first + 1).join('\n').trim();
  if (!body || TRAILER_HEADING.test(body)) return null;
  return { title, body, blockedBy };
}

/** The size session's final reply, with `<promise>${promise}</promise>` removed; null when the reply is invalid. */
export function parseSizeReply(text: string, mode: SizeMode, promise: string): SizeReply | null {
  const lines = (text ?? '').split(`<promise>${promise}</promise>`).join('').split(/\r?\n/);
  let fence = false;
  let shape: 'fits' | 'split' | 'narrow' | null = null;
  const blocks: { header: string; lines: string[] }[] = [];
  for (const l of lines) {
    const outside = !fence;
    if (l.startsWith('```')) fence = !fence;
    if (outside && shape === null) {
      const m = SHAPE.exec(l.trim());
      if (m) shape = m[1] as 'fits' | 'split' | 'narrow';
      continue;
    }
    if (shape === null) continue;
    if (outside && l.startsWith('=== ')) blocks.push({ header: l.trim(), lines: [] });
    else blocks.at(-1)?.lines.push(l);
  }
  if (shape === 'fits') return mode === 'up-front' ? { shape } : null;
  if (shape === null || (shape === 'split') !== (mode === 'up-front')) return null;

  let scope: string | null = null;
  const children: SizeChild[] = [];
  for (const [i, b] of blocks.entries()) {
    if (b.header === '=== SCOPE') {
      if (shape !== 'narrow' || i !== 0) return null;
      scope = b.lines.join('\n').trim();
      if (!scope) return null;
      continue;
    }
    const m = CHILD_HEADER.exec(b.header);
    if (!m || Number(m[1]) !== children.length + 1) return null;
    const child = parseChild(children.length + 1, m[2].trim(), b.lines);
    if (!child) return null;
    children.push(child);
  }
  if (shape === 'split') return children.length >= 2 ? { shape, children } : null;
  return scope === null ? null : { shape, scope, children };
}
