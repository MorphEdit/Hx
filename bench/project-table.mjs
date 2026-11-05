// The "Project benchmark" table in docs/benchmark.md, built from the parsed bench/results/project-<arm>.json files.
// Pure: no I/O. bench/figures.mjs reads the files and writes docs/benchmark.md when the text changed.
// Fields read (as bench/project.mjs writes them): arm, passed, total, wallMs, tokens (a number or
// { total }), costUsd, sessions (by role: { impl: 3, … }, or a number), issuesClosed, issuesFiled,
// auditFails, gateReds, escapedDefects, capped. A null or missing value shows as –.

export const START = '<!-- project-bench:start -->';
export const END = '<!-- project-bench:end -->';

const DASH = '–';
const has = (v) => v !== null && v !== undefined;
const num = (v) => (has(v) ? String(v) : DASH);
const mins = (ms) => (has(ms) ? `${(ms / 60000).toFixed(1)} min` : DASH);
const tokTotal = (t) => (has(t) && typeof t === 'object' ? t.total : t);
const mtok = (t) => { const n = tokTotal(t); return has(n) ? `${(n / 1e6).toFixed(2)}M` : DASH; };
const usd = (c) => (has(c) ? `$${c.toFixed(2)}` : DASH);
const pair = (a, b) => (has(a) || has(b) ? `${num(a)}/${num(b)}` : DASH);
const yesNo = (b) => (has(b) ? (b ? 'yes' : 'no') : DASH);

/** Total sessions plus the per-role split, e.g. `9 (impl 6, review 3)`. */
function sessions(s) {
  if (!has(s)) return DASH;
  if (typeof s !== 'object') return String(s);
  const roles = Object.entries(s).filter(([, n]) => has(n));
  if (!roles.length) return DASH;
  const total = roles.reduce((a, [, n]) => a + n, 0);
  return `${total} (${roles.map(([r, n]) => `${r} ${n}`).join(', ')})`;
}

const HEADER = ['Arm', 'Hidden passed', 'Wall time', 'Tokens', 'Cost', 'Sessions', 'Issues closed/filed',
  'Audit FAILs', 'Gate reds', 'Escaped defects', 'Capped'];

const row = (r) => [num(r.arm), pair(r.passed, r.total), mins(r.wallMs), mtok(r.tokens), usd(r.costUsd),
  sessions(r.sessions), pair(r.issuesClosed, r.issuesFiled), num(r.auditFails), num(r.gateReds),
  num(r.escapedDefects), yesNo(r.capped)];

const line = (cells) => `| ${cells.join(' | ')} |`;

/** The markdown table, one row per arm. */
export function projectTable(results) {
  return [line(HEADER), line(HEADER.map(() => '---')), ...results.map((r) => line(row(r)))].join('\n');
}

/**
 * Replaces what is between the project-bench markers with the table. Returns the text unchanged when
 * there are no results or the markers are missing.
 */
export function updateReadme(readmeText, results) {
  if (!results || !results.length) return readmeText;
  const a = readmeText.indexOf(START);
  const b = a < 0 ? -1 : readmeText.indexOf(END, a + START.length);
  if (b < 0) return readmeText;
  const eol = readmeText.includes('\r\n') ? '\r\n' : '\n';
  const table = projectTable(results).replace(/\n/g, eol);
  return `${readmeText.slice(0, a + START.length)}${eol}${table}${eol}${readmeText.slice(b)}`;
}
