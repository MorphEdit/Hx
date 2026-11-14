// hx grill end to end: the real CLI (bin/hx.mjs) with fake claude (grill role) and fake gh.
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
const wake = path.join(root, '.hx', 'wake');
const grillSeen =() => JSON.parse(readFileSync(path.join(fakeDir, 'grill-args.json'), 'utf8'));

function hx(args: string[], input = '', env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HX, ...args], { cwd: root, input, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: stateFile, HX_FAKE_DIR: fakeDir, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('hx grill "idea" --yes: one prd issue titled from the "# " line, exit 0', E2E, () => {
  reset();
  rmSync(wake, { force: true });
  const r = hx(['grill', 'add dark mode', '--yes']);
  assert.equal(r.code, 0, r.out);
  const { issues } = board();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'Grilled feature');
  assert.deepEqual(issues[0].labels, [DEFAULTS.labels.prd]);
  assert.match(issues[0].body, /## Goals\nShip it\./);
  assert.match(r.out, /# Grilled feature/); // the PRD is shown
  assert.match(r.out, /filed https:\/\/github\.com\/me\/app\/issues\/1\r?\nIt will be decomposed into issues\. no hx run is running — start it with {2}hx run --watch/);
  assert.match(readFileSync(wake, 'utf8').trim(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.doesNotMatch(r.out, /\[y\/N\]/);
  // the session: interactive argv (prompt last), repo root, rendered with repo, base and idea
  const seen = grillSeen();
  assert.deepEqual(seen.args.slice(0, 4), ['--model', DEFAULTS.model, '--effort', DEFAULTS.effort]);
  assert.ok(!seen.args.includes('-p'));
  assert.equal(path.resolve(seen.cwd), path.resolve(root));
  for (const s of ['me/app', '`dev`', 'add dark mode']) assert.ok(seen.full.includes(s), s);
  assert.equal(seen.trusted, 'me', 'the grill session gets HX_TRUSTED (the gh login + trustedAuthors)');
  // outside hx run n = 1: cpus - 1, whatever else runs (#350)
  assert.equal(seen.testConcurrency, String(Math.max(1, os.availableParallelism() - 1)));
  // reuseTestedTrees (default on): the absolute path of <stateDir>/tested-trees.jsonl (#351)
  assert.equal(seen.testedTrees, path.resolve(root, '.hx', 'tested-trees.jsonl'));
});

test('without --yes: "n" files nothing and prints the path; "y" / "YES" file one issue', E2E, () => {
  reset();
  rmSync(wake, { force: true });
  let r = hx(['grill', 'idea'], 'n\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /File this PRD on me\/app\? \[y\/N\] /);
  assert.equal(board().issues.length, 0);
  assert.ok(!existsSync(wake), 'answered no: no .hx/wake');
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
  rmSync(wake, { force: true });
  const before = prds().length;
  const r = hx(['grill', 'idea', '--yes'], '', { FAKE_GRILL_NOWRITE: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no PRD written — nothing filed/);
  assert.equal(board().issues.length, 0);
  assert.ok(!existsSync(wake), 'nothing written: no .hx/wake');
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

// the user's idea kept word for word in ## Original request (PRD #475)
const newest = () => path.join(root, '.hx', 'prds', prds().sort().at(-1)!);
const nl = (s: string) => s.replace(/\r\n/g, '\n');

test('original request: no section → added first, in the text shown before [y/N], in the file and in the filed PRD', E2E, () => {
  reset();
  const r = hx(['grill', 'add dark mode\nwith a toggle'], 'y\n');
  assert.equal(r.code, 0, r.out);
  const want = '# Grilled feature\n\n## Original request\n\n> add dark mode\n> with a toggle\n\n## Goals\nShip it.\n';
  const out = nl(r.out);
  assert.ok(out.indexOf(want.trimEnd()) >= 0 && out.indexOf(want.trimEnd()) < out.indexOf('[y/N]'), r.out);
  assert.equal(readFileSync(newest(), 'utf8'), want);
  const { issues } = board();
  assert.equal(issues[0].title, 'Grilled feature');
  assert.equal(issues[0].body, want.replace('# Grilled feature\n\n', ''));
  assert.match(issues[0].body, /^## Original request\n\n> add dark mode\n> with a toggle\n\n## Goals/);
});

test('original request: a section without the idea → the idea at its top, the session\'s lines below', E2E, () => {
  reset();
  const text = '# Grilled feature\n\n## Original request\n\n> no toggle after all\n\n## Goals\nShip it.\n';
  const r = hx(['grill', 'add dark mode with a toggle', '--yes'], '', { FAKE_GRILL_TEXT: text });
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues[0].body, '## Original request\n\n> add dark mode with a toggle\n\n> no toggle after all\n\n## Goals\nShip it.\n');
});

test('original request: a section that holds the idea → filed as written, the file untouched', E2E, () => {
  reset();
  const text = '# Grilled feature\n\n## Original request\n\n> add dark\n> mode\n\n> and a toggle\n\n## Goals\nShip it.\n';
  const r = hx(['grill', 'add  dark mode', '--yes'], '', { FAKE_GRILL_TEXT: text });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(newest(), 'utf8'), text);
  assert.equal(board().issues[0].body, text.replace('# Grilled feature\n\n', ''));
});

test('original request: answered "no" — the file keeps the idea and hx prd <that file> files it', E2E, () => {
  reset();
  let r = hx(['grill', 'add dark mode'], 'n\n');
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues.length, 0);
  const file = newest();
  assert.match(readFileSync(file, 'utf8'), /^# Grilled feature\n\n## Original request\n\n> add dark mode\n\n## Goals/);
  r = hx(['prd', file]);
  assert.equal(r.code, 0, r.out);
  assert.match(board().issues[0].body, /^## Original request\n\n> add dark mode\n\n## Goals\nShip it\.\n$/);
});

test('original request: an empty idea (none, or only whitespace) → nothing inserted, filed as written', E2E, () => {
  for (const args of [['grill', '--yes'], ['grill', '  \n ', '--yes']]) {
    reset();
    const r = hx(args);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(newest(), 'utf8'), '# Grilled feature\n\n## Goals\nShip it.\n');
    assert.equal(board().issues[0].body, '## Goals\nShip it.\n');
  }
});

test('original request: an idea from a file (CRLF, a heading of its own) is its content, quoted whole', E2E, () => {
  reset();
  const idea = path.join(tmp, 'idea-crlf.md');
  writeFileSync(idea, 'Build a tracker.\r\n\r\n## Scope\r\nonly mine\r\n');
  const r = hx(['grill', idea, '--yes']);
  assert.equal(r.code, 0, r.out);
  assert.equal(board().issues[0].body, '## Original request\n\n> Build a tracker.\n> \n> ## Scope\n> only mine\n\n## Goals\nShip it.\n');
});
