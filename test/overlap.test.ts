// hx overlap (#424, PRD #422): the pure matcher, then the real CLI (bin/hx.mjs) end to end with real git (a local
// bare origin, an i<N> impl worktree) and the fake gh.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';
import { normPath, overlapLines, type OverlapSource } from '../src/overlap.ts';
import { docsText } from './docs-text.ts';

const issue = (number: number, files: string[]): OverlapSource => ({ kind: 'issue', number, files });
const pr = (number: number, files: string[]): OverlapSource => ({ kind: 'pr', number, files });

test('normPath: \\ becomes /, a leading ./ is dropped, an absolute path under the root is made relative', () => {
  assert.equal(normPath('src\\a.ts'), 'src/a.ts');
  assert.equal(normPath('./src/a.ts'), 'src/a.ts');
  assert.equal(normPath('.\\src\\a.ts'), 'src/a.ts');
  const root = path.resolve(os.tmpdir(), 'app');
  assert.equal(normPath(path.join(root, 'src', 'a.ts'), root), 'src/a.ts');
});

test('overlapLines: \\ and ./ in the asked paths and in the sources match the same file', () => {
  assert.deepEqual(overlapLines(['src\\a.ts'], [pr(3, ['src/a.ts'])]), ['src/a.ts: PR #3']);
  assert.deepEqual(overlapLines(['./src/a.ts'], [issue(4, ['src/a.ts'])]), ['src/a.ts: issue #4']);
  assert.deepEqual(overlapLines(['src/a.ts'], [pr(5, ['src\\a.ts'])]), ['src/a.ts: PR #5']);
});

test('overlapLines: a path in an issue diff and a PR names both, the issue first', () => {
  assert.deepEqual(overlapLines(['src/a.ts'], [pr(9, ['src/a.ts']), issue(7, ['src/a.ts'])]), ['src/a.ts: issue #7, PR #9']);
});

test('overlapLines: each group in ascending number order (PR #9, PR #12)', () => {
  assert.deepEqual(overlapLines(['src/a.ts'], [pr(12, ['src/a.ts']), issue(30, ['src/a.ts']), pr(9, ['src/a.ts']), issue(7, ['src/a.ts'])]),
    ['src/a.ts: issue #7, issue #30, PR #9, PR #12']);
});

test('overlapLines: a path given twice (in any spelling) is reported once', () => {
  assert.deepEqual(overlapLines(['src/a.ts', 'src\\a.ts', './src/a.ts'], [pr(9, ['src/a.ts'])]), ['src/a.ts: PR #9']);
});

test('overlapLines: lines sorted by path in plain string order', () => {
  const src = [pr(1, ['b.ts', 'B.ts', 'a/z.ts', 'a.ts'])];
  assert.deepEqual(overlapLines(['b.ts', 'a/z.ts', 'B.ts', 'a.ts'], src), ['B.ts: PR #1', 'a.ts: PR #1', 'a/z.ts: PR #1', 'b.ts: PR #1']);
});

test('overlapLines: no overlap → empty', () => {
  assert.deepEqual(overlapLines(['src/x.ts'], [issue(7, ['src/a.ts']), pr(9, ['src/b.ts'])]), []);
  assert.deepEqual(overlapLines(['src/x.ts'], []), []);
});

// --- end to end ---
const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ov-'));
const stateFile = path.join(tmp, 'board.json'), ghLog = path.join(tmp, 'gh.log');
const origin = path.join(tmp, 'origin.git'), root = path.join(tmp, 'app'), wt = path.join(tmp, 'wt');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const L = DEFAULTS.labels;

git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
mkdirSync(path.join(root, 'src'));
for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(path.join(root, 'src', `${f}.ts`), `export const ${f} = 1;\n`);
git(root, 'add', '-A');
git(root, 'commit', '-q', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const exclude = path.join(root, '.git', 'info', 'exclude');
writeFileSync(exclude, readFileSync(exclude, 'utf8') + '/.hx/\n');
saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: wt });
// i7: agent-working; a.ts and c.ts committed on its branch, b.ts changed and not committed
git(root, 'worktree', 'add', '-q', '-b', 'issue/7', path.join(wt, 'i7'), 'origin/main');
for (const f of ['a', 'c']) writeFileSync(path.join(wt, 'i7', 'src', `${f}.ts`), `export const ${f} = 7;\n`);
git(path.join(wt, 'i7'), 'commit', '-q', '-am', 'work on 7');
writeFileSync(path.join(wt, 'i7', 'src', 'b.ts'), 'export const b = 7;\n');
// i8: its worktree changes d.ts, but #8 is not labelled agent-working
git(root, 'worktree', 'add', '-q', '-b', 'issue/8', path.join(wt, 'i8'), 'origin/main');
writeFileSync(path.join(wt, 'i8', 'src', 'd.ts'), 'export const d = 8;\n');

const issueOf = (number: number, labels: string[], state = 'OPEN') => ({ number, title: `task ${number}`, body: '', state, labels, author: 'me' });
const BOARD = {
  login: 'me', comments: [], labels: [],
  issues: [
    issueOf(7, [L.ready, L.working]),
    issueOf(8, [L.ready]),
    issueOf(9, [L.ready, L.working]), // no i9 worktree on this machine; its PR #12 is still checked
    issueOf(10, [L.working], 'CLOSED'),
  ],
  prs: [
    { number: 12, head: 'issue/9', state: 'OPEN', files: ['src/e.ts'] },
    { number: 13, head: 'feature/x', state: 'OPEN', files: ['src/a.ts', 'src/f.ts'] },
    { number: 14, head: 'patch-1', fork: true, state: 'OPEN', files: ['src/f.ts'] },
    { number: 5, head: 'old', state: 'MERGED', files: ['src/d.ts'] },
  ],
};
const reset = (extra: object = {}) => { writeFileSync(stateFile, JSON.stringify({ ...BOARD, ...extra })); writeFileSync(ghLog, ''); };

function hx(args: string[]) {
  const r = spawnSync(process.execPath, [HX, 'overlap', ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_GH_LOG: ghLog } });
  return { code: r.status, out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr };
}

test('hx overlap: a committed and an uncommitted change in an agent-working issue\'s i<N> worktree both count', E2E, () => {
  reset();
  let r = hx(['src/c.ts']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'src/c.ts: issue #7\n');
  r = hx(['src/b.ts']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'src/b.ts: issue #7\n');
});

test('hx overlap: a path in an open PR names it, whatever its head (feature/x, a fork, an issue without a worktree)', E2E, () => {
  reset();
  let r = hx(['src/f.ts']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'src/f.ts: PR #13, PR #14\n');
  r = hx(['src/e.ts']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'src/e.ts: PR #12\n');
});

test('hx overlap: a path in both an issue worktree and a PR is one line, the issue first', E2E, () => {
  reset();
  const r = hx(['src/a.ts']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'src/a.ts: issue #7, PR #13\n');
});

test('hx overlap: several paths in any spelling → one sorted line per overlapping path', E2E, () => {
  reset();
  const r = hx(['src\\f.ts', './src/a.ts', 'src/zzz.ts', 'src/a.ts']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, 'src/a.ts: issue #7, PR #13\nsrc/f.ts: PR #13, PR #14\n');
});

test('hx overlap: no overlap → "no overlap", exit 0 (a non-working issue\'s worktree and a merged PR are ignored)', E2E, () => {
  reset();
  const r = hx(['src/d.ts', 'src/zzz.ts']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out, 'no overlap\n');
});

test('hx overlap changes nothing: only issue list, pr list and pr diff calls; the board and the worktree are unchanged', E2E, () => {
  reset();
  const before = JSON.parse(readFileSync(stateFile, 'utf8')), status = git(path.join(wt, 'i7'), 'status', '--porcelain'), head = git(path.join(wt, 'i7'), 'rev-parse', 'HEAD');
  assert.equal(hx(['src/a.ts', 'src/b.ts', 'src/e.ts']).code, 1);
  const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c, /^(issue list|pr list|pr diff) /, c);
  assert.ok(calls.some((c) => /^pr list .*--state open/.test(c) && !c.includes('--head')), calls.join('\n'));
  assert.deepEqual(calls.filter((c) => c.startsWith('pr diff')).map((c) => c.split(' ')[2]).sort(), ['12', '13', '14']);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), before);
  assert.equal(git(path.join(wt, 'i7'), 'status', '--porcelain'), status);
  assert.equal(git(path.join(wt, 'i7'), 'rev-parse', 'HEAD'), head);
});

test('hx overlap: a failing gh call exits 2 with the error on stderr', E2E, () => {
  reset({ listFails: true });
  let r = hx(['src/a.ts']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /hx overlap: .*issue list.*Bad Gateway/s);
  assert.equal(r.out, '');
  reset({ prDiffFails: true });
  r = hx(['src/a.ts']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /pr diff.*Bad Gateway/s);
});

test('hx overlap: a failing git diff exits 2 with the error on stderr', E2E, () => {
  reset();
  const cfg = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'no-such-branch', worktreeRoot: wt };
  saveConfig(path.join(root, '.hx'), cfg);
  try {
    const r = hx(['src/a.ts']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /hx overlap: .*diff/);
  } finally { saveConfig(path.join(root, '.hx'), { ...cfg, defaultBranch: 'main' }); }
});

test('hx overlap with no path is a usage error; outside an hx project it exits 2', E2E, () => {
  reset();
  let r = hx([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: hx overlap <path>/);
  const r2 = spawnSync(process.execPath, [HX, 'overlap', 'src/a.ts'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /\.hx\/config\.json/);
});

test('hx overlap is documented: the guide section, the command list and hx help', () => {
  const guide = readFileSync(path.join(here, '..', 'docs', 'guide.md'), 'utf8');
  assert.match(guide, /^## Checking for overlap \(`hx overlap`\)/m);
  assert.match(guide, /^hx overlap src\/a\.ts/m);
  for (const s of ['no overlap', 'exit code 1', 'exit code 2', 'this machine']) assert.ok(guide.includes(s), s);
  assert.ok(docsText().includes('hx overlap'));
  const h = spawnSync(process.execPath, [HX, 'help'], { encoding: 'utf8' });
  assert.match(h.stdout, /overlap <path>\.\.\./);
});
