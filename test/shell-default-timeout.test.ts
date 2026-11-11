// #443: a worker's shell command without its own timeout must end at a short default, not ship's 50 minutes; the stall
// timer gives a pending call only the time that call can take; the prompts that run ship.mjs or the full suite pass a long timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claude, shellEnv, SHELL_DEFAULT_MS, SHIP_TEST_MINUTES } from '../src/agents/claude.ts';

// a worker's own session (hx run) has these set: the turn reads process.env
delete process.env.BASH_DEFAULT_TIMEOUT_MS;
delete process.env.BASH_MAX_TIMEOUT_MS;
const here = path.dirname(fileURLToPath(import.meta.url));
const SHIP_MS = (SHIP_TEST_MINUTES + 5) * 60_000;
const DEFAULT_MS = 2 * 60_000; // Claude Code's own default for one Bash command
const toolUse = (id: string, input: Record<string, unknown>, name = 'Bash') =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const newTurn = () => claude.turn({ timeoutMs: 60 * 60_000, stallMs: 15 * 60_000 } as any);
const pendingBash = (input: Record<string, unknown>) => {
  const t = newTurn();
  t.line(toolUse('tu1', input), {} as any);
  return t;
};
const prompt = (name: string) => readFileSync(path.join(here, '..', 'prompts', `${name}.md`), 'utf8');

test('shellEnv: BASH_MAX_TIMEOUT_MS stays at ship timeout + 5 min; BASH_DEFAULT_TIMEOUT_MS is not raised to it', () => {
  const env = shellEnv(60 * 60_000, {});
  assert.equal(env.BASH_MAX_TIMEOUT_MS, String(SHIP_MS));
  assert.ok(!(Number(env.BASH_DEFAULT_TIMEOUT_MS) >= SHIP_MS), `BASH_DEFAULT_TIMEOUT_MS = ${env.BASH_DEFAULT_TIMEOUT_MS}`);
  assert.equal(SHELL_DEFAULT_MS, DEFAULT_MS);
  assert.equal(shellEnv(60 * 60_000, { BASH_DEFAULT_TIMEOUT_MS: '9000000' }).BASH_DEFAULT_TIMEOUT_MS, '9000000', 'a higher value is kept');
});

test('waitMs: a pending shell call with no timeout gets the default + 1 min, not the maximum', () => {
  const w = pendingBash({ command: 'cat > /tmp/x.py' }).waitMs!();
  assert.equal(w, DEFAULT_MS + 60_000, `waitMs = ${w / 60_000} min`);
});

test('waitMs: a pending shell call with an explicit timeout gets that timeout + 1 min, capped at the maximum', () => {
  assert.equal(pendingBash({ command: 'node scripts/ship.mjs', timeout: 3_000_000 }).waitMs!(), 3_000_000 + 60_000);
  const w = pendingBash({ command: 'npm test -- a.test.ts', timeout: 300_000 }).waitMs!();
  assert.equal(w, 300_000 + 60_000, `waitMs = ${w / 60_000} min`);
  assert.equal(pendingBash({ command: 'x', timeout: 99_000_000 }).waitMs!(), SHIP_MS + 60_000, 'no more than the maximum');
});

test('waitMs: the longest pending call counts; none pending is 0', () => {
  const t = newTurn();
  assert.equal(t.waitMs!(), 0);
  t.line(toolUse('a', { command: 'node ship.mjs', timeout: 3_000_000 }), {} as any);
  t.line(toolUse('b', { command: 'ls' }), {} as any);
  assert.equal(t.waitMs!(), 3_000_000 + 60_000);
  t.line(toolResult('a'), {} as any);
  assert.equal(t.waitMs!(), DEFAULT_MS + 60_000, 'the long call answered: the short one is left');
  t.line(toolResult('b'), {} as any);
  assert.equal(t.waitMs!(), 0);
});

test('the prompts that run ship.mjs or the full test command tell the worker to pass a timeout of at least ship\'s', () => {
  const long = /shell\s+`timeout`\s+of\s+(\d+)\s+ms/g;
  const timeouts = (text: string) => [...text.matchAll(long)].map((m) => Number(m[1]));
  const impl = prompt('impl');
  assert.match(impl, /Give the ship call a shell `timeout` of \d+ ms/);
  assert.match(impl, /full test command a shell `timeout` of \d+ ms/);
  assert.match(prompt('audit'), /test\s+run that may take longer a shell `timeout` of \d+ ms/);
  assert.match(prompt('review'), /full test suite\. Give it a shell `timeout` of \d+ ms/);
  assert.match(prompt('continue'), /Give ship\.mjs and the full test command a shell `timeout` of \d+ ms/);
  for (const name of ['impl', 'audit', 'review', 'continue']) {
    const ts = timeouts(prompt(name));
    assert.ok(ts.length > 0, name);
    for (const t of ts) assert.ok(t >= SHIP_TEST_MINUTES * 60_000 && t <= SHIP_MS, `${name}: ${t} ms`);
  }
});
