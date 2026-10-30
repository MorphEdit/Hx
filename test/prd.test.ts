// filePrd: the one path from a markdown file to a PRD issue (fake gh).
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

const { filePrd } = await import('../src/prd.ts');
const { DEFAULTS } = await import('../src/config.ts');

const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main' };
const board = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const md = (name: string, text: string) => { const f = path.join(tmp, name); writeFileSync(f, text); return f; };
const reset = () => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));

test('the first "# " line is the title and leaves the body', async () => {
  reset();
  const url = await filePrd(config, md('a.md', '# My title\n\n## Problem\nIt hurts.\n'));
  assert.equal(url, 'https://github.com/me/app/issues/1');
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'My title');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.prd]);
  assert.equal(issues[0].body, '## Problem\nIt hurts.\n');
});

test('a title argument overrides the "# " line', async () => {
  reset();
  await filePrd(config, md('b.md', '# Ignored\n\nbody\n'), 'X');
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'X');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.prd]);
});

test('no "# " line and no title: throws, nothing filed', async () => {
  reset();
  await assert.rejects(filePrd(config, md('c.md', 'just text\n## not h1\n')), /no title: pass --title/);
  assert.equal(board().issues.length, 0);
});
