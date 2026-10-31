// {{BUG_NOTE}} end to end: a `bug` issue's impl and audit prompts get the reproduce-first notes; any other
// issue's prompts get nothing, not even a leftover placeholder or a stray line. Real git, fake gh and claude.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-bn-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
mkdirSync(fakeDir);

const { runPool, IMPL_BUG_NOTE, AUDIT_BUG_NOTE } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');
const { render } = await import('../src/state.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
mkdirSync(stateDir);
const project = (extra = {}) => ({ root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, auditRounds: 2, ...extra } });

const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number, labels: string[]) => ({ number: n, title: `task ${n}`, body: '', state: 'OPEN', labels });

/** Runs the pool on `only`; returns each new session's first prompt by role and issue. */
async function run(only: number[], extra = {}) {
  const before = new Set(readdirSync(fakeDir));
  const rc = await pooled((signal) => runPool(project(extra), { workers: 1, watch: false, dryRun: false, only, signal }));
  const prompts: { role: string; n: number; text: string }[] = [];
  for (const f of readdirSync(fakeDir).filter((f) => !before.has(f) && f.endsWith('.prompt-1.txt'))) {
    const text = readFileSync(path.join(fakeDir, f), 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout of the prompts
    prompts.push({ role: /^Role: (\w+)/m.exec(text)![1], n: Number(/Issue: #(\d+)/.exec(text)![1]), text });
  }
  return { rc, prompts };
}
const of = (ps: { role: string; n: number; text: string }[], role: string, n: number) => {
  const p = ps.filter((x) => x.role === role && x.n === n);
  assert.equal(p.length, 1, `one ${role} prompt for #${n}`);
  return p[0].text;
};

test('the two notes are the exact texts the issue asks for', E2E, () => {
  assert.equal(IMPL_BUG_NOTE, 'This is a bug. Start from the triage comment if there is one and add its failing test (or a better one); otherwise write a test that reproduces the bug. See it fail, then fix the root cause. Do not only patch the symptom.');
  assert.equal(AUDIT_BUG_NOTE, 'Check that a test reproduces the reported bug and fails without the fix (revert the fix locally to check), and that the fix addresses the root cause (the one named in the triage comment, if there is one).');
  // both prompts hold the placeholder; rendered empty, they are unchanged from the template minus the placeholder
  for (const f of ['impl.md', 'audit.md']) {
    const t = readFileSync(path.join(here, '..', 'prompts', f), 'utf8');
    assert.match(t, /\{\{BUG_NOTE\}\}/, f);
    assert.equal(render(t, { BUG_NOTE: '' }), t.replace('{{BUG_NOTE}}', ''));
  }
});

test('bugTriage false: a bug runs impl without triage, both prompts carry their note, it merges; a feature gets none', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [issue(1, [L.bug, L.ready]), issue(2, [L.ready])] }));
  const { rc, prompts } = await run([1, 2], { bugTriage: false });
  assert.equal(rc, 0);
  assert.deepEqual([...new Set(prompts.map((p) => p.role))].sort(), ['audit', 'implement'], 'no triage session');
  const s = read();
  assert.deepEqual(s.issues.map((i: any) => i.state), ['CLOSED', 'CLOSED']);
  assert.ok(s.prs.every((p: any) => p.state === 'MERGED'));

  const impl1 = of(prompts, 'implement', 1), audit1 = of(prompts, 'audit', 1);
  assert.ok(impl1.includes(IMPL_BUG_NOTE));
  assert.ok(!impl1.includes(AUDIT_BUG_NOTE));
  assert.ok(audit1.includes(AUDIT_BUG_NOTE));
  assert.ok(!audit1.includes(IMPL_BUG_NOTE));
  // the note sits on its own line between the steps
  assert.match(impl1, /existing test\.\nThis is a bug\.[^\n]*symptom\.\n3\. Run the tests/);
  assert.match(audit1, /if it were wrong\?\nCheck that a test reproduces[^\n]*if there is one\)\.\n\nFAIL only/);

  const impl2 = of(prompts, 'implement', 2), audit2 = of(prompts, 'audit', 2);
  for (const t of [impl2, audit2]) {
    assert.ok(!t.includes(IMPL_BUG_NOTE) && !t.includes(AUDIT_BUG_NOTE));
    assert.ok(!t.includes('{{BUG_NOTE}}'));
    assert.ok(!t.includes('This is a bug'));
  }
  // no stray line: the steps follow each other as in the template without the note
  assert.match(impl2, /existing test\.\n3\. Run the tests/);
  assert.match(audit2, /if it were wrong\?\n\nFAIL only/);
});

test('a bug labelled bug-triaged + ready-for-agent by hand (bugTriage true) gets the note in its impl prompt', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [issue(3, [L.bug, L.triaged, L.ready])] }));
  const { rc, prompts } = await run([3], { audit: false });
  assert.equal(rc, 0);
  assert.ok(of(prompts, 'implement', 3).includes(IMPL_BUG_NOTE));
  assert.equal(read().issues[0].state, 'CLOSED');
});

test('a PRD child labelled bug gets the note too', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify({ comments: [], prs: [], issues: [
    { ...issue(4, [L.prd]), state: 'CLOSED' }, { ...issue(5, [L.bug, L.ready]), body: '## Parent\n#4' }] }));
  const { rc, prompts } = await run([5], { audit: false });
  assert.equal(rc, 0);
  assert.ok(of(prompts, 'implement', 5).includes(IMPL_BUG_NOTE));
});
