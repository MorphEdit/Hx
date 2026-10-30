// hx grill end to end: the real CLI (bin/hx.mjs) with fake claude (grill role) and fake gh.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const HX = path.join(here, '..', 'bin', 'hx.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-gc-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
const root = path.join(tmp, 'app');
mkdirSync(fakeDir);
mkdirSync(root);
saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'dev', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs') });

const board = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const reset = () => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [] }));
const prds = () => readdirSync(path.join(root, '.hx', 'prds')).filter((f) => !f.endsWith('.prompt.md'));
const grillSeen = () => JSON.parse(readFileSync(path.join(fakeDir, 'grill-args.json'), 'utf8'));

function hx(args: string[], input = '', env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd: root, input, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_DIR: fakeDir, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('hx grill "idea" --yes: one prd issue titled from the "# " line, exit 0', E2E, () => {
  reset();
  const r = hx(['grill', 'add dark mode', '--yes']);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'Grilled feature');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.prd]);
  assert.match(issues[0].body, /## Goals\nShip it\./);
  assert.match(r.out, /# Grilled feature/); // the PRD is shown
  assert.match(r.out, /filed https:\/\/github\.com\/me\/app\/issues\/1/);
  assert.doesNotMatch(r.out, /\[y\/N\]/);
  // the session: interactive argv (prompt last), repo root, rendered with repo, base and idea
  const seen = grillSeen();
  assert.deepEqual(seen.args.slice(0, 4), ['--model', DEFAULTS.model, '--effort', DEFAULTS.effort]);
  assert.ok(!seen.args.includes('-p'));
  assert.equal(path.resolve(seen.cwd), path.resolve(root));
  for (const s of ['me/app', '`dev`', 'add dark mode']) assert.ok(seen.full.includes(s), s);
  assert.equal(seen.trusted, 'me', 'the grill session gets HX_TRUSTED (the gh login + trustedAuthors)');
});

test('without --yes: "n" files nothing and prints the path; "y" / "YES" file one issue', E2E, () => {
  reset();
  let r = hx(['grill', 'idea'], 'n\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /File this PRD on me\/app\? \[y\/N\] /);
  assert.equal(board().issues.length, 0);
  assert.ok(r.out.includes(path.join(root, '.hx', 'prds')), r.out);
  assert.match(r.out, /hx prd <file>/);

  r = hx(['grill', 'idea'], ''); // no answer = No
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 0);

  r = hx(['grill', 'idea'], 'y\n');
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 1);
  assert.equal(board().issues[0].title, 'Grilled feature');

  reset();
  r = hx(['grill', 'idea'], 'YES\n');
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 1);

  reset();
  r = hx(['grill', 'idea'], 'yep\n'); // only y / yes count
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 0);
});

test('a long idea from a file goes through the prompt file and still works', E2E, () => {
  reset();
  const idea = path.join(tmp, 'idea.md');
  writeFileSync(idea, 'a long idea. '.repeat(700));
  const r = hx(['grill', idea, '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 1);
  const seen = grillSeen();
  assert.match(seen.args.at(-1), /^Role: grill\nRead .+ first/);
  assert.ok(seen.full.includes('a long idea. a long idea.'));
});

test('session writes no PRD: nothing filed, exit 1', E2E, () => {
  reset();
  const before = prds().length;
  const r = hx(['grill', 'idea', '--yes'], '', { FAKE_GRILL_NOWRITE: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no PRD written — nothing filed/);
  assert.equal(board().issues.length, 0);
  assert.equal(prds().length, before);
});

test('session writes a whitespace-only PRD: nothing filed, exit 1', E2E, () => {
  reset();
  const r = hx(['grill', 'idea', '--yes'], '', { FAKE_GRILL_NOWRITE: 'blank' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no PRD written — nothing filed/);
  assert.equal(board().issues.length, 0);
});

test('hx help lists grill', E2E, () => {
  const r = hx(['help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /\bgrill\b/);
});
