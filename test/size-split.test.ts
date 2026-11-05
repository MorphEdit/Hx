// The writer both size-split paths share (PRD #300, #309): readDependents and fileSplit against the fake gh, in-process.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-sz-'));
const stateFile = path.join(tmp, 'board.json');
const ghLog = path.join(tmp, 'gh.log');
Object.assign(process.env, { HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_GH_LOG: ghLog });

const { fileSplit, readDependents } = await import('../src/pool.ts');
const { editBody } = await import('../src/github.ts');
const { parseBlockedBy, parseParent, trustedSet } = await import('../src/state.ts');

const R = 'me/app';
const READY = 'ready-for-agent';
const trusted = trustedSet('me');
const board = (issues: any[], extra = {}) => { writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues, ...extra })); writeFileSync(ghLog, ''); };
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issueOf = (n: number) => read().issues.find((i: any) => i.number === n);
const edits = () => readFileSync(ghLog, 'utf8').split('\n').filter((l) => l.startsWith('issue edit'));
const blockers = (n: number) => parseBlockedBy(issueOf(n).body, R).map((r) => r.number);
const issue = (n: number, body = '', extra = {}) => ({ number: n, title: `task ${n}`, body, state: 'OPEN', labels: [READY], ...extra });
const kids = [
  { title: 'Part a', body: 'Do a.', blockedBy: [] },
  { title: 'Part b', body: 'Do b.', blockedBy: [1] },
];

test('editBody: gh issue edit --body-file -, the body on stdin', E2E, async () => {
  board([issue(1, 'old')]);
  await editBody(R, 1, 'new body\n\n## Blocked by\nNone');
  assert.equal(issueOf(1).body, 'new body\n\n## Blocked by\nNone');
  assert.deepEqual(edits(), [`issue edit 1 -R ${R} --body-file -`]);
});

test('fileSplit: children in order, the second blocked by the first, parent #n, only the ready label', E2E, async () => {
  board([issue(10, 'Big.', { labels: [READY, 'agent-working', 'enhancement'] })]);
  const r = await fileSplit(R, READY, kids, { parent: 10, first: [], dependents: [] });
  assert.deepEqual(r, { filed: [11, 12] });
  const [a, b] = [issueOf(11), issueOf(12)];
  assert.equal(a.title, 'Part a');
  assert.equal(b.title, 'Part b');
  assert.equal(a.body, 'Do a.\n\n## Blocked by\nNone\n\n## Parent\n#10');
  assert.equal(b.body, 'Do b.\n\n## Blocked by\n#11\n\n## Parent\n#10');
  assert.deepEqual(blockers(11), []);
  assert.deepEqual(blockers(12), [11]);
  for (const x of [a, b]) {
    assert.equal(parseParent(x.body, R)?.number, 10);
    assert.deepEqual(x.labels, [READY]);
  }
});

test('fileSplit: first comes before the siblings; children with no blockers do not list each other', E2E, async () => {
  board([issue(20, 'Narrowed.')]);
  const three = [{ title: 'A', body: 'a', blockedBy: [] }, { title: 'B', body: 'b', blockedBy: [] }, { title: 'C', body: 'c', blockedBy: [2, 1] }];
  const r = await fileSplit(R, READY, three, { parent: 5, first: [20], dependents: [] });
  assert.deepEqual(r, { filed: [21, 22, 23] });
  assert.deepEqual(blockers(21), [20]);
  assert.deepEqual(blockers(22), [20]);
  assert.deepEqual(blockers(23), [20, 22, 21]);
  for (const n of [21, 22, 23]) assert.equal(parseParent(issueOf(n).body, R)?.number, 5);
});

test('readDependents + fileSplit: only open trusted same-repo dependents of #n get the children added', E2E, async () => {
  board([
    issue(30, 'Big.\n\n## Blocked by\n#30'),
    issue(31, 'Needs 30.\n\n## Blocked by\n#4\n#30\n\n## Parent\n#2'),
    issue(32, '## Blocked by\n#30', { state: 'CLOSED' }),
    issue(33, '## Blocked by\n#30', { author: 'stranger' }),
    issue(34, '## Blocked by\nother/repo#30'),
    issue(35, '## Blocked by\nNone'),
  ]);
  const dependents = await readDependents(R, 30, trusted);
  assert.deepEqual(dependents.map((d) => d.number), [31]);
  const before = read().issues;
  writeFileSync(ghLog, '');
  const r = await fileSplit(R, READY, kids, { parent: 30, first: [], dependents });
  assert.deepEqual(r, { filed: [36, 37] });
  assert.equal(issueOf(31).body, 'Needs 30.\n\n## Blocked by\n#4\n#30\n#36\n#37\n\n## Parent\n#2');
  assert.deepEqual(blockers(31), [4, 30, 36, 37]);
  assert.equal(parseParent(issueOf(31).body, R)?.number, 2);
  for (const n of [30, 32, 33, 34, 35]) assert.equal(issueOf(n).body, before.find((i: any) => i.number === n).body, `#${n} unchanged`);
  assert.deepEqual(edits(), [`issue edit 31 -R ${R} --body-file -`]);
});

test('fileSplit: the second create fails — filed is the first, failed names child 2, no dependent is edited', E2E, async () => {
  board([issue(40, 'Big.'), issue(41, '## Blocked by\n#40')], { createFails: 2 });
  const dependents = await readDependents(R, 40, trusted);
  assert.deepEqual(dependents.map((d) => d.number), [41]);
  const r = await fileSplit(R, READY, [...kids, { title: 'Part c', body: 'Do c.', blockedBy: [] }], { parent: 40, first: [], dependents });
  assert.deepEqual(r.filed, [42]);
  assert.equal(r.failed?.step, 'filing child 2');
  assert.match(r.failed?.error ?? '', /HTTP 502/);
  assert.deepEqual(read().issues.map((i: any) => i.number), [40, 41, 42]); // no child 3: no write after the failure
  assert.equal(issueOf(41).body, '## Blocked by\n#40');
  assert.deepEqual(edits(), []);
  assert.equal(read().createFails, undefined);
});

test('fileSplit: a dependent edit that fails stops the writes and names the dependent', E2E, async () => {
  board([issue(50, 'Big.'), issue(51, '## Blocked by\n#50'), issue(52, '## Blocked by\n#50')]);
  const dependents = [{ number: 99, body: '## Blocked by\n#50' }, ...(await readDependents(R, 50, trusted))];
  const r = await fileSplit(R, READY, kids, { parent: 50, first: [], dependents });
  assert.deepEqual(r.filed, [53, 54]);
  assert.equal(r.failed?.step, 'updating #99');
  assert.equal(issueOf(51).body, '## Blocked by\n#50');
  assert.equal(issueOf(52).body, '## Blocked by\n#50');
});
