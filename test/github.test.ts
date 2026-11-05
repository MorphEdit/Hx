// src/github.ts against the fake gh: what hx itself reads from GitHub.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const board = path.join(mkdtempSync(path.join(os.tmpdir(), 'hx-gh-')), 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = board;
const { openPrFor, hasAnyPrFor } = await import('../src/github.ts');

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
