// hx release end to end (#186, PRD #139 §B, §C): the real CLI (bin/hx.mjs), real git with a local bare origin,
// fake gh, and a fake gate command that records the sha it tested.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { writeGate } from '../src/gate.ts';
import { writeLive } from '../src/runstate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-rel-'));
const fwd = (p: string) => p.replace(/\\/g, '/');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const gitAt = (date: string, cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).trim();

// The gate: appends the sha it tests to argv[2]; red while argv[3] exists; when argv[4] exists, it first pushes a
// new commit to origin from the clone named in that file (the branch moves after the gate's checkout).
const gateScript = path.join(tmp, 'gate.mjs');
writeFileSync(gateScript, `import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [runs, red, move] = process.argv.slice(2);
appendFileSync(runs, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() + '\\n');
if (existsSync(move)) {
  const w = readFileSync(move, 'utf8').trim(); rmSync(move);
  writeFileSync(w + '/moved.txt', 'x\\n');
  execFileSync('git', ['-C', w, 'add', '-A']);
  execFileSync('git', ['-C', w, 'commit', '-q', '-m', 'feat: landed during the gate (#50)']);
  execFileSync('git', ['-C', w, 'push', '-q', 'origin', 'HEAD:main']);
}
process.exit(existsSync(red) ? 1 : 0);
`);
// HX_GIT_BIN: plain git, except that while HX_TEST_MOVE names an existing file, the first ls-remote (the head the
// release reads) moves origin's main right after answering — before the gate checks it out.
const gitWrap = path.join(tmp, 'git.mjs');
writeFileSync(gitWrap, `import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
const r = spawnSync('git', a, { stdio: 'inherit' });
const flag = process.env.HX_TEST_MOVE;
if (a.includes('ls-remote') && flag && existsSync(flag)) {
  const w = readFileSync(flag, 'utf8').trim(); rmSync(flag);
  writeFileSync(w + '/early.txt', 'x\\n');
  execFileSync('git', ['-C', w, 'add', '-A']);
  execFileSync('git', ['-C', w, 'commit', '-q', '-m', 'fix: landed before the gate (#51)']);
  execFileSync('git', ['-C', w, 'push', '-q', 'origin', 'HEAD:main']);
}
process.exit(r.status ?? 1);
`);

const TAG_DATE = '2026-01-01T00:00:00Z';
const PKG = '{\n  "name": "app",\n  "version": "0.1.0",\n    "private": true\n}\n';

interface Fixture { dir: string; origin: string; root: string; w: string; hxDir: string; board: string; runs: string; red: string; move: string }

/** origin with main at a tagged commit (v0.1.0, released), an hx checkout `root` and a second clone `w` for pushes. */
function fixture(o: { pkg?: boolean; gateCommand?: string; config?: object; board?: object; tag?: boolean } = {}): Fixture {
  const dir = mkdtempSync(path.join(tmp, 'f-'));
  const origin = path.join(dir, 'origin.git'), root = path.join(dir, 'app'), w = path.join(dir, 'w');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, w);
  writeFileSync(path.join(w, 'README.md'), 'app\n');
  if (o.pkg !== false) writeFileSync(path.join(w, 'package.json'), PKG);
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', 'feat: the start (#1)');
  if (o.tag !== false) gitAt(TAG_DATE, w, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  git(w, 'push', '-q', '--follow-tags', 'origin', 'HEAD:main');
  git(dir, 'clone', '-q', origin, root);
  const hxDir = path.join(root, '.hx');
  const f: Fixture = { dir, origin, root, w, hxDir, board: path.join(dir, 'board.json'), runs: path.join(dir, 'runs'), red: path.join(dir, 'RED'), move: path.join(dir, 'MOVE') };
  const gateCommand = o.gateCommand ?? `node "${fwd(gateScript)}" "${fwd(f.runs)}" "${fwd(f.red)}" "${fwd(f.move)}"`;
  saveConfig(hxDir, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(dir, 'wt'), gateCommand, ...o.config });
  const exclude = path.join(root, '.git', 'info', 'exclude');
  writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
  writeFileSync(f.board, JSON.stringify({ comments: [], prs: [], issues: [], releases: o.tag !== false ? [{ tag: 'v0.1.0' }] : [], ...o.board }));
  return f;
}

function commit(f: Fixture, subject: string, body = '') {
  writeFileSync(path.join(f.w, `c${Math.random().toString(36).slice(2)}.txt`), subject + '\n');
  git(f.w, 'add', '-A');
  git(f.w, 'commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
  git(f.w, 'push', '-q', 'origin', 'HEAD:main');
}

function hx(f: Fixture, args: string[], o: { input?: string; env?: object } = {}) {
  const r = spawnSync(process.execPath, [HX, 'release', ...args], { cwd: f.root, encoding: 'utf8', input: o.input ?? '',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: f.board, ...o.env } });
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\r\n/g, '\n') };
}

const og = (f: Fixture, ...a: string[]) => git(f.origin, ...a);
const originRefs = (f: Fixture) => og(f, 'for-each-ref', '--format=%(refname) %(objectname)');
const releases = (f: Fixture): any[] => JSON.parse(readFileSync(f.board, 'utf8')).releases ?? [];
const gateRuns = (f: Fixture) => (existsSync(f.runs) ? readFileSync(f.runs, 'utf8').trim().split('\n').filter(Boolean) : []);
const hasTag = (f: Fixture, t: string) => og(f, 'tag', '-l', t) === t;
const prd = (number: number, title: string, closedAt: string, stateReason = 'COMPLETED') =>
  ({ number, title, body: '', state: 'CLOSED', labels: ['prd'], closedAt, stateReason });

test('hx release --yes: package.json bumped and committed on main, annotated tag on it, release with the notes; minor with a closed PRD; then nothing to release', E2E, () => {
  const f = fixture({ config: { gate: false }, board: { issues: [
    prd(3, 'PRD: Widgets', '2026-06-01T00:00:00Z'),
    prd(2, 'PRD: Older', '2025-12-01T00:00:00Z'), // closed before v0.1.0
    prd(4, 'PRD: Dropped', '2026-06-02T00:00:00Z', 'NOT_PLANNED'),
  ] } });
  commit(f, 'feat: add a widget (closes #5) (#6)');
  commit(f, 'fix: handle empty input (closes #7) (#8)');
  commit(f, 'docs: explain widgets (#9)');
  const head = og(f, 'rev-parse', 'main');

  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /release v0\.2\.0: minor bump from 0\.1\.0, 3 PR\(s\) merged since v0\.1\.0/);
  assert.ok(r.out.includes('released v0.2.0'), r.out);
  // the gate ran (gate: false only turns off testing after merges) on the head, and main got the release commit on it
  assert.deepEqual(gateRuns(f), [head]);
  assert.equal(og(f, 'log', '-1', '--format=%s', 'main'), 'chore: release v0.2.0');
  assert.equal(og(f, 'rev-parse', 'main^'), head);
  assert.equal(og(f, 'show', 'main:package.json'), PKG.replace('0.1.0', '0.2.0').trim());
  assert.equal(og(f, 'cat-file', '-t', 'v0.2.0'), 'tag');
  assert.equal(og(f, 'rev-parse', 'v0.2.0^{commit}'), og(f, 'rev-parse', 'main'));
  const rel = releases(f).find((x) => x.tag === 'v0.2.0');
  assert.ok(rel, JSON.stringify(releases(f)));
  assert.equal(rel.title, 'v0.2.0');
  assert.ok(rel.latest && rel.args.includes('--notes-file'), JSON.stringify(rel.args));
  assert.equal(rel.notes, [
    'PRD #3: Widgets', '',
    '## Features', '- feat: add a widget (#5, #6)', '',
    '## Fixes', '- fix: handle empty input (#7, #8)', '',
    '## Docs', '- docs: explain widgets (#9)', '',
    'Full diff: https://github.com/me/app/compare/v0.1.0...v0.2.0', '',
  ].join('\n'));
  assert.ok(!existsSync(path.join(f.dir, 'wt', 'r')), 'the release worktree is removed');

  // the release commit alone is nothing to release
  const again = hx(f, ['--yes']);
  assert.equal(again.code, 0, again.out);
  assert.ok(again.out.includes('nothing to release since v0.2.0'), again.out);
  assert.equal(releases(f).length, 2);
  assert.equal(gateRuns(f).length, 1);
});

test('hx release --yes with no closed PRD: a patch bump; with no package.json the tag goes on the gated head itself', E2E, () => {
  const f = fixture({ pkg: false });
  commit(f, 'fix(gate): a fix (closes #11) (#12)');
  commit(f, 'chore: tidy (#13)');
  const head = og(f, 'rev-parse', 'main');
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(og(f, 'rev-parse', 'main'), head, 'no release commit without a package.json');
  assert.equal(og(f, 'cat-file', '-t', 'v0.1.1'), 'tag');
  assert.equal(og(f, 'rev-parse', 'v0.1.1^{commit}'), head);
  const rel = releases(f).find((x) => x.tag === 'v0.1.1');
  assert.equal(rel.notes, '## Fixes\n- fix(gate): a fix (#11, #12)\n\n## Other\n- chore: tidy (#13)\n\nFull diff: https://github.com/me/app/compare/v0.1.0...v0.1.1\n');
});

test('an explicit bump overrides the default; a prompt answered with anything but y/yes changes nothing', E2E, () => {
  const f = fixture();
  commit(f, 'fix: a fix (#12)');
  const before = originRefs(f);
  const no = hx(f, ['major'], { input: 'n\n' });
  assert.equal(no.code, 0, no.out);
  assert.ok(no.out.includes('Release v1.0.0? [y/N]'), no.out);
  assert.equal(originRefs(f), before);
  assert.equal(releases(f).length, 1);
  assert.deepEqual(gateRuns(f), [], 'no gate before the answer');
  const yes = hx(f, ['major'], { input: 'yes\n' });
  assert.equal(yes.code, 0, yes.out);
  assert.ok(hasTag(f, 'v1.0.0'), yes.out);
  assert.equal(hx(f, ['huge']).code, 1);
});

test('--dry-run: prints the plan and the recorded gate result, never runs the gate, changes nothing; also while a run is live', E2E, () => {
  const f = fixture({ board: { issues: [prd(3, 'PRD: Widgets', '2026-06-01T00:00:00Z')] } });
  commit(f, 'feat: add a widget (closes #5) (#6)');
  const before = originRefs(f);
  let r = hx(f, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('release v0.2.0: minor bump from 0.1.0, 1 PR(s) merged since v0.1.0'), r.out);
  assert.ok(r.out.includes('PRD #3: Widgets') && r.out.includes('- feat: add a widget (#5, #6)'), r.out);
  assert.match(r.out, /gate: no recorded result for main at [0-9a-f]{7}/);
  writeGate(f.hxDir, { last: { sha: og(f, 'rev-parse', 'main'), ok: true, command: 'npm test', output: '', at: new Date().toISOString() } });
  writeLive(f.hxDir, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  r = hx(f, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /gate: recorded green at [0-9a-f]{7} \(npm test\)/);
  assert.equal(originRefs(f), before);
  assert.equal(releases(f).length, 1);
  assert.deepEqual(gateRuns(f), []);
});

test('a live runner in live.json: --yes exits 3 before anything (no gate, no tag, no release)', E2E, () => {
  const f = fixture();
  commit(f, 'fix: a fix (#12)');
  writeLive(f.hxDir, { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 1, sessions: [] });
  const before = originRefs(f);
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 3, r.out);
  assert.ok(r.out.includes(`hx is already running for this repo (pid ${process.pid}): stop it first, or set autoRelease`), r.out);
  assert.equal(originRefs(f), before);
  assert.deepEqual(gateRuns(f), []);
  assert.equal(releases(f).length, 1);
});

test('red gate → exit 1 with its output, no tag, no release; no gate command → exit 1, no tag, no release', E2E, () => {
  const f = fixture();
  commit(f, 'fix: a fix (#12)');
  const before = originRefs(f);
  writeFileSync(f.red, 'x');
  let r = hx(f, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gate red on main at [0-9a-f]{7}/);
  assert.equal(gateRuns(f).length, 1);
  assert.equal(originRefs(f), before);
  assert.equal(releases(f).length, 1);

  const g = fixture({ gateCommand: '' });
  commit(g, 'fix: a fix (#12)');
  const before2 = originRefs(g);
  r = hx(g, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('no gate command known: set gateCommand'), r.out);
  assert.equal(originRefs(g), before2);
  assert.equal(releases(g).length, 1);
});

test('the recorded gate result for the head is used (no gate run); a red one stops the release', E2E, () => {
  const f = fixture({ gateCommand: '' }); // the learned command is not needed when the head is already gated
  commit(f, 'fix: a fix (#12)');
  const head = og(f, 'rev-parse', 'main');
  writeGate(f.hxDir, { last: { sha: head, ok: false, command: 'npm test', output: 'FAILED: test x', at: new Date().toISOString() } });
  let r = hx(f, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('FAILED: test x'), r.out);
  assert.ok(!hasTag(f, 'v0.1.1'));
  writeGate(f.hxDir, { last: { sha: head, ok: true, command: 'npm test', output: '', at: new Date().toISOString() } });
  r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(og(f, 'rev-parse', 'v0.1.1^{commit}^'), head);
  assert.deepEqual(gateRuns(f), []);
});

test('a gate run by hx release leaves gate.json unchanged (the learned command is used)', E2E, () => {
  const f = fixture({ gateCommand: '' });
  const learned = `node "${fwd(gateScript)}" "${fwd(f.runs)}" "${fwd(f.red)}" "${fwd(f.move)}"`;
  writeGate(f.hxDir, { command: learned, last: { sha: 'f'.repeat(40), ok: true, command: learned, output: '', at: '2026-01-02T00:00:00.000Z' } });
  const before = readFileSync(path.join(f.hxDir, 'gate.json'), 'utf8');
  commit(f, 'fix: a fix (#12)');
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(gateRuns(f).length, 1);
  assert.equal(readFileSync(path.join(f.hxDir, 'gate.json'), 'utf8'), before);
});

test('an origin hook rejecting the branch push: the tag goes on G alone, the release is made, no release commit on main', E2E, () => {
  const f = fixture();
  commit(f, 'fix: a fix (#12)');
  const hook = path.join(f.origin, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/*) echo "protected branch" >&2; exit 1;; esac; done\nexit 0\n');
  chmodSync(hook, 0o755);
  const head = og(f, 'rev-parse', 'main');
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`package.json was not bumped (push rejected): tagged v0.1.1 at ${head.slice(0, 7)}`), r.out);
  assert.equal(og(f, 'rev-parse', 'main'), head);
  assert.equal(og(f, 'cat-file', '-t', 'v0.1.1'), 'tag');
  assert.equal(og(f, 'rev-parse', 'v0.1.1^{commit}'), head);
  assert.ok(releases(f).some((x) => x.tag === 'v0.1.1'));
});

test('main moves after the gate checked it out: the tag is on the sha the gate tested, never the newer head', E2E, () => {
  const f = fixture();
  commit(f, 'fix: a fix (#12)');
  const head = og(f, 'rev-parse', 'main');
  writeFileSync(f.move, f.w);
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(gateRuns(f), [head]);
  assert.notEqual(og(f, 'rev-parse', 'main'), head, 'main moved');
  assert.equal(og(f, 'rev-parse', 'v0.1.1^{commit}'), head);
  assert.ok(r.out.includes('package.json was not bumped'), r.out);
  const rel = releases(f).find((x) => x.tag === 'v0.1.1');
  assert.ok(!rel.notes.includes('landed during the gate'), rel.notes);
});

test('main moves after the head is read but before the gate checkout: the tag is on the sha the gate tested', E2E, () => {
  const f = fixture();
  commit(f, 'fix: a fix (#12)');
  const read = og(f, 'rev-parse', 'main');
  const flag = path.join(f.dir, 'EARLY');
  writeFileSync(flag, f.w);
  const r = hx(f, ['--yes'], { env: { HX_GIT_BIN: gitWrap, HX_TEST_MOVE: flag } });
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(flag), 'the move happened');
  const [tested] = gateRuns(f);
  assert.notEqual(tested, read);
  assert.equal(og(f, 'rev-parse', `${tested}^`), read);
  assert.equal(og(f, 'rev-parse', 'v0.1.1^{commit}^'), tested, 'the release commit is a child of the gated sha');
  assert.ok(releases(f).find((x) => x.tag === 'v0.1.1').notes.includes('fix: landed before the gate (#51)'));
});

test('the last tag on origin has no release: only that release is made (no gate, no tag); run again → nothing to release', E2E, () => {
  const f = fixture({ board: { releases: [{ tag: 'v0.1.0' }], issues: [
    prd(3, 'PRD: In range', '2026-03-01T00:00:00Z'),
    prd(4, 'PRD: After the tag', '2026-06-01T00:00:00Z'),
    prd(2, 'PRD: Before', '2025-12-01T00:00:00Z'),
  ] } });
  commit(f, 'feat: a feature (closes #5) (#6)');
  commit(f, 'chore: release v0.1.0');
  gitAt('2026-04-01T00:00:00Z', f.w, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');
  git(f.w, 'tag', 'latest'); // not semver: ignored
  git(f.w, 'push', '-q', 'origin', 'v0.2.0', 'latest');
  const before = originRefs(f);
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('created the missing release v0.2.0'), r.out);
  assert.equal(originRefs(f), before, 'no new tag, no commit');
  assert.deepEqual(gateRuns(f), []);
  const rel = releases(f).find((x) => x.tag === 'v0.2.0');
  assert.ok(rel.latest);
  assert.equal(rel.notes, 'PRD #3: In range\n\n## Features\n- feat: a feature (#5, #6)\n\nFull diff: https://github.com/me/app/compare/v0.1.0...v0.2.0\n');
  const again = hx(f, ['--yes']);
  assert.equal(again.code, 0, again.out);
  assert.ok(again.out.includes('nothing to release since v0.2.0'), again.out);
  assert.equal(releases(f).filter((x) => x.tag === 'v0.2.0').length, 1);
});

test('no tag and only release commits: nothing to release since the start', E2E, () => {
  const f = fixture({ tag: false });
  git(f.w, 'commit', '-q', '--amend', '-m', 'chore: release v0.0.1');
  git(f.w, 'push', '-q', '-f', 'origin', 'HEAD:main');
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('nothing to release since the start'), r.out);
});

test('no tag: the version comes from package.json and the notes link the commits', E2E, () => {
  const f = fixture({ tag: false });
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(og(f, 'rev-parse', 'v0.1.1^{commit}'), og(f, 'rev-parse', 'main'));
  assert.ok(releases(f).find((x) => x.tag === 'v0.1.1').notes.endsWith('Full diff: https://github.com/me/app/commits/v0.1.1\n'));
});

test('hx help lists release', E2E, () => {
  const h = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.ok(h.stdout.includes('release [patch|minor|major] [--dry-run] [--yes]'), h.stdout);
});
test('gh release view failing for another reason than not-found: exit 1, nothing created', E2E, () => {
  const f = fixture({ board: { releases: [], releaseViewFails: true } });
  const before = originRefs(f);
  const r = hx(f, ['--yes']);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('gh release view v0.1.0 failed'), r.out);
  assert.equal(originRefs(f), before);
  assert.equal(releases(f).length, 0);
});
