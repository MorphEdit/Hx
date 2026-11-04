// hx status: the health line from .hx/health.json `last` (PRD #194 §D, #240); none before the first pass.
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
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-hs-'));

function app(name: string, health?: object) {
  const root = path.join(tmp, name), sd = path.join(root, '.hx');
  mkdirSync(sd, { recursive: true });
  saveConfig(sd, { ...DEFAULTS, repo: 'me/app', defaultBranch: 'main', worktreeRoot: path.join(tmp, `wt-${name}`) } as any);
  if (health) writeFileSync(path.join(sd, 'health.json'), JSON.stringify(health));
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

test('hx status: the last health pass\'s time and line from health.json, no line without a pass', E2E, () => {
  const line = 'health: 3 ✓ · fixed 2 (closed stale PR #91, resumed #170) · filed 1 (#200)';
  const at = new Date(Date.now() - 12 * 60_000).toISOString();
  const out = status(app('with', { stuck: {}, last: { at, line } }));
  assert.match(out, /^health {3}12m0\ds ago — health: 3 ✓ · fixed 2 \(closed stale PR #91, resumed #170\) · filed 1 \(#200\)$/m, out);
  assert.match(out, /^runner {3}not running$/m, 'shown with no runner up');
  assert.doesNotMatch(status(app('none')), /^health /m);
  assert.doesNotMatch(status(app('stuck-only', { stuck: { 5: at } })), /^health /m, 'health.json without last');
});
