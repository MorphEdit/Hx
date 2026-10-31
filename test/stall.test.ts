// A claude turn that stops printing is killed after stallMinutes (not the turn timeout); prompts say foreground only.
import { E2E, pooled, alive } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-stall-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runTurn } = await import('../src/agent.ts');
const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');

const fakeClaude = path.join(here, 'fakes', 'claude.mjs');
const L = DEFAULTS.labels;
const RULE = "Run every command in the foreground and wait for it. Never start a command in the background, and never poll for a background command's output in a loop.";
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const turn = (o: { stallMs?: number; timeoutMs: number }) => runTurn({ bin: fakeClaude, cwd: tmp, prompt: 'Issue: #1', sessionId: crypto.randomUUID(),
  resume: false, model: 'x', extraArgs: [], ...o });
/** The pids the stalled fake recorded, newest last. */
const stallPids = (): { pid: number; child: number }[] => readdirSync(fakeDir).filter((f) => f.startsWith('stall-'))
  .map((f) => JSON.parse(readFileSync(path.join(fakeDir, f), 'utf8')));
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}
async function withMode<T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> {
  Object.assign(process.env, env);
  try { return await f(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
}

test('a turn with no stdout for stallMinutes is killed: stalled, not timedOut, and the process tree is gone', E2E, async () => {
  const before = stallPids().length;
  const r = await withMode({ FAKE_CLAUDE_MODE: 'stall' }, () => turn({ stallMs: 0.1 * 60_000, timeoutMs: 60_000 }));
  assert.equal(r.stalled, true);
  assert.ok(!r.timedOut, 'not a timeout');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /stalled: no output for 0\.1 min/);
  assert.ok(r.durationMs < 30_000, `killed early (${r.durationMs} ms)`);
  const pids = stallPids();
  assert.equal(pids.length, before + 1);
  const { pid, child } = pids.at(-1)!;
  assert.ok(await gone(pid), 'claude process gone');
  assert.ok(await gone(child), 'its child gone too');
});

test('stallMinutes 0: the stall timer never fires; the turn ends by its own exit or the turn timeout', E2E, async () => {
  // sleeps 2.5 s, far past a 0.02 min (1.2 s) stall, then replies
  const own = await withMode({ FAKE_CLAUDE_MODE: 'stall', FAKE_CLAUDE_SLEEP_MS: '2500' }, () => turn({ stallMs: 0, timeoutMs: 60_000 }));
  assert.equal(own.ok, true, own.error);
  assert.ok(!own.stalled);
  assert.match(own.text, /woke up/);
  const timed = await withMode({ FAKE_CLAUDE_MODE: 'stall' }, () => turn({ stallMs: 0, timeoutMs: 2000 }));
  assert.equal(timed.timedOut, true);
  assert.ok(!timed.stalled);
  assert.match(timed.error ?? '', /turn timed out/);
  assert.ok(await gone(stallPids().at(-1)!.pid));
});

test('through the pool: a stalled issue is handed back as after a timed-out turn, and the log says stalled', E2E, async () => {
  const origin = path.join(tmp, 'origin.git');
  const proj = path.join(tmp, 'app');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, proj);
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(proj, 'push', '-q', 'origin', 'HEAD:main');
  const issue = (number: number) => ({ number, title: `task ${number}`, body: '', state: 'OPEN', labels: [L.ready] });
  writeFileSync(stateFile, JSON.stringify({ comments: [], issues: [issue(1), issue(2)] }));
  const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), claudeBin: fakeClaude,
    maxIterations: 3, pollSeconds: 1, audit: false, gate: false };
  const run = async (only: number, over: object) => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: string) => { lines.push(m); orig(m); };
    try {
      await withMode({ FAKE_CLAUDE_MODE: 'stall' }, () => pooled((signal) => runPool({ root: proj, stateDir: path.join(proj, '.hx'), config: { ...config, ...over } },
        { workers: 1, watch: false, dryRun: false, signal, only: [only] })));
    } finally { console.log = orig; }
    return lines;
  };
  const stalled = await run(1, { stallMinutes: 0.02, turnTimeoutMinutes: 5 });
  const timed = await run(2, { stallMinutes: 0, turnTimeoutMinutes: 0.02 });
  assert.ok(stalled.some((l) => /turn 1: error .*stalled: no output for 0\.02 min/.test(l)), stalled.join('\n'));
  assert.ok(timed.some((l) => /turn timed out/.test(l)), timed.join('\n'));
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const by = (n: number) => s.issues.find((i: any) => i.number === n);
  assert.deepEqual(by(1).labels.sort(), by(2).labels.sort(), 'same labels as after a timeout');
  assert.ok(!by(1).labels.includes(L.working), 'not left agent-working');
  assert.equal(by(1).state, by(2).state);
  const comment = (n: number) => s.comments.filter((c: any) => c.issue === n).map((c: any) => c.body.split('\n')[0]);
  assert.deepEqual(comment(1).map((b: string) => b.replace(/stalled: no output for 0\.02 min/, 'X')),
    comment(2).map((b: string) => b.replace(/turn timed out after \d+ min/, 'X')), 'same hand-back comment but the error');
});

test('the ten worker prompts (not grill) carry the foreground-only rule verbatim', E2E, () => {
  for (const f of ['impl', 'audit', 'review', 'security', 'decompose', 'critic', 'revise', 'checkpoint', 'continue', 'triage'])
    assert.ok(readFileSync(path.join(root, 'prompts', `${f}.md`), 'utf8').includes(RULE), f);
  assert.ok(!readFileSync(path.join(root, 'prompts', 'grill.md'), 'utf8').includes(RULE), 'grill is interactive: no rule');
});

test('stallMinutes: default 15, documented in the README config table and CLAUDE.md', E2E, () => {
  assert.equal(DEFAULTS.stallMinutes, 15);
  const r = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(r.split('\n').some((l) => l.startsWith('| `stallMinutes` | 15 |') && /0 = off/.test(l) && /killed/.test(l)));
  const c = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(c.slice(c.indexOf('## Conventions'), c.indexOf('## Next up')), /foreground/);
});
