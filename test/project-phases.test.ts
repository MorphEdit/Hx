// A two-phase fixture's run (#450, PRD #446): the change sent when the brief is done (chat: the same session resumed;
// Hx: `hx prd` of the change to the same runner), phase1Sha from the remote, caps over both phases, and the run split
// into `phases` by time. Fake sessions, a fake runner and fake steps: no gh, no claude, no usage spent.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: a plain .mjs bench module
import { setupRepo, splitPhases } from '../bench/project-lib.mjs';
// @ts-ignore: a plain .mjs bench module
import { chatArm, hxArm, runSet, STEPS } from '../bench/project.mjs';
// @ts-ignore: a plain .mjs bench module
import { resolveFixture } from '../bench/project-fixtures.mjs';
// @ts-ignore: a plain .mjs bench module
import { stableScore } from '../bench/project-grade.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeClaude = path.join(root, 'test', 'fakes', 'claude.mjs');
const CHANGE = '# Ledge, second edition\n\nRename every command.\n';
const U = { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 };
/** The fake fixture's hidden/tags.json: three stable cases, two change cases. */
const TAGS = { 'a > s1': 'stable', 'a > s2': 'stable', 'b > c1': 'change', 'b > s3': 'stable', 'b > c2': 'change' };

/** A temp dir with a two-phase fixture (ledge's files, a change file), a work dir with .hx/, and a log. */
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hxp-2p-'));
  const ledge = resolveFixture('ledge');
  writeFileSync(path.join(dir, 'change.md'), CHANGE);
  writeFileSync(path.join(dir, 'tags.json'), JSON.stringify(TAGS));
  const fixture = { ...ledge, manifest: { ...ledge.manifest, change: 'change.md' }, change: path.join(dir, 'change.md'), tags: path.join(dir, 'tags.json') };
  const work = path.join(dir, 'work');
  mkdirSync(path.join(work, '.hx'), { recursive: true });
  const events: string[] = [];
  return { dir, fixture, work, events, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake runGoal: each call takes its phase's turns (`plan[k]`: turns and how it stops), reporting each through onTurn
 *  and stopping early when the signal is aborted. Records every call's options. */
function fakeRun(plan: { turns: number; stop?: string; cost?: number }[], events: string[]) {
  const calls: any[] = [];
  const run = async (o: any) => {
    const k = calls.length;
    calls.push(o);
    const sessionId = o.resumeSession ?? 'sess-1';
    const { turns, stop = 'promise', cost = 0.1 } = plan[k];
    for (let i = 1; i <= turns; i++) {
      events.push(`turn ${k + 1}.${i}: ${i === 1 ? o.prompt.split('\n')[0] : o.continuePrompt.split('.')[0]}`);
      o.onTurn(i, sessionId, { ok: true, durationMs: 10, usage: U, costUsd: cost });
      if (o.signal.aborted) return { stopReason: 'aborted', iterations: i, sessionId };
    }
    return { stopReason: stop, iterations: turns, sessionId };
  };
  return { run, calls };
}

const chatCtx = (s: ReturnType<typeof setup>, over: any = {}) => ({
  arm: 'chat', repo: 'o/r', work: s.work, maxHours: 4, maxUsd: 60, log: () => {}, fixture: s.fixture,
  remoteMain: () => { s.events.push('remoteMain'); return 'remote-sha'; }, ...over,
});

test('chat two-phase: the change goes to the same session after the first promise; phase-2 continue prompts name the change; nudges per phase; done on the second promise', E2E, async () => {
  const s = setup();
  try {
    const { run, calls } = fakeRun([{ turns: 2 }, { turns: 3 }], s.events);
    const r = await chatArm(chatCtx(s), { run });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].resumeSession, undefined, 'phase 1 is a new session');
    assert.equal(calls[1].resumeSession, 'sess-1', 'phase 2 resumes the same session id');
    assert.ok(calls[0].prompt.startsWith(readFileSync(s.fixture.brief, 'utf8').trimEnd()));
    assert.ok(calls[1].prompt.startsWith(`Change this project as follows:\n\n${CHANGE.trimEnd()}\n\n---\n`), calls[1].prompt);
    assert.match(calls[1].prompt, /only what is pushed counts/);
    assert.match(calls[1].prompt, /When it is finished and pushed, output exactly:\n<promise>PROJECT DONE<\/promise>\n$/);
    assert.match(calls[1].continuePrompt, /change/);
    assert.doesNotMatch(calls[1].continuePrompt, /brief/);
    assert.match(calls[0].continuePrompt, /from the brief/);
    // the change is sent only after the first promise, and phase1Sha is read in between
    assert.deepEqual(s.events, [
      `turn 1.1: ${calls[0].prompt.split('\n')[0]}`, 'turn 1.2: Continue building the project from the brief', 'remoteMain',
      'turn 2.1: Change this project as follows:', 'turn 2.2: Continue making the change to the project', 'turn 2.3: Continue making the change to the project',
    ]);
    assert.equal(r.ended, 'done');
    assert.equal(r.phase1Sha, 'remote-sha');
    assert.deepEqual(r.phaseNudges, [1, 2]);
    assert.equal(r.nudges, 3);
    assert.ok(r.boundary >= r.t0 && r.boundary <= r.t1);
    assert.equal(r.usage.length, 5);
    assert.ok(r.usage.every((u: any) => u.sessionId === 'sess-1'));
    // the turns land on their side of the boundary
    const phases = splitPhases({ usage: r.usage, t0: r.t0, t1: r.t1, boundary: r.boundary, nudges: r.phaseNudges });
    assert.deepEqual(phases.map((p: any) => [p.name, p.tokens.total, p.nudges, p.sessions]), [['brief', 20, 1, { chat: 1 }], ['change', 30, 2, { chat: 1 }]]);
  } finally { s.done(); }
});

test('chat two-phase: a session that stops in phase 2 without the promise ends early, after the change was sent', E2E, async () => {
  const s = setup();
  try {
    const { run, calls } = fakeRun([{ turns: 1 }, { turns: 2, stop: 'max-iterations' }], s.events);
    const r = await chatArm(chatCtx(s), { run });
    assert.equal(calls.length, 2);
    assert.equal(r.ended, 'early');
    assert.deepEqual(r.phaseNudges, [0, 1]);
  } finally { s.done(); }
});

test('chat two-phase: a remote read that fails is logged, phase1Sha null, and the change still sent', E2E, async () => {
  const s = setup();
  try {
    const lines: string[] = [];
    const { run, calls } = fakeRun([{ turns: 1 }, { turns: 1 }], s.events);
    const r = await chatArm(chatCtx(s, { log: (m: string) => lines.push(m), remoteMain: () => { throw new Error('gh: HTTP 502\nmore'); } }), { run });
    assert.equal(calls.length, 2);
    assert.equal(r.phase1Sha, null);
    assert.ok(lines.includes('reading main of o/r failed: gh: HTTP 502'), lines.join('\n'));
  } finally { s.done(); }
});

test('chat two-phase: a cap in phase 1 never sends the change and ends capped; an early end never sends it and ends early', E2E, async () => {
  for (const [plan, maxUsd, ended] of [
    [[{ turns: 5 }], 0.25, 'capped'], // capped on turn 3, mid phase 1
    [[{ turns: 2, stop: 'error' }], 60, 'early'],
  ] as const) {
    const s = setup();
    try {
      const { run, calls } = fakeRun(plan as any, s.events);
      const r = await chatArm(chatCtx(s, { maxUsd }), { run });
      assert.equal(calls.length, 1, `${ended}: the change is never sent`);
      assert.equal(r.ended, ended);
      assert.equal(r.boundary, null);
      assert.equal('phase1Sha' in r, false, 'read by runSet when the run stops');
      assert.ok(!s.events.includes('remoteMain'));
      assert.deepEqual(r.phaseNudges, [r.nudges]);
    } finally { s.done(); }
  }
});

test('chat two-phase: caps count both phases; a cap in phase 2 ends capped', E2E, async () => {
  const s = setup();
  try {
    // $0.1 a turn: 2 turns in phase 1, the cap of $0.35 reached on phase 2's second turn
    const { run, calls } = fakeRun([{ turns: 2 }, { turns: 5 }], s.events);
    const r = await chatArm(chatCtx(s, { maxUsd: 0.35 }), { run });
    assert.equal(calls.length, 2);
    assert.equal(r.ended, 'capped');
    assert.equal(r.usage.length, 4);
    assert.equal(r.phase1Sha, 'remote-sha');
  } finally { s.done(); }
});

test('chat single-phase: no change, no phase fields, exactly as before', E2E, async () => {
  const s = setup();
  try {
    const { run, calls } = fakeRun([{ turns: 2 }], s.events);
    const r = await chatArm(chatCtx(s, { fixture: resolveFixture('ledge') }), { run });
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(r).sort(), ['ended', 'nudges', 't0', 't1', 'usage']);
  } finally { s.done(); }
});

/** A fake Hx world: `hx prd` files #1, #2…; each PRD closes after `closeAfter[n]` polls of it (never when absent); the
 *  runner is an emitter that closes on `hx pause --now`, or after `exitAfter` polls. */
function fakeHx(s: ReturnType<typeof setup>, { closeAfter = {} as Record<number, number>, exitAfter = Infinity, onPoll = (_n: number, _k: number) => {} } = {}) {
  const hxCalls: { args: string[]; cwd: string }[] = [];
  const runners: EventEmitter[] = [];
  const polls: Record<number, number> = {};
  let filed = 0, total = 0;
  const hx = (args: string[], opts: any) => {
    hxCalls.push({ args, cwd: opts.cwd });
    s.events.push(`hx ${args[0]}`);
    if (args[0] === 'prd') return `https://github.com/o/r/issues/${++filed}\n`;
    if (args[0] === 'pause') setImmediate(() => runners[0].emit('close'));
    return '';
  };
  const prdState = (n: number) => {
    polls[n] = (polls[n] ?? 0) + 1;
    onPoll(n, polls[n]);
    if (++total >= exitAfter) setImmediate(() => runners[0].emit('close'));
    const closed = polls[n] >= (closeAfter[n] ?? Infinity);
    if (closed) s.events.push(`#${n} closed`);
    return closed ? 'CLOSED' : 'OPEN';
  };
  const runner = () => { const r = new EventEmitter(); runners.push(r); s.events.push('runner'); return r; };
  return { deps: { hx, prdState, runner, tick: 1 }, hxCalls, runners };
}

const usageLine = (ts: number, sessionId: string, costUsd: number, role = 'impl') => JSON.stringify({ ts: new Date(ts).toISOString(), role, sessionId, usage: U, costUsd }) + '\n';
const hxCtx = (s: ReturnType<typeof setup>, over: any = {}) => ({ ...chatCtx(s), arm: 'hx3', ...over });

test('Hx two-phase: the change is filed (titled by its heading, same work dir) only after the first PRD closes, to the same runner; done when the second PRD closes', E2E, async () => {
  const s = setup();
  try {
    const f = fakeHx(s, { closeAfter: { 1: 3, 2: 2 } });
    const r = await hxArm(hxCtx(s), f.deps);
    assert.equal(f.runners.length, 1, 'no second runner');
    assert.deepEqual(f.hxCalls.map((c) => c.args), [
      ['prd', s.fixture.brief, '--title', `PRD: ${/^#\s+(.+)$/m.exec(readFileSync(s.fixture.brief, 'utf8'))![1].trim()}`],
      ['prd', s.fixture.change, '--title', 'PRD: Ledge, second edition'],
      ['pause', '--now'],
    ]);
    assert.ok(f.hxCalls.every((c) => c.cwd === s.work));
    assert.deepEqual(s.events, ['hx prd', 'runner', '#1 closed', 'remoteMain', 'hx prd', '#2 closed', 'hx pause']);
    assert.equal(r.ended, 'done');
    assert.equal(r.phase1Sha, 'remote-sha');
    assert.ok(r.boundary >= r.t0 && r.boundary < r.t1);
  } finally { s.done(); }
});

test('Hx two-phase: the runner exiting in phase 1 ends early and a cap in phase 1 ends capped; neither files the change', E2E, async () => {
  for (const ended of ['early', 'capped']) {
    const s = setup();
    try {
      const usageFile = path.join(s.work, '.hx', 'usage.jsonl');
      const f = fakeHx(s, ended === 'early' ? { exitAfter: 2 } : { onPoll: (_n, k) => { if (k === 2) appendFileSync(usageFile, usageLine(Date.now(), 'a', 61)); } });
      const r = await hxArm(hxCtx(s), f.deps);
      assert.equal(r.ended, ended);
      assert.deepEqual(f.hxCalls.filter((c) => c.args[0] === 'prd').length, 1, `${ended}: the change is never filed`);
      assert.equal(r.boundary, null);
      assert.equal('phase1Sha' in r, false);
    } finally { s.done(); }
  }
});

test('Hx two-phase: caps count both phases; a cap reached in phase 2 ends capped', E2E, async () => {
  const s = setup();
  try {
    const usageFile = path.join(s.work, '.hx', 'usage.jsonl');
    // $40 in phase 1, $25 more in phase 2: $65 over the $60 cap only together
    const f = fakeHx(s, { closeAfter: { 1: 2 }, onPoll: (n, k) => {
      if (n === 1 && k === 1) appendFileSync(usageFile, usageLine(Date.now(), 'a', 40));
      if (n === 2 && k === 1) appendFileSync(usageFile, usageLine(Date.now(), 'b', 25));
    } });
    const r = await hxArm(hxCtx(s), f.deps);
    assert.equal(r.ended, 'capped');
    assert.equal(f.hxCalls.filter((c) => c.args[0] === 'prd').length, 2);
    assert.equal(r.usage.length, 2);
  } finally { s.done(); }
});

test('Hx single-phase: done when the PRD closes, nothing else filed, no phase fields', E2E, async () => {
  const s = setup();
  try {
    const f = fakeHx(s, { closeAfter: { 1: 2 } });
    const r = await hxArm(hxCtx(s, { fixture: resolveFixture('ledge') }), f.deps);
    assert.equal(r.ended, 'done');
    assert.deepEqual(f.hxCalls.map((c) => c.args[0]), ['prd', 'pause']);
    assert.deepEqual(Object.keys(r).sort(), ['ended', 't0', 't1', 'usage']);
    assert.ok(!s.events.includes('remoteMain'));
  } finally { s.done(); }
});

test('splitPhases: records go by ts, a session spanning the boundary counts in both, and the phases add up to the totals', E2E, () => {
  const t0 = 1_000_000, boundary = 1_600_000, t1 = 2_000_000;
  const rec = (ts: number | null, sessionId: string, costUsd: number, role = 'impl') => ({ ...(ts === null ? {} : { ts: new Date(ts).toISOString() }), role, sessionId, usage: U, costUsd });
  const usage = [
    rec(1_100_000, 's1', 1), rec(1_200_000, 's2', 2, 'review'), rec(boundary, 's2', 4, 'review'), rec(null, 's9', 8, 'audit'),
    // s1 has turns on both sides (a phase-1 issue still worked in phase 2)
    rec(1_700_000, 's1', 16), rec(1_900_000, 's3', 32),
  ];
  const [brief, change] = splitPhases({ usage, t0, t1, boundary, nudges: [3, 4] });
  assert.equal(brief.name, 'brief');
  assert.equal(change.name, 'change');
  assert.deepEqual([brief.wallMs, change.wallMs], [600_000, 400_000]);
  assert.deepEqual([brief.costUsd, change.costUsd], [15, 48]);
  assert.deepEqual(brief.sessions, { impl: 1, review: 1, audit: 1 });
  assert.deepEqual(change.sessions, { impl: 2 });
  assert.deepEqual([brief.tokens.total, change.tokens.total], [40, 20]);
  assert.deepEqual([brief.nudges, change.nudges], [3, 4]);
  for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 'total']) assert.equal(brief.tokens[k] + change.tokens[k], usage.length * (k === 'total' ? 10 : U[k as keyof typeof U]), k);
  assert.equal(brief.wallMs + change.wallMs, t1 - t0);
  // never reached phase 2: one brief phase over the whole run; an Hx arm's nudges are null
  const one = splitPhases({ usage, t0, t1, boundary: null, nudges: null });
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].name, one[0].wallMs, one[0].costUsd, one[0].nudges], ['brief', t1 - t0, 63, null]);
});

/** runSet on the two-phase fixture with the real chat arm over a fake session; the setup step makes ctx.work a real git
 *  repo whose local main is not the remote's. */
async function chatSet(s: ReturnType<typeof setup>, plan: { turns: number; stop?: string }[], remote: string[]) {
  const reads: string[] = [];
  const steps = {
    setup: (ctx: any) => {
      setupRepo(ctx.work, { template: ctx.fixture.template, name: 'ledge' });
      mkdirSync(path.join(ctx.work, '.hx'), { recursive: true });
    },
    arm: (ctx: any) => chatArm(ctx, { run: fakeRun(plan, s.events).run }),
    remoteMain: (ctx: any) => { const sha = remote[reads.length]; reads.push(ctx.repo); return sha; },
    phase1Checkout: (ctx: any) => ctx.phase1Clone,
    issues: () => [],
    clone: () => {},
    grade: () => ({ passed: 1, failed: 0, total: 1, failures: [] }),
    fuzz: () => ({ divergences: 0, classes: {} }),
    coverage: () => ({ tests: 'none', lines: 'n/a', branches: 'n/a' }),
  };
  const out = await runSet({ arm: 'chat', owner: 'me', stamp: '202611110900', fixture: s.fixture, resultsDir: path.join(s.dir, 'out'), tmp: s.dir,
    commit: 'abc', claudeBin: fakeClaude, steps, print: () => {} });
  assert.deepEqual(out.failed, []);
  const work = path.join(s.dir, 'hxp', 'ledge-chat-202611110900-1');
  const local = execFileSync('git', ['rev-parse', 'main'], { cwd: work, encoding: 'utf8' }).trim();
  return { r: JSON.parse(readFileSync(out.files[0], 'utf8')), reads, local };
}

test('runSet two-phase: phase1Sha comes from the remote step, not the work directory\'s local main; phases add up to the totals', E2E, async () => {
  const s = setup();
  try {
    const remote = 'f'.repeat(40);
    const { r, reads, local } = await chatSet(s, [{ turns: 2 }, { turns: 2 }], [remote]);
    assert.notEqual(local, remote);
    assert.equal(r.phase1Sha, remote);
    assert.deepEqual(reads, ['me/hx-project-ledge-chat-202611110900-1'], 'read once, at the boundary');
    assert.deepEqual(r.phases.map((p: any) => p.name), ['brief', 'change']);
    for (const k of ['wallMs', 'costUsd', 'nudges'] as const) assert.ok(Math.abs(r.phases[0][k] + r.phases[1][k] - r[k]) < 1e-9, k);
    assert.equal(r.phases[0].tokens.total + r.phases[1].tokens.total, r.tokens.total);
    assert.deepEqual(r.phases.map((p: any) => [p.nudges, p.sessions]), [[1, { chat: 1 }], [1, { chat: 1 }]]);
    assert.deepEqual([r.ended, r.nudges, r.sessions], ['done', 2, { chat: 1 }]);
    assert.deepEqual(r.phase1, { passed: 3, total: 3 }, 'the first version on the stable cases');
  } finally { s.done(); }
});

test('runSet two-phase: a run that ends in phase 1 records only the brief phase, and phase1Sha is main on GitHub when it stopped', E2E, async () => {
  const s = setup();
  try {
    const { r, reads } = await chatSet(s, [{ turns: 3, stop: 'error' }], ['e'.repeat(40)]);
    assert.equal(r.ended, 'early');
    assert.equal(r.phase1Sha, 'e'.repeat(40));
    assert.equal(reads.length, 1, 'read after the run stopped');
    assert.equal(r.phases.length, 1);
    assert.deepEqual([r.phases[0].name, r.phases[0].wallMs, r.phases[0].costUsd, r.phases[0].nudges], ['brief', r.wallMs, r.costUsd, 2]);
  } finally { s.done(); }
});

test('runSet single-phase (tally, ledge): no phases, phase1Sha or phase1, and no remote read', E2E, async () => {
  for (const fixture of [resolveFixture('tally'), resolveFixture('ledge')]) {
    const s = setup();
    try {
      let reads = 0;
      const steps = {
        setup: (ctx: any) => mkdirSync(path.join(ctx.work, '.hx'), { recursive: true }),
        arm: () => ({ usage: [], ended: 'done', t0: 0, t1: 1, nudges: 0 }),
        remoteMain: () => { reads++; return 'x'; },
        issues: () => [], clone: () => {},
        grade: () => ({ passed: 1, failed: 0, total: 1, failures: [] }),
        fuzz: () => ({ divergences: 0, classes: {} }),
        coverage: () => ({ tests: 'none', lines: 'n/a', branches: 'n/a' }),
      };
      const out = await runSet({ arm: 'chat', owner: 'me', stamp: '202611110900', fixture, resultsDir: path.join(s.dir, 'out'), tmp: s.dir,
        commit: 'abc', claudeBin: fakeClaude, steps, print: () => {} });
      const r = JSON.parse(readFileSync(out.files[0], 'utf8'));
      for (const k of ['phases', 'phase1Sha', 'phase1']) assert.equal(k in r, false, `${fixture.name}: ${k}`);
      assert.equal(reads, 0);
    } finally { s.done(); }
  }
});

test('stableScore: only the stable cases count; total is their number, passed those not among the failures', () => {
  const score = { passed: 2, failed: 3, total: 5, failures: ['a > s2', 'b > c1', 'b > c2'] };
  assert.deepEqual(stableScore(score, TAGS), { passed: 2, total: 3 });
  assert.deepEqual(stableScore({ ...score, failures: ['b > c1', 'b > c2'] }, TAGS), { passed: 3, total: 3 }, 'change failures never count');
  assert.deepEqual(stableScore({ ...score, failures: Object.keys(TAGS) }, TAGS), { passed: 0, total: 3 });
});

/** runSet on the two-phase fixture with a fake arm returning `armed`; grade fails `failuresOf(dir, ctx)` in each
 *  directory. Records every step's directory (and the sha phase1Checkout receives) in order, and the log. */
async function gradedSet(s: ReturnType<typeof setup>, armed: any, failuresOf: (dir: string, ctx: any) => string[] = () => [], over: any = {}) {
  const calls: string[] = [], lines: string[] = [];
  let run: any;
  const steps = {
    setup: (ctx: any) => { run = ctx; mkdirSync(path.join(ctx.work, '.hx'), { recursive: true }); },
    arm: () => armed,
    remoteMain: () => 'remote-at-stop',
    issues: () => [],
    clone: (ctx: any) => { calls.push(`clone ${ctx.clone}`); },
    phase1Checkout: (ctx: any, sha: string) => { calls.push(`phase1Checkout ${sha}`); return ctx.phase1Clone; },
    grade: (dir: string) => {
      calls.push(`grade ${dir}`);
      const f = failuresOf(dir, run);
      return { passed: 5 - f.length, failed: f.length, total: 5, failures: f };
    },
    fuzz: (dir: string) => { calls.push(`fuzz ${dir}`); return { divergences: 0, classes: {} }; },
    coverage: (dir: string) => { calls.push(`coverage ${dir}`); return { tests: 'none', lines: 'n/a', branches: 'n/a' }; },
    ...over,
  };
  const out = await runSet({ arm: 'chat', owner: 'me', stamp: '202611110900', fixture: s.fixture, resultsDir: path.join(s.dir, 'out'), tmp: s.dir,
    commit: 'abc', claudeBin: fakeClaude, steps, print: (l: string) => lines.push(l) });
  assert.deepEqual(out.failed, []);
  return { r: JSON.parse(readFileSync(out.files[0], 'utf8')), calls, lines, ctx: run };
}

const reachedPhase2 = (phase1Sha: string) => ({ usage: [], ended: 'done', t0: 0, t1: 10, boundary: 5, phase1Sha, nudges: 0, phaseNudges: [0, 0] });

test('runSet two-phase: a run that reached phase 2 grades a checkout at phase1Sha besides the final clone; phase1 counts its stable cases; fuzz and coverage only on the final clone', E2E, async () => {
  const s = setup();
  try {
    const sha = '1'.repeat(40);
    const { r, calls, lines, ctx } = await gradedSet(s, reachedPhase2(sha),
      (dir, c) => (dir === c.phase1Clone ? ['a > s1', 'b > c1', 'b > c2'] : ['b > c2']));
    assert.notEqual(ctx.clone, ctx.phase1Clone);
    assert.deepEqual(calls, [`clone ${ctx.clone}`, `grade ${ctx.clone}`, `phase1Checkout ${sha}`, `grade ${ctx.phase1Clone}`,
      `fuzz ${ctx.clone}`, `coverage ${ctx.clone}`]);
    assert.deepEqual([r.passed, r.total, r.failures], [4, 5, ['b > c2']], 'the final product is graded as today');
    assert.deepEqual(r.phase1, { passed: 2, total: 3 }, 'only the stable cases of the phase-1 grade');
    assert.equal(r.phase1Sha, sha);
    assert.match(lines.at(-1)!, /hidden 4\/5 · phase1 2\/3 · done/);
  } finally { s.done(); }
});

test('runSet two-phase: when phase1Sha equals the final commit both gradings still run', E2E, async () => {
  const s = setup();
  try {
    const { r, calls, ctx } = await gradedSet(s, reachedPhase2('remote-at-stop'));
    assert.deepEqual(calls.filter((c) => c.startsWith('grade ') || c.startsWith('phase1Checkout')),
      [`grade ${ctx.clone}`, 'phase1Checkout remote-at-stop', `grade ${ctx.phase1Clone}`]);
    assert.deepEqual(r.phase1, { passed: 3, total: 3 });
  } finally { s.done(); }
});

test('runSet two-phase: a run capped, or ended early, in phase 1 records phase1 from its final grade on the stable cases, with no second checkout', E2E, async () => {
  for (const ended of ['capped', 'early']) {
    const s = setup();
    try {
      const { r, calls, ctx } = await gradedSet(s, { usage: [], ended, t0: 0, t1: 10, boundary: null, nudges: 0, phaseNudges: [0] },
        () => ['a > s2', 'b > s3', 'b > c1']);
      assert.deepEqual(calls, [`clone ${ctx.clone}`, `grade ${ctx.clone}`, `fuzz ${ctx.clone}`, `coverage ${ctx.clone}`], ended);
      assert.deepEqual([r.ended, r.passed, r.total], [ended, 2, 5]);
      assert.deepEqual(r.phase1, { passed: 1, total: 3 }, ended);
      assert.deepEqual(r.phases.map((p: any) => p.name), ['brief']);
    } finally { s.done(); }
  }
});

test('runSet two-phase: a phase-1 checkout that throws is recorded as phase1Error and the results file is still written', E2E, async () => {
  const s = setup();
  try {
    const { r, calls, lines } = await gradedSet(s, reachedPhase2('2'.repeat(40)), undefined,
      { phase1Checkout: () => { throw new Error('clone failed: no such commit'); } });
    assert.equal('phase1' in r, false);
    assert.equal(r.phase1Error, 'clone failed: no such commit');
    assert.deepEqual([r.passed, r.total], [5, 5], 'the final grade stands');
    assert.ok(calls.some((c) => c.startsWith('fuzz ')) && calls.some((c) => c.startsWith('coverage ')));
    assert.ok(lines.some((l) => /phase 1 grade failed: clone failed/.test(l)));
    assert.match(lines.at(-1)!, /hidden 5\/5 · phase1 error · done/);
  } finally { s.done(); }
});

test('the real phase1Checkout step refuses a run with no phase1Sha (the remote read failed)', () => {
  assert.throws(() => STEPS.phase1Checkout({ phase1Clone: 'x', repo: 'o/r' }, null), /no phase1Sha/);
});
