// The project benchmark runner's pure parts (bench/project-lib.mjs): the caps, escaped defects, the repo
// setup step, the result fields, the arguments and the provenance; and the run loop (bench/project.mjs runSet) with
// fake steps, and the fuzz and coverage after the hidden tests on a fake arm's graded clone. No gh, no claude, no
// usage spent.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: a plain .mjs bench module
import { USAGE, auditFails, capCheck, chatSession, escapedDefects, gateReds, parseArgs, parseJsonl, provenanceRoles, sessionsByRole, setupRepo, usageTotals } from '../bench/project-lib.mjs';
// @ts-ignore: a plain .mjs bench module
import { STEPS, chatArm, qualityLine, runSet } from '../bench/project.mjs';
// @ts-ignore: a plain .mjs bench module
import { coverage } from '../bench/project-coverage.mjs';
// @ts-ignore: a plain .mjs bench module
import { fuzz, genHash } from '../bench/project-fuzz.mjs';
import { DEFAULTS, ROLES, roleModel, workerArgs, type Config } from '../src/config.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'bench', 'project');
const H = 3_600_000;

const walk = (dir: string, rel = ''): string[] => readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(dir, path.join(rel, d.name)) : [path.join(rel, d.name).split(path.sep).join('/')]));

test('capCheck: continue under both caps, stop at and past the hour cap and the dollar cap', E2E, () => {
  const c = (elapsedMs: number, costUsd: number) => capCheck({ elapsedMs, costUsd, maxHours: 4, maxUsd: 60 });
  assert.equal(c(0, 0), 'continue');
  assert.equal(c(4 * H - 1, 59.99), 'continue');
  assert.equal(c(4 * H, 0), 'stop');
  assert.equal(c(5 * H, 10), 'stop');
  assert.equal(c(H, 60), 'stop');
  assert.equal(c(H, 75.5), 'stop');
  assert.equal(capCheck({ elapsedMs: 0.5 * H, costUsd: 1, maxHours: 0.5, maxUsd: 60 }), 'stop');
});

test('escapedDefects: failed for done, null for capped and early, 0 for a clean done run', E2E, () => {
  assert.equal(escapedDefects(7, 'done'), 7);
  assert.equal(escapedDefects(0, 'done'), 0);
  assert.equal(escapedDefects(7, 'capped'), null);
  assert.equal(escapedDefects(7, 'early'), null);
  assert.equal(escapedDefects(0, 'early'), null);
});

test('setupRepo: one commit whose tree is the template; nothing from hidden/ or reference/', E2E, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hxp-setup-'));
  try {
    setupRepo(dir);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(git('branch', '--show-current').trim(), 'main');
    const template = walk(path.join(project, 'template')).sort();
    const tree = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort();
    assert.deepEqual(tree, template);
    for (const f of tree) assert.equal(git('show', `HEAD:${f}`), readFileSync(path.join(project, 'template', f), 'utf8'), f);
    const working = walk(dir).filter((f) => !f.startsWith('.git/')).sort();
    assert.deepEqual(working, template);
    // no hidden or reference file by name or by content, in the tree or the working dir
    const contents = new Set(working.map((f) => readFileSync(path.join(dir, f), 'utf8')));
    for (const sub of ['hidden', 'reference']) {
      for (const f of walk(path.join(project, sub))) {
        const text = readFileSync(path.join(project, sub, f), 'utf8');
        // the reference's package.json is the template's own: a file the template ships is allowed
        if (template.includes(f) && readFileSync(path.join(project, 'template', f), 'utf8') === text) continue;
        const base = path.posix.basename(f);
        assert.ok(!working.some((w) => path.posix.basename(w) === base), `${sub}/${f} by name`);
        assert.ok(!contents.has(text), `${sub}/${f} by content`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('result helpers: sessions by role, token and cost sums, audit FAILs, gate reds', E2E, () => {
  const u = (role: string, sessionId: string, input: number, output: number, costUsd: number) =>
    ({ role, sessionId, usage: { input, cacheWrite: 1, cacheRead: 2, output }, costUsd });
  const records = [u('impl', 'a', 10, 5, 0.5), u('impl', 'a', 20, 5, 0.25), u('impl', 'b', 1, 1, 1),
    u('review', 'c', 3, 3, 2), { role: 'audit', sessionId: 'd' }];
  assert.deepEqual(sessionsByRole(records), { impl: 2, review: 1, audit: 1 });
  assert.deepEqual(sessionsByRole([]), {});
  const t = usageTotals(records);
  assert.deepEqual(t.tokens, { input: 34, cacheWrite: 4, cacheRead: 8, output: 14, total: 60 });
  assert.equal(t.costUsd, 3.75);
  assert.deepEqual(usageTotals([]), { tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }, costUsd: 0 });

  const runLog = [
    '2026-11-01T10:00:00.000Z [#3] audit FAIL ✗ missing test',
    '2026-11-01T10:05:00.000Z [#3] audit PASS ✓',
    '2026-11-01T10:06:00.000Z [#4] audit FAIL ✗ wrong rounding',
    'audit FAIL ✗ no timestamp: not counted',
    '2026-11-01T10:07:00.000Z [#4] note: audit FAIL ✗ not at the start',
  ].join('\r\n');
  assert.equal(auditFails(runLog), 2);
  assert.equal(auditFails(''), 0);

  const gate = [{ ok: true }, { ok: false, sha: 'a' }, { ok: false, sha: 'b' }, { sha: 'c' }]
    .map((x) => JSON.stringify(x)).join('\n') + '\n{"ok": false, torn\n\n';
  assert.equal(gateReds(gate), 2);
  assert.equal(gateReds(''), 0);

  assert.deepEqual(parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

test('bench/project.mjs parses, and no prompt names the hidden suite', E2E, () => {
  execFileSync(process.execPath, ['--check', path.join(root, 'bench', 'project.mjs')]);
  const src = readFileSync(path.join(root, 'bench', 'project.mjs'), 'utf8');
  assert.ok(!/project[\\/]hidden|hidden (tests?|suite)/i.test(src.split('// 4.')[0].replace(/^\/\/.*$/gm, '')));
});

// what claude.ts gives every session: never part of a role's recorded flags
const PER_SESSION = ['-p', '--output-format', '--verbose', '--permission-mode', '--model', '--effort', '--session-id', '--resume'];
const LEAN = ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local', '--tools', ...DEFAULTS.workerTools];
const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, repo: 'o/r', defaultBranch: 'main', worktreeRoot: 'wt', ...over } as Config);

test('parseArgs: --runs defaults to 1 and must be a positive integer; the caps as before', E2E, () => {
  assert.deepEqual(parseArgs(['chat']), { arm: 'chat', runs: 1, maxHours: 4, maxUsd: 60 });
  assert.deepEqual(parseArgs(['hx3', '--runs', '5', '--max-hours', '0.5', '--max-usd', '10']), { arm: 'hx3', runs: 5, maxHours: 0.5, maxUsd: 10 });
  for (const bad of [['--runs', '0'], ['--runs', '-1'], ['--runs', '1.5'], ['--runs'], ['--runs', ''], ['--runs', 'x'], ['--runs', '--max-hours', '4'], ['--max-hours', '0'], ['--max-usd']])
    assert.equal(parseArgs(['chat', ...bad]), null, bad.join(' '));
  assert.equal(parseArgs(['hx1']), null);
  assert.equal(parseArgs([]), null);
  assert.match(USAGE, /<chat\|hx3> \[--runs N\]/);
});

test('bench/project.mjs: a bad --runs prints the usage line and exits 2, before any gh call', E2E, () => {
  for (const bad of [['--runs', '0'], ['--runs', '-1'], ['--runs', '1.5'], ['--runs']]) {
    let err: any;
    try { execFileSync(process.execPath, [path.join(root, 'bench', 'project.mjs'), 'chat', ...bad], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: '' } }); }
    catch (e) { err = e; }
    assert.ok(err, bad.join(' '));
    assert.equal(err.status, 2, bad.join(' '));
    assert.equal(err.stderr.trim(), USAGE);
  }
});

test('chatSession: the default model and effort, and the lean flags with --tools of the default workerTools', E2E, () => {
  const s = chatSession();
  assert.equal(s.model, DEFAULTS.model);
  assert.equal(s.effort, DEFAULTS.effort);
  assert.deepEqual(s.extraArgs, workerArgs(cfg()));
  assert.deepEqual(s.extraArgs.slice(0, LEAN.length), LEAN);
});

test('chatArm: its session is given the lean flags, with --tools of the default workerTools, and chatSession\'s model and effort', E2E, async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'hxp-chat-'));
  try {
    mkdirSync(path.join(work, '.hx'));
    const seen: any[] = [];
    const run = async (o: any) => {
      seen.push(o);
      o.onTurn(1, 's1', { ok: true, durationMs: 10, usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 }, costUsd: 0.5 });
      return { stopReason: 'promise', iterations: 1 };
    };
    const r = await chatArm({ arm: 'chat', repo: 'o/r', work, maxHours: 4, maxUsd: 60, log: () => {} }, { run });
    assert.equal(seen.length, 1);
    const flags: string[] = seen[0].extraArgs;
    for (const f of ['--strict-mcp-config', '--disable-slash-commands']) assert.ok(flags.includes(f), f);
    assert.equal(flags[flags.indexOf('--setting-sources') + 1], 'project,local');
    const t = flags.indexOf('--tools');
    assert.ok(t >= 0);
    assert.deepEqual(flags.slice(t + 1, t + 1 + DEFAULTS.workerTools.length), DEFAULTS.workerTools);
    assert.equal(seen[0].model, DEFAULTS.model);
    assert.equal(seen[0].effort, DEFAULTS.effort);
    assert.equal(r.ended, 'done');
    assert.equal(r.usage.length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('provenanceRoles hx3: every role, roleModels for the one it sets, roleModel defaults for the rest, workerArgs flags', E2E, () => {
  const c = cfg({ roleModels: { review: { model: 'claude-sonnet-5-5', effort: 'high' } }, claudeArgs: ['--add-dir', 'x'] });
  const roles = provenanceRoles('hx3', { config: c });
  assert.deepEqual(Object.keys(roles).sort(), [...ROLES].sort());
  assert.deepEqual([roles.review.model, roles.review.effort], ['claude-sonnet-5-5', 'high']);
  for (const r of ROLES) {
    if (r !== 'review') assert.deepEqual({ model: roles[r].model, effort: roles[r].effort }, roleModel(cfg(), r), r);
    assert.deepEqual(roles[r].flags, workerArgs(c), r);
    for (const f of PER_SESSION) assert.ok(!roles[r].flags.includes(f), `${r} ${f}`);
  }
  assert.equal(roles.bar.effort, 'high'); // roleModel's own default for bar
});

test('provenanceRoles chat: only role chat, with its model, effort and lean flags', E2E, () => {
  const roles = provenanceRoles('chat');
  assert.deepEqual(Object.keys(roles), ['chat']);
  assert.deepEqual(roles.chat, { model: DEFAULTS.model, effort: DEFAULTS.effort, flags: chatSession().extraArgs });
  assert.deepEqual(roles.chat.flags.slice(0, LEAN.length), LEAN);
  for (const f of PER_SESSION) assert.ok(!roles.chat.flags.includes(f), f);
  assert.deepEqual(provenanceRoles('chat', { chat: { model: 'm', effort: 'low', extraArgs: ['--a'] } }), { chat: { model: 'm', effort: 'low', flags: ['--a'] } });
});

/** Fake per-run steps: no gh, no claude. The setup writes .hx/config.json as the benchmark's edits leave it. */
function fakeSteps(calls: any[], throwOn = 0) {
  return {
    setup: (ctx: any) => {
      calls.push({ step: 'setup', i: ctx.i, ctx });
      mkdirSync(path.join(ctx.work, '.hx'), { recursive: true });
      writeFileSync(path.join(ctx.work, '.hx', 'config.json'), JSON.stringify({ workers: 3, worktreeRoot: ctx.worktreeRoot,
        roleModels: { impl: { model: 'claude-sonnet-5-5', effort: 'low' } } }));
    },
    arm: (ctx: any) => {
      calls.push({ step: 'arm', i: ctx.i });
      if (ctx.i === throwOn) throw new Error('gh repo create failed');
      return { usage: [{ role: 'impl', sessionId: `s${ctx.i}`, usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 }, costUsd: 1 }], ended: 'done', t0: 1_000, t1: 61_000 };
    },
    issues: (ctx: any) => { calls.push({ step: 'issues', i: ctx.i }); return [{ number: 1, state: 'CLOSED' }, { number: 2, state: 'OPEN' }]; },
    clone: (ctx: any) => { calls.push({ step: 'clone', i: ctx.i, clone: ctx.clone }); },
    grade: (dir: string) => { calls.push({ step: 'grade', dir }); return { passed: 9, failed: 1, total: 10, failures: ['x'] }; },
    fuzz: (dir: string) => { calls.push({ step: 'fuzz', dir }); return { seed: 1107, count: 1, genHash: 'h', timeLimitMs: 5000, divergences: 0, classes: {}, excluded: { count: 0, examples: [] }, examples: {} }; },
    coverage: (dir: string) => { calls.push({ step: 'coverage', dir }); return { tests: 'none', lines: 'n/a', branches: 'n/a' }; },
  };
}

test('runSet --runs 3 with a fake arm: three results files under one stamp, each run its own repo, dirs and provenance', E2E, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hxp-set-'));
  try {
    const resultsDir = path.join(dir, 'results', 'project');
    const calls: any[] = [];
    const out = await runSet({ arm: 'hx3', runs: 3, maxHours: 2, maxUsd: 30, owner: 'me', stamp: '202611071200', resultsDir, tmp: dir,
      claudeBin: path.join(root, 'test', 'fakes', 'claude.mjs'), steps: fakeSteps(calls), print: () => {} });
    assert.deepEqual(out, { stamp: '202611071200', files: [1, 2, 3].map((i) => path.join(resultsDir, `hx3-202611071200-${i}.json`)), failed: [] });
    assert.deepEqual(readdirSync(resultsDir).sort(), ['hx3-202611071200-1.json', 'hx3-202611071200-2.json', 'hx3-202611071200-3.json']);
    assert.ok(!existsSync(path.join(dir, 'results', 'project-hx3.json')));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const setups = calls.filter((c) => c.step === 'setup').map((c) => c.ctx);
    assert.equal(setups.length, 3);
    for (const i of [1, 2, 3]) {
      const ctx = setups[i - 1];
      for (const p of [ctx.work, ctx.worktreeRoot, ctx.clone]) assert.equal(path.basename(p), `hx3-202611071200-${i}`, p);
      assert.deepEqual([ctx.maxHours, ctx.maxUsd], [2, 30]);
      const r = JSON.parse(readFileSync(path.join(resultsDir, `hx3-202611071200-${i}.json`), 'utf8'));
      assert.equal(r.repo, `me/hx-project-hx3-202611071200-${i}`);
      assert.deepEqual([r.run, r.stamp], [i, '202611071200']);
      assert.deepEqual([r.passed, r.total, r.issuesFiled, r.issuesClosed, r.costUsd, r.wallMs, r.maxHours, r.maxUsd], [9, 10, 2, 1, 1, 60_000, 2, 30]);
      assert.equal(r.provenance.claudeVersion, '2.0.0 (Claude Code)');
      assert.equal(r.provenance.hxCommit, head);
      assert.deepEqual(Object.keys(r.provenance.roles).sort(), [...ROLES].sort());
      // from the config after the benchmark's edits, as hx run loads it
      assert.deepEqual(r.provenance.roles.impl, { model: 'claude-sonnet-5-5', effort: 'low', flags: workerArgs(cfg()) });
      assert.deepEqual(r.provenance.roles.review, { ...roleModel(cfg(), 'review'), flags: workerArgs(cfg()) });
    }
    for (const k of ['work', 'worktreeRoot', 'clone']) assert.equal(new Set(setups.map((c) => c[k])).size, 3, k);
    assert.deepEqual(calls.filter((c) => c.step === 'grade').map((c) => c.dir), setups.map((c) => c.clone));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSet: a run that throws is logged with its i, the next run goes on, and it is reported failed', E2E, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hxp-set-'));
  try {
    const resultsDir = path.join(dir, 'out');
    const lines: string[] = [];
    const out = await runSet({ arm: 'chat', runs: 3, owner: 'me', stamp: '202611071300', resultsDir, tmp: dir, commit: 'abc123',
      claudeBin: path.join(root, 'test', 'fakes', 'claude.mjs'), steps: fakeSteps([], 2), print: (m: string) => lines.push(m) });
    assert.deepEqual(out.failed, [2]);
    assert.deepEqual(readdirSync(resultsDir).sort(), ['chat-202611071300-1.json', 'chat-202611071300-3.json']);
    assert.ok(lines.some((l) => /\[project chat 2\/3\] run 2 failed: gh repo create failed/.test(l)), lines.join('\n'));
    const r = JSON.parse(readFileSync(path.join(resultsDir, 'chat-202611071300-3.json'), 'utf8'));
    assert.deepEqual(r.provenance, { claudeVersion: '2.0.0 (Claude Code)', hxCommit: 'abc123',
      roles: { chat: { model: DEFAULTS.model, effort: DEFAULTS.effort, flags: chatSession().extraArgs } } });
    assert.equal(r.auditFails, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fuzz and coverage after the hidden tests (#406): the fake arm, the real fuzz and coverage, run small ---

const reference = path.join(project, 'reference');
const SMALL_FUZZ = { count: 12, timeLimitMs: 60_000 };

/** Fake steps whose clone step fills the grade clone with `fill(dir, i)`; the real fuzz and coverage, unless given. */
function cloneSteps(fill: (dir: string, i: number) => void, ended: (i: number) => string = () => 'done', over: any = {}) {
  return {
    ...fakeSteps([]),
    arm: (ctx: any) => ({ usage: [], ended: ended(ctx.i), t0: 0, t1: 1_000 }),
    clone: (ctx: any) => { mkdirSync(ctx.clone, { recursive: true }); fill(ctx.clone, ctx.i); },
    fuzz: STEPS.fuzz, coverage: STEPS.coverage,
    ...over,
  };
}

/** runSet over `steps` in a temp dir; `check` gets every run's results file and the log lines. */
async function withSet(steps: any, opts: any, check: (results: any[], lines: string[]) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hxp-q-'));
  try {
    const resultsDir = path.join(dir, 'out');
    const lines: string[] = [];
    const out = await runSet({ arm: 'chat', owner: 'me', stamp: '202611080900', resultsDir, tmp: dir, commit: 'abc',
      claudeBin: path.join(root, 'test', 'fakes', 'claude.mjs'), steps, print: (m: string) => lines.push(m), ...opts });
    assert.deepEqual(out.failed, [], lines.join('\n'));
    check(out.files.map((f: string) => JSON.parse(readFileSync(f, 'utf8'))), lines);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test('STEPS: the real fuzz and coverage; the CLI passes them no options, so they run with their defaults', E2E, () => {
  assert.equal(STEPS.fuzz, fuzz);
  assert.equal(STEPS.coverage, coverage);
  const src = readFileSync(path.join(root, 'bench', 'project.mjs'), 'utf8');
  assert.match(src.split('if (process.argv[1]')[1], /runSet\(\{ \.\.\.args, owner \}\)/);
});

test('runSet: a graded copy of the reference gets fuzz (seed, count, genHash, 0 divergences) and coverage; so does a capped run, still capped', E2E, async () => {
  // run 1 ends done, with a passing own test added; run 2 is capped, a bare copy (no own tests)
  const fill = (dir: string, i: number) => {
    cpSync(reference, dir, { recursive: true });
    if (i === 1) {
      mkdirSync(path.join(dir, 'test'));
      writeFileSync(path.join(dir, 'test', 'load.test.mjs'),
        `import { test } from 'node:test';\nimport * as m from '../src/tally.js';\ntest('loads', () => { if (!m) throw new Error('no module'); });\n`);
    }
  };
  await withSet(cloneSteps(fill, (i) => (i === 1 ? 'done' : 'capped')), { runs: 2, fuzzOptions: SMALL_FUZZ }, (results, lines) => {
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.deepEqual({ seed: r.fuzz.seed, count: r.fuzz.count, genHash: r.fuzz.genHash, divergences: r.fuzz.divergences, classes: r.fuzz.classes },
        { seed: 1107, count: 12, genHash: genHash(), divergences: 0, classes: {} });
      assert.ok(!('fuzzError' in r) && !('coverageError' in r));
    }
    const [done, capped] = results;
    assert.equal(done.ended, 'done');
    assert.equal(done.coverage.tests, 'passed');
    assert.ok(done.coverage.lines.total > 0 && done.coverage.lines.covered > 0, JSON.stringify(done.coverage));
    assert.deepEqual([capped.ended, capped.capped], ['capped', true]);
    assert.deepEqual(capped.coverage, { tests: 'none', lines: 'n/a', branches: 'n/a' });
    const closing = lines.filter((l) => /hidden 9\/10/.test(l));
    assert.equal(closing.length, 2, lines.join('\n'));
    const c = done.coverage;
    assert.ok(closing[0].includes(`fuzz 0 divergences in 0 classes · coverage ${c.lines.covered}/${c.lines.total} lines, ${c.branches.covered}/${c.branches.total} branches`), closing[0]);
    assert.ok(closing[1].includes('fuzz 0 divergences in 0 classes · coverage n/a (own tests none)'), closing[1]);
  });
});

test('runSet: a graded checkout with no CLI records the no CLI class and coverage n/a', E2E, async () => {
  const fill = (dir: string) => writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tally', scripts: { test: 'node --test' } }));
  await withSet(cloneSteps(fill), { fuzzOptions: SMALL_FUZZ }, ([r], lines) => {
    assert.deepEqual([r.fuzz.divergences, r.fuzz.classes], [12, { 'no CLI': 12 }]);
    assert.deepEqual(r.coverage, { tests: 'none', lines: 'n/a', branches: 'n/a' });
    assert.ok(lines.some((l) => l.includes('fuzz 12 divergences in 1 classes · coverage n/a')), lines.join('\n'));
  });
});

test('runSet: an own test that never ends, with a short coverage time limit, records failed and n/a; the results file is written', E2E, async () => {
  const fill = (dir: string) => {
    cpSync(reference, dir, { recursive: true });
    mkdirSync(path.join(dir, 'test'));
    writeFileSync(path.join(dir, 'test', 'hang.test.mjs'), `import { test } from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n`);
  };
  // the short limit is the point here: the suite never ends, so it is killed at the limit whatever the machine's load
  await withSet(cloneSteps(fill), { fuzzOptions: SMALL_FUZZ, coverageOptions: { timeoutMs: 3_000 } }, ([r], lines) => {
    assert.deepEqual(r.coverage, { tests: 'failed', lines: 'n/a', branches: 'n/a' });
    assert.equal(r.fuzz.divergences, 0);
    assert.ok(lines.some((l) => l.includes('coverage n/a (own tests failed)')), lines.join('\n'));
  });
});

test('runSet: a fuzz that throws leaves a written results file without fuzz, the error beside it and logged; coverage still runs', E2E, async () => {
  let covered = 0;
  const steps = cloneSteps((dir) => cpSync(reference, dir, { recursive: true }), undefined, {
    coverage: () => { covered++; return { tests: 'none', lines: 'n/a', branches: 'n/a' }; },
  });
  // the injected failure: a reference that does not exist has no CLI, and the real fuzz throws on it
  await withSet(steps, { fuzzOptions: { ...SMALL_FUZZ, reference: path.join(os.tmpdir(), 'hxp-no-such-reference') } }, ([r], lines) => {
    assert.ok(!('fuzz' in r));
    assert.match(r.fuzzError, /has no CLI/);
    assert.deepEqual(r.coverage, { tests: 'none', lines: 'n/a', branches: 'n/a' });
    assert.equal(covered, 1);
    assert.ok(lines.some((l) => /fuzz failed: .*has no CLI/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /hidden 9\/10 .*fuzz error: .*has no CLI.* · coverage n\/a/.test(l)), lines.join('\n'));
  });
});

test('runSet: a coverage that throws leaves fuzz in place and coverageError beside it', E2E, async () => {
  const steps = { ...fakeSteps([]), coverage: () => { throw new Error('injected coverage failure'); } };
  await withSet(steps, {}, ([r], lines) => {
    assert.equal(r.fuzz.divergences, 0);
    assert.ok(!('coverage' in r));
    assert.equal(r.coverageError, 'injected coverage failure');
    assert.ok(lines.some((l) => l.includes('coverage failed: injected coverage failure')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('coverage error: injected coverage failure →')), lines.join('\n'));
  });
});

test('runSet: grade, then fuzz, then coverage, all on the graded clone, with the options passed through', E2E, async () => {
  const calls: any[] = [];
  const steps = { ...fakeSteps(calls),
    fuzz: (dir: string, o: any) => { calls.push({ step: 'fuzz', dir, o }); return { divergences: 1, classes: { 'a / stdout': 1 } }; },
    coverage: (dir: string, o: any) => { calls.push({ step: 'coverage', dir, o }); return { tests: 'passed', lines: { covered: 3, total: 4 }, branches: { covered: 0, total: 0 } }; } };
  await withSet(steps, { fuzzOptions: { count: 7 }, coverageOptions: { timeoutMs: 9 } }, (_r, lines) => {
    const names = calls.map((c) => c.step);
    assert.deepEqual(names.slice(names.indexOf('grade')), ['grade', 'fuzz', 'coverage']);
    const [g, f, c] = calls.slice(names.indexOf('grade'));
    assert.equal(f.dir, g.dir);
    assert.equal(c.dir, g.dir);
    assert.deepEqual([f.o, c.o], [{ count: 7 }, { timeoutMs: 9 }]);
    assert.ok(lines.some((l) => l.includes('fuzz 1 divergences in 1 classes · coverage 3/4 lines, 0/0 branches')), lines.join('\n'));
  });
});

test("qualityLine: divergences and classes, lines and branches, the own tests' state, or each error", E2E, () => {
  const lb = { tests: 'passed', lines: { covered: 1, total: 2 }, branches: { covered: 0, total: 1 } };
  assert.equal(qualityLine({ fuzz: { divergences: 5, classes: { a: 3, b: 2 } }, coverage: lb }), 'fuzz 5 divergences in 2 classes · coverage 1/2 lines, 0/1 branches');
  assert.equal(qualityLine({ fuzzError: 'x', coverage: { tests: 'failed', lines: 'n/a', branches: 'n/a' } }), 'fuzz error: x · coverage n/a (own tests failed)');
  assert.equal(qualityLine({ fuzz: { divergences: 0, classes: {} }, coverageError: 'y' }), 'fuzz 0 divergences in 0 classes · coverage error: y');
});
