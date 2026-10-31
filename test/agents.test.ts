// The agent-CLI seam (src/agents): a registry by name, runTurn driven by any adapter, claude by default.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn, type RateLimit, type TurnOptions } from '../src/agent.ts';
import { agentFor, registerAgent, type AgentCli } from '../src/agents/index.ts';
import { claude } from '../src/agents/claude.ts';
import { DEFAULTS, saveConfig, type Config } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-agents-'));

/** A line-based fake: `args=<json>` (what the process got), `said=<stdin>`, `limit=<utilization>`. */
const fake: AgentCli = {
  name: 'fake',
  bin: () => 'never-called',
  args: (o) => ['--fake-model', o.model, '--sid', o.sessionId],
  turn: () => ({
    line(line, res) {
      const i = line.indexOf('=');
      const k = line.slice(0, i), v = line.slice(i + 1);
      if (k === 'args') return { event: { kind: 'args', args: JSON.parse(v) } };
      if (k === 'said') res.text = v;
      if (k === 'limit') return { rateLimit: { status: 'allowed_warning', utilization: Number(v) } };
    },
    finish(res, code, stderr) {
      res.ok = code === 0;
      res.numTurns = 1;
      if (!res.ok) res.error = `fake exited ${code}: ${stderr}`;
    },
  }),
  interactiveArgs: (model, _effort, prompt) => ['--fake-model', model, prompt],
};

const base = (o: Partial<TurnOptions>): TurnOptions => ({ bin: path.join(here, 'fakes', 'agent.mjs'), cwd: tmp, prompt: 'hello',
  sessionId: 's-1', resume: false, model: 'm1', extraArgs: [], timeoutMs: 60_000, ...o });

test('a fake adapter drives one turn: its args reach the process, line/finish fill the result, event → onEvent, rateLimit → onRateLimit', E2E, async () => {
  const events: any[] = [];
  const limits: RateLimit[] = [];
  const r = await runTurn(base({ agent: fake, onEvent: (e) => events.push(e), onRateLimit: (rl) => limits.push(rl) }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'hello');
  assert.equal(r.numTurns, 1);
  assert.deepEqual(events, [{ kind: 'args', args: ['--fake-model', 'm1', '--sid', 's-1'] }]);
  assert.deepEqual(limits, [{ status: 'allowed_warning', utilization: 0.95 }]);
});

test('a fake adapter: finish sees the exit code and stderr; nothing claude-specific is added', E2E, async () => {
  const r = await runTurn(base({ agent: fake, env: { FAKE_AGENT_EXIT: '3' } }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /^fake exited 3/);
  assert.equal(r.limited, undefined);
});

test('runTurn without agent uses the claude adapter (the stream-json fake still works)', E2E, async () => {
  const events: any[] = [];
  const limits: RateLimit[] = [];
  const r = await runTurn(base({ bin: path.join(here, 'fakes', 'claude.mjs'), prompt: 'Issue: #1', sessionId: crypto.randomUUID(),
    env: { FAKE_CLAUDE_MODE: 'limit' }, onEvent: (e) => events.push(e), onRateLimit: (rl) => limits.push(rl) }));
  assert.deepEqual(events.map((e) => e.type), ['rate_limit_event', 'result'], 'raw stream-json events reach onEvent');
  assert.deepEqual(limits, [{ status: 'rejected', utilization: undefined, resetsAt: 4102444800, type: undefined }]);
  assert.equal(r.ok, false);
  assert.equal(r.numTurns, 1);
  assert.equal(r.text, "You've hit your session limit");
  assert.deepEqual(r.limited, { resetsAt: 4102444800 });
});

test('the claude adapter: argv for a headless turn and an interactive session, bin = config.claudeBin', E2E, () => {
  const o = base({ model: 'claude-opus-5-5', effort: 'medium', extraArgs: ['--x'] });
  assert.deepEqual(claude.args(o), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--model', 'claude-opus-5-5', '--effort', 'medium', '--session-id', 's-1', '--x']);
  assert.deepEqual(claude.args({ ...o, resume: true, effort: '' }).slice(6), ['--model', 'claude-opus-5-5', '--resume', 's-1', '--x']);
  assert.deepEqual(claude.interactiveArgs('m', 'high', 'P'), ['--model', 'm', '--effort', 'high', 'P']);
  assert.deepEqual(claude.interactiveArgs('m', '', 'P'), ['--model', 'm', 'P']);
  assert.equal(claude.bin({ ...DEFAULTS, claudeBin: 'my-claude' } as Config), 'my-claude');
});

test('the claude adapter: a rate_limit_event is both an event and a rate limit; a rejected one limits the turn', E2E, () => {
  const t = claude.turn(base({}));
  const res: any = { ok: false, text: '', usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, durationMs: 0, numTurns: 0 };
  const ev = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', utilization: 100, resetsAt: 42, rateLimitType: 'five_hour' } };
  assert.deepEqual(t.line(JSON.stringify(ev), res), { event: ev, rateLimit: { status: 'rejected', utilization: 1, resetsAt: 42, type: 'five_hour' } });
  assert.equal(t.line('not json', res), undefined);
  t.finish(res, 1, '');
  assert.deepEqual(res.limited, { resetsAt: 42 });
  assert.match(res.error, /^claude exited 1 with no result/);
});

test('registry: agentCli defaults to claude; registerAgent then agentFor returns it; an unknown name throws with the known list', E2E, () => {
  assert.equal(DEFAULTS.agentCli, 'claude');
  assert.equal(agentFor('claude'), claude);
  registerAgent(fake);
  assert.equal(agentFor('fake'), fake);
  assert.throws(() => agentFor('nope'), (e: Error) => e.message.startsWith('unknown agentCli "nope" — known: claude'));
});

test('hx run with agentCli "nope" exits non-zero with the message and makes no board read', E2E, () => {
  const root = path.join(tmp, 'app');
  mkdirSync(root);
  saveConfig(path.join(root, '.hx'), { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'), agentCli: 'nope' });
  const ghLog = path.join(tmp, 'gh.log');
  const state = path.join(tmp, 'board.json');
  writeFileSync(state, JSON.stringify({ comments: [], prs: [], issues: [] }));
  writeFileSync(ghLog, '');
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), 'run'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: state, HX_FAKE_GH_LOG: ghLog } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown agentCli "nope" — known: claude/);
  assert.equal(readFileSync(ghLog, 'utf8'), '', 'no gh call');
});

test('src/pool.ts reads no stream-json: no rateLimitOf, no event fields', E2E, () => {
  const src = readFileSync(path.join(here, '..', 'src', 'pool.ts'), 'utf8');
  assert.doesNotMatch(src, /rateLimitOf/);
  assert.doesNotMatch(src, /ev\.(type|message|result|usage|rate_limit_info)|rate_limit_event|stream-json/);
});
