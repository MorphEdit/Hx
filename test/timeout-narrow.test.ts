// The split after a timeout (#312, PRD #300 §2 steps 2–6): once a timed-out impl turn's WIP is pushed, one `size`
// session in mode after-timeout narrows the issue to what its WIP has nearly done and hx files the rest; the issue is
// ready again and the next impl claim resumes the kept branch. Once only. End to end: real git with a local bare
// origin, fake gh and claude, in the plain path and in the audited loop.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-tn-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, HANDOFF_MARKER } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { SIZE_NARROWED } = await import('../src/size.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const fakeClaude = path.join(here, 'fakes', 'claude.mjs');
// 0.1 min: the fake impl turn writes its WIP within moments, then sleeps 10 min
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: fakeClaude, maxIterations: 3, pollSeconds: 1, audit: false, gate: false, gauntlet: false, bugTriage: false, security: false,
  turnTimeoutMinutes: 0.1, selfHeal: false, trustedAuthors: ['Alice'], ...extra } });
// the gh login is Hx-Bot (a comment or issue without an author is its own); alice is trusted
const board = (issues: any[], comments: any[] = [], extra = {}) =>
  writeFileSync(stateFile, JSON.stringify({ login: 'Hx-Bot', comments, prs: [], issues, ...extra }));
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const commentsOn = (n: number): string[] => read().comments.filter((c: any) => c.issue === n).map((c: any) => c.body);
const ready = (n: number, body: string) => ({ number: n, title: `feature ${n}`, body, state: 'OPEN', labels: [L.ready] });
const runLog = () => readFileSync(path.join(stateDir, 'run.log'), 'utf8');
const onOrigin = (n: number) => { try { return git(origin, 'rev-parse', '--verify', '-q', `refs/heads/issue/${n}`); } catch { return ''; } };
const failComment = (n: number) => commentsOn(n).find((b) => /\*\*hx:\*\* impl stopped —/.test(b)) ?? '';
/** The first prompts of the sessions for issue #n, in no particular order. */
const prompts = (n: number) => readdirSync(fakeDir).filter((f) => f.endsWith('.prompt-1.txt')).map((f) => readFileSync(path.join(fakeDir, f), 'utf8'))
  .filter((t) => new RegExp(`(?:Issue|PRD): #${n}\\b`).test(t));
const narrowSessions = (n: number) => prompts(n).filter((t) => /^Role: size/.test(t) && /· mode: after-timeout/.test(t)).length;
const restOf = (n: number) => read().issues.filter((i: any) => /^rest \d of #/.test(i.title) && i.title.endsWith(`#${n}`));

async function run(extra = {}, only: number[]) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(project(extra), { workers: 5, watch: false, dryRun: false, signal, only })), lines };
  } finally { console.log = orig; }
}

/** #b: a PRD child (parent #b+9, blocked by #b+8), #b+1 an open issue blocked by #b · #b+2: a single issue ·
 *  #b+3: narrowed, then times out again */
const boardFrom = (b: number, quick = '') => [
  { number: b + 9, title: 'the PRD', body: 'prd', state: 'OPEN', labels: ['prd'] },
  { number: b + 8, title: 'done before', body: 'x', state: 'CLOSED', labels: [] },
  ready(b, `A big job. IMPLTIMEOUT SIZENARROW${quick}\n\n## Blocked by\n#${b + 8}\n\n## Parent\n#${b + 9}\n`),
  { number: b + 1, title: `after ${b}`, body: `later\n\n## Blocked by\n#${b}\n`, state: 'OPEN', labels: [L.ready] },
  ready(b + 2, `A big single job. IMPLTIMEOUT SIZENARROW${quick}`),
  ready(b + 3, 'A big single job. IMPLTIMEOUT SIZENARROW SIZENARROWAGAIN'),
];

function assertNarrowed(b: number, lines: string[], quick = '') {
  const all = lines.join('\n');
  for (const [n, parent] of [[b, b + 9], [b + 2, b + 2]]) {
    const rest = restOf(n);
    assert.equal(rest.length, 2, `#${n}: ${JSON.stringify(read().issues)}`);
    const [r1, r2] = rest.map((i: any) => i.number);
    // the rest: ready-for-agent, blocked by #n only (the second's `Blocked by: none` names no sibling), parent #p
    for (const [k, r] of rest.entries()) {
      assert.deepEqual(r.labels, [L.ready], `#${r.number}`);
      assert.equal(r.body, `do rest part ${k + 1}\n\n## Blocked by\n#${n}\n\n## Parent\n#${parent}`);
    }
    const i = issue(n);
    assert.ok(i.body.startsWith(`## Scope (narrowed after a timeout)\nNarrowed by hx after a 0.1-min timeout; the rest is #${r1}, #${r2}.\n\nfinish the part the WIP of #${n} has nearly done${quick && ' NOTHINGTOBUILD'}\n\n## Blocked by\n`), i.body);
    if (n === b) assert.ok(i.body.endsWith(`## Blocked by\n#${b + 8}\n\n## Parent\n#${b + 9}`), i.body);
    else assert.ok(i.body.endsWith('## Blocked by\nNone') && !/## Parent/.test(i.body), i.body);
    // ready again, then resumed: neither blocked nor working at the end
    assert.ok(i.labels.includes(L.ready) && !i.labels.includes(L.blocked) && !i.labels.includes(L.working), `#${n}: ${i.labels.join()}`);
    const marker = commentsOn(n).find((c) => c.startsWith(SIZE_NARROWED));
    assert.ok(marker, `#${n}: the narrowed marker\n${commentsOn(n).join('\n---\n')}`);
    assert.match(marker, new RegExp(`^- #${r1}\\n- #${r2}$`, 'm'));
    assert.match(marker, /<details>[\s\S]*A big (single )?job\. IMPLTIMEOUT SIZENARROW[\s\S]*<\/details>$/);
    assert.ok(runLog().includes(`[#${n}] split #${n} → #${r1}, #${r2} (narrowed after a timeout)\n`), runLog());
    assert.equal(failComment(n), '', `#${n}: no fail comment`);
    assert.equal(narrowSessions(n), 1);
    // the next impl session resumes the kept branch with the handoff note, and finishes the narrowed issue
    const at = lines.findIndex((l) => l.includes(`[#${n}] split #${n} →`));
    assert.ok(lines.slice(at).some((l) => new RegExp(`\\[#${n}\\] working in .+ \\(resuming earlier work\\)$`).test(l)), all);
    const resumed = prompts(n).filter((t) => /^Role: implement/.test(t) && t.includes('already has work from an earlier session'));
    assert.equal(resumed.length, 1, `#${n}`);
    assert.ok(resumed[0].includes(`half done; next: finish part ${n}`), 'the handoff note');
    assert.equal(i.state, 'CLOSED', `#${n} implemented after the narrowing\n${all}`);
  }
  // a dependent of #b now waits on the rest too
  const [r1, r2] = restOf(b).map((i: any) => i.number);
  assert.equal(issue(b + 1).body, `later\n\n## Blocked by\n#${b}\n#${r1}\n#${r2}\n`);
  // a second timeout: agent-blocked with the already-split reason, no second size session
  {
    const n = b + 3;
    const i = issue(n);
    assert.ok(i.labels.includes(L.blocked) && !i.labels.includes(L.working), i.labels.join());
    assert.equal(narrowSessions(n), 1, all);
    assert.match(failComment(n), /impl stopped — the turn timed out again; this issue was already split once after a timeout \(/);
    assert.match(failComment(n), new RegExp(`The WIP is on branch \`issue/${n}\`\\.`));
    assert.equal(commentsOn(n).filter((c) => c.startsWith(SIZE_NARROWED)).length, 1);
    assert.ok(onOrigin(n));
  }
}

test('a timed-out impl turn (plain path): narrowed, the rest filed, ready again and resumed; a second timeout is agent-blocked', E2E, async () => {
  board(boardFrom(10));
  const { lines } = await run({}, [10, 12, 13]);
  assertNarrowed(10, lines);
});

test('a timed-out implementer turn (audited loop): the same', E2E, async () => {
  // its resumed implementer closes the narrowed issue at once: a ship.mjs run would outlast the 0.1-min turn timeout
  board(boardFrom(40, ' SIZENARROWQUICK'));
  const { lines } = await run({ audit: true }, [40, 42, 43]);
  assertNarrowed(40, lines, ' SIZENARROWQUICK');
});

test('a failed size session: agent-blocked, the WIP on issue/<n> on origin, no narrowed marker; a trustedAuthors marker is ignored', E2E, async () => {
  board([ready(70, 'Job. IMPLTIMEOUT SIZENARROWBAD'), ready(71, 'Job. IMPLTIMEOUT SIZENARROW SIZENARROWNONE')],
    [{ issue: 71, body: `${SIZE_NARROWED}\nnarrowed`, author: 'alice' }]);
  const { lines } = await run({}, [70, 71]);
  const all = lines.join('\n');
  {
    const n = 70;
    assert.ok(issue(n).labels.includes(L.blocked), issue(n).labels.join());
    assert.equal(narrowSessions(n), 1);
    assert.ok(onOrigin(n), `issue/${n} on origin`);
    assert.equal(git(origin, 'show', `issue/${n}:wip-${n}.txt`), 'half done');
    assert.ok(!commentsOn(n).some((c) => c.startsWith(SIZE_NARROWED)));
    // the fail comment is the one a timeout got before; run.log says why it was not narrowed
    assert.match(failComment(n), /^\*\*hx:\*\* impl stopped — the impl turn timed out \(agent error: turn timed out after [^)]*\) \(/);
    assert.ok(runLog().includes(`[#${n}] not narrowed after the timeout: the size session failed (the reply has no valid SIZE: narrow shape;`), runLog());
    assert.match(failComment(n), new RegExp(`The WIP is on branch \`issue/${n}\`\\.`));
    assert.equal(read().issues.length, 2, 'nothing filed');
    assert.equal(issue(n).body, 'Job. IMPLTIMEOUT SIZENARROWBAD');
  }
  // alice's narrowed marker is not hx's: the issue is narrowed (to nothing else) and resumed
  {
    const n = 71;
    assert.equal(narrowSessions(n), 1, all);
    assert.ok(runLog().includes(`[#${n}] split #${n} → none (narrowed after a timeout)\n`), runLog());
    assert.ok(issue(n).body.includes('; the rest is none.\n'), issue(n).body);
    assert.equal(issue(n).state, 'CLOSED', all);
  }
});

test('a rest-issue create fails: agent-blocked, the fail comment starts with the narrowed marker; a later timeout is not narrowed again', E2E, async () => {
  board([ready(80, 'Job. IMPLTIMEOUT SIZENARROW'), { number: 81, title: 'after 80', body: 'later\n\n## Blocked by\n#80\n', state: 'OPEN', labels: [L.ready] }],
    [], { createFails: 2 });
  const { lines } = await run({}, [80]);
  const n = 80;
  const i = issue(n);
  assert.ok(i.labels.includes(L.blocked) && !i.labels.includes(L.working), i.labels.join());
  const fc = failComment(n);
  assert.equal(fc.split('\n')[0], SIZE_NARROWED, fc);
  assert.match(fc, /the narrowing stopped at filing child 2: .*502.*; filed #82/);
  assert.match(fc, new RegExp(`The WIP is on branch \`issue/${n}\`\\.`));
  assert.deepEqual(read().issues.map((x: any) => x.number), [80, 81, 82], 'only the first rest issue was filed');
  assert.equal(issue(81).body, 'later\n\n## Blocked by\n#80\n', 'no dependent edited');
  assert.equal(i.body, 'Job. IMPLTIMEOUT SIZENARROW', 'the body is not rewritten');
  assert.ok(!runLog().includes('split #80 →'), 'no split line');
  assert.ok(lines.some((l) => /\[#80\] impl FAILED ✗ — the narrowing stopped at filing child 2/.test(l)), lines.join('\n'));
  // the marker on the fail comment: the next timeout ends in agent-blocked, with no second size session
  const b = read();
  Object.assign(b.issues.find((x: any) => x.number === n), { labels: [L.ready] });
  writeFileSync(stateFile, JSON.stringify(b));
  const again = await run({}, [80]);
  assert.ok(issue(n).labels.includes(L.blocked), again.lines.join('\n'));
  assert.equal(narrowSessions(n), 1);
  assert.match(commentsOn(n).filter((c) => /impl stopped —/.test(c)).at(-1)!, /the turn timed out again; this issue was already split once after a timeout/);
  assert.ok(commentsOn(n).some((c) => c.startsWith(HANDOFF_MARKER)));
});
