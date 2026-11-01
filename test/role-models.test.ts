// roleModels: a model and effort per role. The resolver and validator, what each session's fake claude receives
// (--model / --effort), the startup line, live.json.models and hx status. Real git (a local bare origin), fake gh and claude.
import { E2E, pooled, sessionEnvs, deadPid } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-rm-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, EFFORTS, ROLES, roleModel, roleModelMap, roleModelsError, formatRoleModels, saveConfig } = await import('../src/config.ts');
const { readLive, writeLive } = await import('../src/runstate.ts');
const { readUsage } = await import('../src/usage.ts');

const L = DEFAULTS.labels;
const SONNET = 'claude-sonnet-5-5';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 2, gate: false, gauntlet: false,
  security: false, roleSkills: {}, ...extra } });

const issue = (n: number) => ({ number: n, title: `task ${n}`, body: '', state: 'OPEN', labels: [L.ready] });
// one child, a review that signs off in round 1: every PRD role runs once, and the run fits E2E.timeout on a loaded machine
const prd = (n: number) => ({ number: n, title: `feature ${n}`, body: 'make it fast DECOMPOSEONE REVIEWPASS', state: 'OPEN', labels: [L.prd] });
const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));
const byNum = (n: number) => JSON.parse(readFileSync(stateFile, 'utf8')).issues.find((i: any) => i.number === n);

/** One run: its rc, what it logged, the new session turns the fake claude saw, and live.json.models while it ran. */
async function run(extra = {}, opts: { signal?: AbortSignal; env?: Record<string, string> } = {}) {
  const lines: string[] = [];
  const before = new Set(readdirSync(fakeDir));
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
  let models: unknown;
  const poll = setInterval(() => { const l = readLive(stateDir); if (l && models === undefined) models = l.models ?? null; }, 20);
  try {
    const rc = await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal }), opts.signal);
    const turns = readdirSync(fakeDir).filter((f) => !before.has(f) && /\.env-\d+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')) as ReturnType<typeof sessionEnvs>[number]);
    return { rc, lines, turns, models };
  } finally {
    console.log = orig; clearInterval(poll);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const SET = { impl: { model: SONNET }, audit: { model: SONNET, effort: 'high' } };

test('roleModel: a role entry wins field by field, else the top-level model and effort', E2E, () => {
  const c = { model: 'm0', effort: 'medium', roleModels: { impl: { model: 'm1' }, audit: { model: 'm2', effort: 'high' }, triage: { effort: 'low' } } };
  assert.deepEqual(roleModel(c, 'impl'), { model: 'm1', effort: 'medium' });
  assert.deepEqual(roleModel(c, 'audit'), { model: 'm2', effort: 'high' });
  assert.deepEqual(roleModel(c, 'triage'), { model: 'm0', effort: 'low' }, 'effort only: the default model');
  assert.deepEqual(roleModel(c, 'review'), { model: 'm0', effort: 'medium' });
  assert.deepEqual(roleModel({ model: 'm0', effort: '', roleModels: {} }, 'impl'), { model: 'm0', effort: '' });
  assert.deepEqual(Object.keys(roleModelMap(c)), [...ROLES]);
  assert.deepEqual(DEFAULTS.roleModels, {});
  assert.deepEqual([...ROLES], ['impl', 'audit', 'triage', 'decompose', 'critic', 'revise', 'review', 'security']);
  assert.deepEqual([...EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('formatRoleModels lists only the roles that differ from the defaults', E2E, () => {
  const def = { model: 'm0', effort: 'medium' };
  assert.equal(formatRoleModels(roleModelMap({ ...def, roleModels: {} }), def), '');
  assert.equal(formatRoleModels(roleModelMap({ ...def, roleModels: { audit: { effort: 'high' }, impl: { model: 'm1' } } }), def),
    'impl m1/medium, audit m0/high');
  assert.equal(formatRoleModels(roleModelMap({ ...def, roleModels: { impl: { model: 'm0', effort: 'medium' } } }), def), '', 'same as the default');
});

test('roleModelsError: unknown role, non-object value, empty model, effort outside the list', E2E, () => {
  assert.equal(roleModelsError({}), null);
  assert.equal(roleModelsError(undefined), null);
  assert.equal(roleModelsError(SET), null);
  assert.equal(roleModelsError({ triage: { effort: 'max' }, review: {} }), null);
  assert.equal(roleModelsError({ x: {} }), 'roleModels: unknown role "x" — known: impl, audit, triage, decompose, critic, revise, review, security');
  assert.match(roleModelsError({ impl: 'sonnet' })!, /^roleModels\.impl: must be an object/);
  assert.match(roleModelsError({ impl: null })!, /^roleModels\.impl: must be an object/);
  assert.match(roleModelsError({ impl: ['x'] })!, /^roleModels\.impl: must be an object/);
  assert.match(roleModelsError({ impl: { model: '' } })!, /^roleModels\.impl\.model: must be a non-empty string/);
  assert.match(roleModelsError({ impl: { model: 5 } })!, /^roleModels\.impl\.model: must be a non-empty string/);
  assert.match(roleModelsError({ audit: { effort: 'huge' } })!, /^roleModels\.audit\.effort: "huge" is not one of low, medium, high, xhigh, max/);
  assert.match(roleModelsError({ audit: { effort: '' } })!, /^roleModels\.audit\.effort: "" is not one of/);
  assert.match(roleModelsError([])!, /^roleModels: must be an object/);
});

test('an invalid roleModels stops hx run with the message; nothing is claimed', E2E, async () => {
  const cases: [unknown, RegExp][] = [
    [{ x: {} }, /STOPPED: roleModels: unknown role "x" — known: impl, audit/],
    [{ impl: 'sonnet' }, /STOPPED: roleModels\.impl: must be an object/],
    [{ impl: { model: '' } }, /STOPPED: roleModels\.impl\.model: must be a non-empty string/],
    [{ audit: { effort: 'huge' } }, /STOPPED: roleModels\.audit\.effort: "huge" is not one of/],
    [{ audit: { effort: '' } }, /STOPPED: roleModels\.audit\.effort: "" is not one of/],
  ];
  for (const [roleModels, msg] of cases) {
    board([issue(1)]);
    const r = await run({ roleModels });
    assert.equal(r.rc, 2, JSON.stringify(roleModels));
    assert.ok(r.lines.some((l) => msg.test(l)), r.lines.join('\n'));
    assert.deepEqual(byNum(1).labels, [L.ready], 'not claimed');
    assert.equal(byNum(1).state, 'OPEN');
    assert.equal(r.turns.length, 0, 'no session ran');
  }
});

test('roleModels {}: every session gets --model and --effort as before; no models: line; live.json.models is the default map', E2E, async () => {
  board([issue(1), prd(11)]);
  const r = await run();
  assert.equal(r.rc, 0, r.lines.join('\n'));
  assert.equal(r.turns.filter((t) => t.role === 'review').length, 1, 'one review session ran');
  for (const t of r.turns) { assert.equal(t.model, DEFAULTS.model, t.role); assert.equal(t.effort, DEFAULTS.effort, t.role); }
  assert.ok(!r.lines.some((l) => / models: /.test(l)));
  assert.deepEqual(r.models, roleModelMap(DEFAULTS));
});

test('impl and audit set: their sessions get their model and effort, a PRD role the default; usage and the startup line follow', E2E, async () => {
  board([issue(1), prd(11)]);
  const seen = readUsage(stateDir).length;
  const r = await run({ roleModels: SET });
  assert.equal(r.rc, 0, r.lines.join('\n'));
  const of = (role: string) => r.turns.filter((t) => t.role === role);
  assert.ok(of('implement').length && of('audit').length && of('review').length && of('decompose').length);
  assert.equal(of('review').length, 1, 'one review round: the PRD has one child and no gap');
  assert.equal(byNum(11).state, 'CLOSED');
  for (const t of of('implement')) assert.deepEqual([t.model, t.effort], [SONNET, 'medium']); // continue turns included
  assert.ok(of('implement').some((t) => t !== of('implement')[0]), 'more than one impl turn');
  for (const t of of('audit')) assert.deepEqual([t.model, t.effort], [SONNET, 'high']);
  for (const t of [...of('review'), ...of('decompose')]) assert.deepEqual([t.model, t.effort], [DEFAULTS.model, DEFAULTS.effort]);
  assert.ok(r.lines.some((l) => l.endsWith(` models: impl ${SONNET}/medium, audit ${SONNET}/high`)), r.lines.join('\n'));
  assert.deepEqual(r.models, { ...roleModelMap(DEFAULTS), impl: { model: SONNET, effort: 'medium' }, audit: { model: SONNET, effort: 'high' } });
  const usage = readUsage(stateDir).slice(seen).filter((u) => u.issue === 1);
  assert.ok(usage.some((u) => u.role === 'impl') && usage.every((u) => u.role !== 'impl' && u.role !== 'audit' || u.model === SONNET));
});

test('an effort set only on a role keeps the default model', E2E, async () => {
  board([issue(2)]);
  const r = await run({ roleModels: { impl: { effort: 'low' } } });
  assert.equal(r.rc, 0, r.lines.join('\n'));
  const impl = r.turns.filter((t) => t.role === 'implement');
  assert.ok(impl.length);
  for (const t of impl) assert.deepEqual([t.model, t.effort], [DEFAULTS.model, 'low']);
  for (const t of r.turns.filter((t) => t.role === 'audit')) assert.deepEqual([t.model, t.effort], [DEFAULTS.model, DEFAULTS.effort]);
  assert.ok(r.lines.some((l) => l.endsWith(` models: impl ${DEFAULTS.model}/low`)));
});

test('a checkpoint of an impl session resumes it with the impl model and effort', E2E, async () => {
  board([issue(3)]);
  const ac = new AbortController();
  const before = new Set(readdirSync(fakeDir));
  const t = setInterval(() => {
    if (readdirSync(fakeDir).some((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))) { clearInterval(t); setTimeout(() => ac.abort(), 200); }
  }, 50);
  // the watcher lasts as long as the run: startup alone can take over 30 s on a loaded machine
  const r = await run({ roleModels: { impl: { model: SONNET, effort: 'xhigh' } } }, { signal: ac.signal, env: { FAKE_CLAUDE_DELAY_MS: '5000' } })
    .finally(() => clearInterval(t));
  assert.equal(r.rc, 0);
  assert.ok(r.lines.some((l) => /checkpoint saved/.test(l)), r.lines.join('\n'));
  const cps = r.turns.filter((t) => t.checkpoint);
  assert.ok(cps.length);
  for (const c of cps) assert.deepEqual([c.model, c.effort], [SONNET, 'xhigh']);
  const rec = readUsage(stateDir).filter((u) => u.issue === 3 && u.role === 'checkpoint');
  assert.ok(rec.length && rec.every((u) => u.model === SONNET));
  rmSync(path.join(tmp, 'wt', 'i3'), { recursive: true, force: true });
});

test('hx status prints the live runner\'s roles that differ from the default, nothing when none do', E2E, () => {
  const app = path.join(tmp, 'status-app');
  mkdirSync(app);
  const sd = path.join(app, '.hx');
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt2') } as any);
  const b = path.join(tmp, 'status-board.json');
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const hx = () => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'status'], { cwd: app, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
  const live = (pid: number, models?: unknown) => writeLive(sd, { pid, startedAt: new Date().toISOString(), repo: 'me/app', workers: 2, sessions: [],
    ...(models ? { models } : {}) } as any);

  live(process.pid, roleModelMap({ ...DEFAULTS, roleModels: SET }));
  let st = hx();
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, new RegExp(`^models   impl ${SONNET}/medium, audit ${SONNET}/high$`, 'm'));
  live(process.pid, roleModelMap(DEFAULTS));
  st = hx();
  assert.doesNotMatch(st.stdout, /^models/m, 'none differ');
  live(process.pid);
  assert.doesNotMatch(hx().stdout, /^models/m, 'a runner without models in live.json');
  live(deadPid(), roleModelMap({ ...DEFAULTS, roleModels: SET }));
  assert.doesNotMatch(hx().stdout, /^models/m, 'no runner running');
});
