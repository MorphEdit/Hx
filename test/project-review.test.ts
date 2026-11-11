// bench/project-review.mjs: the blind review of two project-benchmark runs. A fake judge (no Claude session) and a
// fake clone (no gh); the checkouts are fixture git repos in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pr = await import(pathToFileURL(path.join(root, 'bench', 'project-review.mjs')).href);
const results = await import(pathToFileURL(path.join(root, 'bench', 'project-results.mjs')).href);

const REPO = 'octo-owner/tally-thing';
const SOURCE = '// by Jane Doe <jane.doe@example.org>, committed by Rob Smith rob@smith.dev\n'
  + '// built with Claude for hx3 and Chat, anthropic, octo-owner/tally-thing, HX\n'
  + '// chatter stays, hxtool stays, claudette stays\n';
const REDACTED = '// by [redacted] <[redacted]>, committed by [redacted] [redacted]\n'
  + '// built with [redacted] for [redacted] and [redacted], [redacted], [redacted]/[redacted], [redacted]\n'
  + '// chatter stays, hxtool stays, claudette stays\n';
const BINARY = Buffer.from([0, 1, 2, ...Buffer.from(' claude hx ')]);

function write(dir: string, files: Record<string, string | Buffer>) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
}

/** A git repo whose author is Jane Doe and committer Rob Smith, holding every kind of file the copy must handle. */
function checkout(tag: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  write(dir, {
    'src/main.js': `// project ${tag}\n${SOURCE}`, 'README.md': `# tally ${tag}\nUse it.\n`, 'package.json': '{"name":"tally"}\n',
    'test/main.test.js': 'ok\n', 'assets/logo.bin': BINARY,
    'CLAUDE.md': 'notes\n', '.claude/settings.json': '{}\n', '.hx/config.json': '{}\n', 'node_modules/dep/index.js': 'x\n',
  });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'jane.doe@example.org',
    GIT_COMMITTER_NAME: 'Rob Smith', GIT_COMMITTER_EMAIL: 'rob@smith.dev' };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

function tree(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => {
    const p = rel ? `${rel}/${d.name}` : d.name;
    return d.isDirectory() ? tree(dir, p) : [p];
  }).sort();
}

const SCORES = {
  X: { correctness: 9, edgeCases: 8, errorMessages: 7, clarity: 8, tests: 6, docs: 4 }, // mean 7
  Y: { correctness: 5, edgeCases: 4, errorMessages: 6, clarity: 5, tests: 3, docs: 1 }, // mean 4
};

type Call = { prompt: string; cwd: string; model: string; effort: string; flags: string[]; a: string; b: string; files: string[] };

/** A fake judge that tells the copies apart by their main.js and scores X and Y by SCORES; `reply` may override. */
function fakeJudge(reply?: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const judge = async (o: Omit<Call, 'a' | 'b' | 'files'>) => {
    const tag = (l: string) => /project (\w)/.exec(readFileSync(path.join(o.cwd, l, 'src', 'main.js'), 'utf8'))![1];
    const call = { ...o, a: tag('A'), b: tag('B'), files: tree(o.cwd) };
    calls.push(call);
    const custom = reply?.(call, calls.length);
    if (custom !== undefined) return custom;
    const text = JSON.stringify({ A: (SCORES as any)[call.a], B: (SCORES as any)[call.b] });
    return { text, usage: { input: 100, cacheWrite: 20, cacheRead: 300, output: 40 }, costUsd: 0.5 };
  };
  return { judge, calls };
}

const brief = '# tally\nA brief.\n';

test('anonymise: no .git, .hx, node_modules or named file; every name redacted as a whole word; nothing else dropped', () => {
  const src = checkout('X');
  const names = pr.checkoutNames(src, REPO);
  for (const n of ['hx', 'hx3', 'chat', 'claude', 'anthropic', 'octo-owner', 'tally-thing', 'Jane Doe', 'jane.doe@example.org', 'Rob Smith', 'rob@smith.dev'])
    assert.ok(names.includes(n), `names hold ${n}`);
  const dest = path.join(mkdtempSync(path.join(os.tmpdir(), 'hx-rv-')), 'A');
  pr.anonymise(src, dest, names);
  assert.deepEqual(tree(dest), ['README.md', 'assets/logo.bin', 'package.json', 'src/main.js', 'test/main.test.js']);
  assert.equal(readFileSync(path.join(dest, 'src', 'main.js'), 'utf8'), `// project X\n${REDACTED}`);
  assert.deepEqual(readFileSync(path.join(dest, 'assets', 'logo.bin')), BINARY);
  assert.equal(readFileSync(path.join(dest, 'README.md'), 'utf8'), '# tally X\nUse it.\n');
});

test('anonymise: invalid UTF-8 keeps its other bytes', () => {
  const src = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  write(src, { 'a.txt': Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' by claude\n')]) });
  const dest = path.join(src, '..', path.basename(src) + '-copy');
  pr.anonymise(src, dest, ['claude']);
  assert.deepEqual(readFileSync(path.join(dest, 'a.txt')),
    Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' by [redacted]\n')]));
});

test('review asks 3 judges in both orders: 6 calls, the second order with the copies swapped, in A/B dirs beside brief.md', async () => {
  const x = checkout('X'), y = checkout('Y');
  const { judge, calls } = fakeJudge();
  const r = await pr.review(x, y, { judge, brief, repoX: REPO, repoY: REPO, version: 'v9' });
  assert.equal(calls.length, 6);
  for (let j = 0; j < 3; j++) {
    const [first, second] = [calls[2 * j], calls[2 * j + 1]];
    assert.deepEqual([second.a, second.b], [first.b, first.a]);
    assert.notEqual(first.a, first.b);
  }
  assert.deepEqual(calls.map((c) => c.a === 'X'), pr.firstOrders(pr.SEED, 3).flatMap((f: boolean) => [f, !f]));
  for (const c of calls) {
    assert.deepEqual([...new Set(c.files.map((f) => f.split('/')[0]))].sort(), ['A', 'B', 'brief.md']);
    assert.equal(c.files.includes('A/CLAUDE.md') || c.files.some((f) => f.includes('.git') || f.includes('.claude')), false);
    assert.equal(c.model, 'claude-opus-5-5');
    assert.ok(c.prompt.includes('A brief.'), 'the prompt holds the brief');
    for (const k of ['correctness', 'edgeCases', 'errorMessages', 'clarity', 'tests', 'docs']) assert.ok(c.prompt.includes(k));
    assert.equal(existsSync(c.cwd), false, 'the review directory is removed');
  }
  assert.equal(r.seed, pr.SEED);
});

test('each copy scores the mean of its 6 verdicts, each verdict with its per-criterion scores', async () => {
  const { judge } = fakeJudge();
  const r = await pr.review(checkout('X'), checkout('Y'), { judge, brief, version: 'v9' });
  assert.equal(r.x.verdicts.length, 6);
  assert.equal(r.x.basedOn, 6);
  assert.equal(r.x.score, 7);
  assert.equal(r.y.score, 4);
  for (const v of r.x.verdicts) { assert.deepEqual(v.scores, SCORES.X); assert.equal(v.value, 7); }
  assert.deepEqual(r.x.verdicts.map((v: any) => [v.judge, v.order]), [[1, 'AB'], [1, 'BA'], [2, 'AB'], [2, 'BA'], [3, 'AB'], [3, 'BA']]);
  for (let i = 0; i < 6; i++) assert.notEqual(r.x.verdicts[i].label, r.y.verdicts[i].label);
  assert.deepEqual(r.x.missing, []);
  assert.deepEqual(r.tokens, { input: 600, cacheWrite: 120, cacheRead: 1800, output: 240, total: 2760 });
  assert.equal(r.costUsd, 3);
});

test('a bad reply is retried once: a good retry counts, two bad replies are missing with the reason and the score is based on 5', async () => {
  const bad = { text: 'I think A is better.', usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 }, costUsd: 0.1 };
  const outOfRange = { text: JSON.stringify({ A: { ...SCORES.X, docs: 11 }, B: SCORES.Y }) };
  const noTests = { text: JSON.stringify({ A: { ...SCORES.X, tests: undefined }, B: SCORES.Y }) };
  // call 2 bad then call 3 good (judge 1 BA retried); calls 4 and 5 bad (judge 2 AB missing)
  const { judge, calls } = fakeJudge((_c, n) => (n === 2 ? bad : n === 4 ? outOfRange : n === 5 ? noTests : undefined));
  const r = await pr.review(checkout('X'), checkout('Y'), { judge, brief, version: 'v9' });
  assert.equal(calls.length, 8);
  assert.equal(r.x.basedOn, 5);
  assert.equal(r.y.basedOn, 5);
  assert.equal(r.x.score, 7);
  assert.equal(r.x.missing.length, 1);
  assert.deepEqual({ ...r.x.missing[0], reason: undefined }, { judge: 2, order: 'AB', reason: undefined });
  assert.match(r.x.missing[0].reason, /tests missing/);
  assert.deepEqual(r.y.missing, r.x.missing);
  assert.ok(Math.abs(r.costUsd - (5 * 0.5 + 0.1)) < 1e-9, 'every attempt is counted');
  assert.equal(pr.parseReply(outOfRange.text).error.includes('docs'), true);
});

test('a judge error (a usage limit), returned or thrown, is retried once and then recorded as missing', async () => {
  const { judge } = fakeJudge((_c, n) => (n === 1 ? { error: 'usage limit' } : n === 2 ? (() => { throw new Error('usage limit'); })() : undefined));
  const r = await pr.review(checkout('X'), checkout('Y'), { judge, brief, version: 'v9' });
  assert.equal(r.x.basedOn, 5);
  assert.deepEqual(r.x.missing.map((m: any) => [m.judge, m.order]), [[1, 'AB']]);
  assert.match(r.x.missing[0].reason, /usage limit/);
});

test('the judges get the lean set and --tools Read Glob Grep, none of Bash, Edit, Write', async () => {
  const { judge, calls } = fakeJudge();
  const r = await pr.review(checkout('X'), checkout('Y'), { judge, brief, version: 'v9' });
  for (const flags of [...calls.map((c) => c.flags), r.judges.flags]) {
    for (const f of ['--strict-mcp-config', '--disable-slash-commands']) assert.ok(flags.includes(f));
    const s = flags.indexOf('--setting-sources');
    assert.equal(flags[s + 1], 'project,local');
    const t = flags.indexOf('--tools');
    assert.deepEqual(flags.slice(t + 1), ['Read', 'Glob', 'Grep']);
    for (const f of ['Bash', 'Edit', 'Write']) assert.equal(flags.includes(f), false);
  }
  assert.deepEqual(r.judges, { role: 'judge', model: 'claude-opus-5-5', effort: 'medium', flags: r.judges.flags, claudeVersion: 'v9' });
});

test('reviewRuns clones both repos into temp dirs it removes, and appends one entry to both results files', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const fa = path.join(dir, 'chat-202611070900-1.json'), fb = path.join(dir, 'hx3-202611071000-1.json');
  const old = { other: 'hx3-1.json', score: 5 };
  const a = { arm: 'chat', repo: 'octo-owner/hx-project-chat-1', passed: 149, costUsd: 10, reviews: [old] };
  const b = { arm: 'hx3', repo: 'octo-owner/hx-project-hx3-1', passed: 147, costUsd: 20 };
  writeFileSync(fa, JSON.stringify(a)); writeFileSync(fb, JSON.stringify(b));
  const src: Record<string, string> = { [a.repo]: checkout('X'), [b.repo]: checkout('Y') };
  const clones: string[] = [];
  const clone = (repo: string, dest: string) => { clones.push(dest); cpSync(src[repo], dest, { recursive: true }); };
  const { judge, calls } = fakeJudge();
  await pr.reviewRuns(fa, fb, { judge, clone, brief, version: 'v9' });
  assert.equal(clones.length, 2);
  for (const c of clones) assert.equal(existsSync(c), false, 'the clone is removed');
  for (const c of calls) assert.equal(c.files.some((f) => /project|octo|chat|hx/i.test(f)), false);
  const ra = JSON.parse(readFileSync(fa, 'utf8')), rb = JSON.parse(readFileSync(fb, 'utf8'));
  assert.deepEqual({ ...ra, reviews: undefined }, { ...a, reviews: undefined });
  assert.deepEqual({ ...rb, reviews: undefined }, { ...b, reviews: undefined });
  assert.equal(ra.reviews.length, 2);
  assert.deepEqual(ra.reviews[0], old);
  assert.equal(rb.reviews.length, 1);
  const [ea, eb] = [ra.reviews[1], rb.reviews[0]];
  assert.equal(ea.other, 'hx3-202611071000-1.json');
  assert.equal(eb.other, 'chat-202611070900-1.json');
  assert.equal(ea.seed, pr.SEED);
  assert.equal(ea.score, 7); assert.equal(eb.score, 4);
  assert.equal(ea.basedOn, 6); assert.equal(ea.verdicts.length, 6);
  assert.deepEqual(ea.verdicts[0].scores, SCORES.X); assert.deepEqual(eb.verdicts[0].scores, SCORES.Y);
  assert.deepEqual(ea.missing, []);
  assert.equal(ea.judges.role, 'judge'); assert.equal(ea.judges.claudeVersion, 'v9');
  assert.deepEqual(eb.judges, ea.judges);
  for (const e of [ea, eb]) {
    assert.equal(e.costUsd, 1.5);
    assert.deepEqual(e.tokens, { input: 300, cacheWrite: 60, cacheRead: 900, output: 120, total: 1380 });
  }
  // what bench/project-results.mjs reads from it
  assert.equal(results.runCost(rb), 21.5);
  assert.equal(results.reviewScore(rb), 4);
});

test('reviewRuns removes the first clone when the second clone fails, and writes nothing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const fa = path.join(dir, 'a.json'), fb = path.join(dir, 'b.json');
  writeFileSync(fa, JSON.stringify({ arm: 'chat', repo: 'o/a' })); writeFileSync(fb, JSON.stringify({ arm: 'hx3', repo: 'o/b' }));
  const x = checkout('X');
  const clones: string[] = [];
  const clone = (repo: string, dest: string) => {
    clones.push(dest);
    if (repo === 'o/b') throw new Error('gh: not found');
    cpSync(x, dest, { recursive: true });
  };
  const { judge, calls } = fakeJudge();
  await assert.rejects(pr.reviewRuns(fa, fb, { judge, clone, brief, version: 'v9' }), /not found/);
  assert.equal(calls.length, 0);
  for (const c of clones) assert.equal(existsSync(c), false);
  assert.equal(JSON.parse(readFileSync(fa, 'utf8')).reviews, undefined);
});

test('--all pairing: newest chat set, same i; reviewed runs skipped; unmatched runs listed; one chat run against two hx3 sets', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  write(dir, {
    'project-chat.json': JSON.stringify({ arm: 'chat', startedAt: '2026-10-01T00:00:00Z' }),
    'project/chat-202611010000-1.json': JSON.stringify({ startedAt: '2026-11-01T00:00:00Z' }),
    'project/chat-202611010000-2.json': JSON.stringify({ startedAt: '2026-11-01T02:00:00Z' }),
    'project/chat-202611050000-1.json': JSON.stringify({ startedAt: '2026-11-05T00:00:00Z' }),
    'project/chat-202611050000-2.json': JSON.stringify({ startedAt: '2026-11-05T02:00:00Z' }),
    'project/hx3-202611060000-1.json': JSON.stringify({ startedAt: '2026-11-06T00:00:00Z' }),
    'project/hx3-202611060000-2.json': JSON.stringify({ startedAt: '2026-11-06T02:00:00Z', reviews: [{ score: 6 }] }),
    'project/hx3-202611060000-3.json': JSON.stringify({ startedAt: '2026-11-06T04:00:00Z' }),
    'project/hx3-202611070000-1.json': JSON.stringify({ startedAt: '2026-11-07T00:00:00Z' }),
  });
  const { pairs, unmatched } = pr.pairRuns(results.loadRuns(results.resultFiles(dir)));
  assert.deepEqual(pairs.map((p: any) => [p.run.name, p.chat.name]), [
    ['hx3-202611060000-1.json', 'chat-202611050000-1.json'],
    ['hx3-202611070000-1.json', 'chat-202611050000-1.json'],
  ]);
  assert.deepEqual(unmatched.map((r: any) => r.name), ['hx3-202611060000-3.json']);
  assert.deepEqual(pr.pairRuns([]), { pairs: [], unmatched: [], skipped: [] });
});

/** A fake `claude`: --version prints a version; a session reads its prompt from stdin and replies, as stream-json,
 *  with its argv and cwd (FAKE_JUDGE=limit: a usage-limit error instead). */
function fakeClaude() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const bin = path.join(dir, 'claude.mjs');
  writeFileSync(bin, `
if (process.argv.includes('--version')) { console.log('2.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  const limit = process.env.FAKE_JUDGE === 'limit';
  const text = JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt: input });
  console.log(JSON.stringify({ type: 'result', subtype: limit ? 'error_during_execution' : 'success', is_error: limit, num_turns: 1,
    result: limit ? 'Claude AI usage limit reached' : text, total_cost_usd: 0.25,
    usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 30, output_tokens: 4 } }));
});
`);
  return bin;
}

test('the default judge runner runs one session in the review dir with the judge flags; claudeVersion reads --version', async () => {
  const bin = fakeClaude();
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const r = await pr.claudeJudge({ prompt: 'judge this', cwd, model: 'claude-opus-5-5', effort: 'medium', flags: pr.JUDGE_FLAGS, bin });
  assert.equal(r.error, undefined);
  const got = JSON.parse(r.text);
  assert.equal(got.prompt, 'judge this');
  assert.equal(path.resolve(got.cwd).toLowerCase(), path.resolve(cwd).toLowerCase());
  const argv: string[] = got.argv;
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'medium');
  for (const f of pr.JUDGE_FLAGS) assert.ok(argv.includes(f), `argv holds ${f}`);
  for (const f of ['Bash', 'Edit', 'Write']) assert.equal(argv.includes(f), false);
  assert.deepEqual(r.usage, { input: 10, cacheWrite: 2, cacheRead: 30, output: 4 });
  assert.equal(r.costUsd, 0.25);
  assert.equal(await pr.claudeVersion(bin), '2.9.9 (Claude Code)');
  assert.equal(await pr.claudeVersion(path.join(cwd, 'missing.mjs')), null);
});

test('the default judge runner returns a usage limit as an error', async () => {
  const bin = fakeClaude();
  const prev = process.env.FAKE_JUDGE;
  process.env.FAKE_JUDGE = 'limit';
  try {
    const r = await pr.claudeJudge({ prompt: 'p', cwd: mkdtempSync(path.join(os.tmpdir(), 'hx-rv-')), model: 'm', effort: 'medium', flags: pr.JUDGE_FLAGS, bin });
    assert.equal(r.error, 'usage limit');
    assert.equal(r.text, undefined);
  } finally {
    if (prev === undefined) delete process.env.FAKE_JUDGE; else process.env.FAKE_JUDGE = prev;
  }
});

test('#415: a review where every judge failed writes nothing and fails loudly; --all pairs the run again', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const fa = path.join(dir, 'chat-202611070900-1.json'), fb = path.join(dir, 'hx3-202611071000-1.json');
  writeFileSync(fa, JSON.stringify({ arm: 'chat', repo: 'o/a', startedAt: '2026-11-07T09:00:00Z' }));
  writeFileSync(fb, JSON.stringify({ arm: 'hx3', repo: 'o/b', startedAt: '2026-11-07T10:00:00Z' }));
  const clones: string[] = [];
  const clone = (_repo: string, dest: string) => { clones.push(dest); mkdirSync(dest); writeFileSync(path.join(dest, 'main.js'), 'x\n'); };
  const judge = async () => ({ error: 'usage limit' });
  await assert.rejects(pr.reviewRuns(fa, fb, { judge, clone, brief, version: 'v9' }), (e: any) => {
    assert.match(e.message, /no verdict: every judge failed \(judge error: usage limit\)/);
    assert.equal(e.usageLimit, true);
    return true;
  });
  for (const c of clones) assert.equal(existsSync(c), false, 'the clone is removed');
  for (const f of [fa, fb]) assert.equal(JSON.parse(readFileSync(f, 'utf8')).reviews, undefined, 'nothing is appended');
  const { pairs } = pr.pairRuns(results.loadRuns([fa, fb]));
  assert.deepEqual(pairs.map((p: any) => [p.run.name, p.chat.name]), [['hx3-202611071000-1.json', 'chat-202611070900-1.json']]);
});

test('#415: --all pairing counts a run as reviewed only when a review has a score; an empty entry already written is retried', () => {
  const r = (reviews: unknown, i = 1) => ({ arm: 'hx3', stamp: 's', i, name: `h${i}`, result: { reviews } });
  const empty = { score: null, basedOn: 0, verdicts: [], missing: [{ judge: 1, order: 'AB', reason: 'judge error: usage limit' }] };
  const runs = [
    { arm: 'chat', stamp: 'c', i: 1, name: 'c1', result: { startedAt: '2026-01-01T00:00:00Z' } },
    { arm: 'chat', stamp: 'c', i: 2, name: 'c2', result: { startedAt: '2026-01-01T01:00:00Z' } },
    r([empty], 1), r([empty, { score: 6.5, basedOn: 6, verdicts: [] }], 2),
  ];
  assert.deepEqual(pr.pairRuns(runs).pairs.map((p: any) => [p.run.name, p.chat.name]), [['h1', 'c1']]);
});

test('#415: the --all loop goes on past a failed pair, and stops at a usage limit', async () => {
  const said: string[] = [];
  const todo = [['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3'], ['a4', 'b4']];
  const seen: string[] = [];
  const run = async (fa: string) => {
    seen.push(fa);
    if (fa === 'a1') throw new Error('gh: not found');
    if (fa === 'a3') throw Object.assign(new Error('no verdict: every judge failed (judge error: usage limit)'), { usageLimit: true });
    return { x: { score: 6, basedOn: 6 }, y: { score: 5, basedOn: 6 }, costUsd: 1 };
  };
  const out = await pr.reviewPairs(todo, { run, say: (m: string) => said.push(m) });
  assert.deepEqual(seen, ['a1', 'a2', 'a3'], 'nothing after the usage limit is tried');
  assert.deepEqual(out, { reviewed: 1, failed: 2 });
  assert.ok(said.some((m) => /a1.*gh: not found/.test(m)));
  assert.ok(said.some((m) => /usage limit/.test(m) && /stop/.test(m)));
});

test('--all pairs every non-chat arm with the newest chat set: a chat run gets one review per Hx arm; old single files are skipped', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  write(dir, {
    'project-hx3.json': JSON.stringify({ arm: 'hx3', startedAt: '2026-10-01T00:00:00Z' }),
    'project-chat.json': JSON.stringify({ arm: 'chat', startedAt: '2026-12-01T00:00:00Z' }),
    'project/chat-202611050000-1.json': JSON.stringify({ startedAt: '2026-11-05T00:00:00Z' }),
    'project/chat-202611050000-2.json': JSON.stringify({ startedAt: '2026-11-05T02:00:00Z' }),
    'project/hx1-202611060000-1.json': JSON.stringify({ startedAt: '2026-11-06T00:00:00Z' }),
    'project/hx1-202611060000-2.json': JSON.stringify({ startedAt: '2026-11-06T02:00:00Z' }),
    'project/hx3-202611070000-1.json': JSON.stringify({ startedAt: '2026-11-07T00:00:00Z' }),
    'project/hx3-202611070000-2.json': JSON.stringify({ startedAt: '2026-11-07T02:00:00Z', reviews: [{ score: 6 }] }),
  });
  const { pairs, unmatched, skipped } = pr.pairRuns(results.loadRuns(results.resultFiles(dir)));
  assert.deepEqual(pairs.map((p: any) => [p.run.name, p.chat.name]), [
    ['hx1-202611060000-1.json', 'chat-202611050000-1.json'],
    ['hx1-202611060000-2.json', 'chat-202611050000-2.json'],
    ['hx3-202611070000-1.json', 'chat-202611050000-1.json'],
  ]);
  assert.deepEqual(unmatched, []);
  // the old chat file is newer by its start, yet no new run is paired with it: old files are skipped, and listed
  assert.deepEqual(skipped.map((r: any) => r.name), ['project-chat.json', 'project-hx3.json']);
  // the CLI's plan lists them too
  const plan = pr.plan(['--all'], { resultsDir: dir });
  assert.deepEqual(plan.skipped, ['project-chat.json', 'project-hx3.json']);
  assert.deepEqual(plan.todo.map((t: string[]) => t.map((f) => path.basename(f))), pairs.map((p: any) => [p.chat.name, p.run.name]));
  assert.equal(plan.brief, readFileSync(path.join(root, 'bench', 'project', 'brief.md'), 'utf8'));
});

test('--all --fixture reads only that fixture\'s results and gives its brief', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  write(dir, {
    'project/chat-202611050000-1.json': JSON.stringify({ startedAt: '2026-11-05T00:00:00Z' }),
    'project/hx3-202611050000-1.json': JSON.stringify({ startedAt: '2026-11-05T00:00:00Z' }),
    'fixtures/ledge/project/chat-202611090000-1.json': JSON.stringify({ fixture: 'ledge', startedAt: '2026-11-09T00:00:00Z' }),
    'fixtures/ledge/project/hx1-202611090000-1.json': JSON.stringify({ fixture: 'ledge', startedAt: '2026-11-09T01:00:00Z' }),
    'fixtures/ledge/project/hx3-202611090000-1.json': JSON.stringify({ fixture: 'ledge', startedAt: '2026-11-09T02:00:00Z' }),
  });
  const plan = pr.plan(['--all', '--fixture', 'ledge'], { resultsDir: dir });
  assert.deepEqual(plan.todo.map((t: string[]) => t.map((f) => path.basename(f))), [
    ['chat-202611090000-1.json', 'hx1-202611090000-1.json'], ['chat-202611090000-1.json', 'hx3-202611090000-1.json'],
  ]);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.brief, readFileSync(path.join(root, 'bench', 'fixtures', 'ledge', 'brief.md'), 'utf8'));
});

test('two files: different fixtures, or a fixture other than --fixture (tally by default), are a usage error before any clone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const f = (name: string, body: object) => { const p = path.join(dir, name); writeFileSync(p, JSON.stringify({ repo: 'o/r', ...body })); return p; };
  const tally = f('chat-1-1.json', {}), tally2 = f('hx3-1-1.json', { fixture: 'tally' });
  const ledge = f('chat-2-1.json', { fixture: 'ledge' }), ledge2 = f('hx1-2-1.json', { fixture: 'ledge' });
  assert.throws(() => pr.plan([tally, ledge]), (e: any) => e.exitCode === 2 && /different fixtures: chat-1-1\.json is tally, chat-2-1\.json is ledge/.test(e.message));
  assert.throws(() => pr.plan([tally, ledge, '--fixture', 'ledge']), /different fixtures/);
  assert.throws(() => pr.plan([ledge, ledge2]), (e: any) => e.exitCode === 2 && /fixture ledge, not tally: pass --fixture ledge/.test(e.message));
  assert.throws(() => pr.plan([tally, tally2, '--fixture', 'ledge']), /fixture tally, not ledge/);
  // otherwise the judges get that fixture's brief
  assert.equal(pr.plan([ledge, ledge2, '--fixture', 'ledge']).brief, readFileSync(path.join(root, 'bench', 'fixtures', 'ledge', 'brief.md'), 'utf8'));
  assert.equal(pr.plan([tally, tally2]).brief, readFileSync(path.join(root, 'bench', 'project', 'brief.md'), 'utf8'));
  assert.deepEqual(pr.plan([tally, tally2]).todo, [[tally, tally2]]);
  assert.equal(pr.plan([tally]), null);
  assert.equal(pr.plan(['--all', tally]), null);
  // the CLI: exit 2 with the message, and no gh is reached (there is none on its PATH)
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(env)) if (/^NODE_TEST/.test(k)) delete env[k];
  env.PATH = path.dirname(process.execPath);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'bench', 'project-review.mjs'), ledge, ledge2],
    { encoding: 'utf8', env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /pass --fixture ledge/);
  assert.doesNotMatch(r.stdout, /reviewing/);
});

test('the judges are given the brief they are passed; hx1 is a name hidden from them', async () => {
  const x = checkout('X'), y = checkout('Y');
  writeFileSync(path.join(x, 'src', 'notes.js'), '// built by hx1\n');
  const { judge: inner, calls } = fakeJudge();
  const seen: string[] = [];
  const judge = async (o: any) => {
    for (const side of ['A', 'B']) {
      const f = path.join(o.cwd, side, 'src', 'notes.js');
      if (existsSync(f)) seen.push(readFileSync(f, 'utf8'));
    }
    return inner(o);
  };
  await pr.review(x, y, { judge, brief: '# ledge\nThe other brief.\n', version: 'v' });
  assert.ok(calls[0].prompt.includes('The other brief.'));
  assert.equal(seen.length, calls.length);
  for (const notes of seen) assert.equal(notes, '// built by [redacted]\n');
});

// PRD #446 (#451): a two-phase fixture's judges get its brief, a blank line, then its change
/** A bench dir with one two-phase fixture `demo` (brief.md ends in blank lines and spaces) beside a complete tally. */
function twoPhaseBench() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rvf-'));
  const files = (fdir: string, gen: string, extra: Record<string, string>) => write(fdir, {
    'brief.md': '# demo\n', 'hidden/a.test.mjs': '', 'reference/src/x.js': 'a\n', 'reference/package.json': '{}\n', 'template/package.json': '{}\n',
    [gen]: 'export const DEFAULT_SEED = 1, DEFAULT_COUNT = 1;\nexport function generate() { return []; }\n', ...extra,
  });
  const manifest = { bin: 'demo', checkoutEnv: 'DEMO_CHECKOUT', coverageClearEnv: ['DEMO_FILE'], fuzzFile: 'demo.txt', fuzzFileEnv: 'DEMO_FILE', fuzzNowEnv: null };
  files(path.join(dir, 'project'), '../project-fuzz-gen.mjs', { 'fixture.json': JSON.stringify(manifest) });
  files(path.join(dir, 'fixtures', 'demo'), 'fuzz-gen.mjs', {
    'fixture.json': JSON.stringify({ ...manifest, change: 'change.md' }), 'hidden/tags.json': '{}\n',
    'brief.md': '# demo\nThe brief.\n\n  \n', 'change.md': '# The change\nNow do it twice.\n',
  });
  return dir;
}

test('a two-phase fixture: the brief is brief.md trimmed at the end, a blank line, then the change; each judge gets exactly that and no other file', async () => {
  const benchDir = twoPhaseBench();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-rv-'));
  const fa = path.join(dir, 'chat-202611110900-1.json'), fb = path.join(dir, 'hx3-202611111000-1.json');
  const a = { fixture: 'demo', arm: 'chat', repo: 'octo-owner/demo-chat-1' }, b = { fixture: 'demo', arm: 'hx3', repo: 'octo-owner/demo-hx3-1' };
  writeFileSync(fa, JSON.stringify(a)); writeFileSync(fb, JSON.stringify(b));
  const want = '# demo\nThe brief.\n\n# The change\nNow do it twice.\n';
  const p = pr.plan([fa, fb, '--fixture', 'demo'], { benchDir });
  assert.equal(p.brief, want);
  assert.deepEqual(p.todo, [[fa, fb]]);
  assert.equal(pr.plan(['--all', '--fixture', 'demo'], { benchDir, resultsDir: dir }).brief, want);
  // the review run: each judge's brief.md and the prompt's {{BRIEF}} hold that text, and only A, B and brief.md
  const src: Record<string, string> = { [a.repo]: checkout('X'), [b.repo]: checkout('Y') };
  const clone = (repo: string, dest: string) => cpSync(src[repo], dest, { recursive: true });
  const briefs: string[] = [];
  const { judge: inner, calls } = fakeJudge();
  const judge = async (o: any) => { briefs.push(readFileSync(path.join(o.cwd, 'brief.md'), 'utf8')); return inner(o); };
  const { reviewed } = await pr.reviewPairs(p.todo, { judge, clone, brief: p.brief, version: 'v9' });
  assert.equal(reviewed, 1);
  assert.equal(calls.length, 6);
  assert.deepEqual(briefs, Array(6).fill(want));
  const template = readFileSync(path.join(root, 'bench', 'project', 'review-prompt.md'), 'utf8');
  for (const c of calls) {
    assert.deepEqual(c.files.filter((f) => !f.startsWith('A/') && !f.startsWith('B/')), ['brief.md']);
    assert.equal(c.prompt, template.replace('{{BRIEF}}', () => want.trimEnd()));
  }
});

test('the brief: a single-phase fixture\'s brief.md byte for byte (tally, ledge)', () => {
  for (const [name, file] of [['tally', path.join(root, 'bench', 'project', 'brief.md')], ['ledge', path.join(root, 'bench', 'fixtures', 'ledge', 'brief.md')]]) {
    assert.equal(pr.plan(['--all', '--fixture', name], { resultsDir: mkdtempSync(path.join(os.tmpdir(), 'hx-rv-')) }).brief, readFileSync(file, 'utf8'));
  }
});

test('docs/benchmark.md: a two-phase fixture\'s runs are judged against the brief followed by the change', () => {
  const doc = readFileSync(path.join(root, 'docs', 'benchmark.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(doc, /two-phase fixture's runs are judged against its brief followed by its change/);
});
