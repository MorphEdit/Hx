// filePrd: the one path from a markdown file to a PRD issue (fake gh).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-prd-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;

const { bugTitle, fileBug, filePrd } = await import('../src/prd.ts');
const { DEFAULTS } = await import('../src/config.ts');

const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main' };
const board = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const md = (name: string, text: string) => { const f = path.join(tmp, name); writeFileSync(f, text); return f; };
const reset = () => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));

test('the first "# " line is the title and leaves the body', E2E, async () => {
  reset();
  const url = await filePrd(config, md('a.md', '# My title\n\n## Problem\nIt hurts.\n'));
  assert.equal(url, 'https://github.com/me/app/issues/1');
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'My title');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.prd]);
  assert.equal(issues[0].body, '## Problem\nIt hurts.\n');
});

test('a title argument overrides the "# " line', E2E, async () => {
  reset();
  await filePrd(config, md('b.md', '# Ignored\n\nbody\n'), 'X');
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'X');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.prd]);
});

test('no "# " line and no title: throws, nothing filed', E2E, async () => {
  reset();
  await assert.rejects(filePrd(config, md('c.md', 'just text\n## not h1\n')), /no title: pass --title/);
  assert.equal(board().issues.length, 0);
});

test('bugTitle: --title, else the "# " line, else the first non-empty line, cut to 80', E2E, () => {
  assert.equal(bugTitle('# Head\nx', 'T'), 'T');
  assert.equal(bugTitle('intro\n# Head\n'), 'Head');
  assert.equal(bugTitle('\n  first  \nsecond'), 'first');
  assert.equal(bugTitle('y'.repeat(81)), 'y'.repeat(80));
  assert.throws(() => bugTitle('  \n'), /no title/);
});

test('fileBug: a file is read, other text is the body; label bug only', E2E, async () => {
  reset();
  await fileBug(config, md('bug.md', '# Broken\n\nsteps\n'));
  await fileBug(config, 'not a file\nmore', 'Given');
  const { issues } = board();
  assert.equal(issues[0].title, 'Broken');
  assert.equal(issues[0].body, '# Broken\n\nsteps\n');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.bug]);
  assert.equal(issues[1].title, 'Given');
  assert.equal(issues[1].body, 'not a file\nmore');
  assert.deepEqual(issues[1].labels, [DEFAULTS.labels.bug]);
});
