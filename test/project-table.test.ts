// The "Project benchmark" table in docs/benchmark.md: bench/project-table.mjs on in-memory runs and text, and
// bench/figures.mjs run on a copy in a temp dir, so the repo's docs/benchmark.md and bench/results/ are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bench = path.join(root, 'bench');
const { updateReadme, projectTable, projectNotes } = await import(pathToFileURL(path.join(bench, 'project-table.mjs')).href);
const { loadRuns, resultFiles } = await import(pathToFileURL(path.join(bench, 'project-results.mjs')).href);

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
const HEADER = ['arm', 'n', 'hidden', 'fuzz divergences', 'fuzz classes', 'blind review', 'coverage', 'wall', 'tokens',
  'cost', 'sessions', 'issues', 'audit', 'gate', 'escaped', 'capped'];
const SINGLE = '1 (single run, supports no claim)';

/** A run as loadRuns returns it: an old single file (project-<arm>.json) by default, or run i of <arm>-<stamp>. */
function run(result: Record<string, unknown>, stamp?: string, i = 1) {
  const arm = result.arm as string;
  const name = stamp ? `${arm}-${stamp}-${i}.json` : `project-${arm}.json`;
  return { file: name, name, arm, stamp: stamp ?? name, i, result };
}
/** The set <arm>-<stamp>: one run per partial result, each on top of `base`, started at `startedAt` + i minutes. */
function set(base: Record<string, unknown>, stamp: string, startedAt: string, parts: Record<string, unknown>[]) {
  return parts.map((p, k) => run({ ...base, startedAt: new Date(Date.parse(startedAt) + k * 60_000).toISOString(), ...p }, stamp, k + 1));
}
/** The table's body rows (no header, no separator) as cells. */
const bodyRows = (runs: unknown[]) => tableRows(`${START}
${projectTable(runs)}
${END}`).slice(2);
/** The arm's row as { column name: cell }. */
function cellsOf(runs: unknown[], arm: string) {
  const [header, , ...rows] = tableRows(`${START}
${projectTable(runs)}
${END}`);
  const r = rows.find((x) => x[0] === arm);
  assert.ok(r, `a row for ${arm}`);
  return Object.fromEntries(header.map((h, k) => [h, r[k]]));
}

/** The lines between the markers, split into cells. */
function tableRows(text: string) {
  const a = text.indexOf(START), b = text.indexOf(END);
  assert.ok(a >= 0 && b > a, 'markers still there, in order');
  const lines = text.slice(a + START.length, b).split(/\r?\n/).filter((l) => l.startsWith('|'));
  return lines.map((l) => { assert.match(l, /^\|.*\|$/); return l.slice(1, -1).split('|').map((c) => c.trim()); });
}

test('updateReadme with no results returns the text unchanged, with and without markers', () => {
  assert.equal(updateReadme(withMarkers, []), withMarkers);
  const plain = '# Hx\n\nNo markers here.\n';
  assert.equal(updateReadme(plain, []), plain);
});

test('updateReadme puts a header and one hx3 row between the markers; text outside is unchanged', () => {
  const out = updateReadme(withMarkers, [run(hx3)]);
  assert.ok(out.startsWith(before + START));
  assert.ok(out.endsWith(END + after));
  const [header, sep, ...rows] = tableRows(out);
  assert.equal(header.length, 16);
  header.forEach((h, i) => assert.match(h.toLowerCase(), new RegExp(HEADER[i])));
  assert.ok(sep.every((c) => /^-+$/.test(c)));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['hx3', SINGLE, '84/87', '–', '–', '–', 'n/a', '90.0 min', '12.34M', '$41.50', '11 (impl 9, review 2)', '9/10', '2', '1', '3', 'no']);
});

test('updateReadme with chat and hx3: one row per arm, null audit FAILs, gate reds and escaped defects as –', () => {
  const out = updateReadme(withMarkers, [run(hx3), run(chat)]);
  assert.ok(out.startsWith(before + START) && out.endsWith(END + after));
  const [, , ...rows] = tableRows(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['chat', SINGLE, '60/87', '–', '–', '–', 'n/a', '240.0 min', '8.00M', '$60.25', '1 (chat 1)', '0/0', '–', '–', '–', 'yes']);
  assert.equal(rows[1][0], 'hx3');
  // re-rendering replaces the old table rather than adding a second one
  assert.equal(updateReadme(out, [run(chat), run(hx3)]), out);
  assert.equal(tableRows(updateReadme(out, [run(hx3)])).length, 3);
});

test('updateReadme without the markers leaves the text unchanged even with results', () => {
  const plain = '# Hx\n\nNo markers here.\n';
  assert.equal(updateReadme(plain, [run(hx3)]), plain);
});

test('docs/benchmark.md has the Project benchmark section, its table is what bench/results/ project runs render, and the README links to it', () => {
  const readme = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8');
  const pb = readme.indexOf('\n## Project benchmark');
  const next = readme.indexOf('\n## ', pb + 1);
  assert.ok(pb >= 0 && next > pb, 'docs/benchmark.md has a Project benchmark section');
  assert.ok(readFileSync(path.join(root, 'README.md'), 'utf8').includes('](docs/benchmark.md)'), 'the README links to docs/benchmark.md');
  // the committed table is exactly what figures.mjs renders from the committed results (empty with none)
  const results = loadRuns(resultFiles(path.join(bench, 'results')));
  assert.equal(updateReadme(readme, results), readme, 'the table matches the runs in bench/results/; run node bench/figures.mjs');
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
  for (const f of ['figures.mjs', 'project-table.mjs', 'project-results.mjs', 'issues.json']) copyFileSync(path.join(bench, f), path.join(dir, 'bench', f));
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
  assert.equal(out, updateReadme(withMarkers, [run(chat), run(hx3)]));
  assert.equal(tableRows(out).length, 4);
  // nothing changed: a second run leaves the file byte-identical
  runFigures(dir);
  assert.equal(readFileSync(path.join(dir, 'docs', 'benchmark.md'), 'utf8'), out);
});

const T0 = '2026-11-07T09:00:00Z';
const lean = ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local'];
const prov = (claudeVersion = '2.1.0', hxCommit = 'abc1234') => ({
  claudeVersion, hxCommit, roles: { chat: { model: 'claude-opus-5-5', effort: 'medium', flags: lean } },
});
const base = { ...chat, ended: 'done', capped: false, provenance: prov() };

test('every number is the median and the range: an odd count, an even count, equal runs without brackets', () => {
  const odd = set(base, 's1', T0, [{ passed: 145, wallMs: 60_000 * 50 }, { passed: 149, wallMs: 60_000 * 70 }, { passed: 147, wallMs: 60_000 * 60 }]);
  let c = cellsOf(odd, 'chat');
  assert.equal(c['Hidden passed'], '147 (145–149)/87');
  assert.equal(c['Wall time'], '60.0 min (50.0 min–70.0 min)');
  const even = set(base, 's1', T0, [{ passed: 140 }, { passed: 149 }, { passed: 145 }, { passed: 146 }]);
  c = cellsOf(even, 'chat');
  assert.equal(c['Hidden passed'], '145.5 (140–149)/87', 'the mean of the two middle values');
  assert.equal(c.n, '4');
  assert.equal(c.Cost, '$60.25', 'every run equal: no brackets');
});

test('a run without a value is left out of the cell; no value in any run shows – (n/a for coverage)', () => {
  const runs = set(base, 's1', T0, [{ auditFails: 1 }, { auditFails: null }, { auditFails: 'n/a' }, { auditFails: 5 }]);
  const c = cellsOf(runs, 'chat');
  assert.equal(c['Audit FAILs'], '3 (1–5)');
  assert.equal(c['Gate reds'], '–');
  assert.equal(c['Fuzz divergences'], '–');
  assert.equal(c['Blind review'], '–');
  assert.equal(c['Coverage lines/branches'], 'n/a');
  const na = set(base, 's1', T0, [{ coverage: { tests: 'none', lines: 'n/a', branches: 'n/a' } }, {}]);
  assert.equal(cellsOf(na, 'chat')['Coverage lines/branches'], 'n/a');
});

test('pair cells give each part its own median and range; Sessions is the total plus each role median', () => {
  const runs = set({ ...hx3, provenance: prov() }, 's1', T0, [
    { passed: 145, total: 149, issuesClosed: 4, issuesFiled: 5, sessions: { impl: 5, review: 2 } },
    { passed: 149, total: 149, issuesClosed: 5, issuesFiled: 5, sessions: { impl: 6, review: 3, security: 1 } },
    { passed: 147, total: 149, issuesClosed: 6, issuesFiled: 6, sessions: { impl: 8, review: 3 } },
  ]);
  const c = cellsOf(runs, 'hx3');
  assert.equal(c['Hidden passed'], '147 (145–149)/149');
  assert.equal(c['Issues closed/filed'], '5 (4–6)/5 (5–6)');
  // totals 7, 10, 11; a role a run did not start counts as 0 there
  assert.equal(c.Sessions, '10 (7–11) (impl 6, review 3, security 0)');
});

test('Capped is the number of capped runs, and yes / no with n=1', () => {
  const runs = set(base, 's1', T0, [{ capped: true }, { capped: false }, { capped: true }]);
  assert.equal(cellsOf(runs, 'chat').Capped, '2');
  assert.equal(cellsOf(set(base, 's1', T0, [{ capped: false }, { capped: false }]), 'chat').Capped, '0');
  assert.equal(cellsOf([run({ ...base, capped: true })], 'chat').Capped, 'yes');
  assert.equal(cellsOf([run({ ...base, capped: false })], 'chat').Capped, 'no');
});

test('Tokens and Cost include each run review halves', () => {
  const review = (costUsd: number, total: number) => ({ other: 'x.json', verdicts: [], tokens: { total }, costUsd });
  const runs = set(base, 's1', T0, [
    { tokens: { total: 1_000_000 }, costUsd: 1, reviews: [review(0.5, 200_000)] },
    { tokens: { total: 2_000_000 }, costUsd: 2, reviews: [review(0.25, 100_000), review(0.25, 100_000)] },
  ]);
  const c = cellsOf(runs, 'chat');
  assert.equal(c.Tokens, '1.70M (1.20M–2.20M)');
  assert.equal(c.Cost, '$2.00 ($1.50–$2.50)');
});

test('the n column, and "single run, supports no claim" on an n=1 row', () => {
  const runs = [...set(base, 's1', T0, [{}, {}, {}]), run({ ...hx3, provenance: prov() }, 's2', 1)];
  assert.equal(cellsOf(runs, 'chat').n, '3');
  assert.equal(cellsOf(runs, 'hx3').n, SINGLE);
});

test('a row is built from the arm newest set: an older set of the same arm does not change it', () => {
  const newer = set(base, 's2', '2026-11-08T09:00:00Z', [{ passed: 80 }, { passed: 82 }]);
  const older = set(base, 's1', T0, [{ passed: 10 }, { passed: 20 }, { passed: 30 }]);
  const oldFile = run({ ...chat, startedAt: '2026-11-01T00:00:00Z' });
  const alone = bodyRows(newer);
  assert.deepEqual(bodyRows([...older, oldFile, ...newer]), alone);
  assert.equal(alone.length, 1);
  assert.equal(cellsOf(newer, 'chat')['Hidden passed'], '81 (80–82)/87');
});

test('chat comes first, then the other arms by name', () => {
  const runs = [run({ ...hx3, arm: 'zz' }), run({ ...hx3 }), run({ ...chat })];
  assert.deepEqual(bodyRows(runs).map((r) => r[0]), ['chat', 'hx3', 'zz']);
});

test('the new columns: fuzz divergences, fuzz classes, blind review (one decimal) and coverage (whole percent)', () => {
  const fuzz = (divergences: number, classes: string[]) => ({
    seed: 1, count: 300, genHash: 'g1', divergences, classes: Object.fromEntries(classes.map((k) => [k, 1])),
  });
  const verdicts = (...values: number[]) => [{ other: 'x.json', verdicts: values.map((value) => ({ value })), tokens: { total: 0 }, costUsd: 0 }];
  const cov = (lc: number, bc: number) => ({ tests: 'passed', lines: { covered: lc, total: 200 }, branches: { covered: bc, total: 50 } });
  const runs = set(base, 's1', T0, [
    { fuzz: fuzz(4, ['a / stdout', 'b / exit status']), reviews: verdicts(7, 8), coverage: cov(170, 40) },
    { fuzz: fuzz(0, []), reviews: verdicts(6.5), coverage: { tests: 'failed', lines: 'n/a', branches: 'n/a' } },
    { fuzz: fuzz(10, ['a / stdout', 'c / stderr', 'd / stdout']), reviews: verdicts(9, 9), coverage: cov(181, 36) },
  ]);
  const c = cellsOf(runs, 'chat');
  assert.equal(c['Fuzz divergences'], '4 (0–10)');
  assert.equal(c['Fuzz classes'], '2 (0–3)');
  assert.equal(c['Blind review'], '7.5 (6.5–9.0)');
  // lines 85% and 90.5%, branches 80% and 72%; the failed run is left out
  assert.equal(c['Coverage lines/branches'], '88% (85%–91%)/76% (72%–80%)');
  assert.deepEqual(projectNotes(runs), [], 'one seed, count and hash, one config: no note');
});

test('config notes: a differing Claude Code version and judge model are named with their runs; a differing Hx commit is not', () => {
  const judge = (model: string) => [{ other: 'x.json', verdicts: [], tokens: { total: 0 }, costUsd: 0,
    judges: { role: 'judge', model, effort: 'medium', flags: [...lean, '--tools', 'Read', 'Glob', 'Grep'], claudeVersion: '2.1.0' } }];
  const runs = set(base, 's1', T0, [
    { provenance: prov('2.1.0', 'aaa'), reviews: judge('claude-opus-5-5') },
    { provenance: prov('2.2.0', 'bbb'), reviews: judge('claude-sonnet-5-5') },
    { provenance: prov('2.1.0', 'ccc'), reviews: judge('claude-opus-5-5') },
  ]);
  assert.deepEqual(projectNotes(runs), [
    '- Config differs, Claude Code version: `2.1.0` (chat-s1-1, chat-s1-3), `2.2.0` (chat-s1-2).',
    '- Config differs, judge model: `claude-opus-5-5` (chat-s1-1, chat-s1-3), `claude-sonnet-5-5` (chat-s1-2).',
  ]);
  const out = updateReadme(withMarkers, runs);
  assert.ok(out.includes('Claude Code version'), 'the notes are inside the markers');
  assert.ok(out.indexOf('judge model') < out.indexOf(END));
  assert.ok(!/commit|aaa|bbb/.test(projectNotes(runs).join('\n')), 'the Hx commit is not compared');
  const sameButCommit = set(base, 's1', T0, [{ provenance: prov('2.1.0', 'aaa') }, { provenance: prov('2.1.0', 'bbb') }]);
  assert.deepEqual(projectNotes(sameButCommit), []);
});

test('a differing role flag or effort is named; a run with no provenance is "config not recorded"', () => {
  const other = { ...prov(), roles: { chat: { model: 'claude-opus-5-5', effort: 'high', flags: [...lean, '--x'] } } };
  const runs = [...set(base, 's1', T0, [{}, { provenance: other }]), run({ ...hx3 })];
  const notes = projectNotes(runs);
  assert.ok(notes.includes('- Config differs, chat effort: `medium` (chat-s1-1), `high` (chat-s1-2).'), notes.join('\n'));
  assert.ok(notes.some((n) => n.startsWith('- Config differs, chat flags: ') && n.includes('--x')));
  assert.equal(notes.at(-1), '- Config not recorded: project-hx3.');
});

test('a note when the runs fuzz generator hashes differ; runs without fuzz are not compared', () => {
  const fuzz = (genHash: string) => ({ seed: 7, count: 300, genHash, divergences: 0, classes: {} });
  const runs = [...set(base, 's1', T0, [{ fuzz: fuzz('g1') }, {}]), ...set({ ...hx3, provenance: prov() }, 's2', T0, [{ fuzz: fuzz('g2') }])];
  assert.deepEqual(projectNotes(runs), [
    '- Fuzz not comparable: the runs do not share one seed, count and generator hash: generator hash `g1` (chat-s1-1), `g2` (hx3-s2-1).',
  ]);
  assert.ok(updateReadme(withMarkers, runs).includes('Fuzz not comparable'));
});

test('figures.mjs reads old single files and every bench/results/project/<arm>-<stamp>-<i>.json, newest set per arm', () => {
  const dir = figuresCopy(true);
  const results = path.join(dir, 'bench', 'results');
  writeFileSync(path.join(results, 'project-chat.json'), JSON.stringify({ ...chat, startedAt: '2026-11-01T00:00:00Z' }));
  writeFileSync(path.join(results, 'project-hx3.json'), JSON.stringify(hx3));
  mkdirSync(path.join(results, 'project'));
  for (const r of set(base, '202611070900', T0, [{ passed: 70 }, { passed: 74 }])) {
    writeFileSync(path.join(results, 'project', r.name), JSON.stringify(r.result));
  }
  const r = runFigures(dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(path.join(dir, 'docs', 'benchmark.md'), 'utf8');
  assert.equal(out, updateReadme(withMarkers, loadRuns(resultFiles(results))));
  const [, , ...rows] = tableRows(out);
  assert.deepEqual(rows.map((x) => [x[0], x[1], x[2]]), [['chat', '2', '72 (70–74)/87'], ['hx3', SINGLE, '84/87']]);
  assert.ok(out.includes('- Config not recorded: project-hx3.'));
  runFigures(dir);
  assert.equal(readFileSync(path.join(dir, 'docs', 'benchmark.md'), 'utf8'), out, 'nothing changed: byte-identical');
});

/** docs/benchmark.md's "Project benchmark" section, without the table figures.mjs renders, each run of white space one space. */
function projectProse() {
  const doc = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8');
  const at = doc.indexOf('## Project benchmark');
  assert.ok(at >= 0, 'docs/benchmark.md has a Project benchmark section');
  const end = doc.indexOf('\n## ', at + 1);
  const section = doc.slice(at, end < 0 ? undefined : end);
  return (section.slice(0, section.indexOf(START)) + section.slice(section.indexOf(END) + END.length)).replace(/\s+/g, ' ');
}

test('docs: the Project benchmark section explains each new column, n, the class count and why one run supports no claim (#407)', () => {
  const prose = projectProse();
  for (const col of ['**Fuzz divergences:**', '**Fuzz classes:**', '**Blind review:**', '**Coverage lines/branches:**', '**`n`:**']) {
    assert.ok(prose.includes(col), `the prose names the column ${col}`);
  }
  assert.match(prose, /not dominated by whichever bug the generator hits most often/);
  assert.match(prose, /supports no claim/);
  assert.match(prose, /20–40%/);
  assert.match(prose, /median/);
  assert.match(prose, /range/);
});

test('docs: the Project benchmark section lists each command with its cost, and the new results location (#407)', () => {
  const prose = projectProse();
  assert.match(prose, /node bench\/project\.mjs chat --runs 5/);
  assert.match(prose, /node bench\/project\.mjs hx3 --runs 5/);
  assert.match(prose, /node bench\/project-review\.mjs --all/);
  assert.match(prose, /6 judge sessions per pair/);
  assert.match(prose, /node bench\/shiprule\.mjs --baseline '[^']+' --change '[^']+'/);
  assert.match(prose, /node bench\/figures\.mjs/);
  assert.match(prose, /bench\/results\/project\/<arm>-<stamp>-<i>\.json/);
  assert.ok(!prose.includes('table below from `bench/results/project-*.json`'),
    'the old line about bench/results/project-*.json is gone');
  assert.match(prose, /provenance/);
  assert.match(prose, /judges/);
});

test('docs: the Project benchmark section explains the ship rule: its checks, exit 2 / 0 / 1, and that a cost win never makes a FAIL pass (#407)', () => {
  const prose = projectProse();
  assert.match(prose, /not enough runs/);
  assert.match(prose, /exits 2/);
  assert.match(prose, /PASS exits 0/);
  assert.match(prose, /FAIL exits 1/);
  assert.match(prose, /never makes a FAIL pass/);
  for (const check of ['at least 5 runs', 'hidden-test', 'fuzz class', 'new fuzz class', '0.5', 'escaped defects']) {
    assert.ok(prose.includes(check), `the ship rule names ${check}`);
  }
});

test('docs: the table in docs/benchmark.md is what figures.mjs renders from bench/results, and the First run text stays (#407)', () => {
  const doc = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8');
  assert.equal(updateReadme(doc, loadRuns(resultFiles(path.join(bench, 'results')))), doc);
  assert.ok(doc.includes('**First run, 2026-11-06** (`claude-opus-5-5`, medium effort, both arms):'));
});

test('CLAUDE.md: the bench/ line names the project benchmark files and the results location (#407)', () => {
  const md = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  const line = md.slice(md.indexOf('- `bench/`'), md.indexOf('\n- ', md.indexOf('- `bench/`') + 1));
  for (const f of ['project-fuzz-gen.mjs', 'project-fuzz.mjs', 'project-coverage.mjs', 'project-results.mjs', 'project-review.mjs', 'shiprule.mjs',
    'bench/results/project/<arm>-<stamp>-<i>.json']) {
    assert.ok(line.includes(f), `the bench/ line names ${f}`);
  }
});
