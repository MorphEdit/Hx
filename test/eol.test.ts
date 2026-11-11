// Line endings (#252): every worktree hx creates is LF whatever the user's git config says, hx init offers a
// .gitattributes, hx doctor notes a missing eol rule and core.autocrlf=true, ship.mjs commits CRLF files as LF.
// Real git (a local bare origin) with core.autocrlf=true in the global config, fake gh and claude.
import { E2E, GIT_TEST_CONFIG } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelSpecs, DEFAULTS } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-eol-'));
const FAKE_GH = path.join(here, 'fakes', 'gh.mjs');
const FAKE_CLAUDE = path.join(here, 'fakes', 'claude.mjs');
const stateFile = path.join(tmp, 'board.json');
writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], labels: labelSpecs(DEFAULTS.labels).map((l) => l.name),
  issues: [{ number: 7, title: 't', body: '', state: 'OPEN', labels: [] }] }));
Object.assign(process.env, { HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: stateFile, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '23.6.0' });
// the git config hx sees: Git for Windows' default
const globalConfig = path.join(tmp, 'gitconfig');
const GLOBAL = `${GIT_TEST_CONFIG}[core]\n\tautocrlf = true\n`;
writeFileSync(globalConfig, GLOBAL);
process.env.GIT_CONFIG_GLOBAL = globalConfig;

const { addWorktree } = await import('../src/worktree.ts');
const { checkEol, hasEolRule } = await import('../src/doctor.ts');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const hx = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), ...args], { cwd, encoding: 'utf8' });
const origin = path.join(tmp, 'origin.git');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
const seed = path.join(tmp, 'seed');
git(tmp, 'clone', '-q', origin, seed);
writeFileSync(path.join(seed, 'a.txt'), 'one\ntwo\n');
git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', 'origin', 'HEAD:main');

let n = 0;
const clone = () => { const d = path.join(tmp, `c${++n}`); git(tmp, 'clone', '-q', origin, d); return d; };

test('a worktree hx creates is LF with core.autocrlf=false in its own config, while the global config says true', E2E, async () => {
  const checkout = clone();
  assert.equal(readFileSync(path.join(checkout, 'a.txt'), 'utf8'), 'one\r\ntwo\r\n', 'a plain checkout is CRLF under core.autocrlf=true');
  const { dir } = await addWorktree(checkout, path.join(tmp, 'wt'), { name: 'i1', branch: 'issue/1', base: 'main', fresh: false });
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(git(dir, 'config', '--worktree', '--get', 'core.autocrlf'), 'false');
  assert.equal(git(dir, 'config', '--worktree', '--get', 'core.eol'), 'lf');
  assert.equal(git(dir, 'config', '--get', 'core.autocrlf'), 'false', 'what git uses in the worktree');
  assert.equal(git(checkout, 'config', '--get', 'core.autocrlf'), 'true', 'the main checkout keeps the user setting');
  assert.equal(readFileSync(globalConfig, 'utf8'), GLOBAL, 'the global config is unchanged');
  // a reused worktree keeps the settings; a fresh one (audit, decompose) gets them too
  const again = await addWorktree(checkout, path.join(tmp, 'wt'), { name: 'i1', branch: 'issue/1', base: 'main', fresh: false });
  assert.equal(again.created, false);
  assert.equal(git(again.dir, 'config', '--get', 'core.autocrlf'), 'false');
  const audit = await addWorktree(checkout, path.join(tmp, 'wt'), { name: 'a1', branch: 'hx/audit-1', base: 'main', fresh: true });
  assert.equal(readFileSync(path.join(audit.dir, 'a.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(git(audit.dir, 'config', '--get', 'core.autocrlf'), 'false');
});

test('hx init --yes adds .gitattributes when missing; without --yes it asks and adds nothing; an existing one is unchanged', E2E, () => {
  const a = clone();
  const r = hx(a, 'init', '--yes');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(path.join(a, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
  assert.match(r.stdout, /line endings: wrote \.gitattributes \(\* text=auto eol=lf\) — commit it/);

  const b = clone();
  const no = hx(b, 'init'); // stdin closed: no answer is no
  assert.equal(no.status, 0, no.stdout + no.stderr);
  assert.match(no.stdout, /No \.gitattributes: add one with "\* text=auto eol=lf".*\[y\/N\]/);
  assert.throws(() => readFileSync(path.join(b, '.gitattributes')));

  const c = clone();
  writeFileSync(path.join(c, '.gitattributes'), '*.png binary\n');
  const kept = hx(c, 'init', '--yes');
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.equal(readFileSync(path.join(c, '.gitattributes'), 'utf8'), '*.png binary\n');
  assert.doesNotMatch(kept.stdout, /gitattributes/);
});

test('checkEol: a missing eol rule and core.autocrlf=true are – notes with the fix; both fine is ✓', E2E, () => {
  assert.ok(hasEolRule('* text=auto eol=lf\n'));
  assert.ok(hasEolRule('*.png binary\r\n*.ts text eol=lf\r\n'));
  assert.ok(!hasEolRule('# * text=auto eol=lf\n*.png binary\n'));
  assert.ok(!hasEolRule(''));
  assert.deepEqual(checkEol('* text=auto eol=lf\n', 'false\n'), { mark: '✓', label: 'line endings', detail: 'LF', required: false });
  assert.deepEqual(checkEol('* text=auto eol=lf\n', ''), { mark: '✓', label: 'line endings', detail: 'LF', required: false });
  const none = checkEol(null, 'true\n');
  assert.equal(none.mark, '–');
  assert.equal(none.required, false);
  assert.equal(none.detail, 'no .gitattributes, core.autocrlf is true');
  assert.match(none.fix!, /\* text=auto eol=lf {2}to \.gitattributes.*git add --renormalize \..*; git config core\.autocrlf false/);
  const noRule = checkEol('*.png binary\n', 'false');
  assert.equal(noRule.detail, 'no eol rule in .gitattributes');
  assert.doesNotMatch(noRule.fix!, /autocrlf/);
  const crlf = checkEol('* text=auto eol=lf\n', 'true');
  assert.equal(crlf.detail, 'core.autocrlf is true');
  assert.doesNotMatch(crlf.fix!, /gitattributes/);
});

test('hx doctor: no .gitattributes and core.autocrlf=true → a – line endings note with its fix, exit 0; fixed → ✓', E2E, () => {
  const dir = path.join(tmp, 'doc');
  mkdirSync(path.join(dir, '.hx'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.hx', 'config.json'), JSON.stringify({ repo: 'me/app', defaultBranch: 'main', claudeBin: FAKE_CLAUDE, gateCommand: 'npm test' }));
  const r = hx(dir, 'doctor');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^– line endings — no \.gitattributes, core\.autocrlf is true\n {4}fix: add {2}\* text=auto eol=lf/m);
  writeFileSync(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  git(dir, 'config', 'core.autocrlf', 'false');
  const ok = hx(dir, 'doctor');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^✓ line endings — LF$/m);
});

test('ship.mjs commits a file a session wrote with CRLF as LF when .gitattributes asks for LF', E2E, () => {
  const wt = clone();
  git(wt, 'config', 'core.autocrlf', 'false');
  // a file already committed with CRLF, then the eol rule: git add alone would keep its CRLF
  writeFileSync(path.join(wt, 'old.txt'), 'x\r\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'crlf');
  writeFileSync(path.join(wt, '.gitattributes'), '* text=auto eol=lf\n*.bin binary\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'attrs'); git(wt, 'push', '-q', 'origin', 'HEAD:main');
  git(wt, 'checkout', '-q', '-b', 'issue/7');
  writeFileSync(path.join(wt, 'old.txt'), 'x\r\ny\r\n');
  writeFileSync(path.join(wt, 'new.txt'), 'a\r\nb\r\n');
  writeFileSync(path.join(wt, 'data.bin'), 'p\r\nq\r\n');
  const r = spawnSync(process.execPath, [path.join(here, '..', 'scripts', 'ship.mjs'), '--repo', 'me/app', '--base', 'main', '--issue', '7',
    '--title', 'feat: thing', '--test', 'node -e "process.exit(0)"', '--no-merge'], { cwd: wt, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(execFileSync('git', ['cat-file', 'blob', 'HEAD:old.txt'], { cwd: wt, encoding: 'utf8' }), 'x\ny\n');
  assert.equal(execFileSync('git', ['cat-file', 'blob', 'HEAD:new.txt'], { cwd: wt, encoding: 'utf8' }), 'a\nb\n');
  assert.equal(execFileSync('git', ['cat-file', 'blob', 'HEAD:data.bin'], { cwd: wt, encoding: 'utf8' }), 'p\r\nq\r\n', 'a binary file is left alone');
  assert.match(r.stdout, /converted CRLF to LF: /);
  assert.equal(readFileSync(path.join(wt, 'old.txt'), 'utf8'), 'x\ny\n', 'the working file is LF too');
});
