// A held merge end to end (#301): real git (a local bare origin), the real ship.mjs, fake gh and claude.
// An audited PR whose merge fails only on tests that also fail on a red main keeps its PASS: no round counted,
// no new implementer, one held comment; it merges once the gate is green. A failure main does not have
// sends it back to the implementer as before, naming that test.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-mh-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { readHeld, HELD_MARKER } = await import('../src/held.ts');

const L = DEFAULTS.labels;
const gitId = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
// the gate: test X fails while main has a BROKEN file
const GATE = `node -e "if (require('fs').existsSync('BROKEN')) { console.log('not ok 1 - X'); process.exit(1) }"`;

function repo(name: string) {
  const origin = path.join(tmp, `${name}.git`), root = path.join(tmp, name);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, root);
  git(root, ...gitId, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'push', '-q', 'origin', 'HEAD:main');
  const stateDir = path.join(root, '.hx');
  mkdirSync(stateDir);
  return { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`),
    claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 2, gate: true, gateCommand: GATE } };
}

const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const comments = (n: number, marker: string) => read().comments.filter((c: any) => c.issue === n && c.body.startsWith(marker));
/** The first prompt of every session started since `before`, by role. */
const prompts = (before: Set<string>, role: string, n: number) => readdirSync(fakeDir)
  .filter((f) => !before.has(f) && f.endsWith('.prompt-1.txt')).map((f) => readFileSync(path.join(fakeDir, f), 'utf8'))
  .filter((p) => new RegExp(`Role: ${role}`).test(p) && new RegExp(`Issue: #${n}\\b`).test(p));

async function run(p: object, only?: number[]) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    return { rc: await pooled((signal) => runPool(p as any, { workers: 1, watch: false, dryRun: false, signal, ...(only ? { only } : {}) })), lines };
  } finally { console.log = orig; }
}

test('a PASSed PR failing only test X, which main fails too: held, no round, no new implementer; it merges once main is green', E2E, async () => {
  const p = repo('held');
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
    { number: 1, title: 'task 1', body: 'MAINRED FAILSONBROKEN=X', state: 'OPEN', labels: [L.ready] }] }));
  const before = new Set(readdirSync(fakeDir));
  const { rc, lines } = await run(p);
  const all = lines.join('\n');
  assert.equal(rc, 0, all);
  const s = read();
  const fix = s.issues.find((i: any) => /^Default branch is red/.test(i.title));
  assert.ok(fix, 'the gate went red and filed its fix');
  // one implementer and one audit: the held PR was neither re-implemented nor re-audited
  assert.equal(prompts(before, 'implement', 1).length, 1, all);
  assert.equal(prompts(before, 'audit', 1).length, 1, all);
  assert.equal(comments(1, '<!-- hx-audit -->').length, 1);
  assert.equal(comments(1, '<!-- hx-retry -->').length, 0, 'no round counted');
  assert.ok(!/back to the implementer/.test(all), all);
  const held = comments(1, HELD_MARKER);
  assert.equal(held.length, 1, 'one held comment');
  assert.match(held[0].body, new RegExp(`held: main is red \\(#${fix.number}\\); merges once main is green`));
  // held → main fixed → gate green → merged, in that order
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/\[#1\] merge held: main is red/) >= 0, all);
  assert.ok(at(/gate green ✓ again/) > at(/\[#1\] merge held/), all);
  assert.ok(at(/\[#1\] main is green: merging held PR #\d+ \(audit 1\/2 PASS kept\)/) > at(/gate green ✓ again/), all);
  assert.ok(at(/\[#1\] DONE ✓ audited and merged \(1 round/) > at(/gate green ✓ again/), all);
  const i1 = s.issues.find((i: any) => i.number === 1);
  assert.equal(i1.state, 'CLOSED');
  assert.ok(!i1.labels.includes(L.blocked));
  assert.ok(s.prs.some((x: any) => x.head === 'issue/1' && x.state === 'MERGED'));
  assert.deepEqual(readHeld(p.stateDir), {}, 'no longer held');
});

test('a PASSed PR failing test Y, which main does not fail: back to the implementer, a merge round counted (not an audit round), Y named', E2E, async () => {
  const p = repo('own');
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
    { number: 1, title: 'task 1', body: 'MAINRED FAILSONBROKEN=X,Y', state: 'OPEN', labels: [L.ready] }] }));
  const before = new Set(readdirSync(fakeDir));
  const { lines } = await run(p, [1]);
  const all = lines.join('\n');
  assert.ok(lines.some((l) => /\[#1\] merge after audit failed \(tests fail after the rebase; not failing on main: Y\) — back to the implementer, merge round 1\/3 \(audit round 1\/2 unchanged\)$/.test(l)), all);
  const retry = comments(1, '<!-- hx-retry -->');
  assert.equal(retry.length, 1);
  assert.match(retry[0].body, /tests fail after the rebase; not failing on main: Y\) — back to the implementer, merge round 1\/3 \(audit round 1\/2 unchanged\)/);
  assert.equal(comments(1, HELD_MARKER).length, 0, 'not held');
  assert.deepEqual(readHeld(p.stateDir), {});
  // the second implementer is told which test its branch broke
  const impls = prompts(before, 'implement', 1);
  assert.equal(impls.length, 2, all);
  assert.ok(impls.some((x) => /these failing tests do not fail there, so your branch broke them: Y\./.test(x)), 'Y named to the implementer');
});
