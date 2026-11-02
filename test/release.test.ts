// Release helpers (#184, PRD #139): semver tags, bumps, fix detection, PRD titles and ranges, release notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotes, bump, compareSemver, currentVersion, isFix, isFixDue, isReleaseCommit, lastTag, noteLine, parseTag, prdDisplayTitle, prdsInRange, releaseDue, setPackageVersion, sortTags,
} from '../src/release.ts';

test('parseTag: only vX.Y.Z counts', () => {
  assert.deepEqual(parseTag('v1.2.3'), [1, 2, 3]);
  for (const t of ['latest', 'v1', 'v1.2', '1.2.3', 'v1.2.3-rc1', 'v1.2.3.4']) assert.equal(parseTag(t), null, t);
});

test('compareSemver / lastTag / sortTags: semver order, non-semver ignored, none when empty', () => {
  assert.ok(compareSemver([0, 10, 0], [0, 9, 3]) > 0);
  assert.equal(compareSemver([1, 2, 3], [1, 2, 3]), 0);
  assert.deepEqual(sortTags(['v0.10.0', 'latest', 'v0.9.3', 'v1', 'v0.1.0']), ['v0.1.0', 'v0.9.3', 'v0.10.0']);
  assert.equal(lastTag(['v0.1.0', 'v0.10.0', 'v0.9.3']), 'v0.10.0');
  assert.equal(lastTag(['latest', 'v1']), undefined);
  assert.equal(lastTag([]), undefined);
});

test('currentVersion: last tag, else package version, else 0.0.0', () => {
  assert.equal(currentVersion(['v0.1.0', 'v0.10.0', 'v0.9.3']), '0.10.0');
  assert.equal(currentVersion(['v0.1.0', 'v0.10.0', 'v0.9.3'], '9.9.9'), '0.10.0');
  assert.equal(currentVersion([], '0.4.2'), '0.4.2');
  assert.equal(currentVersion(['latest', 'v1'], '0.4.2'), '0.4.2');
  assert.equal(currentVersion([]), '0.0.0');
  assert.equal(currentVersion(['latest', 'v1']), '0.0.0');
});

test('bump: major / minor / patch from 0.x and 1.x', () => {
  assert.equal(bump('0.4.2', 'minor'), '0.5.0');
  assert.equal(bump('0.4.2', 'patch'), '0.4.3');
  assert.equal(bump('0.4.2', 'major'), '1.0.0');
  assert.equal(bump('1.9.7', 'minor'), '1.10.0');
  assert.equal(bump('1.9.7', 'patch'), '1.9.8');
  assert.equal(bump('1.9.7', 'major'), '2.0.0');
  assert.equal(bump('0.0.0', 'patch'), '0.0.1');
  assert.throws(() => bump('1.2', 'patch'));
});

test('isReleaseCommit: exactly chore: release vX.Y.Z', () => {
  assert.ok(isReleaseCommit('chore: release v1.2.3'));
  for (const s of ['chore: release v1.2', 'chore: release 1.2.3', 'chore: release v1.2.3 (#5)', 'chore(x): release v1.2.3']) assert.ok(!isReleaseCommit(s), s);
});

test('isFix / isFixDue', () => {
  assert.ok(isFix('fix: a'));
  assert.ok(isFix('fix(pool): a'));
  for (const s of ['feat: a', 'docs: a', 'chore: release v1.2.3', 'refactor: a', 'fixup: a', 'prefix: a']) assert.ok(!isFix(s), s);
  assert.ok(isFixDue(['feat: a', 'fix(x): b']));
  assert.ok(!isFixDue(['feat: a', 'docs: b', 'chore: release v1.2.3']));
  assert.ok(!isFixDue([]));
});

test('prdDisplayTitle strips a leading PRD: and trims', () => {
  assert.equal(prdDisplayTitle('PRD: A model and effort per role'), 'A model and effort per role');
  assert.equal(prdDisplayTitle('  Plain title '), 'Plain title');
});

test('prdsInRange: both bounds, completed only', () => {
  const prds = [
    { number: 1, title: 'PRD: one', closedAt: '2026-01-01T00:00:00Z', stateReason: 'COMPLETED' },
    { number: 2, title: 'PRD: two', closedAt: '2026-02-01T00:00:00Z', stateReason: 'COMPLETED' },
    { number: 3, title: 'PRD: three', closedAt: '2026-02-15T00:00:00Z', stateReason: 'NOT_PLANNED' },
    { number: 4, title: 'PRD: four', closedAt: '2026-03-01T00:00:00Z', stateReason: 'COMPLETED' },
    { number: 5, title: 'PRD: open', closedAt: null, stateReason: null },
  ];
  const nums = (a?: string, b?: string) => prdsInRange(prds, a, b).map((p) => p.number);
  assert.deepEqual(nums(), [1, 2, 4]);
  assert.deepEqual(nums('2026-01-01T00:00:00Z'), [2, 4]); // strictly after
  assert.deepEqual(nums('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'), [2]); // not after: inclusive
  assert.deepEqual(nums(undefined, '2026-02-28T00:00:00Z'), [1, 2]);
});

test('noteLine: PR suffix and closes #N folded into one parenthesis', () => {
  assert.equal(noteLine({ subject: 'fix: remove a stale setup record (closes #174) (#179)', body: '' }), '- fix: remove a stale setup record (#174, #179)');
  assert.equal(noteLine({ subject: 'feat: x (#179)', body: '' }), '- feat: x (#179)');
  assert.equal(noteLine({ subject: 'feat: x', body: '' }), '- feat: x');
  assert.equal(noteLine({ subject: 'feat: x (#12)', body: 'Closes #11\ncloses #11' }), '- feat: x (#11, #12)');
});

const commits = [
  { subject: 'feat: a model and effort per role (closes #130) (#140)', body: '' },
  { subject: 'chore: release v0.1.0', body: '' },
  { subject: 'feat(dashboard): a back link (closes #166) (#177)', body: 'details\n\nCloses #166' },
  { subject: 'fix: remove a stale setup record (closes #174) (#179)', body: '' },
  { subject: 'fix(pool): retry a stalled turn (#181)', body: 'This closes #180.' },
  { subject: 'docs: document worktree setup (closes #149) (#164)', body: '' },
  { subject: 'refactor: split the runner (#150)', body: '' },
  { subject: 'tidy up', body: '' },
];

test('buildNotes: PRD lines, sections in order, refs, release commit left out, compare URL', () => {
  const notes = buildNotes({
    repo: 'MorphEdit/Hx', commits, newTag: 'v0.2.0', previousTag: 'v0.1.0',
    prds: [{ number: 129, title: 'PRD: A model and effort per role' }, { number: 138, title: 'PRD: GitHub budget' }],
  });
  assert.equal(notes, [
    'PRD #129: A model and effort per role',
    'PRD #138: GitHub budget',
    '',
    '## Features',
    '- feat: a model and effort per role (#130, #140)',
    '- feat(dashboard): a back link (#166, #177)',
    '',
    '## Fixes',
    '- fix: remove a stale setup record (#174, #179)',
    '- fix(pool): retry a stalled turn (#180, #181)',
    '',
    '## Docs',
    '- docs: document worktree setup (#149, #164)',
    '',
    '## Other',
    '- refactor: split the runner (#150)',
    '- tidy up',
    '',
    'Full diff: https://github.com/MorphEdit/Hx/compare/v0.1.0...v0.2.0',
    '',
  ].join('\n'));
});

test('buildNotes: no PRDs, empty sections left out, commits URL with no previous tag', () => {
  const notes = buildNotes({ repo: 'MorphEdit/Hx', commits: [commits[1], commits[3]], prds: [], newTag: 'v0.1.0' });
  assert.equal(notes, '## Fixes\n- fix: remove a stale setup record (#174, #179)\n\nFull diff: https://github.com/MorphEdit/Hx/commits/v0.1.0\n');
});

test('setPackageVersion: only the version value changes, formatting kept; a missing version is added', () => {
  const pkg = '{\n  "name": "app",\n  "version": "0.1.0",\n    "private": true\n}\n';
  assert.equal(setPackageVersion(pkg, '0.2.0'), pkg.replace('0.1.0', '0.2.0'));
  assert.equal(setPackageVersion('{"version":"1.0.0","x":{"version":"9"}}', '1.1.0'), '{"version":"1.1.0","x":{"version":"9"}}');
  assert.equal(setPackageVersion('{\n  "name": "a"\n}\n', '0.0.1'), '{\n  "version": "0.0.1",\n  "name": "a"\n}\n');
});

test('releaseDue: a PRD closed since the last tag → minor, whatever the tag\'s age', () => {
  const now = new Date('2026-06-02T00:00:00Z');
  assert.deepEqual(releaseDue({ last: 'v0.1.0', lastDate: '2026-06-01T23:00:00Z', prdsSince: [3], subjects: [], patchHours: 24, now }), { due: true, bump: 'minor' });
});

test('releaseDue: patch once the last tag is older than patchHours (or there is none) and a fix merged since', () => {
  const now = new Date('2026-06-02T00:00:00Z');
  const old = '2026-05-31T23:00:00Z', fresh = '2026-06-01T01:00:00Z';
  const due = (subjects: string[], lastDate: string | undefined, patchHours = 24) =>
    releaseDue({ last: lastDate ? 'v0.1.0' : undefined, lastDate, prdsSince: [], subjects, patchHours, now });
  assert.deepEqual(due(['fix(parser): x (#2)'], old), { due: true, bump: 'patch' });
  assert.deepEqual(due(['fix: x (#2)', 'feat: y (#3)'], undefined), { due: true, bump: 'patch' });
  assert.equal(due(['fix: x (#2)'], fresh).due, false);
  assert.equal(due(['fix: x (#2)'], fresh, 12).due, true);
  assert.equal(due(['feat: y (#3)', 'docs: z (#4)', 'chore: w'], old).due, false);
  assert.equal(due(['chore: release v0.1.1'], old).due, false);
  assert.equal(due([], old).due, false);
});
