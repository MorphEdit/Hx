// The "Project benchmark" table in docs/benchmark.md: bench/project-table.mjs on in-memory text, and bench/figures.mjs
// run on a copy in a temp dir, so the repo's docs/benchmark.md and bench/results/ are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bench = path.join(root, 'bench');
const { updateReadme } = await import(pathToFileURL(path.join(bench, 'project-table.mjs')).href);

const START = '<!-- project-bench:start -->';
const END = '<!-- project-bench:end -->';
const before = '# Hx\n\n## Benchmark\n\n### Project benchmark\n\nIntro.\n\n';
const after = '\n\n### Real runs\n\nMore text.\n';
const withMarkers = `${before}${START}${END}${after}`;

const hx3 = {
  arm: 'hx3', passed: 84, failed: 3, total: 87, failures: ['a', 'b', 'c'], wallMs: 5_400_000,
  tokens: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, total: 12_340_000 }, costUsd: 41.5,
  sessions: { impl: 9, review: 2 }, issuesFiled: 10, issuesClosed: 9, auditFails: 2, gateReds: 1,
  escapedDefects: 3, ended: 'done', capped: false,
};
const chat = {
  arm: 'chat', passed: 60, failed: 27, total: 87, failures: [], wallMs: 14_400_000, tokens: 8_000_000,
  costUsd: 60.25, sessions: { chat: 1 }, issuesFiled: 0, issuesClosed: 0, auditFails: null, gateReds: null,
  escapedDefects: null, ended: 'capped', capped: true,
};
const HEADER = ['arm', 'hidden', 'wall', 'tokens', 'cost', 'sessions', 'issues', 'audit', 'gate', 'escaped', 'capped'];

/** The lines between the markers, split into cells. */
function tableRows(text: string) {
  const a = text.indexOf(START), b = text.indexOf(END);
  assert.ok(a >= 0 && b > a, 'markers still there, in order');
  const lines = text.slice(a + START.length, b).split(/\r?\n/).filter(Boolean);
  return lines.map((l) => { assert.match(l, /^\|.*\|$/); return l.slice(1, -1).split('|').map((c) => c.trim()); });
}

test('updateReadme with no results returns the text unchanged, with and without markers', () => {
  assert.equal(updateReadme(withMarkers, []), withMarkers);
  const plain = '# Hx\n\nNo markers here.\n';
  assert.equal(updateReadme(plain, []), plain);
});

test('updateReadme puts a header and one hx3 row between the markers; text outside is unchanged', () => {
  const out = updateReadme(withMarkers, [hx3]);
  assert.ok(out.startsWith(before + START));
  assert.ok(out.endsWith(END + after));
  const [header, sep, ...rows] = tableRows(out);
  assert.equal(header.length, 11);
  header.forEach((h, i) => assert.match(h.toLowerCase(), new RegExp(HEADER[i])));
  assert.ok(sep.every((c) => /^-+$/.test(c)));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['hx3', '84/87', '90.0 min', '12.34M', '$41.50', '11 (impl 9, review 2)', '9/10', '2', '1', '3', 'no']);
});

test('updateReadme with chat and hx3: one row per arm, null audit FAILs, gate reds and escaped defects as –', () => {
  const out = updateReadme(withMarkers, [chat, hx3]);
  assert.ok(out.startsWith(before + START) && out.endsWith(END + after));
  const [, , ...rows] = tableRows(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['chat', '60/87', '240.0 min', '8.00M', '$60.25', '1 (chat 1)', '0/0', '–', '–', '–', 'yes']);
  assert.equal(rows[1][0], 'hx3');
  // re-rendering replaces the old table rather than adding a second one
  assert.equal(updateReadme(out, [chat, hx3]), out);
  assert.equal(tableRows(updateReadme(out, [hx3])).length, 3);
});

test('updateReadme without the markers leaves the text unchanged even with results', () => {
  const plain = '# Hx\n\nNo markers here.\n';
  assert.equal(updateReadme(plain, [hx3]), plain);
});

test('docs/benchmark.md has the Project benchmark section, its table is what bench/results/project-*.json render, and the README links to it', () => {
  const readme = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8');
  const pb = readme.indexOf('\n## Project benchmark');
  const next = readme.indexOf('\n## ', pb + 1);
  assert.ok(pb >= 0 && next > pb, 'docs/benchmark.md has a Project benchmark section');
  assert.ok(readFileSync(path.join(root, 'README.md'), 'utf8').includes('](docs/benchmark.md)'), 'the README links to docs/benchmark.md');
  // the committed table is exactly what figures.mjs renders from the committed results (empty with none)
  const results = readdirSync(path.join(bench, 'results')).filter((f) => /^project-.+.json$/.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(path.join(bench, 'results', f), 'utf8')));
  assert.equal(updateReadme(readme, results), readme, 'the table matches bench/results/project-*.json; run node bench/figures.mjs');
  if (!results.length) assert.ok(readme.includes(START + END), 'markers adjacent');
  const part = readme.slice(pb, next);
  for (const s of ['tally', '80+ hidden tests', 'node bench/project.mjs chat', 'node bench/project.mjs hx3',
    '--max-hours', '--max-usd', 'node bench/figures.mjs', 'real usage', '4 h', '$60', 'private repo']) {
    assert.ok(part.includes(s), `Project benchmark part mentions ${s}`);
  }
  const lines = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('- `bench/`'));
  const block = lines.slice(at, at + 6).join('\n');
  assert.match(block, /project benchmark/);
  assert.match(block, /real usage/);
});

/** A copy of figures.mjs and its inputs in a temp dir: <tmp>/docs/benchmark.md, <tmp>/bench/... */
function figuresCopy(sixIssue: boolean) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-ptab-'));
  mkdirSync(path.join(dir, 'bench', 'results'), { recursive: true });
  for (const f of ['figures.mjs', 'project-table.mjs', 'issues.json']) copyFileSync(path.join(bench, f), path.join(dir, 'bench', f));
  if (sixIssue) for (const f of ['chat.json', 'hx1.json', 'hx3.json']) copyFileSync(path.join(bench, 'results', f), path.join(dir, 'bench', 'results', f));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'benchmark.md'), withMarkers);
  return dir;
}
const runFigures = (dir: string) => spawnSync(process.execPath, [path.join(dir, 'bench', 'figures.mjs')], { encoding: 'utf8' });

test('figures.mjs with no project results leaves docs/benchmark.md byte-identical and still draws the SVGs', () => {
  const dir = figuresCopy(true);
  const r = runFigures(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, 'docs', 'benchmark.md'), 'utf8'), withMarkers);
  assert.ok(readFileSync(path.join(dir, 'docs', 'figures', 'bench-summary.svg'), 'utf8').includes('<svg'));
});

test('figures.mjs renders project-*.json into docs/benchmark.md before it exits 1 for missing six-issue results', () => {
  const dir = figuresCopy(false);
  writeFileSync(path.join(dir, 'bench', 'results', 'project-hx3.json'), JSON.stringify(hx3));
  writeFileSync(path.join(dir, 'bench', 'results', 'project-chat.json'), JSON.stringify(chat));
  const r = runFigures(dir);
  assert.equal(r.status, 1);
  const out = readFileSync(path.join(dir, 'docs', 'benchmark.md'), 'utf8');
  assert.equal(out, updateReadme(withMarkers, [chat, hx3]));
  assert.equal(tableRows(out).length, 4);
});
