// The model that actually ran each turn: the claude adapter reads it from the result's modelUsage, usage records carry it
// as actualModel, goal() logs a mismatch once per session, a checkpoint never does, hx usage --by model groups by it.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-am-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, modelMatches, saveConfig } = await import('../src/config.ts');
const { claude, mainModel } = await import('../src/agents/claude.ts');
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
const board = (issues: any[]) => writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues }));

/** One run with extra env: its rc and what it logged. */
async function run(env: Record<string, string>, stop?: AbortSignal, extra = {}) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const rc = await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, signal }), stop);
    return { rc, lines };
  } finally {
    console.log = orig;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const emptyRes = (): any => ({ ok: false, text: '', usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs: 0, numTurns: 0 });

test('mainModel: the model with the most output tokens; undefined when modelUsage is absent or empty', E2E, () => {
  assert.equal(mainModel({ 'claude-haiku-4-5': { outputTokens: 20 }, 'claude-opus-5-5': { outputTokens: 200 } }), 'claude-opus-5-5');
  assert.equal(mainModel({ 'claude-opus-5-5': { outputTokens: 200 }, 'claude-haiku-4-5': { outputTokens: 20 } }), 'claude-opus-5-5');
  assert.equal(mainModel({ only: {} }), 'only');
  assert.equal(mainModel(undefined), undefined);
  assert.equal(mainModel(null), undefined);
  assert.equal(mainModel({}), undefined);
});

test('the claude adapter sets actualModel from the result event, leaves it unset without modelUsage', E2E, () => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, usage: {} };
  const res = emptyRes();
  claude.turn({} as any).line(JSON.stringify({ ...result, modelUsage: { 'claude-haiku-4-5': { outputTokens: 20 }, [SONNET]: { outputTokens: 200 } } }), res);
  assert.equal(res.actualModel, SONNET);
  const bare = emptyRes();
  claude.turn({} as any).line(JSON.stringify(result), bare);
  assert.ok(!('actualModel' in bare));
  const empty = emptyRes();
  claude.turn({} as any).line(JSON.stringify({ ...result, modelUsage: {} }), empty);
  assert.ok(!('actualModel' in empty));
});

test('modelMatches: same id, a dated id, a bare alias family; another model is a mismatch', E2E, () => {
  assert.equal(modelMatches('sonnet', 'claude-sonnet-5-5'), true);
  assert.equal(modelMatches('opus', 'claude-opus-5-5-20261001'), true);
  assert.equal(modelMatches('haiku', 'claude-haiku-4-5'), true);
  assert.equal(modelMatches('claude-opus-5-5', 'claude-opus-5-5'), true);
  assert.equal(modelMatches('claude-opus-5-5', 'claude-opus-5-5-20261001'), true);
  assert.equal(modelMatches('claude-opus-5-5', SONNET), false);
  assert.equal(modelMatches('sonnet', 'claude-opus-5-5'), false);
  assert.equal(modelMatches('claude-opus-5', 'claude-opus-5-5'), true, 'a prefix followed by "-"');
  assert.equal(modelMatches('claude-opus-5-5', 'claude-opus-5-50'), false);
});

const mismatches = (lines: string[], n: number) => lines.filter((l) => l.includes(`[#${n}] model mismatch: impl `));

test('records carry actualModel when the CLI reports it (a dated id of the asked model: no mismatch), absent when not', E2E, async () => {
  board([issue(1)]);
  let seen = readUsage(stateDir).length;
  let r = await run({ FAKE_CLAUDE_RAN: `${DEFAULTS.model}-20261001` });
  assert.equal(r.rc, 0, r.lines.join('\n'));
  let recs = readUsage(stateDir).slice(seen).filter((u) => u.issue === 1);
  assert.ok(recs.length);
  for (const u of recs) { assert.equal(u.actualModel, `${DEFAULTS.model}-20261001`); assert.equal(u.model, DEFAULTS.model); }
  assert.ok(!r.lines.some((l) => /model mismatch/.test(l)), r.lines.join('\n'));

  board([issue(2)]);
  seen = readUsage(stateDir).length;
  r = await run({});
  assert.equal(r.rc, 0, r.lines.join('\n'));
  recs = readUsage(stateDir).slice(seen).filter((u) => u.issue === 2);
  assert.ok(recs.length);
  for (const u of recs) assert.ok(!('actualModel' in u), JSON.stringify(u));
  assert.ok(!r.lines.some((l) => /model mismatch/.test(l)));
});

test('a session that asked for one model and ran another over two turns logs the mismatch exactly once', E2E, async () => {
  board([issue(4)]);
  const seen = readUsage(stateDir).length;
  const r = await run({ FAKE_CLAUDE_RAN: SONNET }, undefined, { audit: false }); // unaudited: turn 1 works, turn 2 closes
  assert.equal(r.rc, 0, r.lines.join('\n'));
  const impl = readUsage(stateDir).slice(seen).filter((u) => u.issue === 4 && u.role === 'impl');
  assert.ok(impl.length >= 2, `two impl turns, got ${impl.length}`);
  for (const u of impl) assert.equal(u.actualModel, SONNET);
  assert.deepEqual(mismatches(r.lines, 4).map((l) => l.slice(l.indexOf('[#'))), [`[#4] model mismatch: impl asked ${DEFAULTS.model}, ran ${SONNET}`]);
});

test('a checkpoint turn that ran another model logs no mismatch line; its record has actualModel', E2E, async () => {
  board([issue(3)]);
  const ac = new AbortController();
  const before = new Set(readdirSync(fakeDir));
  const t = setInterval(() => {
    if (readdirSync(fakeDir).some((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))) { clearInterval(t); setTimeout(() => ac.abort(), 200); }
  }, 50);
  // not sooner than E2E.timeout: on a loaded machine the session can take more than 30 s to start (#159)
  setTimeout(() => clearInterval(t), E2E.timeout).unref();
  const seen = readUsage(stateDir).length;
  const r = await run({ FAKE_CLAUDE_DELAY_MS: '5000', FAKE_CLAUDE_RAN: SONNET }, ac.signal);
  assert.equal(r.rc, 0);
  assert.ok(r.lines.some((l) => /checkpoint saved/.test(l)), r.lines.join('\n'));
  const cps = readUsage(stateDir).slice(seen).filter((u) => u.issue === 3 && u.role === 'checkpoint');
  assert.ok(cps.length);
  for (const u of cps) { assert.equal(u.actualModel, SONNET); assert.equal(u.model, DEFAULTS.model); }
  assert.ok(!r.lines.some((l) => /model mismatch/.test(l)), r.lines.join('\n'));
  rmSync(path.join(tmp, 'wt', 'i3'), { recursive: true, force: true });
});

test('hx usage --by model groups by actualModel, by model for records without it', E2E, () => {
  const app = path.join(tmp, 'usage-app');
  const sd = path.join(app, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt3') } as any);
  const rec = (i: number, tokens: number, model: string, actualModel?: string) => ({ ts: '2026-10-30T10:00:00Z', issue: 1, role: 'impl',
    sessionId: `s${i}`, iteration: 1, model, ...(actualModel ? { actualModel } : {}), ok: true,
    usage: { input: tokens, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs: 0, numTurns: 1 });
  const recs = [rec(1, 100, 'claude-opus-5-5', SONNET), rec(2, 10, 'claude-opus-5-5', 'claude-opus-5-5-20261001'), rec(3, 1, 'claude-opus-5-5')];
  writeFileSync(path.join(sd, 'usage.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'usage', '--by', 'model'],
    { cwd: app, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const row = (k: string) => r.stdout.split(/\r?\n/).find((l) => l.split(/\s+/)[0] === k);
  assert.match(row(SONNET) ?? '', /\s1\s+1\s+100\b/, r.stdout);
  assert.match(row('claude-opus-5-5-20261001') ?? '', /\s1\s+1\s+10\b/, r.stdout);
  assert.match(row('claude-opus-5-5') ?? '', /\s1\s+1\s+1\b/, r.stdout);
});
