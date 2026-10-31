// Role skills in `hx run`: the rtdd check (.rtdd/config.yaml on origin, then `rtdd --version`), the prompts the
// sessions get, PATH, the run log and live.json. Real git (a local bare origin), fake gh, claude and rtdd, and a
// temp HX_SKILLS_HOME: never a real rtdd or ~/.claude/skills.
import { E2E, pooled, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-sr-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
const rtddLog = path.join(tmp, 'rtdd.log');
const rtddBin = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
process.env.HX_FAKE_RTDD_LOG = rtddLog;
process.env.HX_RTDD_BIN = rtddBin;
mkdirSync(fakeDir);

// a home whose rtdd SKILL.md is a directory: reading it throws, so a run that gets through never read it
const unreadable = path.join(tmp, 'home-unreadable');
mkdirSync(path.join(unreadable, '.claude', 'skills', 'rtdd', 'SKILL.md'), { recursive: true });
const home = path.join(tmp, 'home');
mkdirSync(path.join(home, '.claude', 'skills', 'rtdd'), { recursive: true });
const BODY = 'Use rtdd: `rtdd explain <name>` for {{BASE}}.'; // {{...}} stays: skill text is never rendered
writeFileSync(path.join(home, '.claude', 'skills', 'rtdd', 'SKILL.md'), `---\nname: rtdd\n---\n${BODY}\n`);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readLive } = await import('../src/runstate.ts');
const { rtddEnv } = await import('../src/skills.ts');

const NOTE = readFileSync(path.join(here, '..', 'prompts', 'skills', 'rtdd.md'), 'utf8').replace(/^﻿/, '').trim();
const SUFFIX = `\n## Skill: rtdd\n${BODY}\n${NOTE}\n`;
const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 2, gate: false, gauntlet: false, ...extra } });

const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const issue = (n: number) => ({ number: n, title: `task ${n}`, body: '', state: 'OPEN', labels: [L.ready] });
const prd = (n: number) => ({ number: n, title: `feature ${n}`, body: 'make it fast', state: 'OPEN', labels: [L.prd] });
const rtddCalls = () => (existsSync(rtddLog) ? readFileSync(rtddLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** One run; what it printed, the first prompt of every new session by role, those sessions' envs, and live.json's skills. */
async function run(only: number[], extra = {}) {
  const lines: string[] = [];
  const before = new Set(readdirSync(fakeDir));
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  let liveSkills: unknown;
  const poll = setInterval(() => { const l = readLive(stateDir); if (l && liveSkills === undefined) liveSkills = l.skills; }, 20);
  try {
    const rc = await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, only, signal }));
    const fresh = readdirSync(fakeDir).filter((f) => !before.has(f));
    const prompts: Record<string, string[]> = {};
    for (const f of fresh.filter((f) => f.endsWith('.prompt-1.txt'))) {
      const p = readFileSync(path.join(fakeDir, f), 'utf8');
      (prompts[/^Role: (\w+)/m.exec(p)![1]] ??= []).push(p);
    }
    const freshEnvs = fresh.filter((f) => /\.env-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')));
    return { rc, lines, prompts, envs: freshEnvs as ReturnType<typeof sessionEnvs>, liveSkills };
  } finally { console.log = orig; clearInterval(poll); }
}

let P0 = '', A0 = ''; // issue 1's impl and audit prompts as they are without skills

test('not set up: no .rtdd/config.yaml on origin → rtdd dropped, the binary never runs, no SKILL.md read', E2E, async () => {
  process.env.HX_SKILLS_HOME = unreadable;
  board([issue(1)]);
  const r = await run([1]);
  assert.equal(r.rc, 0, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /skill rtdd dropped: .*run rtdd init and commit \.rtdd\/$/.test(l)), r.lines.join('\n'));
  assert.ok(r.lines.some((l) => / skills: none$/.test(l)), r.lines.join('\n'));
  assert.deepEqual(rtddCalls(), [], 'the fake rtdd was never called');
  P0 = r.prompts.implement[0]; A0 = r.prompts.audit[0];
  assert.ok(P0 && A0);
  for (const p of [P0, A0]) assert.doesNotMatch(p, /## Skill:/);
  assert.deepEqual(r.liveSkills, {});
});

test('committed locally but not pushed → still not set up, the binary never runs', E2E, async () => {
  process.env.HX_SKILLS_HOME = unreadable;
  mkdirSync(path.join(root, '.rtdd'), { recursive: true });
  writeFileSync(path.join(root, '.rtdd', 'config.yaml'), 'version: 1\n');
  git(root, 'add', '.rtdd/config.yaml');
  git(root, 'commit', '-q', '-m', 'rtdd (local only)');
  board([issue(2)]);
  const r = await run([2]);
  assert.equal(r.rc, 0, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /skill rtdd dropped: \.rtdd\/config\.yaml is not on origin\/main — run rtdd init and commit \.rtdd\/$/.test(l)), r.lines.join('\n'));
  assert.deepEqual(rtddCalls(), []);
  assert.doesNotMatch(r.prompts.implement[0], /## Skill:/);
});

test('not found: config pushed, `rtdd --version` fails → rtdd dropped with a line naming the binary', E2E, async () => {
  // push .rtdd/config.yaml from another clone; the project checkout sees it once fetched
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', '-q', origin, other);
  mkdirSync(path.join(other, '.rtdd'));
  writeFileSync(path.join(other, '.rtdd', 'config.yaml'), 'version: 1\n');
  git(other, 'add', '.rtdd/config.yaml');
  git(other, 'commit', '-q', '-m', 'rtdd init');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  git(root, 'fetch', '-q', 'origin');
  process.env.HX_SKILLS_HOME = home;
  process.env.HX_FAKE_RTDD_VERSION_FAIL = '1';
  try {
    board([issue(3)]);
    const r = await run([3]);
    assert.equal(r.rc, 0, r.lines.join('\n'));
    const line = r.lines.find((l) => /skill rtdd dropped: rtdd not found/.test(l));
    assert.ok(line?.includes(rtddBin), r.lines.join('\n'));
    assert.deepEqual(rtddCalls(), [['--version']]);
    assert.doesNotMatch(r.prompts.implement[0], /## Skill:/);
    assert.doesNotMatch(r.prompts.audit[0], /## Skill:/);
  } finally { delete process.env.HX_FAKE_RTDD_VERSION_FAIL; }
});

test('active: impl and audit prompts end with the skill and its note, decompose has none; PATH, run log, live.json', E2E, async () => {
  process.env.HX_SKILLS_HOME = home;
  writeFileSync(rtddLog, '');
  board([issue(1), prd(11)]);
  const r = await run([1, 11]);
  assert.equal(r.rc, 0, r.lines.join('\n'));
  assert.deepEqual(rtddCalls(), [['--version']], 'checked once per run');
  // the same prompts as without skills, the skill appended after them, byte for byte
  assert.equal(r.prompts.implement[0], P0 + SUFFIX);
  assert.equal(r.prompts.audit[0], A0 + SUFFIX);
  assert.ok(r.prompts.decompose?.length, 'a decompose session ran');
  assert.doesNotMatch(r.prompts.decompose[0], /## Skill:/);
  // the continue prompt gets no skill
  const cont = readdirSync(fakeDir).filter((f) => /\.prompt-2\.txt$/.test(f)).map((f) => readFileSync(path.join(fakeDir, f), 'utf8'));
  for (const p of cont) assert.doesNotMatch(p, /## Skill:/);
  // PATH: the fake rtdd's directory first for impl and audit sessions, unchanged for decompose
  const dir = path.dirname(path.resolve(rtddBin));
  const impl = r.envs.filter((e) => e.role === 'implement' && !e.checkpoint);
  assert.ok(impl.length);
  for (const e of [...impl, ...r.envs.filter((e) => e.role === 'audit')]) assert.ok(e.path?.startsWith(dir + path.delimiter), String(e.path));
  for (const e of r.envs.filter((e) => e.role === 'decompose')) assert.equal(e.path, process.env.PATH);
  const log = readFileSync(path.join(stateDir, 'run.log'), 'utf8');
  assert.match(log, /skills: impl ← rtdd \(\d+\.\dK chars\), audit ← rtdd\n/);
  assert.deepEqual(r.liveSkills, { impl: ['rtdd'], audit: ['rtdd'] });
});

test('roleSkills: {} → no skill sections, prompts byte-identical to a run without skills, PATH unchanged', E2E, async () => {
  process.env.HX_SKILLS_HOME = home;
  board([issue(1)]);
  const r = await run([1], { roleSkills: {} });
  assert.equal(r.rc, 0, r.lines.join('\n'));
  assert.equal(r.prompts.implement[0], P0);
  assert.equal(r.prompts.audit[0], A0);
  for (const e of r.envs) assert.equal(e.path, process.env.PATH);
  assert.ok(r.lines.some((l) => / skills: none$/.test(l)));
  // and with rtdd removed from the roles that had it
  board([issue(1)]);
  const r2 = await run([1], { roleSkills: { impl: [], audit: [] } });
  assert.equal(r2.prompts.implement[0], P0);
  assert.equal(r2.prompts.audit[0], A0);
});

test('rtddEnv: a path puts its directory first on PATH, in the key the env already uses; a bare name or no rtdd changes nothing', E2E, () => {
  const env = { HX_TRUSTED: 'me' };
  const bin = path.join(tmp, 'tools', 'rtdd.exe');
  const want = path.join(tmp, 'tools') + path.delimiter + 'C:\\bin';
  assert.deepEqual(rtddEnv(env, true, bin, { Path: 'C:\\bin' }), { HX_TRUSTED: 'me', Path: want });
  assert.deepEqual(rtddEnv(env, true, bin, { PATH: 'C:\\bin' }), { HX_TRUSTED: 'me', PATH: want });
  assert.deepEqual(rtddEnv(env, true, 'tools/rtdd', { PATH: 'x' }), { HX_TRUSTED: 'me', PATH: path.resolve('tools') + path.delimiter + 'x' });
  assert.equal(rtddEnv(env, true, 'rtdd', { PATH: 'x' }), env);
  assert.equal(rtddEnv(env, false, bin, { PATH: 'x' }), env);
});
