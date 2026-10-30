// Per-role skills: resolution (checks, three locations, strip, cap), the summary line, appending to a
// prompt, the config keys, hx status's skills line and the fake rtdd. A temp HX_SKILLS_HOME, never the real home.
import { E2E, deadPid } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-sk-'));
const home = path.join(tmp, 'home');
mkdirSync(home);
process.env.HX_SKILLS_HOME = home;

const { appendSkills, resolveSkills, skillNames, skillsHome, skillsLogLine, stripSkill } = await import('../src/skills.ts');
const { DEFAULTS, effectiveRtddBin, saveConfig } = await import('../src/config.ts');
const { writeLive } = await import('../src/runstate.ts');

let n = 0;
const newRepo = () => { const r = path.join(tmp, `repo${++n}`); mkdirSync(r); return r; };
const put = (base: string, dir: '.claude' | '.agents', name: string, text: string) => {
  const d = path.join(base, dir, 'skills', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'SKILL.md'), text);
};
const homeOnly = (name: string, text: string) => put(home, '.claude', name, text);

test('HX_SKILLS_HOME is the home skills are looked up in', E2E, () => {
  assert.equal(skillsHome(), home);
});

test('a skill is found in each location; repo .claude > home .claude > repo .agents', E2E, async () => {
  const repo = newRepo();
  put(repo, '.claude', 'a', 'repo-claude a');
  homeOnly('a', 'home a');
  put(repo, '.agents', 'a', 'agents a');
  homeOnly('b', 'home b');
  put(repo, '.agents', 'b', 'agents b');
  put(repo, '.agents', 'c', 'agents c');
  const r = await resolveSkills(repo, { impl: ['a', 'b', 'c'] }, 12000, { checks: {} });
  assert.deepEqual(r.byRole.impl.map((s) => s.body), ['repo-claude a', 'home b', 'agents c']);
  assert.deepEqual(r.lines, []);
});

test('front matter and HTML comments are stripped', E2E, async () => {
  assert.equal(stripSkill('---\nname: x\ndescription: y\n---\nbody <!-- hidden -->here\n<!--\nmulti\n-->\nend\n'), 'body here\n\nend');
  assert.equal(stripSkill('\uFEFF---\r\nname: x\r\n---\r\nbody'), 'body');
  assert.equal(stripSkill('no front matter\n---\nnot: yaml\n---\n'), 'no front matter\n---\nnot: yaml\n---');
  const repo = newRepo();
  put(repo, '.claude', 's', '---\nname: s\n---\n<!-- note -->\nthe body\n');
  const r = await resolveSkills(repo, { impl: ['s'] }, 12000, { checks: {} });
  assert.deepEqual(r.byRole.impl, [{ name: 's', body: 'the body', size: 8 }]);
});

test('a missing skill is skipped with its line, once per role', E2E, async () => {
  const repo = newRepo();
  put(repo, '.claude', 'here', 'x');
  const r = await resolveSkills(repo, { impl: ['nope', 'here'], audit: ['nope'] }, 12000, { checks: {} });
  assert.deepEqual(r.lines, ['skill nope not found — role impl runs without it', 'skill nope not found — role audit runs without it']);
  assert.deepEqual(skillNames(r.byRole), { impl: ['here'] });
});

test('a skill over skillMaxChars is skipped; the cap applies to the stripped body', E2E, async () => {
  const repo = newRepo();
  put(repo, '.claude', 'big', 'x'.repeat(101));
  put(repo, '.claude', 'padded', `---\nname: padded\n---\n<!-- ${'c'.repeat(500)} -->\n${'y'.repeat(100)}`);
  const r = await resolveSkills(repo, { impl: ['big', 'padded'] }, 100, { checks: {} });
  assert.deepEqual(r.byRole.impl.map((s) => [s.name, s.size]), [['padded', 100]]);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^skill big .*\b101\b.*\b100\b/);
});

test('a skill whose check fails is never read; checks run before the disk and once per skill', E2E, async () => {
  const repo = newRepo();
  put(repo, '.claude', 'gated', 'gated body');
  put(repo, '.claude', 'okd', 'ok body');
  let calls = 0;
  const checks = {
    gated: async () => { calls++; return 'skill gated: its CLI is not installed — dropped'; },
    okd: async () => null,
  };
  const r = await resolveSkills(repo, { impl: ['gated', 'okd'], audit: ['gated'] }, 12000, { checks });
  assert.equal(calls, 1);
  assert.deepEqual(r.lines, ['skill gated: its CLI is not installed — dropped']);
  assert.deepEqual(skillNames(r.byRole), { impl: ['okd'] });
  assert.ok(!JSON.stringify(r).includes('gated body'));
  // a failing check stops the lookup: even a missing SKILL.md gives no "not found" line
  const r2 = await resolveSkills(repo, { impl: ['ghost'] }, 12000, { checks: { ghost: async () => 'ghost is off' } });
  assert.deepEqual(r2.lines, ['ghost is off']);
});

test('the summary line: sizes on first appearance, role and skill order, none', E2E, async () => {
  const repo = newRepo();
  put(repo, '.claude', 'rtdd', `---\nname: rtdd\n---\n${'r'.repeat(7400)}\n`);
  const r = await resolveSkills(repo, { impl: ['rtdd'], audit: ['rtdd'] }, 12000, { checks: {} });
  assert.equal(skillsLogLine(r.byRole), 'skills: impl ← rtdd (7.4K chars), audit ← rtdd');
  put(repo, '.claude', 'a', 'a'.repeat(1000));
  put(repo, '.claude', 'b', 'b'.repeat(2049));
  const r2 = await resolveSkills(repo, { review: [], impl: ['a', 'b'], audit: ['b', 'missing'] }, 12000, { checks: {} });
  assert.equal(skillsLogLine(r2.byRole), 'skills: impl ← a (1.0K chars), b (2.0K chars), audit ← b');
  assert.equal(skillsLogLine({}), 'skills: none');
  assert.equal(skillsLogLine((await resolveSkills(repo, {}, 12000, { checks: {} })).byRole), 'skills: none');
  assert.equal(skillsLogLine((await resolveSkills(repo, { impl: ['missing'] }, 12000, { checks: {} })).byRole), 'skills: none');
});

test('appendSkills: heading, body, then the prompts/skills note; {{N}} stays; no skills → unchanged', E2E, () => {
  const prompts = path.join(tmp, 'prompts');
  mkdirSync(path.join(prompts, 'skills'), { recursive: true });
  writeFileSync(path.join(prompts, 'skills', 'withnote.md'), 'the hx note\n');
  const prompt = 'Rendered prompt for #7.\n';
  const out = appendSkills(prompt, [
    { name: 'plain', body: 'uses {{N}} and {{REPO}}', size: 23 },
    { name: 'withnote', body: 'second body', size: 11 },
  ], prompts);
  assert.equal(out, 'Rendered prompt for #7.\n\n## Skill: plain\nuses {{N}} and {{REPO}}\n\n## Skill: withnote\nsecond body\nthe hx note\n');
  assert.ok(out.endsWith('## Skill: withnote\nsecond body\nthe hx note\n'));
  for (const p of ['', 'x', 'a\r\nb {{N}}\n\n']) assert.equal(appendSkills(p, [], prompts), p);
});

test('DEFAULTS has the skill keys; HX_RTDD_BIN overrides rtddBin', E2E, () => {
  assert.deepEqual(DEFAULTS.roleSkills, { impl: ['rtdd'], audit: ['rtdd'] });
  assert.equal(DEFAULTS.skillMaxChars, 12000);
  assert.equal(DEFAULTS.rtddBin, 'rtdd');
  const c = { ...DEFAULTS, rtddBin: 'C:/tools/rtdd.exe' };
  delete process.env.HX_RTDD_BIN;
  assert.equal(effectiveRtddBin(c), 'C:/tools/rtdd.exe');
  process.env.HX_RTDD_BIN = '';
  assert.equal(effectiveRtddBin(c), 'C:/tools/rtdd.exe');
  process.env.HX_RTDD_BIN = '/fake/rtdd';
  assert.equal(effectiveRtddBin(c), '/fake/rtdd');
  delete process.env.HX_RTDD_BIN;
});

test('hx status prints the live runner\'s skills line, none for {}, nothing without a runner', E2E, () => {
  const app = newRepo();
  const stateDir = path.join(app, '.hx');
  saveConfig(stateDir, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt') } as any);
  const board = path.join(tmp, 'board.json');
  writeFileSync(board, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const hx = () => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: board } });
  const live = (skills?: Record<string, string[]>) => writeLive(stateDir,
    { pid: process.pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 2, sessions: [], ...(skills ? { skills } : {}) });

  live({ impl: ['rtdd'], audit: ['rtdd'] });
  let st = hx();
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /^skills   impl ← rtdd, audit ← rtdd$/m);
  live({});
  st = hx();
  assert.match(st.stdout, /^skills   none$/m);
  live();
  st = hx();
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.doesNotMatch(st.stdout, /^skills/m, 'a runner without skills in live.json');
  writeLive(stateDir, { pid: deadPid(), startedAt: new Date().toISOString(), repo: 'me/app', workers: 2, sessions: [], skills: { impl: ['rtdd'] } });
  st = hx();
  assert.match(st.stdout, /runner   not running/);
  assert.doesNotMatch(st.stdout, /^skills/m, 'no runner running');
});

test('the fake rtdd logs its calls; --version and init succeed or fail on demand', E2E, () => {
  const log = path.join(tmp, 'rtdd.log');
  const cwd = newRepo();
  const rtdd = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(here, 'fakes', 'rtdd.mjs'), ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, HX_FAKE_RTDD_LOG: log, ...env } });
  const v = rtdd(['--version']);
  assert.equal(v.status, 0);
  assert.match(v.stdout, /\d+\.\d+/);
  assert.notEqual(rtdd(['--version'], { HX_FAKE_RTDD_VERSION_FAIL: '1' }).status, 0);
  assert.notEqual(rtdd(['init'], { HX_FAKE_RTDD_INIT_FAIL: '1' }).status, 0);
  assert.ok(!existsSync(path.join(cwd, '.rtdd')));
  assert.equal(rtdd(['init']).status, 0);
  assert.ok(existsSync(path.join(cwd, '.rtdd', 'config.yaml')));
  assert.ok(existsSync(path.join(cwd, '.rtdd', '.gitignore')));
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [['--version'], ['--version'], ['init'], ['init']]);
});
