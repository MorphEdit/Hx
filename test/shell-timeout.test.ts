// Worker shell commands may run as long as ship's test timeout (#191): BASH_MAX_TIMEOUT_MS / BASH_DEFAULT_TIMEOUT_MS in each
// session's env, a stall timer that waits on a running tool call, and an impl prompt that never opens a PR outside ship.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-shell-'));
const fakeDir = path.join(tmp, 'sessions');
mkdirSync(fakeDir);
process.env.HX_FAKE_DIR = fakeDir;

const { runTurn } = await import('../src/agent.ts');
const { shellEnv, SHIP_TEST_MINUTES } = await import('../src/agents/claude.ts');
const { DEFAULTS } = await import('../src/config.ts');
const fakeClaude = path.join(here, 'fakes', 'claude.mjs');
const SHIP_MS = (SHIP_TEST_MINUTES + 5) * 60_000;
const turn = (o: { stallMs?: number; timeoutMs: number }) => runTurn({ bin: fakeClaude, cwd: tmp, prompt: 'Issue: #1', sessionId: crypto.randomUUID(),
  resume: false, model: 'x', extraArgs: [], ...o });
async function withEnv<T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await f(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test('shellEnv: ship test timeout + 5 min, below the turn timeout; a higher value already set is kept', E2E, () => {
  assert.equal(SHIP_TEST_MINUTES, 45, "ship.mjs's --test-timeout default");
  assert.deepEqual(shellEnv(60 * 60_000, {}), { BASH_MAX_TIMEOUT_MS: String(SHIP_MS), BASH_DEFAULT_TIMEOUT_MS: String(SHIP_MS) });
  assert.deepEqual(shellEnv(60 * 60_000, { BASH_MAX_TIMEOUT_MS: '9000000', BASH_DEFAULT_TIMEOUT_MS: '120000' }),
    { BASH_MAX_TIMEOUT_MS: '9000000', BASH_DEFAULT_TIMEOUT_MS: String(SHIP_MS) });
  assert.equal(shellEnv(30 * 60_000, {}).BASH_MAX_TIMEOUT_MS, String(29 * 60_000), 'kept below a shorter turn timeout');
  assert.deepEqual(shellEnv(30_000, {}), {}, 'a turn too short for any: nothing set');
  assert.ok(Number(shellEnv(DEFAULTS.turnTimeoutMinutes * 60_000, {}).BASH_MAX_TIMEOUT_MS) === SHIP_MS && SHIP_MS < DEFAULTS.turnTimeoutMinutes * 60_000,
    'the default turn timeout leaves room for the full value');
});

test('a fake claude sees BASH_MAX_TIMEOUT_MS and BASH_DEFAULT_TIMEOUT_MS from the ship timeout; a higher value in the env is kept', E2E, async () => {
  const out = path.join(tmp, 'env.json');
  await withEnv({ FAKE_CLAUDE_MODE: 'crash', FAKE_CLAUDE_ENV_OUT: out, BASH_MAX_TIMEOUT_MS: '', BASH_DEFAULT_TIMEOUT_MS: '' },
    () => turn({ timeoutMs: 60 * 60_000 }));
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { max: String(SHIP_MS), def: String(SHIP_MS) });
  await withEnv({ FAKE_CLAUDE_MODE: 'crash', FAKE_CLAUDE_ENV_OUT: out, BASH_MAX_TIMEOUT_MS: '7200000', BASH_DEFAULT_TIMEOUT_MS: '60000' },
    () => turn({ timeoutMs: 60 * 60_000 }));
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { max: '7200000', def: String(SHIP_MS) });
});

test('the stall timer does not kill a turn waiting on a running tool call; it still kills one that is not', E2E, async () => {
  // silent for twice the stall window after the tool call starts. A node so slow to start that the tool call comes after the
  // window is a real stall: the window then grows (5, 15, 30 s)
  let waiting;
  for (const ms of [5000, 15000, 30000]) {
    waiting = await withEnv({ FAKE_CLAUDE_MODE: 'stall', FAKE_CLAUDE_TOOL: '1', FAKE_CLAUDE_SLEEP_MS: String(2 * ms) },
      () => turn({ stallMs: ms, timeoutMs: 60 * 60_000 }));
    if (!waiting.stalled) break;
  }
  assert.ok(!waiting!.stalled, waiting!.error);
  assert.equal(waiting!.ok, true, waiting!.error);
  assert.match(waiting!.text, /woke up/);
  const idle = await withEnv({ FAKE_CLAUDE_MODE: 'stall', FAKE_CLAUDE_SLEEP_MS: '10000' },
    () => turn({ stallMs: 5000, timeoutMs: 60 * 60_000 }));
  assert.equal(idle.stalled, true);
});

test('impl prompt: never open a PR outside ship.mjs; a test command the shell kills is reported, then stop', E2E, () => {
  const impl = readFileSync(path.join(here, '..', 'prompts', 'impl.md'), 'utf8');
  assert.match(impl, /never open a PR outside ship\.mjs/);
  assert.match(impl, /runs longer than the shell allows.*say so/s);
  const audit = readFileSync(path.join(here, '..', 'prompts', 'audit.md'), 'utf8');
  assert.match(audit, /longer than the shell allows.*say so/s);
});
