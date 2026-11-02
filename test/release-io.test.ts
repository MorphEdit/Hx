// The I/O half of src/release.ts in process (#186): origin's tags and commits, the gh release helpers, the gate
// `hx release` uses, and release() with an injected gate and prompt (as the hx run integration will call it).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-relio-'));
const board = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = board;

const { DEFAULTS } = await import('../src/config.ts');
const { writeGate } = await import('../src/gate.ts');
const gh = await import('../src/github.ts');
const { dueRelease, firstParentCommits, originTags, release, releaseGate } = await import('../src/release.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const gitAt = (date: string, cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).trim();
const origin = path.join(tmp, 'origin.git'), root = path.join(tmp, 'app'), w = path.join(tmp, 'w');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, w);
writeFileSync(path.join(w, 'a.txt'), 'a\n');
git(w, 'add', '-A');
gitAt('2026-01-01T00:00:00Z', w, 'commit', '-q', '-m', 'feat: a (#1)');
gitAt('2026-01-02T00:00:00Z', w, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
writeFileSync(path.join(w, 'b.txt'), 'b\n');
git(w, 'add', '-A');
gitAt('2026-02-01T00:00:00Z', w, 'commit', '-q', '-m', 'fix: b (closes #2) (#3)', '-m', 'body line\n\ncloses #4');
git(w, 'tag', 'v0.1.1'); // lightweight: dated by its commit
git(w, 'tag', 'v1'); // not semver
git(w, 'push', '-q', '--tags', 'origin', 'HEAD:main');
git(tmp, 'clone', '-q', origin, root);
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), gateCommand: '' };
const paths = { root, stateDir };
const setBoard = (extra: object) => writeFileSync(board, JSON.stringify({ comments: [], prs: [], issues: [], ...extra }));
const releases = (): any[] => JSON.parse(readFileSync(board, 'utf8')).releases ?? [];

test('originTags: every tag with its date (tagger date, else commit date); firstParentCommits: subject and body', E2E, async () => {
  const tags = await originTags(root, 'main');
  const byName = Object.fromEntries(tags.map((t) => [t.name, Date.parse(t.date)]));
  assert.equal(byName['v0.1.0'], Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(byName['v0.1.1'], Date.parse('2026-02-01T00:00:00Z'));
  assert.ok('v1' in byName);
  assert.deepEqual(await firstParentCommits(root, 'refs/hx/tags/v0.1.0..origin/main'), [{ subject: 'fix: b (closes #2) (#3)', body: 'body line\n\ncloses #4' }]);
  assert.equal((await firstParentCommits(root, 'origin/main')).length, 2);
});

test('gh helpers: closed PRDs by label with closedAt and stateReason; release view found / not found / failing; create', E2E, async () => {
  setBoard({ issues: [
    { number: 5, title: 'PRD: X', body: '', state: 'CLOSED', labels: ['prd'], closedAt: '2026-03-01T00:00:00Z', stateReason: 'COMPLETED' },
    { number: 6, title: 'an issue', body: '', state: 'CLOSED', labels: [] },
    { number: 7, title: 'PRD: open', body: '', state: 'OPEN', labels: ['prd'] },
  ], releases: [{ tag: 'v0.1.0' }] });
  assert.deepEqual(await gh.closedWithLabel('me/app', 'prd'), [{ number: 5, title: 'PRD: X', closedAt: '2026-03-01T00:00:00Z', stateReason: 'COMPLETED' }]);
  assert.equal(await gh.releaseExists('me/app', 'v0.1.0'), true);
  assert.equal(await gh.releaseExists('me/app', 'v9.9.9'), false);
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, 'the notes\n');
  await gh.createRelease('me/app', 'v0.2.0', notes);
  const rel = releases().find((r) => r.tag === 'v0.2.0');
  assert.equal(rel.notes, 'the notes\n');
  assert.deepEqual(rel.args, ['release', 'create', 'v0.2.0', '-R', 'me/app', '--title', 'v0.2.0', '--notes-file', notes, '--latest', '--verify-tag']);
  setBoard({ releaseViewFails: true });
  await assert.rejects(gh.releaseExists('me/app', 'v0.1.0'), /gh release view v0\.1\.0 failed/);
});

test('dueRelease: minor for a PRD completed after the last tag; else due with no bump when that tag has no GitHub release', E2E, async () => {
  const prd = (closedAt: string, stateReason = 'COMPLETED') => ({ number: 5, title: 'PRD: X', body: '', state: 'CLOSED', labels: ['prd'], closedAt, stateReason });
  const now = new Date('2026-06-01T00:00:00Z');
  setBoard({ issues: [prd('2026-03-01T00:00:00Z')], releases: [{ tag: 'v0.1.1' }] });
  assert.deepEqual(await dueRelease(paths, config, now), { due: true, bump: 'minor' });
  setBoard({ issues: [prd('2026-03-01T00:00:00Z', 'NOT_PLANNED'), prd('2026-01-15T00:00:00Z')], releases: [{ tag: 'v0.1.1' }] });
  assert.deepEqual(await dueRelease(paths, config, now), { due: false, why: 'no PRD closed and no fix merged since v0.1.1' });
  setBoard({ issues: [] });
  assert.deepEqual(await dueRelease(paths, config, now), { due: true });
});

test('releaseGate: the recorded result for the head; else null with no command known', E2E, async () => {
  const lines: string[] = [];
  const head = git(origin, 'rev-parse', 'main');
  writeGate(stateDir, {});
  assert.equal(await releaseGate(paths, config, (m) => lines.push(m))(), null);
  const last = { sha: head, ok: true, command: 'npm test', output: '', at: '2026-03-01T00:00:00.000Z' };
  writeGate(stateDir, { last });
  assert.deepEqual(await releaseGate(paths, config, (m) => lines.push(m))(), last);
  writeGate(stateDir, { last: { ...last, sha: 'f'.repeat(40) } });
  assert.equal(await releaseGate(paths, config, (m) => lines.push(m))(), null, 'an older recorded result is not used');
});

test('release(): the injected gate decides; a declined prompt changes nothing; the outcome names the tag', E2E, async () => {
  // v0.1.1 has a release; v0.1.0 too (only the last tag is checked)
  setBoard({ releases: [{ tag: 'v0.1.1' }] });
  writeFileSync(path.join(w, 'c.txt'), 'c\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', 'feat: c (closes #8) (#9)');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  const head = git(origin, 'rev-parse', 'main');
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  let gated = 0;
  const gate = async () => { gated++; return { sha: head, ok: true, command: 'x', output: '', at: '' }; };
  const opts = { paths, config, yes: false, dryRun: false, gate, log };
  assert.deepEqual(await release({ ...opts, confirm: async () => false }), { code: 0 });
  assert.equal(gated, 0);
  assert.equal(git(origin, 'tag', '-l', 'v0.1.2'), '');
  assert.deepEqual(await release({ ...opts, gate: async () => null, confirm: async () => true }), { code: 1 });
  assert.ok(lines.includes('no gate command known: set gateCommand'), lines.join('\n'));
  const out = await release({ ...opts, confirm: async () => true });
  assert.deepEqual(out, { code: 0, released: 'v0.1.2', prds: [] });
  assert.equal(gated, 1);
  assert.equal(git(origin, 'rev-parse', 'v0.1.2^{commit}'), head);
  assert.equal(releases().find((r) => r.tag === 'v0.1.2').notes,
    '## Features\n- feat: c (#8, #9)\n\nFull diff: https://github.com/me/app/compare/v0.1.1...v0.1.2\n');
});
