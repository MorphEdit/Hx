// #121: a repo set up before bug triage has no bug-triaged label; a REPRODUCED verdict must still label the bug.
import { E2E, pooled } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-t-'));
const stateFile = path.join(tmp, 'board.json');
const fakeDir = path.join(tmp, 'sessions');
process.env.HX_GH_BIN = path.join(here, 'fakes', 'gh.mjs');
process.env.HX_RTDD_BIN = path.join(here, 'fakes', 'rtdd.mjs');
process.env.HX_FAKE_STATE = stateFile;
process.env.HX_FAKE_DIR = fakeDir;
process.env.HX_LABEL_RETRY_MS = '1';
mkdirSync(fakeDir);

const { runPool } = await import('../src/pool.ts');
const { DEFAULTS } = await import('../src/config.ts');

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
const project = { root, stateDir, config: { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, 'wt'),
  claudeBin: path.join(here, 'fakes', 'claude.mjs'), maxIterations: 3, pollSeconds: 1, audit: true, gate: false, gauntlet: false } };

test('REPRODUCED in a repo without the bug-triaged label: hx creates it and labels the bug (#121)', E2E, async () => {
  // every hx label exists except bug-triaged (a repo set up with hx init before bug triage existed)
  const labels = Object.values(L).filter((l) => l !== L.triaged);
  writeFileSync(stateFile, JSON.stringify({ strictLabels: true, labels, comments: [], prs: [],
    issues: [{ number: 1, title: 'bug 1', body: 'crashes on save TRIAGEREPRO', state: 'OPEN', labels: [L.bug] }] }));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); orig(m); };
  try {
    await pooled((signal) => runPool(project, { workers: 1, watch: false, dryRun: false, signal }));
  } finally { console.log = orig; }
  const s = JSON.parse(readFileSync(stateFile, 'utf8'));
  const i = s.issues.find((x: any) => x.number === 1);
  assert.ok(s.labels.includes(L.triaged), `bug-triaged created: ${s.labels.join()}`);
  assert.ok(!i.labels.includes(L.blocked), `not blocked: ${i.labels.join()}\n${lines.join('\n')}`);
  assert.equal(i.state, 'CLOSED', `triaged, built and merged: ${i.labels.join()}`);
});
