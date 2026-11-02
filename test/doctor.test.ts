// hx doctor: the pure checks per OS, and the command end to end with real git, fake gh and fake claude.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelSpecs, DEFAULTS } from '../src/config.ts';
import { doctor, checkAgent, checkConfig, checkGh, checkGit, checkLabels, checkNode, checkOrigin, checkRtdd, exitCode, installFix, nodeOk, render, type Check } from '../src/doctor.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-doc-'));
const FAKE_GH = path.join(here, 'fakes', 'gh.mjs');
const FAKE_CLAUDE = path.join(here, 'fakes', 'claude.mjs');
const ALL_LABELS = labelSpecs(DEFAULTS.labels).map((l) => l.name);
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

let n = 0;
/** A fresh repo (or a plain directory with repo: false) and its fake board; config: .hx/config.json contents (null = none). */
function setup(o: { repo?: boolean; config?: Record<string, unknown> | null; state?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const dir = path.join(tmp, `d${++n}`);
  mkdirSync(dir);
  if (o.repo !== false) git(dir, 'init', '-q', '-b', 'main');
  const config = o.config === undefined ? { repo: 'me/app', claudeBin: FAKE_CLAUDE, gateCommand: 'npm test' } : o.config;
  if (config && o.repo !== false) { mkdirSync(path.join(dir, '.hx')); writeFileSync(path.join(dir, '.hx', 'config.json'), JSON.stringify(config)); }
  const stateFile = path.join(tmp, `board${n}.json`);
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], labels: ALL_LABELS, ...o.state }));
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'doctor'], { cwd: dir, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: stateFile, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '23.6.0', ...o.env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const line = (out: string, label: string) => out.split('\n').find((l) => l.includes(label)) ?? '';

test('hx doctor: all present → exit 0, the agent-CLI login a – note', E2E, () => {
  const r = setup();
  assert.equal(r.code, 0, r.out + r.err);
  for (const l of ['node ≥ 23.6', 'git', 'gh logged in', 'agent CLI', 'GitHub origin', '.hx/config.json', 'board labels', 'gate command'])
    assert.match(line(r.out, l), /^✓/, `${l}: ${r.out}`);
  assert.match(line(r.out, 'gh logged in'), /as me/);
  assert.match(line(r.out, 'agent CLI (' ), /2\.0\.0/);
  assert.match(line(r.out, 'agent CLI login'), /^–/);
  assert.match(r.out, /if not logged in yet: run `claude`, then `\/login`/);
  assert.match(line(r.out, 'rtdd'), /^–/);
});

test('hx doctor: no .hx/config.json in a repo → ✗ with hx init, exit 1', E2E, () => {
  const r = setup({ config: null, env: {} });
  assert.equal(r.code, 1, r.out);
  assert.match(line(r.out, '.hx/config.json'), /^✗/);
  assert.match(r.out, /\.hx\/config\.json — missing\n\s+fix: hx init/);
});

test('hx doctor: gh logged out → ✗ with gh auth login, exit 1', E2E, () => {
  const r = setup({ state: { authStatus: 'out' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ gh logged in — not logged in\n\s+fix: gh auth login/);
});

test('hx doctor: a network failure in gh auth status → ?, exit 0', E2E, () => {
  const r = setup({ state: { authStatus: 'offline' } });
  assert.equal(r.code, 0, r.out);
  assert.match(line(r.out, 'gh logged in'), /^\? .*offline/);
});

test('hx doctor: claude missing → ✗ not installed, exit 1', E2E, () => {
  const r = setup({ config: { repo: 'me/app', claudeBin: path.join(tmp, 'no-such-claude'), gateCommand: 'x' } });
  assert.equal(r.code, 1, r.out);
  assert.match(line(r.out, 'agent CLI ('), /^✗ .*not installed/);
});

test('hx doctor: outside a git repo the repo checks are skipped and it says so', E2E, () => {
  const r = setup({ repo: false, config: null });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /repo checks — skipped: not inside a git repo/);
  for (const l of ['GitHub origin', '.hx/config.json', 'board labels', 'gate command']) assert.equal(line(r.out, l), '', r.out);
});

test('hx doctor: a missing board label → –, exit 0', E2E, () => {
  const r = setup({ state: { labels: ALL_LABELS.filter((l) => l !== 'agent-working') } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /– board labels — missing: agent-working\n\s+fix: `hx run` creates it/);
});

test('hx doctor: the label lookup failing while offline → ?, exit 0', E2E, () => {
  const r = setup({ state: { labelListFails: true } });
  assert.equal(r.code, 0, r.out);
  assert.match(line(r.out, 'board labels'), /^\?/);
});

test('hx doctor: an empty gateCommand → – note, exit 0', E2E, () => {
  const r = setup({ config: { repo: 'me/app', claudeBin: FAKE_CLAUDE, gateCommand: '' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /– gate command — not set\n\s+fix: learned from the first audited merge/);
});

test('hx doctor: no GitHub origin → ✗; a gh repo view network failure → ?', E2E, () => {
  const none = setup({ state: { repoViewFails: 'notfound' } });
  assert.equal(none.code, 1, none.out);
  assert.match(line(none.out, 'GitHub origin'), /^✗/);
  const off = setup({ state: { repoViewFails: 'offline' } });
  assert.equal(off.code, 0, off.out);
  assert.match(line(off.out, 'GitHub origin'), /^\?/);
});

test('hx doctor: HX_NODE_VERSION below 23.6 → ✗ node, exit 1', E2E, () => {
  const r = setup({ env: { HX_NODE_VERSION: '22.12.0' } });
  assert.equal(r.code, 1, r.out);
  assert.match(line(r.out, 'node'), /^✗ .*22\.12\.0/);
});

test('hx help lists doctor', E2E, () => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^\s+doctor\s/m);
});

// --- the pure checks ---

const missing = { code: 1, stdout: '', stderr: 'spawn claude ENOENT', spawnFailed: true };

test('checkAgent: claude missing → ✗ with the install command per OS', E2E, () => {
  const win = checkAgent(missing, 'claude', 'win32'), mac = checkAgent(missing, 'claude', 'darwin'), lin = checkAgent(missing, 'claude', 'linux');
  for (const c of [win, mac, lin]) { assert.equal(c.mark, '✗'); assert.match(c.detail!, /not installed/); assert.equal(c.required, true); }
  assert.match(win.fix!, /install\.ps1/);
  assert.match(mac.fix!, /install\.sh/);
  assert.match(lin.fix!, /https:\/\//);
  assert.equal(exitCode([win]), 1);
});

test('checkGit / checkGh: not installed → the OS install fix', E2E, () => {
  assert.equal(checkGit(missing, 'win32').fix, 'winget install --id Git.Git');
  assert.equal(checkGh(missing, 'win32').fix, 'winget install --id GitHub.cli');
  assert.match(checkGit(missing, 'darwin').fix!, /brew install git/);
  assert.match(checkGh(missing, 'darwin').fix!, /brew install .*gh/);
  assert.match(checkGit(missing, 'linux').fix!, /git-scm\.com/);
  assert.match(checkGh(missing, 'linux').fix!, /github\.com\/cli\/cli/);
  assert.equal(installFix('gh', 'freebsd'), installFix('gh', 'linux'));
  assert.deepEqual(checkGit({ code: 0, stdout: 'git version 2.47.1.windows.1\n', stderr: '' }, 'win32'), { mark: '✓', label: 'git', detail: '2.47.1.windows.1', required: true });
});

test('checkGh: logged in (both gh output styles), logged out, offline, timeout', E2E, () => {
  assert.equal(checkGh({ code: 0, stdout: '  ✓ Logged in to github.com account alice (keyring)', stderr: '' }, 'linux').detail, 'as alice');
  assert.equal(checkGh({ code: 0, stdout: '', stderr: '  ✓ Logged in to github.com as bob (oauth_token)' }, 'linux').detail, 'as bob');
  assert.equal(checkGh({ code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' }, 'linux').fix, 'gh auth login');
  assert.equal(checkGh({ code: 1, stdout: '', stderr: 'error connecting to api.github.com' }, 'linux').mark, '?');
  assert.equal(checkGh({ code: 1, stdout: '', stderr: '', timedOut: true }, 'linux').mark, '?');
});

test('checkOrigin, checkConfig, checkLabels, checkRtdd, checkNode', E2E, () => {
  assert.equal(checkOrigin({ code: 0, stdout: 'me/app\n', stderr: '' }).detail, 'me/app');
  assert.equal(checkOrigin({ code: 1, stdout: '', stderr: 'no git remotes found' }).mark, '✗');
  assert.equal(checkOrigin({ code: 1, stdout: '', stderr: 'HTTP 502' }).mark, '?');
  assert.deepEqual(checkConfig(false), { mark: '✗', label: '.hx/config.json', detail: 'missing', fix: 'hx init', required: true });
  const start = checkConfig(false, true);
  assert.equal(start.mark, '–');
  assert.match(start.fix!, /`hx start` runs `hx init` next/);
  assert.equal(exitCode([start]), 0);
  assert.equal(checkLabels(null).mark, '?');
  assert.equal(checkLabels([]).mark, '✓');
  assert.equal(checkRtdd(true).mark, '–');
  assert.equal(checkRtdd(false).mark, '–');
  assert.ok(nodeOk('23.6.0') && nodeOk('v24.0.1') && nodeOk('30.0.0'));
  assert.ok(!nodeOk('23.5.9') && !nodeOk('22.20.0'));
  assert.equal(checkNode('20.1.0', 'win32').fix, 'winget install --id OpenJS.NodeJS');
});

test('exitCode: 1 iff a required check is ✗; – and ? never; render shows a fix under every mark but ✓', E2E, () => {
  const c = (mark: Check['mark'], required = true): Check => ({ mark, label: 'x', fix: 'do it', required });
  assert.equal(exitCode([c('✓'), c('–'), c('?')]), 0);
  assert.equal(exitCode([c('✗', false)]), 0);
  assert.equal(exitCode([c('✓'), c('✗')]), 1);
  assert.equal(render([c('✓'), c('?')]), '✓ x\n? x\n    fix: do it');
  for (const ch of [checkGh(missing, 'linux'), checkAgent(missing, 'c', 'linux'), checkConfig(false), checkLabels(['a']), checkRtdd(false), checkOrigin({ code: 1, stdout: '', stderr: 'x' })])
    assert.ok(ch.fix && !ch.fix.includes('\n'), ch.label);
});

test('doctor(): returns { checks, code }; configOptional makes a missing config a – note, skipLabels skips the lookup', E2E, async () => {
  const dir = path.join(tmp, 'inproc');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const stateFile = path.join(tmp, 'board-inproc.json'), log = path.join(tmp, 'gh-inproc.log');
  writeFileSync(stateFile, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [], labels: [] }));
  Object.assign(process.env, { HX_GH_BIN: FAKE_GH, HX_FAKE_STATE: stateFile, HX_FAKE_GH_LOG: log, HX_RTDD_BIN: path.join(tmp, 'no-rtdd.mjs'), HX_NODE_VERSION: '24.0.0' });
  try {
    const strict = await doctor({ cwd: dir, platform: 'linux' });
    assert.equal(strict.checks.find((c) => c.label === '.hx/config.json')?.mark, '✗');
    assert.equal(strict.code, 1);
    assert.equal(strict.checks.find((c) => c.label === 'board labels')?.mark, '–');
    const start = await doctor({ cwd: dir, platform: 'linux', configOptional: true, skipLabels: true });
    assert.equal(start.checks.find((c) => c.label === '.hx/config.json')?.mark, '–');
    assert.equal(start.checks.find((c) => c.label === 'board labels'), undefined);
    assert.equal(start.checks.filter((c) => c.required && c.mark === '✗').every((c) => c.label.startsWith('agent CLI')), true);
    assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('label list')).length, 1);
    assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('auth status')).length, 2);
  } finally {
    for (const k of ['HX_GH_BIN', 'HX_FAKE_STATE', 'HX_FAKE_GH_LOG', 'HX_RTDD_BIN', 'HX_NODE_VERSION']) delete process.env[k];
  }
});
