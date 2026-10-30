// Trusted authors end to end: real git (a local bare origin), fake gh and claude. Only issues and PRDs
// opened by the gh login or config.trustedAuthors are worked on; the rest are skipped, logged once.
import { E2E, sessionEnvs } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-t-'));
const stateFile = path.join(tmp, 'board.json');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = path.join(tmp, 'sessions');
mkdirSync(process.env.HX_FAKE_DIR);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS, saveConfig } = await import('../src/config.ts');

const L = DEFAULTS.labels;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const origin = path.join(tmp, 'origin.git');
const root = path.join(tmp, 'app');
git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
git(tmp, 'clone', '-q', origin, root);
git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git(root, 'push', '-q', 'origin', 'HEAD:main');
const stateDir = path.join(root, '.hx');
const config = { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: false, gate: false,
  gauntlet: false, security: false, trustedAuthors: ['Alice'] };
const project = { root, stateDir, config };
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const issue = (n: number) => read().issues.find((i: any) => i.number === n);
const it = (number: number, labels: string[], author?: string, body = '') =>
  ({ number, title: `task ${number}`, body, state: 'OPEN', labels, ...(author === undefined ? {} : { author }) });

// the gh login is Hx-Bot; alice is in trustedAuthors (matched case-insensitively)
const BOARD = () => ({ login: 'Hx-Bot', comments: [], prs: [], issues: [
  it(1, [L.ready]),                                  // by the gh login → built
  it(2, [L.ready], 'mallory'),                       // untrusted → skipped
  it(3, [L.prd, L.hardened], 'hx-bot'),              // trusted PRD → decomposed, its children built, closed
  it(4, [L.prd, L.hardened], 'eve'),                 // untrusted PRD → nothing of it runs
  it(5, [L.ready], 'Hx-Bot', '## Parent\n#4\n'),     // trusted child of the untrusted PRD → skipped
  it(6, [L.ready], 'ALICE'),                         // trustedAuthors → built
  it(7, [L.ready], ''),                              // deleted account → skipped
] });

async function capture(fn: () => Promise<number>) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  const rc = await fn().finally(() => { console.log = orig; });
  return { rc, lines };
}
const pool = (dryRun = false) => runPool(project, { workers: 2, watch: false, dryRun, signal: new AbortController().signal });

test('--dry-run: untrusted rows show who opened them (or their PRD)', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify(BOARD()));
  const { rc, lines } = await capture(() => pool(true));
  const out = lines.join('\n');
  assert.equal(rc, 0, out);
  assert.match(out, /PRD #4\s+untrusted\s+\(by @eve\) task 4/);
  assert.match(out, /PRD #3\s+decompose\s+task 3/);
  assert.match(out, /#2\s+untrusted\s+\(by @mallory\) task 2/);
  assert.match(out, /#5\s+untrusted\s+\(PRD #4 by @eve\) task 5/);
  assert.match(out, /#7\s+untrusted\s+\(by @ghost\) task 7/);
  assert.match(out, /#1\s+claimable\s+task 1/);
  assert.match(out, /#6\s+claimable\s+task 6/);
  assert.match(out, /next: decompose #3, impl #1, impl #6$/m);
});

test('hx run builds only trusted work; each untrusted issue / PRD is logged once and left untouched', E2E, async () => {
  writeFileSync(stateFile, JSON.stringify(BOARD()));
  const before = read();
  const { rc, lines } = await capture(() => pool());
  const out = lines.join('\n');
  assert.equal(rc, 0, out);

  for (const n of [1, 6]) assert.equal(issue(n).state, 'CLOSED', `#${n} built`);
  // the PRD's children (and the review's gap issue) were filed by hx as the gh login, then built
  const kids = read().issues.filter((i: any) => /## Parent\n#3\b/.test(i.body));
  assert.equal(kids.length, 3, out);
  for (const k of kids) { assert.equal(k.author, 'Hx-Bot'); assert.equal(k.state, 'CLOSED', `child #${k.number} built`); }
  assert.equal(issue(3).state, 'CLOSED', 'trusted PRD closed');

  for (const n of [2, 4, 5, 7]) {
    assert.deepEqual(issue(n), before.issues.find((i: any) => i.number === n), `#${n} untouched`);
    assert.ok(!lines.some((l) => new RegExp(`\\[#${n}\\] (impl|decompose|review|gauntlet|security)`).test(l)), `#${n} never run`);
  }
  assert.ok(!read().issues.some((i: any) => /## Parent\n#4\b/.test(i.body) && i.number !== 5), 'untrusted PRD not decomposed');
  const once = (line: string) => assert.equal(lines.filter((l) => l.endsWith(line)).length, 1, `${line}\n${out}`);
  once('#2 skipped: opened by @mallory, who is not trusted (add them to trustedAuthors to allow)');
  once('#4 skipped: opened by @eve, who is not trusted (add them to trustedAuthors to allow)');
  once('#5 skipped: its PRD #4 was opened by @eve, who is not trusted (add them to trustedAuthors to allow)');
  once('#7 skipped: opened by @ghost, who is not trusted (add them to trustedAuthors to allow)');

  // every session got the trusted set as HX_TRUSTED (the gh login + trustedAuthors, lower-cased) ...
  const envs = sessionEnvs(process.env.HX_FAKE_DIR!);
  assert.deepEqual([...new Set(envs.map((e) => e.role))].sort(), ['decompose', 'implement', 'review']);
  for (const e of envs) assert.equal(e.trusted, 'hx-bot,alice', JSON.stringify(e));
  // ... and a prompt that reads its issue through scripts/issue.mjs, by absolute path, with nothing left unrendered
  const script = path.join(here, '..', 'scripts', 'issue.mjs').replace(/\\/g, '/');
  const prompts = readdirSync(process.env.HX_FAKE_DIR!).filter((f) => f.endsWith('.prompt-1.txt'))
    .map((f) => readFileSync(path.join(process.env.HX_FAKE_DIR!, f), 'utf8'));
  assert.ok(prompts.length >= 5);
  for (const pr of prompts) {
    assert.doesNotMatch(pr, /\{\{\w+\}\}/);
    assert.doesNotMatch(pr, /gh issue view|--comments/);
    assert.ok(pr.includes(`node "${script}" --repo me/app --issue `), pr.slice(0, 300));
  }
});

test('gh api user failing or returning no login: hx run stops non-zero and claims nothing', E2E, async () => {
  for (const extra of [{ loginFails: true }, { login: '' }]) {
    writeFileSync(stateFile, JSON.stringify({ ...BOARD(), ...extra }));
    const before = read();
    for (const dryRun of [false, true]) {
      const { rc, lines } = await capture(() => pool(dryRun));
      assert.equal(rc, 2, lines.join('\n'));
      assert.match(lines.join('\n'), /STOPPED: could not look up the gh login \(gh api user (failed|returned no login)/);
      assert.ok(!lines.some((l) => /impl:|decompose:|pool up/.test(l)));
    }
    assert.deepEqual(read(), before, 'nothing claimed or labelled');
  }
});

test('hx init prints the trusted accounts; hx status shows untrusted rows and fails without a login', E2E, () => {
  const app = path.join(tmp, 'cli');
  git(tmp, 'clone', '-q', origin, app);
  writeFileSync(stateFile, JSON.stringify(BOARD()));
  const hx = (...args: string[]) => spawnSync(process.execPath, [path.join(here, '..', 'bin', 'hx.mjs'), ...args], { cwd: app, encoding: 'utf8' });
  const init = hx('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /trusted\s+Hx-Bot \(\+ config\.trustedAuthors/);
  const p = path.join(app, '.hx');
  saveConfig(p, { ...JSON.parse(readFileSync(path.join(p, 'config.json'), 'utf8')), trustedAuthors: ['alice'] });
  const st = hx('status');
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /#2\s+untrusted\s+\(by @mallory\) task 2/);
  assert.match(st.stdout, /#6\s+claimable\s+task 6/);
  writeFileSync(stateFile, JSON.stringify({ ...BOARD(), loginFails: true }));
  const bad = hx('status');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /could not look up the gh login/);
});
