// hx issue end to end: the real CLI (bin/hx.mjs) with fake claude (issue role) and fake gh.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ic-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
const root = path.join(tmp, 'app');
mkdirSync(fakeDir);
mkdirSync(root);
saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'dev', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs') });

const wake = path.join(root, '.hx', 'wake');
const board = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const reset = () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
  for (const f of [wake, path.join(fakeDir, 'issue-args.json'), path.join(fakeDir, 'grill-args.json')]) rmSync(f, { force: true });
};
const issueFiles = () => readdirSync(path.join(root, '.hx', 'issues')).filter((f) => !f.endsWith('.prompt.md'));
const seen = () => JSON.parse(readFileSync(path.join(fakeDir, 'issue-args.json'), 'utf8'));
const BODY = '## What to do\nDo it.\n\n## Blocked by\nnone\n';
const NONE = 'no hx run is running — start it with  hx run --watch';
const ends = (out: string, tail: string) => assert.ok(out.replace(/\r\n/g, '\n').trimEnd().endsWith(tail), out);

function hx(args: string[], input = '', env: Record<string, string> = {}, cwd = root) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd, input, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_DIR: fakeDir, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('hx issue "idea" --yes: one ready-for-agent issue titled from the "# " line, no question, wake + closing line', E2E, () => {
  reset();
  const r = hx(['issue', 'fix the typo', '--yes']);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'Small task');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.ready]);
  assert.equal(issues[0].body, BODY);
  assert.doesNotMatch(r.out, /\[y\/N\]/);
  assert.match(r.out, /# Small task/); // the issue is shown
  ends(r.out, `filed https://github.com/me/app/issues/1\n${NONE}`);
  assert.doesNotMatch(r.out, /It will be/);
  assert.ok(existsSync(wake));
  // the session: issue.md (not grill.md) rendered with repo, base, idea and the issue script; trusted env
  const s = seen();
  assert.match(s.full, /^Role: issue/);
  for (const x of ['me/app', '`dev`', 'fix the typo', 'scripts/issue.mjs']) assert.ok(s.full.includes(x), x);
  assert.ok(!/\{\{\w+\}\}/.test(s.full), 'no placeholder left');
  assert.equal(s.trusted, 'me');
  assert.deepEqual(s.args.slice(0, 4), ['--model', DEFAULTS.model, '--effort', DEFAULTS.effort]);
  assert.ok(!existsSync(path.join(fakeDir, 'grill-args.json')), 'not a grill session');
  assert.ok(s.full.includes(path.join(root, '.hx', 'issues')), 'output under .hx/issues');
  assert.match(issueFiles().at(-1)!, /^\d{8}-\d{6}-issue\.md$/);
});

test('hx issue --bug --yes: label bug only, same title and body, triage closing line', E2E, () => {
  reset();
  const r = hx(['issue', 'it crashes', '--bug', '--yes']);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'Small task');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.bug]);
  assert.equal(issues[0].body, BODY);
  ends(r.out, `filed https://github.com/me/app/issues/1\nIt will be triaged. ${NONE}`);
  assert.ok(existsSync(wake));
  assert.ok(seen().full.includes('it crashes'));
});

test('without --yes: "n" files nothing and points at hx issue --file; "y" files', E2E, () => {
  reset();
  let r = hx(['issue', 'idea'], 'n\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /File this issue on me\/app\? \[y\/N\] /);
  assert.equal(board().issues.length, 0);
  assert.ok(!existsSync(wake));
  assert.ok(r.out.includes(path.join(root, '.hx', 'issues')), r.out);
  assert.match(r.out, /file it later with {2}hx issue --file/);

  r = hx(['issue', 'idea'], 'y\n');
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 1);
  assert.deepEqual(board().issues[0].labels, [DEFAULTS.labels.ready]);
  assert.ok(existsSync(wake));
});

test('session writes no issue (or only whitespace): exit 1, nothing filed', E2E, () => {
  reset();
  for (const v of ['1', 'blank']) {
    const r = hx(['issue', 'idea', '--yes'], '', { FAKE_GRILL_NOWRITE: v });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no issue written — nothing filed/);
    assert.equal(board().issues.length, 0);
    assert.ok(!existsSync(wake));
  }
});

test('hx issue --file: files without a session; --title keeps the body unchanged; --bug labels bug', E2E, () => {
  reset();
  const f = path.join(tmp, 'x.md');
  writeFileSync(f, '# From file\n\n## What to do\nThat.\n');
  let r = hx(['issue', '--file', f]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(path.join(fakeDir, 'issue-args.json')), 'no claude session');
  assert.equal(board().issues[0].title, 'From file');
  assert.equal(board().issues[0].body, '## What to do\nThat.\n');
  assert.deepEqual(board().issues[0].labels, [DEFAULTS.labels.ready]);
  ends(r.out, `filed https://github.com/me/app/issues/1\n${NONE}`);
  assert.ok(existsSync(wake));

  reset();
  r = hx(['issue', '--file', f, '--title', 'T', '--bug']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(path.join(fakeDir, 'issue-args.json')), 'no claude session');
  assert.equal(board().issues[0].title, 'T');
  assert.equal(board().issues[0].body, '# From file\n\n## What to do\nThat.\n');
  assert.deepEqual(board().issues[0].labels, [DEFAULTS.labels.bug]);
  ends(r.out, `filed https://github.com/me/app/issues/1\nIt will be triaged. ${NONE}`);
});

test('hx issue --file with no "# " line and no --title: no title error, nothing filed', E2E, () => {
  reset();
  const f = path.join(tmp, 'untitled.md');
  writeFileSync(f, 'just a body\n');
  const r = hx(['issue', '--file', f]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no title/);
  assert.equal(board().issues.length, 0);
  assert.ok(!existsSync(wake));
});

test('two sessions back to back get two files', E2E, () => {
  reset();
  const before = issueFiles().length;
  hx(['issue', 'a', '--yes']);
  hx(['issue', 'b', '--yes']);
  assert.equal(issueFiles().length, before + 2);
  assert.equal(board().issues.length, 2);
});

test('without hx init: the same error as hx grill', E2E, () => {
  const bare = mkdtempSync(path.join(os.tmpdir(), 'hx-ic-bare-'));
  const g = hx(['grill', 'x', '--yes'], '', {}, bare);
  const i = hx(['issue', 'x', '--yes'], '', {}, bare);
  assert.notEqual(i.code, 0);
  assert.equal(i.code, g.code);
  assert.equal(i.out, g.out);
});

test('hx help lists hx issue with its options', E2E, () => {
  const r = hx(['help']);
  assert.equal(r.code, 0);
  for (const s of ['issue [<idea.md> | "idea"] [--bug] [--yes] [--title T]', 'issue --file <file.md> [--bug] [--title T]'])
    assert.ok(r.out.includes(s), s);
});
