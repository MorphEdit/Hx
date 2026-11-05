// hx status: the `split #` lines of run.log.1 + run.log from the last 24 h, after the board (PRD #300 §7, #308).
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig } from '../src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-ss-'));

function app(name: string, log?: string, log1?: string) {
  const root = path.join(tmp, name), sd = path.join(root, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  if (log !== undefined) writeFileSync(path.join(sd, 'run.log'), log);
  if (log1 !== undefined) writeFileSync(path.join(sd, 'run.log.1'), log1);
  return root;
}
function status(cwd: string): string {
  const b = path.join(tmp, `board-${path.basename(cwd)}.json`);
  writeFileSync(b, JSON.stringify({ login: 'me', comments: [], prs: [], issues: [] }));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, '..', 'bin', 'hx.mjs'), 'status'],
    { cwd, encoding: 'utf8', env: { ...process.env, HX_GH_BIN: path.join(here, 'fakes', 'gh.mjs'), HX_FAKE_STATE: b } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test('hx status: a split # line of the last 24 h is printed after the board, an older one is not', E2E, () => {
  const out = status(app('with',
    `${ago(30 * 60)} [#1] split #1 → #2, #3\n${ago(90)} [#4] split #4 → #5, #6\n${ago(80)} [#4] size #4: fits\n`,
    `${ago(120)} [#7] split #7 → #8, #9 (narrowed after a timeout)\n`));
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith('split'));
  assert.equal(lines.length, 2, out);
  assert.match(lines[0], /^split {4}split #7 → #8, #9 \(narrowed after a timeout\) \(2h0\dm ago\)$/, 'run.log.1 first, oldest first');
  assert.match(lines[1], /^split {4}split #4 → #5, #6 \(1h\d\dm ago\)$/);
  assert.ok(out.indexOf('open PRD(s)') < out.indexOf('split    split #7'), 'after the board');
  assert.doesNotMatch(out, /split #1 /, 'older than 24 h');
});

test('hx status: no split line without a recent split # line in run.log', E2E, () => {
  assert.doesNotMatch(status(app('none')), /^split/m);
  assert.doesNotMatch(status(app('old', `${ago(25 * 60)} [#1] split #1 → #2, #3\n${ago(5)} [#4] size #4: fits\n`)), /^split/m);
});
