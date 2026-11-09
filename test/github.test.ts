// src/github.ts against the fake gh: what hx itself reads from GitHub.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const board = path.join(mkdtempSync(path.join(os.tmpdir(), 'hx-gh-')), 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = board;
const { openPrFor, hasAnyPrFor, closeIssue, listOpenPrNumbers, prFiles } = await import('../src/github.ts');

const prs = (list: any[]) => writeFileSync(board, JSON.stringify({ comments: [], issues: [], prs: list }));

test('openPrFor: a fork PR from a branch of the same name is never taken', E2E, async () => {
  prs([{ number: 99, head: 'issue/7', state: 'OPEN', fork: true }]);
  assert.equal(await openPrFor('me/app', 'issue/7'), null);
  prs([{ number: 99, head: 'issue/7', state: 'OPEN', fork: true }, { number: 100, head: 'issue/7', state: 'OPEN' }]);
  assert.equal(await openPrFor('me/app', 'issue/7'), 100);
  prs([{ number: 100, head: 'issue/7', state: 'MERGED' }]);
  assert.equal(await openPrFor('me/app', 'issue/7'), null);
});

test('hasAnyPrFor: an own PR in any state counts (open, merged, closed); a fork PR or none does not', E2E, async () => {
  for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
    prs([{ number: 100, head: 'issue/7', state }]);
    assert.equal(await hasAnyPrFor('me/app', 'issue/7'), true, state);
  }
  prs([{ number: 99, head: 'issue/7', state: 'MERGED', fork: true }, { number: 101, head: 'issue/8', state: 'MERGED' }]);
  assert.equal(await hasAnyPrFor('me/app', 'issue/7'), false);
  prs([]);
  assert.equal(await hasAnyPrFor('me/app', 'issue/7'), false);
});

test('closeIssue: the comment is optional (a size split closes not planned without one); with one it is posted', E2E, async () => {
  const two = () => writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: [7, 8].map((number) => ({ number, title: 't', body: '', state: 'OPEN', labels: [] })) }));
  two();
  await closeIssue('me/app', 7, undefined, 'not planned');
  await closeIssue('me/app', 8, 'done here');
  const s = JSON.parse(readFileSync(board, 'utf8'));
  assert.deepEqual(s.issues.map((i: any) => [i.number, i.state, i.stateReason]), [[7, 'CLOSED', 'NOT_PLANNED'], [8, 'CLOSED', 'COMPLETED']]);
  assert.deepEqual(s.comments.map((c: any) => [c.issue, c.body]), [[8, 'done here']], 'no empty comment on #7');
});

test('listOpenPrNumbers: every open PR whatever its head (issue/<N>, hx/*, a person\'s branch, a fork); not merged or closed', E2E, async () => {
  prs([{ number: 1, head: 'issue/7', state: 'OPEN' }, { number: 2, head: 'hx/prd-3', state: 'OPEN' }, { number: 3, head: 'feature/x', state: 'OPEN' },
    { number: 4, head: 'patch-1', state: 'OPEN', fork: true }, { number: 5, head: 'issue/8', state: 'MERGED' }, { number: 6, head: 'y', state: 'CLOSED' }]);
  assert.deepEqual(await listOpenPrNumbers('me/app'), [1, 2, 3, 4]);
  prs([]);
  assert.deepEqual(await listOpenPrNumbers('me/app'), []);
});

test('prFiles: the paths gh pr diff --name-only lists; a failure throws', E2E, async () => {
  prs([{ number: 9, head: 'feature/x', state: 'OPEN', files: ['src/a.ts', 'docs/guide.md'] }, { number: 10, head: 'z', state: 'OPEN' }]);
  assert.deepEqual(await prFiles('me/app', 9), ['src/a.ts', 'docs/guide.md']);
  assert.deepEqual(await prFiles('me/app', 10), []);
  await assert.rejects(prFiles('me/app', 11), /pr diff 11 --name-only/);
});
